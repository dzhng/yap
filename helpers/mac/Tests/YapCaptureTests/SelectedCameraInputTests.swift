@preconcurrency import AVFoundation
import CoreGraphics
import Foundation
import CryptoKit
@preconcurrency import ScreenCaptureKit
import YapCapture
import YapMedia

@MainActor
func runSelectedCameraInputTests(output: String? = nil) async throws {
    let root = output.map { URL(fileURLWithPath: $0) } ?? RecoveryFixture.directory("selected-camera-input")
    if output != nil { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false) }
    defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
    let screenSource = root.appendingPathComponent("screen-input.mov")
    let cameraSource = root.appendingPathComponent("camera-input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: screenSource,
        timesUs: [0, 100000, 200000, 500000, 700000], endUs: 800000)
    try await RecoveryFixture.writeVariableDurationVideo(to: cameraSource,
        timesUs: [0, 100000, 200000], endUs: 300000)
    let audioFolder = try captureMaterializerFixture(in: root, name: "audio-input", accepted: 96000)
    for mode in ["selected", "both-audio"] {
        let folder = root.appendingPathComponent(mode)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let screen = PrerecordedCaptureInput(source: screenSource)
        screen.cursorFixture = true
        if mode == "both-audio" { screen.audio = audioFolder.appendingPathComponent("narration.packed.mov"); screen.audioRoles = [.microphone, .audio] }
        let wrong = FixtureCameraDevice("other", session: FixtureCameraSession(source: screenSource, origin: { screen.fixtureOrigin! }))
        let chosen = FixtureCameraDevice("chosen", session: FixtureCameraSession(source: cameraSource, origin: { screen.fixtureOrigin! }))
        var preparation = CaptureInputPreparation()
        preparation.requireScreenAuthorization = { _ in }
        preparation.prepareScreen = { _ in screen }
        preparation.cameraAuthorized = { true }
        preparation.cameras = { [wrong, chosen] }
        let capture = NativeCapture(prepareInput: { [preparation] request, check in
            try await preparation.prepare(request, camera: CaptureCameraSelection(id: "chosen",
                directory: folder.appendingPathComponent("camera"), observations: folder.appendingPathComponent("timestamps.jsonl")), checkInterruption: check)
        })
        try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.appendingPathComponent("screen").path, microphone: mode == "both-audio", systemAudio: mode == "both-audio"))
        let result = try await capture.stop()
        precondition(result.state == "complete" && result.failure == nil, "Requested routed capture must complete: \(String(describing: result.failure))")
        precondition(result.camera?.state == "complete" && result.camera?.failure == nil)
        precondition(result.camera?.tracks.first?.firstSampleUs == 200000)
        precondition(result.camera?.tracks.first?.samples == 3)
        precondition(result.cursor.sampled == 1 && screen.cursorSamplingStarts == 1, "Ordinary selected input must forward cursor sampling")
        precondition(wrong.opens == 0 && wrong.session.starts == 0 && chosen.opens == 1 && chosen.session.starts == 1 && chosen.session.stops == 1)
        let cameraTimes = await RecoveryFixture.decodedPresentationMicroseconds(of: folder.appendingPathComponent("camera/video.mov"))
        precondition(cameraTimes.filter { $0 >= 200000 } == [200000, 300000, 400000], "The exact selected fixture must survive independent publication")
        var cursorSamples: [CursorSample] = []
        let screenJournal = try CaptureJournal.readEvidence(directory: folder.appendingPathComponent("screen").path,
            maximumBytes: nil, retainTiming: true, geometry: { _ in }, samples: { cursorSamples.append(contentsOf: $0) }, displaySpace: { _ in }, layout: 3)
        precondition(screenJournal.finished && cursorSamples.count == 1)
        let cursor = cursorSamples[0]
        precondition(cursor.sourceUs == 150000 && cursor.globalX == 50 && cursor.globalY == 40 && cursor.buttons == 0)
        if mode == "both-audio" {
            var hash = SHA256(); hash.update(data: Data("yap.capture-pcm.v1\0".utf8))
            for value in [screen.expectedRate, screen.expectedChannels] {
                var little = value.littleEndian
                hash.update(data: withUnsafeBytes(of: &little) { Data($0) })
            }
            hash.update(data: screen.expectedPCM)
            let expected = hash.finalize().map { String(format: "%02x", $0) }.joined()
            var receipts: [CaptureAudioPublication.Receipt] = []
            for role in ["narration", "system"] {
                let receipt = try JSONDecoder().decode(CaptureAudioPublication.Receipt.self,
                    from: Data(contentsOf: folder.appendingPathComponent("screen/\(role).publication.json")))
                precondition(receipt.pcmSHA256 == expected && receipt.acceptedFrames == receipt.representedFrames)
                receipts.append(receipt)
            }
            precondition(receipts[0].supportSHA256 == receipts[1].supportSHA256)
            let rows = try String(contentsOf: folder.appendingPathComponent("timestamps.jsonl"), encoding: .utf8)
                .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
            precondition(!rows.isEmpty && rows.allSatisfy { $0["role"] as? String == "camera" },
                "The camera's mapping logs camera callbacks only, not the screen, microphone or system audio")
        }
        try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("native-result.json"))
        print("PASS \(mode): exact selected camera, independent native timing, cursor and requested audio routing")
    }
    try await verifyCameraAcquisition(root: root, source: screenSource)
    try await verifyDiscardedStartup(root: root, screenSource: screenSource, cameraSource: cameraSource)
    try await verifySelectedLifecycle(root: root, screenSource: screenSource, cameraSource: cameraSource)
    try await verifyDiscardedPreparation(root: root, screenSource: screenSource, cameraSource: cameraSource)
    try await verifyWriterRefusal(root: root, screenSource: screenSource, cameraSource: cameraSource)
    try await verifyCameraSwitch(root: root, screenSource: screenSource, cameraSource: cameraSource,
        audio: audioFolder.appendingPathComponent("narration.packed.mov"))
    try await runCaptureStreamInputTests(root: root)

}


