import Foundation
import YapControls

@MainActor
protocol PreviewPresenting: AnyObject {
    func open(title: String, retry: @escaping @MainActor () -> Void, closed: @escaping @MainActor () -> Void)
    func show(title: String, message: String, canRetry: Bool)
    func play(title: String, file: String, mediaType: String, failed: @escaping @MainActor (String) -> Void)
    func showTimeline(_ items: [PreviewTimelineItem], selected: String, select: @escaping @MainActor (String) -> Void)
    func showExport(_ action: @escaping @MainActor () -> Void)
    func close()
}

struct PreviewTimelineItem: Sendable {
    let id: String
    let ordinal: Int
    let label: String
    let operation: String
}

extension PreviewPresenting {
    func showTimeline(_ items: [PreviewTimelineItem], selected: String, select: @escaping @MainActor (String) -> Void) {}
    func showExport(_ action: @escaping @MainActor () -> Void) {}
}

/// One native view of a pinned service derivative. The delivery lease owns the cache file;
/// this owner holds no copied movie, edit plan, or rendering job.
@MainActor
final class PreviewController {
    /// Library playback favors a bounded draft raster; callers that need the full canvas use the
    /// public preview operation with `maxLongEdge: null`.
    private let draftMaxLongEdge = 960
    typealias Call = @MainActor (String, [String: Any]) async throws -> Data
    private let call: Call
    private let presentation: any PreviewPresenting
    private let now: @MainActor () -> Date
    private let failure: (String) -> Void
    private let changed: () -> Void
    private let export: @MainActor (String, String) -> Void
    private let timelineEnabled: Bool
    private var generation = UUID()
    private var target: MediaTarget?
    private var revisionId: String?
    private var range: [String: Any]?
    private var lease: Lease?
    private var renewAt = Date.distantPast
    private var reading = false
    private var requestOperation = "preview.get"
    private var polling = false
    /// The project's name as people know it; its identifiers stay out of the window.
    var projectTitle: (String) -> String? = { _ in nil }
    /// A name the opener supplied, as an agent's inspect.open does for a project the Library may not hold.
    private var givenTitle: String?
    private func title(for target: MediaTarget) -> String { givenTitle ?? projectTitle(target.id) ?? "Project preview" }

    init(call: @escaping Call, presentation: any PreviewPresenting = PreviewWindow(),
        now: @escaping @MainActor () -> Date = Date.init, changed: @escaping () -> Void = {},
        export: @escaping @MainActor (String, String) -> Void = { _, _ in },
        timelineEnabled: Bool = false,
        failure: @escaping (String) -> Void)
    {
        self.call = call
        self.presentation = presentation
        self.now = now
        self.failure = failure
        self.changed = changed
        self.export = export
        self.timelineEnabled = timelineEnabled
    }

    var isOpen: Bool { target != nil }

    func titled(_ title: @escaping (String) -> String?) -> Self {
        projectTitle = title
        return self
    }

    func open(_ projectId: String, revisionId: String? = nil, range: [String: Any]? = nil, title: String? = nil) {
        let target = MediaTarget.project(projectId)
        finishClose()
        givenTitle = title.flatMap { $0.isEmpty ? nil : $0 }
        self.target = target
        changed()
        self.revisionId = revisionId
        self.range = range
        polling = true
        requestOperation = "preview.get"
        let current = generation
        presentation.open(title: self.title(for: target), retry: { [weak self] in
            guard let self, self.generation == current else { return }
            self.retryPreview()
        }, closed: { [weak self] in
            guard let self, self.generation == current else { return }
            self.close()
        })
        presentation.showExport { [weak self] in
            guard let self, let revisionId = self.revisionId ?? revisionId else { return }
            self.export(target.id, revisionId)
        }
        if timelineEnabled { loadTimeline(for: target, generation: current) }
        tick()
    }

    private func loadTimeline(for target: MediaTarget, generation: UUID) {
        Task { @MainActor [weak self] in
            guard let self, self.generation == generation else { return }
            do {
                let data = try await call("revision.history", ["projectId": target.id, "limit": 100])
                let page = try JSONDecoder().decode(History.self, from: data)
                guard self.generation == generation else { return }
                presentation.showTimeline(page.revisions.reversed().map {
                    PreviewTimelineItem(id: $0.id, ordinal: $0.ordinal, label: "Revision \($0.ordinal + 1)", operation: $0.operation)
                }, selected: revisionId ?? page.revisions.last?.id ?? "", select: { [weak self] id in
                    guard let self, self.generation == generation, self.target?.id == target.id else { return }
                    self.open(target.id, revisionId: id, range: self.range)
                })
            } catch {
                // Preview remains usable when historical metadata is temporarily unavailable.
            }
        }
    }

    func close(target: MediaTarget? = nil) {
        if let target, target != self.target { return }
        finishClose()
        changed()
    }

    private func finishClose() {
        generation = UUID()
        self.target = nil
        revisionId = nil
        range = nil
        polling = false
        reading = false
        presentation.close()
        if let token = lease?.token { release(token) }
        lease = nil
    }

