import Foundation

/// Device identities and available sources shared by capture selection and presentation.
extension ControlsState {
    public struct Display: Equatable, Sendable {
        public init(id: Int, name: String, width: Int, height: Int, frame: CGRect? = nil, isDefault: Bool = false) {
            self.id = id
            self.name = name
            self.width = width
            self.height = height
            self.frame = frame
            self.isDefault = isDefault
        }
        public let id: Int
        public let name: String
        public let width: Int
        public let height: Int
        /// The display's global AppKit frame, when the native app has observed it. Source
        /// discovery supplies identity and dimensions; the app adds this geometry for pointer
        /// routed starts, while controls tests can inject it deterministically.
        public let frame: CGRect?
        /// The system's main display, independent of catalog order or the focused window.
        public let isDefault: Bool
    }

    public struct Window: Equatable, Sendable {
        public init(id: Int, title: String, application: String) {
            self.id = id
            self.title = title
            self.application = application
        }
        public let id: Int
        public let title: String
        public let application: String
        /// What the chooser calls this window: its app, and its title when it has one.
        public var label: String {
            let named = title.trimmingCharacters(in: .whitespaces)
            if application.isEmpty { return named }
            return named.isEmpty ? application : "\(application) — \(named)"
        }
    }

    public struct Microphone: Equatable, Sendable {
        public init(id: String, name: String, isDefault: Bool) {
            self.id = id
            self.name = name
            self.isDefault = isDefault
        }
        public let id: String
        public let name: String
        public let isDefault: Bool
    }

    public struct Camera: Equatable, Sendable {
        public init(id: String, name: String, isDefault: Bool = false) {
            self.id = id
            self.name = name
            self.isDefault = isDefault
        }
        public let id: String
        public let name: String
        public let isDefault: Bool
    }

    public struct SourceCatalog: Equatable, Sendable {
        public init(
            displays: [Display] = [], windows: [Window] = [], microphones: [Microphone] = [], cameras: [Camera] = []
        ) {
            self.displays = displays
            self.windows = windows
            self.microphones = microphones
            self.cameras = cameras
        }
        public var displays: [Display]
        public var windows: [Window]
        public var microphones: [Microphone]
        public var cameras: [Camera]
        public var defaultDisplay: Display? { displays.first(where: \.isDefault) ?? displays.first }
    }

    /// A rectangle of one display, in that display's own points with a top-left origin: the same
    /// coordinates a capture start carries, so nothing converts them a second time.
    public struct Region: Equatable, Sendable {
        public init(displayId: Int, displayName: String, x: Double, y: Double, width: Double, height: Double) {
            self.displayId = displayId
            self.displayName = displayName
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
        public let displayId: Int
        public let displayName: String
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
    }

    public enum SelectedSource: Equatable, Sendable {
        case display(Display)
        case window(Window)
        case region(Region)
        /// Camera mode requires a selected device.
        case camera
    }

    /// These takes are narrated, so a fresh launch has the microphone on and the machine's own
    /// sound off. `.systemDefault` follows whatever the person's default input is at start time.
    public enum MicrophoneChoice: Equatable, Sendable {
        case off
        case systemDefault
        case device(id: String, name: String)
    }
}
