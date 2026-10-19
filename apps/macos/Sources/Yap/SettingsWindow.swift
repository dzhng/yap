import AppKit
import Carbon.HIToolbox
import YapControls
import ServiceManagement
import SwiftUI

/// What the "Set up my agents" row drives: the yap command and the skill, as one switch.
@MainActor protocol AgentSetup {
    func setEnabled(_ enabled: Bool)
    func summary() -> String
}

@MainActor final class NoAgentSetup: AgentSetup {
    func setEnabled(_ enabled: Bool) {}
    func summary() -> String { "" }
}

/**
 The Settings window: permissions, recording defaults, shortcuts and launch behaviour in one
 ordinary window, so none of it is only reachable through nested submenus.

 It owns no selection and no permission state. The recording controls push the one state they
 hold, and every recording or permission change goes back to them as the same action the menu
 sends. Only the launch preference and login-item registration are edited here directly: the first
 lives in preferences, the second is read from and written to the system, never cached.
 Update controls call the shared native handler even when the child service is unavailable.
 */
@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate {
    static let title = "Yap Settings"

    private let model: SettingsModel
    private let preferences: Preferences
    private let refreshPermissions: () -> Void
    private let agentSetup: AgentSetup
    private var window: NSWindow?

    init(
        preferences: Preferences, perform: @escaping (ControlsAction) -> Void,
        update: @escaping (String, [String: Any]) -> Void,
        suspendShortcuts: @escaping () -> Void,
        resumeShortcuts: @escaping () -> Void,
        setShortcut: @escaping (ControlsAction, Shortcut) -> Bool,
        refreshPermissions: @escaping () -> Void,
        agentSetup: AgentSetup = NoAgentSetup()
    ) {
        self.preferences = preferences
        self.refreshPermissions = refreshPermissions
        self.agentSetup = agentSetup
        model = SettingsModel(
            preferences: preferences, perform: perform, update: update,
            suspendShortcuts: suspendShortcuts, resumeShortcuts: resumeShortcuts,
            setShortcut: setShortcut, agentSetup: agentSetup)
        super.init()
        // Returning from System Settings activates this app again; that is when access changes.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.restoreAfterExternalSettings()
            }
        }
    }

    /// An accessory app is never frontmost on its own, so a person opening the window activates it.
    /// A launch a check drives orders the same window in behind everything instead: taking the
    /// screen from whoever is at the Mac is no part of what such a run verifies.
    /// Re-reads the agent setup status line, e.g. after a background install settles.
    func refreshAgentSummary() { model.refreshAgentSummary() }

    func show() {
        let window = self.window ?? makeWindow()
        refreshSystemState()
        if ControlsProbe.observed {
            window.orderBack(nil)
            return
        }
        NSApplication.shared.activate()
        // A window put in the Dock earlier has to come out of it, or choosing Settings looks like
        // a menu row that does nothing.
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    func update(
        _ state: ControlsState, shortcuts: [ControlsAction: ShortcutBindings.Binding],
        registered: Set<String>
    ) {
        if model.state != state { model.state = state }
        if model.shortcuts != shortcuts { model.shortcuts = shortcuts }
        if model.registered != registered { model.registered = registered }
        if model.countdownBeforeRecording != preferences.countdownBeforeRecording {
            model.countdownBeforeRecording = preferences.countdownBeforeRecording
        }
        if model.showCameraPreview != preferences.showCameraPreview {
            model.showCameraPreview = preferences.showCameraPreview
        }
        if model.controlsGlass != preferences.controlsGlass {
            model.controlsGlass = preferences.controlsGlass
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        refreshSystemState()
    }

    func windowWillClose(_ notification: Notification) {
        if let window { preferences.settingsFrame = window.frameDescriptor }
    }

    /// Permission prompts and the Privacy pane activate another app. Keep Settings available
    /// during that handoff, then put this window back in front when Yap returns.
    private func restoreAfterExternalSettings() {
        guard let window, window.isVisible, !window.isMiniaturized else { return }
        refreshSystemState()
        guard !ControlsProbe.observed else { return }
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.orderFrontRegardless()
        window.makeKey()
    }

    private func refreshSystemState() {
        refreshPermissions()
        model.readLoginItem()
        model.refreshAgentSummary()
    }

    private func makeWindow() -> NSWindow {
        let content = NSHostingView(rootView: SettingsView(model: model))
        // The form scrolls, so the window decides its height: all of it where the screen has room.
        content.sizingOptions = []
        let available = (NSScreen.main?.visibleFrame.height ?? 900) - 60
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: min(780, available)),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = Self.title
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.contentView = content
        window.delegate = self
        // Where it was left, if that is still somewhere this Mac can show it: a window saved on a
        // display that has since been unplugged would otherwise open where nobody can reach it.
        if let frame = preferences.settingsFrame {
            window.setFrame(from: frame)
            if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) {
                window.center()
            }
        } else {
            window.center()
        }
        WindowMenu.install()
        self.window = window
        return window
    }


}

