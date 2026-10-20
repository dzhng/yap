import Foundation

/// Service observations and explicit deletion requests, without a library lifecycle of their own.
public struct LibraryState: Equatable, Sendable {
    public init() {}
    /// The Recordings tab's page, in `media.list` order: recordings and imported videos together.
    public var media: [Media] = []
    /// What the service reports about each recording on that page.
    public var recent: [ControlsState.RecentTake] = []
    public var projects: [Project] = []
    public var nextRecordingCursor: RecordingCursor?
    public var hasPreviousRecordingPage = false
    public var recordingsRefreshing = false
    public var nextProjectCursor: ProjectCursor?
    public var hasPreviousProjectPage = false
    public var projectsRefreshing = false
    public var recordingFailure: String?
    public var progressFailure: String?
    public var projectFailure: String?
    public var retryingImports: Set<String> = []
    public var deletions: [MediaTarget: DeleteRequest] = [:]

    public typealias RecordingCursor = String
    public typealias ProjectCursor = String
    public struct Project: Decodable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let createdAt: String
        public let currentRevisionId: String
    }
    /// One `media.list` row: a recording or an imported video, with its measured facts. The row
    /// names what it is as `{kind, id}`.
    public struct Media: Decodable, Equatable, Sendable {
        public let target: MediaTarget
        public let title: String
        public let durationUs: Int64
        public let sizeBytes: Int64
        public let createdAt: String
        public init(target: MediaTarget, title: String, durationUs: Int64, sizeBytes: Int64, createdAt: String) {
            self.target = target; self.title = title
            self.durationUs = durationUs; self.sizeBytes = sizeBytes; self.createdAt = createdAt
        }
        private enum Keys: String, CodingKey { case kind, id, title, durationUs, sizeBytes, createdAt }
        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            let id = try fields.decode(String.self, forKey: .id)
            switch try fields.decode(String.self, forKey: .kind) {
            case "recording": target = .recording(id)
            case "asset": target = .asset(id)
            case let kind:
                throw DecodingError.dataCorruptedError(forKey: .kind, in: fields,
                    debugDescription: "A media row cannot be a \(kind)")
            }
            title = try fields.decode(String.self, forKey: .title)
            durationUs = try fields.decode(Int64.self, forKey: .durationUs)
            sizeBytes = try fields.decode(Int64.self, forKey: .sizeBytes)
            createdAt = try fields.decode(String.self, forKey: .createdAt)
        }
    }
    public struct Job: Decodable, Equatable, Sendable {
        public let id: String
        public let state: String
        public let reason: String?
        public let errorCode: String?
        public let retryable: Bool
        public var importFailed: Bool {
            !["idle", "queued", "running", "ready"].contains(state) && errorCode != nil && errorCode != "OWNER_DELETED"
        }
        public let details: Details?
        public struct Details: Decodable, Equatable, Sendable {
            public let retry: Retry?
            public struct Retry: Decodable, Equatable, Sendable {
                public let operation: String
                public let params: Params
                public struct Params: Decodable, Equatable, Sendable { public let jobId: String }
            }
        }
        public let target: Target
        /// The record the job works for, `{kind, id}`.
        public struct Target: Decodable, Equatable, Sendable {
            public let kind: String
            public let id: String
        }
    }
    public struct SourceAdmission: Decodable, Equatable, Sendable {
        public let kind: String
        public let sourceId: String
        public let acquisitionId: String?
        public var job: Job?
        public let admissionError: ControlsState.FinalizationError?
        public let publication: Publication?
        public struct Publication: Decodable, Equatable, Sendable {
            public enum State: String, Decodable, Sendable { case pending, published, unavailable }
            public struct Failure: Decodable, Equatable, Sendable {
                public let code: String
                public let message: String
            }
            public let state: State
            public let error: Failure?
        }
    }
    public struct DeleteRequest: Equatable, Sendable {
        public let target: MediaTarget
        /// One deletion keeps one replay identity: retrying after a lost reply asks the service for
        /// the original result instead of deleting again.
        public let requestId: String
        /// Whether this request also deletes the item's users. A cascade is a different request
        /// from the plain delete it follows, so it has its own identity.
        public var cascade = false
        /// Projects a confirmed cascade deletes with it, as the refusal named them.
        public var cascadeProjects: [String] = []
        public let title: String
        public let take: ControlsState.RecentTake?
        /// The page row, so a deletion still shows after its row leaves the page.
        public let media: Media?
        public var failure: String?
        public var isPending: Bool { failure == nil }
    }

    public mutating func beginDelete(_ target: MediaTarget, cascade: Bool = false, cascadeProjects users: [String]? = nil) -> Bool {
        guard deletions[target]?.isPending != true else { return false }
        if let old = deletions[target] {
            deletions[target] = .init(target: target, requestId: old.cascade == cascade ? old.requestId : UUID().uuidString,
                cascade: cascade, cascadeProjects: cascade ? users ?? old.cascadeProjects : [],
                title: old.title, take: old.take, media: old.media)
            return true
        }
        let requestId = UUID().uuidString
        let row = media.first { $0.target == target }
        switch target {
        case .recording(let id):
            let take = recent.first { $0.id == id }
            guard take != nil || row != nil else { return false }
            let title = take.map(LibraryPresentation.recordingTitle(of:)) ?? ElapsedTime.shortTime(of: row!.createdAt)
            deletions[target] = .init(target: target, requestId: requestId, cascade: cascade, cascadeProjects: users ?? [], title: title, take: take, media: row)
        case .asset:
            guard let row else { return false }
            deletions[target] = .init(target: target, requestId: requestId, cascade: cascade, cascadeProjects: users ?? [], title: row.title, take: nil, media: row)
        case .project(let id):
            guard let project = projects.first(where: { $0.id == id }) else { return false }
            deletions[target] = .init(target: target, requestId: requestId, cascade: cascade, cascadeProjects: users ?? [], title: project.title, take: nil, media: nil)
        }
        return true
    }
    /// The person declined: nothing was deleted, so the row reads as it did before.
    public mutating func cancelDelete(_ target: MediaTarget) {
        guard let request = deletions.removeValue(forKey: target) else { return }
        if case .recording = target, let take = request.take, !recent.contains(where: { $0.id == take.id }) {
            recent.append(take)
        }
        if let row = request.media, !media.contains(where: { $0.target == target }) { media.append(row) }
    }

    /// The name the delete dialog uses for a listed item: an import's filename, a recording's
    /// time (as its row reads), a project's title.
    public func confirmationName(for target: MediaTarget) -> String? {
        if let row = media.first(where: { $0.target == target }) ?? deletions[target]?.media {
            return row.target.isAsset ? row.title : ElapsedTime.shortTime(of: row.createdAt)
        }
        if case .project(let id) = target { return projects.first { $0.id == id }?.title ?? deletions[target]?.title }
        return nil
    }

    /// The plain dialog for a listed item, with its measured size where the page has one.
    public func confirmation(for target: MediaTarget) -> DeleteConfirmation? {
        guard let name = confirmationName(for: target) else { return nil }
        let size = (media.first { $0.target == target } ?? deletions[target]?.media)?.sizeBytes
        return .plain(target, name: name, sizeBytes: size)
    }

    public mutating func finishDelete(_ target: MediaTarget, failure: String?) {
        guard deletions[target] != nil else { return }
        if let failure { deletions[target]?.failure = failure; return }
        deletions.removeValue(forKey: target)
        media.removeAll { $0.target == target }
        switch target {
        case .recording(let id): recent.removeAll { $0.id == id }
        case .asset: break
        case .project(let id): projects.removeAll { $0.id == id }
        }
    }
}