@MainActor
private func verifyCameraAcquisition(root: URL, source: URL) async throws {
    for mode in ["omitted", "denied", "screen-denied", "absent", "disappeared", "empty-selection"] {
        let folder = root.appendingPathComponent(mode)
        let screen = PrerecordedCaptureInput(source: source)
        let device = FixtureCameraDevice("selected", session: FixtureCameraSession(source: source, origin: { screen.fixtureOrigin! }))
        device.unavailable = mode == "disappeared"
        var cameraChecks = 0, discoveries = 0, screenPreparations = 0
        var preparation = CaptureInputPreparation()
        preparation.requireScreenAuthorization = { _ in
            if mode == "screen-denied" { throw CaptureFailure("PERMISSION_REQUIRED", "Fixture screen permission denied") }
        }
        preparation.prepareScreen = { _ in screenPreparations += 1; return screen }
        preparation.cameraAuthorized = { cameraChecks += 1; return mode != "denied" }
        preparation.cameras = { discoveries += 1; return mode == "absent" ? [] : [device] }
        let capture = NativeCapture(prepareInput: { [preparation] request, check in
            try await preparation.prepare(request, camera: mode == "omitted" ? nil : CaptureCameraSelection(
                id: mode == "empty-selection" ? "" : "selected", directory: folder.appendingPathComponent("camera"),
                observations: folder.appendingPathComponent("timestamps.jsonl")), checkInterruption: check)
        })
        let request = CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.path, microphone: false, systemAudio: false)
        if mode == "omitted" {
            try await capture.start(request)
            let result = try await capture.stop()
            precondition(result.state == "complete" && result.camera == nil && cameraChecks == 0 && discoveries == 0 && device.opens == 0)
            try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("native-result.json"))
        } else {
            do { try await capture.start(request); preconditionFailure("Camera preparation must refuse \(mode)") }
            catch let error as CaptureFailure {
                let expected = mode == "denied" ? "CAMERA_PERMISSION_REQUIRED" : mode == "screen-denied" ? "PERMISSION_REQUIRED" : mode == "empty-selection" ? "INVALID_REQUEST" : "SOURCE_UNAVAILABLE"
                precondition(error.code == expected && capture.deviceState == "idle")
                precondition(!FileManager.default.fileExists(atPath: folder.path), "Refused preparation must create no recording output")
                let evidence = ["code": error.code, "cameraChecks": cameraChecks, "discoveries": discoveries,
                    "screenPreparations": screenPreparations, "openedSelectedDevices": device.opens,
                    "physicalStarts": device.session.starts, "physicalStops": device.session.stops] as [String: Any]
                try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys])
                    .write(to: root.appendingPathComponent("\(mode).json"))
            }
            precondition(device.session.starts == 0 && device.session.stops == 0)
            if ["denied", "screen-denied", "empty-selection"].contains(mode) { precondition(discoveries == 0 && device.opens == 0 && screenPreparations == 0) }
            if mode == "absent" { precondition(discoveries == 1 && device.opens == 0 && screenPreparations == 0) }
            if mode == "disappeared" { precondition(discoveries == 1 && device.opens == 1 && screenPreparations == 1) }
        }
        print("PASS camera acquisition \(mode): exact refusal/no fallback and no unauthorized or unselected IO")
    }
}


@MainActor
private func fixturePreparation(screen: PrerecordedCaptureInput, session: FixtureCameraSession) -> CaptureInputPreparation {
    let device = FixtureCameraDevice("chosen", session: session)
    var preparation = CaptureInputPreparation()
    preparation.requireScreenAuthorization = { _ in }
    preparation.prepareScreen = { _ in screen }
    preparation.cameraAuthorized = { true }
    preparation.cameras = { [device] }
    return preparation
}

@MainActor
private func verifyDiscardedStartup(root: URL, screenSource: URL, cameraSource: URL) async throws {
    let oldFolder = root.appendingPathComponent("discarded-startup")
    let newFolder = root.appendingPathComponent("after-discarded-startup")
    for folder in [oldFolder, newFolder] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false) }
    let oldScreen = PrerecordedCaptureInput(source: screenSource)
    let newScreen = PrerecordedCaptureInput(source: screenSource)
    newScreen.cursorFixture = true
    let oldCamera = FixtureCameraSession(source: cameraSource, origin: { oldScreen.fixtureOrigin! })
    let newCamera = FixtureCameraSession(source: cameraSource, origin: { newScreen.fixtureOrigin! })
    oldCamera.holdStart = true
    var inputs = [(oldScreen, oldCamera, oldFolder), (newScreen, newCamera, newFolder)]
    let capture = NativeCapture(prepareInput: { request, check in
        let (screen, camera, folder) = inputs.removeFirst()
        return try await fixturePreparation(screen: screen, session: camera).prepare(request,
            camera: CaptureCameraSelection(id: "chosen", directory: folder.appendingPathComponent("camera"),
                observations: folder.appendingPathComponent("timestamps.jsonl")), checkInterruption: check)
    })
    func request(_ folder: URL) -> CaptureRequest {
        CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.appendingPathComponent("screen").path, microphone: false, systemAudio: false)
    }
    let oldStartup = Task { try await capture.start(request(oldFolder)) }
    await oldCamera.startEntered.wait()
    do { _ = try await capture.stop(); preconditionFailure("Startup is not ready for publication") }
    catch let error as CaptureFailure { precondition(error.code == "INVALID_STATE") }
    await capture.discard()
    precondition(oldCamera.stops == 1 && oldScreen.stops == 1 && capture.deviceState == "idle")
    try await capture.start(request(newFolder))
    oldCamera.onFailure?(CaptureFailure("STALE_CAMERA", "Discarded device callback"))
    oldCamera.releaseStart.release()
    do { try await oldStartup.value; preconditionFailure("Discarded startup must not become recording") }
    catch let error as CaptureFailure { precondition(error.code == "NATIVE_CAPTURE_FAILED") }
    precondition(capture.deviceState == "recording" && oldCamera.stops == 1 && oldScreen.stops == 1)
    let result = try await capture.stop()
    precondition(result.state == "complete" && result.failure == nil && result.camera?.state == "complete" && result.camera?.tracks.first?.samples == 3)
    precondition(result.cursor.sampled == 1 && newCamera.stops == 1 && newScreen.stops == 1)
    precondition(!FileManager.default.fileExists(atPath: oldFolder.appendingPathComponent("camera/capture-result.json").path))
    try JSONEncoder().encode(result).write(to: newFolder.appendingPathComponent("native-result.json"))
    try JSONSerialization.data(withJSONObject: ["oldInputStops": oldScreen.stops, "oldCameraStops": oldCamera.stops,
        "newInputStops": newScreen.stops, "newCameraStops": newCamera.stops, "state": capture.deviceState], options: [.sortedKeys])
        .write(to: oldFolder.appendingPathComponent("drain-counts.json"))
    print("PASS discarded startup is fenced across await/rollback; stale callback cannot clear or cancel a newer take; physical drain once")
}


