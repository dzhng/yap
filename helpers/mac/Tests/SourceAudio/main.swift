@preconcurrency import AVFoundation
import Foundation
#if DEBUG
@testable import YapAudio
@testable import YapMedia
#else
import YapMedia
import YapAudio
#endif

let decodeFailure = NativeFailure.decodeFailed("fixture")
precondition(decodeFailure.code == "NATIVE_DECODE_FAILED" && decodeFailure.message == "fixture")

// These opt-in consumers execute only their selected source; the default suite stays small.
if let plan = ProcessInfo.processInfo.environment["YAP_AUDIO_SELECTED_PLAN"] {
    try await writeSelectedReference(plan)
    exit(0)
}
if let source = ProcessInfo.processInfo.environment["YAP_AUDIO_STREAM_SOURCE"],
    let value = ProcessInfo.processInfo.environment["YAP_AUDIO_STREAM_SECONDS"],
    let seconds = Int64(value),
    let path = ProcessInfo.processInfo.environment["YAP_SOURCE_AUDIO_EVIDENCE"] {
    try await streamingProof(source: source, seconds: seconds, evidence: URL(fileURLWithPath: path))
    exit(0)
}

#if DEBUG
// A seek is an interior point in an already selected native cell, including negative
// presentation origins and phases whose denominator cannot combine into CMTimeScale.
for rate in [8000, 44100, 48000, 192000] {
    for origin in [ExactTime(-100001), ExactTime(100001), ExactTime(100013),
        ExactTime(100000000001, 999983), ExactTime(Int128(TimeSpan.maximumMicroseconds) * 2)] {
        for frame: Int64 in [0, 1, 4096] {
            let seek = try ExactTime(AudioSourceReader.seekTime(origin: origin, frame: frame, sampleRate: rate))
            let start = try origin.subtract(ExactTime(-Int128(frame) * 1_000_000, Int128(rate)))
            let end = try origin.subtract(ExactTime(-Int128(frame + 1) * 1_000_000, Int128(rate)))
            let afterStart = try seek.subtract(start).numerator > 0
            let beforeEnd = try end.subtract(seek).numerator > 0
            precondition(afterStart && beforeEnd)
        }
    }
}

#endif

let directory = URL(
    fileURLWithPath: ProcessInfo.processInfo.environment["YAP_SOURCE_AUDIO_EVIDENCE"]
        ?? NSTemporaryDirectory() + UUID().uuidString)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
