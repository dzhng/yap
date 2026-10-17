import AppKit
import Darwin
import YapControls
import UniformTypeIdentifiers

/**
 The native export actions. Every export is one service export identity: this chooses its
 destination, pins the revision before the save panel opens, and reports what `export.status`
 answers. Retry, abandonment and cleanup stay with the service; after a restart, unfinished exports
 are rediscovered from `export.list` rather than from anything this app stored.
 */
@MainActor
final class ExportController {
    typealias Call = @MainActor (String, [String: Any]) async throws(ServiceFailure) -> Data
    /// Asks a person where to write an export. Nil means they chose not to export.
    typealias Choose = @MainActor (_ kind: ExportsState.Kind, _ suggestedName: String) async -> URL?

    private(set) var state = ExportsState()
    private let call: Call
    private let choose: Choose
    private let reveal: @MainActor (URL) -> Void
    private let changed: @MainActor () -> Void
    private let failure: @MainActor (String) -> Void
    private var observing = false
    private var discovering = false
    private var pendingDiscovery = false
    private var discoveryGeneration = 0

    init(
        call: @escaping Call, choose: @escaping Choose = ExportController.savePanel,
        reveal: @escaping @MainActor (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) },
        changed: @escaping @MainActor () -> Void, failure: @escaping @MainActor (String) -> Void
    ) {
        self.call = call
        self.choose = choose
        self.reveal = reveal
        self.changed = changed
        self.failure = failure
    }

    // MARK: acting

    func export(_ projectId: String, kind: ExportsState.Kind) {
        let target = MediaTarget.project(projectId)
        guard let choice = state.beginChoice(target: target, kind: kind) else { return }
        changed()
        Task { @MainActor in
            defer {
                if state.choosing == choice { state.choosing = nil }
                changed()
            }
            // The revision is pinned before the panel opens, so an edit made while a person picks
            // a folder does not change what they asked to export.
            let answer: Data
            do throws(ServiceFailure) {
                answer = try await call("project.get", target.parameters)
            } catch {
                guard state.choosing == choice else { return }
                return failure(error.localizedDescription)
            }
            guard state.choosing == choice else { return }
            guard let owner = try? JSONDecoder().decode(Owner.self, from: answer), owner.target == target else {
                return failure("The service returned an unreadable or different export owner.")
            }
            let revisionId = owner.currentRevisionId
            let destination = await choose(kind, Self.suggestedName(owner, revisionId, kind))
            guard state.choosing == choice, let destination else { return }
            // Foundation prettifies /private aliases; the broker's directory identity uses
            // the physical realpath instead. Resolve once and keep that request for replay.
            let directory = destination.deletingLastPathComponent().withUnsafeFileSystemRepresentation { path -> String? in
                guard let path, let resolved = realpath(path, nil) else { return nil }
                defer { free(resolved) }
                return String(cString: resolved)
            }
            guard let directory else { return failure("The selected export folder could not be resolved.") }
            let request = ExportsState.Request(
                exportId: choice.exportId, target: target, kind: kind,
                revisionId: revisionId, directory: directory,
                leaf: destination.lastPathComponent)
            state.send(request)
            await send(request)
        }
    }

    /// Inspector action: deterministic, collision-safe delivery to the user's Downloads folder.
    func exportToDownloads(_ projectId: String, revisionId: String, kind: ExportsState.Kind = .video) {
        let target = MediaTarget.project(projectId)
        guard state.choosing == nil else { return }
        let exportId = UUID().uuidString.lowercased()
        Task { @MainActor in
            do throws(ServiceFailure) {
                let answer = try await call("project.get", target.parameters)
                guard let owner = try? JSONDecoder().decode(Owner.self, from: answer) else {
                    throw ServiceFailure(code: "INVALID_RESPONSE", message: "The service returned an unreadable project")
                }
                guard owner.target == target else { throw ServiceFailure(code: "INVALID_RESPONSE", message: "The service returned a different project") }
                let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                    ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
                do { try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true) }
                catch { throw ServiceFailure(code: "INVALID_DESTINATION", message: error.localizedDescription) }
                let stem = "Project \((owner.title ?? projectId).replacingOccurrences(of: "/", with: "-")) \(revisionId)"
                let ext = kind == .audio ? "wav" : kind == .package ? "zip" : "mp4"
                var index = 0
                var leaf = "\(stem).\(ext)"
                while FileManager.default.fileExists(atPath: downloads.appendingPathComponent(leaf).path) {
                    index += 1; leaf = "\(stem) (\(index)).\(ext)"
                }
                let directory = downloads.path
                let request = ExportsState.Request(exportId: exportId, target: target, kind: kind,
                    revisionId: revisionId, directory: directory, leaf: leaf)
                state.send(request)
                changed()
                await send(request)
            } catch { failure(error.localizedDescription) }
        }
    }

    func resend(_ exportId: String) {
        guard let request = state.resend(exportId) else { return }
        changed()
        Task { @MainActor in
            await send(request)
            changed()
        }
    }

    func retry(_ exportId: String) {
        guard state.begin(.retry, exportId) else { return }
        changed()
        Task { @MainActor in
            defer { changed() }
            do throws(ServiceFailure) {
                guard let jobId = state.records.first(where: { $0.exportId == exportId })?.jobId else {
                    throw ServiceFailure(code: "NOT_READY", message: "Export has no retryable job", retryable: true)
                }
                let answer = try await call("job.retry", ["jobId": jobId])
                guard known(exportId) else { return }
                state.update(try record(answer, exportId: exportId))
                state.finish(exportId, failure: nil)
            } catch where Self.unanswered.contains(error.code) {
                guard known(exportId) else { return }
                state.finish(exportId, failure: nil)
                state.readFailures[exportId] = error.localizedDescription
            } catch where error.code == "NOT_FOUND" {
                state.forget(exportId)
            } catch {
                guard known(exportId) else { return }
                state.finish(exportId, failure: error.localizedDescription)
            }
        }
    }

    /// Abandonment drains the export and removes its private staging; a committed file remains.
    /// For an unconfirmed request it also settles whether that request was ever admitted.
    func abandon(_ exportId: String) {
        guard state.begin(.abandon, exportId) else { return }
        changed()
        Task { @MainActor in
            defer { changed() }
            do throws(ServiceFailure) {
                _ = try await call("export.abandon", ["exportId": exportId])
                state.forget(exportId)
            } catch {
                guard known(exportId) else { return }
                state.finish(exportId, failure: error.localizedDescription)
            }
        }
    }

    func reveal(_ exportId: String) {
        guard let output = state.records.first(where: { $0.exportId == exportId })?.output else { return }
        reveal(URL(fileURLWithPath: output))
    }

    func dismiss(_ exportId: String) {
        state.dismiss(exportId)
        changed()
    }

    func forget(target: MediaTarget) {
        state.forget(target: target)
        discoveryGeneration += 1
        if discovering { pendingDiscovery = true }
        changed()
    }

    // MARK: observing

    /// Reads the status of every export that can still change without a person acting here.
    /// One sweep at a time; the controls cadence calls this again.
    func tick() {
        let observed = state.observed
        guard !observing, !observed.isEmpty else { return }
        observing = true
        Task { @MainActor in
            defer { observing = false }
            var changedAny = false
            for exportId in observed {
                let unconfirmed = state.requests.contains { $0.exportId == exportId }
                do throws(ServiceFailure) {
                    let answer = try await call("export.status", ["exportId": exportId])
                    guard known(exportId) else { continue }
                    let record = try record(answer, exportId: exportId)
                    if unconfirmed { state.admit(record) } else { state.update(record) }
                    changedAny = true
                } catch where error.code == "NOT_FOUND" {
                    // An unconfirmed request may simply not have been admitted; it stays until a
                    // person sends it again or abandons it. A described export is gone for good.
                    if !unconfirmed {
                        state.forget(exportId)
                        changedAny = true
                    }
                } catch where error.code == "INVALID_RESPONSE" {
                    guard known(exportId) else { continue }
                    state.readFailures[exportId] = error.localizedDescription
                    changedAny = true
                } catch {
                    // A transient read failure changes nothing a person can act on.
                }
            }
            if changedAny { changed() }
        }
    }

    /// Finds unfinished exports, including ones from before this app launched, and reads the
    /// status of each. Overlapping requests coalesce into one follow-up traversal.
    func discover() {
        guard !discovering else {
            pendingDiscovery = true
            return
        }
        discovering = true
        let generation = discoveryGeneration
        Task { @MainActor in
            defer {
                discovering = false
                changed()
                if pendingDiscovery {
                    pendingDiscovery = false
                    discover()
                }
            }
            var cursor: Any = NSNull()
            var failedStatus: String?
            do throws(ServiceFailure) {
                repeat {
                    var params: [String: Any] = ["unfinishedOnly": true]
                    if !(cursor is NSNull) { params["cursor"] = cursor }
                    let data = try await call("export.list", params)
                    guard generation == discoveryGeneration else { return }
                    guard let page = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                        let summaries = page["exports"] as? [[String: Any]]
                    else {
                        throw ServiceFailure(code: "INVALID_RESPONSE", message: "export.list returned unreadable data")
                    }
                    for summary in summaries {
                        guard let exportId = summary["exportId"] as? String else {
                            failedStatus = failedStatus ?? "INVALID_RESPONSE: export.list returned an unreadable export identity"
                            continue
                        }
                        do throws(ServiceFailure) {
                            let answer = try await call("export.status", ["exportId": exportId])
                            guard generation == discoveryGeneration else { return }
                            let record = try record(answer, exportId: exportId)
                            if state.requests.contains(where: { $0.exportId == exportId }) {
                                state.admit(record)
                            } else {
                                state.update(record)
                            }
                        } catch where error.code == "NOT_FOUND" {
                            // Retired between the page and its status read.
                        } catch {
                            guard generation == discoveryGeneration else { return }
                            failedStatus = failedStatus ?? error.localizedDescription
                        }
                    }
                    cursor = page["nextCursor"] ?? NSNull()
                } while !(cursor is NSNull)
                state.discoveryFailure = failedStatus
            } catch {
                guard generation == discoveryGeneration else { return }
                state.discoveryFailure = error.localizedDescription
            }
        }
    }

    // MARK: sending

    private func send(_ request: ExportsState.Request) async {
        var params: [String: Any] = [
            "exportId": request.exportId,
            "kind": request.kind.rawValue, "revisionId": request.revisionId,
            "directory": request.directory, "leaf": request.leaf,
        ]
        for (key, value) in request.target.parameters { params[key] = value }
        do throws(ServiceFailure) {
            let answer = try await call("export.create", params)
            guard known(request.exportId) else { return }
            state.admit(try record(answer, exportId: request.exportId))
        } catch where Self.unanswered.contains(error.code) {
            guard known(request.exportId) else { return }
            state.unanswered(request.exportId, reason: error.localizedDescription)
        } catch {
            guard known(request.exportId) else { return }
            state.refuse(request.exportId)
            failure(error.localizedDescription)
        }
    }

    /// Failures that leave open whether the service admitted the request.
    private static let unanswered: Set = ["TIMEOUT", "SERVICE_STOPPED", "SERVICE_UNAVAILABLE", "INVALID_RESPONSE"]

    private func record(_ data: Data, exportId: String) throws(ServiceFailure) -> ExportsState.Record {
        let record: ExportsState.Record
        do {
            record = try JSONDecoder().decode(ExportsState.Record.self, from: data)
        } catch {
            throw ServiceFailure(code: "INVALID_RESPONSE", message: "Unreadable export status for \(exportId): \(error.localizedDescription)")
        }
        guard record.exportId == exportId else {
            throw ServiceFailure(code: "INVALID_RESPONSE", message: "Export status returned a different exportId for \(exportId)")
        }
        let request = state.requests.first { $0.exportId == exportId }
        let previous = state.records.first { $0.exportId == exportId }
        if let expected = request?.target ?? previous?.target {
            guard record.target == expected,
                record.revisionId == (request?.revisionId ?? previous?.revisionId),
                record.kind == (request?.kind ?? previous?.kind),
                record.directory == (request?.directory ?? previous?.directory),
                record.leaf == (request?.leaf ?? previous?.leaf)
            else {
                throw ServiceFailure(code: "INVALID_RESPONSE", message: "Export status returned a different owner or snapshot for \(exportId)")
            }
        }
        return record
    }

    private func known(_ exportId: String) -> Bool {
        state.requests.contains { $0.exportId == exportId } || state.records.contains { $0.exportId == exportId }
    }

    // MARK: destination

    private static func suggestedName(_ owner: Owner, _ revisionId: String, _ kind: ExportsState.Kind)
        -> String
    {
        if case .project(let id) = owner.target {
            let title = (owner.title ?? id).replacingOccurrences(of: "/", with: "-")
                .replacingOccurrences(of: ":", with: "-")
                .components(separatedBy: .controlCharacters).joined(separator: " ")
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            return "Project \(name.isEmpty ? id : name) \(revisionId)" + (kind == .video ? ".mp4" : kind == .audio ? ".wav" : ".zip")
        }
        let when = ISO8601DateFormatter.fractional.date(from: owner.createdAt)
            ?? ISO8601DateFormatter().date(from: owner.createdAt) ?? Date()
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let base = "Recording \(stamp.string(from: when)) \(revisionId)"
        return base + (kind == .video ? ".mp4" : kind == .audio ? ".wav" : ".zip")
    }

    static func savePanel(kind: ExportsState.Kind, suggestedName: String) async -> URL? {
        let panel = NSSavePanel()
        panel.title = kind == .video ? "Export Video" : kind == .audio ? "Export Audio" : "Export AI Package"
        if kind == .package {
            panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        }
        panel.nameFieldStringValue = suggestedName
        panel.allowedContentTypes = [kind == .video ? .mpeg4Movie : kind == .audio ? .wav : .zip]
        panel.canCreateDirectories = true
        // Choosing where to save is this person's business, not the take's: a panel that opens
        // while one is recording stays out of it, as this app's own panels do.
        panel.sharingType = .none
        NSApp.activate(ignoringOtherApps: true)
        return await withCheckedContinuation { continuation in
            panel.begin { response in
                continuation.resume(returning: response == .OK ? panel.url : nil)
            }
        }
    }

    private struct Owner: Decodable {
        let target: MediaTarget
        let createdAt: String
        let title: String?
        let currentRevisionId: String
        private enum Keys: String, CodingKey { case createdAt, title, currentRevisionId }
        init(from decoder: Decoder) throws {
            target = try MediaTarget(from: decoder)
            let fields = try decoder.container(keyedBy: Keys.self)
            createdAt = try fields.decode(String.self, forKey: .createdAt)
            title = try fields.decodeIfPresent(String.self, forKey: .title)
            currentRevisionId = try fields.decode(String.self, forKey: .currentRevisionId)
        }
    }
}

extension ISO8601DateFormatter {
    fileprivate static var fractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter
    }
}