@MainActor
private func verifySelectedLifecycle(root: URL, screenSource: URL, cameraSource: URL) async throws {
    for mode in ["screen-start-failure", "camera-start-failure", "interrupted", "pause-resume", "cancel-retry", "discard", "concurrent", "no-camera", "probe-stopped-start"] {
        let folder = root.appendingPathComponent(mode)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let screen = PrerecordedCaptureInput(source: screenSource, refusesAfterDelivery: mode == "screen-start-failure")
        screen.cursorFixture = true
        screen.holdStop = ["cancel-retry", "concurrent"].contains(mode)
        let camera = FixtureCameraSession(source: cameraSource, origin: { screen.fixtureOrigin! })
        camera.deliverFrames = mode != "no-camera"
        if mode == "camera-start-failure" { camera.failureAfterDelivery = CaptureFailure("INPUT_START_FAILED", "Fixture camera startup failed") }
        let preparation = fixturePreparation(screen: screen, session: camera)
        let capture = NativeCapture(prepareInput: { request, check in
            try await preparation.prepare(request, camera: CaptureCameraSelection(id: "chosen",
                directory: folder.appendingPathComponent("camera"), observations: folder.appendingPathComponent("timestamps.jsonl")),
                measurement: mode == "probe-stopped-start" ? CameraCaptureMeasurement(framesPerSecond: 24,
                    samplesCursor: false, beforeStart: { false }) : .init(), checkInterruption: check)
        })
        let request = CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.appendingPathComponent("screen").path, microphone: false, systemAudio: false)
        if mode.hasSuffix("start-failure") {
            do { try await capture.start(request); preconditionFailure("Partial startup must refuse") }
            catch let error as CaptureFailure { precondition(error.code == "INPUT_START_FAILED") }
            precondition(capture.deviceState == "idle" && capture.outputSize == nil && screen.stops == 1 && camera.stops == 1)
            precondition(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("camera/capture-result.json").path))
            try JSONSerialization.data(withJSONObject: ["failure": "INPUT_START_FAILED", "inputStops": screen.stops, "cameraStops": camera.stops], options: [.sortedKeys])
                .write(to: folder.appendingPathComponent("drain-counts.json"))
            print("PASS \(mode): startup rollback drains once and publishes no completed camera")
            continue
        }
        try await capture.start(request)
        if mode == "discard" {
            await capture.discard(); await capture.discard()
            precondition(screen.stops == 1 && camera.stops == 1 && capture.deviceState == "idle")
            precondition(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("camera/capture-result.json").path))
            do { _ = try await capture.stop(); preconditionFailure("Discarded capture must refuse stop") }
            catch let error as CaptureFailure { precondition(error.code == "INVALID_STATE") }
            try JSONSerialization.data(withJSONObject: ["inputStops": screen.stops, "cameraStops": camera.stops, "state": capture.deviceState], options: [.sortedKeys])
                .write(to: folder.appendingPathComponent("drain-counts.json"))
            print("PASS discard: both physical inputs drain once; no camera publication")
            continue
        }
        if mode == "interrupted" {
            let interrupted = InputGate()
            capture.onInterruption = { _ in interrupted.release() }
            camera.onFailure?(CaptureFailure("SOURCE_LOST", "Fixture selected camera interrupted"))
            await interrupted.wait()
        }
        var resumedHost: Int64?
        if mode == "pause-resume" {
            try capture.pause()
            try camera.offer(at: CaptureHostTime.nowUs())
            try await Task.sleep(for: .milliseconds(20))
            try capture.resume()
            resumedHost = CaptureHostTime.nowUs()
            try camera.offer(at: resumedHost!)
        }
        let result: CaptureResult
        if screen.holdStop {
            let first = Task { try await capture.stop() }
            await screen.stopEntered.wait()
            if mode == "cancel-retry" {
                capture.cancelPublication(); screen.releaseStop.release()
                do { _ = try await first.value; preconditionFailure("Publication must observe cancellation") }
                catch is CancellationError {}
                let raw = try Data(contentsOf: folder.appendingPathComponent("camera/camera.raw.mov"))
                do { _ = try CaptureJournalLease(directory: folder.appendingPathComponent("camera").path); preconditionFailure("Closed snapshot must retain its lease") }
                catch let error as CaptureFailure { precondition(error.code == "CAPTURE_BUSY") }
                result = try await capture.stop()
                let retained = try Data(contentsOf: folder.appendingPathComponent("camera/camera.raw.mov"))
                precondition(raw == retained, "Retry must not refinish camera encoding")
            } else {
                let second = Task { try await capture.stop() }
                let discard = Task { await capture.discard() }
                await Task.yield()
                screen.releaseStop.release()
                result = try await first.value
                let joined = try await second.value
                await discard.value
                precondition(joined.hostOriginUs == result.hostOriginUs && joined.durationUs == result.durationUs && joined.camera?.durationUs == result.camera?.durationUs)
            }
        } else { result = try await capture.stop() }
        precondition(screen.stops == 1 && camera.stops == 1 && capture.deviceState == "idle")
        if ["no-camera", "probe-stopped-start"].contains(mode) {
            precondition(result.state == "interrupted" && result.failure?.code == "NO_CAMERA" && result.camera?.failure?.code == "NO_CAMERA" && result.camera?.tracks.isEmpty == true)
            if mode == "probe-stopped-start" { precondition(camera.starts == 0 && result.cursor.sampled == 0 && screen.cursorSamplingStarts == 0) }
        } else {
            precondition(result.camera?.tracks.first?.samples == (mode == "pause-resume" ? 4 : 3))
            precondition(result.state == (mode == "interrupted" ? "interrupted" : "complete"))
            precondition(result.failure?.code == (mode == "interrupted" ? "SOURCE_LOST" : nil))
            let rows = try String(contentsOf: folder.appendingPathComponent("camera/capture.journal.jsonl"), encoding: .utf8).split(separator: "\n")
            let terminal = try rows.filter { (try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any])["event"] as? String == "finished" }
            precondition(terminal.count == 1, "Joined/retried termination must record one camera completion")
            _ = try await assertProbePresentation(directory: folder.appendingPathComponent("camera"), observations: folder.appendingPathComponent("timestamps.jsonl"))
        }
        if let resumedHost {
            precondition(result.pauses.count == 1 && result.camera?.pauses == result.pauses)
            let rows = try String(contentsOf: folder.appendingPathComponent("timestamps.jsonl"), encoding: .utf8).split(separator: "\n")
                .map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
                .filter { $0["role"] as? String == "camera" }
            precondition(rows.filter { $0["disposition"] as? String == "outside-support" }.count == 1)
            let expected = resumedHost - result.hostOriginUs! - result.pauses[0].elapsedPauseUs
            precondition(rows.last?["sourceUs"] as? Int64 == expected && result.camera?.tracks.first?.omittedSamples == 1)
        }
        try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("native-result.json"))
        try JSONSerialization.data(withJSONObject: ["inputStops": screen.stops, "cameraStops": camera.stops, "state": capture.deviceState], options: [.sortedKeys])
            .write(to: folder.appendingPathComponent("drain-counts.json"))
        do { _ = try await capture.stop(); preconditionFailure("Settled termination must not close again") }
        catch let error as CaptureFailure { precondition(error.code == "INVALID_STATE") }
        await capture.discard()
        precondition(screen.stops == 1 && camera.stops == 1)
        print("PASS \(mode): shared NativeCapture lifecycle, truthful camera source and single physical drain")
    }
}


