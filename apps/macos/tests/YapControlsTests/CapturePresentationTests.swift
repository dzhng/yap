import Foundation
import YapControls

private func action(_ entries: [PresentedControlsAction], _ id: String) -> PresentedControlsAction {
    guard let found = entries.first(where: { $0.action.id == id }) else {
        preconditionFailure("No presented action for \(id)")
    }
    return found
}

private func recording(elapsedUs: Int64, paused: Bool = false) -> ControlsState {
    var state = ready(source: .window(window))
    state.device = .init(state: paused ? .paused : .recording, recordingId: "rec-1", elapsedUs: elapsedUs)
    state.take = .init(recordingId: "rec-1", state: paused ? "paused" : "recording",
        interruptionReason: nil, sourceDurationUs: nil)
    return state
}

func runCapturePresentationTests() {
    let idle = CapturePresentation.transport(for: ready())
    precondition(action(idle, "capture.startOrStop").title == "Start Recording" && action(idle, "capture.startOrStop").enabled)
    for id in ["capture.pauseOrResume", "capture.cancel", "capture.restart"] {
        precondition(!action(idle, id).enabled, "\(id) needs a take")
    }
    precondition(!action(CapturePresentation.transport(for: ready(source: nil)), "capture.startOrStop").enabled,
        "Nothing starts without a selected source")

    let running = recording(elapsedUs: 12_000_000)
    let live = CapturePresentation.transport(for: running)
    precondition(CapturePresentation.statusTitle(for: running) == "Recording — 0:12")
    precondition(action(live, "capture.startOrStop").title == "Finish Recording")
    precondition(action(live, "capture.pauseOrResume").title == "Pause Recording")
    precondition(action(live, "capture.cancel").enabled && action(live, "capture.restart").enabled)

    var finalizing = running
    finalizing.device = .init(state: .finalizing, recordingId: "rec-1", elapsedUs: 12_000_000)
    finalizing.take = .init(recordingId: "rec-1", state: "finalizing", interruptionReason: nil, sourceDurationUs: nil)
    let finishing = CapturePresentation.transport(for: finalizing)
    precondition(finalizing.isLive && action(finishing, "capture.cancel").enabled)
    precondition(action(finishing, "capture.startOrStop").title == "Finish Recording")
    precondition(!action(finishing, "capture.pauseOrResume").enabled, "Closed input cannot be paused")

    let paused = recording(elapsedUs: 12_000_000, paused: true)
    precondition(CapturePresentation.statusTitle(for: paused) == "Paused — 0:12")
    precondition(action(CapturePresentation.transport(for: paused), "capture.pauseOrResume").title == "Resume Recording")

    var lost = running
    lost.service = .unavailable("Service exited with status 9")
    precondition(StatusItemAppearance.symbolName(for: lost) == "exclamationmark.triangle")
    precondition(CapturePresentation.statusTitle(for: lost) == "Unavailable — Service exited with status 9")
    let orphaned = CapturePresentation.transport(for: lost)
    precondition(action(orphaned, "capture.startOrStop").title == "Start Recording"
        && !action(orphaned, "capture.startOrStop").enabled)

    var interrupted = ready()
    interrupted.take = .init(recordingId: "rec-2", state: "interrupted", interruptionReason: "SOURCE_LOST", sourceDurationUs: 4_000_000)
    precondition(CapturePresentation.noticeLines(for: interrupted).contains("Last take interrupted — SOURCE_LOST"))

    interrupted.take = .init(recordingId: "camera-start", state: "interrupted",
        interruptionReason: "SOURCE_UNAVAILABLE", sourceDurationUs: nil,
        interruptionMessage: "Camera session did not start.")
    precondition(CapturePresentation.noticeLines(for: interrupted).contains(
        "Last take interrupted — SOURCE_UNAVAILABLE: Camera session did not start."),
        "A camera failure must show its actionable native explanation")

    var endedCamera = ready(source: .camera)
    endedCamera.observeTake(.init(recordingId: "camera-start", state: "recording",
        interruptionReason: nil, sourceDurationUs: nil))
    endedCamera.observeTake(nil)
    precondition(endedCamera.takeNeedingResolution == "camera-start",
        "Idle capture status must resolve the started take rather than forget its failure")
    precondition(endedCamera.observeTake(interrupted.take), "A newly interrupted take reopens its controls")
    endedCamera.observeTake(nil)
    precondition(CapturePresentation.noticeLines(for: endedCamera).contains(
        "Last take interrupted — SOURCE_UNAVAILABLE: Camera session did not start."))
    precondition(endedCamera.takeNeedingResolution == nil, "A terminal take needs no further reads")
    precondition(!endedCamera.observeTake(interrupted.take), "Polling must not reopen dismissed controls")
    endedCamera.observeTake(.init(recordingId: "next-camera", state: "recording",
        interruptionReason: nil, sourceDurationUs: nil))
    precondition(!CapturePresentation.noticeLines(for: endedCamera).contains(where: { $0.contains("Last take interrupted") }),
        "Starting a new take clears the previous interruption")

    endedCamera.observeTake(.init(recordingId: "deleted-take", state: "finalizing",
        interruptionReason: nil, sourceDurationUs: nil))
    endedCamera.takeWasDeleted("deleted-take")
    precondition(!endedCamera.isLive && endedCamera.takeNeedingResolution == nil,
        "A confirmed missing take must release recording controls")
    precondition(action(CapturePresentation.transport(for: endedCamera), "capture.startOrStop").title == "Start Recording")
    endedCamera.observeTake(.init(recordingId: "new-take", state: "recording",
        interruptionReason: nil, sourceDurationUs: nil))
    endedCamera.takeWasDeleted("deleted-take")
    precondition(endedCamera.take?.recordingId == "new-take",
        "A delayed missing-take answer cannot forget a newer recording")

    var recovering = ready()
    recovering.take = .init(recordingId: "rec-recovery", state: "finalizing", interruptionReason: nil,
        sourceDurationUs: nil, finalizationError: .init(code: "MEDIA_WORKER_TIMEOUT", message: "Recovery can be retried", retryable: true))
    let recovery = CapturePresentation.transport(for: recovering)
    precondition(recovering.isLive && CapturePresentation.statusTitle(for: recovering) == "Finalization needs attention")
    precondition(action(recovery, "capture.startOrStop").title == "Retry Finalization" && action(recovery, "capture.startOrStop").enabled)
    precondition(action(recovery, "capture.cancel").title == "Cancel Finalization" && !action(recovery, "capture.restart").enabled)
    precondition(CapturePresentation.noticeLines(for: recovering).contains("Finalization failed — MEDIA_WORKER_TIMEOUT: Recovery can be retried"))

    var refused = ready()
    refused.failure = "PERMISSION_REQUIRED: Screen recording permission is not authorized."
    precondition(CapturePresentation.noticeLines(for: refused).contains(refused.failure!))
    print("PASS shared capture lifecycle and transport applicability")
    runOverlayCameraTests()
}

