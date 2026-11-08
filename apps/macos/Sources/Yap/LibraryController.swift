import Foundation
import YapControls

/// The public library reads and explicit deletion requests shared by native presentation.
@MainActor
final class LibraryController {
    typealias Call = @MainActor (String, [String: Any]) async throws(ServiceFailure) -> Data
    /// Asks the person one delete question and answers whether they confirmed it.
    typealias Confirm = @MainActor (DeleteConfirmation) async -> Bool
    private let failure: (ControlsAction, String?) -> Void
    private let call: Call
    private let confirm: Confirm
    private let changed: () -> Void
    private let closePreview: (MediaTarget) -> Void
    private let forgetExports: (MediaTarget) -> Void
    private let deleted: () -> Void
    private let preview: (String) -> Void
    private let export: (String, ExportsState.Kind) -> Void
    private(set) var state = LibraryState() { didSet { changed() } }
    private var ready = false
    private var serviceGeneration = UUID()
    private var recordingGeneration = UUID()
    private var projectGeneration = UUID()
    private var pendingRecordings = false
    private var jobsReading = false
    private var pendingProjects = false
    private var recordingPages: [LibraryState.RecordingCursor?] = [nil]
    private var recordingPageIndex = 0
    private var projectPages: [LibraryState.ProjectCursor?] = [nil]
    private var projectPageIndex = 0

    init(call: @escaping Call, confirm: @escaping Confirm, changed: @escaping () -> Void,
        closePreview: @escaping (MediaTarget) -> Void, forgetExports: @escaping (MediaTarget) -> Void,
        deleted: @escaping () -> Void,
        preview: @escaping (String) -> Void, export: @escaping (String, ExportsState.Kind) -> Void,
        failure: @escaping (ControlsAction, String?) -> Void)
    {
        self.failure = failure
        self.call = call; self.confirm = confirm; self.changed = changed; self.closePreview = closePreview
        self.forgetExports = forgetExports; self.deleted = deleted
        self.preview = preview; self.export = export
    }

    func serviceChanged(ready: Bool) {
        self.ready = ready
        serviceGeneration = UUID(); recordingGeneration = UUID(); projectGeneration = UUID()
        state.recordingsRefreshing = false; jobsReading = false; pendingRecordings = false; pendingProjects = false
        state.projectsRefreshing = false
        state.progressFailure = nil
        for take in state.recent {
            for source in take.sourceAdmissions ?? [] {
                if let job = source.job { failure(.retryImport(job.id), nil) }
            }
        }
        state.retryingImports = []
        // An unanswered deletion keeps its identity but must be explicitly retried on the new service.
        for target in state.deletions.keys where state.deletions[target]?.isPending == true {
            state.finishDelete(target, failure: "Delete was not confirmed.")
        }
        recordingPages = [nil]; recordingPageIndex = 0; state.hasPreviousRecordingPage = false
        state.nextRecordingCursor = nil
        projectPages = [nil]; projectPageIndex = 0; state.hasPreviousProjectPage = false
        state.nextProjectCursor = nil
        if ready { refresh() }
    }

    func refresh() { refreshRecordings(); refreshProjects() }

    /// Delivery remains owned by the existing controllers; this boundary resolves library identity.
    func perform(_ action: ControlsAction) -> Bool {
        switch action {
        case .previewProject(let id): if usable(id) { preview(id) }
        case .exportProject(let id, let kind): if usable(id) { export(id, kind) }
        case .retryImport(let id): retryImport(id)
        case .deleteRecording(let id): requestDelete(.recording(id))
        case .deleteAsset(let id): requestDelete(.asset(id))
        case .deleteProject(let id): requestDelete(.project(id))
        case .nextRecordings: nextRecordings()
        case .previousRecordings: previousRecordings()
        case .nextProjects: nextProjects()
        case .previousProjects: previousProjects()
        case .refreshLibrary: refresh()
        default: return false
        }
        return true
    }
    private func usable(_ projectId: String) -> Bool {
        ready && state.deletions[.project(projectId)] == nil && state.projects.contains { $0.id == projectId }
    }