@MainActor
private func verifyDiscardedPreparation(root: URL, screenSource: URL, cameraSource: URL) async throws {
    for mode in ["discarded-preparation", "canceled-preparation", "returned-preparation"] {
        let oldFolder = root.appendingPathComponent(mode)
        let newFolder = root.appendingPathComponent("after-\(mode)")
        for folder in [oldFolder, newFolder] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false) }
        let oldScreen = PrerecordedCaptureInput(source: screenSource)
        let newScreen = PrerecordedCaptureInput(source: screenSource)
        let oldDevice = FixtureCameraDevice("chosen", session: FixtureCameraSession(source: cameraSource, origin: { oldScreen.fixtureOrigin! }))
        let newCamera = FixtureCameraSession(source: cameraSource, origin: { newScreen.fixtureOrigin! })
        let entered = InputGate(), release = InputGate()
        var oldPreparation = CaptureInputPreparation()
        oldPreparation.requireScreenAuthorization = { _ in }
        oldPreparation.cameraAuthorized = { true }
        oldPreparation.cameras = { [oldDevice] }
        oldPreparation.prepareScreen = { _ in entered.release(); await release.wait(); return oldScreen }
        var first = true
        let capture = NativeCapture(prepareInput: { [oldPreparation] request, check in
            let old = first; first = false
            if old && mode == "returned-preparation" { entered.release(); await release.wait(); return oldScreen }
            let folder = old ? oldFolder : newFolder
            let preparation = old ? oldPreparation : fixturePreparation(screen: newScreen, session: newCamera)
            return try await preparation.prepare(request, camera: CaptureCameraSelection(id: "chosen",
                directory: folder.appendingPathComponent("camera"), observations: folder.appendingPathComponent("timestamps.jsonl")), checkInterruption: check)
        })
        func request(_ folder: URL) -> CaptureRequest { CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.appendingPathComponent("screen").path, microphone: false, systemAudio: false) }
        let oldStartup = Task { try await capture.start(request(oldFolder)) }
        await entered.wait()
        if mode == "canceled-preparation" { oldStartup.cancel() }
        await capture.discard()
        precondition(capture.deviceState == "idle", "Discard must invalidate preparation before a writer exists")
        try await capture.start(request(newFolder))
        release.release()
        do { try await oldStartup.value; preconditionFailure("Obsolete preparation must refuse startup") }
        catch is CancellationError {}
        catch let error as CaptureFailure { precondition(error.code == "NATIVE_CAPTURE_FAILED") }
        precondition(oldDevice.opens == 0 && oldDevice.session.starts == 0 && oldDevice.session.stops == 0)
        precondition(oldScreen.offeredVideoFrames == 0 && oldScreen.stops == 1 && oldScreen.discards == 1,
            "Obsolete prepared resources must be released locally without starting a writer")
        precondition(!FileManager.default.fileExists(atPath: oldFolder.appendingPathComponent("screen").path)
            && !FileManager.default.fileExists(atPath: oldFolder.appendingPathComponent("camera").path))
        let result = try await capture.stop()
        precondition(result.state == "complete" && result.failure == nil && result.camera?.tracks.first?.samples == 3 && newCamera.stops == 1)
        try JSONEncoder().encode(result).write(to: newFolder.appendingPathComponent("native-result.json"))
        try JSONSerialization.data(withJSONObject: ["oldDeviceOpens": oldDevice.opens, "oldCameraStarts": oldDevice.session.starts,
            "oldCameraStops": oldDevice.session.stops, "newCameraStops": newCamera.stops, "state": capture.deviceState], options: [.sortedKeys])
            .write(to: oldFolder.appendingPathComponent("preparation-counts.json"))
        print("PASS \(mode): generation ends before writer; obsolete lookup cannot open selected IO or overwrite newer take")
    }
}


