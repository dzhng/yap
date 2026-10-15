@preconcurrency import AVFoundation
import Foundation
import YapMedia

/// Executes compiler records verbatim. Source support is decoded; editorial time is never inferred.
public enum CompositionVideoRenderer {
    public struct Request: Codable {
        public let output: String
        public let frames: String
        public let range: TimeSpan
        let canvas: CompositionPictureExecutor.Canvas
        public let maxLongEdge: Int?
        public let settings: OutputSettings
        public let processing: [CompositionProcessing]
        public let assets: [CompositionAsset]
        public let fonts: [FontAssetBinding]?
        public let luts: [LUTAssetBinding]?
        let lutImplementationId: String?
        let sdrCorrectionImplementationId: String?
        let pointers: PreparedPointersReceipt?
        public func validateOutput(hasAudio: Bool) throws {
            try canvas.validate()
            let delivered = try deliveredSize()
            try settings.validate(
                width: delivered.width, height: delivered.height,
                frameRate: Double(canvas.fps.numerator) / Double(canvas.fps.denominator),
                hasAudio: hasAudio)
        }
        public func deliveredSize() throws -> (width: Int, height: Int) {
            guard let maxLongEdge else { return (canvas.width, canvas.height) }
            guard maxLongEdge >= 2, maxLongEdge <= 8192 else {
                throw CompositionVideoRenderer.invalid("Preview long edge is outside 2...8192.")
            }
            let sourceLongEdge = max(canvas.width, canvas.height)
            guard sourceLongEdge > maxLongEdge else { return (canvas.width, canvas.height) }
            let scale = Double(maxLongEdge) / Double(sourceLongEdge)
            let scaledWidth = Int((Double(canvas.width) * scale).rounded(.down))
            let scaledHeight = Int((Double(canvas.height) * scale).rounded(.down))
            let width = max(2, scaledWidth - scaledWidth % 2)
            let height = max(2, scaledHeight - scaledHeight % 2)
            return (width, height)
        }
        public func replacingOutput(_ path: String) -> Self {
            Self(
                output: path, frames: frames, range: range, canvas: canvas, maxLongEdge: maxLongEdge, settings: settings,
                processing: processing, assets: assets, fonts: fonts, luts: luts, lutImplementationId: lutImplementationId, sdrCorrectionImplementationId: sdrCorrectionImplementationId, pointers: pointers)
        }
    }
    public struct Result: Encodable {
        let file: String
        let mediaType = "video/mp4"
        let settings: OutputSettings
        public let encodedVideo: OutputSettings.EncodedVideo
        public let durationUs: Int64
        public let width: Int
        public let height: Int
        public let frames: Int
        let rasterizedFrames: Int
        let pointerRasterizations: Int
        let decodedImages: Int
        let decodedSamples: Int
        let readerOpens: Int
        let bytes: Int
        let retainedSourceBuffersBound: Int
        /// Omitted when every text drew with its pinned face.
        public let textFallbacks: [CompositionPictureExecutor.TextFallbackReport]?
        let pixelPoolAllocationThreshold = 4
        let maximumSequentialAdvanceUs = CompositionPictureExecutor.maximumSequentialAdvanceUs
    }

