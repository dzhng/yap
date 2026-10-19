import Foundation

/// Recording, imported asset and project identifiers remain separate namespaces, including in
/// service receipts. It decodes from the one reference a receipt carries (`recordingId`,
/// `assetId` or `projectId`); a record's own `id` names it without saying which kind it is.
public enum MediaTarget: Hashable, Sendable, Decodable {
    case recording(String)
    case asset(String)
    case project(String)

    public var id: String {
        switch self {
        case .recording(let id), .asset(let id), .project(let id): id
        }
    }

    public var isAsset: Bool { if case .asset = self { true } else { false } }

    public var parameters: [String: String] {
        switch self {
        case .recording(let id): ["recordingId": id]
        case .asset(let id): ["assetId": id]
        case .project(let id): ["projectId": id]
        }
    }

    private enum Keys: String, CodingKey { case recordingId, assetId, projectId }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        switch (fields.contains(.recordingId), fields.contains(.assetId), fields.contains(.projectId)) {
        case (true, false, false): self = .recording(try fields.decode(String.self, forKey: .recordingId))
        case (false, true, false): self = .asset(try fields.decode(String.self, forKey: .assetId))
        case (false, false, true): self = .project(try fields.decode(String.self, forKey: .projectId))
        default:
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath, debugDescription: "Media requires exactly one recording, asset or project owner"))
        }
    }
}
