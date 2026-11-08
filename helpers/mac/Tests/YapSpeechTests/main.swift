import FluidAudio
import Foundation

import YapSpeech
import YapMedia

if CommandLine.arguments.contains("--help") {
    print("Usage: YapSpeechTests [--boundary-cases <json> [--case <id>]]\nReplays retained observations with no inference or model access. Paths in the case file are relative to that file.")
    exit(0)
}

// Many short physical runs are valid even in a short take; window count is not a product limit.
let fragmented = (0..<10_002).map { n in
    ExactRange(startUs: ExactTime(Int128(n * 2)), endUs: ExactTime(Int128(n * 2 + 1)))
}
let fragmentedWindows = try SpeechWindows.plan(available: fragmented, execution: SpeechExecution())
precondition(fragmentedWindows.map(\.owned) == fragmented)
print("PASS all 10002 physical speech runs are retained")

/// The engine's tokens, grouped into words the way the evaluated CLI groups them, and timed by the
/// speech-bearing tokens while retaining overlapping estimates.

func timing(_ token: String, _ start: TimeInterval, _ end: TimeInterval, _ confidence: Float = 1)
    -> TokenTiming
{
    TokenTiming(token: token, tokenId: 0, startTime: start, endTime: end, confidence: confidence)
}

func check(_ condition: Bool, _ message: @autoclosure () -> String) {
    precondition(condition, message())
}

// A sentence ends with a punctuation token of its own, which this model places well after the last
// sound. The word keeps the mark in its text and the engine's own times, and is timed by its speech.
let sentence = WordTimingMerger.mergeTokensIntoWords([
    timing(" dis", 4.72, 4.88),
    timing("pl", 4.88, 5.20),
    timing("ay", 5.20, 5.52),
    timing(".", 5.84, 6.16),
]).words
check(sentence.count == 1, "One word, got \(sentence.map(\.word))")
check(sentence[0].word == "display.", "Text keeps the mark, got \(sentence[0].word)")
check(sentence[0].endTime == 6.16, "The engine's own end is kept, got \(sentence[0].endTime)")
check(
    sentence[0].spokenStart == 4.72 && sentence[0].spokenEnd == 5.52,
    "Spoken extent must stop at the last sound, got \(sentence[0].spokenStart)–\(sentence[0].spokenEnd)")
print("PASS a trailing mark does not carry the word's end through the silence after it")

// A mark inside a word is surrounded by speech, so it changes nothing.
let inside = WordTimingMerger.mergeTokensIntoWords([
    timing(" U", 1.0, 1.2),
    timing(".", 1.2, 1.3),
    timing("S", 1.3, 1.5),
    timing(".", 1.5, 1.6),
]).words
check(inside.count == 1 && inside[0].word == "U.S.", "Got \(inside.map(\.word))")
check(
    inside[0].spokenStart == 1.0 && inside[0].spokenEnd == 1.5,
    "Got \(inside[0].spokenStart)–\(inside[0].spokenEnd)")
print("PASS a mark between letters leaves the word timed by its letters")

// Punctuation standing alone as its own word has no speech to be timed by, so it keeps its own.
let alone = WordTimingMerger.mergeTokensIntoWords([
    timing(" first", 0.5, 0.9),
    timing(" --", 2.0, 2.2),
]).words
check(alone.count == 2 && alone[1].word == "--", "Got \(alone.map(\.word))")
check(
    alone[1].spokenStart == 2.0 && alone[1].spokenEnd == 2.2,
    "Got \(alone[1].spokenStart)–\(alone[1].spokenEnd)")
print("PASS a word that is only a mark keeps the one time the engine gave it")

// Ordinary words are unchanged: what the CLI reports is what this reports.
let plain = WordTimingMerger.mergeTokensIntoWords([
    timing(" Open", 1.68, 2.24, 0.5),
    timing(" the", 2.24, 2.48, 1.0),
]).words
check(plain.count == 2, "Got \(plain.map(\.word))")
check(
    plain.allSatisfy { $0.spokenStart == $0.startTime && $0.spokenEnd == $0.endTime },
    "Spoken extent must equal the engine's span when every token is speech")
check(abs(plain[0].confidence - 0.5) < 1e-6, "Confidence stays the token average")
print("PASS a word of plain speech reports exactly the engine's own span")

