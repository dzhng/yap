@preconcurrency import AVFoundation
import Darwin
import Foundation
import YapCapture
import YapMedia
import YapWire

@MainActor
func runSourcePublicationRecoveryTests(output: String? = nil) async throws {
    let root = output.map { URL(fileURLWithPath: $0) } ?? RecoveryFixture.directory("source-publication-recovery")
    if output != nil { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false) }
    defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
    let input = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: input, timesUs: [0, 100000, 200000], keyFrameInterval: 1, endUs: 300000)
    for kind in ["primary", "camera"] {
        for tail in ["unfinished", "torn", "corrupt", "complete"] {
            let folder = root.appendingPathComponent("\(kind)-\(tail)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            let binding = kind == "camera" ? CameraCaptureBinding(recordingId: "literal-take", sourceId: "literal-camera", deviceId: "literal-device") : nil
            let id = binding?.sourceId ?? "literal-primary"
            let journal = try CaptureJournal(directory: folder.path, header: .init(schemaVersion: kind == "camera" ? 1 : 2,
                sessionID: id, source: .init(kind: kind == "camera" ? "camera" : "offline-prerecorded"), width: RecoveryFixture.width,
                height: RecoveryFixture.height, microphone: false, systemAudio: false, cameraBinding: binding))
            if kind == "camera" { try journal.recordOrigin(hostUs: 1040000) }
            else { try journal.recordPCMOrigin(.init(rawPTS: time(microseconds: 1000000), declaredHostUs: 1000000)) }
            if tail == "complete" {
                try journal.recordFinished(CaptureResult(state: "complete", source: .init(kind: kind), width: RecoveryFixture.width,
                    height: RecoveryFixture.height, durationUs: 300000, hostOriginUs: kind == "camera" ? 1040000 : 1000000,
                    pauses: [], tracks: [], failure: nil, systemAudioScope: "none", cameraBinding: binding))
            }
            journal.lease.release()
            if tail == "torn" || tail == "corrupt" {
                let handle = try FileHandle(forWritingTo: folder.appendingPathComponent("capture.journal.jsonl"))
                try handle.seekToEnd(); try handle.write(contentsOf: Data((tail == "torn" ? "{\"sequence\":3" : "broken terminated record\n").utf8)); try handle.close()
            }
            try FileManager.default.copyItem(at: input, to: folder.appendingPathComponent(kind == "camera" ? "camera.raw.mov" : "video.mov"))
            if kind == "camera" {
                struct Row: Encodable { let role = "camera"; let disposition = "accepted"; let cameraFrame: CameraFrameMapping }
                var rows = Data()
                for index in 0..<3 {
                    let frame = try JSONDecoder().decode(CameraFrameMapping.self, from: JSONSerialization.data(withJSONObject: [
                        "ordinal": index, "start": ["value": index * 100000, "timescale": 1000000, "epoch": 0],
                        "end": ["value": (index + 1) * 100000, "timescale": 1000000, "epoch": 0]]))
                    rows += try JSONEncoder().encode(Row(cameraFrame: frame)) + Data([10])
                }
                try rows.write(to: folder.appendingPathComponent("camera.mapping.jsonl"))
            }
            let original = try Data(contentsOf: folder.appendingPathComponent("capture.journal.jsonl"))
            let authority: [String: Any] = ["kind": kind, "sourceId": id, "binding": try binding.map(json) ?? NSNull()]
            let response = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "\(kind)-\(tail)-recover")
            let data = response["data"] as! [String: Any]
            let outcome = data["sourcePublication"] as! [String: Any]
            precondition(data["inputsClosed"] as? Bool == true && outcome["state"] as? String == "published", "Pre-completion recovery must publish authority: \(response)")
            let source = try JSONDecoder().decode(CapturePublishedSource.self, from: JSONSerialization.data(withJSONObject: outcome["source"]!))
            precondition(source.sourceDurationUs == 300000 && source.originHostUs == (kind == "camera" ? 1040000 : 1000000) && source.binding == binding)
            try require(try Data(contentsOf: folder.appendingPathComponent("capture.journal.jsonl")) == original)
            try require(try Data(contentsOf: folder.appendingPathComponent(source.journal.file)) == original)
            let receiptPath = folder.appendingPathComponent("source.publication.json")
            let receipt = try Data(contentsOf: receiptPath)
            let stored = try JSONSerialization.jsonObject(with: receipt) as! [String: Any]
            precondition((stored["recovery"] != nil) == (tail != "complete"))
            precondition((outcome["source"] as! [String: Any])["recovery"] == nil, "Private basis cannot leak into public authority")
            _ = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "\(kind)-\(tail)-retry")
            try require(try Data(contentsOf: receiptPath) == receipt, "A lost reply must reuse identical receipt bytes")
            _ = try await CapturePublishedSource.recover(directory: folder.path)
            try await verifyStagedRecovery(root: root, folder: folder, source: source, name: "\(kind)-\(tail)")
            if tail == "torn" {
                try await recoveryRefusalControls(root: root, folder: folder, authority: authority, kind: kind)
            }
        }
    }
    try await recoverSnapshotBeforeReceipt(root: root)
    try await interruptedAuthorityControls(root: root)
    try await actualCrashRecovery(root: root)
    print("PASS native source recovery preserves whole unfinished/torn journals, private provenance, source authority, staged descriptors and lost-reply identity")
}

