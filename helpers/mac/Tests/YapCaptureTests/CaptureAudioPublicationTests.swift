import Darwin
import Foundation
import YapCapture
import YapMedia
import YapWire

func runCaptureAudioPublicationTests(output: String? = nil) async throws {
  let root: URL
  if let output {
    root = URL(fileURLWithPath: output)
    precondition(!FileManager.default.fileExists(atPath: root.path), "Use a new evidence directory")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  } else {
    root = RecoveryFixture.directory("capture-publication")
  }
  defer { if output == nil { try? FileManager.default.removeItem(at: root) } }
  func fixture(_ name: String) throws -> URL {
    try captureMaterializerFixture(in: root, name: name, accepted: 96000)
  }
  func publish(_ folder: URL) async throws -> CaptureAudioPublication.Receipt {
    let lease = try CaptureJournalLease(directory: folder.path)
    return try await published(lease)
  }
  func published(_ lease: CaptureJournalLease) async throws -> CaptureAudioPublication.Receipt {
    guard case .published(let receipt) = try await CaptureAudioPublication.publish(lease: lease, role: "narration") else {
      preconditionFailure("This fixture must publish represented audio")
    }
    return receipt
  }
  func remove(_ folder: URL, _ name: String) throws {
    try FileManager.default.removeItem(at: folder.appendingPathComponent(name))
  }
  func refuse(_ folder: URL) async throws {
    let payload = try Data(contentsOf: folder.appendingPathComponent("narration.packed.mov"))
    do {
      _ = try await publish(folder)
      preconditionFailure("Conflicting publication must refuse")
    } catch {
      let retained = try Data(contentsOf: folder.appendingPathComponent("narration.packed.mov"))
      precondition(retained == payload, "Publication refusal must retain recoverable input")
    }
  }

  let complete = try fixture("complete")
  let unavailable = try captureMaterializerFixture(in: root, name: "unavailable", accepted: 0)
  do {
    let unavailableLease = try CaptureJournalLease(directory: unavailable.path)
    guard case .unavailable(.noRepresentedFrames(let absent)) = try await CaptureAudioPublication.publish(lease: unavailableLease, role: "narration") else {
      preconditionFailure("A verified zero represented prefix must be typed unavailable")
    }
    precondition(absent.representedFrames == 0 && absent.canonical == nil)
  }
  precondition(FileManager.default.fileExists(atPath: unavailable.appendingPathComponent("narration.packed.mov").path))
  precondition(!FileManager.default.fileExists(atPath: unavailable.appendingPathComponent("narration.mov").path))
  let unavailableExport = try await SourceEvidenceExport.write(directory: unavailable.path,
    output: root.appendingPathComponent("unavailable-evidence.jsonl").path)
  precondition(unavailableExport.audioIntervals == 0)
  try Data("conflicting canonical name".utf8).write(to: unavailable.appendingPathComponent("narration.mov"))
  do {
    let unavailableLease = try CaptureJournalLease(directory: unavailable.path)
    _ = try await CaptureAudioPublication.publish(lease: unavailableLease, role: "narration")
    preconditionFailure("Integrity conflict must not become unavailable")
  } catch let failure as CaptureFailure { precondition(failure.code == "PUBLICATION_CONFLICT") }
  let unmapped = try captureMaterializerFixture(in: root, name: "missing-mapping", accepted: 0)
  let unmappedJournal = unmapped.appendingPathComponent("capture.journal.jsonl")
  let unmappedPrefix = try String(contentsOf: unmappedJournal, encoding: .utf8).split(separator: "\n").prefix(2).joined(separator: "\n") + "\n"
  try Data(unmappedPrefix.utf8).write(to: unmappedJournal)
  do {
    let lease = try CaptureJournalLease(directory: unmapped.path)
    guard case .unavailable(.missingMapping(let intent)) = try await CaptureAudioPublication.publish(lease: lease, role: "narration") else {
      preconditionFailure("Missing mapping retains identity without fabricated phase/count")
    }
    precondition(intent.role == "narration" && intent.payload.bytes > 0)
  }
  let unmappedExport = try await SourceEvidenceExport.write(directory: unmapped.path,
    output: root.appendingPathComponent("unmapped-evidence.jsonl").path)
  precondition(unmappedExport.audioIntervals == 0)
  let original = try await publish(complete)
  let exported = try await SourceEvidenceExport.write(
    directory: complete.path, output: root.appendingPathComponent("published-evidence.jsonl").path)
  precondition(exported.header?.schemaVersion == 2 && exported.audioIntervals == 2,
               "Source admission must export verified canonical support")
  let exportedRows = try String(contentsOfFile: exported.file, encoding: .utf8)
    .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
  let spans = exportedRows.filter { $0["event"] as? String == "audioAcquired" }
    .map { $0["data"] as! [String: Any] }
  precondition(spans.map { $0["startUs"] as! Int } == [100001, 1141668])
  precondition(spans.map { $0["endUs"] as! Int } == [782668, 2459001])
  precondition(exported.publications?["narration"]?.canonical == original.canonical)
  let unproven = try fixture("unproven-source")
  try FileManager.default.copyItem(at: complete.appendingPathComponent("narration.mov"),
                                 to: unproven.appendingPathComponent("narration.mov"))
  do {
    _ = try await SourceEvidenceExport.write(directory: unproven.path,
      output: root.appendingPathComponent("unproven-evidence.jsonl").path)
    preconditionFailure("A canonical-looking filename must not admit accepted-only support")
  } catch { precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent("unproven-evidence.jsonl").path)) }
  let clipped = try captureMaterializerFixture(in: root, name: "clipped-source", accepted: 120000)
  _ = try await publish(clipped)
  let clippedExport = try await SourceEvidenceExport.write(directory: clipped.path,
    output: root.appendingPathComponent("clipped-evidence.jsonl").path)
  let clippedBytes = try Data(contentsOf: URL(fileURLWithPath: clippedExport.file))
  let completeBytes = try Data(contentsOf: URL(fileURLWithPath: exported.file))
  precondition(clippedBytes == completeBytes, "Accepted-only tail must not expand verified support")
  do {
    _ = try await SourceEvidenceExport.write(directory: complete.path,
      output: root.appendingPathComponent("omitted-canonical.jsonl").path, canonical: [:])
    preconditionFailure("A closed admitted set must not fall back to a donor pathname")
  } catch let failure as CaptureFailure { precondition(failure.code == "PUBLICATION_FAILED") }
  let repeated = try await publish(complete)
  precondition(original == repeated && original.representedFrames == 96000)
  precondition(
    FileManager.default.fileExists(
      atPath: complete.appendingPathComponent("narration.packed.mov").path))

  // These are exact on-disk restart boundaries reconstructed from a verified publication,
  // not claims of hardware power-loss testing or a test hook in the publisher.
  for boundary in ["intent", "prepared", "canonical"] {
    let folder = try fixture(boundary)
    let expected = try await publish(folder)
    try remove(folder, "narration.publication.json")
    if boundary != "canonical" { try remove(folder, "narration.mov") }
    if boundary == "intent" {
      try remove(folder, ".capture-publication-narration/prepared.json")
      try remove(folder, ".capture-publication-narration/candidate.mov")
      try Data("interrupted media bytes".utf8).write(
        to: folder.appendingPathComponent(".capture-publication-narration/candidate.mov"))
    }
    let resumed = try await publish(folder)
    // Re-export may change container metadata; delivered PCM/support must be identical.
    precondition(
      resumed.pcmSHA256 == expected.pcmSHA256 && resumed.supportSHA256 == expected.supportSHA256)
    precondition(resumed.representedFrames == expected.representedFrames)
    if boundary != "intent" { precondition(resumed == expected) }
  }

  let conflict = try fixture("conflicting-canonical")
  let occupant = Data("unrelated existing output".utf8)
  try occupant.write(to: conflict.appendingPathComponent("narration.mov"))
  try await refuse(conflict)
  do {
    _ = try NewFile.publish(
      staged: complete.appendingPathComponent(".capture-publication-narration/candidate.mov"),
      at: conflict.appendingPathComponent("narration.mov").path)
    preconditionFailure("No-clobber primitive must reject a different inode")
  } catch let failure as NativeFailure { precondition(failure.code == "INVALID_OUTPUT") }
  let unchanged = try Data(contentsOf: conflict.appendingPathComponent("narration.mov"))
  precondition(unchanged == occupant)

  let damaged = try fixture("changed-canonical")
  _ = try await publish(damaged)
  try occupant.write(to: damaged.appendingPathComponent("narration.mov"))
  try await refuse(damaged)

  let changed = try fixture("changed-journal")
  _ = try await publish(changed)
  let journal = changed.appendingPathComponent("capture.journal.jsonl")
  var bytes = try Data(contentsOf: journal)
  bytes[bytes.startIndex] = 32
  try bytes.write(to: journal)
  try await refuse(changed)

  let cleanupLease = try CaptureJournalLease(directory: complete.path)
  let removed = try await CaptureAudioPublication.cleanup(lease: cleanupLease, receipt: original)
  precondition(removed == .removed)
  precondition(
    !FileManager.default.fileExists(
      atPath: complete.appendingPathComponent("narration.packed.mov").path))
  let afterCleanup = try await published(cleanupLease)
  precondition(
    afterCleanup == original, "Canonical verification must survive removal of packed working data")
  let repeatedCleanup = try await CaptureAudioPublication.cleanup(lease: cleanupLease, receipt: original)
  precondition(repeatedCleanup == .alreadyClear)

  let tail = try captureMaterializerFixture(in: root, name: "unmapped-tail", accepted: 40000)
  let tailReceipt = try await publish(tail)
  let tailLease = try CaptureJournalLease(directory: tail.path)
  let retainedTail = try await CaptureAudioPublication.cleanup(lease: tailLease, receipt: tailReceipt)
  precondition(retainedTail == .retained)
  precondition(
    FileManager.default.fileExists(atPath: tail.appendingPathComponent("narration.packed.mov").path)
  )

  let missing = try captureMaterializerFixture(
    in: root, name: "accepted-beyond-physical", accepted: 120000)
  let missingReceipt = try await publish(missing)
  let missingLease = try CaptureJournalLease(directory: missing.path)
  let retainedMissing = try await CaptureAudioPublication.cleanup(lease: missingLease, receipt: missingReceipt)
  precondition(retainedMissing == .retained)
  precondition(missingReceipt.acceptedFrames > missingReceipt.committedFrames)
  precondition(
    FileManager.default.fileExists(
      atPath: missing.appendingPathComponent("narration.packed.mov").path),
    "Known accepted/physical disagreement remains retained despite a playable proven prefix")

  let denied = try fixture("cleanup-permission")
  let deniedReceipt = try await publish(denied)
  let deniedLease = try CaptureJournalLease(directory: denied.path)
  let deniedAttempt = denied.appendingPathComponent(".capture-publication-narration")
  precondition(chmod(deniedAttempt.path, 0o500) == 0)
  do {
    defer { precondition(chmod(deniedAttempt.path, 0o700) == 0) }
    do {
      try await CaptureAudioPublication.cleanup(lease: deniedLease, receipt: deniedReceipt)
      preconditionFailure("Read-only attempt must refuse member deletion")
    } catch {
      precondition(CaptureFinalizationError.isOperationalRead(error), "Permission failure must preserve its IO category")
    }
    _ = try await CaptureAudioPublication.readPublished(lease: deniedLease, role: "narration", canonical: denied.appendingPathComponent("narration.mov"))
  }
  let repaired = try await CaptureAudioPublication.cleanup(lease: deniedLease, receipt: deniedReceipt)
  precondition(repaired == .removed)

  let explicit = try fixture("explicit-cleanup")
  let explicitReceipt = try await publish(explicit)
  do {
    _ = try await CaptureAudioPublication.cleanupPublished(directory: explicit.path, sourceID: "wrong-source")
    preconditionFailure("Cleanup must not cross source identity")
  } catch let failure as CaptureFailure { precondition(failure.code == "PUBLICATION_CONFLICT") }
  precondition(FileManager.default.fileExists(atPath: explicit.appendingPathComponent("narration.packed.mov").path))
  let explicitResult = try await CaptureAudioPublication.cleanupPublished(directory: explicit.path, sourceID: explicitReceipt.intent.sourceID)
  precondition(explicitResult.count == 2 && explicitResult[0].role == "narration" && explicitResult[0].outcome == .removed)
  precondition(explicitResult[1].role == "system" && explicitResult[1].outcome == .alreadyClear)
  let noProof = try fixture("cleanup-without-proof")
  let noProofLease = try CaptureJournalLease(directory: noProof.path)
  let noProofSummary = try CaptureJournal.streamAcceptedPCM(lease: noProofLease) { _ in }
  noProofLease.release()
  let retainedProof = try await CaptureAudioPublication.cleanupPublished(directory: noProof.path, sourceID: noProofSummary.header!.sessionID)
  precondition(retainedProof[0].outcome == .retained && retainedProof[0].reason == "missing-publication")
  precondition(FileManager.default.fileExists(atPath: noProof.appendingPathComponent("narration.packed.mov").path))

  let linked = try fixture("cleanup-linked-proof")
  let linkedReceipt = try await publish(linked)
  let linkedPath = linked.appendingPathComponent("narration.publication.json")
  let movedPath = linked.appendingPathComponent("saved-publication.json")
  try FileManager.default.moveItem(at: linkedPath, to: movedPath)
  try FileManager.default.createSymbolicLink(at: linkedPath, withDestinationURL: movedPath)
  do {
    _ = try await CaptureAudioPublication.cleanupPublished(directory: linked.path, sourceID: linkedReceipt.intent.sourceID)
    preconditionFailure("Linked publication proof must refuse cleanup")
  } catch let failure as CaptureFailure {
    precondition(failure.code == "PUBLICATION_CONFLICT")
    precondition(!CaptureFinalizationError(failure).retryable)
  }
  precondition(FileManager.default.fileExists(atPath: linked.appendingPathComponent("narration.packed.mov").path))

  let journalLess = root.appendingPathComponent("cleanup-no-journal")
  try FileManager.default.createDirectory(at: journalLess, withIntermediateDirectories: false)
  let unverified = journalLess.appendingPathComponent("narration.packed.mov")
  let unverifiedBytes = Data("unknown recoverable bytes".utf8)
  try unverifiedBytes.write(to: unverified)
  let noJournal = try await CaptureAudioPublication.cleanupPublished(directory: journalLess.path, sourceID: "unverified")
  precondition(noJournal.allSatisfy { $0.outcome == .retained && $0.reason == "missing-journal" })
  let retainedBytes = try Data(contentsOf: unverified)
  precondition(retainedBytes == unverifiedBytes)

  let pending = try fixture("cleanup-pending")
  let pendingReceipt = try await publish(pending)
  let attempt = pending.appendingPathComponent(".capture-publication-narration")
  let unexpected = attempt.appendingPathComponent("retained-diagnostic")
  try Data("retain unknown working entry".utf8).write(to: unexpected)
  let pendingLease = try CaptureJournalLease(directory: pending.path)
  do {
    try await CaptureAudioPublication.cleanup(lease: pendingLease, receipt: pendingReceipt)
    preconditionFailure("Nonempty attempt requires explicit cleanup attention")
  } catch let failure as CaptureFailure { precondition(failure.code == "PUBLICATION_CONFLICT") }
  let available = try await published(pendingLease)
  precondition(
    available == pendingReceipt, "Optional cleanup failure must not revoke canonical availability")
  try FileManager.default.removeItem(at: unexpected)
  try await CaptureAudioPublication.cleanup(lease: pendingLease, receipt: pendingReceipt)

  let canceled = Task { () throws -> Bool in
    withUnsafeCurrentTask { $0?.cancel() }
    do {
      _ = try CaptureJournal.streamAcceptedPCM(lease: cleanupLease) { _ in }
      return false
    } catch is CancellationError { return true }
  }
  let canceledRead = try await canceled.value
  precondition(canceledRead, "The shared journal read owner must observe cancellation")

  let record = try Data(contentsOf: complete.appendingPathComponent("narration.publication.json"))
  let json = try JSONSerialization.jsonObject(with: record) as! [String: Any]
  let intent = json["intent"] as! [String: Any]
  let prefix = intent["journal"] as! [String: Any]
  precondition(json["representedFrames"] is String && prefix["bytes"] is String)
  print(
    "PASS capture publication: repeated verification, intent/prepared/canonical restart boundaries, no-clobber and changed-input refusals"
  )
}
