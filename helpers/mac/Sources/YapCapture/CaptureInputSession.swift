@preconcurrency import AVFoundation
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

/// How a reserved companion camera ended: never turned on, or closed with whatever it recorded.
package enum CameraClosure {
    case notTurnedOn
    case closed(ClosedCameraSource)

    var source: ClosedCameraSource? {
        if case .closed(let source) = self { return source }
        return nil
    }
}

package struct CaptureInputClosure {
    package var camera: CameraClosure? = nil
    package var failure: CaptureFailure? = nil
    package init(camera: CameraClosure? = nil, failure: CaptureFailure? = nil) {
        self.camera = camera; self.failure = failure
    }
}

/// A take's reserved companion camera, turned on and off while the take runs. Turning it on opens
/// the device; turning it off releases it. Calls are serialized, and setting the current state
/// changes nothing.
@MainActor
package protocol CompanionCameraSwitch: AnyObject {
    var deviceId: String { get }
    var isOn: Bool { get }
    func setOn(_ on: Bool) async throws
}

/// Acquires inputs; NativeCapture orders physical drain and optional companion-media closure.
@MainActor
package protocol CaptureInputSession: AnyObject {
    var width: Int { get }
    var height: Int { get }
    var requestedSourceRect: CGRect? { get }
    /// The reserved companion camera, if this take has one.
    var companionCamera: (any CompanionCameraSwitch)? { get }
    var previewFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)? { get set }
    func start(writer: CaptureWriter, output: any SCStreamOutput, framesPerSecond: Int?, onFailure: @escaping @Sendable (CaptureFailure) -> Void,
        checkInterruption: @escaping @MainActor () throws -> Void) async throws
    func startCursorSampling(writer: CaptureWriter)
    func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void)
    func stop() async -> CaptureFailure?
    func closeMedia(clock: CaptureClock, failure: CaptureFailure?) async -> CaptureInputClosure
    func discardMedia() async
}

extension CaptureInputSession {
    package var companionCamera: (any CompanionCameraSwitch)? { nil }
    package func closeMedia(clock: CaptureClock, failure: CaptureFailure?) async -> CaptureInputClosure { CaptureInputClosure() }
    package func discardMedia() async {}
}

