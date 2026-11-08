import CoreMedia
import Foundation

public struct PauseEvent: Codable, Sendable, Equatable {
    public let atSourceUs: Int64
    public let elapsedPauseUs: Int64
}

public struct CaptureClock: Sendable {
    public private(set) var originUs: Int64?
    public private(set) var pauses: [PauseEvent] = []
    private var intervals: [(start: Int64, end: Int64)] = []
    private var pausedAt: Int64?
    private var sealedAt: Int64?
    private var pcmPhases: [String: PCMPhase] = [:]

    private struct PCMPhase: Sendable {
        let anchorUs: Int64
        let rate: Int32
        let hostPTS: CMTime
        let firstFrame: Int64
        let endFrame: Int64
        let removedUs: Int64
    }

    package struct PCMPlacement: Codable, Sendable {
        package let anchorUs: Int64
        package let firstFrame: Int64
        package let frames: Int64
        package let rate: Int32
        package let joinsPrevious: Bool
        package let removedPauseUs: Int64
    }

    public init() {}
    public var isPaused: Bool { pausedAt != nil }
    /// Source zero belongs to a usable frame whose host-time interval excludes pauses;
    /// delivering a paused frame after resume does not make that timestamp eligible.
    @discardableResult
    public mutating func start(at hostUs: Int64, durationUs: Int64 = 0) -> Bool {
        guard originUs == nil, accepts(hostUs: hostUs, durationUs: durationUs) else { return false }
        originUs = hostUs
        pauses = pauseProjection(originUs: hostUs).compactMap(\.pause)
        return true
    }
    package struct ProjectedPause: Sendable {
        package let startHostUs: Int64
        package let endHostUs: Int64
        package let pause: PauseEvent?
    }

    /// A source reads the take's controls through its fixed origin; it never owns pause/resume.
    package func projected(originUs: Int64) -> CaptureClock {
        var projected = self
        projected.originUs = originUs
        projected.pauses = pauseProjection(originUs: originUs).compactMap(\.pause)
        return projected
    }
    package var openPauseHostUs: Int64? { pausedAt }

    package func pauseProjection(originUs: Int64) -> [ProjectedPause] {
        var removedUs: Int64 = 0
        return intervals.map { interval in
            let pause = interval.start >= originUs
                ? PauseEvent(atSourceUs: interval.start - originUs - removedUs,
                    elapsedPauseUs: interval.end - interval.start) : nil
            removedUs += max(0, interval.end - max(interval.start, originUs))
            return ProjectedPause(startHostUs: interval.start, endHostUs: interval.end, pause: pause)
        }
    }

    public mutating func seal(at hostUs: Int64) { if sealedAt == nil { sealedAt = hostUs } }
    public mutating func pause(at hostUs: Int64) { if pausedAt == nil { pausedAt = hostUs } }
    public mutating func resume(at hostUs: Int64) {
        guard let start = pausedAt, hostUs >= start else { return }
        pausedAt = nil
        if let boundary = sourceTime(for: start) {
            pauses.append(PauseEvent(atSourceUs: boundary, elapsedPauseUs: hostUs - start))
        }
        intervals.append((start, hostUs))
    }
    /// Where the open pause began in source time: the last moment a paused take holds.
    package var openPauseSourceUs: Int64? {
        guard let pausedAt, let originUs, pausedAt >= originUs else { return nil }
        return pausedAt - originUs - removedBefore(pausedAt, originUs: originUs)
    }
    public func sourceTime(for hostUs: Int64, durationUs: Int64 = 0) -> Int64? {
        guard let originUs, hostUs >= originUs, accepts(hostUs: hostUs, durationUs: durationUs)
        else { return nil }
        return hostUs - originUs - removedBefore(hostUs, originUs: originUs)
    }

