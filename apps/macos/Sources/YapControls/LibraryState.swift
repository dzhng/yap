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
    public var deletions: [MediaTarget: DeleteRequest] = [:]

    public typealias RecordingCursor = String
    public typealias ProjectCursor = String
    public struct Project: Decodable, Equatable, Sendable {
        public let projectId: String
        public let title: String
        public let createdAt: String
        public let currentRevisionId: String
        private enum Keys: String, CodingKey { case title, createdAt, currentRevisionId }
        public init(from decoder: Decoder) throws {
            guard case .project(let id) = try MediaTarget(from: decoder) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected a project owner"))
            }
            projectId = id
            let fields = try decoder.container(keyedBy: Keys.self)
            title = try fields.decode(String.self, forKey: .title)
            createdAt = try fields.decode(String.self, forKey: .createdAt)
            currentRevisionId = try fields.decode(String.self, forKey: .currentRevisionId)
        }
    }
    /// One `media.list` row: a recording or an imported video, with its measured facts.
    public struct Media: Decodable, Equatable, Sendable {
        public enum Kind: String, Decodable, Sendable { case recording, imported }
        public let kind: Kind
        public let target: MediaTarget
        public let title: String
        public let durationUs: Int64
        public let sizeBytes: Int64
        public let createdAt: String
        public init(kind: Kind, target: MediaTarget, title: String, durationUs: Int64, sizeBytes: Int64, createdAt: String) {
            self.kind = kind; self.target = target; self.title = title
            self.durationUs = durationUs; self.sizeBytes = sizeBytes; self.createdAt = createdAt
        }
        private enum Keys: String, CodingKey { case kind, title, durationUs, sizeBytes, createdAt }
        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            kind = try fields.decode(Kind.self, forKey: .kind)
            target = try MediaTarget(from: decoder)
            switch (kind, target) {
            case (.recording, .recording), (.imported, .asset): break
            default:
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath,
                    debugDescription: "A \(kind.rawValue) row names the wrong owner"))
            }
            title = try fields.decode(String.self, forKey: .title)
            durationUs = try fields.decode(Int64.self, forKey: .durationUs)
            sizeBytes = try fields.decode(Int64.self, forKey: .sizeBytes)
            createdAt = try fields.decode(String.self, forKey: .createdAt)
        }
    }
    public struct Job: Decodable, Equatable, Sendable {
        public let jobId: String
        public let state: String
        public let reason: String?
        public let target: Target
        public struct Target: Decodable, Equatable, Sendable {
            public let kind: String
            public let acquisitionId: String?
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
        public let title: String
        public let take: ControlsState.RecentTake?
        /// The page row, so a deletion still shows after its row leaves the page.
        public let media: Media?
        public var failure: String?
        public var isPending: Bool { failure == nil }
    }

    public mutating func beginDelete(_ target: MediaTarget) -> Bool {
        guard deletions[target]?.isPending != true else { return false }
        if let old = deletions[target] {
            deletions[target] = .init(target: target, requestId: old.requestId, title: old.title, take: old.take, media: old.media)
            return true
        }
        let requestId = UUID().uuidString
        let row = media.first { $0.target == target }
        switch target {
        case .recording(let id):
            let take = recent.first { $0.recordingId == id }
            guard take != nil || row != nil else { return false }
            let title = take.map(LibraryPresentation.recordingTitle(of:)) ?? ElapsedTime.shortTime(of: row!.createdAt)
            deletions[target] = .init(target: target, requestId: requestId, title: title, take: take, media: row)
        case .asset:
            guard let row else { return false }
            deletions[target] = .init(target: target, requestId: requestId, title: row.title, take: nil, media: row)
        case .project(let id):
            guard let project = projects.first(where: { $0.projectId == id }) else { return false }
            deletions[target] = .init(target: target, requestId: requestId, title: project.title, take: nil, media: nil)
        }
        return true
    }
    public mutating func finishDelete(_ target: MediaTarget, failure: String?) {
        guard deletions[target] != nil else { return }
        if let failure { deletions[target]?.failure = failure; return }
        deletions.removeValue(forKey: target)
        media.removeAll { $0.target == target }
        switch target {
        case .recording(let id): recent.removeAll { $0.recordingId == id }
        case .asset: break
        case .project(let id): projects.removeAll { $0.projectId == id }
        }
    }
}
