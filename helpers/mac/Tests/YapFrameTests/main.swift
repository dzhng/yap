@preconcurrency import AVFoundation
import Foundation
import YapFrames
import YapMedia

// Outputs are published only at new paths, so a run starts from an empty evidence directory. A
// caller that supplies one supplies a fresh one.
let evidence: URL
if let supplied = ProcessInfo.processInfo.environment["YAP_FRAME_EVIDENCE"] {
    evidence = URL(fileURLWithPath: supplied)
} else {
    evidence = URL(fileURLWithPath: NSTemporaryDirectory() + "yap-frame-tests-" + UUID().uuidString)
}
try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
func cleanupEvidence() {
    if ProcessInfo.processInfo.environment["YAP_FRAME_EVIDENCE"] == nil {
        try? FileManager.default.removeItem(at: evidence)
    }
}
defer { cleanupEvidence() }
func finish() -> Never { cleanupEvidence(); exit(0) }
let images = evidence.appendingPathComponent("images")
try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)

if CommandLine.arguments.contains("--face-observations") {
    try verifyFaceObservations(in: images)
    finish()
}

if CommandLine.arguments.contains("--picture-observations") {
    try verifyPictureObservations(in: images)
    finish()
}

if CommandLine.arguments.contains("--lut") {
    try await verifyLUTs(in: images)
    finish()
}

if CommandLine.arguments.contains("--sdr-correction") {
    try await verifySDRCorrection(in: images)
    finish()
}

if CommandLine.arguments.contains("--composition-identity") {
    try await verifyCompositionPNG(in: images)
    finish()
}

if CommandLine.arguments.contains("--source-authority") {
    try await verifySourceAuthority(in: images)
    finish()
}

if CommandLine.arguments.contains("--pointer-readability") {
    try await verifyCompositionPointerReadability(in: images)
    finish()
}

if CommandLine.arguments.contains("--text-vertical") {
    try verifyTextVerticalPlacement()
    finish()
}

if CommandLine.arguments.contains("--text-decorations") {
    try verifyTextDecorations()
    finish()
}

if CommandLine.arguments.contains("--text-highlights") {
    try verifyTextHighlights()
    finish()
}

if CommandLine.arguments.contains("--text-fallback") {
    try verifyTextFallback()
    finish()
}

if CommandLine.arguments.contains("--blend-modes") {
    try await verifyCompositionBlends(in: images)
    finish()
}

if CommandLine.arguments.contains("--composition-downscale") {
    try await verifyCompositionMovieDownscale(in: images)
    finish()
}

try verifyFaceObservations(in: images)
try verifyPictureObservations(in: images)
try await verifySDRCorrection(in: images)
try await verifyCompositionPNG(in: images)
try await verifyCompositionSourceColors(in: images)
try await verifyCompositionMovieTerminal(in: images)
if CommandLine.arguments.contains("--composition-png") { finish() }

try await verifyExactPresentation(in: images)
if CommandLine.arguments.contains("--exact-picture") { finish() }

try await verifySourcePictures(in: images)
try await verifySourceAuthority(in: images)
if CommandLine.arguments.contains("--source-pictures") { finish() }

try await verifyCompositionPointerReadability(in: images)

func steps(_ count: Int, everyUs: Int64) -> [CMTime] {
    (0..<count).map { CMTime(value: Int64($0) * everyUs, timescale: 1_000_000) }
}

let stepsFixture = evidence.appendingPathComponent("steps-10fps.mp4")
try await FixtureWriter.write(to: stepsFixture, times: steps(30, everyUs: 100_000))
let stepsTruth = try await FixtureTruth.presentationMicroseconds(of: stepsFixture)
precondition(
    stepsTruth == (0..<30).map { Int64($0) * 100_000 },
    "Fixture must present 30 frames every 100000us, got \(stepsTruth)")
print("PASS fixture presents \(stepsTruth.count) samples from \(stepsTruth.first!) to \(stepsTruth.last!)us")

try await verifySourceSceneBounds(source: stepsFixture)

try await verifyPresentationPublicationRace(source: stepsFixture, parent: evidence)
print("PASS current source and composition picture evidence written to \(evidence.path)")