    /// Prospective admission; the writer commits its copied clock only after media acceptance.
    /// The caller supplies accepted buffers only; rejected appends must never advance this phase.
    package mutating func recordAcceptedPCM(
        role: String, hostPTS: CMTime, frames: Int64, rate: Int32
    )
        throws -> PCMPlacement?
    {
        guard ["narration", "system"].contains(role), hostPTS.isNumeric, hostPTS.timescale > 0,
            hostPTS.epoch == 0,
            frames > 0, frames <= Int64(Int32.max), (1...192_000).contains(rate)
        else { throw CaptureFailure("INVALID_AUDIO_TIMING", "Invalid PCM timing candidate.") }
        // Int64 raw values, Int32 scales/rates and these products fit Int128. Round only at named boundaries.
        func nearest(_ numerator: Int128, _ denominator: Int128) throws -> Int64 {
            let magnitude = numerator.magnitude
            let rounded = (magnitude + UInt128(denominator) / 2) / UInt128(denominator)
            let signed = numerator < 0 ? -Int128(rounded) : Int128(rounded)
            guard let value = Int64(exactly: signed) else {
                throw CaptureFailure("INVALID_AUDIO_TIMING", "PCM position exceeds capture bounds.")
            }
            return value
        }
        let scale = Int128(hostPTS.timescale)
        let hostUs = try nearest(Int128(hostPTS.value) * 1_000_000, scale)
        let durationUs = try nearest(Int128(frames) * 1_000_000, Int128(rate))
        guard hostUs <= Int64.max - durationUs else {
            throw CaptureFailure("INVALID_AUDIO_TIMING", "PCM interval exceeds capture bounds.")
        }
        guard sourceTime(for: hostUs, durationUs: durationUs) != nil, let originUs else {
            return nil
        }
        let removedUs = removedBefore(hostUs, originUs: originUs)
        let relative =
            Int128(hostPTS.value) * 1_000_000 - (Int128(originUs) + Int128(removedUs)) * scale
        let prior = pcmPhases[role]
        if let prior, prior.rate != rate {
            throw CaptureFailure(
                "AUDIO_FORMAT_CHANGED", "PCM rate changed within the declared phase.")
        }
        let anchor = try prior?.anchorUs ?? nearest(relative, scale)
        var first: Int64
        if let prior {
            // Compare adjacent callbacks, not each callback against a fixed host-clock
            // phase. Sub-frame clock residue must not accumulate into invented gaps.
            let denominator = scale * Int128(prior.hostPTS.timescale)
            let elapsed = (Int128(hostPTS.value) * Int128(prior.hostPTS.timescale)
                - Int128(prior.hostPTS.value) * scale) * Int128(rate)
            let removed = (Int128(removedUs) - Int128(prior.removedUs)) * Int128(rate)
            // Subtract rational frame distances via quotient/remainder so cross-products
            // stay within Int128 even at the platform's timestamp bounds.
            var whole = elapsed / denominator - removed / 1_000_000
            let fractionalDenominator = denominator * 1_000_000
            var remainder = elapsed % denominator * 1_000_000
                - removed % 1_000_000 * denominator
            if whole > 0 && remainder < 0 { whole -= 1; remainder += fractionalDenominator }
            if whole < 0 && remainder > 0 { whole += 1; remainder -= fractionalDenominator }
            let distance = whole + Int128(try nearest(remainder, fractionalDenominator))
            guard let position = Int64(exactly: Int128(prior.firstFrame) + distance) else {
                throw CaptureFailure("INVALID_AUDIO_TIMING", "PCM position exceeds capture bounds.")
            }
            first = position
            // The session clock can move by a fraction of one PCM frame between adjacent
            // callbacks. Preserve a continuous sample grid across that residue; a full-frame
            // overlap remains invalid and is still rejected below.
            let frameCount = Int128(prior.endFrame - prior.firstFrame)
            let overlapBoundary = (frameCount - 1) * fractionalDenominator
            let rawDistance = elapsed * 1_000_000 - removed * denominator
            if distance < frameCount, rawDistance > overlapBoundary {
                first = prior.endFrame
            }
        } else {
            first = try nearest(
                (relative - Int128(anchor) * scale) * Int128(rate), scale * 1_000_000)
        }
        guard first >= 0, prior.map({ first >= $0.endFrame }) ?? true else {
            throw CaptureFailure("AUDIO_OVERLAP", "PCM classification overlaps admitted samples.")
        }
        let end = first.addingReportingOverflow(frames)
        guard !end.overflow else {
            throw CaptureFailure("INVALID_AUDIO_TIMING", "PCM frame count overflow.")
        }
        let container = try PCMContainerTime(phaseUs: anchor, rate: rate)
        _ = try container.time(at: first)
        _ = try container.time(at: end.partialValue)
        let placement = PCMPlacement(
            anchorUs: anchor, firstFrame: first, frames: frames, rate: rate,
            joinsPrevious: prior.map { first == $0.endFrame && removedUs == $0.removedUs } ?? false,
            removedPauseUs: removedUs)
        pcmPhases[role] = PCMPhase(
            anchorUs: anchor, rate: rate, hostPTS: hostPTS, firstFrame: first,
            endFrame: end.partialValue, removedUs: removedUs)
        return placement
    }

    /// The same interval rule gates origin and media placement, including delayed deliveries
    /// whose host timestamps fall inside a pause that has already ended.
    private func accepts(hostUs: Int64, durationUs: Int64) -> Bool {
        let endUs = hostUs + max(0, durationUs)
        if let pausedAt, hostUs >= pausedAt || endUs > pausedAt { return false }
        for interval in intervals {
            if hostUs < interval.end && endUs > interval.start { return false }
            if hostUs >= interval.start && hostUs < interval.end { return false }
        }
        return true
    }

    /// How much source time this take holds right now: the same playback coordinate its media is
    /// written in, with paused time already removed. It stops advancing while the take is paused,
    /// because paused wall time is not recording time. Whoever displays elapsed time reads this
    /// rather than deriving a second clock of its own.
    public func elapsedSourceUs(at hostUs: Int64) -> Int64? {
        guard let originUs else { return nil }
        let at = min(pausedAt ?? hostUs, sealedAt ?? hostUs, hostUs)
        guard at > originUs else { return 0 }
        return at - originUs - removedBefore(at, originUs: originUs)
    }

    /// Paused time this take has already resumed from, before the given host instant.
    private func removedBefore(_ hostUs: Int64, originUs: Int64) -> Int64 {
        var removed: Int64 = 0
        for interval in intervals where interval.end <= hostUs {
            removed += max(0, interval.end - max(originUs, interval.start))
        }
        return removed
    }
}
