@preconcurrency import AVFoundation
import Foundation
import YapMedia

public struct PreparedPointersReceipt: Codable {
    let file: String
    let bytes: Int
    let records: Int
    let sha256: String
}

/// Prepared source evidence is separate from, and cannot rewrite, the raw compiler graph.
final class PreparedPointers {
    struct Row: Decodable, Equatable {
        struct Time: Decodable, Equatable {
            let value: String
            let timescale: Int32
            func time() throws -> CMTime {
                guard let value = Int64(value), value >= 0, timescale > 0 else {
                    throw invalid("Invalid prepared exact time.")
                }
                return CMTime(value: value, timescale: timescale)
            }
        }
        let frameIndex: Int64
        let sampleAtUs: Int64
        let clipId: String
        let stepId: String
        let trailUs: Int64
        let status: String
        let assetId: String?
        let streamId: String?
        let requestedSourceUs: ExactTime?
        let availability: String?
        let captureUs: Int64?
        let clockOffsetUs: Int64?
        let sourceToAssetOffsetUs: ExactTime?
        let width: Int?
        let height: Int?
        let start: Time?
        let end: Time?
        let sampleTime: Time?
        let overlay: FrameOverlay?
    }
    private let lines: RetainedJSONLines
    private let receipt: PreparedPointersReceipt
    private var count = 0
    init(_ receipt: PreparedPointersReceipt) throws {
        guard receipt.records >= 0 else {
            throw invalid("Prepared pointer count is invalid.")
        }
        self.receipt = receipt
        self.lines = try RetainedJSONLines(
            path: receipt.file, bytes: receipt.bytes, sha256: receipt.sha256,
            recordBytes: 256 * 1024)
        while try row() != nil {}
        try finish()
        try lines.rewind()
        count = 0
    }
    private func row() throws -> Row? {
        guard let data = try lines.next() else { return nil }
        guard count < receipt.records,
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let status = object["status"] as? String
        else { throw invalid("Malformed prepared pointer row.") }
        var keys: Set<String> = [
            "frameIndex", "sampleAtUs", "clipId", "stepId", "trailUs", "status",
        ]
        switch status {
        case "inactive": break
        case "excluded":
            keys.formUnion(["assetId", "streamId", "requestedSourceUs", "availability"])
        case "empty", "picture":
            keys.formUnion([
                "assetId", "streamId", "requestedSourceUs", "captureUs", "clockOffsetUs",
                "sourceToAssetOffsetUs", "width", "height", "start", "end",
            ])
            if status == "picture" { keys.formUnion(["sampleTime", "overlay"]) }
        default: throw invalid("Unknown prepared pointer status.")
        }
        guard Set(object.keys) == keys else {
            throw invalid("Prepared pointer fields differ from status.")
        }
        let result = try JSONDecoder().decode(Row.self, from: data)
        guard result.frameIndex >= 0, result.sampleAtUs >= 0, !result.clipId.isEmpty,
            !result.stepId.isEmpty,
            result.trailUs >= 0, result.trailUs <= FrameLimits.maximumTrailUs
        else { throw invalid("Invalid prepared pointer identity.") }
        if status == "picture" || status == "empty" {
            guard let width = result.width, let height = result.height, width > 0, height > 0,
                width <= 8192, height <= 8192,
                let at = result.captureUs, at >= 0, at <= TimeSpan.maximumMicroseconds,
                let start = result.start, let end = result.end,
                let offset = result.clockOffsetUs, offset >= -TimeSpan.maximumMicroseconds,
                offset <= TimeSpan.maximumMicroseconds,
                let mapping = result.sourceToAssetOffsetUs,
                try mapping.compare(ExactTime(-Int128(TimeSpan.maximumMicroseconds))) != .orderedAscending,
                try mapping.compare(ExactTime(Int128(TimeSpan.maximumMicroseconds))) != .orderedDescending,
                let requested = result.requestedSourceUs
            else { throw invalid("Prepared source clock or raster is invalid.") }
            let capture = try requested.subtract(mapping)
            guard capture.numerator >= 0, try capture.sample(1_000_000) == at,
                try capture.compare(ExactTime(start.time())) != .orderedAscending,
                try capture.compare(ExactTime(end.time())) == .orderedAscending
            else { throw invalid("Prepared exact source clock differs from its support or observation cutoff.") }
            if status == "picture" {
                guard let overlay = result.overlay, overlay.trailUs == result.trailUs,
                    let sample = result.sampleTime,
                    try capture.compare(ExactTime(sample.time())) != .orderedAscending
                else { throw invalid("Prepared picture has no matching overlay/sample.") }
                try overlay.validate(width: width, height: height)
                for point in overlay.trail.flatMap({ $0 }) {
                    guard point.atSourceUs <= at, point.atSourceUs >= max(0, at - overlay.trailUs)
                    else { throw invalid("Prepared trail escapes its source-time window.") }
                }
                if let pointer = overlay.pointer, pointer.atSourceUs > at {
                    throw invalid("Prepared pointer observes the future.")
                }
            }
        }
        count += 1
        return result
    }
    func take(
        frame: CompositionPictureExecutor.Frame, clipId: String,
        operation: CompositionPictureExecutor.Frame.Operation,
        layer: CompositionPictureExecutor.Frame.Layer?, picture: CompositionPictureExecutor.Picture?
    ) throws -> Row {
        guard let row = try row(), row.frameIndex == frame.index,
            row.sampleAtUs == frame.sampleAtUs,
            row.clipId == clipId, row.stepId == operation.stepId, row.trailUs == operation.trailUs
        else { throw invalid("Prepared pointer does not match the compiled operation.") }
        guard let layer else {
            guard row.status == "inactive" else {
                throw invalid("Inactive clip received prepared source pixels.")
            }
            return row
        }
        guard layer.kind == "video", row.assetId == layer.assetId, row.streamId == layer.streamId,
            row.requestedSourceUs == layer.sourceUs
        else { throw invalid("Prepared pointer changed its selected source.") }
        if layer.availability != "available" {
            guard row.status == "excluded", row.availability == layer.availability else {
                throw invalid("Excluded source received prepared pixels.")
            }
            return row
        }
        guard let picture, let mapping = row.sourceToAssetOffsetUs,
            let offset = row.clockOffsetUs, let width = row.width, let height = row.height,
            Double(width) == layer.width, Double(height) == layer.height
        else { throw invalid("Prepared pointer changed its source domain.") }
        if picture.status == "unavailable" {
            guard picture.reason == "physical-empty", row.status == "empty" else {
                throw invalid("Empty presentation received pointer pixels.")
            }
            return row
        }
        guard row.status == "picture", let sample = row.sampleTime, let observed = picture.sample,
            let observedValue = Int64(observed.value), try ExactTime(Int128(offset)).subtract(mapping) == observed.originUs
        else { throw invalid("Prepared pointer has no observed source identity.") }
        let translated = try ExactTime(sample.time()).subtract(ExactTime(-Int128(offset)))
        guard try translated.compare(ExactTime(CMTime(value: observedValue, timescale: observed.timescale))) == .orderedSame
        else {
            throw invalid("Prepared pointer physical sample differs from the selected picture.")
        }
        return row
    }
    func finish() throws {
        guard count == receipt.records, try lines.next() == nil else {
            throw invalid("Prepared pointer stream has missing or extra operations.")
        }
        try lines.finish()
    }
}
private func invalid(_ message: String) -> NativeFailure {
    NativeFailure("INVALID_REQUEST", message)
}
