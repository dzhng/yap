import Foundation

/// The audio choices a new take starts from. The menu and the Settings window edit the same
/// selection; this is only the part of it that outlives a launch.
public struct RecordingDefaults: Equatable, Sendable {
    public init(microphone: ControlsState.MicrophoneChoice = .systemDefault, systemAudio: Bool = false) {
        self.microphone = microphone
        self.systemAudio = systemAudio
    }
    public var microphone: ControlsState.MicrophoneChoice
    public var systemAudio: Bool
}

/// How the floating recording controls are drawn: the system's frosted Liquid Glass, light or
/// dark, or its clear lens that lets what is behind them show through.
public enum ControlsGlass: String, CaseIterable, Sendable {
    case light
    case dark
    case clear
}

/**
 This app's own preferences, in one defaults domain. Capture state, permissions and login-item
 registration are read from where they live and never copied here.
 */
public struct Preferences {
    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    private let defaults: UserDefaults

    private enum Key {
        static let showSettingsAtLaunch = "showSettingsAtLaunch"
        static let settingsFrame = "settingsFrame"
        static let overlayOrigin = "overlayOrigin"
        static let showCameraPreview = "showCameraPreview"
        static let controlsGlass = "controlsGlass"
        static let countdownBeforeRecording = "countdownBeforeRecording"
        static let microphone = "recording.microphone"
        static let microphoneDeviceId = "recording.microphoneDeviceId"
        static let microphoneDeviceName = "recording.microphoneDeviceName"
        static let systemAudio = "recording.systemAudio"
        static let setUpAgents = "setUpAgents"
        static let telemetryInstallId = "telemetry.installId"
        static let telemetryPingSent = "telemetry.pingSent"
    }

    /// Standard menu-bar apps open their window at every launch until a person turns that off.
    public var showSettingsAtLaunch: Bool {
        get { defaults.object(forKey: Key.showSettingsAtLaunch) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Key.showSettingsAtLaunch) }
    }

    /// Keeps the yap command and the consumer skill installed and current when enabled.
    public var setUpAgents: Bool {
        get { defaults.object(forKey: Key.setUpAgents) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Key.setUpAgents) }
    }

    /// Anonymous install ID for telemetry, generated once on first launch. A random UUID with no
    /// connection to personal data. Used only to count unique installs.
    public var telemetryInstallId: String {
        get {
            if let existing = defaults.string(forKey: Key.telemetryInstallId) { return existing }
            let generated = UUID().uuidString.lowercased()
            defaults.set(generated, forKey: Key.telemetryInstallId)
            return generated
        }
    }

    /// Whether the one-time first-launch ping has been sent.
    public var telemetryPingSent: Bool {
        get { defaults.bool(forKey: Key.telemetryPingSent) }
        nonmutating set { defaults.set(newValue, forKey: Key.telemetryPingSent) }
    }

    /// Where the Settings window was last closed, as AppKit describes a window frame.
    public var settingsFrame: String? {
        get { defaults.string(forKey: Key.settingsFrame) }
        nonmutating set { defaults.set(newValue, forKey: Key.settingsFrame) }
    }

    /// Where the floating recording controls were last left, in the screen points AppKit writes.
    public var overlayOrigin: NSPoint? {
        get { defaults.string(forKey: Key.overlayOrigin).map(NSPointFromString) }
        nonmutating set { defaults.set(newValue.map(NSStringFromPoint), forKey: Key.overlayOrigin) }
    }

    public var showCameraPreview: Bool {
        get { defaults.object(forKey: Key.showCameraPreview) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Key.showCameraPreview) }
    }

    /// Clear by default: the floating controls let what is behind them show through.
    public var controlsGlass: ControlsGlass {
        get { defaults.string(forKey: Key.controlsGlass).flatMap(ControlsGlass.init(rawValue:)) ?? .clear }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Key.controlsGlass) }
    }

    /// Countdown defaults off; the agent can trim the start, and people can opt into a pause.
    public var countdownBeforeRecording: Bool {
        get { defaults.object(forKey: Key.countdownBeforeRecording) as? Bool ?? false }
        nonmutating set { defaults.set(newValue, forKey: Key.countdownBeforeRecording) }
    }

    /// The count a start spends before capture begins: nothing once the preference is off.
    public var countdown: Countdown? {
        Countdown(seconds: countdownBeforeRecording ? Countdown.defaultSeconds : 0)
    }

    public var recording: RecordingDefaults {
        get {
            let microphone: ControlsState.MicrophoneChoice =
                switch defaults.string(forKey: Key.microphone) {
                case "off": .off
                case "device":
                    defaults.string(forKey: Key.microphoneDeviceId).map { id in
                        .device(id: id, name: defaults.string(forKey: Key.microphoneDeviceName) ?? id)
                    } ?? .systemDefault
                default: .systemDefault
                }
            return RecordingDefaults(microphone: microphone, systemAudio: defaults.bool(forKey: Key.systemAudio))
        }
        nonmutating set {
            switch newValue.microphone {
            case .off:
                defaults.set("off", forKey: Key.microphone)
                defaults.removeObject(forKey: Key.microphoneDeviceId)
                defaults.removeObject(forKey: Key.microphoneDeviceName)
            case .systemDefault:
                defaults.set("default", forKey: Key.microphone)
                defaults.removeObject(forKey: Key.microphoneDeviceId)
                defaults.removeObject(forKey: Key.microphoneDeviceName)
            case .device(let id, let name):
                defaults.set("device", forKey: Key.microphone)
                defaults.set(id, forKey: Key.microphoneDeviceId)
                defaults.set(name, forKey: Key.microphoneDeviceName)
            }
            defaults.set(newValue.systemAudio, forKey: Key.systemAudio)
        }
    }
}

extension ControlsState.CaptureSelection {
    /// The audio part of this selection, as a new take's defaults. A microphone that is merely
    /// unplugged is still what this person chose, so it is what is saved.
    public var recordingDefaults: RecordingDefaults {
        RecordingDefaults(microphone: awaitedMicrophone ?? microphone, systemAudio: systemAudio)
    }
}