// The engine puts several tokens on one frame, so a contraction's first word can be reported as
// covering the whole of the next one. Estimates retain that uncertainty rather than cutting it away.
let contraction = WordTimingMerger.mergeTokensIntoWords([
    timing(" I", 7.008, 7.168),
    timing("'", 7.168, 7.248),
    timing("m", 7.248, 7.328),
    timing(" going", 7.248, 7.328),
]).words
check(contraction.map(\.word) == ["I'm", "going"], "Got \(contraction.map(\.word))")
check(
    contraction[0].spokenEnd == 7.328 && contraction[1].spokenStart == 7.248,
    "Overlapping estimates must retain their operands, got "
        + "\(contraction[0].spokenEnd) and \(contraction[1].spokenStart)")
check(
    contraction[0].spokenStart == 7.008 && contraction[1].spokenEnd == 7.328,
    "Only the overlap moves: got \(contraction[0].spokenStart) and \(contraction[1].spokenEnd)")
print("PASS overlapping word estimates retain both extents")

// A word's last token is not always its latest, for the same reason.
let unordered = WordTimingMerger.mergeTokensIntoWords([
    timing(" wo", 1.0, 1.4),
    timing("rd", 1.2, 1.28),
]).words
check(
    unordered[0].spokenEnd == 1.4 && unordered[0].endTime == 1.4,
    "A word ends where its speech ends, got \(unordered[0].spokenEnd)")
print("PASS a word ends at its latest token, not its last one")

// Numbers are speech too; a year must not be read as punctuation.
let number = WordTimingMerger.mergeTokensIntoWords([timing(" 2026", 3.0, 3.4)]).words
check(
    number[0].spokenStart == 3.0 && number[0].spokenEnd == 3.4,
    "Got \(number[0].spokenStart)–\(number[0].spokenEnd)")
print("PASS digits count as speech")

// Binary-exact engine offsets straddle the nearest-microsecond boundary only after adding
// the physical interval origin; pre-rounding the offset loses the lower word boundary.
let exactInterval = ExactRange(startUs: ExactTime(1, 4), endUs: ExactTime(2_000_001, 4))
let mapped = try SourceTranscript.sourceSpan(from: 1.0 / 4_194_304, to: 1.0 / 2_097_152, in: exactInterval)
check(mapped?.source == TimeSpan(startUs: 0, endUs: 1) && mapped?.clamped == false,
    "Engine labels must round only after exact origin mapping")
for (start, end) in [(-1.0, 0.1), (0.2, 0.1), (Double.nan, 0.1), (0.0, Double.infinity)] {
    check(try SourceTranscript.sourceSpan(from: start, to: end, in: exactInterval) == nil,
        "A malformed estimate \(start)–\(end) has no span")
}
print("PASS exact speech interval mapping before integer word-label projection")

// The engine's last frame can end past the decoded audio: at the physical end of media (receipt 02,
// 18.7 ms) or at a caller's window end (receipt 04, 60 ms). The estimate is clamped to the edge.
let mediaEnd = ExactRange(startUs: ExactTime(215_000_000), endUs: ExactTime(695_104_000, 3))
let overrun = try SourceTranscript.sourceSpan(from: 16.56, to: 16.72, in: mediaEnd)
check(overrun?.source == TimeSpan(startUs: 231_560_000, endUs: 231_701_333) && overrun?.clamped == true,
    "An overrun clamps to the decoded edge, got \(String(describing: overrun))")
let beyond = try SourceTranscript.sourceSpan(from: 0, to: 9000, in: exactInterval)
check(beyond?.source == TimeSpan(startUs: 0, endUs: 500_000) && beyond?.clamped == true,
    "An estimate past every window still clamps, got \(String(describing: beyond))")
let late = try SourceTranscript.sourceSpan(from: 12.6, to: 12.68, in: ExactRange(startUs: ExactTime(219_000_000), endUs: ExactTime(231_500_000)))
check(late?.source == TimeSpan(startUs: 231_500_000, endUs: 231_500_000) && late?.clamped == true,
    "An estimate wholly past the edge becomes a point at the edge, got \(String(describing: late))")
print("PASS an estimate past the decoded window is clamped to its edge")

// The API returns the binary Double, not an ideal decimal half microsecond. Preserve that value
// through mapping; multiplying first can round it to a different side of the final label boundary.
let decimalHalf = try SourceTranscript.sourceSpan(from: 0.0000005, to: 0.0000015,
    in: ExactRange(startUs: 0, endUs: 10))
check(decimalHalf?.source == TimeSpan(startUs: 0, endUs: 2), "Double authority must survive label mapping")
print("PASS binary engine seconds at a decimal half-microsecond label boundary")

