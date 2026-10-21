@preconcurrency import AVFoundation
import Foundation
@testable import YapFrames
import YapMedia

/// A review frame of a source shows the person's marks the way they saw them at that moment: at
/// full strength, partly faded, or gone, and as large as they were on screen.
func verifySourceInk(in parent: URL) async throws {
    let directory = parent.appendingPathComponent("source-ink")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let source = directory.appendingPathComponent("source.mp4")
    try await FixtureWriter.write(to: source, times: (0..<8).map { CMTime(value: Int64($0), timescale: 10) })
    let track = try await AVURLAsset(url: source).loadTracks(withMediaType: .video)[0]

    func render(_ name: String, atUs: Int64 = 500_000, ink: [String: Any]?) async throws -> FixtureImage {
        let output = directory.appendingPathComponent(name + ".png")
        var body: [String: Any] = [
            "asset": ["assetId": "source", "streamId": "track:\(track.trackID)", "path": source.path, "originUs": 0],
            "available": [["startUs": 0, "endUs": 800_000]],
            "atUs": atUs, "output": output.path,
        ]
        if let ink { body["cursorOverlay"] = ["trail": [], "trailUs": 0, "ink": ink] }
        _ = try await SourceFrameRenderer.write(JSONDecoder().decode(
            SourceFrameRenderer.Request.self, from: JSONSerialization.data(withJSONObject: body)))
        return try FixtureImage(contentsOf: output)
    }
    func pin(fromUs: Int64, untilUs: Int64, scale: Double = 1) -> [String: Any] {
        [
            "scale": scale,
            "marks": [[
                "kind": "pin", "pin": 1, "runs": [[["x": 100.0, "y": 120.0]]],
                "fade": ["fromUs": fromUs, "untilUs": untilUs],
            ]],
        ]
    }
    func redness(_ color: (red: Double, green: Double, blue: Double)) -> Double {
        color.red - max(color.green, color.blue)
    }

    let clean = try await render("clean", ink: nil)
    // The badge's number is white, so its fill is read below the centre rather than on it.
    let fill = (x: 97, y: 127)
    let full = try await render("pin-full", ink: pin(fromUs: 600_000, untilUs: 700_000))
    let fading = try await render("pin-fading", ink: pin(fromUs: 400_000, untilUs: 600_000))
    precondition(
        redness(full.color(x: fill.x, y: fill.y)) > 0.6,
        "A pin before its fade is drawn in full ink, got \(full.color(x: fill.x, y: fill.y))")
    let partly = redness(fading.color(x: fill.x, y: fill.y))
    precondition(
        partly > redness(clean.color(x: fill.x, y: fill.y)) + 0.1
            && partly < redness(full.color(x: fill.x, y: fill.y)) - 0.1,
        "A pin halfway through its fade shows partly, got \(fading.color(x: fill.x, y: fill.y))")
    let gone = try await render("pin-gone", ink: pin(fromUs: 300_000, untilUs: 500_000))
    precondition(gone.difference(to: clean) == 0, "A pin whose fade has ended is not drawn")

    // On a Retina display a point is two pixels, and so is the ink in a frame of it.
    let outside = (x: 120, y: 117)
    let retina = try await render("pin-retina", ink: pin(fromUs: 600_000, untilUs: 700_000, scale: 2))
    precondition(
        redness(retina.color(x: outside.x, y: outside.y)) > 0.6
            && redness(full.color(x: outside.x, y: outside.y)) < 0.3,
        "A pin keeps the size it had on screen, got \(retina.color(x: outside.x, y: outside.y)) and \(full.color(x: outside.x, y: outside.y))")

    let stroke = try await render("stroke-drawing", ink: [
        "scale": 1,
        "marks": [[
            "kind": "stroke",
            "runs": [[["x": 40.0, "y": 60.0], ["x": 280.0, "y": 60.0]]],
        ]],
    ])
    precondition(
        redness(stroke.color(x: 160, y: 58, height: 4)) > 0.6,
        "A stroke still being drawn shows at full strength, got \(stroke.color(x: 160, y: 58, height: 4))")
    print("PASS a review frame shows the person's marks as they saw them at that moment")
}