@MainActor
final class SettingsModel: ObservableObject {
    @Published var state = ControlsState()
    @Published var shortcuts = ShortcutBindings.defaults
    @Published var registered: Set<String> = []
    @Published var recordingAction: ControlsAction?
    @Published var shortcutErrorAction: ControlsAction?
    /// Read from the system each time the window is shown or comes forward.
    @Published private(set) var loginItem = SMAppService.Status.notRegistered
    @Published private(set) var loginFailure: String?
    @Published var showAtLaunch: Bool {
        didSet { preferences.showSettingsAtLaunch = showAtLaunch }
    }
    @Published var countdownBeforeRecording: Bool {
        didSet { preferences.countdownBeforeRecording = countdownBeforeRecording }
    }
    @Published var showCameraPreview: Bool {
        didSet { preferences.showCameraPreview = showCameraPreview }
    }
    @Published var controlsGlass: ControlsGlass {
        didSet { preferences.controlsGlass = controlsGlass }
    }
    @Published var setUpAgents: Bool {
        didSet {
            guard setUpAgents != oldValue else { return }
            preferences.setUpAgents = setUpAgents
            agentSetup.setEnabled(setUpAgents)
            refreshAgentSummary()
        }
    }
    @Published private(set) var agentSummary = ""
    let perform: (ControlsAction) -> Void
    private let update: (String, [String: Any]) -> Void
    private let suspendShortcuts: () -> Void
    private let resumeShortcuts: () -> Void
    private let setShortcut: (ControlsAction, Shortcut) -> Bool
    private let preferences: Preferences
    private let agentSetup: AgentSetup

    init(preferences: Preferences, perform: @escaping (ControlsAction) -> Void,
         update: @escaping (String, [String: Any]) -> Void,
         suspendShortcuts: @escaping () -> Void = {}, resumeShortcuts: @escaping () -> Void = {},
         setShortcut: @escaping (ControlsAction, Shortcut) -> Bool = { _, _ in false },
         agentSetup: AgentSetup = NoAgentSetup()) {
        self.preferences = preferences
        self.perform = perform
        self.update = update
        self.suspendShortcuts = suspendShortcuts
        self.resumeShortcuts = resumeShortcuts
        self.setShortcut = setShortcut
        self.agentSetup = agentSetup
        showAtLaunch = preferences.showSettingsAtLaunch
        countdownBeforeRecording = preferences.countdownBeforeRecording
        showCameraPreview = preferences.showCameraPreview
        controlsGlass = preferences.controlsGlass
        setUpAgents = preferences.setUpAgents
        agentSummary = agentSetup.summary()
    }

    /// The row's status line reads the disk, so it is re-read whenever Settings may be looked at.
    func refreshAgentSummary() { agentSummary = agentSetup.summary() }

    func beginShortcutRecording(_ action: ControlsAction) {
        shortcutErrorAction = nil
        recordingAction = action
        suspendShortcuts()
    }

    func endShortcutRecording(_ action: ControlsAction) {
        guard recordingAction == action else { return }
        recordingAction = nil
        resumeShortcuts()
    }

    func captureShortcut(_ action: ControlsAction, shortcut: Shortcut) {
        if setShortcut(action, shortcut) {
            shortcutErrorAction = nil
        } else {
            shortcutErrorAction = action
        }
    }

    func setAutomaticUpdates(_ enabled: Bool) {
        guard state.updates.available, enabled != state.updates.enabled else { return }
        update("update.setEnabled", ["enabled": enabled])
    }

    func checkForUpdates() {
        guard state.updates.available, state.updates.canCheck else { return }
        update("update.check", ["requestId": UUID().uuidString])
    }

    func readLoginItem() {
        loginItem = SMAppService.mainApp.status
    }