for invalid in [timing(" bad", .nan, 0.1), timing(" bad", 0.2, 0.1),
                timing(" bad", -0.1, 0.1), timing(" bad", 0, 0.1, .nan),
                timing(" bad", 0, 0.1, 1.1)] {
    let merged = WordTimingMerger.mergeTokensIntoWords([timing(" ok", 0, 0.1), invalid, timing(" fine", 0.3, 0.4)])
    check(merged.words.map(\.word) == ["ok", "fine"], "Neighbours of a malformed word publish, got \(merged.words.map(\.word))")
    check(merged.dropped.count == 1 && merged.dropped[0].token == 1 && merged.dropped[0].text == "bad",
        "The malformed word is dropped and identified by its token, got \(merged.dropped)")
}
let inner = WordTimingMerger.mergeTokensIntoWords([timing(" wo", 1.0, 1.2), timing("rd", .nan, 1.4), timing(" next", 1.5, 1.6)])
check(inner.words.map(\.word) == ["next"] && inner.dropped.map(\.text) == ["word"] && inner.dropped[0].token == 1,
    "A malformed token inside a word drops the whole word, got \(inner)")
print("PASS a malformed token drops its word and its neighbours still publish")

let boundedWindows = try SpeechWindows.plan(available: [ExactRange(startUs: 0, endUs: 45_000_000),
    ExactRange(startUs: 50_000_000, endUs: 85_000_000)], execution: SpeechExecution(
    executionRange: ExactRange(startUs: 10_000_000, endUs: 70_000_000),
    context: SpeechContext(beforeUs: 2_000_000, afterUs: 3_000_000)))
check(boundedWindows.map(\.owned) == [ExactRange(startUs: 10_000_000, endUs: 30_000_000),
    ExactRange(startUs: 30_000_000, endUs: 45_000_000), ExactRange(startUs: 50_000_000, endUs: 70_000_000)],
    "Primary ownership must split the requested source scope without filling its physical gap")
check(boundedWindows.map(\.decoded) == [ExactRange(startUs: 8_000_000, endUs: 34_000_000),
    ExactRange(startUs: 26_000_000, endUs: 45_000_000), ExactRange(startUs: 50_000_000, endUs: 73_000_000)],
    "Outer context and internal overlap must remain inside the original readable run")
let fullWindows = try SpeechWindows.plan(available: [ExactRange(startUs: 0, endUs: 100_000_000)], execution: SpeechExecution())
let fullWindowDurations = try fullWindows.map { try $0.decoded.endUs.subtract($0.decoded.startUs) }
let decodedWindowsAreBounded = try fullWindowDurations.allSatisfy { try $0.compare(ExactTime(28_000_000)) != .orderedDescending }
check(fullWindows.count == 5 && decodedWindowsAreBounded,
    "Full-source inference must still decode bounded support")
print("PASS bounded and full-source planning retain primary ownership, outer context and real gaps")

// Independent decodes can disagree about which side owns the same seam observation.
let seam = try SpeechBoundaryMerge.resolve(
    left: [SpeechObservation(text: "Again,", source: TimeSpan(startUs: 19_950_000, endUs: 20_120_000))],
    right: [SpeechObservation(text: "again", source: TimeSpan(startUs: 20_030_000, endUs: 20_200_000))],
    boundaryUs: ExactTime(20_000_000), shared: ExactRange(startUs: 18_000_000, endUs: 22_000_000))
check(seam.pairs == [SpeechBoundaryPair(left: 0, right: 0, selected: .left)],
    "A physically overlapping occurrence with two start owners must publish once")
print("PASS seam observations retain one original occurrence when starts disagree")

let ownerless = try SpeechBoundaryMerge.resolve(
    left: [SpeechObservation(text: "again", source: TimeSpan(startUs: 20_030_000, endUs: 20_200_000))],
    right: [SpeechObservation(text: "again", source: TimeSpan(startUs: 19_950_000, endUs: 20_120_000))],
    boundaryUs: ExactTime(20_000_000), shared: ExactRange(startUs: 18_000_000, endUs: 22_000_000))
check(ownerless.pairs == [SpeechBoundaryPair(left: 0, right: 0, selected: .left)],
    "A peer pair with no start owner must still publish once")
