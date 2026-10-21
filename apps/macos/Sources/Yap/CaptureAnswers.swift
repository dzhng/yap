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