    public static func write(
        _ request: Request, nextFrame: () throws -> CompositionPictureExecutor.Frame?
    ) async throws
        -> Result
    {
        let canvas = request.canvas
        let delivered = try request.deliveredSize()
        guard request.range.startUs >= 0, request.range.endUs > request.range.startUs,
            request.range.endUs <= TimeSpan.maximumMicroseconds
        else {
            throw invalid("Video requires a positive range.")
        }
        try request.validateOutput(hasAudio: false)
        let pictures = try CompositionPictureExecutor(
            canvas: canvas, deliveredSize: delivered, bindings: request.assets, fonts: request.fonts ?? [], luts: request.luts ?? [], lutImplementationId: request.lutImplementationId, pointers: request.pointers, sdrCorrectionImplementationId: request.sdrCorrectionImplementationId)
        let output = try NewFile(at: request.output, assembledAs: "video.mp4")
        defer { output.discard() }
        let writer = try AVAssetWriter(outputURL: output.url, fileType: .mp4)
        defer { if writer.status == .writing { writer.cancelWriting() } }
        let settings = try request.settings.videoDictionary(
            width: delivered.width, height: delivered.height,
            frameRate: Double(canvas.fps.numerator) / Double(canvas.fps.denominator))
        guard writer.canApply(outputSettings: settings, forMediaType: .video) else {
            throw unsupported("Video profile cannot encode this canvas.")
        }
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        video.mediaTimeScale = 1_000_000
        writer.movieTimeScale = 1_000_000
        writer.add(video)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: video,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: delivered.width,
                kCVPixelBufferHeightKey as String: delivered.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ])
        guard writer.startWriting() else {
            throw writer.error ?? invalid("Cannot start video writer.")
        }
        writer.startSession(atSourceTime: .zero)
        var through = request.range.startUs
        var lastIndex: Int64 = -1
        var lastSample: Int64 = -1
        var frames = 0
        while let frame = try nextFrame() {
            try Task.checkCancellation()
            guard frame.index >= 0, frame.index <= TimeSpan.maximumMicroseconds,
                frame.index > lastIndex,
                frame.sampleAtUs >= 0, frame.sampleAtUs <= TimeSpan.maximumMicroseconds,
                frame.sampleAtUs > lastSample,
                frame.sampleAtUs <= frame.visibleRange.startUs,
                frame.visibleRange.startUs == through, frame.visibleRange.endUs > through,
                frame.visibleRange.endUs <= request.range.endUs
            else { throw invalid("Invalid or discontinuous compiled frame stream.") }
            let destination = try await pictures.render(frame) { retained in
                let deadline = ContinuousClock.now.advanced(by: .seconds(10))
                var destination: CVPixelBuffer?
                while destination == nil {
                    try Task.checkCancellation()
                    guard writer.status == .writing, ContinuousClock.now < deadline else {
                        throw NativeFailure.decodeFailed("Video writer stopped making progress.")
                    }
                    if video.isReadyForMoreMediaData, let retained {
                        destination = retained
                    } else if video.isReadyForMoreMediaData, let pool = adaptor.pixelBufferPool {
                        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
                            nil, pool,
                            [kCVPixelBufferPoolAllocationThresholdKey: 4] as CFDictionary,
                            &destination)
                        guard
                            status == kCVReturnSuccess
                                || status == kCVReturnWouldExceedAllocationThreshold
                        else { throw invalid("Cannot allocate render buffer.") }
                    }
                    if destination == nil { try await Task.sleep(for: .milliseconds(1)) }
                }
                return destination!
            }
            if !pictures.outputIsKnownOpaque {
                try CompositionPictureExecutor.requireOpaque(destination)
            }
            var format: CMVideoFormatDescription?
            var sample: CMSampleBuffer?
            var timing = CMSampleTimingInfo(
                duration: time(microseconds: frame.visibleRange.endUs - through),
                presentationTimeStamp: time(microseconds: through - request.range.startUs),
                decodeTimeStamp: .invalid)
            guard
                CMVideoFormatDescriptionCreateForImageBuffer(
                    allocator: nil, imageBuffer: destination, formatDescriptionOut: &format)
                    == noErr,
                CMSampleBufferCreateReadyWithImageBuffer(
                    allocator: nil, imageBuffer: destination, formatDescription: format!,
                    sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
                video.append(sample!)
            else { throw writer.error ?? invalid("Cannot append compiled picture.") }
            through = frame.visibleRange.endUs
            lastIndex = frame.index
            lastSample = frame.sampleAtUs
            frames += 1
        }
        try pictures.finishPointers()
        guard through == request.range.endUs else {
            throw invalid("Compiled frames do not cover the requested range.")
        }
        video.markAsFinished()
        writer.endSession(
            atSourceTime: time(microseconds: request.range.endUs - request.range.startUs))
        await writer.finishWriting()
        try Task.checkCancellation()
        guard writer.status == .completed else {
            throw writer.error ?? invalid("Video writer did not complete.")
        }
        let encodedVideo = try await request.settings.inspectVideo(output.url)
        let bytes = try output.publish()
        return Result(
            file: request.output, settings: request.settings, encodedVideo: encodedVideo,
            durationUs: through - request.range.startUs,
            width: delivered.width,
            height: delivered.height, frames: frames, rasterizedFrames: pictures.rasterized,
            pointerRasterizations: pictures.pointerRasterizations,
            decodedImages: pictures.decodedImages, decodedSamples: pictures.decodedSamples,
            readerOpens: pictures.opens,
            bytes: bytes, retainedSourceBuffersBound: pictures.maximumActiveSources,
            textFallbacks: pictures.textFallbacks.isEmpty ? nil : pictures.textFallbacks)
    }

    private static func invalid(_ message: String) -> NativeFailure {
        NativeFailure("INVALID_REQUEST", message)
    }
    private static func unsupported(_ message: String) -> NativeFailure {
        NativeFailure("NOT_READY", message)
    }

}
