import Foundation
import Darwin
import YapMedia

public struct CaptureRegion: Codable, Sendable {
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
}

public struct CaptureSource: Codable, Sendable {
    public init(
        kind: String, displayID: UInt32? = nil, windowID: UInt32? = nil,
        region: CaptureRegion? = nil, deviceID: String? = nil
    ) {
        self.kind = kind
        self.displayID = displayID
        self.windowID = windowID
        self.region = region
        self.deviceID = deviceID
    }

    public let kind: String
    public let displayID: UInt32?
    public let windowID: UInt32?
    public let region: CaptureRegion?
    public let deviceID: String?
}

public struct CaptureRequest: Codable, Sendable {
    public init(
        source: CaptureSource, outputDirectory: String, sourceId: String? = nil,
        microphone: Bool = false, microphoneDeviceID: String? = nil, systemAudio: Bool = false,
        camera: CaptureCameraRequest? = nil
    ) {
        self.source = source
        self.outputDirectory = outputDirectory
        self.sourceId = sourceId
        self.microphone = microphone
        self.microphoneDeviceID = microphoneDeviceID
        self.systemAudio = systemAudio
        self.camera = camera
    }

    public var source: CaptureSource
    public let outputDirectory: String
    /// The capture-source identity the library allocated for this take, stamped into the journal
    /// so a source directory names the take it belongs to. Absent for a standalone probe run.
    public var sourceId: String?
    public let microphone: Bool
    public let microphoneDeviceID: String?
    public let systemAudio: Bool
    public let camera: CaptureCameraRequest?
}

/// The allocating owner supplies both device identity and the managed source destination.
public struct CaptureCameraRequest: Codable, Sendable {
    public let binding: CameraCaptureBinding
    public let outputDirectory: String
    /// Whether the camera is on when the take starts. Off reserves it without opening the device.
    public let startsOn: Bool
    public init(binding: CameraCaptureBinding, outputDirectory: String, startsOn: Bool = true) {
        self.binding = binding
        self.outputDirectory = outputDirectory
        self.startsOn = startsOn
    }
    private enum Keys: String, CodingKey { case binding, outputDirectory, startsOn }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        binding = try values.decode(CameraCaptureBinding.self, forKey: .binding)
        outputDirectory = try values.decode(String.self, forKey: .outputDirectory)
        startsOn = try values.decodeIfPresent(Bool.self, forKey: .startsOn) ?? true
    }
}

/// One microphone a take can narrate through, as the device layer sees it.
public struct CaptureAudioDevice: Codable, Sendable, Equatable {
    public init(id: String, name: String, isDefault: Bool) {
        self.id = id
        self.name = name
        self.isDefault = isDefault
    }

    public let id: String
    public let name: String
    public let isDefault: Bool
}

/// Camera discovery identifies the system preference without activating a device.
public struct CaptureVideoDevice: Codable, Sendable, Equatable {
    public init(id: String, name: String, isDefault: Bool = false) {
        self.id = id
        self.name = name
        self.isDefault = isDefault
    }
    public let id: String
    public let name: String
    public let isDefault: Bool
}

/// Supplied camera identity; service allocation validation belongs to the capture lifecycle owner.
public struct CameraCaptureBinding: Codable, Sendable, Equatable {
    public let recordingId: String
    public let sourceId: String
    public let deviceId: String
    public init(recordingId: String, sourceId: String, deviceId: String) {
        self.recordingId = recordingId; self.sourceId = sourceId; self.deviceId = deviceId
    }
    package func validate() throws {
        guard [recordingId, sourceId, deviceId].allSatisfy({ !$0.isEmpty && $0.utf16.count <= 256 }) else {
            throw CaptureFailure("INVALID_REQUEST", "Camera binding requires bounded take, source and device identities.")
        }
    }
}

public struct CapturedTrack: Codable, Sendable {
    public let role: String
    public let file: String
    public let firstSampleUs: Int64?
    public let lastSampleEndUs: Int64?
    public let samples: Int
    public let droppedSamples: Int
    public let omittedSamples: Int
    public let heldTailUs: Int64
    public let sampleRate: Double?
    public let channelCount: UInt32?
}

public struct CaptureResult: Codable, Sendable {
    public init(
        state: String, source: CaptureSource, width: Int, height: Int, durationUs: Int64,
        hostOriginUs: Int64?, pauses: [PauseEvent], tracks: [CapturedTrack],
        failure: CaptureFailure?, systemAudioScope: String, cursor: CursorStats = CursorStats(),
        cleanupFailure: CaptureFailure? = nil, camera: CapturedCameraSource? = nil,
        cameraBinding: CameraCaptureBinding? = nil
    ) {
        self.state = state
        self.source = source
        self.width = width
        self.height = height
        self.durationUs = durationUs
        self.hostOriginUs = hostOriginUs
        self.pauses = pauses
        self.tracks = tracks
        self.failure = failure
        self.cleanupFailure = cleanupFailure
        self.systemAudioScope = systemAudioScope
        self.cursor = cursor
        self.camera = camera
        self.cameraBinding = cameraBinding
    }

    public let state: String
    public let source: CaptureSource
    public let width: Int
    public let height: Int
    public let durationUs: Int64
    public let hostOriginUs: Int64?
    public let pauses: [PauseEvent]
    public let tracks: [CapturedTrack]
    public let failure: CaptureFailure?
    public let cleanupFailure: CaptureFailure?
    public let systemAudioScope: String
    public let cursor: CursorStats
    public let camera: CapturedCameraSource?
    public let cameraBinding: CameraCaptureBinding?
}

/// Independent camera media facts; screen/audio tracks keep their original meanings.
public struct CapturedCameraSource: Codable, Sendable {
    public let directory: String
    public let source: CaptureSource
    public let state: String
    public let width: Int
    public let height: Int
    public let durationUs: Int64
    public let hostOriginUs: Int64?
    public let pauses: [PauseEvent]
    public let tracks: [CapturedTrack]
    public let failure: CaptureFailure?
    public let cameraBinding: CameraCaptureBinding?

    package init(directory: String, result: CaptureResult) {
        self.directory = directory; source = result.source; state = result.state
        width = result.width; height = result.height; durationUs = result.durationUs
        hostOriginUs = result.hostOriginUs; pauses = result.pauses
        tracks = result.tracks; failure = result.failure
        cameraBinding = result.cameraBinding
    }
}

// Companion media can fail a take without becoming a screen/audio track.
extension CaptureResult {
    package func withCamera(_ camera: CapturedCameraSource?) -> CaptureResult {
        CaptureResult(state: state, source: source, width: width, height: height,
            durationUs: durationUs, hostOriginUs: hostOriginUs, pauses: pauses, tracks: tracks,
            failure: failure, systemAudioScope: systemAudioScope, cursor: cursor,
            cleanupFailure: cleanupFailure, camera: camera, cameraBinding: cameraBinding).withFailure(camera?.failure)
    }

    package func withFailure(_ other: CaptureFailure?) -> CaptureResult {
        guard failure == nil, let reason = other else { return self }
        return CaptureResult(state: "interrupted", source: source, width: width, height: height,
            durationUs: durationUs, hostOriginUs: hostOriginUs, pauses: pauses, tracks: tracks,
            failure: reason, systemAudioScope: systemAudioScope, cursor: cursor, cleanupFailure: cleanupFailure,
            camera: camera, cameraBinding: cameraBinding)
    }
}
