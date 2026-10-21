import AppKit
import CoreImage
import ScreenCaptureKit
import UniformTypeIdentifiers
import YapCapture
import YapControls

/**
 The status-bar recording controls.

 Media actions use the service's public operations: this holds what they have selected to record
 next, asks the service to act, and shows what the service answered.
 It keeps no device state machine, no catalog and no clock of its own — the elapsed time it shows
 is the running take's own playback time, read back through the same status call the CLI reads.
 Native owns permissions and the updater; update commands use the same handler as CLI forwarding.
 Permissions are requested by a person choosing to request them. The Settings window is a second view of this same state: it sends the
 same actions the menu does, and the audio choices both edit are saved as the next launch's defaults.
 */
@MainActor
final class RecordingControls: NSObject {
    private let home: String
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private lazy var capturePopover = CapturePopover(perform: { [weak self] in self?.perform($0) })
    private lazy var libraryWindow = LibraryWindow(perform: { [weak self] in self?.perform($0, surface: .library) })
    private var emptySourceMode = CaptureViewInput.Source.display
    private let shortcuts = GlobalShortcuts()
    private lazy var region = RegionSelection(changed: { [weak self] in self?.render() })
    private let quit: () -> Void
    private let preferences: Preferences
    private let homeLifecycle: HomeLifecycle
    private var state: ControlsState
    private var updateOperation: ((String, Data) -> Result<Data, ServiceFailure>)?
    /// Screen access has no "not yet asked" state to read, so a request this launch that came back
    /// refused is what says asking again would prompt for nothing.
    private var screenRequestRefused = false
    private var bindings = ShortcutBindings.defaults
    private var held: Set<String> = []
    private var shortcutsRecording = false
    private var shortcutsSuspended = false
    private weak var host: ServiceHost?
    private weak var captureController: CaptureController?
    private var lastHotkeyStart = Date.distantPast
    var updateProgress: (() -> Void)?
    private var updateFenced = false
    private var permissionRequests = 0
    private var lastUpdateBlockers: [String] = []
    private lazy var sourcePreviews = SourcePreviews { [weak self] in self?.render() }
    private lazy var preview = PreviewController(
        call: { [weak self] operation, params in
            guard let self else { throw Self.noService }
            return try await self.service().call(operation, params)
        },
        changed: { [weak self] in self?.render() },
        export: { [weak self] projectId, revisionId in
            self?.exports.exportToDownloads(projectId, revisionId: revisionId)
        },
        timelineEnabled: true,
        failure: { [weak self] action, message in
            guard let self else { return }
            state.observeAction(action, failure: message, on: .library)
            render()
        }).titled { [weak self] id in self?.state.library.projects.first { $0.id == id }?.title }
    private lazy var exports = ExportController(
        call: { [weak self] operation, params throws(ServiceFailure) in
            guard let self else { throw Self.noService }
            return try await self.service().call(operation, params)
        },
        changed: { [weak self] in self?.render() },
        failure: { [weak self] action, message in
            guard let self else { return }
            state.observeAction(action, failure: message, on: .library)
            render()
        })
    private lazy var library: LibraryController = LibraryController(
        call: { [weak self] operation, params throws(ServiceFailure) in
            guard let self else { throw Self.noService }
            return try await self.service().call(operation, params)
        }, confirm: { [weak self] dialog in
            await DeleteAlert.ask(dialog, on: self?.libraryWindow.sheetParent)
        }, changed: { [weak self] in
            guard let self else { return }
            state.library = library.state
            render()
        }, closePreview: { [weak self] in self?.preview.close(target: $0) },
        forgetExports: { [weak self] in self?.exports.forget(target: $0) },
        deleted: { [weak self] in self?.readStorage() },
        preview: { [weak self] in self?.preview.open($0) },
        export: { [weak self] in self?.exports.export($0, kind: $1) },
        failure: { [weak self] action, message in
            guard let self else { return }
            state.observeAction(action, failure: message, on: .library)
            render()
        })
    private lazy var overlay = RecordingOverlayPanel(
        preferences: preferences, perform: { [weak self] action in self?.perform(action) })
    private lazy var ink = InkOverlayPanel()
    private let recordingPreview = PreviewWindow()
    private let prompts = PromptHandoff()
    private lazy var countdown = StartCountdown(shortcuts: shortcuts)
    private lazy var settings = SettingsWindow(
        preferences: preferences,
        perform: { [weak self] action in self?.perform(action) },
        update: { [weak self] operation, params in self?.sendUpdate(operation, params) },
        suspendShortcuts: { [weak self] in self?.suspendShortcutsForSettings() },
        resumeShortcuts: { [weak self] in self?.resumeShortcutsForSettings() },
        setShortcut: { [weak self] action, shortcut in
            guard let self else { return false }
            if case .success = self.setShortcutFromSettings(action, shortcut) { return true }
            return false
        },
        resetShortcuts: { [weak self] in _ = self?.handleShortcuts("shortcuts.reset", Data("{}".utf8)) },
        refreshPermissions: { [weak self] in
            self?.readPermissions()
            self?.render()
        },
        agentSetup: homeLifecycle)
    private var ticker: Timer?
    private var reading = false
    private var pendingRefresh = false
    private var pendingStorageRefresh = false
    private var cameraPreviewImage: NSImage?
    /// The clock a check asked the floating controls to show. Every render reconciles the controls
    /// with the state, so a request that is not held here is gone on the next status tick.
    private var observedOverlay: RecordingOverlay.Presentation?
    private var observedInk = false
    private var lastCameraPreviewUpdate = Date.distantPast
    private let cameraPreviewContext = CIContext()

    /// Bounded status cadence, including controls issued by another client.
    private static let tick: TimeInterval = 0.5

    /// `inApplications` is the launch decision's answer: whether this app lives in an Applications
    /// folder, which is where the yap command may point.
    init(home: String, preferences: Preferences, inApplications: Bool, quit: @escaping () -> Void) {
        self.home = home
        self.quit = quit
        self.preferences = preferences
        self.homeLifecycle = HomeLifecycle(inApplications: inApplications)
        state = ControlsState(recording: preferences.recording)
        super.init()
        var bindings = ShortcutBindings.defaults
        do {
            bindings = try ShortcutBindings.decode(
                FileManager.default.contents(atPath: GlobalShortcuts.overridePath(home: home)))
        } catch {
            state.failure = .init("Shortcuts file refused, using the defaults: \(error.message)")
        }
        do {
            try applyShortcuts(bindings, recording: false)
        } catch {
            // A hand-edited file can bind one key twice; the defaults never do, so they hold
            // instead and Settings shows what is actually registered.
            state.failure = .init("Duplicate shortcuts: \(error)")
            try? applyShortcuts(ShortcutBindings.defaults, recording: false)
        }
        statusItem.button?.target = self
        statusItem.button?.action = #selector(toggleCapture)
        statusItem.button?.setAccessibilityLabel("Yap")
        readPermissions()
        render()
        homeLifecycle.settled = { [weak self] in self?.settings.refreshAgentSummary() }
        if preferences.setUpAgents { homeLifecycle.setEnabled(true) }
    }