func cleanupEvidence() {
    if ProcessInfo.processInfo.environment["YAP_SOURCE_AUDIO_EVIDENCE"] == nil {
        try? FileManager.default.removeItem(at: directory)
    }
}
defer { cleanupEvidence() }
func finish() -> Never { cleanupEvidence(); exit(0) }
if CommandLine.arguments.contains("--source-streaming") {
    try await verifySourceStreaming(in: directory)
    finish()
}
if CommandLine.arguments.contains("--speaker-pcm") {
    try await verifySpeakerPCM(in: directory)
    finish()
}
let wireOnly = CommandLine.arguments.contains("--wire-fixtures")
func wave(_ url: URL) throws -> (rate: Int, channels: Int, samples: [Float]) {
    let data = try Data(contentsOf: url)
    func number(_ offset: Int) -> UInt32 {
        data.withUnsafeBytes {
            UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
        }
    }
    var position = 12
    var rate = 0
    var channels = 0
    while position + 8 <= data.count {
        let tag = String(decoding: data[position..<position + 4], as: UTF8.self)
        let size = Int(number(position + 4))
        position += 8
        if tag == "fmt " {
            channels = Int(data[position + 2]) | Int(data[position + 3]) << 8
            rate = Int(number(position + 4))
        }
        if tag == "data" {
            let samples = stride(from: position, to: position + size, by: 4).map {
                Float(bitPattern: number($0))
            }
            return (rate, channels, samples)
        }
        position += size + size % 2
    }
    fatalError("WAVE data missing")
}
func fixture(
    rate: Double, channels: Int, name: String, poison: Bool = false, discrete: Bool = false,
    seconds: Double = 1.1, frameCount: Int? = nil, sample: ((Int, Int) -> Float)? = nil
) throws -> URL {
    let url = directory.appendingPathComponent(name + ".caf")
    let format =
        channels > 2 || discrete
        ? AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: rate, interleaved: true,
            channelLayout: AVAudioChannelLayout(
                layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | UInt32(channels))!)
        : AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: rate,
            channels: AVAudioChannelCount(channels), interleaved: true)!
    let file = try AVAudioFile(
        forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32,
        interleaved: true)
    let count = frameCount ?? Int(rate * seconds)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
    buffer.frameLength = AVAudioFrameCount(count)
    for frame in 0..<count {
        for channel in 0..<channels {
            let excluded = frame >= Int(rate * 0.2) && frame < Int(rate * 0.3)
            buffer.floatChannelData![0][frame * channels + channel] =
                sample?(frame, channel) ?? (poison && excluded
                ? (channel == 0 ? 0.99 : -0.99) : Float((frame * (channel + 3)) % 101 - 50) / 100)
        }
    }
    try file.write(from: buffer)
    return url
}
func pcmMovie(_ source: URL) async throws -> URL {
    let file = try AVAudioFile(
        forReading: source, commonFormat: .pcmFormatFloat32, interleaved: true)
    let format = file.processingFormat
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: buffer)
    let url = source.appendingPathExtension("mov")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: format.settings)
    writer.add(input)
    precondition(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    var description: CMAudioFormatDescription?
    var basic = format.streamDescription.pointee
    CMAudioFormatDescriptionCreate(
        allocator: nil, asbd: &basic, layoutSize: 0, layout: nil,
        magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
    var sample: CMSampleBuffer?
    CMSampleBufferCreate(
        allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
        formatDescription: description, sampleCount: Int(buffer.frameLength),
        sampleTimingEntryCount: 1,
        sampleTimingArray: [
            CMSampleTimingInfo(
                duration: CMTime(value: 1, timescale: Int32(format.sampleRate)),
                presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        ],
        sampleSizeEntryCount: 1, sampleSizeArray: [4 * Int(format.channelCount)],
        sampleBufferOut: &sample)
    precondition(
        CMSampleBufferSetDataBufferFromAudioBufferList(
            sample!, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0,
            bufferList: buffer.audioBufferList) == noErr)
    while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(1)) }
    precondition(input.append(sample!))
    input.markAsFinished()
    await writer.finishWriting()
    precondition(writer.status == .completed)
    return url
}
func movie(_ sources: [URL], name: String) async throws -> (URL, [String]) {
    let composition = AVMutableComposition()
    for source in sources {
        let input = try await pcmMovie(source)
        let asset = AVURLAsset(url: input)
        defer { withExtendedLifetime(asset) {} }
        let audio = try await asset.loadTracks(withMediaType: .audio)[0]
        let target = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        for range in [
            TimeSpan(startUs: 0, endUs: 400_000), TimeSpan(startUs: 600_000, endUs: 1_000_000),
        ] {
            let sourceRange = CMTimeRange(
                start: CMTime(value: range.startUs, timescale: 1_000_000),
                end: CMTime(value: range.endUs, timescale: 1_000_000))
            let destinationTime = CMTime(value: 1_250_000 + range.startUs, timescale: 1_000_000)
            try target.insertTimeRange(sourceRange, of: audio, at: destinationTime)
        }
    }
    let url = directory.appendingPathComponent(name + ".mov")
    let export = AVAssetExportSession(
        asset: composition, presetName: AVAssetExportPresetPassthrough)!
    try await export.export(to: url, as: .mov)
    let tracks = try await AVURLAsset(url: url).loadTracks(withMediaType: .audio)
    return (url, tracks.map { "track:\($0.trackID)" })
}
if CommandLine.arguments.contains("--source-occupancy") {
    try await verifySourceOccupancy(in: directory)
    finish()
}

if CommandLine.arguments.contains("--source-stream") {
    try await verifySourceStream(in: directory)
    finish()
}

var cases = 0
if !wireOnly {
try await verifyDescriptorLifetime(
    source: fixture(rate: 48_000, channels: 1, name: "descriptor-lifetime", seconds: 0.1),
    parent: directory)
if CommandLine.arguments.contains("--descriptor-lifetime") { finish() }

try await verifySourceOccupancy(in: directory)
try await verifySourceStream(in: directory)

}

