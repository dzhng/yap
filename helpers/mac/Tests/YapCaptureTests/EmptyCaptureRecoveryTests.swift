import Darwin
import Foundation
import YapMedia
import YapWire

@MainActor
func runEmptyCaptureRecoveryTests(output: String? = nil) async throws {
    let root = output.map { URL(fileURLWithPath: $0) } ?? RecoveryFixture.directory("empty-capture-recovery")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
    let source = root.appendingPathComponent("primary")
    try FileManager.default.createDirectory(at: source, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
    let params: [String: Any] = ["directory": source.path,
        "sourceAuthority": ["kind": "primary", "sourceId": "empty-source"]]
    let result = try await emptyRecoveryWire(params, root: root, name: "empty-primary")
    guard result["ok"] as? Bool == true, let data = result["data"] as? [String: Any],
        data["inputsClosed"] as? Bool == true, data["durationUs"] as? Int == 0,
        let outcome = data["sourcePublication"] as? [String: Any], outcome["state"] as? String == "unavailable",
        let error = outcome["error"] as? [String: Any], error["code"] as? String == "NO_SOURCE_MEDIA" else {
        throw NativeFailure("TEST_FAILED", "Empty allocation did not close unavailable: \(result)")
    }
    let members = try FileManager.default.contentsOfDirectory(atPath: source.path)
    precondition(members.isEmpty,
        "Empty recovery cannot manufacture authority files")
    let retry = try await emptyRecoveryWire(params, root: root, name: "empty-primary-retry")
    precondition(NSDictionary(dictionary: retry["data"] as! [String: Any]).isEqual(to: data),
        "Retry after a lost reply must preserve the unavailable fact")
    let camera = root.appendingPathComponent("camera")
    try FileManager.default.createDirectory(at: camera, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
    let cameraResult = try await emptyRecoveryWire(["directory": camera.path, "sourceAuthority": [
        "kind": "camera", "sourceId": "empty-camera", "binding": [
            "recordingId": "empty-take", "sourceId": "empty-camera", "deviceId": "fixture-device"]]],
        root: root, name: "empty-camera")
    precondition(NSDictionary(dictionary: cameraResult["data"] as! [String: Any]).isEqual(to: data),
        "Allocated camera emptiness must close independently")
    // A reserved camera that never delivered a picture (never turned on, or crashed before its
    // first one) leaves only its mapping. Recovery closes it unavailable and keeps the mapping.
    // This build leaves it empty when no camera callback arrived; 0.1.33 also logged screen rows.
    let mapping = camera.appendingPathComponent("camera.mapping.jsonl")
    for (name, rows) in [("empty", Data()), ("0.1.33", Data("{\"role\":\"screen\"}\n".utf8))] {
        try rows.write(to: mapping)
        let mappingOnly = try await emptyRecoveryWire(["directory": camera.path, "sourceAuthority": [
            "kind": "camera", "sourceId": "empty-camera", "binding": [
                "recordingId": "empty-take", "sourceId": "empty-camera", "deviceId": "fixture-device"]]],
            root: root, name: "mapping-only-camera-\(name)")
        guard mappingOnly["ok"] as? Bool == true, let mappingData = mappingOnly["data"] as? [String: Any],
            mappingData["inputsClosed"] as? Bool == true,
            let mappingOutcome = mappingData["sourcePublication"] as? [String: Any], mappingOutcome["state"] as? String == "unavailable",
            (mappingOutcome["error"] as? [String: Any])?["code"] as? String == "NO_CAMERA" else {
            throw NativeFailure("TEST_FAILED", "A \(name) mapping-only camera did not close unavailable: \(mappingOnly)")
        }
        let retained = try Data(contentsOf: mapping), cameraMembers = try FileManager.default.contentsOfDirectory(atPath: camera.path)
        precondition(retained == rows && cameraMembers == ["camera.mapping.jsonl"],
            "Recovery keeps the \(name) mapping and manufactures nothing")
        try FileManager.default.removeItem(at: mapping)
    }
    let generic = try await emptyRecoveryWire(["directory": source.path], root: root, name: "directory-only-empty")
    let genericData = generic["data"] as! [String: Any]
    precondition(generic["ok"] as? Bool == true && genericData["durationUs"] as? Int == 0
        && genericData["inputsClosed"] == nil && genericData["sourcePublication"] == nil,
        "Directory-only media recovery cannot acquire source closure authority")
    try await emptyRecoveryRefusals(root: root, source: source, params: params)
    print("PASS native empty allocated source closes unavailable without manufacturing authority")
}

@MainActor
private func emptyRecoveryRefusals(root: URL, source: URL, params: [String: Any]) async throws {
    func refused(_ params: [String: Any], _ name: String, retryable: Bool? = nil) async throws {
        let response = try await emptyRecoveryWire(params, root: root, name: name)
        precondition(response["ok"] as? Bool == false && response["data"] == nil,
            "\(name) cannot infer closure or source outcome: \(response)")
        let error = response["error"] as! [String: Any]
        // Retryability belongs to the shared refusal ledger; native carries only the code.
        precondition(error["retryable"] == nil, "\(name) must not state its own retryability: \(response)")
        if let retryable {
            let expected = retryable ? "RECOVERY_FAILED" : "RECOVERY_REFUSED"
            precondition(error["code"] as? String == expected, "\(name) must refuse as \(expected): \(response)")
        }
    }
    for name in ["unknown.bin", "camera.raw.mov", "camera.mapping.jsonl"] {
        let member = source.appendingPathComponent(name), bytes = Data("retained unknown input\n".utf8)
        try bytes.write(to: member)
        try await refused(params, "retained-\(name)", retryable: true)
        let retained = try Data(contentsOf: member)
        precondition(retained == bytes, "Retained bytes cannot be inspected away or rewritten")
        try FileManager.default.removeItem(at: member)
    }
    let alias = root.appendingPathComponent("source-link")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: source)
    var symlink = params; symlink["directory"] = alias.path
    try await refused(symlink, "symlink-directory")
    var absent = params; absent["directory"] = root.appendingPathComponent("absent").path
    try await refused(absent, "absent-directory", retryable: true)
    let fd = Darwin.open(source.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    precondition(fd >= 0); defer { close(fd) }
    precondition(flock(fd, LOCK_EX | LOCK_NB) == 0)
    try await refused(params, "held-directory", retryable: true)
    precondition(flock(fd, LOCK_UN) == 0)
    precondition(chmod(source.path, 0) == 0)
    do { try await refused(params, "unreadable-directory", retryable: true) }
    catch { chmod(source.path, 0o700); throw error }
    precondition(chmod(source.path, 0o700) == 0)
    precondition(chmod(source.path, 0o755) == 0)
    do { try await refused(params, "nonprivate-directory") }
    catch { chmod(source.path, 0o700); throw error }
    precondition(chmod(source.path, 0o700) == 0)
    let invalidAuthorities: [[String: Any]] = [
        ["kind": "primary", "sourceId": ""],
        ["kind": "primary", "sourceId": String(repeating: "s", count: 257)],
        ["kind": "camera", "sourceId": "empty-camera"],
        ["kind": "camera", "sourceId": "empty-camera", "binding": [
            "recordingId": "empty-take", "sourceId": "other-camera", "deviceId": "fixture-device"]],
    ]
    for (index, authority) in invalidAuthorities.enumerated() {
        var invalid = params; invalid["sourceAuthority"] = authority
        try await refused(invalid, "invalid-authority-\(index)", retryable: false)
    }
    let canceled = Task {
        let response = try await emptyRecoveryWire(params, root: root, name: "canceled-empty")
        precondition(response["ok"] as? Bool == false && response["data"] == nil,
            "Cancellation must remain an outer refusal")
    }
    canceled.cancel()
    try await canceled.value
    let reopened = try await emptyRecoveryWire(params, root: root, name: "empty-primary-reopened")
    precondition(reopened["ok"] as? Bool == true)
    let members = try FileManager.default.contentsOfDirectory(atPath: source.path)
    precondition(members.isEmpty)
}

@MainActor
private func emptyRecoveryWire(_ params: [String: Any], root: URL, name: String) async throws -> [String: Any] {
    let request = try JSONSerialization.data(withJSONObject: ["id": name, "operation": "media.recover", "params": params], options: [.sortedKeys])
    try request.write(to: root.appendingPathComponent("\(name)-request.json"))
    let response = await NativeWire.respond(to: String(decoding: request, as: UTF8.self))
    try response.write(to: root.appendingPathComponent("\(name)-response.json"))
    return try JSONSerialization.jsonObject(with: response) as! [String: Any]
}