let repeated = try SpeechBoundaryMerge.resolve(
    left: [SpeechObservation(text: "go", source: TimeSpan(startUs: 19_600_000, endUs: 19_800_000)),
           SpeechObservation(text: "go", source: TimeSpan(startUs: 20_100_000, endUs: 20_300_000))],
    right: [SpeechObservation(text: "Go", source: TimeSpan(startUs: 19_620_000, endUs: 19_820_000)),
            SpeechObservation(text: "go!", source: TimeSpan(startUs: 20_080_000, endUs: 20_280_000))],
    boundaryUs: ExactTime(20_000_000), shared: ExactRange(startUs: 18_000_000, endUs: 22_000_000))
check(repeated.pairs == [SpeechBoundaryPair(left: 0, right: 0, selected: .left),
                        SpeechBoundaryPair(left: 1, right: 1, selected: .right)],
    "Repeated lexical words retain distinct physically overlapping occurrences")
let boundary20 = ExactTime(20_000_000), shared20 = ExactRange(startUs: 18_000_000, endUs: 22_000_000)
for (left, right, unresolved) in [
    ([SpeechObservation(text: "word", source: TimeSpan(startUs: 19_900_000, endUs: 20_100_000))], [],
     [SpeechBoundaryObservation(.left, 0)]),
    ([SpeechObservation(text: "go", source: TimeSpan(startUs: 19_900_000, endUs: 20_100_000)),
      SpeechObservation(text: "go", source: TimeSpan(startUs: 19_950_000, endUs: 20_120_000))],
     [SpeechObservation(text: "go", source: TimeSpan(startUs: 19_980_000, endUs: 20_080_000))],
     [SpeechBoundaryObservation(.left, 0), SpeechBoundaryObservation(.left, 1), SpeechBoundaryObservation(.right, 0)]),
    ([SpeechObservation(text: "point", source: TimeSpan(startUs: 20_000_000, endUs: 20_000_000))],
     [SpeechObservation(text: "point", source: TimeSpan(startUs: 20_000_001, endUs: 20_000_001))],
     [SpeechBoundaryObservation(.left, 0), SpeechBoundaryObservation(.right, 0)]),
] {
    let result = try SpeechBoundaryMerge.resolve(left: left, right: right, boundaryUs: boundary20, shared: shared20)
    check(result.pairs.isEmpty && result.unresolved == unresolved,
        "Unmatched, ambiguous or shifted point evidence publishes unresolved, got \(result.pairs) \(result.unresolved)")
}
check(try [seam, ownerless, repeated].allSatisfy { $0.unresolved.isEmpty }, "Unique correspondences leave nothing unresolved")
print("PASS explicit ownership handles absent owners, repeats, ambiguity and exact points")

let shifted = try SpeechBoundaryMerge.resolve(
    left: [SpeechObservation(text: "we're", source: TimeSpan(startUs: 60_080_000, endUs: 60_240_000)),
           SpeechObservation(text: "going", source: TimeSpan(startUs: 60_240_000, endUs: 60_320_000)),
           SpeechObservation(text: "to", source: TimeSpan(startUs: 60_320_000, endUs: 60_400_000))],
    right: [SpeechObservation(text: "we're", source: TimeSpan(startUs: 60_000_000, endUs: 60_160_000)),
            SpeechObservation(text: "going", source: TimeSpan(startUs: 60_160_000, endUs: 60_240_000)),
            SpeechObservation(text: "to", source: TimeSpan(startUs: 60_240_000, endUs: 60_320_000))],
    boundaryUs: ExactTime(60_000_000), shared: ExactRange(startUs: 56_000_000, endUs: 64_000_000))
check(shifted.pairs == [SpeechBoundaryPair(left: 0, right: 0, selected: .right),
                       SpeechBoundaryPair(left: 1, right: 1, selected: .right),
                       SpeechBoundaryPair(left: 2, right: 2, selected: .right)],
    "Unique shared-context word order must retain the original shifted estimates")
print("PASS lexical anchors distinguish frame-shifted estimates without a timestamp epsilon")

// narration.mov's final window (receipt 02, probe 2): only the trailing "." token runs past physical
// end, by 18.7 ms of its 80 ms frame. The published word is timed by its speech, which ends inside
// the window, so nothing is clamped; raw evidence keeps the engine's token as reported.
let endWindows = try SpeechWindows.plan(available: [ExactRange(startUs: ExactTime(0), endUs: ExactTime(695_104_000, 3))],
    execution: SpeechExecution(executionRange: ExactRange(startUs: ExactTime(215_000_000), endUs: ExactTime(695_104_000, 3))))
