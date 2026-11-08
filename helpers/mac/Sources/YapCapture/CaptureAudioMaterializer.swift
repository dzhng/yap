@preconcurrency import AVFoundation
import CryptoKit
import Darwin
import Foundation
import YapMedia

package struct CaptureMediaIdentity: Codable, Sendable, Equatable {
  @JournalInteger package var bytes: Int64
  package let sha256: String
  package static func read(_ url: URL, maximumBytes: Int64? = nil) throws -> CaptureMediaIdentity {
    let inherited = try MediaDescriptor(url: url, writable: false)
    let descriptor =
      inherited.map { fcntl($0.descriptor, F_DUPFD_CLOEXEC, 0) }
      ?? Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard descriptor >= 0 else {
      let invalidPath = [ENOENT, ENOTDIR, ELOOP].contains(errno)
      throw CaptureFailure(invalidPath ? "INVALID_MEDIA" : "MEDIA_UNAVAILABLE", "Cannot open media identity input.")
    }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0 else {
      throw CaptureFailure("MEDIA_UNAVAILABLE", "Cannot inspect media identity input.")
    }
    guard info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0 else {
      throw CaptureFailure("INVALID_MEDIA", "Media identity requires a regular file.")
    }
    guard maximumBytes.map({ info.st_size <= $0 }) ?? true else {
      throw CaptureFailure("EVIDENCE_LIMIT", "Media identity input exceeds its read budget.")
    }
    var hash = SHA256()
    var bytes: Int64 = 0
    while bytes < info.st_size {
      try Task.checkCancellation()
      var data = Data(count: Int(min(65_536, info.st_size - bytes)))
      let count = data.withUnsafeMutableBytes { pread(descriptor, $0.baseAddress, $0.count, bytes) }
      if count < 0 && errno == EINTR { continue }
      guard count >= 0 else {
        throw CaptureFailure("MEDIA_UNAVAILABLE", "Cannot read media identity input.")
      }
      guard count > 0 else {
        throw CaptureFailure("INVALID_MEDIA", "Media identity input ended before its pinned size.")
      }
      data.count = count
      bytes += Int64(count)
      hash.update(data: data)
    }
    var final = stat()
    guard fstat(descriptor, &final) == 0 else {
      throw CaptureFailure("MEDIA_UNAVAILABLE", "Cannot recheck media identity input.")
    }
    guard final.st_size == info.st_size else {
      throw CaptureFailure("INVALID_MEDIA", "Media identity input changed length.")
    }
    return CaptureMediaIdentity(
      bytes: bytes, sha256: hash.finalize().map { String(format: "%02x", $0) }.joined())
  }
}

package struct CaptureCanonicalAudio: Sendable {
  package let acquiredAudio: [JournalAudioSamples]
  package let identity: CaptureMediaIdentity
  package let representedFrames: Int64
  package let pcmSHA256: String
  package let supportSHA256: String
}

/// Candidate facts only. Publication and removal of working media belong to the caller.
package struct CaptureAudioMaterialization: Sendable {
  package let role: String
  package let payload: CaptureMediaIdentity
  package let journal: JournalPrefix
  package let acceptedFrames: Int64
  package let committedFrames: Int64
  package let representedFrames: Int64
  /// All platform-indexed PCM is proven; this does not classify unindexed container bytes.
  package let cleanPhysicalEOF: Bool
  package let diagnostic: String?
  package let candidate: URL?
  package let canonical: CaptureMediaIdentity?
  package let pcmSHA256: String
  package let supportSHA256: String
}