for rate in [44_100, 48_000] {
    let clean = try fixture(rate: Double(rate), channels: 2, name: "clean-\(rate)")
    let poison = try fixture(rate: Double(rate), channels: 2, name: "poison-\(rate)", poison: true)
    let other = try fixture(rate: Double(rate), channels: 1, name: "other-\(rate)")
    let (url, tracks) = try await movie([clean, other], name: "selected-\(rate)")
    let (poisonURL, poisonTracks) = try await movie(
        [poison, other], name: "poison-selected-\(rate)")
    let support = [
        TimeSpan(startUs: 13, endUs: 200_000), TimeSpan(startUs: 300_000, endUs: 999_987),
    ]
    let selection = AudioSourceSelection(
        source: url.path, streamId: tracks[0], sourceOffsetUs: ExactTime(-1_250_000), available: support.map(ExactRange.init))
    let fullRange = TimeSpan(startUs: 0, endUs: 1_000_000)
    let fullURL = directory.appendingPathComponent("full-\(rate).wav")
    let originalBytes = try Data(contentsOf: url)
    let full = try await SourceAudio.write(source: selection, range: ExactRange(fullRange), output: fullURL)
    let reference = try wave(fullURL)
    precondition(full.frames == Int64(rate) && reference.channels == 2)
    for frame in 0..<32 {
        for channel in 0..<2 {
            let expected = Float(((frame + 1) * (channel + 3)) % 101 - 50) / 100
            precondition(
                reference.samples[frame * 2 + channel] == expected,
                "Channel/source-frame mapping changed")
        }
    }
    precondition(
        full.unavailable == [
            TimeSpan(startUs: 0, endUs: 13), TimeSpan(startUs: 200_000, endUs: 300_000),
            TimeSpan(startUs: 400_000, endUs: 600_000),
            TimeSpan(startUs: 999_987, endUs: 1_000_000),
        ].map(ExactRange.init), "Unexpected unavailable: \(full.unavailable)")
    for (index, range) in [
        TimeSpan(startUs: 71, endUs: 199_991), TimeSpan(startUs: 199_997, endUs: 600_013),
        TimeSpan(startUs: 610_013, endUs: 999_981),
    ].enumerated() {
        let output = directory.appendingPathComponent("part-\(rate)-\(index).wav")
        let part = try await SourceAudio.write(source: selection, range: ExactRange(range), output: output)
        let actual = try wave(output)
        precondition(part.sampleRange.start == range.startUs * Int64(rate) / 1_000_000)
        precondition(part.sampleRange.end == range.endUs * Int64(rate) / 1_000_000)
        precondition(
            actual.samples
                == Array(
                    reference.samples[
                        Int(part.sampleRange.start) * 2..<Int(part.sampleRange.end) * 2]),
            "Window PCM differs from full source output")
        cases += 1
    }
    let poisonOutput = directory.appendingPathComponent("poison-\(rate).wav")
    _ = try await SourceAudio.write(
        source: .init(
            source: poisonURL.path, streamId: poisonTracks[0], sourceOffsetUs: ExactTime(-1_250_000),
            available: support.map(ExactRange.init)), range: ExactRange(fullRange), output: poisonOutput)
    let poisoned = try wave(poisonOutput)
    precondition(poisoned.samples == reference.samples, "Excluded poison leaked")
    let monoOutput = directory.appendingPathComponent("mono-\(rate).wav")
    let mono = try await SourceAudio.write(
        source: .init(
            source: url.path, streamId: tracks[1], sourceOffsetUs: ExactTime(-1_250_000),
            available: [.init(startUs: 0, endUs: 1_000_000)]), range: ExactRange(fullRange), output: monoOutput)
    precondition(mono.channels == 1 && mono.layout == "mono")
    let remainingBytes = try Data(contentsOf: url)
    precondition(originalBytes == remainingBytes)
    let request: [String: Any] = [
        "source": [
            "source": url.path, "streamId": tracks[0], "sourceOffsetUs": -1_250_000,
            "available": support.map { ["startUs": $0.startUs, "endUs": $0.endUs] },
        ], "range": ["startUs": 0, "endUs": 1_000_000],
        "output": directory.appendingPathComponent("wire-\(rate).wav").path,
    ]
    try JSONSerialization.data(withJSONObject: request).write(
        to: directory.appendingPathComponent("request-\(rate).json"))
}
if wireOnly {
    print("Wire fixtures ready: 44100/48000 stereo source clocks and holes")
    finish()
}
// Noninteger file extents must admit and select every physical sample. Integer floor requests
// remain deliberately shorter, and late views retain the same physical source-frame addresses.
for (rate, count) in [(48_000, 246_478), (44_100, 44_117), (44_100, 44_116)] {
    let source = try fixture(rate: Double(rate), channels: 1, name: "exact-end-\(rate)-\(count)", frameCount: count)
    let probed = try await MediaProbe.inspect(url: source)
    let stream = probed.streams[0]
    let end = ExactTime(Int128(count) * 1_000_000, Int128(rate))
    precondition(probed.originUs == ExactTime(0) && stream.startUs == ExactTime(0) && stream.endUs == end)
    let range = ExactRange(startUs: ExactTime(0), endUs: end)
    let selected = AudioSourceSelection(source: source.path, streamId: stream.id,
        sourceOffsetUs: ExactTime(0), available: [range])
    let intervals = try await AudioPCMStream.readableIntervals(of: selected)
    precondition(intervals == [range], "Speech/source support was rounded before decoding")
    let expected = (0..<count).map { Float(($0 * 3) % 101 - 50) / 100 }
    precondition(expected.last != 0)
    let fullURL = directory.appendingPathComponent("exact-end-\(rate)-\(count)-full.wav")
    let full = try await SourceAudio.write(source: selected, range: range, output: fullURL)
    let fullPCM = try wave(fullURL).samples
    precondition(full.frames == Int64(count) && full.unavailable.isEmpty && fullPCM == expected)
    let first = count - 127
    let lateRange = ExactRange(startUs: ExactTime(Int128(first) * 1_000_000, Int128(rate)), endUs: end)
    let lateURL = directory.appendingPathComponent("exact-end-\(rate)-\(count)-late.wav")
    let late = try await SourceAudio.write(source: selected, range: lateRange, output: lateURL)
    let latePCM = try wave(lateURL).samples
    precondition(late.frames == 127 && latePCM == Array(expected[first...]))
    let floorRange = ExactRange(startUs: ExactTime(0), endUs: ExactTime(Int128(try end.sample(1_000_000))))
    let floorURL = directory.appendingPathComponent("exact-end-\(rate)-\(count)-floor.wav")
    let floorResult = try await SourceAudio.write(source: selected, range: floorRange, output: floorURL)
    let floorPCM = try wave(floorURL).samples
    precondition(floorResult.frames == Int64(count - 1) && floorPCM == Array(expected.dropLast()))
}
print("PASS exact48k/44.1k admission, complete/late PCM and explicit-floor semantics")