    func refreshRecordings() {
        guard !state.recordingsRefreshing else { pendingRecordings = true; return }
        readRecordings(index: recordingPageIndex)
    }
    func nextRecordings() {
        guard ready, !state.recordingsRefreshing, let cursor = state.nextRecordingCursor else { return }
        recordingPages = Array(recordingPages.prefix(recordingPageIndex + 1)) + [cursor]
        readRecordings(index: recordingPageIndex + 1)
    }
    func previousRecordings() {
        guard recordingPageIndex > 0 else { return }
        pendingRecordings = false
        readRecordings(index: recordingPageIndex - 1)
    }
    private func readRecordings(index: Int) {
        guard ready else { return }
        state.recordingsRefreshing = true
        recordingGeneration = UUID(); jobsReading = false
        let service = serviceGeneration, generation = recordingGeneration, cursor = recordingPages[index]
        Task { @MainActor in
            do throws(ServiceFailure) {
                var params: [String: Any] = ["limit": 5]
                if let cursor { params["cursor"] = cursor }
                let page: Media = try await read("media.list", params)
                guard service == serviceGeneration && generation == recordingGeneration else { return }
                guard page.media.count <= 5,
                    Set(page.media.map(\.target)).count == page.media.count,
                    page.nextCursor.map({ !$0.isEmpty && !page.media.isEmpty }) ?? true else {
                    throw Self.invalid("Unreadable media page or cursor")
                }
                // A recording row's status and sources come from the recording itself.
                var takes: [ControlsState.RecentTake] = []
                var vanished: Set<MediaTarget> = []
                for case .recording(let id) in page.media.map(\.target) {
                    let take: ControlsState.RecentTake
                    do throws(ServiceFailure) { take = try await read("recording.get", ["recordingId": id]) }
                    catch where error.code == "NOT_FOUND" {
                        // Deleted elsewhere since the page was read: it drops from this page.
                        vanished.insert(.recording(id)); continue
                    }
                    guard service == serviceGeneration && generation == recordingGeneration else { return }
                    guard take.id == id else { throw Self.invalid("Recording returned a different identity") }
                    try validate(take)
                    takes.append(take)
                }
                state.media = page.media.filter { state.deletions[$0.target] == nil && !vanished.contains($0.target) }
                for take in takes {
                    for source in take.sourceAdmissions ?? [] where source.job?.state == "ready" {
                        failure(.retryImport(source.job!.id), nil)
                    }
                }
                state.recent = takes.filter { state.deletions[.recording($0.id)] == nil }
                state.nextRecordingCursor = page.nextCursor
                recordingPageIndex = index; state.hasPreviousRecordingPage = index > 0
                state.recordingFailure = nil
                state.progressFailure = nil
            } catch {
                guard service == serviceGeneration && generation == recordingGeneration else { return }
                state.recordingFailure = error.localizedDescription
            }
            guard service == serviceGeneration && generation == recordingGeneration else { return }
            state.recordingsRefreshing = false
            if pendingRecordings { pendingRecordings = false; refreshRecordings() }
        }
    }

    func refreshProjects() {
        guard !state.projectsRefreshing else { pendingProjects = true; return }
        readProjects(index: projectPageIndex)
    }
    func nextProjects() {
        guard ready, !state.projectsRefreshing, let cursor = state.nextProjectCursor else { return }
        projectPages = Array(projectPages.prefix(projectPageIndex + 1)) + [cursor]
        readProjects(index: projectPageIndex + 1)
    }
    func previousProjects() {
        guard projectPageIndex > 0 else { return }
        readProjects(index: projectPageIndex - 1)
    }
    private func readProjects(index: Int) {
        guard ready else { return }
        projectGeneration = UUID()
        let generation = projectGeneration, service = serviceGeneration, cursor = projectPages[index]
        state.projectsRefreshing = true
        Task { @MainActor in
            do throws(ServiceFailure) {
                var params: [String: Any] = ["limit": 5]
                if let cursor { params["cursor"] = cursor }
                let page: Projects = try await read("project.list", params)
                guard service == serviceGeneration && generation == projectGeneration else { return }
                guard page.projects.count <= 5,
                    Set(page.projects.map(\.id)).count == page.projects.count,
                    page.nextCursor.map({ !$0.isEmpty }) ?? true else {
                    throw Self.invalid("Unreadable project page or cursor")
                }
                state.projects = page.projects.filter { state.deletions[.project($0.id)] == nil }
                state.nextProjectCursor = page.nextCursor
                projectPageIndex = index; state.hasPreviousProjectPage = index > 0
                state.projectFailure = nil
            } catch {
                guard service == serviceGeneration && generation == projectGeneration else { return }
                state.projectFailure = error.localizedDescription
            }
            guard service == serviceGeneration && generation == projectGeneration else { return }
            state.projectsRefreshing = false
            if pendingProjects { pendingProjects = false; refreshProjects() }
        }
    }

    /// A new delete is confirmed first; retrying one the service never confirmed resends that same
    /// request, cascade included, without asking again.
    func requestDelete(_ target: MediaTarget) {
        guard ready, state.deletions[target]?.isPending != true else { return }
        if let failed = state.deletions[target] { delete(target, cascade: failed.cascade); return }
        guard let dialog = state.confirmation(for: target) else { return }
        Task { @MainActor in
            if await confirm(dialog) { delete(target, cascade: false) }
        }
    }