@MainActor
private func verifyStagedRecovery(root: URL, folder: URL, source: CapturePublishedSource, name: String) async throws {
    let stage = root.appendingPathComponent("\(name)-stage")
    try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
    try FileManager.default.copyItem(at: folder.appendingPathComponent(source.journal.file), to: stage.appendingPathComponent("capture.journal.jsonl"))
    for name in ["source.publication.json", "camera.publication.json", "camera.mapping.jsonl", "narration.publication.json", "system.publication.json"] {
        let file = folder.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.copyItem(at: file, to: stage.appendingPathComponent(name)) }
    }
    let receipt = try CaptureMediaIdentity.read(stage.appendingPathComponent("source.publication.json"))
    let descriptor = Darwin.open(folder.appendingPathComponent("video.mov").path, O_RDONLY | O_NOFOLLOW)
    precondition(descriptor >= 0); defer { close(descriptor) }
    let canonical = ["video": "/dev/fd/\(descriptor)"]
    let expected: [String: Any] = ["source": try json(source), "receipt": try json(receipt)]
    let params: [String: Any] = ["directory": stage.path, "output": root.appendingPathComponent("\(name)-verified.jsonl").path,
        "canonical": canonical, "sourceAuthority": expected]
    let donorLease = try CaptureJournalLease(directory: folder.path)
    let response = try await recoveryWire("media.sourceEvidence", params: params, root: root, name: "\(name)-staged")
    donorLease.release()
    let data = response["data"] as! [String: Any]
    precondition(NSDictionary(dictionary: data["verifiedSourceAuthority"] as! [String: Any]).isEqual(to: expected["source"] as! [String: Any]))
    let generic = try await recoveryWire("media.sourceEvidence", params: ["directory": stage.path,
        "output": root.appendingPathComponent("\(name)-generic.jsonl").path, "canonical": canonical], root: root, name: "\(name)-generic")
    var proven = data; proven.removeValue(forKey: "verifiedSourceAuthority"); proven.removeValue(forKey: "file")
    var ordinary = generic["data"] as! [String: Any]; ordinary.removeValue(forKey: "file")
    precondition(NSDictionary(dictionary: proven).isEqual(to: ordinary), "Capture verification must preserve generic evidence receipt")
    try require(try Data(contentsOf: URL(fileURLWithPath: data["file"] as! String)) == Data(contentsOf: URL(fileURLWithPath: (generic["data"] as! [String: Any])["file"] as! String)))
    var missing = params; missing["canonical"] = [:]; missing["output"] = root.appendingPathComponent("\(name)-missing.jsonl").path
    let refused = try await recoveryWire("media.sourceEvidence", params: missing, root: root, name: "\(name)-missing-descriptor", successful: false)
    precondition(refused["ok"] as? Bool == false)
    let receiptPath = stage.appendingPathComponent("source.publication.json")
    let saved = try Data(contentsOf: receiptPath)
    try FileManager.default.removeItem(at: receiptPath)
    var absent = params; absent["output"] = root.appendingPathComponent("\(name)-absent.jsonl").path
    let absentResponse = try await recoveryWire("media.sourceEvidence", params: absent, root: root, name: "\(name)-absent-proof", successful: false)
    precondition(absentResponse["ok"] as? Bool == false)
    try saved.write(to: receiptPath)
    if name == "primary-torn" || name == "camera-torn" {
        let journalPath = stage.appendingPathComponent("capture.journal.jsonl")
        let journal = try Data(contentsOf: journalPath)
        try (journal + Data([32])).write(to: journalPath)
        var changedJournal = params; changedJournal["output"] = root.appendingPathComponent("\(name)-changed-journal.jsonl").path
        let journalRefusal = try await recoveryWire("media.sourceEvidence", params: changedJournal, root: root, name: "\(name)-changed-journal", successful: false)
        precondition(journalRefusal["ok"] as? Bool == false)
        try journal.write(to: journalPath)
        var changed = try JSONSerialization.jsonObject(with: saved) as! [String: Any]
        changed.removeValue(forKey: "recovery")
        try JSONSerialization.data(withJSONObject: changed, options: [.sortedKeys]).write(to: receiptPath)
        var changedProof = params; changedProof["output"] = root.appendingPathComponent("\(name)-changed-proof.jsonl").path
        let frozenRefusal = try await recoveryWire("media.sourceEvidence", params: changedProof, root: root, name: "\(name)-changed-frozen-proof", successful: false)
        precondition(frozenRefusal["ok"] as? Bool == false)
        changedProof["sourceAuthority"] = ["source": expected["source"]!, "receipt": try json(CaptureMediaIdentity.read(receiptPath))]
        let basisRefusal = try await recoveryWire("media.sourceEvidence", params: changedProof, root: root, name: "\(name)-missing-private-basis", successful: false)
        precondition(basisRefusal["ok"] as? Bool == false)
        try saved.write(to: receiptPath)
        let wrong = root.appendingPathComponent("\(name)-different-canonical.mov")
        try (Data(contentsOf: folder.appendingPathComponent("video.mov")) + Data([32])).write(to: wrong)
        let wrongDescriptor = Darwin.open(wrong.path, O_RDONLY | O_NOFOLLOW)
        precondition(wrongDescriptor >= 0); defer { close(wrongDescriptor) }
        var different = params; different["canonical"] = ["video": "/dev/fd/\(wrongDescriptor)"]
        different["output"] = root.appendingPathComponent("\(name)-wrong-descriptor.jsonl").path
        let descriptorRefusal = try await recoveryWire("media.sourceEvidence", params: different, root: root, name: "\(name)-wrong-descriptor", successful: false)
        precondition(descriptorRefusal["ok"] as? Bool == false)
    }
}