/// What the floating controls offer for a take's camera follows native's live report.
private func runOverlayCameraTests() {
    var screen = recording(elapsedUs: 1_000_000)
    precondition(RecordingOverlay.camera(for: screen) == .none,
        "A take that reserved no camera offers no camera controls")
    screen.device = .init(state: .recording, recordingId: "rec-1", elapsedUs: 1_000_000,
        camera: .init(deviceId: "built-in", state: .off))
    precondition(RecordingOverlay.camera(for: screen) == .companion(on: false),
        "A reserved camera that is off offers Turn Camera On and no picture")
    precondition(!RecordingOverlay.camera(for: screen).recording, "An off camera has no picture to show")
    screen.device = .init(state: .paused, recordingId: "rec-1", elapsedUs: 1_000_000,
        camera: .init(deviceId: "built-in", state: .on))
    precondition(RecordingOverlay.camera(for: screen) == .companion(on: true) && RecordingOverlay.camera(for: screen).recording,
        "A camera that is on, paused or not, shows its picture and offers Turn Camera Off")
    // The start switch says nothing about a live take's camera.
    screen.selection.cameraOn = true
    screen.device = .init(state: .recording, recordingId: "rec-1", elapsedUs: 1_000_000,
        camera: .init(deviceId: "built-in", state: .off))
    precondition(RecordingOverlay.camera(for: screen) == .companion(on: false),
        "The live camera is native's report, not the selection the take started from")

    var cameraOnly = ready(source: .camera)
    cameraOnly.device = .init(state: .recording, recordingId: "rec-2", elapsedUs: 1_000_000)
    precondition(RecordingOverlay.camera(for: cameraOnly) == .primary && RecordingOverlay.camera(for: cameraOnly).recording,
        "A camera-only take shows its picture and cannot switch its source off")
    precondition(RecordingOverlay.camera(for: ready(source: .camera)) == .none, "Nothing is live, so no camera is offered")
    print("PASS the floating controls offer the live camera native reports")
}

