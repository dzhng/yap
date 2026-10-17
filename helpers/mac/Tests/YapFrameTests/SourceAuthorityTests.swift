@preconcurrency import AVFoundation
import Darwin
import Foundation
@testable import YapFrames
import YapMedia

func verifySourceAuthority(in parent: URL) async throws {
    let directory = parent.appendingPathComponent("source-authority")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let source = directory.appendingPathComponent("source.mp4")
    try await FixtureWriter.write(to: source, times: (0..<3).map { CMTime(value: Int64($0), timescale: 10) })
    let reference = try await PresentationSource(source: source, streamId: nil, startUs: 0)
    func pixels(_ selection: PresentationSource.Selection) throws -> Data {
        let buffer = selection.buffer!
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        var bytes = Data()
        for row in 0..<CVPixelBufferGetHeight(buffer) {
            bytes.append(Data(bytes: CVPixelBufferGetBaseAddress(buffer)!.advanced(
                by: row * CVPixelBufferGetBytesPerRow(buffer)), count: CVPixelBufferGetWidth(buffer) * 4))
        }
        return bytes
    }
    let expected = try pixels(reference.selection(at: time(microseconds: 200_000), end: .positiveInfinity))
    let descriptor = open(source.path, O_RDONLY | O_CLOEXEC)
    precondition(descriptor >= 0)
    let media = try await PresentationSource.prepare(
        source: URL(fileURLWithPath: "/dev/fd/\(descriptor)"), streamId: nil)
    let normalInput = try MediaInput(url: source)
    let normalMedia = try await PresentationSource.prepare(source: source, streamId: nil)
    close(descriptor)
    try FileManager.default.removeItem(at: source)
    try Data("replacement is not a movie".utf8).write(to: source)
    let delayedDuration = try await normalInput.asset.load(.duration)
    precondition(delayedDuration == media.duration,
        "Normal path authority must survive replacement even before metadata is loaded")
    let retained = try PresentationSource(media: media, startUs: 0)
    let selected = try retained.selection(at: time(microseconds: 200_000), end: .positiveInfinity)
    let actual = try pixels(selected)
    try expected.write(to: directory.appendingPathComponent("expected.bgra"))
    try actual.write(to: directory.appendingPathComponent("actual.bgra"))
    precondition(selected.sampleTime == time(microseconds: 200_000) && actual == expected,
        "Prepared presentation must retain original pixels after caller close and source unlink")
    let normal = try PresentationSource(media: normalMedia, startUs: 0)
    let normalSelected = try normal.selection(at: time(microseconds: 200_000), end: .positiveInfinity)
    let normalPixels = try pixels(normalSelected)
    try normalPixels.write(to: directory.appendingPathComponent("normal.bgra"))
    precondition(normalSelected.sampleTime == selected.sampleTime && normalPixels == expected,
        "Prepared normal-path presentation must decode admitted bytes after path replacement")
    let oversized = directory.appendingPathComponent("oversized.mov")
    let headerSize = 65 * 1024 * 1024
    var prefix = Data(repeating: 0, count: 12)
    for index in 0..<4 { prefix[index] = UInt8((headerSize >> (24 - index * 8)) & 255) }
    prefix.replaceSubrange(4..<12, with: Data("ftypqt  ".utf8))
    try prefix.write(to: oversized)
    let large = try FileHandle(forWritingTo: oversized)
    try large.truncate(atOffset: UInt64(headerSize))
    try large.close()
    do {
        _ = try await PresentationSource.prepare(source: oversized, streamId: nil)
        preconditionFailure("Oversized metadata must refuse")
    } catch let refusal as NativeFailure {
        precondition(refusal.code == "LIMIT_EXCEEDED",
            "Metadata budget refusal must preserve its deterministic native meaning")
    }
    print("PASS inherited and normal-path presentation retain unchanged pixels/sample time after close, unlink and replacement; unopened metadata retains the same source")
}
