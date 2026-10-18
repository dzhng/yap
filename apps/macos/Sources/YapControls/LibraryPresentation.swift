import Foundation

/// Shared saved-media facts and action applicability; renderers consume these directly.
public enum LibraryPresentation {
    /// What a person pastes into their agent to hand it a recording or project.
    public static func agentPrompt(for target: MediaTarget) -> String {
        switch target {
        case .recording(let id): "I want you to use this recording with this ID with the Yap CLI: \(id)"
        case .asset(let id): "I want you to use this imported video with this asset ID with the Yap CLI: \(id)"
        case .project(let id): "I want you to use this project with this ID with the Yap CLI: \(id)"
        }
    }

    public static func recordings(for state: ControlsState) -> SavedPage {
        let library = state.library
        // The page is media.list's order; a deletion still pending stays listed after its row leaves.
        let rows = library.media + library.deletions.values
            .filter { request in request.media != nil && !library.media.contains { $0.target == request.target } }
            .sorted { $0.target.id < $1.target.id }
            .compactMap(\.media)
        // Paging is offered only where another page exists; a refresh disables it without hiding it.
        let actions: [PresentedControlsAction] = [PresentedControlsAction?](arrayLiteral:
            library.hasPreviousRecordingPage ? .init(.previousRecordings, "Previous", enabled: state.service == .ready && !library.recordingsRefreshing) : nil,
            library.nextRecordingCursor != nil ? .init(.nextRecordings, "Next", enabled: state.service == .ready && !library.recordingsRefreshing) : nil,
            .init(.refreshLibrary, "Refresh", enabled: state.service == .ready && !library.recordingsRefreshing)
        ).compactMap { $0 }
        var notices: [SavedItem] = []
        if let failure = library.recordingFailure { notices.append(.init(id: "recordings.failure", kind: .message, title: "Recordings unavailable — \(failure)")) }
        if let failure = library.progressFailure { notices.append(.init(id: "recordings.progress", kind: .message, title: "Preparation status unavailable — \(failure)")) }
        guard !rows.isEmpty else {
            return .init(items: notices + [.init(id: "recordings.empty", kind: .message, title: "No recordings on this page.")], actions: actions)
        }
        return .init(items: notices + rows.map { row in
            let request = library.deletions[row.target]
            let pending = request?.isPending == true
            let usable = state.service == .ready && !pending
            let deleteTitle = request?.failure != nil ? "Retry Delete" : "Delete"
            switch row.target {
            case .asset(let id):
                // An import reads by its own name; its length, size and arrival read once, below.
                var details = [ElapsedTime.format(row.durationUs), byteCount(row.sizeBytes), "imported \(ElapsedTime.shortTime(of: row.createdAt))"]
                if let failure = request?.failure { details.append("Delete not confirmed — \(failure)") }
                return .init(id: id, kind: .imported, title: row.title, badge: "Imported",
                    status: request == nil ? nil : pending ? "Deleting" : "Attention", details: details, actions: [
                        .init(.playAsset(id), "Play", enabled: usable),
                        .init(.copyAssetPrompt(id), "Copy agent prompt", enabled: !pending),
                        .init(.deleteAsset(id), deleteTitle, enabled: usable),
                    ], opens: .playAsset(id), attention: request?.failure != nil)
            case .recording(let id):
                let take = library.recent.first { $0.recordingId == id } ?? request?.take
                var details: [String] = []
                if take?.sourceAdmissions?.contains(where: { $0.kind == "primary" && $0.publication?.state == .published }) == true {
                    details.append("Microphone audio")
                }
                if let failure = take?.finalizationError { details.append("Finalization failed — \(failure.code): \(failure.message)") }
                if let failure = request?.failure { details.append("Delete not confirmed — \(failure)") }
                let state = take?.state ?? "complete"
                let status = request != nil ? pending ? "Deleting" : "Attention" : take?.finalizationError != nil ? "Attention" : state == "complete" ? "Ready" : state.capitalized
                // The title is when; how long and what state it is in read once, on the line below.
                if state == "complete" || state == "interrupted" {
                    details.insert(ElapsedTime.format(take?.sourceDurationUs ?? row.durationUs), at: 0)
                }
                return .init(id: id, kind: .recording, title: ElapsedTime.shortTime(of: take?.createdAt ?? row.createdAt),
                    status: status, details: details, actions: [
                        .init(.playRecording(id), "Play", enabled: usable && state != "canceled"),
                        .init(.copyRecordingPrompt(id), "Copy agent prompt", enabled: !pending),
                        .init(.deleteRecording(id), deleteTitle, enabled: usable),
                    ], opens: .playRecording(id), attention: status == "Attention")
            case .project:
                preconditionFailure("media.list never lists projects")
            }
        }, actions: actions)
    }

