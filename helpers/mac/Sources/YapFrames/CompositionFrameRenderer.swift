import Foundation
import YapMedia

/// Delivers one compiled picture, without encoding or decoding an intermediate movie.
public enum CompositionFrameRenderer {
    public struct Request: Codable {
        public let output: String
        public let frame: CompositionPictureExecutor.Frame
        let canvas: CompositionPictureExecutor.Canvas
        let profile: String
        let processing: [CompositionProcessing]
        public let assets: [CompositionAsset]
        public let fonts: [FontAssetBinding]?
        public let luts: [LUTAssetBinding]?
        let lutImplementationId: String?
        let maxLongEdge: Int?
        let maxEncodedBytes: Int?
        let sdrCorrectionImplementationId: String?
        let pointers: PreparedPointersReceipt?
        let observations: PictureObservationRequest?
        let faceObservations: FaceObservationRequest?
    }
    public struct Result: Encodable {
        let file: String
        let mediaType = "image/png"
        let profile = "h264-rec709"
        let frame: CompositionPictureExecutor.Frame
        let pictures: [CompositionPictureExecutor.Picture]
        let width: Int
        let height: Int
        let sourceWidth: Int
        let sourceHeight: Int
        let decodedImages: Int
        let decodedSamples: Int
        let readerOpens: Int
        let bytes: Int
        let observations: PictureObservations?
        let faceObservations: FaceObservations?
        /// Omitted when every text drew with its pinned face.
        let textFallbacks: [CompositionPictureExecutor.TextFallbackReport]?
    }

    public static func write(_ request: Request) async throws -> Result {
        guard request.profile == "h264-rec709" else {
            throw NativeFailure("INVALID_PARAMS", "Unknown video export profile.")
        }
        let frame = request.frame
        let edge = request.maxLongEdge ?? FrameLimits.defaultLongEdge
        let limit = request.maxEncodedBytes ?? FrameLimits.maximumEncodedBytes
        guard edge > 0, edge <= FrameLimits.maximumLongEdge,
            limit > 0, limit <= FrameLimits.maximumEncodedBytes,
            frame.index >= 0, frame.index <= TimeSpan.maximumMicroseconds,
            frame.sampleAtUs >= 0, frame.sampleAtUs <= frame.visibleRange.startUs,
            frame.visibleRange.endUs > frame.visibleRange.startUs,
            frame.visibleRange.endUs <= TimeSpan.maximumMicroseconds
        else { throw NativeFailure("INTERNAL_ERROR", "Invalid compiled picture or image limits.") }
        let pictures = try CompositionPictureExecutor(
            canvas: request.canvas, deliveredSize: FrameImage.delivered(
                width: request.canvas.width, height: request.canvas.height, maxLongEdge: edge),
            bindings: request.assets, fonts: request.fonts ?? [], luts: request.luts ?? [], lutImplementationId: request.lutImplementationId, pointers: request.pointers, sdrCorrectionImplementationId: request.sdrCorrectionImplementationId)
        let output = try NewFile(at: request.output, assembledAs: "frame.png")
        defer { output.discard() }
        let composed = try await pictures.image(frame)
        try pictures.finishPointers()
        // Orientation and composition are complete. Only the established delivery bound remains.
        let image = FrameImage(oriented: composed, maxLongEdge: edge)
        let published = try image.publishPNG(
            to: output, context: pictures.context, maxEncodedBytes: limit,
            observations: request.observations, faceObservations: request.faceObservations)
        return Result(
            file: request.output, frame: frame, pictures: pictures.pictures,
            width: image.width, height: image.height,
            sourceWidth: request.canvas.width, sourceHeight: request.canvas.height,
            decodedImages: pictures.decodedImages, decodedSamples: pictures.decodedSamples,
            readerOpens: pictures.opens, bytes: published.bytes, observations: published.observations, faceObservations: published.faceObservations,
            textFallbacks: pictures.textFallbacks.isEmpty ? nil : pictures.textFallbacks)
    }
}