check(endWindows.count == 1, "One final window, got \(endWindows.count)")
let endTokens = WordTimingMerger.mergeTokensIntoWords([
    timing(" li", 16.0, 16.08), timing("e", 16.08, 16.32), timing(" down", 16.32, 16.48), timing(".", 16.56, 16.72),
])
var endPublication = SourceTranscript.Publication(windows: endWindows, execution: SpeechExecution(
    executionRange: ExactRange(startUs: ExactTime(215_000_000), endUs: ExactTime(695_104_000, 3))))
check(try endPublication.add(SourceTranscript.WindowEvidence(words: endTokens.words, dropped: endTokens.dropped,
    in: endWindows[0].decoded), ordinal: 0) == nil, "The only window waits for the end")
let endLine = endPublication.finish()!
check(endLine.words.map(\.text) == ["lie", "down."] && endLine.words[1].source == TimeSpan(startUs: 231_320_000, endUs: 231_480_000),
    "The final word publishes its spoken extent, got \(endLine.words.map { ($0.text, $0.source) })")
check(endLine.issues.isEmpty, "Nothing published was clamped, got \(endLine.issues)")
print("PASS a trailing mark past the physical end publishes the final word unclamped")

// narration.mov's 120 s seam (probe, slice 03): the right window's decode starts hearing speech at
// "We", so the left window's "I mean," has no peer. Both still publish, from the left core.
func observed(_ text: String, _ startUs: Int64, _ endUs: Int64) -> SpeechObservation {
    SpeechObservation(text: text, source: TimeSpan(startUs: startUs, endUs: endUs))
}
let seam120 = try SpeechBoundaryMerge.resolve(
    left: [observed("it", 118_640_000, 118_720_000), observed("I", 119_120_000, 119_200_000),
           observed("mean,", 119_200_000, 119_280_000), observed("we", 119_360_000, 119_520_000),
           observed("could", 119_520_000, 119_600_000), observed("just", 119_600_000, 119_840_000),
           observed("go", 119_840_000, 120_080_000), observed("now.", 120_080_000, 120_400_000),
           observed("It's", 120_720_000, 121_040_000)],
    right: [observed("We", 119_280_000, 119_440_000), observed("could", 119_440_000, 119_520_000),
            observed("just", 119_520_000, 119_760_000), observed("go", 119_760_000, 120_000_000),
            observed("now.", 120_000_000, 120_320_000), observed("It's", 120_640_000, 121_040_000)],
    boundaryUs: ExactTime(120_000_000), shared: ExactRange(startUs: 116_000_000, endUs: 124_000_000))
check(seam120.unresolved == [SpeechBoundaryObservation(.left, 1), SpeechBoundaryObservation(.left, 2)],
    "The one-letter 'I' and its neighbour are unresolved, got \(seam120.unresolved)")
check(seam120.pairs == zip(3...8, 0...5).map { SpeechBoundaryPair(left: $0, right: $1, selected: $0 < 7 ? .left : .right) },
    "The agreeing run still pairs, got \(seam120.pairs)")
print("PASS a one-letter seam word without a peer is unresolved, not refused")

// The publication assembles both windows: unresolved words publish once from the core holding their
// start, an overrun at the decoded end is clamped, and a malformed word is dropped while its
// neighbours publish. Each becomes an issue on the line that carries it.
let seamWindows = try SpeechWindows.plan(available: [ExactRange(startUs: 100_000_000, endUs: 140_000_000)],
    execution: SpeechExecution())
var publication = SourceTranscript.Publication(windows: seamWindows, execution: SpeechExecution())
func evidence(_ tokens: [TokenTiming], _ window: Int) throws -> SourceTranscript.WindowEvidence {
    let merged = WordTimingMerger.mergeTokensIntoWords(tokens)
    return try SourceTranscript.WindowEvidence(words: merged.words, dropped: merged.dropped, in: seamWindows[window].decoded)
}
check(try publication.add(evidence([
    timing(" it", 18.64, 18.72), timing(" I", 19.12, 19.20), timing(" mean,", 19.20, 19.28),
    timing(" we", 19.36, 19.52), timing(" could", 19.52, 19.60), timing(" just", 19.60, 19.84),
    timing(" go", 19.84, 20.08), timing(" now.", 20.08, 20.40), timing(" It's", 20.72, 21.04),
], 0), ordinal: 0) == nil, "The first window waits for its right seam")
let leftLine = try publication.add(evidence([
    timing(" We", 3.28, 3.44), timing(" could", 3.44, 3.52), timing(" just", 3.52, 3.76),
    timing(" go", 3.76, 4.00), timing(" now.", 4.00, 4.32), timing(" It's", 4.64, 5.04),
    timing(" bad", .nan, 5.2), timing(" end", 23.90, 24.06),
], 1), ordinal: 1)!
let rightLine = publication.finish()!
check(leftLine.words.map(\.text) == ["it", "I", "mean,", "we", "could", "just", "go"],
    "Left publishes its unresolved words once, got \(leftLine.words.map(\.text))")
