@preconcurrency import AVFoundation
import CoreImage
import Foundation
import YapMedia

/// Bounded inspection of selected-source presentation membership, including gaps between grid points.
public enum SourceVisualSamples {
    public struct Request: Codable {
        public let asset: CompositionAsset
        let available: [ExactRange]
        let atSourceUs: [Int64]
    }
    public struct Clock: Encodable {
        let value: String
        let timescale: Int32
        let endValue: String
        let endTimescale: Int32
    }
    public struct Observation: Encodable {
        let requestedSourceUs: Int64
        let status: String
        let reason: String?
        let actualSourceUs: Int64?
        let sample: Clock?
        let width: Int?
        let height: Int?
        let rgbBase64: String?
        let continuousFromPrevious: Bool
    }
    public struct Result: Encodable {
        let assetId: String
        let streamId: String
        let originUs: ExactTime
        let sourceWidth: Int
        let sourceHeight: Int
        let samples: [Observation]
        let decodedSamples: Int
        let readerOpens = 1
    }
    public static func read(_ request: Request) async throws -> Result {
        try Task.checkCancellation()
        let times = request.atSourceUs
        guard !request.asset.assetId.isEmpty, !request.asset.streamId.isEmpty,
            !times.isEmpty, times.count <= 52,
            times.allSatisfy({ $0 >= 0 && $0 <= TimeSpan.maximumMicroseconds }),
            zip(times, times.dropFirst()).allSatisfy({ $0 < $1 }),
            times.last! - times.first! <= 10_200_000,
            try ExactRange.areAvailable(request.available)
        else { throw NativeFailure("INVALID_REQUEST", "Invalid selected visual sample grid.") }
        func container(_ at: Int64) throws -> ExactTime {
            try ExactTime(Int128(at)).adding(request.asset.originUs)
        }
        let first = try container(times[0])
        let source = try await PresentationSource(source: URL(fileURLWithPath: request.asset.path),
            streamId: request.asset.streamId, startUs: first.sample(1_000_000))
        try await VideoColorPolicy.requireSupportedColor(source.track)
        let context = CIContext(options: [.cacheIntermediates: false])
        var previous: (at: ExactTime, support: Int)?
        var thumbnail: (buffer: CVPixelBuffer, width: Int, height: Int, rgb: String)?
        var observations: [Observation] = []
        for requested in times {
            try Task.checkCancellation()
            guard let support = try request.available.firstIndex(where: { try $0.contains(ExactTime(Int128(requested))) }) else {
                observations.append(Observation(requestedSourceUs: requested, status: "unavailable",
                    reason: "outside_support", actualSourceUs: nil, sample: nil, width: nil, height: nil,
                    rgbBase64: nil, continuousFromPrevious: false))
                previous = nil
                continue
            }
            let at = try container(requested)
            var continuous = previous.map { prior in
                (prior.support..<support).allSatisfy {
                    request.available[$0].endUs == request.available[$0 + 1].startUs
                }
            } ?? false
            if let prior = previous, continuous {
                var cursor = prior.at
                while try cursor.compare(at) == .orderedAscending {
                    try Task.checkCancellation()
                    let span = try source.selection(at: cursor, end: .positiveInfinity)
                    guard try ExactTime(span.end).compare(cursor) == .orderedDescending else { throw NativeFailure("UNAVAILABLE", "Visual sample traversal made no progress.") }
                    if span.buffer == nil { continuous = false }
                    cursor = try ExactTime(span.end)
                }
            }
            let selected = try source.selection(at: at, end: .positiveInfinity)
            previous = (at, support)
            guard let buffer = selected.buffer, let stamp = selected.sampleTime else {
                observations.append(Observation(requestedSourceUs: requested, status: "unavailable",
                    reason: "empty_edit", actualSourceUs: nil, sample: nil, width: nil, height: nil,
                    rgbBase64: nil, continuousFromPrevious: false))
                thumbnail = nil
                continue
            }
            if thumbnail?.buffer !== buffer {
                thumbnail = try autoreleasepool {
                    let image = try FrameImage(buffer: buffer, transform: source.transform, maxLongEdge: 64)
                    return (buffer, image.width, image.height, image.rgb(context: context).base64EncodedString())
                }
            }
            let actual = try ExactTime(stamp).subtract(request.asset.originUs).sample(1_000_000, nearest: true)
            observations.append(Observation(requestedSourceUs: requested, status: "available", reason: nil,
                actualSourceUs: actual, sample: Clock(value: String(stamp.value), timescale: stamp.timescale,
                    endValue: String(selected.end.value), endTimescale: selected.end.timescale),
                width: thumbnail!.width, height: thumbnail!.height, rgbBase64: thumbnail!.rgb,
                continuousFromPrevious: continuous))
        }
        return Result(assetId: request.asset.assetId, streamId: request.asset.streamId,
            originUs: request.asset.originUs, sourceWidth: source.width, sourceHeight: source.height,
            samples: observations, decodedSamples: source.decodedCount)
    }
}