/// The media.list rows a page of takes would produce, in the same order.
func mediaRows(_ takes: [ControlsState.RecentTake]) -> [LibraryState.Media] {
    takes.map { .init(kind: .recording, target: .recording($0.recordingId), title: $0.createdAt,
        durationUs: $0.sourceDurationUs ?? 0, sizeBytes: 1_000, createdAt: $0.createdAt) }
}

func runSavedRecordingTests() {
    precondition(LibraryPresentation.agentPrompt(for: .recording("recording-1")) ==
        "I want you to use this recording with this ID with the Yap CLI: recording-1")
    var state = ready()
    let first = ControlsState.RecentTake(recordingId: "first", createdAt: "2026-09-15T18:04:05Z",
        state: "complete", sourceDurationUs: 65_000_000, interruptionReason: nil)
    let sibling = ControlsState.RecentTake(recordingId: "sibling", createdAt: first.createdAt,
        state: "complete", sourceDurationUs: 2_000_000, interruptionReason: nil)
    state.library.recent = [first, sibling]
    state.library.media = mediaRows([first, sibling])
    let listed = LibraryPresentation.recordings(for: state).items.first!
    precondition(listed.title == ElapsedTime.shortTime(of: first.createdAt) && listed.details.first == "1:05",
                 "A recording is titled by when it was made, with its length once, below")
    for (status, duration) in [("complete", Int64(1)), ("interrupted", 1), ("interrupted", 0), ("recording", 1), ("canceled", 1)] {
        var observed = state
        observed.library.recent = [.init(recordingId: "first", createdAt: first.createdAt,
            state: status, sourceDurationUs: duration, interruptionReason: nil)]
        observed.library.media = mediaRows(observed.library.recent)
        let offered = LibraryPresentation.recordings(for: observed).items.flatMap(\.actions).filter(\.enabled).map(\.action)
        let expected: [ControlsAction] = status == "canceled"
            ? [.copyRecordingPrompt("first"), .deleteRecording("first")]
            : [.playRecording("first"), .copyRecordingPrompt("first"), .deleteRecording("first")]
        precondition(offered == expected, "Recordings expose playback, agent handoff and deletion: \(offered)")
    }
    precondition(!state.library.beginDelete(.recording("unknown")))
    precondition(state.library.beginDelete(.recording("first")))
    precondition(!state.library.beginDelete(.recording("first")), "A pending request cannot be sent twice")
    var page = LibraryPresentation.recordings(for: state)
    precondition(page.items.flatMap(\.actions).contains { $0.action == .playRecording("first") && !$0.enabled })
    precondition(page.items.flatMap(\.actions).contains { $0.action == .playRecording("sibling") && $0.enabled })
    state.library.recent = [sibling]
    state.library.media = mediaRows([sibling])
    state.library.finishDelete(.recording("first"), failure: "DELETE_FAILED: disk is unavailable")
    page = LibraryPresentation.recordings(for: state)
    precondition(page.items.flatMap(\.details).contains { $0.contains("DELETE_FAILED: disk is unavailable") })
    precondition(page.items.flatMap(\.actions).contains { $0.action == .deleteRecording("first") && $0.title == "Retry Delete" && $0.enabled },
                 "A delete that was not confirmed is offered again, under its own identity")
    state.service = .ready
    precondition(state.library.beginDelete(.recording("first")), "Retry uses its retained target")
    state.library.finishDelete(.recording("first"), failure: nil)
    page = LibraryPresentation.recordings(for: state)
    precondition(!page.items.flatMap(\.actions).contains { $0.action == .deleteRecording("first") })
    precondition(page.items.flatMap(\.actions).contains { $0.action == .playRecording("sibling") && $0.enabled })
    print("PASS saved recording actions preserve source and deletion identity")
}

