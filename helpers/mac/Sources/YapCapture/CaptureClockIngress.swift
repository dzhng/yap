@preconcurrency import AVFoundation
import Foundation
@preconcurrency import ScreenCaptureKit

package enum CaptureIngressRole: String, Codable { case screen, camera, microphone, system }
package struct CaptureRationalTime: Codable {
    let value: Int64
    let timescale: Int32
    let epoch: Int64
    var time: CMTime { CMTime(value: value, timescale: timescale, flags: .valid, epoch: epoch) }
    init(_ time: CMTime) { value = time.value; timescale = time.timescale; epoch = time.epoch }
}

package enum CaptureVideoDestination {
    case primary(width: Int, height: Int)
    case companion(CameraWriter)
}

/// Routes capture callbacks on the existing capture writer queue. A companion camera's callbacks,
/// and only those, are logged to its mapping.
package final class CaptureClockIngress: NSObject, SCStreamOutput, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate,
    @unchecked Sendable {
    package let writer: CaptureWriter
    private let destination: CaptureVideoDestination
    package var companion: CameraWriter? {
        if case .companion(let camera) = destination { return camera }; return nil
    }
    private var primaryFormat: CMFormatDescription?
    private let observations: FileHandle?
    package let observationURL: URL?
    package var captureSessionClock: (@Sendable () -> CMClockOrTimebase?)?
    package var previewFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)?
    private let failure: @Sendable (CaptureFailure) -> Void
    private var stopped = false
    private var writtenBytes: Int64 = 0
    private let generation = UUID().uuidString

    package init(writer: CaptureWriter, destination: CaptureVideoDestination, observations: URL? = nil,
        failure: @escaping @Sendable (CaptureFailure) -> Void) throws {
        self.writer = writer; self.destination = destination; self.failure = failure
        self.observationURL = observations
        if let observations {
            guard FileManager.default.createFile(atPath: observations.path, contents: nil) else {
                throw CaptureFailure("WRITE_FAILED", "Cannot create clock evidence.")
            }
            self.observations = try FileHandle(forWritingTo: observations)
        } else {
            guard case .primary = destination else {
                throw CaptureFailure("INVALID_REQUEST", "Companion camera requires clock evidence.")
            }
            self.observations = nil
        }
    }
    package func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer,
        of type: SCStreamOutputType) {
        acceptStream(sample, of: type, from: stream.synchronizationClock)
    }
    package func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
        from connection: AVCaptureConnection) {
        let role: CaptureIngressRole = output is AVCaptureAudioDataOutput ? .microphone : .camera
        accept(sample, role: role, from: captureSessionClock?())
    }
    package func captureOutput(_ output: AVCaptureOutput, didDrop sample: CMSampleBuffer,
        from connection: AVCaptureConnection) {
        do { try log(sample, arrivalHostUs: CaptureHostTime.nowUs(), converted: nil, disposition: "device-dropped", sourceUs: nil, clock: captureSessionClock?()) }
        catch { fail(error) }
    }
    @discardableResult
    package func acceptStream(_ sample: CMSampleBuffer, of type: SCStreamOutputType,
        from clock: CMClockOrTimebase?) -> CaptureWriter.IngressReceipt? {
        let role: CaptureIngressRole
        switch type {
        case .screen: role = .screen
        case .microphone: role = .microphone
        case .audio: role = .system
        @unknown default: return nil
        }
        return accept(sample, role: role, from: clock)
    }
    @discardableResult
    package func accept(_ sample: CMSampleBuffer, role: CaptureIngressRole, from clock: CMClockOrTimebase?) -> CaptureWriter.IngressReceipt? {
        guard !stopped else { return nil }
        let arrival = CaptureHostTime.nowUs()
        do {
            guard let clock else {
                throw CaptureFailure("CLOCK_UNAVAILABLE", "Selected \(role.rawValue) synchronization clock is unavailable.")
            }
            let host = CMSyncConvertTime(sample.presentationTimeStamp, from: clock, to: CMClockGetHostTimeClock())
            let converted = try Self.convert(sample, from: clock)
            // Screen and audio callbacks go to the primary writer, whose journal records them. The
            // camera's mapping records camera callbacks only, so its size follows camera time.
            switch role {
            case .screen: return writer.ingestObserved(converted, of: .screen)
            case .microphone: return writer.ingestObserved(converted, of: .microphone)
            case .system: return writer.ingestObserved(converted, of: .audio)
            case .camera: break
            }
            if let image = sample.imageBuffer { previewFrame?(NativeCapture.CameraPreviewFrame(image)) }
            let receipt: CaptureWriter.IngressReceipt
            var frame: CameraFrameMapping?
            switch destination {
            case .companion(let camera):
                (receipt, frame) = try camera.append(converted, state: writer.ingressState)
            case .primary(let width, let height):
                if converted.isValid, CMSampleBufferDataIsReady(converted), let image = converted.imageBuffer {
                    guard CVPixelBufferGetWidth(image) == width, CVPixelBufferGetHeight(image) == height,
                        let format = converted.formatDescription,
                        primaryFormat.map({ CMFormatDescriptionEqual($0, otherFormatDescription: format) }) ?? true else {
                        throw CaptureFailure("FORMAT_CHANGED", "Selected camera changed the fixed primary picture format.")
                    }
                    primaryFormat = converted.formatDescription
                }
                receipt = writer.ingestPrimaryVideo(converted)
            }
            try log(sample, arrivalHostUs: arrival, converted: host, disposition: receipt.disposition,
                sourceUs: receipt.sourceUs, clock: clock, cameraFrame: frame)
            if let frame, let companion, let observationURL { companion.recorded(observations: observationURL, bytes: writtenBytes, frames: frame.ordinal + 1) }
            return receipt
        } catch {
            // A failed append can leave a torn tail. Never append another row behind it.
            fail(error)
            return nil
        }
    }
    private func fail(_ error: Error) {
        guard !stopped else { return }
        stopped = true
        failure((error as? CaptureFailure) ?? CaptureFailure("CAPTURE_EVIDENCE_FAILED", error.localizedDescription))
    }
    /// One camera callback. Rows keep `role` and `clockDomain` so the file reads like 0.1.33
    /// mappings, which also held screen and microphone rows.
    private func log(_ sample: CMSampleBuffer, arrivalHostUs: Int64, converted: CMTime?,
        disposition: String, sourceUs: Int64?, clock: CMClockOrTimebase?, cameraFrame: CameraFrameMapping? = nil) throws {
        guard !stopped, let observations else { return }
        struct Row: Codable {
            let role: CaptureIngressRole
            let clockDomain: String
            let generation: String
            let rawPTS: CaptureRationalTime
            let convertedHostPTS: CaptureRationalTime?
            let arrivalHostUs: Int64
            let duration: CaptureRationalTime
            let sourceUs: Int64?
            let disposition: String
            let relativeRate: Double?
            let cameraFrame: CameraFrameMapping?
        }
        // Bound pathological callback floods without accumulating a take in memory.
        let rate = clock.map { CMSyncGetRelativeRate($0, relativeTo: CMClockGetHostTimeClock()) }
        let row = Row(role: .camera, clockDomain: "camera-session", generation: generation, rawPTS: CaptureRationalTime(sample.presentationTimeStamp),
            convertedHostPTS: converted.map(CaptureRationalTime.init), arrivalHostUs: arrivalHostUs,
            duration: CaptureRationalTime(sample.duration), sourceUs: sourceUs, disposition: disposition,
            relativeRate: rate.flatMap { $0.isFinite ? $0 : nil }, cameraFrame: cameraFrame)
        let data = try JSONEncoder().encode(row) + Data([10])
        try observations.write(contentsOf: data); writtenBytes += Int64(data.count)
    }
    package func close() throws {
        stopped = true
        try observations?.synchronize(); try observations?.close()
    }
    package static func convert(_ sample: CMSampleBuffer, from clock: CMClockOrTimebase) throws -> CMSampleBuffer {
        try timingCopy(sample) { timing in
            let start = timing.presentationTimeStamp
            let host = CMSyncConvertTime(start, from: clock, to: CMClockGetHostTimeClock())
            guard host.isNumeric, host.epoch == 0 else { throw CaptureFailure("INVALID_CLOCK", "Invalid converted timestamp.") }
            if timing.duration.isNumeric && timing.duration > .zero {
                let end = CMSyncConvertTime(CMTimeAdd(start, timing.duration), from: clock, to: CMClockGetHostTimeClock())
                guard end.isNumeric, end.epoch == 0, end > host else { throw CaptureFailure("INVALID_CLOCK", "Invalid converted endpoint.") }
                timing.duration = CMTimeSubtract(end, host)
            }
            timing.presentationTimeStamp = host
            if timing.decodeTimeStamp.isNumeric {
                timing.decodeTimeStamp = CMSyncConvertTime(timing.decodeTimeStamp, from: clock, to: CMClockGetHostTimeClock())
                guard timing.decodeTimeStamp.isNumeric, timing.decodeTimeStamp.epoch == 0 else { throw CaptureFailure("INVALID_CLOCK", "Invalid converted decode timestamp.") }
            }
        }
    }
    package static func retime(_ sample: CMSampleBuffer, to host: CMTime, duration: CMTime? = nil) throws -> CMSampleBuffer {
        guard host.isNumeric, host.timescale > 0, host.epoch == 0,
            sample.presentationTimeStamp.isNumeric else {
            throw CaptureFailure("INVALID_CLOCK", "Clock conversion must yield numeric epoch-zero host time.")
        }
        let offset = CMTimeSubtract(host, sample.presentationTimeStamp)
        return try timingCopy(sample) { timing in
            if let duration { timing.duration = duration }
            timing.presentationTimeStamp = CMTimeAdd(timing.presentationTimeStamp, offset)
            if timing.decodeTimeStamp.isNumeric { timing.decodeTimeStamp = CMTimeAdd(timing.decodeTimeStamp, offset) }
        }
    }
    private static func timingCopy(_ sample: CMSampleBuffer, transform: (inout CMSampleTimingInfo) throws -> Void) throws -> CMSampleBuffer {
        var count = 0
        guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil,
            entriesNeededOut: &count) == noErr, count > 0 else {
            throw CaptureFailure("INVALID_CLOCK", "Sample has no timing entries.")
        }
        var times = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &times,
            entriesNeededOut: &count) == noErr else { throw CaptureFailure("INVALID_CLOCK", "Cannot read sample timing.") }
        for i in times.indices { try transform(&times[i]) }
        var output: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample,
            sampleTimingEntryCount: count, sampleTimingArray: &times, sampleBufferOut: &output) == noErr,
            let output else { throw CaptureFailure("INVALID_CLOCK", "Cannot retime sample.") }
        return output
    }
}