@MainActor
package final class ScreenCaptureInput: CaptureInputSession {
    package let width: Int
    package let height: Int
    package let requestedSourceRect: CGRect?
    package var previewFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)?
    private let request: CaptureRequest
    private let content: SCShareableContent
    private let filter: SCContentFilter
    /// The display a display or region take records; a window take records only its window.
    private let display: SCDisplay?
    private var video: SCStream?
    private let crop: CGRect?
    private let microphone: AVCaptureDevice?
    private let acquisition = CaptureStreamInputs()
    private var delegate: CaptureStreamDelegate?
    private var microphoneObserver: NSObjectProtocol?

    private init(request: CaptureRequest, content: SCShareableContent, filter: SCContentFilter, display: SCDisplay?,
        crop: CGRect?, microphone: AVCaptureDevice?, width: Int, height: Int, requestedSourceRect: CGRect?) {
        self.display = display
        self.request = request
        self.content = content
        self.filter = filter
        self.crop = crop
        self.microphone = microphone
        self.width = width
        self.height = height
        self.requestedSourceRect = requestedSourceRect
    }

    package static func requireAuthorization(_ request: CaptureRequest) throws {
        guard NativeCapture.screenPermission else {
            throw CaptureFailure(
                "PERMISSION_REQUIRED",
                "Allow Yap in System Settings > Privacy & Security > Screen & System Audio Recording, then relaunch. No permission was requested automatically."
            )
        }
        if request.microphone {
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                throw CaptureFailure(
                    "MICROPHONE_PERMISSION_REQUIRED",
                    "Microphone access is not authorized. Enable it explicitly before recording narration."
                )
            }
        }
    }

    package static func prepare(_ request: CaptureRequest) async throws -> ScreenCaptureInput {
        try requireAuthorization(request)
        let microphone: AVCaptureDevice?
        if request.microphone {
            let devices = NativeCapture.microphoneCandidates()
            microphone =
                request.microphoneDeviceID.flatMap { id in devices.first { $0.uniqueID == id } }
                ?? (request.microphoneDeviceID == nil ? AVCaptureDevice.default(for: .audio) : nil)
            guard microphone != nil else {
                throw CaptureFailure(
                    "SOURCE_UNAVAILABLE", "The selected microphone is unavailable.")
            }
        } else {
            microphone = nil
        }
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        var recordedDisplay: SCDisplay?
        var crop: CGRect?
        // Where the request fixed its content onscreen, in global display points. A window has no
        // such rect: only the stream reports where the window is while it is being captured.
        var requestedSourceRect: CGRect?
        switch request.source.kind {
        case "window":
            guard
                let window = content.windows.first(where: { $0.windowID == request.source.windowID }
                )
            else {
                throw CaptureFailure("SOURCE_UNAVAILABLE", "The selected window is unavailable.")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
        case "display", "region":
            guard
                let display = content.displays.first(where: {
                    $0.displayID == request.source.displayID
                })
            else {
                throw CaptureFailure("SOURCE_UNAVAILABLE", "The selected display is unavailable.")
            }
            filter = CaptureExclusion.displayFilter(display, in: content)
            recordedDisplay = display
            requestedSourceRect = CGDisplayBounds(display.displayID)
            if request.source.kind == "region" {
                guard let region = request.source.region else {
                    throw CaptureFailure(
                        "INVALID_REQUEST",
                        "Region capture requires display-local point coordinates.")
                }
                let rect = CGRect(
                    x: region.x, y: region.y, width: region.width, height: region.height)
                let bounds = CGRect(origin: .zero, size: filter.contentRect.size)
                guard [region.x, region.y, region.width, region.height].allSatisfy(\.isFinite),
                    region.width > 0, region.height > 0, bounds.contains(rect)
                else {
                    throw CaptureFailure(
                        "INVALID_REQUEST",
                        "Region must be a nonempty rectangle inside the selected display.")
                }
                crop = rect
                requestedSourceRect = CGRect(
                    x: CGDisplayBounds(display.displayID).minX + rect.minX,
                    y: CGDisplayBounds(display.displayID).minY + rect.minY, width: rect.width,
                    height: rect.height)
            }
        default:
            throw CaptureFailure(
                "INVALID_REQUEST", "Source kind must be display, window, or region.")
        }
        let size = (crop ?? filter.contentRect).size
        let pixels = CGSize(
            width: size.width * CGFloat(filter.pointPixelScale),
            height: size.height * CGFloat(filter.pointPixelScale))
        let scale = min(1, 4096 / max(pixels.width, pixels.height))
        let width = max(2, Int(pixels.width * scale) / 2 * 2)
        let height = max(2, Int(pixels.height * scale) / 2 * 2)
        return ScreenCaptureInput(request: request, content: content, filter: filter, display: recordedDisplay,
            crop: crop, microphone: microphone, width: width, height: height,
            requestedSourceRect: requestedSourceRect)
    }

    package func start(writer: CaptureWriter, output: any SCStreamOutput, framesPerSecond: Int?, onFailure: @escaping @Sendable (CaptureFailure) -> Void,
        checkInterruption: @escaping @MainActor () throws -> Void) async throws {
        let delegate = CaptureStreamDelegate(onFailure: onFailure)
        self.delegate = delegate
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(framesPerSecond ?? 30))
        config.queueDepth = 3
        // The pointer is part of the screen demonstration. Cursor geometry is also sampled as
        // evidence, but the captured frames must show the pointer itself during playback.
        config.showsCursor = true
        config.showMouseClicks = false
        config.captureDynamicRange = .SDR
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB
        config.preservesAspectRatio = true
        config.ignoreShadowsSingleWindow = true
        config.shouldBeOpaque = true
        if let crop { config.sourceRect = crop }
        config.captureMicrophone = request.microphone
        config.microphoneCaptureDeviceID = microphone?.uniqueID
        let video = SCStream(filter: filter, configuration: config, delegate: delegate)
        self.video = video
        try video.addStreamOutput(output, type: .screen, sampleHandlerQueue: writer.queue)
        if request.microphone {
            try video.addStreamOutput(output, type: .microphone, sampleHandlerQueue: writer.queue)
        }
        var prepared = [video]
        if request.systemAudio {
            let audio = try WholeSystemAudioCapture.stream(content: content, output: output, queue: writer.queue, delegate: delegate)
            prepared.append(audio)
        }
        do {
            try await acquisition.start(prepared.map { stream in
                CaptureStreamOperation(start: { try await stream.startCapture() }, stop: { try await stream.stopCapture() })
            }, checkInterruption: checkInterruption)
        } catch {
            throw (error as? CaptureFailure)
                ?? CaptureFailure("NATIVE_CAPTURE_FAILED", error.localizedDescription)
        }
    }

    package func startCursorSampling(writer: CaptureWriter) { writer.startCursorSampling() }

    package func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void) {
        if let microphone {
            let deviceID = microphone.uniqueID
            microphoneObserver = NotificationCenter.default.addObserver(
                forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: .main
            ) { notification in
                guard (notification.object as? AVCaptureDevice)?.uniqueID == deviceID else {
                    return
                }
                onFailure(CaptureFailure("SOURCE_LOST", "The selected microphone disconnected."))
            }
        }
    }

    package func stop() async -> CaptureFailure? {
        if let microphoneObserver { NotificationCenter.default.removeObserver(microphoneObserver) }
        microphoneObserver = nil
        let failure = await acquisition.stop().value
        delegate = nil
        return failure
    }
}

final class CaptureStreamDelegate: NSObject, SCStreamDelegate, @unchecked Sendable {
    private let onFailure: @Sendable (CaptureFailure) -> Void

    init(onFailure: @escaping @Sendable (CaptureFailure) -> Void) {
        self.onFailure = onFailure
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onFailure(CaptureFailure("SOURCE_LOST", error.localizedDescription))
    }
}

/// One whole-display audio-only stream contract shared by screen and camera-primary acquisition.
@MainActor
enum WholeSystemAudioCapture {
    static func stream(content: SCShareableContent, output: any SCStreamOutput, queue: DispatchQueue,
        delegate: CaptureStreamDelegate) throws -> SCStream {
        guard let display = content.displays.first else {
            throw CaptureFailure("SOURCE_UNAVAILABLE", "No display is available for whole-system audio capture.")
        }
        let config = SCStreamConfiguration()
        config.width = 2; config.height = 2
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000; config.channelCount = 2
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []),
            configuration: config, delegate: delegate)
        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)
        return stream
    }
}