func runSavedRowOpenTests() {
    var state = ready()
    state.library.recent = [.init(recordingId: "take", createdAt: "2026-09-15T18:04:05Z",
        state: "complete", sourceDurationUs: 1_000_000, interruptionReason: nil)]
    state.library.media = mediaRows(state.library.recent)
    let project = #"{"projectId":"project","title":"Launch","createdAt":"2026-09-15T18:04:05Z","currentRevisionId":"r1"}"#
    state.library.projects = [try! JSONDecoder().decode(LibraryState.Project.self, from: Data(project.utf8))]
    precondition(LibraryPresentation.recordings(for: state).items.first?.open == .playRecording("take"),
                 "Clicking a recording plays it")
    precondition(LibraryPresentation.projects(for: state, exports: .init()).items.first?.open == .previewProject("project"),
                 "Clicking a project previews it")
    state.service = .unavailable("down")
    precondition(LibraryPresentation.projects(for: state, exports: .init()).items.first?.open == nil,
                 "A row whose open action is unavailable is not clickable")
    print("PASS clicking a saved row plays a recording or previews a project, only while that is enabled")
}

func runSavedProjectRowTests() {
    var state = ready()
    let project = #"{"projectId":"p-1","title":"Launch","createdAt":"2026-10-13T22:12:00Z","currentRevisionId":"r-9"}"#
    state.library.projects = [try! JSONDecoder().decode(LibraryState.Project.self, from: Data(project.utf8))]
    let row = LibraryPresentation.projects(for: state, exports: .init()).items.first!
    precondition(row.status == nil, "A project row does not label itself a project")
    precondition(row.details == ["Created \(ElapsedTime.shortTime(of: "2026-10-13T22:12:00Z"))"],
                 "A project row describes when it was made, not its identifiers: \(row.details)")
    precondition(row.actions.contains { $0.action == .copyProjectPrompt("p-1") && $0.title == "Copy agent prompt" && $0.enabled },
                 "A project can still be handed to an agent")
    precondition(LibraryPresentation.agentPrompt(for: .project("p-1")) ==
        "I want you to use this project with this ID with the Yap CLI: p-1")
    precondition(LibraryPresentation.agentPrompt(for: .recording("t-1")) ==
        "I want you to use this recording with this ID with the Yap CLI: t-1")
    print("PASS a project row reads as a project and can still be handed to an agent")
}