    /// Registration is the system's state; this only asks for a change and reads back the answer.
    func openAtLogin(_ enabled: Bool) {
        loginFailure = nil
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            loginFailure = error.localizedDescription
        }
        readLoginItem()
    }

}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        Form {
            if let message = model.state.adminMessage {
                Section("From the Yap team") {
                    Label {
                        Text(message).fontWeight(.medium).textSelection(.enabled)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                }
            }
            Section("About") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development")
            }
            Section("Permissions") {
                ForEach(PermissionKind.allCases, id: \.self) { kind in
                    permissionRow(kind)
                }
            }
            recordingSection
            shortcutsSection
            generalSection
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func permissionRow(_ kind: PermissionKind) -> some View {
        let access = model.state.permissions?.access(to: kind)
        // macOS tells an app whether it may record the screen once, when the app starts, so
        // allowing it while this window is open cannot change what this row says. Saying so is
        // the difference between a person quitting once and toggling a switch that never moves.
        let detail = kind == .screen && access != .granted
            ? "\(kind.purpose) Takes effect next time Yap opens."
            : kind.purpose
        detailRow(kind.name, detail) {
            switch access {
            case .granted?:
                Label(kind.statusTitle(for: .granted), systemImage: "checkmark.circle.fill")
                    .labelStyle(StatusLabelStyle(tint: .green))
            case let missing?:
                HStack(spacing: 10) {
                    // An optional access that is off is a choice, not a problem to fix.
                    if kind.isOptional {
                        Text(kind.statusTitle(for: missing)).foregroundStyle(.secondary)
                    } else {
                        Label(kind.statusTitle(for: missing), systemImage: "exclamationmark.circle.fill")
                            .labelStyle(StatusLabelStyle(tint: .orange))
                    }
                    // The same action as the menu's: it prompts, or opens the privacy pane once a
                    // prompt was already answered.
                    // Optional access is always granted in System Settings, so its button needs no longer name.
                    Button(missing == .denied && !kind.isOptional ? "Open System Settings…" : "Allow…") {
                        model.perform(kind.action)
                    }
                }
                // A longer explanation on the left takes room from this row, and a button whose
                // own words are cut off is worse than a line of text that wraps once more.
                .fixedSize(horizontal: true, vertical: false)
            case nil:
                Text("Checking…").foregroundStyle(.secondary)
            }
        }
    }

    /// A row whose label runs to a second explanatory line. `LabeledContent` aligns its value with
    /// the first line, which leaves a status and its button riding high against two lines of text,
    /// so this centers the value against the whole label the way System Settings does.
    private func detailRow(
        _ title: String, _ detail: String, @ViewBuilder content: () -> some View
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if !detail.isEmpty { Text(detail).font(.callout).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 12)
            content()
        }
    }

    private var recordingSection: some View {
        let live = model.state.isLive
        return Section {
            Picker(selection: microphone) {
                Text("Off (no narration)").tag(MicrophoneTag.off)
                Text(defaultInputTitle).tag(MicrophoneTag.systemDefault)
                if !inputs.isEmpty {
                    Divider()
                    ForEach(inputs, id: \.id) { input in
                        Text(input.name).tag(MicrophoneTag.device(input.id))
                    }
                }
            } label: {
                Text("Microphone")
            }
            .disabled(live)
            detailRow("Include System Audio", "Records everything the Mac plays, not a single app or tab.") {
                Toggle("", isOn: systemAudio).labelsHidden()
            }
            .disabled(live)
            // A count belongs to the next take, so it stays editable while one is running.
            detailRow(
                "Count Down Before Recording",
                "Shows three, two, one on the display being recorded. Escape abandons the start."
            ) {
                Toggle("", isOn: $model.countdownBeforeRecording).labelsHidden()
            }
            detailRow("Show Camera Preview", "Shows the camera picture above the floating recording controls.") {
                Toggle("", isOn: $model.showCameraPreview).labelsHidden()
            }
            // How the controls look is no part of a take, so it stays editable while one runs.
            detailRow("Controls Glass", "Frosted glass keeps the floating controls easy to read; clear lets what is behind them show through.") {
                Picker("", selection: $model.controlsGlass) {
                    Text("Light").tag(ControlsGlass.light)
                    Text("Dark").tag(ControlsGlass.dark)
                    Text("Clear").tag(ControlsGlass.clear)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .fixedSize()
            }
        } header: {
            Text("Recording")
        } footer: {
            if live {
                Text("The recording in progress keeps the choices it started with.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var shortcutsSection: some View {
        Section {
            shortcutRows(for: .app)
        } header: {
            Text("Shortcuts")
        }
        Section {
            shortcutRows(for: .recording)
        } header: {
            Text("While Recording")
        }
    }

    @ViewBuilder
    private func shortcutRows(for lifetime: ShortcutLifetime) -> some View {
        ForEach(ShortcutBindings.catalog.filter {
            model.shortcuts[$0.action]?.lifetime == lifetime
        }, id: \.action.id) { entry in
            LabeledContent(entry.name) { shortcutValue(entry.action) }
        }
    }

    @ViewBuilder
    private func shortcutValue(_ action: ControlsAction) -> some View {
        let binding = model.shortcuts[action]
        let unavailable = model.state.unavailableShortcuts.contains(action.id)
        let status = binding.map {
            ShortcutPresentation.state(
                for: $0, registered: model.registered.contains(action.id),
                recording: model.state.isLive || model.state.counting,
                unavailable: unavailable,
                duplicate: model.shortcutErrorAction == action)
        } ?? .refusedByMacOS
        HStack(alignment: .center, spacing: 8) {
            if status != .active {
                shortcutStatus(status)
            }
            // The text sizes the field; the AppKit recorder lies over it as an overlay, so its own
            // fitting size never reaches the row's layout and the row stays one line tall.
            Text(model.recordingAction == action
                ? "Type shortcut"
                : binding.map { $0.shortcut.label.map(String.init).joined(separator: "\u{2009}") } ?? "Off")
                .font(.system(size: 13))
                .foregroundStyle(model.recordingAction == action ? .secondary : .primary)
                .lineLimit(1)
                .frame(width: 104, height: 24)
                .overlay {
                    ShortcutRecorderField(
                        recording: model.recordingAction == action,
                        focusChanged: { focused in
                            if focused { model.beginShortcutRecording(action) }
                            else { model.endShortcutRecording(action) }
                        },
                        captured: { shortcut in model.captureShortcut(action, shortcut: shortcut) })
                }
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(
                model.recordingAction == action ? Color.accentColor : status == .active ? Color(nsColor: .separatorColor) : Color.orange,
                lineWidth: model.recordingAction == action ? 2 : 1))
        }
    }

    @ViewBuilder
    private func shortcutStatus(_ status: ShortcutPresentation.State) -> some View {
        switch status {
        case .active:
            EmptyView()
        case .refusedByMacOS, .duplicateInYap:
            Label(ShortcutPresentation.statusTitle(status), systemImage: "exclamationmark.triangle.fill")
                .labelStyle(StatusLabelStyle(tint: .orange, titleTint: .orange))
        }
    }

    private var generalSection: some View {
        Section {
            Toggle("Show this window when Yap starts", isOn: $model.showAtLaunch)
            detailRow("Set up my agents", model.agentSummary) {
                Toggle("", isOn: $model.setUpAgents).labelsHidden()
            }
            detailRow("Open at login", loginItemDescription) {
                Toggle("", isOn: openAtLogin).labelsHidden()
            }
            if let failure = model.loginFailure {
                Text(failure).foregroundStyle(.red)
            }
            // The toggle registers the login item by itself. Only when macOS keeps that decision
            // for a person to confirm, or does not recognise this copy, does anyone need the pane.
            if [.requiresApproval, .notFound].contains(model.loginItem) {
                HStack {
                    Spacer(minLength: 12)
                    Button("Open Login Items Settings…") { SMAppService.openSystemSettingsLoginItems() }
                }
            }
            if model.state.updates.available {
                Toggle("Automatically download and install updates", isOn: Binding(
                    get: { model.state.updates.enabled },
                    set: { model.setAutomaticUpdates($0) }))
                HStack {
                    Spacer()
                    Button("Check for Updates") { model.checkForUpdates() }
                        .disabled(!model.state.updates.canCheck)
                }
                if let status = model.state.updates.status {
                    Text(status).font(.callout).foregroundStyle(.secondary)
                }
            } else {
                Text("Updates are installed manually in this build.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("General")
        } footer: {
            if model.state.updates.available {
                Text(model.state.updates.enabled
                    ? "Installs when recording and background work are idle."
                    : "Automatic updates are off. You can still check and install manually.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var loginItemDescription: String {
        switch model.loginItem {
        case .enabled: "Yap opens when you log in."
        case .requiresApproval: "Waiting for your approval in Login Items settings."
        case .notRegistered: "Yap does not open when you log in."
        case .notFound: "macOS does not recognise this copy of Yap as a login item."
        @unknown default: "macOS reports an unknown login item status."
        }
    }

    private var openAtLogin: Binding<Bool> {
        Binding(
            get: { [.enabled, .requiresApproval].contains(model.loginItem) },
            set: { model.openAtLogin($0) })
    }

    private enum MicrophoneTag: Hashable {
        case off, systemDefault
        case device(String)
    }

    /// The catalog's inputs, plus this person's own choice while it is unplugged — said to be
    /// unplugged, so the picker never looks like it is recording through something that is not
    /// there. Takes use the system default meanwhile, and the choice comes back with the device.
    private var inputs: [(id: String, name: String)] {
        var listed = model.state.sources.microphones.map { (id: $0.id, name: $0.name) }
        for choice in [model.state.selection.microphone, model.state.selection.awaitedMicrophone] {
            guard case .device(let id, let name)? = choice,
                !listed.contains(where: { $0.id == id })
            else { continue }
            listed.append((id: id, name: "\(name) (not connected)"))
        }
        return listed
    }

    private var defaultInputTitle: String {
        model.state.sources.microphones.first(where: \.isDefault)
            .map { "System Default (\($0.name))" } ?? "System Default"
    }

    private var microphone: Binding<MicrophoneTag> {
        Binding(
            get: {
                switch model.state.selection.microphone {
                case .off: .off
                case .systemDefault: .systemDefault
                case .device(let id, _): .device(id)
                }
            },
            set: { tag in
                switch tag {
                case .off: model.perform(.disableMicrophone)
                case .systemDefault: model.perform(.selectMicrophone(nil))
                case .device(let id): model.perform(.selectMicrophone(id))
                }
            })
    }

    private var systemAudio: Binding<Bool> {
        Binding(
            get: { model.state.selection.systemAudio },
            set: { if $0 != model.state.selection.systemAudio { model.perform(.toggleSystemAudio) } })
    }
}

/// A small AppKit responder embedded in the SwiftUI row. It owns event capture and focus only;
/// labels and shortcut state remain in YapControls so Settings and other adapters share them.
private struct ShortcutRecorderField: NSViewRepresentable {
    let recording: Bool
    let focusChanged: (Bool) -> Void
    let captured: (Shortcut) -> Void

    func makeNSView(context: Context) -> ShortcutRecorderNativeView {
        let view = ShortcutRecorderNativeView()
        view.focusChanged = focusChanged
        view.captured = captured
        return view
    }

    func updateNSView(_ view: ShortcutRecorderNativeView, context: Context) {
        view.focusChanged = focusChanged
        view.captured = captured
        if recording, view.window?.firstResponder !== view {
            view.window?.makeFirstResponder(view)
        } else if !recording, view.window?.firstResponder === view {
            view.window?.makeFirstResponder(nil)
        }
    }
}

private final class ShortcutRecorderNativeView: NSView {
    var focusChanged: ((Bool) -> Void)?
    var captured: ((Shortcut) -> Void)?

    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { focusChanged?(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { focusChanged?(false) }
        return resigned
    }

    override func keyDown(with event: NSEvent) {
        // Modifier-only presses do not identify a shortcut. Keep the field focused until a
        // physical key arrives, so a person can chord modifiers in any order.
        guard !ShortcutKeys.isModifier(UInt32(event.keyCode)) else { return }
        var modifiers: UInt32 = 0
        if event.modifierFlags.contains(.control) { modifiers |= UInt32(controlKey) }
        if event.modifierFlags.contains(.option) { modifiers |= UInt32(optionKey) }
        if event.modifierFlags.contains(.shift) { modifiers |= UInt32(shiftKey) }
        if event.modifierFlags.contains(.command) { modifiers |= UInt32(cmdKey) }
        // A key every app types with is not offered; the field keeps listening.
        guard !ShortcutKeys.stealsKey(keyCode: UInt32(event.keyCode), modifiers: modifiers) else {
            NSSound.beep()
            return
        }
        let label = ShortcutKeys.label(
            keyCode: UInt32(event.keyCode), modifiers: modifiers, layout: .current())
        captured?(Shortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, label: label))
    }
}

/// A status word with a tinted symbol, the way System Settings states an access.
private struct StatusLabelStyle: LabelStyle {
    let tint: Color
    var titleTint: Color?

    init(tint: Color, titleTint: Color? = nil) {
        self.tint = tint
        self.titleTint = titleTint
    }

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.foregroundStyle(tint)
            configuration.title.foregroundStyle(titleTint ?? .secondary)
        }
    }
}