@MainActor
private func recoveryRefusalControls(root: URL, folder: URL, authority: [String: Any], kind: String) async throws {
    for mutation in ["basis", "duration", "origin", "diagnostic", "outside-prefix", "snapshot", "canonical", "proof"] {
        if kind == "primary" && mutation == "proof" { continue }
        let target = root.appendingPathComponent("\(kind)-red-\(mutation)")
        try FileManager.default.copyItem(at: folder, to: target)
        let receipt = target.appendingPathComponent("source.publication.json")
        var value = try JSONSerialization.jsonObject(with: Data(contentsOf: receipt)) as! [String: Any]
        if mutation == "basis" { value.removeValue(forKey: "recovery") }
        if mutation == "duration" { value["sourceDurationUs"] = 300001 }
        if mutation == "origin" { value["originHostUs"] = 1000001 }
        if mutation == "diagnostic" { value["diagnostic"] = ["code": "CAPTURE_RECOVERED", "message": "changed diagnostic"] }
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: receipt)
        if ["outside-prefix", "snapshot", "canonical", "proof"].contains(mutation) {
            let name = mutation == "outside-prefix" ? "capture.journal.jsonl" : mutation == "snapshot" ? (kind == "primary" ? "source.journal.jsonl" : "capture.journal.jsonl") : mutation == "canonical" ? "video.mov" : "camera.mapping.jsonl"
            let handle = try FileHandle(forWritingTo: target.appendingPathComponent(name)); try handle.seekToEnd(); try handle.write(contentsOf: Data([32])); try handle.close()
        }
        let response = try await recoveryWire("media.recover", params: ["directory": target.path, "sourceAuthority": authority], root: root, name: "\(kind)-red-\(mutation)", successful: false)
        if response["ok"] as? Bool == true {
            let outcome = (response["data"] as! [String: Any])["sourcePublication"] as! [String: Any]
            precondition(outcome["state"] as? String != "published", "Altered \(mutation) cannot retain publication authority")
        }
    }
    let busy = try CaptureJournalLease(directory: folder.path)
    let response = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "\(kind)-busy", successful: false)
    let busyError = response["error"] as? [String: Any]
    precondition(busyError?["code"] as? String == "CAPTURE_BUSY"
        && (busyError?["details"] as? [String: Any])?["cause"] as? String == "CAPTURE_BUSY")
    busy.release()
    let journalPath = folder.appendingPathComponent("capture.journal.jsonl").path
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: journalPath)
    let inaccessible = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "\(kind)-unreadable-journal", successful: false)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journalPath)
    precondition(inaccessible["ok"] as? Bool == false && (inaccessible["error"] as? [String: Any])?["code"] as? String == "JOURNAL_UNAVAILABLE")
    let canceled = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        return try await MediaRecovery.recover(directory: folder.path, sourceAuthority: .init(kind: kind == "camera" ? .camera : .primary,
            sourceId: authority["sourceId"] as! String, binding: kind == "camera" ? .init(recordingId: "literal-take", sourceId: "literal-camera", deviceId: "literal-device") : nil))
    }
    do { _ = try await canceled.value; preconditionFailure("Canceled authority recovery cannot classify a source") }
    catch is CancellationError {}
    var changed = authority; changed["sourceId"] = "wrong-source"
    let mismatch = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": changed], root: root, name: "\(kind)-changed-binding")
    let data = mismatch["data"] as! [String: Any]
    let outcome = data["sourcePublication"] as! [String: Any]
    precondition(outcome["state"] as? String == "unavailable"
        && (outcome["error"] as? [String: Any])?["code"] as? String == "INVALID_JOURNAL_PREFIX",
        "Immutable authority mismatch must settle unavailable: \(mismatch)")
}