func runSavedMediaTests() {
    let page = #"""
    {"media":[
      {"kind":"recording","recordingId":"take","title":"2026-10-17T21:41:00Z","durationUs":252000000,"sizeBytes":61000000,"createdAt":"2026-10-17T21:41:00Z"},
      {"kind":"imported","assetId":"a-1","title":"launch-teaser-v2.mp4","durationUs":42000000,"sizeBytes":22000000,"createdAt":"2026-10-17T20:46:00Z"}
    ],"nextCursor":null}
    """#
    struct Page: Decodable { let media: [LibraryState.Media] }
    let media = try! JSONDecoder().decode(Page.self, from: Data(page.utf8)).media
    precondition(media.map(\.target) == [.recording("take"), .asset("a-1")], "media.list rows keep their own owner kinds")
    let wrongOwner = #"{"kind":"imported","recordingId":"take","title":"x","durationUs":0,"sizeBytes":0,"createdAt":"2026-10-17T20:46:00Z"}"#
    precondition((try? JSONDecoder().decode(LibraryState.Media.self, from: Data(wrongOwner.utf8))) == nil,
                 "An imported row naming a recording is unreadable, not misfiled")
    precondition(MediaTarget.asset("a-1").parameters == ["assetId": "a-1"])
    precondition(LibraryPresentation.agentPrompt(for: .asset("a-1")) ==
        "I want you to use this imported video with this asset ID with the Yap CLI: a-1")

    var state = ready()
    state.library.media = media
    state.library.recent = [.init(recordingId: "take", createdAt: "2026-10-17T21:41:00Z",
        state: "complete", sourceDurationUs: 252_000_000, interruptionReason: nil)]
    var items = LibraryPresentation.recordings(for: state).items
    precondition(items.map(\.id) == ["take", "a-1"], "The tab lists recordings and imports in media.list order")
    let imported = items[1]
    precondition(imported.kind == .imported && imported.title == "launch-teaser-v2.mp4" && imported.badge == "Imported",
                 "An import is titled by its original filename and marked as imported")
    precondition(imported.details == ["0:42", LibraryPresentation.byteCount(22_000_000), "imported \(ElapsedTime.shortTime(of: "2026-10-17T20:46:00Z"))"],
                 "An import's length, size and arrival read once, below: \(imported.details)")
    precondition(imported.actions.map(\.action) == [.playAsset("a-1"), .copyAssetPrompt("a-1"), .deleteAsset("a-1")]
                 && imported.actions.allSatisfy(\.enabled) && imported.open == .playAsset("a-1"),
                 "An import plays, hands off to an agent, and deletes")
    precondition(items[0].badge == nil && items[0].kind == .recording, "A recording carries no badge")

    precondition(state.library.beginDelete(.asset("a-1")))
    state.library.media = [media[0]]
    items = LibraryPresentation.recordings(for: state).items
    precondition(items.last?.id == "a-1" && items.last?.status == "Deleting"
                 && items.last?.actions.contains { $0.action == .playAsset("a-1") && !$0.enabled } == true,
                 "An import being deleted stays listed as Deleting, and cannot be played")
    state.library.finishDelete(.asset("a-1"), failure: nil)
    precondition(LibraryPresentation.recordings(for: state).items.map(\.id) == ["take"], "A confirmed delete leaves the page")
    precondition(!state.library.beginDelete(.asset("unknown")), "Only a listed import can be deleted")

    let storage = LibraryPresentation.storage(.init(totalBytes: 2_300_000_000, modelBytes: 2_200_000_000, observedAt: "now"))
    precondition(storage.total == "\(LibraryPresentation.byteCount(2_300_000_000)) used"
                 && storage.media == "Media \(LibraryPresentation.byteCount(100_000_000))"
                 && storage.models == "Models \(LibraryPresentation.byteCount(2_200_000_000))",
                 "Storage reads as one total, then media and models: \(storage)")
    print("PASS the Recordings tab lists recordings and imported videos from media.list")
}

func runDeleteConfirmationTests() {
    var state = ready()
    state.library.media = [
        .init(kind: .imported, target: .asset("a-1"), title: "launch-teaser-v2.mp4", durationUs: 42_000_000, sizeBytes: 22_000_000, createdAt: "2026-10-17T20:46:00Z"),
        .init(kind: .recording, target: .recording("take"), title: "2026-10-16T15:05:00Z", durationUs: 9_000_000, sizeBytes: 61_000_000, createdAt: "2026-10-16T15:05:00Z"),
    ]
    let project = #"{"projectId":"p-1","title":"Q4 demo","createdAt":"2026-10-13T22:12:00Z","currentRevisionId":"r-9"}"#
    state.library.projects = [try! JSONDecoder().decode(LibraryState.Project.self, from: Data(project.utf8))]
    let size = { LibraryPresentation.byteCount($0) }

    let imported = state.library.confirmation(for: .asset("a-1"))!
    precondition(imported == .init(title: "Delete “launch-teaser-v2.mp4”?", users: [], lead: nil,
        message: "Removes Yap’s copy and its transcripts (\(size(22_000_000))). Your original file isn’t touched. This can’t be undone.",
        confirm: "Delete", cascade: false), "An import's dialog says its original is untouched: \(imported)")
    let recording = state.library.confirmation(for: .recording("take"))!
    precondition(recording.title == "Delete “\(ElapsedTime.shortTime(of: "2026-10-16T15:05:00Z"))”?"
        && recording.message == "Removes the recording and its transcripts (\(size(61_000_000))). This can’t be undone."
        && recording.confirm == "Delete" && !recording.cascade, "A recording is named by when it was made: \(recording)")
    let projectDialog = state.library.confirmation(for: .project("p-1"))!
    precondition(projectDialog.title == "Delete “Q4 demo”?" && projectDialog.message.hasSuffix("This can’t be undone.")
        && projectDialog.confirm == "Delete", "A project uses the same dialog")
    precondition(state.library.confirmation(for: .asset("unlisted")) == nil, "Only a listed item can be confirmed")

    // An IN_USE refusal's own details become the cascade dialog; nothing is queried.
    let refusal = #"""
    {"assetId":"a-1","usedBy":[{"kind":"project","projectId":"p-1","title":"Q4 demo","revisions":14},
      {"kind":"project","projectId":"p-2","title":"Bug report: export","revisions":1}],
     "acquisitions":[],"derivedAssets":[],"freesBytes":22000000,"cascadeFreesBytes":1400000000}
    """#
    let inUse = try! JSONDecoder().decode(DeleteConfirmation.InUse.self, from: Data(refusal.utf8))
    let cascade = DeleteConfirmation.cascade(.recording("take"), name: "Yesterday 3:05 PM", inUse: inUse)
    precondition(cascade == .init(title: "Delete “Yesterday 3:05 PM”?",
        users: ["Project “Q4 demo” — 14 revisions", "Project “Bug report: export” — 1 revision"],
        lead: "This recording is used by:",
        message: "Deleting it also deletes these projects (\(size(1_400_000_000)) total). This can’t be undone.",
        confirm: "Delete all", cascade: true), "The cascade dialog lists the refusal's users: \(cascade)")
    let derivedOnly = try! JSONDecoder().decode(DeleteConfirmation.InUse.self, from: Data(#"{"usedBy":[],"acquisitions":[],"derivedAssets":[{"kind":"asset","assetId":"d"}],"freesBytes":1,"cascadeFreesBytes":2}"#.utf8))
    let derived = DeleteConfirmation.cascade(.asset("a-1"), name: "x.mp4", inUse: derivedOnly)
    precondition(derived.users.isEmpty && derived.lead == nil
        && derived.message == "Deleting it also deletes 1 file made from it (\(size(2)) total). This can’t be undone.",
        "Users the service names only by count are said as a count, never as projects: \(derived)")

    // A cascade is a new request; declining it leaves the row as it was.
    precondition(state.library.beginDelete(.asset("a-1")))
    let plainId = state.library.deletions[.asset("a-1")]!.requestId
    state.library.finishDelete(.asset("a-1"), failure: "IN_USE: used by 2 projects")
    precondition(state.library.beginDelete(.asset("a-1"), cascade: true))
    let cascadeId = state.library.deletions[.asset("a-1")]!.requestId
    precondition(cascadeId != plainId && state.library.deletions[.asset("a-1")]!.cascade, "Cascade carries its own request identity")
    state.library.finishDelete(.asset("a-1"), failure: "SERVICE_STOPPED: lost")
    precondition(state.library.beginDelete(.asset("a-1"), cascade: true) && state.library.deletions[.asset("a-1")]!.requestId == cascadeId,
                 "Retrying the cascade keeps its identity")
    state.library.finishDelete(.asset("a-1"), failure: "x")
    state.library.cancelDelete(.asset("a-1"))
    let items = LibraryPresentation.recordings(for: state).items
    precondition(state.library.deletions.isEmpty && items.first { $0.id == "a-1" }?.status == nil
        && items.first { $0.id == "a-1" }?.actions.allSatisfy(\.enabled) == true, "Declining leaves the row as it was")
    print("PASS one delete dialog: plain, imported and cascade, from the row and the refusal only")
}

func runSavedPagingTests() {
    var state = ready()
    state.library.recent = [.init(recordingId: "take", createdAt: "2026-09-15T18:04:05Z",
        state: "complete", sourceDurationUs: 1_000_000, interruptionReason: nil)]
    state.library.media = mediaRows(state.library.recent)
    let paging: Set<ControlsAction> = [.previousRecordings, .nextRecordings]
    precondition(LibraryPresentation.recordings(for: state).actions.filter { paging.contains($0.action) }.isEmpty,
                 "With one page there is no paging to offer")
    state.library.nextRecordingCursor = "opaque-cursor"
    state.library.recordingsRefreshing = true
    let refreshing = LibraryPresentation.recordings(for: state).actions.filter { paging.contains($0.action) }
    precondition(refreshing.map(\.action) == [.nextRecordings] && !refreshing[0].enabled,
                 "Another page stays offered while a refresh disables it")
    print("PASS paging appears where another page exists and stays put while refreshing")
}