@MainActor
private func verifyWriterRefusal(root: URL, screenSource: URL, cameraSource: URL) async throws {
    for held in [false, true] {
        let folder = root.appendingPathComponent(held ? "writer-refusal-generation" : "writer-refusal")
        let newFolder = root.appendingPathComponent("after-writer-refusal")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        if held { try FileManager.default.createDirectory(at: newFolder, withIntermediateDirectories: false) }
        let occupied = folder.appendingPathComponent("screen")
        let bytes = Data("occupied output path".utf8)
        try bytes.write(to: occupied)
        let screen = PrerecordedCaptureInput(source: screenSource)
        let camera = FixtureCameraSession(source: cameraSource, origin: { screen.fixtureOrigin! })
        camera.holdStop = held
        let newScreen = PrerecordedCaptureInput(source: screenSource)
        let newCamera = FixtureCameraSession(source: cameraSource, origin: { newScreen.fixtureOrigin! })
        let preparation = fixturePreparation(screen: screen, session: camera)
        let capture = NativeCapture(prepareInput: { request, check in
            let old = request.outputDirectory == occupied.path
            let selected = old ? preparation : fixturePreparation(screen: newScreen, session: newCamera)
            let directory = old ? folder : newFolder
            return try await selected.prepare(request, camera: CaptureCameraSelection(id: "chosen",
                directory: directory.appendingPathComponent("camera"), observations: directory.appendingPathComponent("timestamps.jsonl")), checkInterruption: check)
        })
        let startup = Task { try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: occupied.path, microphone: false, systemAudio: false)) }
        if held {
            await camera.stopEntered.wait()
            await capture.discard()
            try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
                outputDirectory: newFolder.appendingPathComponent("screen").path, microphone: false, systemAudio: false))
            camera.releaseStop.release()
        }
        do { try await startup.value; preconditionFailure("Occupied writer destination must refuse") }
        catch {
            precondition(screen.stops == 1 && camera.stops == 1,
                "Writer-init refusal must release prepared resources once")
            if !held { precondition(capture.deviceState == "idle" && capture.outputSize == nil,
                "Writer-init refusal must publish no output size") }
        }
        precondition(camera.starts == 0 && screen.offeredVideoFrames == 0 && !FileManager.default.fileExists(atPath: folder.appendingPathComponent("camera").path))
        let retained = try Data(contentsOf: occupied)
        precondition(retained == bytes)
        if held {
            precondition(capture.deviceState == "recording" && capture.outputSize?.width == newScreen.width)
            let result = try await capture.stop()
            precondition(result.state == "complete" && result.failure == nil && result.camera?.tracks.first?.samples == 3 && newCamera.stops == 1)
            try JSONEncoder().encode(result).write(to: newFolder.appendingPathComponent("native-result.json"))
        }
        try JSONSerialization.data(withJSONObject: ["inputStops": screen.stops, "cameraStops": camera.stops,
            "cameraStarts": camera.starts, "state": capture.deviceState], options: [.sortedKeys])
            .write(to: folder.appendingPathComponent("drain-counts.json"))
        print("PASS writer refusal\(held ? " across new generation" : ""): local resource cleanup once, no activation/output overwrite or newer-take mutation")
    }
}

/// A screen take that reserved a companion camera, driven through the real NativeCapture and the
/// real CameraCaptureInput. Only the device and its sessions are fixtures.
@MainActor
private final class SwitchTake {
    let folder: URL
    let screen: PrerecordedCaptureInput
    let device: FixtureCameraDevice
    var capture: NativeCapture!
    var authorized = true
    var present = true
    var interruption: CaptureFailure?
    private let session: () -> FixtureCameraSession
    var camera: URL { folder.appendingPathComponent("camera") }
    /// Later opens build sessions configured differently from the first.
    func reopen(_ configure: @escaping (FixtureCameraSession) -> Void) {
        device.reopen = { [session] in let next = session(); configure(next); return next }
    }

    init(root: URL, name: String, screenSource: URL, cameraSource: URL, startsOn: Bool,
        session configure: @escaping (FixtureCameraSession) -> Void = { _ in }) throws {
        folder = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let screen = PrerecordedCaptureInput(source: screenSource)
        self.screen = screen
        func session() -> FixtureCameraSession {
            let session = FixtureCameraSession(source: cameraSource, origin: { screen.fixtureOrigin! })
            session.startsAtNow = true
            configure(session)
            return session
        }
        device = FixtureCameraDevice("chosen", session: session())
        device.reopen = session
        self.session = session
        var preparation = CaptureInputPreparation()
        preparation.requireScreenAuthorization = { _ in }
        preparation.prepareScreen = { _ in screen }
        let folder = folder, device = device
        let binding = CameraCaptureBinding(recordingId: name, sourceId: "\(name)-camera", deviceId: "chosen")
        preparation.cameraAuthorized = { [unowned self] in authorized }
        preparation.cameras = { [unowned self] in present ? [device] : [] }
        capture = NativeCapture(prepareInput: { [preparation] request, check in
            try await preparation.prepare(request, camera: CaptureCameraSelection(id: "chosen",
                directory: folder.appendingPathComponent("camera"),
                observations: folder.appendingPathComponent("camera").appendingPathComponent(CameraMedia.mappingFile),
                binding: binding, startsOn: startsOn), checkInterruption: check)
        })
        capture.onInterruption = { [unowned self] reason in interruption = reason }
    }
    func start(microphone: Bool = false) async throws {
        try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
            outputDirectory: folder.appendingPathComponent("screen").path, microphone: microphone, systemAudio: false))
    }
    func stop() async throws -> CaptureResult { try await capture.stop() }
    @discardableResult
    func refused(_ on: Bool, _ code: String) async -> CaptureFailure {
        var refusal: CaptureFailure!
        do { try await capture.setCamera(on: on); preconditionFailure("Turning the camera \(on) must refuse \(code)") }
        catch let error as CaptureFailure { refusal = error; precondition(error.code == code, "Expected \(code), got \(error.code): \(error.message)") }
        catch { preconditionFailure("Unexpected \(error)") }
        precondition(capture.deviceState == "recording" && capture.companionCamera?.on == false,
            "A refused toggle leaves the camera off and the take recording")
        return refusal
    }
    /// Lets the pictures a session stamped from its start become past, so a turn-off follows them.
    func record() async throws { try await Task.sleep(for: .milliseconds(350)) }
    var gaps: [Any]? {
        let receipt = try! JSONSerialization.jsonObject(with: Data(contentsOf:
            camera.appendingPathComponent("camera.publication.json"))) as! [String: Any]
        return receipt["gaps"] as? [Any]
    }
    var cameraUnavailableCode: String? {
        if case .unavailable(let reason) = capture.publication?.camera { return reason.code }
        return nil
    }
}