@MainActor
private func recoverSnapshotBeforeReceipt(root: URL) async throws {
    let folder = root.appendingPathComponent("snapshot-before-receipt")
    try FileManager.default.copyItem(at: root.appendingPathComponent("primary-torn"), to: folder)
    let receipt = folder.appendingPathComponent("source.publication.json")
    let expected = try Data(contentsOf: folder.appendingPathComponent("source.journal.jsonl"))
    try FileManager.default.removeItem(at: receipt)
    _ = try await recoveryWire("media.recover", params: ["directory": folder.path,
        "sourceAuthority": ["kind": "primary", "sourceId": "literal-primary"]], root: root, name: "snapshot-before-receipt")
    try require(try Data(contentsOf: folder.appendingPathComponent("source.journal.jsonl")) == expected)
}

@MainActor
private func actualCrashRecovery(root: URL) async throws {
    let source = root.appendingPathComponent("crash-input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source, timesUs: (0..<90).map { Int64($0) * 33333 }, keyFrameInterval: 1, endUs: 3000000)
    for mode in ["both", "camera-only", "pause"] {
        let directory = root.appendingPathComponent("crash-\(mode)")
        let child = Process(); child.executableURL = Bundle.main.executableURL
        child.arguments = [source.path, directory.path, mode]
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "YAP_SOURCE_RECOVERY_OUTPUT")
        environment["YAP_SOURCE_RECOVERY_CHILD"] = "1"; child.environment = environment
        let log = root.appendingPathComponent("crash-\(mode)-child.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let output = try FileHandle(forWritingTo: log); child.standardOutput = output; child.standardError = output
        try child.run(); child.waitUntilExit(); try output.close()
        precondition(child.terminationStatus == 0)
        let original = try Data(contentsOf: directory.appendingPathComponent("capture.journal.jsonl"))
        try require(try CaptureJournal.inspect(directory: directory.path).finished == false)
        for kind in ["primary", "camera"] {
            let folder = kind == "camera" ? directory.appendingPathComponent("camera") : directory
            let authority: [String: Any] = ["kind": kind, "sourceId": "crash-\(mode)-\(kind)",
                "binding": kind == "camera" ? ["recordingId": "crash-\(mode)", "sourceId": "crash-\(mode)-camera", "deviceId": "prerecorded-device"] : NSNull()]
            let response = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "crash-\(mode)-\(kind)")
            let data = response["data"] as! [String: Any]
            let outcome = data["sourcePublication"] as! [String: Any]
            if mode == "camera-only" && kind == "primary" {
                precondition(outcome["state"] as? String == "unavailable"
                    && (outcome["error"] as? [String: Any])?["code"] as? String == "INVALID_JOURNAL_PREFIX",
                    "Retry cannot invent missing captured placement provenance")
            }
            else {
                precondition(outcome["state"] as? String == "published" && (data["durationUs"] as! Int64) > 0, "Actual crash must retain verified source support: \(response)")
                let published = try JSONDecoder().decode(CapturePublishedSource.self, from: JSONSerialization.data(withJSONObject: outcome["source"]!))
                try await verifyStagedRecovery(root: root, folder: folder, source: published, name: "crash-\(mode)-\(kind)")
            }
        }
        try require(try Data(contentsOf: directory.appendingPathComponent("capture.journal.jsonl")) == original)
    }
}