    /// Driven by the controls' status cadence. Expiry is checked even with a request in flight;
    /// no renewal response may revive a session that was closed while awaiting the service.
    func tick() {
        guard let target else { return }
        if let lease, lease.expiresAt <= now().timeIntervalSince1970 * 1000 {
            stop("Preview lease expired. Open Preview again to continue.")
            return
        }
        guard !reading else { return }
        reading = true
        let current = generation
        let pinnedRevision = revisionId
        let currentLease = lease
        Task { @MainActor in
            do {
                if !polling || currentLease != nil {
                    _ = try await call("project.get", target.parameters)
                    guard generation == current else { return }
                    guard let currentLease, now() >= renewAt else { reading = false; return }
                    let data = try await call("artifact.renew", ["token": currentLease.token])
                    let renewed = try JSONDecoder().decode(Lease.self, from: data)
                    guard generation == current else { return }
                    guard currentLease.expiresAt > now().timeIntervalSince1970 * 1000,
                        renewed.token == currentLease.token, renewed.bytes == currentLease.bytes,
                        renewed.expiresAt > now().timeIntervalSince1970 * 1000 else {
                        throw InvalidAnswer()
                    }
                    lease = renewed
                    renewAt = now().addingTimeInterval(10)
                } else {
                    var params: [String: Any] = target.parameters
                    if let pinnedRevision { params["revisionId"] = pinnedRevision }
                    if let range { params["range"] = range }
                    params["maxLongEdge"] = draftMaxLongEdge
                    let data = try await call(requestOperation, params)
                    // Decode the lease separately so a late or otherwise invalid ready answer
                    // releases the service pin rather than leaving it until expiration.
                    let delivered = try? JSONDecoder().decode(Delivery.self, from: data).delivery
                    guard generation == current else {
                        if let delivered { release(delivered.token) }
                        return
                    }
                    do {
                        let answer = try JSONDecoder().decode(Answer.self, from: data)
                        guard answer.target == target, !answer.revisionId.isEmpty,
                            pinnedRevision == nil || pinnedRevision == answer.revisionId else {
                            throw InvalidAnswer()
                        }
                        revisionId = answer.revisionId
                        requestOperation = "preview.get"
                        let title = self.title(for: target)
                        if answer.state == "ready" {
                            guard let movie = answer.published?.output, let delivered,
                                movie.target == target, movie.revisionId == answer.revisionId,
                                movie.mediaType == "video/mp4", movie.bytes > 0,
                                !delivered.token.isEmpty, delivered.bytes == movie.bytes,
                                delivered.expiresAt > now().timeIntervalSince1970 * 1000,
                                movie.file.hasPrefix("/") else { throw InvalidAnswer() }
                            lease = delivered
                            renewAt = now().addingTimeInterval(10)
                            polling = false
                            presentation.play(title: title, file: movie.file, mediaType: movie.mediaType) { [weak self] reason in
                                guard let self, self.generation == current else { return }
                                self.stop(reason)
                            }
                        } else if delivered != nil {
                            throw InvalidAnswer()
                        } else if answer.state == "failed" || answer.state == "not_requested" || answer.state == "unavailable" {
                            polling = false
                            presentation.show(title: title, message: answer.reason ?? "Preview could not be prepared.",
                                canRetry: answer.dependency == nil && answer.retryable == true)
                        } else if answer.state == "queued" || answer.state == "processing" {
                            presentation.show(title: title, message: "Preparing preview — \(answer.state)…", canRetry: false)
                        } else {
                            throw InvalidAnswer()
                        }
                    } catch {
                        if let delivered { release(delivered.token) }
                        throw error
                    }
                }
            } catch {
                if generation == current { stop(error.localizedDescription) }
            }
            if generation == current { reading = false }
        }
    }

    private func retryPreview() {
        guard let target, let revisionId, !reading else { return }
        presentation.show(title: title(for: target), message: "Retrying preview…", canRetry: false)
        requestOperation = "preview.retry"
        polling = true
        tick()
    }

    private func stop(_ reason: String) {
        close()
        failure(reason)
    }

    private func release(_ token: String) {
        Task { @MainActor [call] in _ = try? await call("artifact.close", ["token": token]) }
    }

    private struct InvalidAnswer: LocalizedError {
        var errorDescription: String? { "The service returned an invalid preview receipt." }
    }
    private struct Lease: Decodable {
        let token: String
        let bytes: Int64
        let expiresAt: Double
    }
    private struct Delivery: Decodable { let delivery: Lease? }
    private struct History: Decodable {
        let revisions: [Revision]
        struct Revision: Decodable { let id: String; let ordinal: Int; let operation: String }
    }
    private struct Answer: Decodable {
        let target: MediaTarget
        let revisionId: String
        let state: String
        let reason: String?
        let retryable: Bool?
        let dependency: Dependency?
        let published: Published?
        private enum Keys: String, CodingKey { case revisionId, state, reason, retryable, dependency, published }
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            target = try MediaTarget(from: decoder)
            revisionId = try fields.decode(String.self, forKey: .revisionId)
            state = try fields.decode(String.self, forKey: .state)
            reason = try fields.decodeIfPresent(String.self, forKey: .reason)
            retryable = try fields.decodeIfPresent(Bool.self, forKey: .retryable)
            dependency = try fields.decodeIfPresent(Dependency.self, forKey: .dependency)
            published = try fields.decodeIfPresent(Published.self, forKey: .published)
        }
        struct Dependency: Decodable { let artifact: String }
        struct Published: Decodable { let output: Movie }
        struct Movie: Decodable {
            let target: MediaTarget
            let revisionId: String
            let file: String
            let mediaType: String
            let bytes: Int64
            private enum Keys: String, CodingKey { case revisionId, file, mediaType, bytes }
            init(from decoder: Decoder) throws {
                let fields = try decoder.container(keyedBy: Keys.self)
                target = try MediaTarget(from: decoder)
                revisionId = try fields.decode(String.self, forKey: .revisionId)
                file = try fields.decode(String.self, forKey: .file)
                mediaType = try fields.decode(String.self, forKey: .mediaType)
                bytes = try fields.decode(Int64.self, forKey: .bytes)
            }
        }
    }
}