    func delete(_ target: MediaTarget, cascade: Bool = false, projects: [String]? = nil) {
        guard ready, state.beginDelete(target, cascade: cascade, cascadeProjects: projects),
            let requestId = state.deletions[target]?.requestId else { return }
        let alsoDeleted = state.deletions[target]?.cascadeProjects ?? []
        // Catalog answers started before this action cannot restore the retired owner.
        recordingGeneration = UUID(); projectGeneration = UUID(); jobsReading = false
        state.recordingsRefreshing = false; state.projectsRefreshing = false; pendingRecordings = false; pendingProjects = false
        closePreview(target)
        let service = serviceGeneration
        Task { @MainActor in
            do throws(ServiceFailure) {
                let operation = switch target {
                case .recording: "recording.delete"
                case .asset: "asset.delete"
                case .project: "project.delete"
                }
                var params: [String: Any] = target.parameters
                params["requestId"] = requestId
                if cascade { params["cascade"] = true }
                let receipt: Deletion = try await read(operation, params)
                guard service == serviceGeneration else { return }
                guard receipt.id == target.id && receipt.deleted else {
                    throw Self.invalid("The service did not confirm deletion of \(target.id).")
                }
                recordingGeneration = UUID(); projectGeneration = UUID(); jobsReading = false
                state.recordingsRefreshing = false; state.projectsRefreshing = false
                state.finishDelete(target, failure: nil)
                forgetExports(target)
                // The projects the cascade took with it are gone too.
                for id in alsoDeleted {
                    closePreview(.project(id)); forgetExports(.project(id))
                    state.projects.removeAll { $0.id == id }
                }
                deleted()
            } catch {
                guard service == serviceGeneration else { return }
                // Something still uses it: the refusal itself says what, and asking once more is
                // the only way the users go too.
                if error.code == "IN_USE", !cascade, let details = error.details,
                    let inUse = try? JSONDecoder().decode(DeleteConfirmation.InUse.self, from: details),
                    let name = state.confirmationName(for: target) {
                    state.finishDelete(target, failure: error.localizedDescription)
                    if await confirm(.cascade(target, name: name, inUse: inUse)) {
                        delete(target, cascade: true, projects: inUse.usedBy.map(\.id))
                    } else {
                        state.cancelDelete(target)
                    }
                    refresh()
                    return
                }
                state.finishDelete(target, failure: error.localizedDescription)
            }
            refresh()
        }
    }

    private func retryImport(_ jobId: String) {
        guard ready, !state.recordingsRefreshing, !state.retryingImports.contains(jobId),
            let take = state.recent.first(where: { $0.sourceAdmissions?.contains { $0.kind == "primary" && $0.job?.id == jobId } == true }),
            state.deletions[.recording(take.id)] == nil,
            let admission = take.sourceAdmissions?.first(where: { $0.kind == "primary" }),
            let job = admission.job, job.retryJobId == jobId else { return }
        recordingGeneration = UUID(); jobsReading = false
        state.retryingImports.insert(jobId)
        let service = serviceGeneration
        Task { @MainActor in
            defer { if service == serviceGeneration { state.retryingImports.remove(jobId) } }
            do throws(ServiceFailure) {
                let answer: LibraryState.Job = try await read("job.retry", ["jobId": jobId])
                guard service == serviceGeneration else { return }
                guard answer.id == jobId, answer.target == job.target, Self.valid(answer) else {
                    throw Self.invalid("Preparation returned a different source job")
                }
                replaceJob(take.id, admission.sourceId, answer)
                failure(.retryImport(jobId), nil)
            } catch {
                guard service == serviceGeneration else { return }
                failure(.retryImport(jobId), error.localizedDescription)
            }
        }
    }

    /// Uses the existing capture cadence, and only reads occupied jobs on visible source receipts.
    func tick() {
        guard ready, !jobsReading, !state.recordingsRefreshing,
            state.recent.contains(where: Self.pending) else { return }
        jobsReading = true
        let service = serviceGeneration, generation = recordingGeneration
        Task { @MainActor in
            defer { if service == serviceGeneration && generation == recordingGeneration { jobsReading = false } }
            var failure: String?
            for take in state.recent {
                guard state.deletions[.recording(take.id)] == nil else { continue }
                if Self.pendingAdmission(take) {
                    do throws(ServiceFailure) {
                        let answer: ControlsState.RecentTake = try await read("recording.get", ["recordingId": take.id])
                        guard service == serviceGeneration && generation == recordingGeneration else { return }
                        guard answer.id == take.id else { throw Self.invalid("Recording returned a different identity") }
                        try validate(answer)
                        if let index = state.recent.firstIndex(where: { $0.id == take.id }) { state.recent[index] = answer }
                    } catch {
                        guard service == serviceGeneration && generation == recordingGeneration else { return }
                        failure = failure ?? error.localizedDescription
                    }
                }
                for admission in take.sourceAdmissions ?? [] where Self.active(admission) {
                    do throws(ServiceFailure) {
                        let job: LibraryState.Job = try await read("job.get", ["jobId": admission.job!.id])
                        guard service == serviceGeneration && generation == recordingGeneration else { return }
                        guard job.id == admission.job!.id, job.target.kind == "acquisition",
                            job.target.id == admission.acquisitionId, Self.valid(job) else {
                            throw Self.invalid("Preparation returned a different source job")
                        }
                        replaceJob(take.id, admission.sourceId, job)
                    } catch {
                        guard service == serviceGeneration && generation == recordingGeneration else { return }
                        failure = failure ?? error.localizedDescription
                    }
                }
            }
            state.progressFailure = failure
        }
    }

