import CoreMedia
import CryptoKit
import Foundation
import YapCapture

func runPCMJournalTests() throws {
  let retained = ProcessInfo.processInfo.environment["YAP_PCM_JOURNAL_OUTPUT"]
  let directory = retained.map { URL(fileURLWithPath: $0) } ?? RecoveryFixture.directory("accepted-pcm-journal")
  if retained != nil { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false) }
  defer { if retained == nil { try? FileManager.default.removeItem(at: directory) } }
  let journal = try CaptureJournal(
    directory: directory.path,
    header: CaptureJournalHeader(
      schemaVersion: 2, sessionID: "offline-mapping", source: CaptureSource(kind: "fixture"),
      width: 160, height: 96, microphone: true, systemAudio: true))
  // Serialization preserves raw flags/epoch; this does not authorize these values for admission.
  let raw = CMTime(
    value: Int64.max - 1, timescale: 1_000_000_000,
    flags: [.valid, .hasBeenRounded], epoch: Int64.min + 1)
  try journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: raw, declaredHostUs: 100_000_000))
  try journal.recordPCMTrack(
    JournalPCMTrack(role: "narration", rate: 48000, channels: 1, phaseUs: 100001))
  do {
    try journal.recordAudioSamples(role: "narration", startUs: 0, endUs: 1000)
    preconditionFailure("Schema2 cannot write legacy acquisition claims")
  } catch let error as CaptureFailure { precondition(error.code == "INVALID_JOURNAL") }
  do {
    try journal.recordPCMAppend(JournalPCMAppend(role: "narration", physicalFirstFrame: 0,
      frameCount: 1024, declaredFirstFrame: 1, rawPTS: raw, removedPauseUs: 0))
    preconditionFailure("The first accepted buffer establishes phase at frame zero")
  } catch let error as CaptureFailure { precondition(error.code == "INVALID_JOURNAL") }
  var received: [JournalPCMAppend] = []
  let empty = try CaptureJournal.streamAcceptedPCM(directory: directory.path) {
    received.append($0)
  }
  precondition(received.isEmpty && empty.acquiredAudio.isEmpty)
  try journal.recordPCMAppend(
    JournalPCMAppend(
      role: "narration", physicalFirstFrame: 0,
      frameCount: 8192, declaredFirstFrame: 0, rawPTS: raw, removedPauseUs: 0))
  try journal.recordPCMAppend(
    JournalPCMAppend(
      role: "narration", physicalFirstFrame: 8192,
      frameCount: 8192, declaredFirstFrame: 16384, rawPTS: raw, removedPauseUs: 500000))
  var origin: JournalPCMOrigin?
  let read = try CaptureJournal.streamAcceptedPCM(
    directory: directory.path, origin: { origin = $0 }
  ) {
    received.append($0)
  }
  precondition(read.invalidAtSequence == nil && read.acquiredAudio.isEmpty)
  precondition(received.map(\.physicalFirstFrame) == [0, 8192])
  precondition(received.map(\.declaredFirstFrame) == [0, 16384])
  precondition(received[1].removedPauseUs == 500000)
  precondition(origin?.rawPTS.value == raw.value && origin?.rawPTS.epoch == raw.epoch)
  precondition(
    origin?.rawPTS.flags == raw.flags.rawValue && origin?.rawPTS.timescale == raw.timescale)
  let inspected = try CaptureJournal.inspect(directory: directory.path)
  precondition(inspected.header?.sessionID == "offline-mapping" && inspected.invalidAtSequence == nil
    && inspected.acquiredAudio.isEmpty && inspected.lastSequence == read.lastSequence,
    "Inspection must accept the persisted packed layout without inventing legacy audio ranges")
  let path = directory.appendingPathComponent("capture.journal.jsonl")
  let frozen = try Data(contentsOf: path)
  func assertPrefix(_ actual: JournalPrefix?, bytes: Data) {
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    precondition(actual?.bytes == Int64(bytes.count) && actual?.sha256 == digest,
      "Accepted journal read must identify its exact validated byte prefix")
  }
  assertPrefix(read.validatedPrefix, bytes: frozen)
  if retained != nil {
    try JSONEncoder().encode(read.validatedPrefix).write(to: directory.appendingPathComponent("validated-prefix.json"))
  }
  precondition(inspected.validatedPrefix == nil)
  let serialized = try JSONSerialization.jsonObject(with: JSONEncoder().encode(read)) as! [String: Any]
  precondition(serialized["validatedPrefix"] == nil, "Mapping provenance must not change ordinary wire summaries")
  _ = try journal.recordLifecycle(state: "finalizing", reason: nil)
  let extended = try Data(contentsOf: path)
  let later = try CaptureJournal.streamAcceptedPCM(directory: directory.path) { _ in }
  assertPrefix(later.validatedPrefix, bytes: extended)
  precondition(later.validatedPrefix != read.validatedPrefix)
  assertPrefix(read.validatedPrefix, bytes: Data(extended.prefix(frozen.count)))
  var pinnedFrames: [Int64] = []
  let pinned = try CaptureJournal.streamAcceptedPCM(lease: journal.lease, through: read.validatedPrefix!) {
    pinnedFrames.append($0.declaredFirstFrame)
  }
  precondition(pinned.validatedPrefix == read.validatedPrefix && pinned.lastSequence == read.lastSequence)
  precondition(pinnedFrames == [0, 16384])
  func refusePrefix(_ token: JournalPrefix) throws {
    do {
      _ = try CaptureJournal.streamAcceptedPCM(lease: journal.lease, through: token) { _ in }
      preconditionFailure("Invalid prefix must not return validated evidence")
    } catch let failure as CaptureFailure { precondition(failure.code == "INVALID_JOURNAL_PREFIX") }
  }
  try refusePrefix(JournalPrefix(bytes: Int64(frozen.count), sha256: String(repeating: "0", count: 64)))
  let partial = Data(frozen.dropLast())
  try refusePrefix(JournalPrefix(bytes: Int64(partial.count), sha256: SHA256.hash(data: partial).map { String(format: "%02x", $0) }.joined()))
  try refusePrefix(JournalPrefix(bytes: Int64(extended.count + 100), sha256: read.validatedPrefix!.sha256))
  try journal.recordPCMAppend(JournalPCMAppend(role: "narration", physicalFirstFrame: 16384,
    frameCount: 1024, declaredFirstFrame: 32768, rawPTS: raw, removedPauseUs: 500000))
  var afterAppend: [Int64] = []
  _ = try CaptureJournal.streamAcceptedPCM(lease: journal.lease, through: read.validatedPrefix!) { afterAppend.append($0.declaredFirstFrame) }
  precondition(afterAppend == pinnedFrames, "Later accepted appends cannot enlarge the pinned mapping")
  let stillCurrent = try CaptureJournal.streamAcceptedPCM(lease: journal.lease) { _ in }
  precondition(stillCurrent.lastSequence == later.lastSequence + 1)
  try frozen.write(to: path, options: .atomic)
  let lines = String(data: frozen, encoding: .utf8)!.split(separator: "\n").map(String.init)
  func checkPrefix(_ altered: [String], acceptedCount: Int, invalid: Int?, torn: Bool = false)
    throws
  {
    try (altered.joined(separator: "\n") + (torn ? "" : "\n")).write(
      to: path, atomically: true, encoding: .utf8)
    var prefix: [Int64] = []
    let result = try CaptureJournal.streamAcceptedPCM(directory: directory.path) {
      prefix.append($0.physicalFirstFrame)
    }
    precondition(prefix == Array([Int64(0), 8192].prefix(acceptedCount)))
    precondition(result.invalidAtSequence == invalid && result.incompleteTail == torn)
    precondition(result.acquiredAudio.isEmpty)
    let validCount = invalid.map { $0 - 1 } ?? (altered.count - (torn ? 1 : 0))
    precondition(result.lastSequence == validCount)
    let validLines = Array(altered.prefix(validCount))
    let validBytes = Data((validLines.isEmpty ? "" : validLines.joined(separator: "\n") + "\n").utf8)
    assertPrefix(result.validatedPrefix, bytes: validBytes)
  }
  try checkPrefix(lines.map { "  " + $0 + " \t\r" }, acceptedCount: 2, invalid: nil)
  // Terminated corruption and an uncommitted final line retain the same earlier mapping only.
  var corrupt = lines
  corrupt[4] = corrupt[4].replacingOccurrences(
    of: "\"physicalFirstFrame\":\"8192\"", with: "\"physicalFirstFrame\":\"8193\"")
  precondition(corrupt != lines)
  try checkPrefix(corrupt, acceptedCount: 1, invalid: 5)
  try checkPrefix(lines, acceptedCount: 1, invalid: nil, torn: true)
  corrupt = lines
  corrupt[4] = corrupt[4].replacingOccurrences(of: "pcmAppend", with: "unrecognizedMapping")
  try checkPrefix(corrupt, acceptedCount: 1, invalid: 5)
  corrupt = lines
  corrupt[2] = corrupt[2].replacingOccurrences(of: "pcm-f32le-interleaved", with: "unsupported-format")
  try checkPrefix(corrupt, acceptedCount: 0, invalid: 3)
  corrupt = lines
  corrupt[1] = corrupt[1].replacingOccurrences(
    of: "\"value\":\"9223372036854775806\"", with: "\"value\":9223372036854775806")
  precondition(corrupt != lines)
  try checkPrefix(corrupt, acceptedCount: 0, invalid: 2)
  corrupt = lines
  corrupt[4] = corrupt[4].replacingOccurrences(of: "\"declaredFirstFrame\":\"16384\"", with: "\"declaredFirstFrame\":\"1\"")
  try checkPrefix(corrupt, acceptedCount: 1, invalid: 5)
  // Removing a required phase record is corruption, even with repaired sequence numbers.
  corrupt = lines
  corrupt.remove(at: 2)
  corrupt[2] = corrupt[2].replacingOccurrences(of: "\"sequence\":4", with: "\"sequence\":3")
  try checkPrefix(corrupt, acceptedCount: 0, invalid: 3)
  try frozen.write(to: path, options: .atomic)
  // Large physical addresses are serialization controls, not claimed real buffer sizes.
  let boundary = JournalPCMAppend(
    role: "system", physicalFirstFrame: Int64.max - 1,
    frameCount: 1, declaredFirstFrame: Int64.max - 1,
    rawPTS: CMTime(value: Int64.min, timescale: 44100, flags: .valid, epoch: Int64.max),
    removedPauseUs: 9_007_199_254_740_993)
  let bytes = try JSONEncoder().encode(boundary)
  if retained != nil { try bytes.write(to: directory.appendingPathComponent("integer-boundaries.json")) }
  let decoded = try JSONDecoder().decode(JournalPCMAppend.self, from: bytes)
  let json = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
  precondition(json["physicalFirstFrame"] as? String == String(Int64.max - 1))
  precondition(
    decoded.physicalFirstFrame == boundary.physicalFirstFrame
      && decoded.removedPauseUs == boundary.removedPauseUs)
  precondition(decoded.rawPTS.value == Int64.min && decoded.rawPTS.epoch == Int64.max)
  let roles = RecoveryFixture.directory("independent-pcm-roles")
  defer { try? FileManager.default.removeItem(at: roles) }
  let dual = try CaptureJournal(directory: roles.path, header: CaptureJournalHeader(
    schemaVersion: 2, sessionID: "roles", source: CaptureSource(kind: "fixture"),
    width: 160, height: 96, microphone: true, systemAudio: true))
  try dual.recordPCMOrigin(JournalPCMOrigin(rawPTS: raw, declaredHostUs: 1))
  for role in ["system", "narration"] {
    try dual.recordPCMTrack(JournalPCMTrack(role: role, rate: 44100, channels: 2, phaseUs: 100))
    try dual.recordPCMAppend(JournalPCMAppend(role: role, physicalFirstFrame: 0,
      frameCount: 1024, declaredFirstFrame: 0, rawPTS: raw, removedPauseUs: 0))
  }
  var streamed: [String: Int64] = [:]
  let roleRead = try CaptureJournal.streamAcceptedPCM(directory: roles.path) {
    streamed[$0.role] = $0.frameCount
  }
  precondition(roleRead.invalidAtSequence == nil && streamed == ["system": 1024, "narration": 1024])
  print(
    "PASS accepted PCM journal retains exact raw fields and separate addresses; public inspection accepts the persisted packed layout"
  )
}
