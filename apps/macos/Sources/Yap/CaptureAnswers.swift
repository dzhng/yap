import AppKit
import YapControls

/// What the controls read back from the service's `capture.status` and `capture.sources`.
struct StatusAnswer: Decodable {
    struct Device: Decodable {
        let state: String
        let recordingId: String?
        let elapsedUs: Int64?
        let selection: ControlsState.CaptureSelection.Start?
        let camera: ControlsState.CameraStatus?
    }
    let device: Device
    let recording: ControlsState.TakeStatus?
}

struct SourcesAnswer: Decodable {
    struct Display: Decodable {
        let id: Int
        let name: String
        let width: Int
        let height: Int
    }
    struct Window: Decodable {
        let id: Int
        let title: String
        let application: String
    }
    struct Microphone: Decodable {
        let id: String
        let name: String
        let isDefault: Bool
    }
    struct Camera: Decodable {
        let id: String
        let name: String
        let isDefault: Bool?
    }
    let displays: [Display]
    let windows: [Window]
    let microphones: [Microphone]
    let cameras: [Camera]
}

extension SourcesAnswer {
    /// Join capture identities to the window server's geometry and main display.
    @MainActor var catalog: ControlsState.SourceCatalog {
        .init(
            displays: displays.map { source in
                .init(id: source.id, name: source.name, width: source.width, height: source.height,
                      frame: NSScreen.screens.first { $0.captureDisplayID == source.id }?.frame,
                      isDefault: source.id == Int(CGMainDisplayID()))
            },
            windows: windows.map { .init(id: $0.id, title: $0.title, application: $0.application) },
            microphones: microphones.map { .init(id: $0.id, name: $0.name, isDefault: $0.isDefault) },
            cameras: cameras.map { .init(id: $0.id, name: $0.name, isDefault: $0.isDefault ?? false) })
    }
}
