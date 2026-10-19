import Foundation

/**
 What the menu knows about exports. The service owns each export's lifecycle, destination and
 cleanup; this holds only the destination a person is choosing, requests whose answer has not
 arrived, and the latest service description of each export this app has seen — including
 unfinished exports rediscovered after a restart.
 */
public struct ExportsState: Equatable, Sendable {
    public init() {}

    public enum Kind: String, Equatable, Sendable, Decodable {
        case video
        case audio
        case package = "processed-package"
        case srt
        case vtt
    }

    /// One export destination being chosen; its identity also fences a replaced choice.
    public struct Choice: Equatable, Sendable {
        public let exportId: String
        public let target: MediaTarget
        public let kind: Kind
    }

    /// A request the service has not confirmed. Its ID is fixed before the first send, so asking
    /// again after a lost reply names the same export instead of creating a second one.
    public struct Request: Equatable, Sendable {
        public init(
            exportId: String, target: MediaTarget, kind: Kind, revisionId: String,
            directory: String, leaf: String
        ) {
            self.exportId = exportId
            self.target = target
            self.kind = kind
            self.revisionId = revisionId
            self.directory = directory
            self.leaf = leaf
        }
        public let exportId: String
        public let target: MediaTarget
        public let kind: Kind
        public let revisionId: String
        public let directory: String
        public let leaf: String
        /// Why the last send went unanswered; nil while a send is outstanding.
        public var unconfirmed: String?
    }

    /// One export as `export.status` last described it.
    public struct Record: Equatable, Sendable, Decodable {
        public init(
            exportId: String, target: MediaTarget, kind: Kind, revisionId: String, state: String,
            directory: String, leaf: String, output: String?, reason: String?, retryable: Bool,
            abandoning: Bool, cleanupPending: Bool, jobId: String? = nil
        ) {
            self.exportId = exportId
            self.target = target
            self.kind = kind
            self.revisionId = revisionId
            self.state = state
            self.jobId = jobId
            self.directory = directory
            self.leaf = leaf
            self.output = output
            self.reason = reason
            self.retryable = retryable
            self.abandoning = abandoning
            self.cleanupPending = cleanupPending
        }
        public let exportId: String
        public let target: MediaTarget
        public let kind: Kind
        public let revisionId: String
        public let state: String
        public let jobId: String?
        public let directory: String
        public let leaf: String
        /// The committed file; nil until the export is committed.
        public let output: String?
        public let reason: String?
        public let retryable: Bool
        public let abandoning: Bool
        public let cleanupPending: Bool

        public var committed: Bool { state == "ready" }
        /// An uncommitted attempt that is no longer running and waits for a person's retry.
        public var stopped: Bool { ["failed", "canceled", "unavailable", "idle"].contains(state) }
        /// Nothing changes until someone asks: a clean commit, or an attempt that stopped.
        public var settled: Bool { !abandoning && (committed ? !cleanupPending : stopped) }

