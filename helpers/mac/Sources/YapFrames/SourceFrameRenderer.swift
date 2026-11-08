@preconcurrency import AVFoundation
import CoreImage
import Foundation
import YapMedia

/// A demanded raw source picture uses physical presentation membership, without a project canvas.
public enum SourceFrameRenderer {
    public struct Request: Codable {
        public let asset: CompositionAsset
        let available: [ExactRange]
        let atUs: Int64
        public let output: String
        let maxLongEdge: Int?
        let maxEncodedBytes: Int?
        let observations: PictureObservationRequest?
        let faceObservations: FaceObservationRequest?
        let cursorOverlay: FrameOverlay?
    }
    public struct Sample: Encodable {
        let value: String
        let timescale: Int32
        let endValue: String
        let endTimescale: Int32
        let originUs: ExactTime
    }
    public struct Result: Encodable {
        let file: String
        let mediaType = "image/png"
        let assetId: String
        let streamId: String
        let requestedSourceUs: Int64
        let actualSourceUs: Int64
        let sample: Sample
        let width: Int
        let height: Int
        let sourceWidth: Int
        let sourceHeight: Int
        let decodedSamples: Int
        let readerOpens = 1
        let bytes: Int
        let observations: PictureObservations?
        let faceObservations: FaceObservations?
    }

    public static func write(_ request: Request) async throws -> Result {
        let edge = request.maxLongEdge ?? FrameLimits.defaultLongEdge
        let limit = request.maxEncodedBytes ?? FrameLimits.maximumEncodedBytes
        guard request.atUs >= 0, request.atUs <= TimeSpan.maximumMicroseconds,
            !request.asset.assetId.isEmpty, !request.asset.streamId.isEmpty,
            edge > 0, edge <= FrameLimits.maximumLongEdge,
            limit > 0, limit <= FrameLimits.maximumEncodedBytes,
            try ExactRange.areAvailable(request.available)
        else { throw NativeFailure("INVALID_REQUEST", "Invalid selected source picture request.") }
        guard try request.available.contains(where: { try $0.contains(ExactTime(Int128(request.atUs))) }) else {
            throw NativeFailure("UNAVAILABLE_SUPPORT", "Requested picture is outside selected source support.")
        }
        let container = try ExactTime(Int128(request.atUs)).adding(request.asset.originUs)
        let output = try NewFile(at: request.output, assembledAs: "frame.png")
        defer { output.discard() }
        let source = try await PresentationSource(
            source: URL(fileURLWithPath: request.asset.path), streamId: request.asset.streamId,
            startUs: container.sample(1_000_000))
        try await VideoColorPolicy.requireSupportedColor(source.track)
        let selected = try source.selection(at: container, end: .positiveInfinity)
        guard let buffer = selected.buffer else {
            throw NativeFailure("SOURCE_PICTURE_UNAVAILABLE", "Requested source picture has no physical sample.")
        }
        guard let stamp = selected.sampleTime else {
            throw NativeFailure("INVALID_RESPONSE", "Decoded source picture has no physical clock.")
        }
        let actualUs = try ExactTime(stamp).subtract(request.asset.originUs).sample(1_000_000, nearest: true)
        let oriented = orientedVideoImage(buffer, transform: source.transform)
        let sourceWidth = Int(oriented.extent.width.rounded())
        let sourceHeight = Int(oriented.extent.height.rounded())
        let delivered = FrameImage.delivered(width: sourceWidth, height: sourceHeight, maxLongEdge: edge)
        var composited = oriented
        if let overlay = request.cursorOverlay {
            try overlay.validate(width: sourceWidth, height: sourceHeight)
            let scale = Double(delivered.width) / Double(sourceWidth)
            if let raster = try CursorOverlay.image(
                overlay, agedFromUs: request.atUs, width: sourceWidth, height: sourceHeight,
                visibleLongEdge: Double(max(sourceWidth, sourceHeight)), deliveredScale: scale
            ) {
                composited = CIImage(cgImage: raster).composited(over: composited)
            }
        }
        let image = FrameImage(oriented: composited, maxLongEdge: edge)
        let published = try image.publishPNG(to: output,
            context: CIContext(options: [.cacheIntermediates: false]), maxEncodedBytes: limit,
            observations: request.observations, faceObservations: request.faceObservations)
        return Result(file: request.output, assetId: request.asset.assetId,
            streamId: request.asset.streamId, requestedSourceUs: request.atUs,
            actualSourceUs: actualUs,
            sample: Sample(value: String(stamp.value), timescale: stamp.timescale,
                endValue: String(selected.end.value), endTimescale: selected.end.timescale,
                originUs: request.asset.originUs),
            width: image.width, height: image.height, sourceWidth: source.width,
            sourceHeight: source.height, decodedSamples: source.decodedCount,
            bytes: published.bytes, observations: published.observations, faceObservations: published.faceObservations)
    }
}