@MainActor
func runSourcePublicationCrashChild() async throws {
    let source = URL(fileURLWithPath: CommandLine.arguments[1]); let folder = URL(fileURLWithPath: CommandLine.arguments[2]); let mode = CommandLine.arguments[3]
    let input = PrerecordedCaptureInput(source: source)
    input.videoDeliveryInterval = .milliseconds(10)
    input.primaryFramesEnabled = mode != "camera-only"
    let binding = CameraCaptureBinding(recordingId: "crash-\(mode)", sourceId: "crash-\(mode)-camera", deviceId: "prerecorded-device")
    if mode == "pause" { input.pauseJournal = folder.appendingPathComponent("capture.journal.jsonl") }
    let camera = FixtureCameraSession(source: source, origin: { input.fixtureOrigin! })
    let selection = CaptureCameraSelection(id: binding.deviceId, directory: folder.appendingPathComponent("camera"),
        observations: folder.appendingPathComponent("timestamps.jsonl"), binding: binding)
    let device = FixtureCameraDevice(binding.deviceId, session: camera)
    let capture = NativeCapture(prepareInput: { request, _ in
        try await prepareFixtureCompanion(request, screen: input, device: device, selection: selection)
    })
    let request = CaptureRequest(source: .init(kind: "offline-prerecorded"), outputDirectory: folder.path, sourceId: "crash-\(mode)-primary")
    try await capture.start(request)
    try JSONEncoder().encode(request).write(to: folder.appendingPathComponent("request.json"))
    precondition(capture.publication?.inputsClosed == false && input.stops == 0 && input.finalizations == 0 && camera.stops == 0)
    try JSONSerialization.data(withJSONObject: ["offeredPictures": input.offeredVideoFrames,
        "originHostUs": input.fixtureOrigin!, "stops": input.stops, "finalizations": input.finalizations, "cameraStops": camera.stops,
        "cameraStarts": camera.starts, "wrapper": "CameraCaptureInput", "cameraMapping": "camera/camera.mapping.jsonl"]).write(to: folder.appendingPathComponent("crash-facts.json"))
    _exit(0)
}

private func json<T: Encodable>(_ value: T) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
}