    /// A source whose publication is unavailable (a camera never turned on, say) has nothing to
    /// admit, so it is settled rather than awaited.
    private static func pendingAdmission(_ take: ControlsState.RecentTake) -> Bool {
        guard take.sourceAdmissions != nil else { return false }
        return take.state == "finalizing" || take.sourceAdmissions!.contains {
            $0.admissionError == nil && $0.publication?.state != .unavailable
                && ($0.acquisitionId == nil || $0.job == nil)
        }
    }
    private static func pending(_ take: ControlsState.RecentTake) -> Bool {
        pendingAdmission(take) || take.sourceAdmissions?.contains(where: active) == true
    }
    private func validate(_ take: ControlsState.RecentTake) throws(ServiceFailure) {
        let admissions = take.sourceAdmissions ?? []
        guard admissions.count <= 2, Set(admissions.map(\.kind)).count == admissions.count,
            Set(admissions.map(\.sourceId)).count == admissions.count,
            admissions.allSatisfy({ admission in
                ["primary", "camera"].contains(admission.kind) && !admission.sourceId.isEmpty
                    && (admission.job.map { $0.target.kind == "acquisition" && $0.target.id == admission.acquisitionId && admission.acquisitionId != nil && Self.valid($0) } ?? true)
            }) else { throw Self.invalid("Unreadable source admission receipt") }
    }

    private static func valid(_ job: LibraryState.Job) -> Bool {
        !job.id.isEmpty && ["idle", "queued", "running", "ready", "failed", "unavailable", "canceled"].contains(job.state)
    }
    private static func active(_ admission: LibraryState.SourceAdmission) -> Bool {
        admission.job.map { $0.isActive } ?? false
    }
    private func replaceJob(_ recordingId: String, _ sourceId: String, _ job: LibraryState.Job) {
        guard let index = state.recent.firstIndex(where: { $0.id == recordingId }),
            var admissions = state.recent[index].sourceAdmissions,
            let source = admissions.firstIndex(where: { $0.sourceId == sourceId && $0.job?.id == job.id }) else { return }
        let take = state.recent[index]
        if job.state == "ready" { failure(.retryImport(job.id), nil) }
        admissions[source].job = job
        state.recent[index] = .init(id: take.id, createdAt: take.createdAt,
            state: take.state, sourceDurationUs: take.sourceDurationUs, interruptionReason: take.interruptionReason,
            finalizationError: take.finalizationError, sourceId: take.sourceId, sourceAdmissions: admissions)
    }

    private func read<T: Decodable>(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> T {
        let bytes = try await call(operation, params)
        do { return try JSONDecoder().decode(T.self, from: bytes) }
        catch { throw Self.invalid("Unreadable \(operation) response: \(error.localizedDescription)") }
    }
    private static func invalid(_ message: String) -> ServiceFailure { .init(code: "INVALID_RESPONSE", message: message) }
    private struct Media: Decodable {
        let media: [LibraryState.Media]
        let nextCursor: LibraryState.RecordingCursor?
        private enum Keys: String, CodingKey { case media, nextCursor }
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            guard fields.contains(.nextCursor) else {
                throw DecodingError.keyNotFound(Keys.nextCursor, .init(codingPath: decoder.codingPath, debugDescription: "Missing media page cursor"))
            }
            media = try fields.decode([LibraryState.Media].self, forKey: .media)
            nextCursor = try fields.decodeIfPresent(String.self, forKey: .nextCursor)
        }
    }
    private struct Projects: Decodable {
        let projects: [LibraryState.Project]; let nextCursor: LibraryState.ProjectCursor?
        private enum Keys: String, CodingKey { case projects, nextCursor }
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            guard fields.contains(.nextCursor) else {
                throw DecodingError.keyNotFound(Keys.nextCursor, .init(codingPath: decoder.codingPath, debugDescription: "Missing project page cursor"))
            }
            projects = try fields.decode([LibraryState.Project].self, forKey: .projects)
            nextCursor = try fields.decodeIfPresent(String.self, forKey: .nextCursor)
        }
    }
    /// The deleted record's stub.
    private struct Deletion: Decodable { let id: String; let deleted: Bool; let freedBytes: Int64 }
}