    /// The library total, then the same bytes split into media and models.
    public static func storage(_ observation: ControlsState.StorageObservation) -> (total: String, media: String, models: String) {
        let media = max(0, observation.totalBytes - observation.modelBytes)
        return ("\(byteCount(observation.totalBytes)) used", "Media \(byteCount(media))", "Models \(byteCount(observation.modelBytes))")
    }

    public static func byteCount(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    public static func projects(for state: ControlsState, exports: ExportsState) -> SavedPage {
        var items: [SavedItem] = []
        if let failure = state.library.projectFailure { items.append(.init(id: "projects.failure", kind: .message, title: "Projects unavailable — \(failure)")) }
        if state.library.projectsRefreshing { items.append(.init(id: "projects.refreshing", kind: .message, title: "Reading projects…")) }
        for project in state.library.projects {
            let request = state.library.deletions[.project(project.projectId)]
            guard request == nil else { continue }
            let usable = state.service == .ready
            items.append(.init(id: project.projectId, kind: .project, title: project.title,
                details: ["Created \(ElapsedTime.shortTime(of: project.createdAt))"], actions: [
                .init(.previewProject(project.projectId), "Preview", enabled: usable),
                .init(.copyProjectPrompt(project.projectId), "Copy agent prompt", enabled: true),
                .init(.exportProject(project.projectId, .video), "Export Video…", enabled: usable && exports.choosing == nil),
                .init(.exportProject(project.projectId, .package), "Export AI Package…", enabled: usable && exports.choosing == nil),
                .init(.deleteProject(project.projectId), "Delete Project", enabled: usable),
            ], opens: .previewProject(project.projectId)))
        }
        for request in state.library.deletions.values.sorted(by: { $0.target.id < $1.target.id }) {
            guard case .project(let id) = request.target else { continue }
            items.append(.init(id: id, kind: .project, title: request.title, status: request.isPending ? "Deleting" : "Attention",
                details: request.failure.map { ["Delete not confirmed — \($0)"] } ?? [],
                actions: [.init(.deleteProject(id), request.isPending ? "Deleting…" : "Retry Delete", enabled: state.service == .ready && !request.isPending)],
                attention: !request.isPending))
        }
        if state.library.projects.isEmpty && items.isEmpty { items.append(.init(id: "projects.empty", kind: .message, title: "No projects on this page.")) }
        // Paging is offered only where another page exists; a refresh disables it without hiding it.
        return .init(items: items, actions: [PresentedControlsAction?](arrayLiteral:
            state.library.hasPreviousProjectPage ? .init(.previousProjects, "Previous", enabled: state.service == .ready && !state.library.projectsRefreshing) : nil,
            state.library.nextProjectCursor != nil ? .init(.nextProjects, "Next", enabled: state.service == .ready && !state.library.projectsRefreshing) : nil
        ).compactMap { $0 })
    }

    public static func recordingTitle(of take: ControlsState.RecentTake) -> String {
        let when = ElapsedTime.shortTime(of: take.createdAt)
        switch take.state {
        case "complete": return "\(when) — \(ElapsedTime.format(take.sourceDurationUs))"
        case "interrupted":
            let duration = take.sourceDurationUs.map { " \(ElapsedTime.format($0))" } ?? ""
            return "\(when) — interrupted\(duration)"
        default: return "\(when) — \(take.state)"
        }
    }
}