// Two streams share one fractional container origin. The later stream begins a third of a
// microsecond into normalized source time, between output samples; it must not acquire silence.
do {
    let count = 48_017
    let input = try await pcmMovie(fixture(rate: 48_000, channels: 1, name: "fractional-origin", frameCount: count + 4096))
    let asset = AVURLAsset(url: input)
    defer { withExtendedLifetime(asset) {} }
    let source = try await asset.loadTracks(withMediaType: .audio)[0]
    let composition = AVMutableComposition()
    for anchor: Int64 in [2_000_002, 2_000_004] {
        let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        track.naturalTimeScale = 6_000_000
        try track.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: Int64(count), timescale: 48_000)),
            of: source, at: CMTime(value: anchor, timescale: 6_000_000))
    }
    let file = directory.appendingPathComponent("fractional-shared-origin.mov")
    try await AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!.export(to: file, as: .mov)
    let metadata = try await MediaProbe.inspect(url: file)
    precondition(metadata.originUs == ExactTime(1_000_001, 3))
    precondition(metadata.streams.count == 2)
    let lateStream = metadata.streams[1]
    precondition(lateStream.startUs == ExactTime(1, 3))
    precondition(lateStream.segments!.contains { $0.empty && $0.startUs.numerator < 0 })
    let range = ExactRange(startUs: lateStream.startUs!, endUs: lateStream.endUs!)
    let selection = AudioSourceSelection(source: file.path, streamId: lateStream.id,
        sourceOffsetUs: try ExactTime(0).subtract(metadata.originUs), available: [range])
    let expected = (0..<count).map { Float(($0 * 3) % 101 - 50) / 100 }
    let fullURL = directory.appendingPathComponent("fractional-origin-full.wav")
    let full = try await SourceAudio.write(source: selection, range: range, output: fullURL)
    let samples = try wave(fullURL).samples
    precondition(full.frames == Int64(count) && samples == expected && full.unavailable.isEmpty,
        "Fractional relative support changed the first or last physical sample")
    let lateRange = ExactRange(startUs: try range.startUs.adding(ExactTime(Int128(count - 127) * 1_000_000, 48_000)), endUs: range.endUs)
    let lateURL = directory.appendingPathComponent("fractional-origin-late.wav")
    let late = try await SourceAudio.write(source: selection, range: lateRange, output: lateURL)
    let lateSamples = try wave(lateURL).samples
    precondition(late.frames == 127 && lateSamples == Array(expected.suffix(127)))
    try JSONEncoder().encode(metadata).write(to: directory.appendingPathComponent("fractional-origin-probe.json"))
}
print("PASS fractional shared origin, unequal stream starts, signed leading empty and native first/last PCM")
try await verifyMixedAVSupport(in: directory)