@MainActor
private func recoveryWire(_ operation: String, params: [String: Any], root: URL, name: String, successful: Bool = true) async throws -> [String: Any] {
    let request = try JSONSerialization.data(withJSONObject: ["id": name, "operation": operation, "params": params], options: [.sortedKeys])
    try request.write(to: root.appendingPathComponent("\(name)-request.json"))
    let bytes = await NativeWire.respond(to: String(decoding: request, as: UTF8.self))
    try bytes.write(to: root.appendingPathComponent("\(name)-response.json"))
    let response = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
    if successful { precondition(response["ok"] as? Bool == true, "Actual native wire refused: \(response)") }
    return response
}

private func require(_ condition: @autoclosure () throws -> Bool, _ message: String = "Contract failed") rethrows {
    let accepted = try condition(); precondition(accepted, message)
}

@MainActor
private func interruptedAuthorityControls(root: URL) async throws {
    let base = root.appendingPathComponent("primary-torn")
    let authority: [String: Any] = ["kind": "primary", "sourceId": "literal-primary"]
    for mode in ["permission", "occupied", "no-video", "no-origin"] {
        let folder = root.appendingPathComponent("primary-\(mode)")
        try FileManager.default.copyItem(at: base, to: folder)
        try FileManager.default.removeItem(at: folder.appendingPathComponent("source.publication.json"))
        try FileManager.default.removeItem(at: folder.appendingPathComponent("source.journal.jsonl"))
        if mode == "permission" { try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path) }
        if mode == "occupied" { try Data("occupied authority name".utf8).write(to: folder.appendingPathComponent("source.journal.jsonl")) }
        if mode == "no-video" { try FileManager.default.removeItem(at: folder.appendingPathComponent("video.mov")) }
        if mode == "no-origin" {
            let journal = folder.appendingPathComponent("capture.journal.jsonl")
            let first = try Data(contentsOf: journal).split(separator: 10)[0] + Data([10])
            try first.write(to: journal)
        }
        let response = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "primary-\(mode)")
        let data = response["data"] as! [String: Any]; let source = data["sourcePublication"] as! [String: Any]
        let expectedCode = ["permission": "PUBLICATION_FAILED", "occupied": "INVALID_JOURNAL_PREFIX",
            "no-video": "INVALID_MEDIA", "no-origin": "INVALID_JOURNAL_PREFIX"][mode]!
        precondition(source["state"] as? String == (mode == "permission" ? "pending" : "unavailable")
            && (source["error"] as? [String: Any])?["code"] as? String == expectedCode,
            "Only operational publication failure may stay pending (\(mode)): \(response)")
        if mode == "permission" {
            precondition(data["durationUs"] as? Int == 300000)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            _ = try await recoveryWire("media.recover", params: ["directory": folder.path, "sourceAuthority": authority], root: root, name: "primary-permission-retry")
        }
    }
    let canceled = root.appendingPathComponent("cancel-after-snapshot")
    try FileManager.default.copyItem(at: base, to: canceled)
    try FileManager.default.removeItem(at: canceled.appendingPathComponent("source.publication.json"))
    try FileManager.default.removeItem(at: canceled.appendingPathComponent("source.journal.jsonl"))
    let work = Task.detached {
        try await MediaRecovery.recover(directory: canceled.path, sourceAuthority: .init(kind: .primary, sourceId: "literal-primary"))
    }
    let snapshot = canceled.appendingPathComponent("source.journal.jsonl")
    for _ in 0..<2000 {
        if FileManager.default.fileExists(atPath: snapshot.path) { break }
        try await Task.sleep(for: .microseconds(100))
    }
    precondition(FileManager.default.fileExists(atPath: snapshot.path), "Cancellation must occur after first support inspection and snapshot publication")
    work.cancel()
    do { _ = try await work.value; preconditionFailure("In-flight authority cancellation cannot publish") }
    catch is CancellationError {}
    precondition(!FileManager.default.fileExists(atPath: canceled.appendingPathComponent("source.publication.json").path))
    _ = try await recoveryWire("media.recover", params: ["directory": canceled.path, "sourceAuthority": authority], root: root, name: "cancel-after-snapshot-retry")
}
