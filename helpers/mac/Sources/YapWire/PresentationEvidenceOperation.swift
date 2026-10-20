import Foundation
import YapFrames
import YapMedia

enum PresentationEvidenceOperation {
    private struct Request: Codable {
        let source: String
        let output: String
        let plan: [VideoRenderSpan]
        let streamId: String?
        let clockOffsetUs: Int64?
    }

    static func execute(_ params: [String: Any]) async throws -> PresentationEvidenceReceipt {
        let request = try WireRequest.decode(Request.self, from: params)
        try WireRequest.requireAbsolute(request.source, request.output)
        return try await PresentationEvidence.write(
            source: URL(fileURLWithPath: request.source), plan: request.plan,
            output: URL(fileURLWithPath: request.output),
            streamId: request.streamId, clockOffsetUs: request.clockOffsetUs ?? 0)
    }
}