// A sample-aligned physical edit need not have an integral microsecond boundary.
let rationalInput = try await pcmMovie(fixture(rate: 48_000, channels: 1, name: "rational-source", seconds: 2.1))
let rationalAsset = AVURLAsset(url: rationalInput)
let rationalSource = try await rationalAsset.loadTracks(withMediaType: .audio)[0]
let rationalComposition = AVMutableComposition()
let rationalTrack = rationalComposition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
rationalTrack.naturalTimeScale = 6_000_000
for (sourceStart, count, targetStart) in [(0, 32768, 4800), (40960, 55040, 45760)] {
    try rationalTrack.insertTimeRange(
        CMTimeRange(start: CMTime(value: Int64(sourceStart), timescale: 48000), duration: CMTime(value: Int64(count), timescale: 48000)),
        of: rationalSource, at: CMTime(value: Int64(targetStart), timescale: 48000))
}
let rationalURL = directory.appendingPathComponent("rational-segments.mov")
try await AVAssetExportSession(asset: rationalComposition, presetName: AVAssetExportPresetPassthrough)!.export(to: rationalURL, as: .mov)
let rationalPublished = try await AVURLAsset(url: rationalURL).loadTracks(withMediaType: .audio)[0]
let rationalSegments = SourceSegment.occupied(of: try await rationalPublished.load(.segments))
precondition(rationalSegments[1].asset.start == CMTime(value: 45760, timescale: 48000))
let rationalSelection = AudioSourceSelection(source: rationalURL.path, sourceOffsetUs: ExactTime(0), available: [.init(startUs: 0, endUs: 2_100_000)])
let rationalFullURL = directory.appendingPathComponent("rational-full.wav")
_ = try await SourceAudio.write(source: rationalSelection, range: .init(startUs: 0, endUs: 2_100_000), output: rationalFullURL)
let rationalFull = try wave(rationalFullURL).samples
var rationalExpected = [Float](repeating: 0, count: 100800)
for (sourceStart, count, targetStart) in [(0, 32768, 4800), (40960, 55040, 45760)] {
    for frame in 0..<count { rationalExpected[targetStart + frame] = Float(((sourceStart + frame) * 3) % 101 - 50) / 100 }
}
precondition(rationalFull == rationalExpected, "Physical rational segments changed full source sample placement")
let rationalLateURL = directory.appendingPathComponent("rational-late.wav")
_ = try await SourceAudio.write(source: rationalSelection, range: .init(startUs: 1_200_000, endUs: 1_400_000), output: rationalLateURL)
let rationalLate = try wave(rationalLateURL).samples
precondition(rationalLate == Array(rationalExpected[57600..<67200]), "Late source window lost the physical segment phase")
// Acquisition remains binding even when physical media exists outside it.
let acquiredURL = directory.appendingPathComponent("rational-acquired.wav")
_ = try await SourceAudio.write(
    source: .init(source: rationalURL.path, sourceOffsetUs: ExactTime(0), available: [.init(startUs: 1_200_000, endUs: 1_400_000)]),
    range: .init(startUs: 1_000_000, endUs: 1_500_000), output: acquiredURL)
let acquired = try wave(acquiredURL).samples
precondition(acquired == [Float](repeating: 0, count: 9600) + Array(rationalExpected[57600..<67200]) + [Float](repeating: 0, count: 4800))
print("PASS exact physical segment phase in full/late windows with binding acquisition support")

