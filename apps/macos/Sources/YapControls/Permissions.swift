import Foundation

extension ControlsState {
    public var screenSelectionAuthorized: Bool { permissions?.screen == .granted }

    /// What this app may capture, as native capture reads it. Reading it asks for nothing.
    public struct Permissions: Equatable, Sendable {
        public init(
            screen: Access, microphone: Access, camera: Access = .undetermined,
            accessibility: Access = .denied
        ) {
            self.screen = screen
            self.microphone = microphone
            self.camera = camera
            self.accessibility = accessibility
        }
        public let screen: Access
        public let microphone: Access
        public let camera: Access
        /// Trusted or not: macOS has no prompt for it that this app would show, so anything short
        /// of trusted is changed only in System Settings.
        public let accessibility: Access

        public func access(to kind: PermissionKind) -> Access {
            switch kind {
            case .screen: screen
            case .microphone: microphone
            case .camera: camera
            case .accessibility: accessibility
            }
        }
    }

    public enum Access: Equatable, Sendable {
        case granted
        /// Nobody has answered yet, so asking shows the system's own prompt.
        case undetermined
        /// Asking again prompts for nothing; only System Settings can change it.
        case denied
        /// Allowed in System Settings while the app ran; it takes effect once the app reopens.
        case reopenToUse

        /// AVFoundation's authorization, as native capture names it.
        public init(authorization: String) {
            switch authorization {
            case "authorized": self = .granted
            case "not_determined": self = .undetermined
            default: self = .denied
            }
        }
    }
}

extension PermissionKind {
    /// The access a refused capture start was missing, when that is what refused it. Pressing
    /// Start says a person wants to record, so the app may ask macOS for it then.
    public static func missing(fromStartFailure code: String) -> PermissionKind? {
        switch code {
        case "MICROPHONE_PERMISSION_REQUIRED": .microphone
        case "CAMERA_PERMISSION_REQUIRED": .camera
        case "PERMISSION_REQUIRED": .screen
        default: nil
        }
    }
}

/// One access a person grants this app. The menu and the Settings window describe each the same
/// way, from the same state, so the two surfaces can never disagree about what is missing.
public enum PermissionKind: String, CaseIterable, Sendable {
    case screen
    case microphone
    case camera
    /// Lets the paste shortcut press ⌘V in the front app. Optional: without it the prompt is
    /// copied and the person presses ⌘V, so nothing ever waits on it or asks for it.
    case accessibility

    /// Nothing needs it to record, so no recording control asks for it.
    public var isOptional: Bool { self == .accessibility }

    public var name: String {
        switch self {
        case .screen: "Screen Recording"
        case .microphone: "Microphone"
        case .camera: "Camera"
        case .accessibility: "Accessibility"
        }
    }

    /// Why a person would grant it.
    public var purpose: String {
        switch self {
        case .screen: "Needed to record your screen."
        case .microphone: "Needed to record narration."
        case .camera: "Needed to record your selected camera."
        case .accessibility: "Lets Paste Prompt paste for you; without it, it copies."
        }
    }

    public var action: ControlsAction {
        switch self {
        case .screen: .requestScreenPermission
        case .microphone: .requestMicrophonePermission
        case .camera: .requestCameraPermission
        case .accessibility: .requestAccessibilityPermission
        }
    }

    /// The disabled line a menu shows while access is missing.
    public var missingLine: String {
        switch self {
        case .screen: "Screen recording access is not granted."
        case .microphone: "Microphone access is not granted."
        case .camera: "Camera access is not granted."
        case .accessibility: "Accessibility access is not granted."
        }
    }

    /// The privacy pane that changes this access once a person has answered the prompt.
    public var settingsURL: URL {
        switch self {
        case .screen:
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
        case .microphone:
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!
        case .camera:
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")!
        case .accessibility:
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        }
    }

    /// What the grant button says. A prompt that was already answered cannot be shown again, so
    /// the button says where the change happens instead of promising a prompt.
    public func allowTitle(for access: ControlsState.Access) -> String {
        switch access {
        case .denied: "Allow in System Settings…"
        case .undetermined, .granted, .reopenToUse:
            switch self {
            case .screen: "Allow Screen Recording…"
            case .microphone: "Allow Microphone Access…"
            case .camera: "Allow Camera Access…"
            case .accessibility: "Allow Accessibility…"
            }
        }
    }

    public func statusTitle(for access: ControlsState.Access) -> String {
        if isOptional, access != .granted, access != .reopenToUse { return "Optional" }
        return switch access {
        case .granted: "Allowed"
        case .reopenToUse: "Reopen Yap to finish"
        case .undetermined: "Not allowed yet"
        case .denied: "Not allowed"
        }
    }
}
