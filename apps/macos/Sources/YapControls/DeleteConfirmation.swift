import Foundation

/// The one question the app asks before deleting anything. A plain delete asks before calling;
/// an `IN_USE` refusal becomes the same dialog listing its users, whose confirmation deletes them
/// too. Every fact in it comes from the page row or the refusal; the app makes no query of its own.
public struct DeleteConfirmation: Equatable, Sendable {
    public let title: String
    /// Projects that use the item, one line each, shown between the lead and the message.
    public let users: [String]
    public let lead: String?
    public let message: String
    public let confirm: String
    /// Whether confirming deletes the users too.
    public let cascade: Bool

    public init(title: String, users: [String], lead: String?, message: String, confirm: String, cascade: Bool) {
        self.title = title; self.users = users; self.lead = lead
        self.message = message; self.confirm = confirm; self.cascade = cascade
    }

    /// What an `IN_USE` refusal says about the item's users, as the service sent it.
    public struct InUse: Decodable, Equatable, Sendable {
        public struct Project: Decodable, Equatable, Sendable {
            public let title: String
            public let revisions: Int
        }
        public let usedBy: [Project]
        public let derivedAssets: [Derived]
        public let acquisitions: [Source]
        public let freesBytes: Int64
        public let cascadeFreesBytes: Int64
        public struct Derived: Decodable, Equatable, Sendable { public let assetId: String }
        public struct Source: Decodable, Equatable, Sendable { public let acquisitionId: String }
    }

    /// Asked before the first call. `sizeBytes` is the page row's measured size, when it has one.
    public static func plain(_ target: MediaTarget, name: String, sizeBytes: Int64?) -> Self {
        let size = sizeBytes.map { " (\(LibraryPresentation.byteCount($0)))" } ?? ""
        let message = switch target {
        case .asset: "Removes Yap’s copy and its transcripts\(size). Your original file isn’t touched. This can’t be undone."
        case .recording: "Removes the recording and its transcripts\(size). This can’t be undone."
        case .project: "Removes the project and its revision history\(size). Recordings and imported videos are kept. This can’t be undone."
        }
        return .init(title: "Delete “\(name)”?", users: [], lead: nil, message: message, confirm: "Delete", cascade: false)
    }

    /// Asked after an `IN_USE` refusal, from the refusal's own details.
    public static func cascade(_ target: MediaTarget, name: String, inUse: InUse) -> Self {
        let noun = switch target {
        case .asset: "imported video"
        case .recording: "recording"
        case .project: "project"
        }
        let users = inUse.usedBy.map { "Project “\($0.title)” — \($0.revisions) revision\($0.revisions == 1 ? "" : "s")" }
        // Only what the refusal names, in its own terms: projects by title, other users by count.
        func count(_ n: Int, _ one: String, _ many: String) -> String? { n == 0 ? nil : n == 1 ? "1 \(one)" : "\(n) \(many)" }
        let parts = [
            inUse.usedBy.isEmpty ? nil : inUse.usedBy.count == 1 ? "this project" : "these projects",
            count(inUse.derivedAssets.count, "file made from it", "files made from it"),
            count(inUse.acquisitions.count, "recording source", "recording sources"),
        ].compactMap { $0 }
        let also = parts.count < 2 ? parts.joined() : parts.dropLast().joined(separator: ", ") + " and " + parts.last!
        return .init(title: "Delete “\(name)”?", users: users, lead: users.isEmpty ? nil : "This \(noun) is used by:",
            message: "Deleting it also deletes \(also) (\(LibraryPresentation.byteCount(inUse.cascadeFreesBytes)) total). This can’t be undone.",
            confirm: "Delete all", cascade: true)
    }
}