// Independent native-address oracle for non-grid phases and acquisition-mask edges.
for rate in [44100, 48000] {
    let input = try await pcmMovie(fixture(rate: Double(rate), channels: 1, name: "phase-source-\(rate)", seconds: 2.1))
    let asset = AVURLAsset(url: input)
    defer { withExtendedLifetime(asset) {} }
    let track = try await asset.loadTracks(withMediaType: .audio)[0]
    for anchor: Int64 in [100001, 100013] {
        let composition = AVMutableComposition()
        let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        target.naturalTimeScale = rate == 44100 ? 441000000 : 6000000
        try target.insertTimeRange(CMTimeRange(start: CMTime(value: 0, timescale: Int32(rate)), duration: CMTime(value: Int64(rate) * 2, timescale: Int32(rate))),
            of: track, at: CMTime(value: anchor, timescale: 1000000))
        let file = directory.appendingPathComponent("phase-\(rate)-\(anchor).mov")
        try await AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!.export(to: file, as: .mov)
        let end = anchor + 2000000
        for maskStart: Int64 in [anchor, 1200001, 1200013] {
            let maskEnd = maskStart == anchor ? end : 1400013
            let selection = AudioSourceSelection(source: file.path, sourceOffsetUs: ExactTime(0),
                available: [.init(startUs: maskStart, endUs: maskEnd)])
            let fullURL = directory.appendingPathComponent("phase-\(rate)-\(anchor)-\(maskStart)-full.wav")
            _ = try await SourceAudio.write(source: selection, range: .init(startUs: 0, endUs: end), output: fullURL)
            let full = try wave(fullURL).samples
            var expected = [Float](repeating: 0, count: Int(end * Int64(rate) / 1000000))
            let outputStart = Int(maskStart * Int64(rate) / 1000000)
            let outputEnd = Int(maskEnd * Int64(rate) / 1000000)
            let sourceFirst = Int(((maskStart - anchor) * Int64(rate) + 500000) / 1000000)
            for i in outputStart..<outputEnd { expected[i] = Float(((sourceFirst + i - outputStart) * 3) % 101 - 50) / 100 }
            precondition(full == expected, "Physical phase or acquisition mask changed native sample identity")
            let lateURL = directory.appendingPathComponent("phase-\(rate)-\(anchor)-\(maskStart)-late.wav")
            _ = try await SourceAudio.write(source: selection, range: .init(startUs: 1200011, endUs: 1299567), output: lateURL)
            let late = try wave(lateURL).samples
            precondition(late == Array(expected[Int(1200011 * Int64(rate) / 1000000)..<Int(1299567 * Int64(rate) / 1000000)]))
        }
    }
}
print("PASS arbitrary physical phase and acquisition-mask native addresses at44.1/48k")

for (rate, channels, discrete) in [(44_100.5, 2, false), (48_000.0, 4, true), (48_000.0, 2, true)] {
    let source = try fixture(
        rate: rate, channels: channels, name: "unsupported-\(rate)-\(channels)", discrete: discrete)
    #if DEBUG
    if rate.rounded() != rate {
        do {
            _ = try await SourceTrack.open(selection: AudioSourceSelection(
                source: source.path, sourceOffsetUs: ExactTime(0),
                available: [.init(startUs: 0, endUs: 1_000_000)]))
            fatalError("Common audio execution accepted a fractional native rate")
        } catch let error as NativeFailure { precondition(error.code == "UNSUPPORTED_FORMAT") }
    }
    #endif
    do {
        _ = try await SourceAudio.write(
            source: .init(
                source: source.path, sourceOffsetUs: ExactTime(0),
                available: [.init(startUs: 0, endUs: 1_000_000)]),
            range: .init(startUs: 0, endUs: 100_000),
            output: directory.appendingPathComponent("unsupported-\(channels).wav"))
        fatalError("Unsupported source format accepted")
    } catch let error as NativeFailure { precondition(error.code == "UNSUPPORTED_FORMAT") }
}
let longSource = try fixture(rate: 48_000, channels: 2, name: "long", seconds: 60)
let longSelection = AudioSourceSelection(
    source: longSource.path, sourceOffsetUs: ExactTime(0), available: [.init(startUs: 0, endUs: 60_000_000)])
let longOutput = directory.appendingPathComponent("long.wav")
_ = try await SourceAudio.write(
    source: longSelection, range: .init(startUs: 0, endUs: 60_000_000), output: longOutput)
