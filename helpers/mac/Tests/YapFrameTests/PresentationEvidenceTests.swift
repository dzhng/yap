import Foundation
import YapFrames
import YapMedia

/// A destination created by another owner while evidence is still being written must survive, and
/// the evidence must neither replace it nor leave its private staging behind.
func verifyPresentationPublicationRace(source: URL, parent: URL) async throws {
    let directory = parent.appendingPathComponent("presentation-race-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let rows = (0..<10_000).map { index in
        [
            "source": ["startUs": index * 2, "endUs": index * 2 + 1],
            "playback": ["startUs": index, "endUs": index + 1],
        ]
    }
    let plan = try JSONDecoder().decode(
        [VideoRenderSpan].self,
        from: JSONSerialization.data(withJSONObject: rows))
    let output = directory.appendingPathComponent("raced.jsonl")
    let task = Task.detached {
        try await PresentationEvidence.write(
            source: source, plan: plan, output: output)
    }
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while true {
        let staging = try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )
        .first { $0.lastPathComponent.hasPrefix(".yap-output-") }
        if let staging,
            let attributes = try? FileManager.default.attributesOfItem(
                atPath: staging.appendingPathComponent("evidence.jsonl").path),
            let bytes = attributes[.size] as? Int, bytes > 1000
        {
            break
        }
        precondition(ContinuousClock.now < deadline, "Evidence did not make bounded forward progress")
        try await Task.sleep(for: .milliseconds(2))
    }
    try Data("unrelated destination".utf8).write(to: output, options: .withoutOverwriting)
    do {
        _ = try await task.value
        preconditionFailure("Raced evidence must not publish")
    } catch let error as NativeFailure {
        precondition(error.code == "INVALID_OUTPUT", "\(error)")
    }
    let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    precondition(!remaining.contains { $0.hasPrefix(".yap-output-") })
    let survivor = try Data(contentsOf: output)
    precondition(survivor == Data("unrelated destination".utf8))
    print("PASS presentation evidence never replaces a destination created while it was written")
}