package enum CaptureAudioMaterializer {
  private struct Run {
    let physical: Int64
    let declared: Int64
    var count: Int64
  }

  /// Inputs must remain immutable under the publication owner's take lease. Roles are invoked
  /// sequentially so platform export metadata is not multiplied by concurrent finalizations.
  package static func materialize(
    lease: CaptureJournalLease, through prefix: JournalPrefix,
    role: String, candidate: URL
  ) async throws
    -> CaptureAudioMaterialization
  {
    try Task.checkCancellation()
    try lease.check()
    let directory = lease.directory
    var candidateInfo = stat()
    let candidateStatus = lstat(candidate.path, &candidateInfo)
    guard candidateStatus == 0 ? candidateInfo.st_mode & S_IFMT == S_IFREG : errno == ENOENT else {
      throw invalid("Candidate must be absent or a regular file, never a symlink.")
    }
    let existing = candidateStatus == 0
    guard ["narration", "system"].contains(role) else { throw invalid("Invalid audio role.") }
    let mapping = try mapping(lease: lease, through: prefix, role: role)
    let format = mapping.format
    var runs = mapping.runs
    let accepted = mapping.accepted
    let timing = try PCMContainerTime(phaseUs: format.phaseUs, rate: format.rate)
    let payloadURL = URL(fileURLWithPath: directory).appendingPathComponent(format.file)
    let payload = try CaptureMediaIdentity.read(payloadURL)
    let input = try MediaInput(url: payloadURL, purpose: .streaming)
    let tracks: [AVAssetTrack]
    do { tracks = try await input.asset.load(.tracks) }
    catch {
      try Task.checkCancellation()
      try lease.check()
      let cause = error as NSError
      // These parse errors describe the pinned input; generic decoding and IO errors still retry.
      if cause.domain == AVFoundationErrorDomain,
        [AVError.fileFormatNotRecognized.rawValue, AVError.fileFailedToParse.rawValue].contains(cause.code),
        try CaptureMediaIdentity.read(payloadURL) == payload
      {
        throw CaptureFailure("PACKED_MEDIA_INVALID", "Packed PCM cannot be parsed (\(cause.domain) \(cause.code)): \(cause.localizedDescription)")
      }
      throw error
    }
    guard tracks.count == 1, tracks[0].mediaType == .audio else {
      throw CaptureFailure("PACKED_MEDIA_INVALID", "Packed media must contain exactly one audio track.")
    }
    let track = tracks[0]
    try await validate(track, format: format)
    let physical = try await scan(input: input, track: track, format: format, accepted: accepted)
    let represented = min(accepted, physical.frames)
    runs = clipped(runs, to: represented)
    let supportHash = supportHash(format: format, runs: runs)
    var canonical: CaptureMediaIdentity?
    if represented > 0 {
      if !existing {
        let composition = AVMutableComposition()
        guard
          let target = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid)
        else { throw invalid("Cannot create canonical audio track.") }
        target.naturalTimeScale = timing.timescale
        var pieces: [AVCompositionTrackSegment] = []
        var previous = CMTime.zero
        for run in runs {
          try Task.checkCancellation()
          let at = try timing.time(at: run.declared)
          let duration = CMTime(value: run.count, timescale: format.rate)
          if at > previous {
            pieces.append(
              AVCompositionTrackSegment(
                timeRange:
                  CMTimeRange(start: previous, duration: CMTimeSubtract(at, previous))))
          }
          pieces.append(
            AVCompositionTrackSegment(
              url: input.url, trackID: track.trackID,
              sourceTimeRange: CMTimeRange(
                start: CMTime(value: run.physical, timescale: format.rate), duration: duration),
              targetTimeRange: CMTimeRange(start: at, duration: duration)))
          previous = try timing.time(at: run.declared + run.count)
        }
        try target.validateSegments(pieces)
        target.segments = pieces
        pieces.removeAll()
        guard
          let exporter = AVAssetExportSession(
            asset: composition, presetName: AVAssetExportPresetPassthrough)
        else { throw invalid("Cannot export canonical audio.") }
        try Task.checkCancellation()
        try await exporter.export(to: candidate, as: .mov)
        try Task.checkCancellation()
      }
      let verified = try await verify(candidate, format: format, runs: runs, timing: timing)
      guard verified.pcm == physical.pcm else {
        throw invalid("Canonical PCM differs from its physical prefix.")
      }
      canonical = verified.identity
    } else if existing {
      throw invalid("Existing candidate has no represented physical prefix.")
    }
    // This is a mutation check, not a substitute for the caller's immutable-input lease.
    guard try CaptureMediaIdentity.read(payloadURL) == payload else {
      throw invalid("Packed media changed during materialization.")
    }
    _ = try CaptureJournal.streamAcceptedPCM(lease: lease, through: prefix) { _ in
      try Task.checkCancellation()
    }
    let diagnostic =
      physical.diagnostic
      ?? (physical.frames > accepted
        ? "unmappedPhysicalTail"
        : physical.frames < accepted
          ? "acceptedBeyondPhysicalEOF"
          : nil)
    try Task.checkCancellation()
    return CaptureAudioMaterialization(
      role: role, payload: payload, journal: prefix,
      acceptedFrames: accepted, committedFrames: physical.frames, representedFrames: represented,
      cleanPhysicalEOF: physical.cleanEOF, diagnostic: diagnostic,
      candidate: canonical == nil ? nil : candidate, canonical: canonical,
      pcmSHA256: physical.pcm, supportSHA256: supportHash)
  }

  package static func verifyCanonical(
    lease: CaptureJournalLease, through prefix: JournalPrefix,
    role: String, representedFrames: Int64, candidate: URL
  ) async throws -> CaptureCanonicalAudio {
    let mapping = try mapping(lease: lease, through: prefix, role: role)
    guard representedFrames > 0, representedFrames <= mapping.accepted else {
      throw invalid("Canonical represented prefix is outside accepted mapping evidence.")
    }
    let runs = clipped(mapping.runs, to: representedFrames)
    let verified = try await verify(
      candidate, format: mapping.format, runs: runs,
      timing: PCMContainerTime(phaseUs: mapping.format.phaseUs, rate: mapping.format.rate))
    _ = try CaptureJournal.streamAcceptedPCM(lease: lease, through: prefix) { _ in
      try Task.checkCancellation()
    }
    try Task.checkCancellation()
    let timing = try PCMContainerTime(phaseUs: mapping.format.phaseUs, rate: mapping.format.rate)
    let acquired = try runs.map { run in
      JournalAudioSamples(role: role,
        startUs: microseconds(try timing.time(at: run.declared)),
        endUs: microseconds(try timing.time(at: run.declared + run.count)))
    }
    return CaptureCanonicalAudio(
      acquiredAudio: acquired, identity: verified.identity, representedFrames: representedFrames,
      pcmSHA256: verified.pcm, supportSHA256: supportHash(format: mapping.format, runs: runs))
  }

  private static func mapping(
    lease: CaptureJournalLease, through prefix: JournalPrefix, role: String
  ) throws
    -> (format: JournalPCMTrack, runs: [Run], accepted: Int64)
  {
    var format: JournalPCMTrack?
    var runs: [Run] = []
    var accepted: Int64 = 0
    let journal = try CaptureJournal.streamAcceptedPCM(
      lease: lease, through: prefix,
      track: {
        if $0.role == role { format = $0 }
      }
    ) { append in
      try Task.checkCancellation()
      guard append.role == role else { return }
      accepted = append.physicalFirstFrame + append.frameCount
      if let last = runs.last, last.physical + last.count == append.physicalFirstFrame,
        last.declared + last.count == append.declaredFirstFrame
      {
        runs[runs.count - 1].count += append.frameCount
      } else {
        runs.append(
          Run(
            physical: append.physicalFirstFrame, declared: append.declaredFirstFrame,
            count: append.frameCount))
      }
    }
    guard let format, journal.validatedPrefix == prefix else {
      throw invalid("No validated accepted PCM track is available.")
    }
    return (format, runs, accepted)
  }

  private static func clipped(_ runs: [Run], to represented: Int64) -> [Run] {
    runs.compactMap { run in
      guard run.physical < represented else { return nil }
      return Run(
        physical: run.physical, declared: run.declared,
        count: min(run.count, represented - run.physical))
    }
  }

  private static func supportHash(format: JournalPCMTrack, runs: [Run]) -> String {
    var support = digest("yap.capture-support.v1", format: format)
    integer(format.phaseUs, into: &support)
    for run in runs {
      integer(run.physical, into: &support)
      integer(run.declared, into: &support)
      integer(run.count, into: &support)
    }
    return hex(support.finalize())
  }

  private static func validate(_ track: AVAssetTrack, format: JournalPCMTrack) async throws {
    guard format.rate > 0, format.rate <= 192_000, (1...8).contains(format.channels) else {
      throw CaptureFailure("INVALID_MEDIA", "Accepted PCM format is outside the native execution domain.")
    }
    guard try await track.load(.isSelfContained) else {
      throw CaptureFailure("INVALID_MEDIA", "Capture PCM must not depend on external media references.")
    }
    let descriptions = try await track.load(.formatDescriptions)
    guard !descriptions.isEmpty else { throw CaptureFailure("INVALID_MEDIA", "Packed PCM format is absent.") }
    for description in descriptions {
      guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
        asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate == Double(format.rate),
        asbd.mChannelsPerFrame == format.channels, asbd.mFramesPerPacket == 1,
        asbd.mBitsPerChannel == 32, asbd.mBytesPerFrame == format.channels * 4,
        asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
        asbd.mFormatFlags & (kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsNonInterleaved) == 0
      else { throw CaptureFailure("INVALID_MEDIA", "Packed PCM does not match the accepted fixed Float32 format.") }
    }
  }

  private struct Physical {
    let frames: Int64
    let cleanEOF: Bool
    let pcm: String
    let diagnostic: String?
  }

  /// Packed sample addresses must be proven before sample counts can stand for a prefix.
  /// Empty edits, shifted media or a packet jump terminate proof before later payload is read.
  private static func scan(
    input: MediaInput, track: AVAssetTrack, format: JournalPCMTrack,
    accepted: Int64
  ) async throws -> Physical {
    let segments = try await track.load(.segments)
    var occupiedEnd = CMTime.zero
    var intact = true
    for segment in segments {
      let map = segment.timeMapping
      guard !segment.isEmpty, map.target.start == occupiedEnd, map.source.start == occupiedEnd,
        map.source.duration == map.target.duration, map.target.duration > .zero
      else {
        intact = false
        break
      }
      occupiedEnd = CMTimeRangeGetEnd(map.target)
    }
    let exactEnd = try ExactTime(occupiedEnd)
    let maximum = try exactEnd.sample(Int(format.rate))
    guard try ExactTime(CMTime(value: maximum, timescale: format.rate)).equals(exactEnd) else {
      throw invalid("Packed PCM boundary is not an exact native sample.")
    }
    let reader = try AVAssetReader(asset: input.asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw invalid("Cannot inspect packed PCM.") }
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? invalid("Cannot read packed PCM.") }
    defer { reader.cancelReading() }
    var frames: Int64 = 0
    var hash = digest("yap.capture-pcm.v1", format: format)
    var problem: String? = intact ? nil : "interiorPhysicalMappingLoss"
    while frames < maximum {
      try Task.checkCancellation()
      let advanced = try autoreleasepool { () throws -> Bool in
        guard let sample = output.copyNextSampleBuffer() else { return false }
        let count = sample.numSamples
        let stamp = sample.presentationTimeStamp
        guard sample.isValid, CMSampleBufferDataIsReady(sample), count > 0,
          stamp.isNumeric, stamp == CMTime(value: frames, timescale: format.rate),
          let bytes = Int(exactly: Int128(count) * Int128(format.channels) * 4),
          let block = sample.dataBuffer, CMBlockBufferGetDataLength(block) == bytes
        else {
          problem = "interiorPhysicalPacketLoss"
          return false
        }
        let owned = Int(min(Int64(count), maximum - frames))
        let hashed = Int(max(0, min(Int64(owned), accepted - frames)))
        var nextHash = hash
        let hashBytes = hashed * Int(format.channels) * 4
        var offset = 0
        while offset < hashBytes {
          try Task.checkCancellation()
          var data = Data(count: min(65_536, hashBytes - offset))
          let status = data.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(
              block, atOffset: offset, dataLength: $0.count, destination: $0.baseAddress!)
          }
          guard status == noErr else {
            problem = "unreadablePhysicalPacket"
            return false
          }
          nextHash.update(data: data)
          offset += data.count
        }
        hash = nextHash
        frames += Int64(owned)
        return true
      }
      if !advanced { break }
    }
    // Passthrough PCM can end with documented drain/empty-media markers. They carry no
    // samples, and neither proves that the underlying media tables end at the selected edit.
    var terminal = Set<String>()
    var ended = false
    if intact && frames == maximum {
      while true {
        try Task.checkCancellation()
        guard let sample = output.copyNextSampleBuffer() else {
          ended = true
          break
        }
        let drain =
          CMGetAttachment(
            sample, key: kCMSampleBufferAttachmentKey_DrainAfterDecoding,
            attachmentModeOut: nil) as? Bool == true
        let empty =
          CMGetAttachment(
            sample, key: kCMSampleBufferAttachmentKey_EmptyMedia,
            attachmentModeOut: nil) as? Bool == true
        let kind = drain ? "drain" : "empty"
        guard sample.isValid, sample.numSamples == 0, sample.dataBuffer == nil,
          sample.duration == .zero, drain != empty, terminal.insert(kind).inserted,
          drain || sample.presentationTimeStamp == occupiedEnd
        else { break }
      }
    }
    try Task.checkCancellation()
    if reader.status == .failed {
      // A failed read with no observations proves no absence. Known IO cannot define a
      // committed tail; other decoder failures retain an already observed usable prefix.
      if frames == 0 { throw reader.error ?? invalid("Packed PCM reader failed before proving any frames.") }
      if let error = reader.error, CaptureFinalizationError.isOperationalRead(error) { throw error }
    }
    let last = track.makeSampleCursorAtLastSampleInDecodeOrder()
    let mediaEnd = last.map { CMTimeAdd($0.presentationTimeStamp, $0.currentSampleDuration) }
    let completeMediaExtent = mediaEnd?.isNumeric == true && mediaEnd == occupiedEnd
    let clean =
      intact && frames == maximum && ended && reader.status == .completed && completeMediaExtent
    if !clean, problem == nil {
      problem = completeMediaExtent ? "incompletePhysicalDecode" : "unprovenPhysicalEOF"
    }
    return Physical(frames: frames, cleanEOF: clean, pcm: hex(hash.finalize()), diagnostic: problem)
  }

  private static func verify(_ url: URL, format: JournalPCMTrack, runs: [Run], timing: PCMContainerTime)
    async throws -> (pcm: String, identity: CaptureMediaIdentity)
  {
    let identity = try CaptureMediaIdentity.read(url)
    let input = try MediaInput(url: url, purpose: .streaming)
    let tracks = try await input.asset.load(.tracks)
    guard tracks.count == 1, tracks[0].mediaType == .audio else {
      throw invalid("Canonical output has unexpected media tracks.")
    }
    let track = tracks[0]
    try await validate(track, format: format)
    let segments = SourceSegment.occupied(of: try await track.load(.segments))
    guard segments.count == runs.count else {
      throw invalid("Canonical occupied run count changed.")
    }
    let trackRange = try await track.load(.timeRange)
    guard let lastRun = runs.last,
      CMTimeRangeGetEnd(trackRange)
        == (try timing.time(at: lastRun.declared + lastRun.count))
    else {
      throw invalid("Canonical media extent differs from its declared support.")
    }
    var hash = digest("yap.capture-pcm.v1", format: format)
    // This bounds each synchronous platform reader start, not the accepted run count. A giant
    // dense track can spend tens of seconds inside startReading before cancellation is observed.
    for first in stride(from: 0, to: runs.count, by: 1024) {
      try Task.checkCancellation()
      try autoreleasepool {
        let last = min(runs.count, first + 1024)
        let dense = AVMutableComposition()
        guard
          let target = dense.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid)
        else { throw invalid("Cannot inspect canonical PCM.") }
        target.naturalTimeScale = format.rate
        var ranges: [NSValue] = []
        var count: Int64 = 0
        for index in first..<last {
          let run = runs[index]
          let segment = segments[index]
          let start = try timing.time(at: run.declared)
          guard segment.asset.start == start,
            segment.asset.duration == CMTime(value: run.count, timescale: format.rate)
          else { throw invalid("Canonical support changed.") }
          ranges.append(NSValue(timeRange: segment.asset))
          count += run.count
        }
        try Task.checkCancellation()
        try target.insertTimeRanges(
          ranges, of: Array(repeating: track, count: ranges.count), at: .zero)
        try Task.checkCancellation()
        let decoder = AudioSourceReader(
          input: input, asset: dense, track: target,
          sampleRate: Int(format.rate), packetFrames: 1, channels: Int(format.channels))
        try decoder.begin(origin: ExactTime(0), at: 0, end: count)
        try Task.checkCancellation()
        var read: Int64 = 0
        while read < count {
          try Task.checkCancellation()
          guard let buffer = try decoder.next() else {
            throw invalid("Canonical PCM ended before its mapped native frame boundary.")
          }
          let bytes = Int(buffer.frameLength) * Int(format.channels) * 4
          hash.update(
            bufferPointer: UnsafeRawBufferPointer(start: buffer.floatChannelData![0], count: bytes))
          read += Int64(buffer.frameLength)
          guard read <= count else {
            throw invalid("Canonical decoder crossed its occupied sample boundary.")
          }
        }
        guard read == count else { throw invalid("Canonical native sample count changed.") }
      }
    }
    guard try CaptureMediaIdentity.read(url) == identity else {
      throw invalid("Canonical media changed during verification.")
    }
    return (hex(hash.finalize()), identity)
  }

  private static func digest(_ domain: String, format: JournalPCMTrack) -> SHA256 {
    var hash = SHA256()
    hash.update(data: Data((domain + "\0").utf8))
    integer(Int64(format.rate), into: &hash)
    integer(Int64(format.channels), into: &hash)
    return hash
  }
  private static func integer(_ value: Int64, into hash: inout SHA256) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { hash.update(bufferPointer: $0) }
  }
  private static func hex(_ digest: SHA256.Digest) -> String {
    digest.map { String(format: "%02x", $0) }.joined()
  }
  private static func invalid(_ message: String) -> CaptureFailure {
    CaptureFailure("MATERIALIZATION_FAILED", message)
  }
}