let lateOutput = directory.appendingPathComponent("late.wav")
let late = try await SourceAudio.write(
    source: longSelection, range: .init(startUs: 59_000_071, endUs: 59_020_013), output: lateOutput)
let fullLong = try wave(longOutput)
let lateWave = try wave(lateOutput)
precondition(
    lateWave.samples
        == Array(fullLong.samples[Int(late.sampleRange.start) * 2..<Int(late.sampleRange.end) * 2]))
precondition(
    late.decodedFrames <= late.frames + 3, "PCM demand exceeded two lookbehind frames and one endpoint cell: \(late.decodedFrames)")
print("Late 20ms window decoded \(late.decodedFrames) native frames from a 60-second source")
// Descriptor accounting is independent of whether an inspection-byte budget applies.
let descriptorFile = try FileHandle(forReadingFrom: longSource)
for purpose in [MediaInput.ReadPurpose.inspection, .streaming] {
    let input = try MediaInput(url: URL(fileURLWithPath: "/dev/fd/\(descriptorFile.fileDescriptor)"), purpose: purpose)
    let tracks = try await input.asset.loadTracks(withMediaType: .audio)
    precondition(!tracks.isEmpty)
    _ = try await tracks[0].load(.formatDescriptions)
    let work = input.readWork!
    FileHandle.standardError.write(Data("Descriptor \(purpose): read=\(work.readBytes) delivered=\(work.deliveredBytes)\n".utf8))
    precondition(work.deliveredBytes > 0, "Streaming reads must not masquerade as zero I/O")
    precondition(work.readBytes == work.deliveredBytes + 12)
}
try descriptorFile.close()
#if DEBUG
// The platform parser borrows positional reads from a retained descriptor. Its allowance
// is the caller's remaining inspection budget, including prior header/delivery work.
let identitySource = try fixture(rate: 48_000, channels: 2, name: "identity", seconds: 0.1)
let identityFile = try FileHandle(forReadingFrom: identitySource)
try identityFile.seek(toOffset: 123)
let identityDescriptor = try MediaDescriptor(
    url: URL(fileURLWithPath: "/dev/fd/\(identityFile.fileDescriptor)"), writable: false)!
let identity = try DescriptorAudioType.identify(identityDescriptor, maximumBytes: 64 * 1024 * 1024)
let identityOffset = try identityFile.offset()
precondition(identityOffset == 123)
try identityFile.close()
try FileManager.default.removeItem(at: identitySource)
let exactIdentity = try DescriptorAudioType.identify(identityDescriptor, maximumBytes: identity.readBytes)
precondition(exactIdentity.type.contentType == identity.type.contentType)
precondition(exactIdentity.readBytes == identity.readBytes)
for remaining in [Int64(0), identity.readBytes - 1] {
    do {
        _ = try DescriptorAudioType.identify(identityDescriptor, maximumBytes: remaining)
        fatalError("Identification exceeded its remaining inspection allowance")
    } catch let error as NativeFailure { precondition(error.code == "LIMIT_EXCEEDED") }
}
print("Container identification exact allowance \(identity.readBytes) bytes; one byte short refused; offset and closed/unlinked lifetime preserved")
#endif
let urlInput = try MediaInput(url: longSource)
let urlTracks = try await urlInput.asset.loadTracks(withMediaType: .audio)
let urlWork = urlInput.readWork!
precondition(urlTracks.count == 1 && urlWork.deliveredBytes > 0
    && urlWork.readBytes >= urlWork.deliveredBytes,
    "Normal-path metadata must retain source authority and report actual logical read work")
let capacitySource = directory.appendingPathComponent("clean-48000.caf")
let capacitySelection = AudioSourceSelection(
    source: capacitySource.path, sourceOffsetUs: ExactTime(0), available: [])