    func showAdminMessage(_ message: String?) {
        guard state.adminMessage != message else { return }
        state.adminMessage = message
        render()
    }

    func configureUpdates(_ updates: UpdateControls,
                          operation: @escaping (String, Data) -> Result<Data, ServiceFailure>) {
        state.updates = updates
        updateOperation = operation
        render()
    }

    /// Every `skill.*` and `cli.*` operation, answered by the one home owner.
    func handleHome(_ operation: String) -> Result<Data, ServiceFailure> {
        homeLifecycle.handle(operation)
    }

    /// The CLI and Settings use this one live binding owner.
    func handleShortcuts(_ operation: String, _ params: Data) -> Result<Data, ServiceFailure> {
        let layout = KeyboardLayout.current()
        if operation == "shortcuts.get" { return .success(describeShortcuts(layout)) }
        if operation == "shortcuts.reset" { return resetShortcuts(layout) }
        guard operation == "shortcuts.set",
            let object = try? JSONSerialization.jsonObject(with: params) as? [String: Any],
            let stated = object["bindings"] as? [String: Any]
        else {
            return .failure(ServiceFailure(code: "INVALID_PARAMS", message: "shortcuts.set requires bindings."))
        }
        let next: [ControlsAction: ShortcutBindings.Binding]
        do {
            next = try ShortcutBindings.merging(stated, into: bindings, layout: layout)
        } catch {
            return .failure(ServiceFailure(code: "INVALID_PARAMS", message: error.message))
        }
        do {
            try applyShortcuts(next, recording: shortcutsRecording)
            let path = GlobalShortcuts.overridePath(home: home)
            try FileManager.default.createDirectory(
                atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            guard let data = ShortcutBindings.encode(bindings) else {
                throw ServiceFailure(code: "INVALID_RESPONSE", message: "Could not encode shortcuts.")
            }
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            render()
            return .success(describeShortcuts(layout))
        } catch let error as GlobalShortcuts.ApplyError {
            return .failure(ServiceFailure(
                code: "DUPLICATE_SHORTCUT", message: "Duplicate shortcut actions: \(error)."))
        } catch let failure as ServiceFailure {
            return .failure(failure)
        } catch {
            return .failure(ServiceFailure(code: "SHORTCUTS_WRITE_FAILED", message: error.localizedDescription))
        }
    }

    /// Every action back on its default. The stored file goes, so a later change to the defaults
    /// reaches this person too.
    private func resetShortcuts(_ layout: KeyboardLayout) -> Result<Data, ServiceFailure> {
        let path = GlobalShortcuts.overridePath(home: home)
        do {
            if FileManager.default.fileExists(atPath: path) { try FileManager.default.removeItem(atPath: path) }
        } catch {
            return .failure(ServiceFailure(code: "SHORTCUTS_WRITE_FAILED", message: error.localizedDescription))
        }
        // The defaults bind each key once, so they always apply.
        try? applyShortcuts(ShortcutBindings.defaults, recording: shortcutsRecording)
        render()
        return .success(describeShortcuts(layout))
    }

    /// The public answer: each action's keys and whether macOS holds it, as Settings shows it.
    private func describeShortcuts(_ layout: KeyboardLayout) -> Data {
        ShortcutBindings.describe(bindings, layout: layout) { [self] action in
            ShortcutPresentation.state(unavailable: state.unavailableShortcuts.contains(action.id))
        }
    }

    /// Registers `next` for the take's state and records what was held. A duplicate throws before
    /// anything is released, so the current registrations and bindings stay as they were.
    private func applyShortcuts(
        _ next: [ControlsAction: ShortcutBindings.Binding], recording: Bool
    ) throws(GlobalShortcuts.ApplyError) {
        let outcome = try shortcuts.apply(
            next, recording: recording, perform: { [weak self] action in self?.performShortcut(action) })
        bindings = next
        held = outcome.held
        state.unavailableShortcuts = outcome.unavailable
        shortcutsRecording = recording
        // While Settings records a key, nothing is held, so the key reaches the field.
        if shortcutsSuspended {
            shortcuts.suspend()
            held = []
        }
    }

    /// Settings submits through the same public handler as the CLI, so validation, registration,
    /// persistence and the response shown in the window cannot drift apart. It states one action;
    /// the handler keeps the rest.
    private func setShortcutFromSettings(
        _ action: ControlsAction, _ shortcut: Shortcut
    ) -> Result<Data, ServiceFailure> {
        let stated = [action.id: ShortcutKeys.name(
            keyCode: shortcut.keyCode, modifiers: shortcut.modifiers, layout: .current())]
        guard let params = try? JSONSerialization.data(withJSONObject: ["bindings": stated]) else {
            return .failure(ServiceFailure(code: "INVALID_RESPONSE", message: "Could not encode shortcuts."))
        }
        return handleShortcuts("shortcuts.set", params)
    }

    private func suspendShortcutsForSettings() {
        shortcutsSuspended = true
        shortcuts.suspend()
    }

    private func resumeShortcutsForSettings() {
        shortcutsSuspended = false
        do {
            try applyShortcuts(bindings, recording: state.isLive || state.counting)
        } catch {
            state.failure = .init("Duplicate shortcuts: \(error)")
        }
        render()
    }

    /// Service-initiated inspect.open uses the same PreviewController as Library actions.
    /// The service has already validated the project/revision pin before asking the app to show it.
    func openInspect(_ data: Data) -> Result<Data, ServiceFailure> {
        guard let params = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(ServiceFailure(code: "INVALID_PARAMS", message: "inspect.open parameters must be a JSON object"))
        }
        guard let projectId = params["projectId"] as? String, !projectId.isEmpty else {
            return .failure(ServiceFailure(code: "INVALID_PARAMS", message: "inspect.open needs projectId"))
        }
        let revisionId = params["revisionId"] as? String
        let range = params["range"] as? [String: Any]
        preview.open(projectId, revisionId: revisionId, range: range, title: params["title"] as? String)
        let payload: [String: Any] = [
            "opened": true,
            "projectId": projectId,
            "revisionId": revisionId as Any,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]) else {
            return .failure(ServiceFailure(code: "INVALID_RESPONSE", message: "Could not encode inspect.open acknowledgement"))
        }
        return .success(data)
    }

    /// Opt-out remains usable while the child service is closing or unavailable.
    private func sendUpdate(_ operation: String, _ params: [String: Any]) {
        guard let updateOperation else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: params)
            _ = try updateOperation(operation, data).get()
        } catch {
            state.failure = .init(error.localizedDescription)
            render()
        }
    }

    func attach(to host: ServiceHost) {
        self.host = host
        refresh()
    }

    func attach(to captureController: CaptureController) {
        self.captureController = captureController
    }

    /// The service's own lifetime, as the app already observes it. A service that is not ready
    /// cannot carry a capture operation, so the controls say so rather than offering one.
    func serviceStateChanged(_ serviceState: ServiceHost.State) {
        switch serviceState {
        case .starting: state.service = .starting
        case .ready: state.service = .ready
        case .unavailable(_, let message): state.service = .unavailable(message)
        }
        library.serviceChanged(ready: state.service == .ready)
        if state.service == .ready {
            refresh()
            exports.discover()
        } else {
            preview.close()
            render()
        }
    }

    /// Shows the floating controls at a clock a take would take hours to reach, so a check can
    /// see how they are laid out then. Only the fixture observer reaches this.
    func showOverlay(elapsed: String) {
        guard ControlsProbe.observed else { return }
        observedOverlay = .init(elapsed: elapsed, paused: false, symbol: "record.circle.fill")
        render()
    }

    /// The marks a screen take recognizes, for the ink over every display.
    func receiveMarkUpdate(_ update: CaptureMarkUpdate) {
        ink.receive(update)
    }

    /// Ink a check asked to look at stays up with or without a take.
    func showInk(scene: String, front: Bool) -> (display: CGDirectDisplayID, marks: [CGRect])? {
        guard ControlsProbe.observed else { return nil }
        observedInk = true
        return ink.showFixture(scene, front: front)
    }

    @objc private func toggleCapture() {
        guard let button = statusItem.button else { return }
        readPermissions()
        render()
        capturePopover.toggle(relativeTo: button, activate: !ControlsProbe.observed)
        if capturePopover.isShown { refresh() }
    }

    private var sourceMode: CaptureViewInput.Source {
        switch state.selection.source {
        case .display: .display
        case .window: .window
        case .region: .area
        case .camera: .cameraOnly
        case nil: emptySourceMode
        }
    }

    func perform(_ intent: CaptureViewIntent) {
        switch intent {
        case .controls(let action): perform(action)
        case .openLibrary: perform(ControlsAction.openLibrary)
        case .chooseSource(let source):
            guard !state.isLive, !state.counting, !updateFenced else { return }
            guard source == .cameraOnly || state.screenSelectionAuthorized else {
                state.failure = .init(CapturePresentation.screenSelectionPermissionNotice)
                render()
                return
            }
            emptySourceMode = source
            switch source {
            case .display: state.selection.source = state.sources.displays.first.map { .display($0) }
            case .window: state.selection.source = state.sources.windows.first.map { .window($0) }
            case .area:
                state.selection.source = nil
                perform(.selectRegion)
            case .cameraOnly:
                state.selection.source = .camera
            }
            render()
        case .camera(let id):
            guard !state.isLive, !state.counting, !updateFenced else { return }
            state.chooseCamera(id)
            render()
        case .countdown(let enabled):
            guard !state.isLive, !state.counting, !updateFenced else { return }
            preferences.countdownBeforeRecording = enabled
            render()
        }
    }

    private func performShortcut(_ action: ControlsAction) {
        let origin: ControlsState.StartOrigin? = action == .startOrStop
            ? .hotkey(pointer: NSEvent.mouseLocation) : nil
        perform(action, origin: origin)
    }

    func perform(_ action: ControlsAction, origin: ControlsState.StartOrigin? = nil, surface: ControlsState.Failure.Scope = .capture) {
        // A second press within 0.4 s of a hotkey start is the same press bouncing, not a request
        // to finish: ignoring it means a double tap never leaves an empty take behind.
        if action == .startOrStop, case .hotkey = origin,
            Date().timeIntervalSince(lastHotkeyStart) < 0.4
        { return }
        if updateFenced {
            switch action {
            case .quit, .openSettings, .openLibrary: break
            default:
                state.failure = .init("An update is installing. Try again after the app reopens.")
                render(); return
            }
        }
        switch action {
        case .selectDisplay, .selectWindow, .selectRegion:
            guard state.screenSelectionAuthorized else {
                state.failure = .init(CapturePresentation.screenSelectionPermissionNotice)
                render()
                return
            }
        default: break
        }
        let chosen = state.selection.recordingDefaults
        switch action {
        case .nextRecordings, .previousRecordings, .nextProjects, .previousProjects:
            libraryWindow.view.clearPageFilter()
        default: break
        }
        if library.perform(action) { render(); return }
        switch action {
        case .selectDisplay(let id):
            if let display = state.sources.displays.first(where: { $0.id == id }) {
                state.selection.source = .display(display)
            }
        case .selectWindow(let id):
            if let window = state.sources.windows.first(where: { $0.id == id }) {
                state.selection.source = .window(window)
            }
        case .selectRegion:
            guard !state.sources.displays.isEmpty else {
                state.failure = .init("Allow screen recording access before choosing an area.")
                render()
                return
            }
            capturePopover.close()
            region.choose(displays: state.sources.displays) { [weak self] chosen in
                guard let self else { return }
                if let chosen { state.selection.source = .region(chosen) }
                render()
                showCaptureIfClosed()
            }
        case .disableMicrophone:
            state.selection.microphone = .off
        case .selectMicrophone(nil):
            state.selection.microphone = .systemDefault
            state.selection.awaitedMicrophone = nil
        case .selectMicrophone(.some(let id)):
            if let microphone = state.sources.microphones.first(where: { $0.id == id }) {
                state.selection.microphone = .device(id: microphone.id, name: microphone.name)
                state.selection.awaitedMicrophone = nil
            } else if case .device(let awaited, _)? = state.selection.awaitedMicrophone,
                awaited == id {
                // Choosing the one that is unplugged again is asking to keep waiting for it, which
                // is already what is happening; anything else here would discard their choice.
                break
            }
        case .toggleSystemAudio:
            state.selection.systemAudio.toggle()
        case .showCameraPreview(let shown):
            preferences.showCameraPreview = shown
        case .setCamera(let on):
            if let request = state.setCamera(on) { setCamera(request) }
        case .startOrStop:
            state.isLive ? send("capture.stop", live(), then: prompts.stopped) : countThenStart(origin: origin ?? .menu)
        case .dismissFailure:
            state.failure = nil
        case .retryFailure:
            switch state.failure?.action {
            case .start(let request): start(origin: request.origin, retrying: request)
            case .copyPrompt(let target): copyPrompt(target, surface: state.failure?.scope ?? .capture)
            case nil: break
            }
        case .pastePrompt:
            let recordingId = state.isLive ? (live()?["recordingId"] as? String) : nil
            copyPrompt(recordingId.map(MediaTarget.recording), .paste)
        case .undoMark:
            captureController?.clearLatestMark()
        case .pauseOrResume:
            guard state.isLive else { return render() }
            send(state.device?.state == .paused ? "capture.resume" : "capture.pause", live())
        case .cancel:
            if countdown.isCounting { countdown.abandon() }
            else if state.isLive { send("capture.cancel", live()) }
        case .restart:
            restart()
        case .playRecording(let recordingId):
            playRecording(recordingId, surface: surface)
        case .copyRecordingPrompt(let recordingId):
            copyPrompt(.recording(recordingId), surface: surface)
        case .copyProjectPrompt(let projectId):
            copyPrompt(.project(projectId), surface: surface)
        case .playAsset(let assetId):
            playAsset(assetId, surface: surface)
        case .copyAssetPrompt(let assetId):
            copyPrompt(.asset(assetId), surface: surface)
        case .retryImport, .deleteRecording, .deleteAsset,
            .previewProject, .exportProject, .deleteProject, .nextProjects, .previousProjects, .nextRecordings, .previousRecordings, .refreshLibrary:
            break // LibraryController handles these before capture selections.
        case .resendExport(let exportId):
            exports.resend(exportId)
        case .retryExport(let exportId):
            exports.retry(exportId)
        case .abandonExport(let exportId):
            exports.abandon(exportId)
        case .revealExport(let exportId):
            exports.reveal(exportId)
        case .dismissExport(let exportId):
            exports.dismiss(exportId)
        case .refreshStorage:
            readStorage()
        case .requestScreenPermission:
            request(.screen)
        case .requestMicrophonePermission:
            request(.microphone)
        case .requestCameraPermission:
            request(.camera)
        case .requestAccessibilityPermission:
            request(.accessibility)
        case .openLibrary:
            capturePopover.close()
            libraryWindow.show()
            library.refresh()
            readStorage()
            exports.discover()
        case .openSettings:
            capturePopover.close()
            settings.show()
        case .quit:
            quit()
        }
        if state.selection.recordingDefaults != chosen {
            preferences.recording = state.selection.recordingDefaults
        }
        render()
    }

    /// The take the device is working on. Capture control names its recording, so an action with
    /// no live take is refused here rather than sent without one.
    private func live() -> [String: Any]? {
        guard let recordingId = state.device?.recordingId
            ?? (state.take?.state == "finalizing" ? state.take?.id : nil) else { return nil }
        return ["recordingId": recordingId]
    }

    /// A start a person asked for, from the menu, the floating controls or a key combination: the
    /// count runs first and nothing is asked of the service until it has run out, so an abandoned
    /// count leaves no take behind. A start with nothing to record, no service to record through,
    /// or the count turned off goes straight to the service, which is what says why it could not:
    /// counting three seconds down before saying no is three seconds nobody asked for.
    private func countThenStart(origin: ControlsState.StartOrigin) {
        // Asking to start while the count runs is asking to stop it: the menu says so, and this is
        // the only way to abandon a count for somebody whose Escape key this app could not hold.
        if countdown.isCounting { return countdown.abandon() }
        guard !state.cameraBlocksStart else {
            state.failure = .init("Choose a camera before recording.")
            showCaptureIfClosed()
            return
        }
        guard let resolvedStart = state.start(origin: origin) else { return start(origin: origin) }
        if case .hotkey = origin { lastHotkeyStart = Date() }
        guard state.service == .ready,
            let counting = preferences.countdown
        else { return start(origin: origin) }
        state.counting = true
        // The menu hangs from the menu bar, right where the count and then the controls appear.
        // A refused start shows it again to explain.
        capturePopover.close()
        render()
        countdown.run(counting, on: screen(for: resolvedStart) ?? statusItem.button?.window?.screen) { [weak self] began in
            guard let self else { return }
            state.counting = false
            if began { start(origin: origin) }
            render()
        }
    }

    private func start(origin: ControlsState.StartOrigin, retrying: ControlsState.StartRequest? = nil) {
        guard let request = state.beginStart(newRequestId: UUID().uuidString, origin: origin, retrying: retrying) else { return }
        capturePopover.close()
        render()
        send("capture.start", parameters(of: request.start, requestId: request.requestId), failureRequest: retrying?.requestId ?? request.requestId) {
            [weak self] result in
            guard let self else { return }
            let answer: ControlsState.StartAnswer
            switch result {
            case .success(let data):
                if let take = try? JSONDecoder().decode(ControlsState.TakeStatus.self, from: data) {
                    if state.observeTake(take) { showCaptureIfClosed() }
                    answer = .init(recordingState: take.state)
                } else {
                    answer = .unanswered
                }
            case .failure(let failure): answer = .init(failureCode: failure.code)
            }
            if state.finishStart(request, answer) { return start(origin: request.origin) }
            if case .failure(let failure) = result,
                PermissionKind.missing(fromStartFailure: failure.code) != nil { readPermissions() }
            if case .failure(let failure) = result {
                state.failure = .init(failure.localizedDescription, request: request.requestId,
                    action: failure.retryable ? .start(request) : nil, operation: "capture.start")
                showCaptureIfClosed()
            }
        }
    }

    private func screen(for start: ControlsState.CaptureSelection.Start) -> NSScreen? {
        switch start.source {
        case .display(let id):
            return state.sources.displays.first { $0.id == id }.flatMap { NSScreen.recording(.display($0)) }
        case .window(let id):
            return NSScreen.recording(.window(.init(id: id, title: "", application: "")))
        case .region(let id, _, _, _, _):
            return NSScreen.recording(.region(.init(
                displayId: id, displayName: "Display \(id)", x: 0, y: 0, width: 0, height: 0)))
        case .camera: return nil
        }
    }

    private func restart() {
        guard let recordingId = state.device?.recordingId else { return }
        guard let start = state.restartStart else {
            state.failure = .init("Choose a source before recording.")
            return
        }
        var params = parameters(of: start, requestId: UUID().uuidString)
        params["recordingId"] = recordingId
        send("capture.restart", params) { [weak self] result in
            guard let self, case .success(let data) = result,
                let take = try? JSONDecoder().decode(ControlsState.TakeStatus.self, from: data)
            else { return }
            state.restarted(recordingId: take.id, start: start)
        }
    }

    /// A live toggle. A refusal (the camera is gone, the turn-on limit, a changed format, missing
    /// access) leaves the camera off and is shown like any other refused action, with the capture
    /// panel revealed because the floating controls have no room to explain it.
    private func setCamera(_ request: ControlsState.SetCamera) {
        let params = (try? JSONEncoder().encode(request)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        send("capture.setCamera", params) { [weak self] result in
            guard let self, case .failure(let failure) = result else { return }
            if PermissionKind.missing(fromStartFailure: failure.code) != nil { readPermissions() }
            showCaptureIfClosed()
        }
    }

    private func parameters(
        of start: ControlsState.CaptureSelection.Start, requestId: String
    ) -> [String: Any] {
        var params =
            (try? JSONEncoder().encode(start)).flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            } ?? [:]
        params["requestId"] = requestId
        return params
    }

    /// Sends one operation; only its own success resolves the failure it produced.
    private func send(
        _ operation: String, _ params: [String: Any]?, failureRequest: String? = nil,
        then settle: (@MainActor (Result<Data, ServiceFailure>) -> Void)? = nil
    ) {
        guard let params else {
            state.failure = .init("No take is recording.")
            return render()
        }
        let request = failureRequest ?? "\(operation).\(params["recordingId"] as? String ?? "")"
        Task { @MainActor in
            let result: Result<Data, ServiceFailure>
            do throws(ServiceFailure) {
                result = .success(try await service().call(operation, params))
                state.resolveFailure(request: request)
            } catch {
                result = .failure(error)
                state.failure = .init(error.localizedDescription, request: request, operation: operation)
            }
            settle?(result)
            refresh()
        }
    }

    /// A library scan may be slow. It never occupies the status read, and overlapping explicit
    /// refreshes coalesce so a deletion finishing mid-scan gets a fresh observation afterward.
    private func readStorage() {
        guard !updateFenced, host != nil, state.service == .ready else { return }
        guard !state.storageRefreshing else {
            pendingStorageRefresh = true
            return
        }
        state.storageRefreshing = true
        state.storageFailure = nil
        render()
        Task { @MainActor in
            do throws(ServiceFailure) {
                state.storage = try await service().call(
                    "storage.usage", as: ControlsState.StorageObservation.self)
            } catch {
                state.storageFailure = error.localizedDescription
            }
            state.storageRefreshing = false
            render()
            if pendingStorageRefresh {
                pendingStorageRefresh = false
                readStorage()
            }
        }
    }

    /// Explicit failures can be revealed without activating over the source being recorded.
    private func showCaptureIfClosed() {
        guard !capturePopover.isShown, let button = statusItem.button else { return }
        render()
        capturePopover.toggle(relativeTo: button)
    }

    /// Permission is requested only here, by a person choosing to request it. Nothing on the way
    /// to a launched, ready app reaches this. Once a prompt has been answered macOS never shows it
    /// again, so a denied access opens its privacy pane instead of asking for nothing.
    private func request(_ kind: PermissionKind) {
        readPermissions()
        switch state.permissions?.access(to: kind) {
        case .granted, .reopenToUse: return
        case .denied:
            NSWorkspace.shared.open(kind.settingsURL)
            return
        case .undetermined, nil: break
        }
        permissionRequests += 1
        render()
        Task { @MainActor in
            defer { permissionRequests -= 1; render() }
            do {
                let granted = try await NativeCapture.requestPermission(
                    kind.rawValue)
                if granted, kind == .screen, !NativeCapture.screenPermission {
                    state.failure = .init("Screen recording was allowed. Quit and reopen Yap to record.")
                } else if !granted {
                    if kind == .screen { screenRequestRefused = true }
                    state.failure = .init("\(kind.missingLine) Allow it in System Settings > Privacy & Security.")
                }
            } catch {
                state.failure = .init(error.localizedDescription)
            }
            refresh()
            render()
        }
    }

    /// What native capture in this process may do, read without asking for anything. A display
    /// fixture may state it instead, so each access state can be looked at without changing the
    /// system's own record.
    private func readPermissions() {
        state.permissions = ControlsProbe.displayedPermissions ?? ControlsState.Permissions(
            screen: NativeCapture.screenPermission ? .granted : screenRequestRefused ? .denied : .undetermined,
            microphone: .init(authorization: NativeCapture.microphonePermission),
            camera: .init(authorization: NativeCapture.cameraPermission),
            accessibility: prompts.paster.access)
    }

    // MARK: reading

    /// Reads everything the menu shows. Used when a person looks at the controls or acts on them.
    private func refresh() {
        guard !updateFenced else { return }
        readPermissions()
        read(everything: true)
        readStorage()
        library.refresh()
    }

    /// Status-only polling observes external controls without re-enumerating idle sources.
    private func tick() {
        guard !updateFenced else { return }
        preview.tick()
        exports.tick()
        library.tick()
        read(everything: false)
    }

    func closePreview() { preview.close() }

    var updateBlockers: [String] {
        var blockers: [String] = []
        if state.counting { blockers.append("native.countdown") }
        if state.unansweredStart != nil { blockers.append("native.start") }
        if permissionRequests > 0 { blockers.append("native.permission") }
        if region.isChoosing || exports.state.choosing != nil { blockers.append("native.chooser") }
        if preview.isOpen { blockers.append("native.preview") }
        if !exports.state.requests.isEmpty || !exports.state.acting.isEmpty { blockers.append("native.export") }
        if library.state.deletions.values.contains(where: { $0.isPending }) { blockers.append("native.deletion") }
        return blockers
    }
    func fenceForUpdate(_ fenced: Bool) {
        updateFenced = fenced
    }

    private func read(everything: Bool) {
        guard !updateFenced, host != nil, state.service == .ready else { return }
        guard !reading else {
            pendingRefresh = pendingRefresh || everything
            return
        }
        reading = true
        Task { @MainActor in
            let previous = state.device
            await readStatus()
            if everything || previous?.recordingId != state.device?.recordingId
                || previous?.state != state.device?.state {
                await readSources()
                if !updateFenced { library.refreshRecordings() }
            }
            reading = false
            render()
            if pendingRefresh {
                pendingRefresh = false
                refresh()
            }
        }
    }

    private func readStatus() async {
        guard let answer = try? await service().call("capture.status", as: StatusAnswer.self)
        else { return }
        state.device = ControlsState.DeviceStatus(
            state: ControlsState.DeviceState(rawValue: answer.device.state) ?? .idle,
            recordingId: answer.device.recordingId, elapsedUs: answer.device.elapsedUs, camera: answer.device.camera)
        if let selection = answer.device.selection {
            state.selection.apply(selection, catalog: state.sources)
        }
        var observed = answer.recording
        if observed == nil, let id = state.takeNeedingResolution {
            do throws(ServiceFailure) {
                let resolved = try await service().call(
                    "recording.get", ["recordingId": id], as: ControlsState.TakeStatus.self)
                // A start response may arrive while this read is in flight.
                if state.take?.id == id { observed = resolved }
            } catch {
                if error.code == "NOT_FOUND" { state.takeWasDeleted(id) }
            }
        }
        if state.observeTake(observed) { showCaptureIfClosed() }
        if let finished = prompts.finishedTake(state.take) { copyPrompt(.recording(finished), .announce) }
    }

    private func readSources() async {
        // A take fixes what it records, so the catalog is only refreshed while nothing is running.
        guard !updateFenced, !state.isLive else { return }
        do throws(ServiceFailure) {
            let answer = try await service().call("capture.sources", as: SourcesAnswer.self)
            emptySourceMode = sourceMode
            state.observeSources(
                ControlsState.SourceCatalog(
                    displays: answer.displays.map { source in
                        ControlsState.Display(
                            id: source.id, name: source.name, width: source.width, height: source.height,
                            frame: NSScreen.screens.first { $0.captureDisplayID == source.id }?.frame)
                    },
                    windows: answer.windows.map {
                        ControlsState.Window(id: $0.id, title: $0.title, application: $0.application)
                    },
                    microphones: answer.microphones.map {
                        ControlsState.Microphone(id: $0.id, name: $0.name, isDefault: $0.isDefault)
                    }, cameras: answer.cameras.map {
                        ControlsState.Camera(id: $0.id, name: $0.name, isDefault: $0.isDefault ?? false)
                    }))
        } catch {
            state.sourcesUnavailable(description: error.localizedDescription)
        }
    }

    private static let noService = ServiceFailure(
        code: "SERVICE_UNAVAILABLE", message: "No service is running.")

    /// The service these controls act through.
    private func service() throws(ServiceFailure) -> ServiceHost {
        guard let host else { throw Self.noService }
        return host
    }

    // MARK: showing

    private func render() {
        let blockers = updateBlockers
        if blockers != lastUpdateBlockers {
            lastUpdateBlockers = blockers
            updateProgress?()
        }
        syncShortcutLifetime()
        if !capturePopover.isShown { sourcePreviews.forgetRequests() }
        capturePopover.update(captureInput())
        libraryWindow.update(state: state, exports: exports.state)
        overlay.update(RecordingOverlay.presentation(for: state) ?? observedOverlay)
        ink.update(active: observedInk || state.showsInk)
        let camera = RecordingOverlay.camera(for: state)
        // A camera that is off forgets its last picture, so turning it on again never shows it.
        if !camera.recording { cameraPreviewImage = nil }
        overlay.updateCamera(camera, previewShown: preferences.showCameraPreview)
        overlay.updateGlass(preferences.controlsGlass)
        overlay.updatePreview(cameraPreviewImage)
        settings.update(state, shortcuts: bindings)
        showStatusItem()
        pace()
    }

    private func syncShortcutLifetime() {
        guard !shortcutsSuspended else { return }
        let recording = state.isLive || state.counting
        guard recording != shortcutsRecording else { return }
        do {
            try applyShortcuts(bindings, recording: recording)
        } catch {
            state.failure = .init("Duplicate shortcuts: \(error)")
        }
    }

    var captureView: CaptureView? { capturePopover.view }
    var savedMediaView: LibraryView { libraryWindow.view }

    func receiveCameraFrame(_ frame: NativeCapture.CameraPreviewFrame) {
        let now = Date()
        guard now.timeIntervalSince(lastCameraPreviewUpdate) >= 0.1 else { return }
        lastCameraPreviewUpdate = now
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let ci = CIImage(cvPixelBuffer: frame.buffer)
            guard let cg = self.cameraPreviewContext.createCGImage(ci, from: ci.extent) else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, RecordingOverlay.camera(for: self.state).recording else { return }
                let image = NSImage(cgImage: cg, size: NSSize(width: ci.extent.width, height: ci.extent.height))
                self.cameraPreviewImage = image
                self.overlay.updatePreview(image)
            }
        }
    }
    func openCapture() { if !capturePopover.isShown { toggleCapture() } }
    func closeCapture() { capturePopover.close() }

    private func playRecording(_ recordingId: String, surface: ControlsState.Failure.Scope) {
        let source = URL(fileURLWithPath: home)
            .appendingPathComponent("library/recordings")
            .appendingPathComponent(recordingId)
            .appendingPathComponent("source")
        let video = source.appendingPathComponent("video.mov")
        let narration = source.appendingPathComponent("narration.mov")
        guard FileManager.default.fileExists(atPath: video.path) else {
            state.failure = .init("Couldn't play recording: Its video is unavailable.", scope: surface, request: ControlsAction.playRecording(recordingId).id)
            render()
            return
        }
        state.resolveFailure(request: ControlsAction.playRecording(recordingId).id)
        if FileManager.default.fileExists(atPath: narration.path) {
            recordingPreview.playLocalRecording(title: "Recording — \(recordingId)",
                video: video.path, narration: narration.path)
        } else {
            recordingPreview.playLocalFile(title: "Recording — \(recordingId)", file: video.path,
                mediaType: "video/quicktime")
        }
    }

    /// An import plays from the library's own copy, named by the asset's immutable file name.
    private func playAsset(_ assetId: String, surface: ControlsState.Failure.Scope) {
        Task { @MainActor in
            do throws(ServiceFailure) {
                let asset = try await service().call("asset.get", ["assetId": assetId], as: AssetFile.self)
                let file = URL(fileURLWithPath: home).appendingPathComponent("library/assets")
                    .appendingPathComponent(asset.fileName)
                guard asset.id == assetId, !asset.fileName.contains("/"),
                    FileManager.default.fileExists(atPath: file.path) else {
                    state.failure = .init("Couldn't play video: Its file is unavailable.", scope: surface, request: ControlsAction.playAsset(assetId).id)
                    render()
                    return
                }
                state.resolveFailure(request: ControlsAction.playAsset(assetId).id)
                let type = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "video/quicktime"
                recordingPreview.playLocalFile(title: asset.fileName, file: file.path, mediaType: type)
            } catch {
                state.failure = .init("Couldn't play video: \(error.localizedDescription)", scope: surface, request: ControlsAction.playAsset(assetId).id)
                render()
            }
        }
    }
    private struct AssetFile: Decodable { let id: String; let fileName: String }

    /// The service owns the handoff text; the app only copies what `recording.prompt` returns, or
    /// pastes it into the front app for the paste shortcut. No target means the newest recording.
    private func copyPrompt(_ target: MediaTarget?, _ delivery: PromptHandoff.Delivery = .copy, surface: ControlsState.Failure.Scope = .capture) {
        let request = "recording.prompt.\(String(describing: target))"
        Task { @MainActor in
            do throws(ServiceFailure) {
                try await prompts.handOver(target, delivery, from: service())
                state.resolveFailure(request: request)
            } catch {
                state.failure = .init("Couldn't \(delivery == .paste ? "paste" : "copy") prompt: \(error.localizedDescription)", scope: surface,
                    request: request, action: delivery == .copy ? nil : .copyPrompt(target))
                render()
            }
        }
    }

    var captureRows: [[String: Any]] {
        guard let view = captureView else { return [] }
        return nativeControls(in: view).map { control in
            let nativeID = control.identifier!.rawValue
            let item = nativeID == "capture.start" ? ControlsAction.startOrStop.id : nativeID == "header.library" ? ControlsAction.openLibrary.id : nativeID == "systemAudio.toggle" ? ControlsAction.toggleSystemAudio.id : nativeID
            var row: [String: Any] = ["item": item, "identifier": nativeID, "enabled": control.isEnabled,
                "title": (control as? NSButton)?.title ?? (control as? NSPopUpButton)?.titleOfSelectedItem ?? nativeID,
                "checked": (control as? NSSwitch).map { $0.state == .on } ?? ((control.accessibilityValue() as? NSNumber)?.boolValue ?? false)]
            if let choices = captureChoices(identifier: nativeID, input: view.input),
                let selected = (control as? NSPopUpButton)?.indexOfSelectedItem ?? (control as? SourcePickerButton)?.selected {
                row["submenu"] = choices.enumerated().map { index, choice in
                    ["item": choice.intent.id, "title": choice.title, "enabled": control.isEnabled, "checked": index == selected] as [String: Any]
                }
            }
            return row
        }
    }

    var libraryRows: [[String: Any]] {
        guard libraryWindow.isVisible else { return [] }
        let page: SavedPage
        switch savedMediaView.tab {
        case .recordings: page = LibraryPresentation.recordings(for: state)
        case .projects: page = LibraryPresentation.projects(for: state, exports: exports.state)
        case .exports: page = ExportPresentation.items(for: state, exports: exports.state)
        }
        return page.items.filter { item in
            item.kind == .message
                || savedMediaView.control(identifier: "actions.\(item.id)") != nil
                || (0..<item.actions.count).contains { savedMediaView.control(identifier: "actions.\(item.id).\($0)") != nil }
        }.map { item in
            ["title": item.title, "id": item.id, "details": item.details, "submenu": item.actions.map { action in
                ["item": action.action.id, "title": action.title, "enabled": action.enabled] as [String: Any]
            }] as [String: Any]
        } + page.actions.map { ["item": $0.action.id, "title": $0.title, "enabled": $0.enabled] }
    }

    func chooseControl(named identifier: String) -> Bool {
        if libraryWindow.isVisible, let item = savedMediaView.actionItem(identifier: identifier), item.isEnabled, let menu = item.menu {
            menu.performActionForItem(at: menu.index(of: item))
            return true
        }
        guard let view = captureView else { return false }
        let nativeID = identifier == ControlsAction.startOrStop.id ? "capture.start" : identifier == ControlsAction.openLibrary.id ? "header.library" : identifier == ControlsAction.toggleSystemAudio.id ? "systemAudio.toggle" : identifier
        if let control = view.control(identifier: nativeID), control.isEnabled {
            control.performClick(nil)
            return true
        }
        for chooserID in ["source.device", "camera.device", "microphone.device"] {
            guard let chooser = view.control(identifier: chooserID), chooser.isEnabled,
                let choices = captureChoices(identifier: chooserID, input: view.input),
                let index = choices.firstIndex(where: { $0.intent.id == identifier }) else { continue }
            if let picker = chooser as? SourcePickerButton {
                picker.choose(at: index)
                return true
            }
            guard let popup = chooser as? NSPopUpButton else { continue }
            popup.selectItem(at: index)
            return popup.sendAction(popup.action!, to: popup.target)
        }
        return false
    }

    private func nativeControls(in view: NSView) -> [NSControl] {
        view.subviews.flatMap { child in
            let own = (child as? NSControl).flatMap { $0.identifier == nil ? nil : $0 }.map { [$0] } ?? []
            return own + nativeControls(in: child)
        }.sorted { $0.convert($0.bounds, to: view).minY < $1.convert($1.bounds, to: view).minY }
    }
    private func captureChoices(identifier: String, input: CaptureViewInput) -> [CaptureViewInput.Choice]? {
        switch identifier {
        case "source.device": input.sourceChoices
        case "camera.device": input.cameraChoices
        case "microphone.device": input.microphoneChoices
        default: nil
        }
    }
    private func captureInput() -> CaptureViewInput {
        let mode = sourceMode
        var sources: [CaptureViewInput.Choice] = []
        let selectedSource: Int
        switch mode {
        case .display:
            sources = state.sources.displays.map { display in
                .init(title: display.name, intent: .controls(.selectDisplay(display.id)),
                      preview: sourcePreviews.display(display.id, taking: capturePopover.isShown))
            }
            if case .display(let display) = state.selection.source { selectedSource = state.sources.displays.firstIndex { $0.id == display.id } ?? -1 }
            else { selectedSource = -1 }
        case .window:
            sources = state.sources.windows.map { window in
                .init(title: window.label,
                      intent: .controls(.selectWindow(window.id)), preview: sourcePreviews.window(window.id, taking: capturePopover.isShown))
            }
            if case .window(let window) = state.selection.source { selectedSource = state.sources.windows.firstIndex { $0.id == window.id } ?? -1 }
            else { selectedSource = -1 }
        case .area:
            sources = [.init(title: state.selection.source == nil ? "Select an area…" : CapturePresentation.sourceTitle(for: state), intent: .controls(.selectRegion))]
            selectedSource = 0
        case .cameraOnly: selectedSource = -1
        }
        if sources.isEmpty { sources = [.init(title: mode == .window ? "No windows available" : "No displays available", intent: .chooseSource(mode))] }
        // The menu only says which camera; the switch beside it says whether it records. A Mac with
        // no camera shows that in the menu, and the row is disabled.
        var cameras: [CaptureViewInput.Choice] = state.sources.cameras.map { .init(title: $0.name, intent: .camera($0.id)) }
        var selectedCamera = state.selection.cameraDeviceId.flatMap { id in state.sources.cameras.firstIndex { $0.id == id } } ?? -1
        if !state.cameraAvailable {
            cameras = [.init(title: "No camera", intent: .controls(.setCamera(false)))]
            selectedCamera = 0
        } else if let id = state.selection.cameraDeviceId, selectedCamera < 0 {
            cameras.append(.init(title: "Selected camera unavailable", intent: .camera(id)))
            selectedCamera = cameras.count - 1
        }
        let defaultMicrophoneTitle = state.sources.microphones.first(where: \.isDefault).map { "\($0.name) (default)" } ?? "System default input"
        var microphones: [CaptureViewInput.Choice] = [.init(title: defaultMicrophoneTitle, intent: .controls(.selectMicrophone(nil)))] + state.sources.microphones.map { .init(title: $0.name, intent: .controls(.selectMicrophone($0.id))) }
        for choice in [state.selection.microphone, state.selection.awaitedMicrophone].compactMap({ $0 }) {
            if case .device(let id, let name) = choice,
                !microphones.contains(where: { $0.intent == .controls(.selectMicrophone(id)) }) {
                microphones.append(.init(title: "\(name) — unavailable", intent: .controls(.selectMicrophone(id))))
            }
        }
        var selectedMic: Int
        if case .device(let id, _) = state.selection.microphone { selectedMic = microphones.firstIndex { $0.intent == .controls(.selectMicrophone(id)) }! }
        else { selectedMic = 0 }
        if !state.microphoneAvailable {
            microphones = [.init(title: "No microphone", intent: .controls(.disableMicrophone))]
            selectedMic = 0
        }
        let transport = CapturePresentation.transport(for: state)
        let startAction = transport.first { $0.action == .startOrStop }
        let missingCamera = !state.isLive && !state.counting && state.cameraBlocksStart
        let liveCamera = RecordingOverlay.camera(for: state)
        var input = CaptureViewInput(selectedSource: mode, selectedSourceChoice: selectedSource,
            sourceChoices: sources, cameraChoices: cameras, selectedCamera: selectedCamera,
            cameraOn: state.isLive ? liveCamera.recording : state.cameraAvailable && (mode == .cameraOnly || state.selection.cameraOn),
            cameraAvailable: state.cameraAvailable,
            microphoneChoices: microphones, selectedMicrophone: selectedMic,
            microphoneOn: state.microphoneAvailable && state.selection.microphone != .off,
            microphoneAvailable: state.microphoneAvailable, systemAudio: state.selection.systemAudio,
            countdown: preferences.countdownBeforeRecording,
            inputsEnabled: !state.isLive && !state.counting && !updateFenced,
            startEnabled: startAction?.enabled == true && !missingCamera && !updateFenced,
            status: CapturePresentation.statusTitle(for: state))
        input.startTitle = startAction?.title
        input.startShortcut = held.contains(ControlsAction.startOrStop.id)
            ? bindings[.startOrStop]?.shortcut.label : nil
        input.notices = CapturePresentation.noticeLines(for: state)
        input.adminMessage = state.adminMessage
        input.screenSourcesEnabled = state.screenSelectionAuthorized
        if !input.screenSourcesEnabled {
            input.notices.append(CapturePresentation.screenSelectionPermissionNotice)
        }
        if mode == .area, state.selection.source == nil {
            input.notices.append("Click and drag to choose the area to record.")
        }
        if state.selection.microphone == .systemDefault && state.selection.awaitedMicrophone != nil {
            input.notices.append("Microphone: \(CapturePresentation.microphoneTitle(for: state)).")
        }
        if missingCamera { input.notices.append("Choose a camera before recording.") }
        let required: [PermissionKind] = PermissionKind.allCases.filter { kind in
            switch kind {
            case .screen: !input.screenSourcesEnabled || mode != .cameraOnly || state.selection.systemAudio
            case .microphone: state.selection.microphone != .off
            case .camera: mode == .cameraOnly || input.cameraOn
            case .accessibility: false
            }
        }
        input.permissionActions = required.compactMap { kind in
            guard let access = state.permissions?.access(to: kind), access != .granted else { return nil }
            return .init(kind.action, kind.allowTitle(for: access), enabled: !state.isLive && !updateFenced)
        }
        input.failureMessage = state.failure?.scope == .capture ? state.failure?.message : nil
        input.failureAction = CapturePresentation.failureAction(for: state)
        input.transport = state.isLive ? transport.filter { $0.action != .startOrStop } : []
        if case .companion = liveCamera { input.liveCamera = !updateFenced }
        if let take = state.library.recent.first {
            let pending = state.library.deletions[.recording(take.id)]?.isPending == true
            input.lastRecording = .init(
                recordingId: take.id,
                title: LibraryPresentation.recordingTitle(of: take),
                canPlay: state.service == .ready && !pending && take.state != "canceled",
                canCopyPrompt: !pending)
        }
        return input
    }

    private func showStatusItem() {
        guard let button = statusItem.button else { return }
        let described = CapturePresentation.statusTitle(for: state)
        button.image = StatusItemAppearance.image(for: state)
        button.image?.isTemplate = state.device?.state != .recording
        button.imagePosition = .imageOnly
        button.title = ""
        button.contentTintColor = state.device?.state == .recording ? .systemRed : nil
        button.setAccessibilityLabel("Yap — \(described)")
    }

    /// Status remains observable while idle or paused: another client can start or resume a take.
    /// Only one read runs at a time; catalog reads are reserved for transitions and explicit refreshes.
    private func pace() {
        guard state.service == .ready else {
            ticker?.invalidate()
            ticker = nil
            return
        }
        guard ticker == nil else { return }
        let timer = Timer(timeInterval: Self.tick, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // An open menu runs its own event tracking, so the clock a person is watching keeps moving.
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }
}
