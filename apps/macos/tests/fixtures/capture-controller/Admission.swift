import Foundation
import YapCapture

func diagnostic(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }

@main @MainActor struct Admission {
    static func main() async throws {
        var observed: CaptureSource?
        let native = NativeCapture(prepareInput: { request, _ in
            observed = request.source
            throw CaptureFailure("SELECTION_OBSERVED", "Admission reached physical input preparation")
        })
        let controller = CaptureController(fixtureWindow: nil, capture: native)
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
        let allocation: [String: Any] = [
            "recordingId": "recording", "sourceId": "source", "outputDirectory": "/tmp/unused-camera-source",
        ]
        let fields = allocation.merging(fixture["selection"] as! [String: Any]) { _, selection in selection }
        let answer = await controller.handle("capture.start", try JSONSerialization.data(withJSONObject: fields))
        guard case .failure(let failure) = answer else { preconditionFailure("Preparation intentionally refuses IO") }
        precondition(failure.code == "SELECTION_OBSERVED", "A primary camera reaches native preparation: \(failure.code)")
        guard let admitted = observed else { preconditionFailure("No input selection observed") }
        let source = try JSONSerialization.jsonObject(with: JSONEncoder().encode(admitted)) as! [String: Any]
        precondition(source["kind"] as? String == "camera" && source["deviceID"] as? String == "chosen-camera",
                     "Native preparation retains the exact primary camera identity")
        var invalid = fixture["invalidSelections"] as! [[String: Any]]
        invalid.append([
            "source": ["kind": "camera", "id": "chosen-camera"], "microphone": false, "systemAudio": false,
            "cameraDeviceId": "companion", "cameraSourceId": "companion-source", "cameraDirectory": "/tmp/unused-companion",
        ])
        for selection in invalid {
            observed = nil
            let answer = await controller.handle("capture.start", try JSONSerialization.data(withJSONObject:
                allocation.merging(selection) { _, selection in selection }))
            guard case .failure(let failure) = answer else { preconditionFailure("Malformed camera selection must refuse") }
            precondition(failure.code == "INVALID_REQUEST" && observed == nil,
                         "Malformed or companion-conflicting primary cannot reach physical preparation: \(failure.code)")
        }
        let catalog = try await CaptureController.discoverSources(screenAuthorized: false,
            screens: { throw CaptureFailure("UNREQUESTED_SCREEN", "Screen discovery must stay unused") },
            cameras: { [.init(id: "chosen-camera", name: "Studio Camera")] },
            microphones: { [.init(id: "chosen-mic", name: "Studio Microphone", isDefault: true)] })
        precondition((catalog["displays"] as? [[String: Any]])?.isEmpty == true
                     && (catalog["windows"] as? [[String: Any]])?.isEmpty == true)
        let cameras = catalog["cameras"] as! [[String: Any]]
        let microphones = catalog["microphones"] as! [[String: Any]]
        precondition(cameras.first?["id"] as? String == "chosen-camera"
                     && microphones.first?["id"] as? String == "chosen-mic",
                     "Denied screen access must retain honest camera and microphone discovery")
        do {
            _ = try await CaptureController.discoverSources(screenAuthorized: true,
                screens: { throw CaptureFailure("SCREEN_ENUMERATION_FAILED", "An authorized screen listing failed") },
                cameras: { [.init(id: "chosen-camera", name: "Studio Camera")] },
                microphones: { [] })
            preconditionFailure("An actual screen discovery error must remain visible")
        } catch let failure as CaptureFailure {
            precondition(failure.code == "SCREEN_ENUMERATION_FAILED")
        }
        print("PASS camera-primary admission retains selected device without opening inputs")
    }
}