let capacityOutput = directory.appendingPathComponent("oversize.wav")
do {
    _ = try await SourceAudio.write(
        source: capacitySelection, range: .init(startUs: 0, endUs: 20_000_000_000),
        output: capacityOutput)
    fatalError("Oversize RIFF accepted")
} catch let error as NativeFailure { precondition(error.code == "LIMIT_EXCEEDED") }
precondition(!FileManager.default.fileExists(atPath: capacityOutput.path))
let canceledOutput = directory.appendingPathComponent("canceled.wav")
let pending = Task.detached {
    try await SourceAudio.write(
        source: capacitySelection, range: .init(startUs: 0, endUs: 600_000_000),
        output: canceledOutput)
}
var began = false
for _ in 0..<1000 {
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    if names.contains(where: { $0.hasPrefix(".yap-output-") }) {
        began = true
        break
    }
    try await Task.sleep(for: .milliseconds(1))
}
precondition(began, "Did not observe active output staging")
pending.cancel()
do {
    _ = try await pending.value
    fatalError("Canceled output published")
} catch is CancellationError {}
precondition(!FileManager.default.fileExists(atPath: canceledOutput.path))
let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
precondition(!remaining.contains(where: { $0.hasPrefix(".yap-output-") }))
print(
    "Source windows passed \(cases) full/range comparisons, dual stream mono/stereo, physical/acquisition gaps and poison isolation; unsupported rate/channel count refused. Evidence: \(directory.path)"
)

// Repeated demands preserve native sample identity while extending finite reader coverage.
let reuseInput = try MediaInput(url: longSource)
let reuseTrack = try await reuseInput.asset.loadTracks(withMediaType: .audio)[0]
@MainActor func reuseReader() -> AudioSourceReader {
    AudioSourceReader(input: reuseInput, asset: reuseInput.asset, track: reuseTrack,
        sampleRate: 48_000, packetFrames: 1, channels: 2)
}
func verifySelection(_ decoder: AudioSourceReader, _ start: Int64, _ end: Int64, originUs: Int64 = 0) throws {
    try decoder.begin(origin: ExactTime(Int128(originUs)), at: start, end: end)
    var values: [Float] = []
    while let buffer = try decoder.next() {
        values.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength) * 2))
    }
    let originFrame = originUs * 48_000 / 1_000_000
    precondition(values == Array(fullLong.samples[Int(originFrame + start) * 2..<Int(originFrame + end) * 2]))
}
let shared = reuseReader()
for pair: (Int64, Int64) in [(0, 0), (0, 100), (100, 200), (199, 220), (220, 220), (220, 230), (2, 4), (230, 300), (96_000, 96_013)] {
    try verifySelection(shared, pair.0, pair.1)
}
let contiguous = reuseReader()
try verifySelection(contiguous, 0, 100)
try verifySelection(contiguous, 100, 200)
let isolatedA = reuseReader(), isolatedB = reuseReader()
try verifySelection(isolatedA, 0, 100)
try verifySelection(isolatedB, 100, 200)
precondition(contiguous.decodedFrames < isolatedA.decodedFrames + isolatedB.decodedFrames,
    "Contiguous extension discarded reusable pending PCM")
print("PASS finite demand reuse across contiguous, overlap, empty, backwards and gapped ranges; shared \(contiguous.decodedFrames) vs independent \(isolatedA.decodedFrames + isolatedB.decodedFrames) decoded frames")

let emptyOrigin = reuseReader()
try verifySelection(emptyOrigin, 0, 100)
try verifySelection(emptyOrigin, 100, 100, originUs: 1_000_000)
try verifySelection(emptyOrigin, 100, 200)
try verifySelection(emptyOrigin, 0, 0, originUs: 1_000_000)
try verifySelection(emptyOrigin, 0, 100, originUs: 1_000_000)
try verifySelection(emptyOrigin, 100, 100)
try verifySelection(emptyOrigin, 100, 200, originUs: 1_000_000)
let shortPhysical = reuseReader()
for count: Int64 in [20, 10] {
    try shortPhysical.begin(origin: ExactTime(0), at: 2_880_000 - count, end: 2_880_000 + count)
    var samples: [Float] = []
    while let buffer = try shortPhysical.next() {
        samples.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength) * 2))
    }
    precondition(samples == Array(fullLong.samples.suffix(Int(count) * 2)))
    precondition(!shortPhysical.reachedSelectionEnd)
    let decoded = shortPhysical.decodedFrames
    let exhausted = try shortPhysical.next()
    precondition(exhausted == nil)
    precondition(shortPhysical.decodedFrames == decoded, "Premature EOF kept reopening without progress")
}
try shortPhysical.begin(origin: ExactTime(0), at: 2_880_000, end: 2_880_030)
let stillExhausted = try shortPhysical.next()
precondition(stillExhausted == nil)
precondition(!shortPhysical.reachedSelectionEnd)
print("PASS zero-demand origin changes preserve next source address; premature finite EOF never pads or loops across later demands")
try await verifySourceStreaming(in: directory)
