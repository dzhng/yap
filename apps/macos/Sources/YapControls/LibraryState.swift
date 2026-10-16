import Foundation

/// Service observations and explicit deletion requests, without a library lifecycle of their own.
public struct LibraryState: Equatable, Sendable {
    public init() {}
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

    public struct RecordingCursor: Codable, Equatable, Sendable {
        public let beforeSequence: Int
        public init(beforeSequence: Int) { self.beforeSequence = beforeSequence }
    }
    public struct ProjectCursor: Codable, Equatable, Sendable {
        /// The last sequence in a newest-first page; the next page contains lower sequences.
        public let afterSequence: Int
        public init(afterSequence: Int) { self.afterSequence = afterSequence }
    }
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
        public let title: String
        public let take: ControlsState.RecentTake?
        public var failure: String?
        public var isPending: Bool { failure == nil }
    }

    public mutating func beginDelete(_ target: MediaTarget) -> Bool {
        guard deletions[target]?.isPending != true else { return false }
        if let old = deletions[target] { deletions[target] = .init(target: target, title: old.title, take: old.take); return true }
        switch target {
        case .recording(let id):
            guard let take = recent.first(where: { $0.recordingId == id }) else { return false }
            deletions[target] = .init(target: target, title: LibraryPresentation.recordingTitle(of: take), take: take)
        case .project(let id):
            guard let project = projects.first(where: { $0.projectId == id }) else { return false }
            deletions[target] = .init(target: target, title: project.title, take: nil)
        }
        return true
    }
    public mutating func finishDelete(_ target: MediaTarget, failure: String?) {
        guard deletions[target] != nil else { return }
        if let failure { deletions[target]?.failure = failure; return }
        deletions.removeValue(forKey: target)
        switch target {
        case .recording(let id):
            recent.removeAll { $0.recordingId == id }
        case .project(let id): projects.removeAll { $0.projectId == id }
        }
    }
}
