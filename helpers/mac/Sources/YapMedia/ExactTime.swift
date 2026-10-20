import Foundation
import CoreMedia

/// Exact microseconds for source and placement relationships. Arithmetic rejects excess precision rather than
/// rounding a source/placement relationship; final conversion to a decoder sample is explicit.
public struct ExactTime: Codable, Sendable, Equatable {
    package let numerator: Int128
    package let denominator: Int128

    public init(from decoder: Decoder) throws {
        let single = try decoder.singleValueContainer()
        let n: Int64
        let d: Int64
        if let value = try? single.decode(Int64.self) {
            n = value
            d = 1
        } else {
            let value = try single.decode(Fraction.self)
            n = value.numerator
            d = value.denominator
            let reduced = d > 0 ? ExactTime(Int128(n), Int128(d)) : nil
            guard d > 1, reduced?.numerator == Int128(n), reduced?.denominator == Int128(d) else {
                throw NativeFailure("INVALID_REQUEST", "Exact time must be canonical.")
            }
        }
        guard n >= -TimeSpan.maximumMicroseconds, n <= TimeSpan.maximumMicroseconds,
            d > 0, d <= TimeSpan.maximumMicroseconds
        else {
            throw NativeFailure("INVALID_REQUEST", "Invalid exact time.")
        }
        self.init(Int128(n), Int128(d))
    }
    private struct Fraction: Codable {
        let numerator: Int64
        let denominator: Int64
        init(numerator: Int64, denominator: Int64) {
            self.numerator = numerator
            self.denominator = denominator
        }
        init(from decoder: Decoder) throws {
            let keys = try decoder.container(keyedBy: WireKey.self)
            guard Set(keys.allKeys.map(\.stringValue)) == ["numerator", "denominator"] else {
                throw NativeFailure("INVALID_REQUEST", "Invalid exact fraction fields.")
            }
            numerator = try keys.decode(Int64.self, forKey: WireKey(stringValue: "numerator"))
            denominator = try keys.decode(Int64.self, forKey: WireKey(stringValue: "denominator"))
        }
        private struct WireKey: CodingKey {
            let stringValue: String
            let intValue: Int? = nil
            init(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }
    }
    public func encode(to encoder: Encoder) throws {
        guard numerator >= -Int128(TimeSpan.maximumMicroseconds),
            numerator <= Int128(TimeSpan.maximumMicroseconds),
            denominator > 0, denominator <= Int128(TimeSpan.maximumMicroseconds) else {
            throw NativeFailure("INVALID_REQUEST", "Exact time exceeds serializable precision.")
        }
        var container = encoder.singleValueContainer()
        if denominator == 1 {
            try container.encode(Int64(numerator))
        } else {
            try container.encode(
                Fraction(numerator: Int64(numerator), denominator: Int64(denominator)))
        }
    }
    package init(_ time: CMTime) throws {
        guard time.isNumeric, time.timescale > 0 else {
            throw NativeFailure.decodeFailed("Audio segment has invalid presentation time.")
        }
        self.init(Int128(time.value) * 1_000_000, Int128(time.timescale))
    }
    /// Preserve an observation API's binary floating-point seconds until its final label projection.
    package init(seconds: Double) throws {
        guard seconds.isFinite else {
            throw NativeFailure("INVALID_REQUEST", "Observed seconds must be finite.")
        }
        let bits = seconds.bitPattern
        let encodedExponent = Int((bits >> 52) & 0x7ff)
        let fraction = bits & 0x000f_ffff_ffff_ffff
        var top = UInt128(encodedExponent == 0 ? fraction : fraction | (1 << 52)) * 1_000_000
        guard top != 0 else { self.init(0); return }
        var exponent = (encodedExponent == 0 ? -1022 : encodedExponent - 1023) - 52
        if exponent < 0 {
            let canceled = min(top.trailingZeroBitCount, -exponent)
            top >>= canceled
            exponent += canceled
        }
        let bottom: UInt128
        if exponent >= 0 {
            guard exponent < 127, top <= UInt128(Int128.max) >> exponent else {
                throw NativeFailure("LIMIT_EXCEEDED", "Observed seconds exceed exact arithmetic capacity.")
            }
            top <<= exponent
            bottom = 1
        } else {
            guard -exponent < 127 else {
                throw NativeFailure("LIMIT_EXCEEDED", "Observed seconds exceed exact arithmetic capacity.")
            }
            bottom = UInt128(1) << -exponent
        }
        guard let numerator = Int128(exactly: top), let denominator = Int128(exactly: bottom) else {
            throw NativeFailure("LIMIT_EXCEEDED", "Observed seconds exceed exact arithmetic capacity.")
        }
        self.init(seconds.sign == .minus ? -numerator : numerator, denominator)
    }
    package init(_ numerator: Int128, _ denominator: Int128 = 1) {
        var a = numerator.magnitude
        var b = denominator.magnitude
        while b != 0 { (a, b) = (b, a % b) }
        let divisor = Int128(a)
        self.numerator = numerator / divisor
        self.denominator = denominator / divisor
    }
    package func subtract(_ other: ExactTime) throws -> ExactTime {
        let left = numerator.multipliedReportingOverflow(by: other.denominator)
        let right = other.numerator.multipliedReportingOverflow(by: denominator)
        let bottom = denominator.multipliedReportingOverflow(by: other.denominator)
        let top = left.partialValue.subtractingReportingOverflow(right.partialValue)
        guard !left.overflow, !right.overflow, !bottom.overflow, !top.overflow else {
            throw NativeFailure("NOT_READY", "Audio time exceeds native exact arithmetic capacity.")
        }
        return ExactTime(top.partialValue, bottom.partialValue)
    }
    package func adding(_ other: ExactTime) throws -> ExactTime {
        let left = numerator.multipliedReportingOverflow(by: other.denominator)
        let right = other.numerator.multipliedReportingOverflow(by: denominator)
        let bottom = denominator.multipliedReportingOverflow(by: other.denominator)
        let top = left.partialValue.addingReportingOverflow(right.partialValue)
        guard !left.overflow, !right.overflow, !bottom.overflow, !top.overflow else {
            throw NativeFailure("NOT_READY", "Time exceeds native exact arithmetic capacity.")
        }
        return ExactTime(top.partialValue, bottom.partialValue)
    }
    package func sample(_ rate: Int, ceil: Bool = false, nearest: Bool = false) throws -> Int64 {
        let top = numerator.multipliedReportingOverflow(by: Int128(rate))
        let bottom = denominator.multipliedReportingOverflow(by: 1_000_000)
        guard !top.overflow, !bottom.overflow else {
            throw NativeFailure(
                "NOT_READY", "Audio time exceeds native sample arithmetic capacity.")
        }
        let quotient = top.partialValue / bottom.partialValue
        let floor =
            quotient - (top.partialValue < 0 && top.partialValue % bottom.partialValue != 0 ? 1 : 0)
        let residue = top.partialValue - floor * bottom.partialValue
        let half = bottom.partialValue / 2
        let roundsUp =
            top.partialValue < 0
            ? residue > half : residue >= half + bottom.partialValue % 2
        let rounded = floor + ((nearest ? roundsUp : ceil && residue != 0) ? 1 : 0)
        guard let value = Int64(exactly: rounded) else {
            throw NativeFailure("INVALID_REQUEST", "Audio sample exceeds native bounds.")
        }
        return value
    }
    package func equals(_ other: ExactTime) -> Bool {
        numerator == other.numerator && denominator == other.denominator
    }
    package func compare(_ other: ExactTime) throws -> ComparisonResult {
        let left = numerator.multipliedReportingOverflow(by: other.denominator)
        let right = other.numerator.multipliedReportingOverflow(by: denominator)
        guard !left.overflow, !right.overflow else {
            throw NativeFailure("NOT_READY", "Time exceeds native exact comparison capacity.")
        }
        if left.partialValue < right.partialValue { return .orderedAscending }
        if left.partialValue > right.partialValue { return .orderedDescending }
        return .orderedSame
    }
}