        private enum Keys: String, CodingKey {
            case id, kind, snapshot, state, jobId, destination, output, reason
            case retryable, abandoning, cleanupPending
        }
        private enum SnapshotKeys: String, CodingKey { case revisionId }
        private enum DestinationKeys: String, CodingKey { case directory, leaf }

        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            let snapshot = try fields.nestedContainer(keyedBy: SnapshotKeys.self, forKey: .snapshot)
            let destination = try fields.nestedContainer(
                keyedBy: DestinationKeys.self, forKey: .destination)
            self.init(
                exportId: try fields.decode(String.self, forKey: .id),
                target: try MediaTarget(from: decoder),
                kind: try fields.decode(Kind.self, forKey: .kind),
                revisionId: try snapshot.decode(String.self, forKey: .revisionId),
                state: try fields.decode(String.self, forKey: .state),
                directory: try destination.decode(String.self, forKey: .directory),
                leaf: try destination.decode(String.self, forKey: .leaf),
                output: try fields.decodeIfPresent(String.self, forKey: .output),
                reason: try fields.decodeIfPresent(String.self, forKey: .reason),
                retryable: try fields.decode(Bool.self, forKey: .retryable),
                abandoning: try fields.decode(Bool.self, forKey: .abandoning),
                cleanupPending: try fields.decode(Bool.self, forKey: .cleanupPending),
                jobId: try fields.decodeIfPresent(String.self, forKey: .jobId))
        }
    }

    public enum Action: Equatable, Sendable { case retry, abandon }

    public var choosing: Choice?
    public var requests: [Request] = []
    /// Newest request first; rediscovered exports follow in the service's order.
    public var records: [Record] = []
    /// Actions sent for an export and not yet answered.
    public var acting: [String: Action] = [:]
    /// The last refused action per export, shown until the next action on it.
    public var failures: [String: String] = [:]
    /// A reply that could not establish export state, resolved by the next valid status.
    public var readFailures: [String: String] = [:]
    public var discoveryFailure: String?

    /// Only one destination can be chosen at a time; exporting another take afterwards is fine.
    public mutating func beginChoice(target: MediaTarget, kind: Kind) -> Choice? {
        // Caption deliveries are observed here; their explicit placement selection belongs to callers.
        guard choosing == nil, kind != .srt, kind != .vtt else { return nil }
        let choice = Choice(exportId: UUID().uuidString.lowercased(), target: target, kind: kind)
        choosing = choice
        return choice
    }

    public mutating func send(_ request: Request) {
        choosing = nil
        requests.insert(request, at: 0)
    }

    /// The service described the export, so the request is no longer outstanding.
    public mutating func admit(_ record: Record) {
        requests.removeAll { $0.exportId == record.exportId }
        update(record, newest: true)
    }

    /// A definite refusal ends the request: nothing was admitted under its ID.
    public mutating func refuse(_ exportId: String) {
        requests.removeAll { $0.exportId == exportId }
        readFailures.removeValue(forKey: exportId)
    }

    public mutating func unanswered(_ exportId: String, reason: String) {
        guard let index = requests.firstIndex(where: { $0.exportId == exportId }) else { return }
        requests[index].unconfirmed = reason
    }

    /// Sends the same request again under its original ID, if it is not already outstanding.
    public mutating func resend(_ exportId: String) -> Request? {
        guard let index = requests.firstIndex(where: { $0.exportId == exportId }),
            requests[index].unconfirmed != nil, acting[exportId] == nil
        else { return nil }
        requests[index].unconfirmed = nil
        return requests[index]
    }

    public mutating func update(_ record: Record, newest: Bool = false) {
        readFailures.removeValue(forKey: record.exportId)
        if let index = records.firstIndex(where: { $0.exportId == record.exportId }) {
            records[index] = record
        } else if newest {
            records.insert(record, at: 0)
        } else {
            records.append(record)
        }
    }

    /// The export no longer exists: abandoned, or retired with its recording.
    public mutating func forget(_ exportId: String) {
        requests.removeAll { $0.exportId == exportId }
        records.removeAll { $0.exportId == exportId }
        acting.removeValue(forKey: exportId)
        failures.removeValue(forKey: exportId)
        readFailures.removeValue(forKey: exportId)
    }

    /// A deleted owner retires its exports in the service; their external files remain.
    public mutating func forget(target: MediaTarget) {
        if choosing?.target == target { choosing = nil }
        for exportId in requests.filter({ $0.target == target }).map(\.exportId)
            + records.filter({ $0.target == target }).map(\.exportId)
        {
            forget(exportId)
        }
    }

    public mutating func begin(_ action: Action, _ exportId: String) -> Bool {
        let known = requests.contains { $0.exportId == exportId && $0.unconfirmed != nil }
            || records.contains { $0.exportId == exportId }
        guard known, acting[exportId] == nil else { return false }
        acting[exportId] = action
        failures.removeValue(forKey: exportId)
        return true
    }

    public mutating func finish(_ exportId: String, failure: String?) {
        acting.removeValue(forKey: exportId)
        if let failure { failures[exportId] = failure }
    }

    /// A settled, committed export can leave this list; the file and its service history remain.
    public mutating func dismiss(_ exportId: String) {
        guard let record = records.first(where: { $0.exportId == exportId }), record.committed,
            record.settled, acting[exportId] == nil
        else { return }
        forget(exportId)
    }

    /// Exports whose status can still change without a person acting here.
    public var observed: [String] {
        requests.filter { $0.unconfirmed != nil }.map(\.exportId)
            + records.filter {
                !$0.settled || acting[$0.exportId] != nil || readFailures[$0.exportId] != nil
            }.map(\.exportId)
    }
}
