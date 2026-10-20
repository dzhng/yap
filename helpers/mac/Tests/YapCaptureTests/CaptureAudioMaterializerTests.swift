import AVFoundation
import CryptoKit
import Darwin
import Foundation
import YapAudio
import YapCapture
import YapMedia

func runCaptureAudioMaterializerTests() async throws {
  var root = URL(fileURLWithPath: #filePath)
  for _ in 0..<5 { root.deleteLastPathComponent() }
  let original = root.appendingPathComponent(
    "specs/done/agent-editing/assets/20a-sparse-storage/run/continuous-48000.mov")
  let directory = RecoveryFixture.directory("materializer")
  defer { try? FileManager.default.removeItem(at: directory) }
  var hashes: [(String, String)] = []
  for (name, accepted, diagnostic, rate) in [
    ("complete", Int64(96000), Optional<String>.none, Int32(48000)),
    ("accepted-tail", 120000, "acceptedBeyondPhysicalEOF", 48000),
    ("physical-tail", 40000, "unmappedPhysicalTail", 48000),
    ("empty", 0, "unmappedPhysicalTail", 48000),
    ("grouped", 96000, Optional<String>.none, 48000),
    ("44100", 88200, Optional<String>.none, 44100),
  ] {
    let folder = try captureMaterializerFixture(
      in: directory, name: name, accepted: accepted, grouped: name == "grouped", rate: rate)
    let candidate = folder.appendingPathComponent("candidate.mov")
    let result = try await materializeCaptureFixture(
      directory: folder.path, role: "narration", candidate: candidate)
    FileHandle.standardError.write(
      Data(
        "CASE \(name) A=\(result.acceptedFrames) C=\(result.committedFrames) R=\(result.representedFrames) EOF=\(result.cleanPhysicalEOF) diagnostic=\(String(describing: result.diagnostic))\n"
          .utf8))
    precondition(result.acceptedFrames == accepted && result.committedFrames == Int64(rate) * 2)
    precondition(
      result.representedFrames == min(Int64(rate) * 2, accepted) && result.cleanPhysicalEOF)
    precondition(result.diagnostic == diagnostic)
    if accepted == 0 {
      precondition(
        result.candidate == nil && !FileManager.default.fileExists(atPath: candidate.path))
      continue
    }
    if name == "complete" || name == "grouped" {
      hashes.append((result.pcmSHA256, result.supportSHA256))
    }
    let count = Int(result.representedFrames)
    let anchor = 100001 * Int(rate) / 1_000_000
    let endFrame = anchor + 50000 + count - 32768
    let endUs = Int64((endFrame + 1) * 1_000_000 / Int(rate))
    let range = TimeSpan(startUs: 0, endUs: endUs)
    let source = AudioSourceSelection(
      source: candidate.path, streamId: nil, sourceOffsetUs: ExactTime(0), available: [ExactRange(range)])
    let full = try await AudioPCMStream.open(source: source, range: ExactRange(range))
    var actual: [Float] = []
    try await full.consume { actual += $0.samples }
    let expectedFrames = Int(endUs * Int64(rate) / 1_000_000)
    precondition(actual.count == expectedFrames)
    var expected = [Float](repeating: 0, count: expectedFrames)
    for i in 0..<count {
      let at = i < 32768 ? anchor + i : anchor + 50000 + i - 32768
      expected[at] = Float((i * 97 % 1009) - 504) / 1024
    }
    precondition(
      actual == expected,
      "Materialized source must preserve every original sample and exact gap placement")
    let lateRange = TimeSpan(startUs: 1_200_011, endUs: min(endUs, 1_299_567))
    if lateRange.endUs > lateRange.startUs {
      let late = try await AudioPCMStream.open(source: source, range: ExactRange(lateRange))
      var samples: [Float] = []
      try await late.consume { samples += $0.samples }
      let first = Int(lateRange.startUs * Int64(rate) / 1_000_000)
      let last = Int(lateRange.endUs * Int64(rate) / 1_000_000)
      precondition(samples.count == last - first)
      precondition(samples == Array(expected[first..<last]))
    }
    if name == "complete" {
      let repeated = try await materializeCaptureFixture(
        directory: folder.path, role: "narration", candidate: candidate)
      precondition(repeated.canonical == result.canonical && repeated.pcmSHA256 == result.pcmSHA256)
      let lease = try CaptureJournalLease(directory: folder.path)
      let prefix = try CaptureJournal.streamAcceptedPCM(lease: lease) { _ in }.validatedPrefix!
      let descriptor = Darwin.open(candidate.path, O_RDONLY | O_CLOEXEC)
      precondition(descriptor >= 0)
      defer { close(descriptor) }
      precondition(lseek(descriptor, 7, SEEK_SET) == 7)
      try FileManager.default.removeItem(at: folder.appendingPathComponent("narration.packed.mov"))
      try FileManager.default.removeItem(at: candidate)
      let verified = try await CaptureAudioMaterializer.verifyCanonical(
        lease: lease, through: prefix,
        role: "narration", representedFrames: result.representedFrames,
        candidate: URL(fileURLWithPath: "/dev/fd/\(descriptor)"))
      precondition(
        verified.identity == result.canonical && verified.pcmSHA256 == result.pcmSHA256
          && verified.supportSHA256 == result.supportSHA256)
      precondition(
        lseek(descriptor, 0, SEEK_CUR) == 7,
        "Descriptor verification must not mutate caller file position")
    }
  }
  precondition(
    hashes.count == 2 && hashes[0].0 == hashes[1].0 && hashes[0].1 == hashes[1].1,
    "Digest identity must ignore adjacent callback grouping")

  let damaged = try captureMaterializerFixture(in: directory, name: "interior-gap", accepted: 96000)
  let payload = damaged.appendingPathComponent("narration.packed.mov")
  let asset = AVURLAsset(url: original)
  let track = try await asset.loadTracks(withMediaType: .audio)[0]
  let composition = AVMutableComposition()
  let destination = composition.addMutableTrack(
    withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
  try destination.insertTimeRange(
    CMTimeRange(start: .zero, duration: CMTime(value: 32768, timescale: 48000)), of: track,
    at: .zero)
  try destination.insertTimeRange(
    CMTimeRange(
      start: CMTime(value: 32768, timescale: 48000),
      duration: CMTime(value: 63232, timescale: 48000)), of: track,
    at: CMTime(value: 40000, timescale: 48000))
  try FileManager.default.removeItem(at: payload)
  try await AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
    .export(to: payload, as: .mov)
  let result = try await materializeCaptureFixture(
    directory: damaged.path, role: "narration",
    candidate: damaged.appendingPathComponent("candidate.mov"))
  precondition(
    result.committedFrames == 32768 && result.representedFrames == 32768 && !result.cleanPhysicalEOF
  )
  precondition(result.diagnostic == "interiorPhysicalMappingLoss")

  let hidden = try captureMaterializerFixture(
    in: directory, name: "hidden-media-tail", accepted: 96000)
  let hiddenPayload = hidden.appendingPathComponent("narration.packed.mov")
  let movie = try AVMutableMovie(settingsFrom: nil, options: nil)
  movie.defaultMediaDataStorage = AVMediaDataStorage(
    url: hidden.appendingPathComponent("hidden.mov"), options: nil)
  try movie.insertTimeRange(
    CMTimeRange(start: .zero, duration: CMTime(value: 2, timescale: 1)), of: asset, at: .zero,
    copySampleData: true)
  movie.removeTimeRange(
    CMTimeRange(start: CMTime(value: 1, timescale: 1), duration: CMTime(value: 1, timescale: 1)))
  try movie.writeHeader(
    to: hidden.appendingPathComponent("hidden.mov"), fileType: .mov,
    options: .addMovieHeaderToDestination)
  try FileManager.default.removeItem(at: hiddenPayload)
  try FileManager.default.moveItem(
    at: hidden.appendingPathComponent("hidden.mov"), to: hiddenPayload)
  let hiddenResult = try await materializeCaptureFixture(
    directory: hidden.path, role: "narration",
    candidate: hidden.appendingPathComponent("candidate.mov"))
  precondition(hiddenResult.representedFrames == 48000 && !hiddenResult.cleanPhysicalEOF)
  precondition(
    hiddenResult.diagnostic == "unprovenPhysicalEOF",
    "A presentation edit must not hide physical bytes from cleanup eligibility")

  let torn = try captureMaterializerFixture(in: directory, name: "torn", accepted: 96000)
  let journalPath = torn.appendingPathComponent("capture.journal.jsonl")
  let validatedBytes = try Data(contentsOf: journalPath).count
  let handle = try FileHandle(forWritingTo: journalPath)
  try handle.seekToEnd()
  try handle.write(contentsOf: Data("{broken".utf8))
  try handle.close()
  let tornResult = try await materializeCaptureFixture(
    directory: torn.path, role: "narration", candidate: torn.appendingPathComponent("candidate.mov")
  )
  precondition(tornResult.journal.bytes == validatedBytes && tornResult.diagnostic == nil)
  precondition(tornResult.representedFrames == 96000)

  for mode in ["missing", "corrupt", "format"] {
    let folder = try captureMaterializerFixture(in: directory, name: mode, accepted: 96000)
    let path = folder.appendingPathComponent("narration.packed.mov")
    if mode == "missing" { try FileManager.default.removeItem(at: path) }
    if mode == "corrupt" { try Data([0, 1, 2, 3]).write(to: path) }
    if mode == "format" {
      try FileManager.default.removeItem(at: path)
      try FileManager.default.copyItem(
        at: original.deletingLastPathComponent().appendingPathComponent("continuous-44100.mov"),
        to: path)
    }
    do {
      _ = try await materializeCaptureFixture(
        directory: folder.path, role: "narration",
        candidate: folder.appendingPathComponent("candidate.mov"))
      preconditionFailure("Invalid physical media must not yield a verified candidate")
    } catch {
      FileHandle.standardError.write(Data("INVALID \(mode): \(error)\n".utf8))
      let failure = CaptureFinalizationError(error)
      precondition(failure.code == "INVALID_MEDIA",
        "Invalid \(mode) input must retain its proven media refusal: \(error)")
      precondition(!failure.retryable, "Retry cannot change immutable \(mode) media: \(error)")
      precondition(
        !FileManager.default.fileExists(atPath: folder.appendingPathComponent("candidate.mov").path)
      )
      if mode != "missing" { precondition(FileManager.default.fileExists(atPath: path.path)) }
    }
  }

  let unrepresentable = try captureMaterializerFixture(
    in: directory, name: "unrepresentable", accepted: 96000, rate: 47999)
  let untouched = try Data(
    contentsOf: unrepresentable.appendingPathComponent("narration.packed.mov"))
  do {
    _ = try await materializeCaptureFixture(
      directory: unrepresentable.path, role: "narration",
      candidate: unrepresentable.appendingPathComponent("candidate.mov"))
    preconditionFailure("Unrepresentable accepted phase must fail before touching media")
  } catch let failure as CaptureFailure {
    precondition(failure.message.contains("timescale"))
  }
  let retained = try Data(
    contentsOf: unrepresentable.appendingPathComponent("narration.packed.mov"))
  precondition(retained == untouched)

  let canceled = try captureMaterializerFixture(in: directory, name: "cancel", accepted: 96000)
  let operation = Task {
    try await materializeCaptureFixture(
      directory: canceled.path, role: "narration",
      candidate: canceled.appendingPathComponent("candidate.mov"))
  }
  operation.cancel()
  do {
    _ = try await operation.value
    preconditionFailure("Canceled materialization must not succeed")
  } catch is CancellationError {}
  precondition(
    FileManager.default.fileExists(
      atPath: canceled.appendingPathComponent("narration.packed.mov").path))
  precondition(
    !FileManager.default.fileExists(atPath: canceled.appendingPathComponent("candidate.mov").path))
  print("Capture audio materializer tests passed")
}

/// Opt-in scaling receipt for the complete production operation, including canonical verification.
func runCaptureAudioMaterializerScaleProbe(output: String, runs: Int) async throws {
  let directory = URL(fileURLWithPath: output)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
  var root = URL(fileURLWithPath: #filePath)
  for _ in 0..<5 { root.deleteLastPathComponent() }
  let original = root.appendingPathComponent(
    "specs/done/agent-editing/assets/20a-sparse-storage/run/continuous-48000.mov")
  let reuse = ProcessInfo.processInfo.environment["YAP_MATERIALIZER_REUSE"]
  if let reuse {
    for name in ["narration.packed.mov", "capture.journal.jsonl", "candidate.mov"] {
      try FileManager.default.copyItem(
        at: URL(fileURLWithPath: reuse).appendingPathComponent(name),
        to: directory.appendingPathComponent(name))
    }
  } else {
    try FileManager.default.copyItem(
      at: original, to: directory.appendingPathComponent("narration.packed.mov"))
  }
  precondition(runs > 0 && runs <= 100000)
  let frames: Int64 = runs > 96000 ? 192000 : 96000
  if frames > 96000 && reuse == nil {
    let asset = AVURLAsset(url: original)
    let track = try await asset.loadTracks(withMediaType: .audio)[0]
    let composition = AVMutableComposition()
    let target = composition.addMutableTrack(
      withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
    let range = NSValue(
      timeRange: CMTimeRange(start: .zero, duration: CMTime(value: 2, timescale: 1)))
    try target.insertTimeRanges([range, range], of: [track, track], at: .zero)
    let doubled = directory.appendingPathComponent("doubled.mov")
    try await AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
      .export(to: doubled, as: .mov)
    try FileManager.default.removeItem(at: directory.appendingPathComponent("narration.packed.mov"))
    try FileManager.default.moveItem(
      at: doubled, to: directory.appendingPathComponent("narration.packed.mov"))
  }
  func records() throws {
    let journal = try CaptureJournal(
      directory: directory.path,
      header: CaptureJournalHeader(
        schemaVersion: 2, sessionID: "materializer-scale", source: CaptureSource(kind: "fixture"),
        width: 160, height: 96, microphone: true, systemAudio: false))
    try journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: .zero, declaredHostUs: 0))
    try journal.recordPCMTrack(
      JournalPCMTrack(role: "narration", rate: 48000, channels: 1, phaseUs: 100001))
    for index in 0..<runs {
      let first = Int64(index) * frames / Int64(runs)
      let end = Int64(index + 1) * frames / Int64(runs)
      try journal.recordPCMAppend(
        JournalPCMAppend(
          role: "narration", physicalFirstFrame: first,
          frameCount: end - first, declaredFirstFrame: first + Int64(index) * 4800,
          rawPTS: CMTime(value: first, timescale: 48000), removedPauseUs: 0))
    }
  }
  if reuse == nil { try records() }
  let start = ContinuousClock.now
  let operation = Task {
    try await materializeCaptureFixture(
      directory: directory.path, role: "narration",
      candidate: directory.appendingPathComponent("candidate.mov"))
  }
  let guardSeconds = Int(
    ProcessInfo.processInfo.environment["YAP_MATERIALIZER_GUARD_SECONDS"] ?? "60")!
  precondition((1...600).contains(guardSeconds))
  let cancellation = Task {
    try await Task.sleep(for: .seconds(guardSeconds))
    operation.cancel()
  }
  defer { cancellation.cancel() }
  var report: [String: Any] = [
    "runs": runs, "guardSeconds": guardSeconds, "guardScope": "experiment only",
  ]
  do {
    let result = try await operation.value
    report["representedFrames"] = result.representedFrames
    report["cleanPhysicalEOF"] = result.cleanPhysicalEOF
    report["pcmSHA256"] = result.pcmSHA256
    report["supportSHA256"] = result.supportSHA256
    report["success"] = true
  } catch {
    report["success"] = false
    report["error"] = String(describing: error)
  }
  let elapsed = start.duration(to: .now).components
  report["seconds"] = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  report["workerPeakResidentBytes"] = usage.ru_maxrss
  try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    .write(to: directory.appendingPathComponent("report.json"))
  print(
    String(
      data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
      encoding: .utf8)!)
}

private func materializeCaptureFixture(directory: String, role: String, candidate: URL) async throws
  -> CaptureAudioMaterialization
{
  let lease = try CaptureJournalLease(directory: directory)
  let summary = try CaptureJournal.streamAcceptedPCM(lease: lease) { _ in }
  return try await CaptureAudioMaterializer.materialize(
    lease: lease, through: summary.validatedPrefix!, role: role, candidate: candidate)
}

func captureMaterializerFixture(
  in directory: URL, name: String, accepted: Int64, grouped: Bool = false, rate: Int32 = 48000
) throws -> URL {
  var root = URL(fileURLWithPath: #filePath)
  for _ in 0..<5 { root.deleteLastPathComponent() }
  let original = root.appendingPathComponent(
    "specs/done/agent-editing/assets/20a-sparse-storage/run/continuous-48000.mov")
  let folder = directory.appendingPathComponent(name)
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
  let media =
    rate == 44100
    ? original.deletingLastPathComponent().appendingPathComponent("continuous-44100.mov") : original
  try FileManager.default.copyItem(
    at: media, to: folder.appendingPathComponent("narration.packed.mov"))
  let journal = try CaptureJournal(
    directory: folder.path,
    header: CaptureJournalHeader(
      schemaVersion: 2, sessionID: name, source: CaptureSource(kind: "fixture"), width: 160,
      height: 96, microphone: true, systemAudio: false))
  try journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: .zero, declaredHostUs: 0))
  try journal.recordPCMTrack(
    JournalPCMTrack(role: "narration", rate: rate, channels: 1, phaseUs: 100001))
  if accepted > 0 {
    let first = min(32768, accepted)
    let pieces = grouped ? [first / 2, first - first / 2] : [first]
    var physical: Int64 = 0
    for count in pieces {
      try journal.recordPCMAppend(
        JournalPCMAppend(
          role: "narration", physicalFirstFrame: physical,
          frameCount: count, declaredFirstFrame: physical,
          rawPTS: CMTime(value: physical, timescale: 48000), removedPauseUs: 0))
      physical += count
    }
    if accepted > first {
      try journal.recordPCMAppend(
        JournalPCMAppend(
          role: "narration", physicalFirstFrame: first,
          frameCount: accepted - first, declaredFirstFrame: 50000,
          rawPTS: CMTime(value: 50000, timescale: 48000), removedPauseUs: 0))
    }
  }
  return folder
}

func runCaptureAudioMaterializerDescriptorProbe(output: String) async throws {
  let root = URL(fileURLWithPath: output)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
  let directory = try captureMaterializerFixture(in: root, name: "long", accepted: 19_200_000)
  let payload = directory.appendingPathComponent("narration.packed.mov")
  let input = AVURLAsset(url: payload)
  let track = try await input.loadTracks(withMediaType: .audio)[0]
  let composition = AVMutableComposition()
  let target = composition.addMutableTrack(
    withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
  let range = NSValue(
    timeRange: CMTimeRange(start: .zero, duration: CMTime(value: 2, timescale: 1)))
  try target.insertTimeRanges(
    Array(repeating: range, count: 200), of: Array(repeating: track, count: 200), at: .zero)
  let long = directory.appendingPathComponent("long.mov")
  try await AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
    .export(to: long, as: .mov)
  try FileManager.default.removeItem(at: payload)
  try FileManager.default.moveItem(at: long, to: payload)
  let candidate = directory.appendingPathComponent("candidate.mov")
  let result = try await materializeCaptureFixture(
    directory: directory.path, role: "narration", candidate: candidate)
  precondition(result.representedFrames == 19_200_000 && result.cleanPhysicalEOF)
  precondition(result.canonical!.bytes > 64 * 1024 * 1024)
  var expected = SHA256()
  expected.update(data: Data("yap.capture-pcm.v1\0".utf8))
  for value: Int64 in [48000, 1] {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { expected.update(bufferPointer: $0) }
  }
  let originalPCM = (0..<96000).map { Float(($0 * 97 % 1009) - 504) / 1024 }
  for _ in 0..<200 { originalPCM.withUnsafeBytes { expected.update(bufferPointer: $0) } }
  precondition(result.pcmSHA256 == expected.finalize().map { String(format: "%02x", $0) }.joined())
  try FileManager.default.copyItem(
    at: payload, to: root.appendingPathComponent("retained-packed.mov"))
  try FileManager.default.copyItem(
    at: candidate, to: root.appendingPathComponent("retained-canonical.mov"))
  let lease = try CaptureJournalLease(directory: directory.path)
  let prefix = try CaptureJournal.streamAcceptedPCM(lease: lease) { _ in }.validatedPrefix!
  let descriptor = Darwin.open(candidate.path, O_RDONLY | O_CLOEXEC)
  precondition(descriptor >= 0)
  defer { close(descriptor) }
  let descriptorURL = URL(fileURLWithPath: "/dev/fd/\(descriptor)")
  try FileManager.default.removeItem(at: payload)
  try FileManager.default.removeItem(at: candidate)
  let start = ContinuousClock.now
  let verified = try await CaptureAudioMaterializer.verifyCanonical(
    lease: lease, through: prefix,
    role: "narration", representedFrames: result.representedFrames, candidate: descriptorURL)
  precondition(
    verified.identity == result.canonical && verified.pcmSHA256 == result.pcmSHA256
      && verified.supportSHA256 == result.supportSHA256)
  let elapsed = start.duration(to: .now).components
  let bounded = try MediaInput(url: descriptorURL)
  do {
    let track = try await bounded.asset.loadTracks(withMediaType: .audio)[0]
    let reader = try AVAssetReader(asset: bounded.asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    if reader.startReading() {
      while autoreleasepool(invoking: { output.copyNextSampleBuffer() != nil }) {}
    }
    reader.cancelReading()
  } catch {}
  precondition(
    bounded.failure?.code == "LIMIT_EXCEEDED",
    "Default descriptor inspection budget must remain enforced")
  let canceled = Task {
    try await CaptureAudioMaterializer.verifyCanonical(
      lease: lease, through: prefix,
      role: "narration", representedFrames: result.representedFrames, candidate: descriptorURL)
  }
  try await Task.sleep(for: .milliseconds(1))
  canceled.cancel()
  var canceledObserved = false
  do { _ = try await canceled.value } catch is CancellationError { canceledObserved = true }
  precondition(canceledObserved)
  let retainedIdentity = try CaptureMediaIdentity.read(descriptorURL)
  precondition(retainedIdentity == verified.identity)
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  let report: [String: Any] = [
    "frames": result.representedFrames, "canonicalBytes": verified.identity.bytes,
    "canonicalSHA256": verified.identity.sha256, "pcmSHA256": verified.pcmSHA256,
    "supportSHA256": verified.supportSHA256,
    "descriptorVerificationSeconds": Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18,
    "workerPeakResidentBytes": usage.ru_maxrss, "sourcePathnamesRemoved": true,
    "inspectionBudgetPreserved": true, "cancellationObserved": canceledObserved,
    "fixture": "200 exact repeats of banked 2-second actual-writer PCM; synthetic duration control",
  ]
  try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    .write(to: root.appendingPathComponent("report.json"))
  print(String(data: try JSONSerialization.data(withJSONObject: report), encoding: .utf8)!)
}