@MainActor
private func verifyCameraSwitch(root: URL, screenSource: URL, cameraSource: URL, audio: URL) async throws {
    func take(_ name: String, startsOn: Bool, session: @escaping (FixtureCameraSession) -> Void = { _ in }) throws -> SwitchTake {
        try SwitchTake(root: root, name: name, screenSource: screenSource, cameraSource: cameraSource,
            startsOn: startsOn, session: session)
    }

    // Reserved but never turned on: the device is never opened and the take completes.
    var t = try take("reserved-off-never-on", startsOn: false)
    t.screen.audio = audio
    try await t.start(microphone: true)
    precondition(t.capture.companionCamera?.deviceId == "chosen" && t.capture.companionCamera?.on == false)
    var result = try await t.stop()
    precondition(t.device.opens == 0, "A camera that was never turned on is never opened")
    precondition(result.state == "complete" && result.failure == nil && result.camera == nil,
        "A never-turned-on camera does not fail the take: \(String(describing: result.failure))")
    precondition(t.cameraUnavailableCode == "CAMERA_NOT_TURNED_ON")
    let members = try FileManager.default.contentsOfDirectory(atPath: t.camera.path)
    precondition(members == [CameraMedia.mappingFile],
        "A never-turned-on camera leaves only its mapping")
    // The mapping records camera callbacks only. Screen and microphone delivered throughout
    // this take; a mapping that logged them would grow with the take while the camera is off.
    precondition(result.tracks.contains { $0.role == "video" && $0.samples > 0 }
        && result.tracks.contains { $0.role == "narration" && $0.samples > 0 },
        "The take recorded screen and microphone: \(result.tracks.map { "\($0.role)=\($0.samples)" })")
    let neverOnMapping = try Data(contentsOf: t.camera.appendingPathComponent(CameraMedia.mappingFile))
    precondition(neverOnMapping.isEmpty,
        "A reserved-off take writes no screen or microphone rows into the camera mapping: \(neverOnMapping.count) bytes")
    print("PASS reserved-off-never-on: no open, take complete, camera CAMERA_NOT_TURNED_ON, empty mapping")

    // Off, on, off, on: each turn-on opens a fresh session and each turn-off drops it.
    t = try take("off-on-off-on", startsOn: false)
    t.reopen { $0.equivalentFormat = true }
    try await t.start()
    try await t.capture.setCamera(on: true)
    precondition(t.capture.companionCamera?.on == true)
    try await t.record()
    try await t.capture.setCamera(on: false)
    precondition(t.capture.companionCamera?.on == false)
    try await t.capture.setCamera(on: true)
    try await t.record()
    result = try await t.stop()
    precondition(t.device.opens == 2 && t.device.sessions.allSatisfy { $0.starts == 1 && $0.stops == 1 },
        "Every turn-on opens one session and every session stops once")
    precondition(result.state == "complete" && result.failure == nil && result.camera?.state == "complete",
        "An equivalent re-created format is accepted: \(String(describing: result.failure ?? result.camera?.failure))")
    precondition(result.camera?.tracks.first?.samples == 6)
    precondition(t.gaps?.count == 1, "Two runs publish one gap: \(String(describing: t.gaps))")
    print("PASS off-on-off-on: two opens, two stops, one gap; an equivalent re-created format is accepted")

    // A re-created session with different dimensions is refused; the take keeps its first run.
    t = try take("format-changed", startsOn: true)
    t.reopen { $0.width = RecoveryFixture.width * 2 }
    try await t.start()
    try await t.record()
    try await t.capture.setCamera(on: false)
    await t.refused(true, "CAMERA_FORMAT_CHANGED")
    result = try await t.stop()
    precondition(t.device.sessions.last!.starts == 0 && t.device.session.stops == 1)
    precondition(result.state == "complete" && result.camera?.tracks.first?.samples == 3)
    print("PASS format-changed: a different picture size refuses the turn-on and the take continues")

    // A session turned on mid-take whose pictures carry different colour tags cannot be told apart
    // before it delivers. Its first incompatible picture ends that run: the picture is refused, the
    // camera turns off and the take keeps every earlier run and completes.
    t = try take("format-recoloured", startsOn: true)
    var reopened = 0
    t.reopen { reopened += 1; if reopened == 1 { $0.equivalentFormat = true } else { $0.recolouredFrom = 0 } }
    try await t.start()
    try await t.record()
    try await t.capture.setCamera(on: false)
    try await t.capture.setCamera(on: true)
    try await t.record()
    try await t.capture.setCamera(on: false)
    try await t.capture.setCamera(on: true)
    for _ in 0..<200 where t.capture.companionCamera?.on != false { try await Task.sleep(for: .milliseconds(10)) }
    precondition(t.capture.companionCamera?.on == false && t.interruption == nil && t.capture.deviceState == "recording",
        "An incompatible picture after a turn-on turns the camera off and keeps the take: \(String(describing: t.interruption))")
    result = try await t.stop()
    precondition(t.device.opens == 3 && t.device.sessions.allSatisfy { $0.starts == 1 && $0.stops == 1 },
        "The ended run's session is released once")
    precondition(result.state == "complete" && result.failure == nil && result.camera?.state == "complete",
        "The take completes: \(String(describing: result.failure ?? result.camera?.failure))")
    precondition(result.camera?.tracks.first?.samples == 6 && t.gaps?.count == 1,
        "The two earlier runs publish alone: \(String(describing: result.camera?.tracks.first?.samples)), gaps \(String(describing: t.gaps))")
    let recolouredRows = try String(contentsOf: t.camera.appendingPathComponent(CameraMedia.mappingFile), encoding: .utf8)
        .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
        .filter { $0["role"] as? String == "camera" }
    precondition(recolouredRows.filter { $0["disposition"] as? String == "accepted" }.count == 6
        && !recolouredRows.contains { (($0["cameraFrame"] as? [String: Any])?["run"] as? Int) == 2 },
        "No picture of the recoloured session is recorded")
    let canonicalTrack = try await AVURLAsset(url: t.camera.appendingPathComponent("video.mov"))
        .loadTracks(withMediaType: .video).first!
    let occupied = try await canonicalTrack.load(.segments).filter { !$0.isEmpty }
    precondition(occupied.count == 2, "The canonical movie holds only the two earlier runs: \(occupied.count) occupied segments")
    print("PASS format-recoloured: a turn-on's incompatible picture ends its run; camera off, take complete")

    // The session whose first picture established the take's format changing mid-run is not a
    // toggle: it still interrupts the take, as a format change always did. (The fixture delivers
    // inside its start, so the take starts off and its first turn-on opens that session.)
    t = try take("format-changed-mid-run", startsOn: false) { $0.recolouredFrom = 1 }
    try await t.start()
    try? await t.capture.setCamera(on: true)
    for _ in 0..<200 where t.interruption == nil { try await Task.sleep(for: .milliseconds(10)) }
    precondition(t.interruption?.code == "CAMERA_FORMAT_CHANGED", "Got \(String(describing: t.interruption))")
    result = try await t.stop()
    precondition(result.state == "interrupted" && result.failure?.code == "CAMERA_FORMAT_CHANGED")
    print("PASS format-changed-mid-run: the establishing session changing format interrupts the take, as before")

    for (mode, code) in [("turn-on-device-missing", "SOURCE_UNAVAILABLE"), ("turn-on-permission-revoked", "CAMERA_PERMISSION_REQUIRED")] {
        t = try take(mode, startsOn: false)
        try await t.start()
        if mode == "turn-on-device-missing" { t.present = false } else { t.authorized = false }
        await t.refused(true, code)
        result = try await t.stop()
        precondition(t.device.opens == 0 && result.state == "complete" && t.cameraUnavailableCode == "CAMERA_NOT_TURNED_ON")
        print("PASS \(mode): refused with \(code), no open, take complete")
    }

    // Stop or discard cancels a turn-on in flight: the turn-on is refused, its session is still
    // released once, and the camera publishes as if that turn-on never happened.
    // A cancelled turn-on whose release fails still keeps the take: the failure is the toggle's.
    for mode in ["stop-during-turn-on", "stop-during-second-turn-on", "discard-during-turn-on",
        "stop-during-turn-on-release-fails"] {
        let earlierRun = mode == "stop-during-second-turn-on"
        let releaseFails = mode.hasSuffix("release-fails")
        t = try take(mode, startsOn: earlierRun) {
            $0.holdStart = !earlierRun
            if releaseFails { $0.releaseFailure = CaptureFailure("DEVICE_RESTORE_FAILED", "Fixture camera settings not restored") }
        }
        if earlierRun { t.reopen { $0.holdStart = true } }
        try await t.start()
        if earlierRun { try await t.record(); try await t.capture.setCamera(on: false) }
        let switching = t
        let turning = Task { try await switching.capture.setCamera(on: true) }
        while t.device.sessions.count < (earlierRun ? 2 : 1) { await Task.yield() }
        let turningSession = t.device.sessions.last!
        await turningSession.startEntered.wait()
        let ending: Task<CaptureResult?, any Error> = mode == "discard-during-turn-on"
            ? Task { await switching.capture.discard(); return nil }
            : Task { try await switching.stop() }
        // The take has sealed its writers before the turn-on's session finishes starting.
        while t.capture.deviceState == "recording" { await Task.yield() }
        turningSession.releaseStart.release()
        do { try await turning.value; preconditionFailure("\(mode): a turn-on cancelled by the take's end must refuse") }
        catch let error as CaptureFailure { precondition(error.code == "INVALID_STATE", "\(mode): got \(error.code)") }
        let ended = try await ending.value
        precondition(t.device.opens == (earlierRun ? 2 : 1)
            && t.device.sessions.allSatisfy { $0.starts == 1 && $0.stops == 1 && $0.stopsDuringStart == 0 },
            "\(mode): the cancelled turn-on's session starts once and is released once, after its start")
        precondition(t.capture.deviceState == "idle")
        if let result = ended {
            precondition(result.state == "complete" && result.failure == nil,
                "\(mode): a stop racing a turn-on keeps the take: \(String(describing: result.failure))")
            if earlierRun {
                precondition(result.camera?.state == "complete" && result.camera?.failure == nil
                    && result.camera?.tracks.first?.samples == 3 && t.gaps == nil,
                    "The earlier run publishes alone, ending where it ended: \(String(describing: result.camera?.failure)), gaps \(String(describing: t.gaps))")
            } else {
                precondition(result.camera == nil && t.cameraUnavailableCode == "CAMERA_NOT_TURNED_ON",
                    "A camera whose only turn-on was cancelled was never turned on: \(String(describing: t.cameraUnavailableCode))")
                let members = try FileManager.default.contentsOfDirectory(atPath: t.camera.path)
                precondition(members == [CameraMedia.mappingFile], "A cancelled turn-on records nothing beside the mapping: \(members)")
            }
        }
        print("PASS \(mode): the turn-on is cancelled, its session released once, the take \(ended?.state ?? "discarded")")
    }

    // Turned on, then off by the person, before any picture was accepted: nothing failed, so the
    // camera reads as never turned on and the take completes. (On at stop with no picture is still
    // NO_CAMERA: the `no-camera` lifecycle mode.)
    t = try take("on-off-no-frames", startsOn: false) { $0.deliverFrames = false }
    try await t.start()
    try await t.capture.setCamera(on: true)
    try await t.capture.setCamera(on: false)
    result = try await t.stop()
    precondition(t.device.opens == 1 && t.device.session.starts == 1 && t.device.session.stops == 1)
    precondition(result.state == "complete" && result.failure == nil && result.camera == nil,
        "A camera turned off before any picture does not fail the take: \(String(describing: result.failure))")
    precondition(t.cameraUnavailableCode == "CAMERA_NOT_TURNED_ON", "Got \(String(describing: t.cameraUnavailableCode))")
    print("PASS on-off-no-frames: turned off before any picture, take complete, camera CAMERA_NOT_TURNED_ON")

    // Loss while off reaches no observer; the next turn-on finds the device gone.
    t = try take("device-loss-while-off", startsOn: true)
    try await t.start()
    try await t.record()
    try await t.capture.setCamera(on: false)
    t.present = false
    t.device.session.loseDevice()
    try await Task.sleep(for: .milliseconds(50))
    precondition(t.interruption == nil && t.capture.deviceState == "recording", "Loss while off does not interrupt the take")
    await t.refused(true, "SOURCE_UNAVAILABLE")
    result = try await t.stop()
    precondition(result.state == "complete" && result.camera?.state == "complete" && result.camera?.tracks.first?.samples == 3)
    print("PASS device-loss-while-off: no interruption; turn-on refuses SOURCE_UNAVAILABLE")

    // Loss while on interrupts the whole take, as before.
    t = try take("device-loss-while-on", startsOn: true)
    try await t.start()
    t.device.session.loseDevice()
    for _ in 0..<100 where t.interruption == nil { try await Task.sleep(for: .milliseconds(10)) }
    precondition(t.interruption?.code == "SOURCE_LOST")
    result = try await t.stop()
    precondition(result.state == "interrupted" && result.failure?.code == "SOURCE_LOST")
    print("PASS device-loss-while-on: whole-take interruption")

    // A release failure belongs to the toggle that released the session: the call reports it, the
    // camera is off, and the take still completes with everything it recorded.
    let notRestored = CaptureFailure("DEVICE_RESTORE_FAILED", "Fixture camera settings not restored")
    t = try take("turn-off-release-fails", startsOn: true) { $0.releaseFailure = notRestored }
    try await t.start()
    try await t.record()
    await t.refused(false, "DEVICE_RESTORE_FAILED")
    result = try await t.stop()
    precondition(t.device.opens == 1 && t.device.session.stops == 1)
    precondition(result.state == "complete" && result.failure == nil,
        "A turn-off's release failure never becomes the take's: \(String(describing: result.failure))")
    precondition(result.camera?.state == "complete" && result.camera?.tracks.first?.samples == 3)
    print("PASS turn-off-release-fails: the turn-off refuses DEVICE_RESTORE_FAILED, camera off, take complete")

    // A failed turn-on reports its own cause; the release of its session failing too is named in
    // that refusal and never becomes the take's failure.
    t = try take("failed-turn-on-release-fails", startsOn: false) {
        $0.failureAfterDelivery = CaptureFailure("INPUT_START_FAILED", "Fixture camera startup failed")
        $0.releaseFailure = notRestored
    }
    try await t.start()
    let startRefusal = await t.refused(true, "INPUT_START_FAILED")
    precondition(startRefusal.message.contains("DEVICE_RESTORE_FAILED"),
        "The refusal names the release failure too: \(startRefusal.message)")
    result = try await t.stop()
    precondition(t.device.opens == 1 && t.device.session.stops == 1)
    precondition(result.state == "complete" && result.failure == nil,
        "A failed turn-on's release failure never becomes the take's: \(String(describing: result.failure))")
    print("PASS failed-turn-on-release-fails: refused with its cause, camera off, take complete")

    // The one release at the end of the take is unchanged: a camera on at stop whose release fails
    // ends the take with that failure.
    t = try take("stop-release-fails", startsOn: true) { $0.releaseFailure = notRestored }
    try await t.start()
    try await t.record()
    result = try await t.stop()
    precondition(t.device.session.stops == 1)
    precondition(result.state == "interrupted" && result.failure?.code == "DEVICE_RESTORE_FAILED",
        "The end-of-take release keeps its rule: \(result.state) \(String(describing: result.failure))")
    print("PASS stop-release-fails: the end-of-take release failure ends the take, as before")

    // Setting the current state changes nothing.
    t = try take("idempotent-set", startsOn: true)
    try await t.start()
    try await t.capture.setCamera(on: true)
    precondition(t.device.opens == 1 && t.capture.companionCamera?.on == true)
    try await t.record()
    try await t.capture.setCamera(on: false)
    try await t.capture.setCamera(on: false)
    precondition(t.device.session.stops == 1 && t.capture.companionCamera?.on == false)
    result = try await t.stop()
    precondition(t.device.opens == 1 && t.device.session.stops == 1 && result.state == "complete")
    do { try await t.capture.setCamera(on: true); preconditionFailure("A settled take cannot toggle") }
    catch let error as CaptureFailure { precondition(error.code == "INVALID_STATE") }
    print("PASS idempotent-set: repeating a state opens and stops nothing more; a settled take refuses")

    // Camera transitions have no aggregate ceiling; all off intervals survive publication.
    t = try take("many-toggles", startsOn: true) { $0.pulseUs = 1000 }
    try await t.start()
    for _ in 0..<501 {
        try await Task.sleep(for: .milliseconds(3))
        try await t.capture.setCamera(on: false)
        try await t.capture.setCamera(on: true)
    }
    result = try await t.stop()
    precondition(result.state == "complete" && result.camera?.state == "complete")
    precondition(t.gaps?.count == 501, "All camera off intervals must survive publication")
    print("PASS 502 camera turn-ons publish all 501 gaps")
}
