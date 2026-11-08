import Foundation

/// Shared identities for explicit app actions across native views and shortcuts.
public enum ControlsAction: Hashable, Sendable {
    case selectDisplay(Int)
    case selectWindow(Int)
    case selectRegion
    /// A named input, or the person's current system default when no ID is given.
    case selectMicrophone(String?)
    case disableMicrophone
    case toggleSystemAudio
    /// Show or minimize the live camera picture in a take's floating controls. The camera keeps
    /// recording either way.
    case showCameraPreview(Bool)
    /// Turn the companion camera on or off: the start switch before a take, the reserved camera
    /// during one. The menu's switch and the floating controls send this same action.
    case setCamera(Bool)
    case startOrStop
    case dismissFailure
    case retryFailure
    case pastePrompt
    case undoMark
    case pauseOrResume
    case cancel
    case restart
    case playRecording(String)
    case copyRecordingPrompt(String)
    case copyProjectPrompt(String)
    case previewProject(String)
    case exportProject(String, ExportsState.Kind)
    case deleteProject(String)
    case nextProjects
    case previousProjects
    case openLibrary
    case nextRecordings
    case previousRecordings
    case refreshLibrary
    case deleteRecording(String)
    case retryImport(String)
    case playAsset(String)
    case copyAssetPrompt(String)
    case deleteAsset(String)
    /// Send an unconfirmed export request again under its original export ID.
    case resendExport(String)
    case retryExport(String)
    case abandonExport(String)
    case revealExport(String)
    /// Remove a finished export from the Library; its file and service history remain.
    case dismissExport(String)
    case refreshStorage
    case requestScreenPermission
    case requestMicrophonePermission
    case requestCameraPermission
    /// Opens the Accessibility privacy pane; there is no prompt to show.
    case requestAccessibilityPermission
    case openSettings
    case quit

    /// A stable name for this action, so a native control can be addressed by what it does.
    public var id: String {
        switch self {
        case .selectDisplay(let display): "source.display.\(display)"
        case .selectWindow(let window): "source.window.\(window)"
        case .selectRegion: "source.region"
        case .selectMicrophone(let device): "microphone.\(device ?? "default")"
        case .disableMicrophone: "microphone.off"
        case .toggleSystemAudio: "audio.system"
        case .showCameraPreview(let shown): shown ? "camera.preview.show" : "camera.preview.hide"
        case .setCamera(let on): on ? "capture.camera.on" : "capture.camera.off"
        case .startOrStop: "capture.startOrStop"
        case .dismissFailure: "failure.dismiss"
        case .retryFailure: "failure.retry"
        case .pastePrompt: "capture.pastePrompt"
        case .undoMark: "capture.undoMark"
        case .pauseOrResume: "capture.pauseOrResume"
        case .cancel: "capture.cancel"
        case .restart: "capture.restart"
        case .playRecording(let id): "recording.play.\(id)"
        case .copyRecordingPrompt(let id): "recording.copyPrompt.\(id)"
        case .playAsset(let id): "asset.play.\(id)"
        case .copyAssetPrompt(let id): "asset.copyPrompt.\(id)"
        case .deleteAsset(let id): "asset.delete.\(id)"
        case .copyProjectPrompt(let id): "project.copyPrompt.\(id)"
        case .previewProject(let id): "project.preview.\(id)"
        case .exportProject(let id, let kind): "project.export.\(kind.rawValue).\(id)"
        case .deleteProject(let id): "project.delete.\(id)"
        case .nextProjects: "library.projects.next"
        case .previousProjects: "library.projects.previous"
        case .openLibrary: "app.library"
        case .nextRecordings: "library.recordings.next"
        case .previousRecordings: "library.recordings.previous"
        case .refreshLibrary: "library.refresh"
        case .retryImport(let id): "recording.retryImport.\(id)"
        case .deleteRecording(let id): "recording.delete.\(id)"
        case .resendExport(let id): "export.resend.\(id)"
        case .retryExport(let id): "export.jobRetry.\(id)"
        case .abandonExport(let id): "export.abandon.\(id)"
        case .revealExport(let id): "export.reveal.\(id)"
        case .dismissExport(let id): "export.dismiss.\(id)"
        case .refreshStorage: "storage.refresh"
        case .requestScreenPermission: "permission.screen"
        case .requestMicrophonePermission: "permission.microphone"
        case .requestCameraPermission: "permission.camera"
        case .requestAccessibilityPermission: "permission.accessibility"
        case .openSettings: "app.settings"
        case .quit: "app.quit"
        }
    }
}
