@preconcurrency import AVFoundation
import CoreImage
import Darwin
import Foundation
import YapMedia

public struct PresentationEvidenceReceipt: Encodable, Sendable {
    public let file: String
    public let version: Int
    public let sourceWidth: Int
    public let sourceHeight: Int
    public let durationUs: Int64
    public let records: Int
    public let bytes: Int
}

/// Exact timestamps survive transport without JSON's floating-point integer limit.
/// Support endpoints are not rounded to microseconds: membership is half-open in CMTime.
private struct PresentationTime: Encodable {
    let value: String
    let timescale: Int32
    init(_ time: CMTime) {
        value = String(time.value)
        timescale = time.timescale
    }
}
private struct PresentationHeader: Encodable {
    let version = 1
    let sourceWidth: Int
    let sourceHeight: Int
    let durationUs: Int64
    let spanCount: Int
}
private struct PresentationRecord: Encodable {
    let spanIndex: Int
    let start: PresentationTime
    let end: PresentationTime
    let empty: Bool
    let sampleTime: PresentationTime?
    let actualSourceUs: Int64?
    let width: Int?
    let height: Int?
    let rgbBase64: String?
}

/// One sequential decode, one bounded JSONL record at a time. Only the final receipt
/// crosses the worker pipe. Consumers can index/read the stream without loading it whole.
public enum PresentationEvidence {
    public static func write(
        source: URL, plan: [VideoRenderSpan], output: URL,
        streamId: String? = nil, clockOffsetUs: Int64 = 0
    ) async throws -> PresentationEvidenceReceipt {
        let duration = try PresentationSource.duration(of: plan)
        guard clockOffsetUs >= -TimeSpan.maximumMicroseconds,
            clockOffsetUs <= TimeSpan.maximumMicroseconds
        else {
            throw NativeFailure(
                "INVALID_REQUEST",
                "Evidence requires a safe clock offset.")
        }
        let destination = try NewFile(at: output.path, assembledAs: "evidence.jsonl")
        defer { destination.discard() }
        // container PTS = requested history-clock time + clockOffsetUs.
        // The capture mapping owner supplies the offset; this writer only translates the clock.
        func container(_ value: Int64) throws -> Int64 {
            let (result, overflow) = value.addingReportingOverflow(clockOffsetUs)
            guard !overflow, result >= -TimeSpan.maximumMicroseconds,
                result <= TimeSpan.maximumMicroseconds
            else {
                throw NativeFailure(
                    "INVALID_REQUEST", "Presentation clock offset exceeds precision.")
            }
            return result
        }
        let presentation = try await PresentationSource(
            source: source, streamId: streamId,
            startUs: nil, endUs: try container(plan.last!.source.endUs))
        let offset = time(microseconds: clockOffsetUs)
        func history(_ value: CMTime) throws -> CMTime {
            if clockOffsetUs == 0 { return value }
            let result = CMTimeSubtract(value, offset)
            guard result.isNumeric, !result.flags.contains(.hasBeenRounded), result >= .zero else {
                throw NativeFailure(
                    "UNAVAILABLE",
                    "Presentation clock translation is negative or loses exact precision.")
            }
            return result
        }
        let fd = open(
            destination.url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o666)
        guard fd >= 0 else {
            throw NativeFailure.decodeFailed("Cannot open evidence output.")
        }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var bytes = 0
        func append(_ record: some Encodable) throws {
            var data = try encoder.encode(record)
            data.append(10)
            guard data.count <= 65_536 else {
                throw NativeFailure(
                    "LIMIT_EXCEEDED", "Presentation evidence exceeds its byte budget.")
            }
            try file.write(contentsOf: data)
            bytes += data.count
        }
        try append(
            PresentationHeader(
                sourceWidth: presentation.width, sourceHeight: presentation.height,
                durationUs: duration, spanCount: plan.count))
        let context = CIContext(options: [.cacheIntermediates: false])
        var count = 0
        // Cuts can revisit the same held sample. Keep only its rendered thumbnail;
        // every span still writes its own exact timing.
        var thumbnail: (buffer: CVPixelBuffer, width: Int, height: Int, rgb: String)?
        for (spanIndex, span) in plan.enumerated() {
            var at = time(microseconds: try container(span.source.startUs))
            let end = time(microseconds: try container(span.source.endUs))
            while at < end {
                try Task.checkCancellation()
                let next = try autoreleasepool {
                    let selected = try presentation.selection(
                        at: at, end: end)
                    guard selected.end > at else {
                        throw NativeFailure(
                            "UNAVAILABLE", "Presentation evidence made no progress.")
                    }
                    if let buffer = selected.buffer {
                        if thumbnail?.buffer !== buffer {
                            let image = try FrameImage(
                                buffer: buffer, transform: presentation.transform, maxLongEdge: 64)
                            thumbnail = (
                                buffer, image.width, image.height,
                                image.rgb(context: context).base64EncodedString()
                            )
                        }
                    } else {
                        thumbnail = nil
                    }
                    let selectedHistoryTime = try selected.sampleTime.map(history)
                    try append(
                        PresentationRecord(
                            spanIndex: spanIndex, start: PresentationTime(try history(at)),
                            end: PresentationTime(try history(selected.end)),
                            empty: selected.buffer == nil,
                            sampleTime: selectedHistoryTime.map(PresentationTime.init),
                            actualSourceUs: selectedHistoryTime.map(microseconds),
                            width: thumbnail?.width, height: thumbnail?.height,
                            rgbBase64: thumbnail?.rgb))
                    return selected.end
                }
                at = next
                count += 1
            }
        }
        try file.close()
        _ = try destination.publish()
        return PresentationEvidenceReceipt(
            file: output.path, version: 1, sourceWidth: presentation.width,
            sourceHeight: presentation.height, durationUs: duration, records: count, bytes: bytes)
    }
}