check(rightLine.words.map(\.text) == ["now.", "It's", "end"], "Right publishes its core, got \(rightLine.words.map(\.text))")
check(leftLine.issues.map { [$0.code, "\($0.word ?? -1)"] } == [["boundary-unresolved", "1"], ["boundary-unresolved", "2"]],
    "Each unresolved published word carries an issue, got \(leftLine.issues)")
check(rightLine.issues.map { [$0.code, "\($0.word ?? -1)"] } == [["timing-clamped", "2"], ["word-dropped", "-1"]],
    "The overrun is clamped and the malformed word dropped, got \(rightLine.issues)")
check(rightLine.words[2].source == TimeSpan(startUs: 139_900_000, endUs: 140_000_000), "The overrun ends at the decoded edge")
let issueEncoder = JSONEncoder()
issueEncoder.outputFormatting = [.sortedKeys]
issueEncoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
let wire = try rightLine.issues.map { String(decoding: try issueEncoder.encode($0), as: UTF8.self) }
check(wire == [
    #"{"code":"timing-clamped","evidence":{"decoded":{"endUs":140000000,"startUs":116000000},"endSeconds":24.06,"observation":6,"startSeconds":23.9,"window":1},"message":"The engine estimate [23.900, 24.060] s runs past its decoded window; it is clamped to the window edge.","word":2}"#,
    #"{"code":"word-dropped","evidence":{"confidence":1,"endSeconds":5.2,"startSeconds":"NaN","text":"bad","token":6,"window":1},"message":"Token 6 of 'bad' has a malformed engine estimate; the word is dropped and its neighbours publish.","range":{"endUs":140000000,"startUs":120000000}}"#,
], "Raw issues keep the wire shape core validates, got \(wire)")
print("PASS a publication flags unresolved, clamped and dropped words instead of refusing")

// Optional case-selected replay uses retained real engine words, with no inference or model access.
if [3, 5].contains(CommandLine.arguments.count) && CommandLine.arguments[1] == "--boundary-cases" {
    struct BoundaryCase: Decodable { let id: String; let left: String; let right: String; let boundaryUs: Int64; let shared: ExactRange; let leftOrdinal: Int?; let rightOrdinal: Int? }
    struct RawWords: Decodable {
        struct Word: Decodable { let text: String; let source: TimeSpan }
        let words: [Word]
        let observations: [Word]?
    }
    let cases = try JSONDecoder().decode([BoundaryCase].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    let selected = CommandLine.arguments.count == 5 ? CommandLine.arguments[4] : nil
    check(CommandLine.arguments.count != 5 || CommandLine.arguments[3] == "--case", "See --help for case selection")
    check(selected == nil || cases.contains { $0.id == selected }, "Unknown boundary case; see the JSON inventory")
    let directory = URL(fileURLWithPath: CommandLine.arguments[2]).deletingLastPathComponent()
    for item in cases where selected == nil || item.id == selected {
        func words(_ path: String, ordinal: Int?) throws -> [SpeechObservation] {
            let body = try Data(contentsOf: URL(fileURLWithPath: path, relativeTo: directory))
            let selected: Data
            if let ordinal {
                let lines = body.split(separator: 10)
                check(lines.indices.contains(ordinal), "Raw window ordinal is absent")
                selected = Data(lines[ordinal])
            } else { selected = body }
            let raw = try JSONDecoder().decode(RawWords.self, from: selected)
            return (raw.observations ?? raw.words).map {
                SpeechObservation(text: $0.text, source: $0.source)
            }
        }
        let result = try SpeechBoundaryMerge.resolve(left: words(item.left, ordinal: item.leftOrdinal), right: words(item.right, ordinal: item.rightOrdinal), boundaryUs: ExactTime(Int128(item.boundaryUs)), shared: item.shared)
        print("CASE \(item.id) \(String(decoding: try encoder.encode(result), as: UTF8.self))")
    }
}
