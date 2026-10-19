import AppKit
import ServiceManagement
import Darwin
import YapControls
import YapCapture

/// One line of this app's diagnostics. Everything this app says about itself goes to stderr, in
/// this one form, so a launch's whole story reads in order whichever part of it wrote a line.
func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data("yap: \(message)\n".utf8))
}

/// The part of the service's health answer this app reports on stderr.
private struct ServiceHealth: Decodable {
    let status: String
    let pid: Int
    let node: String
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controls: RecordingControls?
    private var service: ServiceHost?
    private var appSocket: AppSocket?
    private var adminNoticeTimer: Timer?
    /// Counts service starts; state reports from a service that has since been replaced are ignored.
    private var serviceGeneration = 0
    private var controller: CaptureController?
    private var fixture: NSWindow?
    private var probe: ControlsProbe?
    private var selectedProbe: SelectedCaptureProbe?
    private var probeTask: Task<Void, Never>?
    private var startup: Operation?
    private var terminating = false
    private var quitting = false
    private var awaitingFinalization = false
    private var updaterTermination = false
    private var updates: UpdateCoordinator?
    private var sparkle: SparkleDriver?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let environment = ProcessInfo.processInfo.environment
        let arguments = CommandLine.arguments.dropFirst()
        if arguments.first == "--probe" {
            let probe = SelectedCaptureProbe()
            let values = Array(arguments.dropFirst())
            if values.prefix(2).elementsEqual(["selected-devices", "capture"]) { selectedProbe = probe }
            probeTask = Task { await runCaptureProbe(values, selected: probe) }
            return
        }
        guard let inApplications = admitLaunch(Array(arguments)) else { return }
        let preferences = Preferences(defaults: defaultsDomain())
        controls = RecordingControls(
            home: personalRoot(), preferences: preferences, inApplications: inApplications
        ) { [weak self] in
            self?.quit()
        }
        // The capture fixture is an ordinary launch that additionally opens this app's own window
        // and refuses every other source, so the real service and controller path is what runs.
        if environment["YAP_FIXTURE_WINDOW"] == "1" {
            let window = makeCaptureFixtureWindow()
            fixture = window
            diagnostic("capture fixture window=\(window.windowNumber)")
        }
        let controller = CaptureController(fixtureWindow: fixture)
        self.controller = controller
        controls?.excludeOwnWindowsFromTake = { [weak controller] in await controller?.excludeOwnWindows() ?? false }
        controller.onCameraFrame = { [weak self] frame in
            Task { @MainActor [weak self] in self?.controls?.receiveCameraFrame(frame) }
        }
        // Marks arrive in the order they happened and must be drawn in it: a mark is undone only
        // after it was recorded. The main queue keeps that order; separate tasks need not.
        controller.onMarkUpdate = { [weak self] update in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.controls?.receiveMarkUpdate(update) } }
        }
        let updates = UpdateCoordinator(blockers: { [weak self] in
            guard let self else { return ["native.startup"] }
            var blockers = self.controls?.updateBlockers ?? []
            if self.controller?.isCapturing == true { blockers.append("native.capture") }
            return blockers
        }, fence: { [weak self] fenced in self?.controls?.fenceForUpdate(fenced) },
        changed: { [weak self] in self?.refreshUpdateControls() })
        self.updates = updates
        updates.restartService = { [weak self] in self?.restartService() }
        updates.endService = { [weak self] host in self?.endService(host) }
        controls?.updateProgress = { [weak updates] in updates?.progress() }
        controller.updateProgress = { [weak updates, weak controller] in
            PreviewWindow.takeInProgress = controller?.isCapturing ?? false
            updates?.progress()
        }
        sparkle = SparkleDriver(owner: updates, changed: { [weak self] in self?.refreshUpdateControls() }) { [weak self] in
            guard let self, self.updates?.mayTerminateForUpdate == true else { return }
            self.updaterTermination = true
            NSApplication.shared.terminate(nil)
        }
        refreshUpdateControls()
        probe = ControlsProbe.requested(controls: controls)
        startAppSocket()
        startAdminNotices()
        startService(capture: controller)
        // A launch that serves a client request starts the service and nothing else: nobody asked
        // to see this app, so no window of it comes forward.
        if preferences.showSettingsAtLaunch, environment["YAP_SERVICE_LAUNCH"] == nil,
            !arguments.contains("--yap-update-relaunch") {
            controls?.perform(.openSettings)
        }
    }

    /// Decides once, before anything starts, whether this copy runs: an update relaunch always
    /// does; a release outside an Applications folder offers to move itself; a second copy hands
    /// off to the running one. Returns whether the app lives in an Applications folder, or nil when
    /// this copy is quitting instead.
    private func admitLaunch(_ arguments: [String]) -> Bool? {
        let bundle = Bundle.main.bundleURL
        let translocation = Translocation.of(bundle)
        let identifier = Bundle.main.bundleIdentifier ?? "com.dzhng.yap"
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .filter { $0.processIdentifier != getpid() }
            .compactMap { app in app.bundleURL.map { RunningCopy(pid: app.processIdentifier, bundleURL: $0) } }
            // Dev builds share the bundle identifier but run beside an installed Yap.
            .filter { Bundle(url: $0.bundleURL).map(LaunchDecision.isRelease) == true }
        let decision = LaunchDecision.decide(
            bundle: bundle, home: accountHome(), isRelease: LaunchDecision.isRelease(.main),
            arguments: arguments, running: running, translocation: translocation)
        switch decision {
        case .proceed:
            return LaunchDecision.originalLocation(of: bundle, translocation: translocation)
                .map { LaunchDecision.isInApplicationsFolder($0, home: accountHome()) } ?? false
        case .handOff(let copy):
            diagnostic("another copy is running (pid \(copy.pid)); handing off")
            // A menu-bar app has nothing to activate; reopening it is what brings up its Settings.
            NSWorkspace.shared.openApplication(at: copy.bundleURL, configuration: NSWorkspace.OpenConfiguration()) { _, _ in
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
            }
            return nil
        case .offerMove(let original):
            NSApplication.shared.activate()
            if let original, MoveToApplicationsPrompt.show(original: original) == .move {
                let relocator = AppRelocator(effects: .live)
                let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
                do {
                    let installed = try relocator.perform(
                        relocator.plan(original: original, ownVersion: version, home: accountHome()),
                        original: original)
                    diagnostic("moved to \(installed.path); relaunching")
                } catch {
                    diagnostic("move failed: \(error.localizedDescription)")
                    let alert = NSAlert()
                    alert.messageText = "Yap couldn't move itself"
                    alert.informativeText = "Drag Yap into your Applications folder in Finder, then open it again. (\(error.localizedDescription))"
                    alert.runModal()
                }
            } else if original == nil {
                _ = MoveToApplicationsPrompt.show(original: nil)
            }
        }
        NSApplication.shared.terminate(nil)
        return nil
    }

    /// Opening the app again while it runs, from Finder or Spotlight, is how a person asks to see it.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        controls?.perform(.openSettings)
        return false
    }

    private func refreshUpdateControls() {
        guard let updates else { return }
        let message: String?
        if let error = updates.status.error { message = error.message }
        else {
            switch updates.status.state {
            case "checking": message = "Checking for updates…"
            case "downloading": message = "Downloading an update…"
            case "waiting":
                message = updates.status.blockers == ["launcher"]
                    ? "An update is waiting for command-line clients to finish."
                    : "An update is waiting for recording and background work to finish."
            case "installing": message = "Installing an update…"
            default: message = updates.checkMessage
            }
        }
        controls?.configureUpdates(.init(available: updates.available, enabled: updates.enabled, status: message,
                                        canCheck: sparkle?.canCheckForUpdates ?? false), operation: { [weak self] operation, params in
            self?.handleUpdate(operation, params) ?? .failure(ServiceFailure(code: "UPDATE_UNAVAILABLE", message: "No native updater is connected."))
        })
    }

    /// The team's message for this version: the last one saved shows at once, even offline, and a
    /// fresh copy is fetched at launch and hourly. Every failure leaves things as they were. The
    /// saved `notice.json` (`{version, message}`) is what the command line prints from.
    private func startAdminNotices() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let saved = URL(fileURLWithPath: (personalRoot() as NSString).appendingPathComponent("notice.json"))
        if let data = try? Data(contentsOf: saved), data.count <= AdminNotice.maxFeedBytes,
            let cached = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            cached["version"] as? String == version
        {
            controls?.showAdminMessage((cached["message"] as? String).map { String($0.prefix(AdminNotice.maxMessageCharacters)) })
        }
        // Bounds the whole fetch, not just its idle time, so a slow server cannot hold one open.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration)
        let refresh = { [weak self] in
            var request = URLRequest(url: AdminNotice.feed, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            request.setValue("Yap/\(version)", forHTTPHeaderField: "User-Agent")
            session.dataTask(with: request) { data, response, _ in
                guard let data, (response as? HTTPURLResponse)?.statusCode == 200 else { return }
                let message: String?
                switch AdminNotice.lookup(in: data, version: version) {
                case .unreadable: return
                case .none: message = nil
                case .message(let text): message = text
                }
                let record: [String: Any] = ["version": version, "message": message as Any? ?? NSNull()]
                if let encoded = try? JSONSerialization.data(withJSONObject: record) {
                    try? FileManager.default.createDirectory(
                        at: saved.deletingLastPathComponent(), withIntermediateDirectories: true,
                        attributes: [.posixPermissions: 0o700])
                    try? encoded.write(to: saved, options: .atomic)
                }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.controls?.showAdminMessage(message) }
                }
            }.resume()
        }
        refresh()
        adminNoticeTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in refresh() }
    }

    /// The app's own operations, answered on its socket so they work without the service.
    private func startAppSocket() {
        let runtime = (personalRoot() as NSString).appendingPathComponent("run")
        // These operations carry no more than a flag; the bound only stops a runaway caller.
        let socket = AppSocket(path: (runtime as NSString).appendingPathComponent("app.sock"),
                               maxRequestBytes: 64 * 1024) { [weak self] operation, params, answer in
            Task { @MainActor [weak self] in
                answer(self?.handleAppOperation(operation, params)
                    ?? .failure(ServiceFailure(code: "APP_CLOSING", message: "The app is closing.")))
            }
        }
        do {
            try socket.start()
            appSocket = socket
        } catch {
            diagnostic("app socket unavailable code=\(error.code) message=\(error.message)")
        }
    }

    private func handleAppOperation(_ operation: String, _ params: Data) -> Result<Data, ServiceFailure> {
        if operation.hasPrefix("update.") { return handleUpdate(operation, params) }
        if operation.hasPrefix("login.") { return handleLogin(operation, params) }
        if operation.hasPrefix("shortcuts.") {
            guard let controls else {
                return .failure(ServiceFailure(code: "APP_STARTING", message: "The app is still starting.", retryable: true))
            }
            return controls.handleShortcuts(operation, params)
        }
        if operation.hasPrefix("skill.") || operation.hasPrefix("cli.") {
            guard let controls else {
                return .failure(ServiceFailure(code: "APP_STARTING", message: "The app is still starting.", retryable: true))
            }
            return controls.handleHome(operation)
        }
        return .failure(ServiceFailure(code: "UNKNOWN_OPERATION", message: "The app does not answer \(operation)."))
    }

    private func handleUpdate(_ operation: String, _ params: Data) -> Result<Data, ServiceFailure> {
        sparkle?.handle(operation, params)
            ?? .failure(ServiceFailure(code: "UPDATE_UNAVAILABLE", message: "Updates are installed manually in this build."))
    }

    private func handleLogin(_ operation: String, _ params: Data) -> Result<Data, ServiceFailure> {
        let service = SMAppService.mainApp
        if operation == "login.status" {
            let status: String
            switch service.status {
            case .enabled: status = "enabled"
            case .requiresApproval: status = "requiresApproval"
            case .notRegistered: status = "notRegistered"
            case .notFound: status = "notFound"
            @unknown default: status = "unknown"
            }
            return resultJSON(["status": status, "enabled": service.status == .enabled || service.status == .requiresApproval])
        }
        do {
            let object = try JSONSerialization.jsonObject(with: params) as? [String: Any]
            guard let enabled = object?["enabled"] as? Bool else {
                return .failure(ServiceFailure(code: "INVALID_PARAMS", message: "login.setEnabled requires enabled."))
            }
            if enabled { try service.register() } else { try service.unregister() }
            return handleLogin("login.status", Data("{}".utf8))
        } catch {
            return .failure(ServiceFailure(code: "LOGIN_ITEM_FAILED", message: error.localizedDescription))
        }
    }

    private func resultJSON(_ value: [String: Any]) -> Result<Data, ServiceFailure> {
        do { return .success(try JSONSerialization.data(withJSONObject: value)) }
        catch { return .failure(ServiceFailure(code: "LOGIN_ITEM_FAILED", message: error.localizedDescription)) }
    }

    /// Ordinary launch owns the service only. Nothing here starts capture or touches a
    /// permission-gated API, so launching the app prompts for nothing. Resolving the
    /// interpreter runs child processes, so it answers back on the main actor rather
    /// than holding it while a candidate is probed.
    private func startService(capture: CaptureController) {
        serviceGeneration += 1
        let generation = serviceGeneration
        apply(.starting)
        startup = ServiceBundle.resolve { [weak self] result in
            Task { @MainActor in
                guard let self, !self.terminating, self.serviceGeneration == generation else { return }
                switch result {
                case .failure(let failure):
                    self.apply(.unavailable(code: failure.code, message: failure.message))
                case .success(let bundle):
                    let host = ServiceHost(
                        bundle: bundle,
                        onNativeCall: { [weak self] operation, params, answer in
                            Task { @MainActor [weak self] in
                                if operation == "inspect.open" {
                                    guard let controls = self?.controls else {
                                        answer(.failure(ServiceFailure(code: "INSPECT_UNAVAILABLE", message: "The native inspector is not available.")))
                                        return
                                    }
                                    answer(controls.openInspect(params))
                                } else {
                                    answer(await capture.handle(operation, params))
                                }
                            }
                        }, onState: { [weak self] state in
                            Task { @MainActor in
                                guard let self, self.serviceGeneration == generation else { return }
                                self.apply(state)
                            }
                    }, onUpdateProgress: { [weak self] in
                        MainActor.assumeIsolated { self?.updates?.progress() }
                    })
                    self.service = host
                    capture.attach(to: host)
                    self.controls?.attach(to: host)
                    host.start()
                }
            }
        }
    }

    /// The updater's way out of a service it cannot trust: the old process is stopped off the main
    /// actor, within ServiceHost's own escalation deadlines, and a fresh one is started.
    private func restartService() {
        guard let controller, !terminating else { return }
        let old = service
        service = nil
        serviceGeneration += 1
        DispatchQueue.global(qos: .userInitiated).async {
            old?.shutdown()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard !self.terminating else { return }
                    self.startService(capture: controller)
                }
            }
        }
    }

    /// The updater ends a service that cannot take part in an installation. The rest of the app
    /// learns it is gone once its process has exited, so the update never replaces a running one.
    private func endService(_ host: ServiceHost) {
        guard service === host else { return }
        service = nil
        serviceGeneration += 1
        let generation = serviceGeneration
        DispatchQueue.global(qos: .userInitiated).async {
            host.shutdown()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard self.serviceGeneration == generation, self.service == nil else { return }
                    self.apply(.unavailable(code: "SERVICE_ENDED", message: "The service was stopped so an update can install."))
                }
            }
        }
    }

    /// The service's lifetime, told to whoever needs it: the controls, which cannot carry a
    /// capture operation without it, and a running take, which has nothing left to report to.
    /// A failed service is stated in the menu and on stderr; the app stays usable and never
    /// retries in a hidden loop. Process identities and interpreter versions stay in the
    /// stderr diagnostics, out of the menu a person acts on.
    private func apply(_ state: ServiceHost.State) {
        controls?.serviceStateChanged(state)
        switch state {
        case .starting:
            break
        case .ready(let pid, let socketPath):
            if let service { updates?.attach(to: service) }
            diagnostic("service ready pid=\(pid) socket=\(socketPath)")
            // One real control round trip proves the inherited pipe, not just the spawn.
            Task { @MainActor in
                guard let health = try? await service?.call("service.health", as: ServiceHealth.self)
                else { return }
                diagnostic("service health status=\(health.status) pid=\(health.pid) node=v\(health.node)")
            }
        case .unavailable(let code, let message):
            diagnostic("service failed code=\(code) message=\(message)")
            updates?.serviceUnavailable()
            // No library is listening any more, so the take is finished into its own journal and
            // left for the next service to reconcile rather than captured unindexed.
            if let controller, controller.isCapturing {
                Task { @MainActor in await controller.serviceLost() }
            }
        }
    }

    /// Where this person's recordings and settings live. The service owns the same root; this is
    /// only where the controls read a person's own key combinations from.
    private func personalRoot() -> String {
        ProcessInfo.processInfo.environment["YAP_HOME"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".yap")
    }

    /// This app's own defaults. A check names an absolute scratch domain instead, so launching the
    /// bundle under test never reads or writes a person's real preferences. A named domain this
    /// process cannot use is reported rather than quietly replaced by the real one.
    private func defaultsDomain() -> UserDefaults {
        guard let named = ProcessInfo.processInfo.environment["YAP_DEFAULTS"] else {
            return .standard
        }
        guard named.hasPrefix("/"), let scratch = UserDefaults(suiteName: named) else {
            diagnostic("YAP_DEFAULTS must be an absolute path; using this app's own defaults")
            return .standard
        }
        return scratch
    }

    /// The Quit menu item and SIGTERM. A second request while the first is still finalizing asks
    /// for nothing new.
    func quit() {
        guard !quitting else { return }
        quitting = true
        NSApplication.shared.terminate(nil)
    }

    /// Every quit reaches this, including the one the system sends at logout. A running take is
    /// finalized and stored before termination proceeds; one that cannot finalize within the
    /// deadline must not hold the app open, and is reconciled from its own journal on the next
    /// launch. Forced termination keeps the ordinary interrupted path instead.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if updaterTermination { return .terminateNow }
        updates?.ordinaryQuit()
        controls?.closePreview()
        if awaitingFinalization { return .terminateLater }
        if let selectedProbe, let probeTask {
            awaitingFinalization = true
            selectedProbe.requestStop()
            Task { @MainActor in
                await probeTask.value
                proceedWithTermination()
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(10))
                proceedWithTermination()
            }
            return .terminateLater
        }
        guard let controller, controller.isCapturing else { return .terminateNow }
        awaitingFinalization = true
        diagnostic("finalizing the running take before quitting")
        // Finalizing waits on two service reports, each bounded by the call timeout, around the
        // writer's own close.
        let deadline = 2 * (service?.callTimeout ?? 0) + 10
        Task { @MainActor in
            await controller.finalizeBeforeQuit()
            proceedWithTermination()
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(deadline))
            proceedWithTermination()
        }
        return .terminateLater
    }

    private func proceedWithTermination() {
        guard awaitingFinalization else { return }
        awaitingFinalization = false
        NSApplication.shared.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        startup?.cancel()
        // Let the bounded in-flight probe reap its child before this process exits.
        // Cancellation prevents another candidate or a late service launch.
        startup?.waitUntilFinished()
        probe?.stop()
        appSocket?.stop()
        if !updaterTermination { service?.shutdown() }
        fixture?.close()
    }
}

// Writing to a control pipe whose child just died must surface as an error, not as a
// signal that kills the app before it can report the failure.
signal(SIGPIPE, SIG_IGN)

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)

// A menu-bar agent has no window to close, so an orderly quit arrives as a signal. Termination
// starts from the run loop rather than inside this main-queue handler: while a main-queue block is
// still running, the main actor cannot run the finalization a pending termination waits for.
let quit = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
quit.setEventHandler {
    RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { delegate.quit() } }
}
quit.resume()
signal(SIGTERM, SIG_IGN)

application.run()
