import YapControls

/// Presentation requests. Existing operations retain ControlsAction; new source/device intents
/// are admitted by RecordingControls when the production shell binds this view.
enum CaptureViewIntent: Equatable {
    case controls(ControlsAction)
    case chooseSource(CaptureViewInput.Source)
    case camera(String)
    case countdown(Bool)
    case openLibrary
}

extension CaptureViewIntent {
    /// The name a check uses for this choice in the capture menu.
    var id: String {
        switch self {
        case .controls(let action): action.id
        case .chooseSource(let source): "source.\(source.rawValue)"
        case .camera(let id): "camera.\(id)"
        case .countdown(let enabled): "countdown.\(enabled ? "on" : "off")"
        case .openLibrary: ControlsAction.openLibrary.id
        }
    }
}
