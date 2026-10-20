import Foundation
import YapMedia

/// One pointer position the core chose, in oriented source-video pixels with a top-left origin.
/// `atSourceUs` is the sample's own time, never the requested frame time.
public struct CursorPoint: Codable, Sendable, Equatable {
    public let atSourceUs: Int64
    public let x: Double
    public let y: Double
    public init(atSourceUs: Int64, x: Double, y: Double) {
        self.atSourceUs = atSourceUs
        self.x = x
        self.y = y
    }

    /// Whether the point addresses a pixel of a `width` by `height` raster. Output pixels are
    /// half-open, as the capture journals them: a coordinate equal to the width is past the edge.
    func isOnRaster(width: Int, height: Int) -> Bool {
        x.isFinite && y.isFinite && x >= 0 && y >= 0 && x < Double(width) && y < Double(height)
    }
}

/// What to draw over a decoded frame. The core selects every point and has already clipped the
/// trail at pause, cut, scene and geometry boundaries; this library draws exactly what it is given.
///
/// `trail` holds continuously observed runs in ascending time. A gap between two runs is a gap in
/// the evidence — an invisible or missing pointer — and nothing is drawn across it. An absent
/// overlay leaves the frame clean; an overlay with an empty trail and no pointer is an honest
/// statement that there was nothing to draw.
public struct FrameOverlay: Codable, Sendable, Equatable {
    public let trail: [[CursorPoint]]
    /// Age at which a trail point reaches its faintest opacity. The requested trail duration, not
    /// the span the retained points happen to cover, so a trail cut short stays visibly short.
    public let trailUs: Int64
    /// The pointer for the requested moment, drawn opaque above the trail.
    public let pointer: CursorPoint?

    public init(trail: [[CursorPoint]] = [], trailUs: Int64 = 0, pointer: CursorPoint? = nil) {
        self.trail = trail
        self.trailUs = trailUs
        self.pointer = pointer
    }
}

public enum FrameLimits {
    public static let defaultLongEdge = 1600
    public static let maximumLongEdge = 8192
    public static let maximumEncodedBytes = 32 * 1024 * 1024
    /// Mirrors the per-request trail cap the public contract fixes at ten seconds.
    public static let maximumTrailUs: Int64 = 10_000_000

}

extension FrameOverlay {
    /// Bounds the drawing work and refuses evidence this library would have to guess about: points
    /// off the source raster, points out of order, and runs that overlap in time.
    func validate(width: Int, height: Int) throws {
        let overlay = self
        guard overlay.trailUs >= 0, overlay.trailUs <= FrameLimits.maximumTrailUs else {
            throw NativeFailure(
                "INVALID_RANGE",
                "Trail duration \(overlay.trailUs) is outside 0...\(FrameLimits.maximumTrailUs) microseconds."
            )
        }
        var total = 0
        var previousUs: Int64?
        for run in overlay.trail {
            guard !run.isEmpty else {
                throw NativeFailure("INVALID_RANGE", "A trail run holds no points.")
            }
            total += run.count
            for point in run {
                try validate(point: point, width: width, height: height)
                if let previousUs, point.atSourceUs <= previousUs {
                    throw NativeFailure(
                        "INVALID_RANGE",
                        "Trail point at \(point.atSourceUs) does not follow \(previousUs) microseconds."
                    )
                }
                previousUs = point.atSourceUs
            }
        }
        guard total == 0 || overlay.trailUs > 0 else {
            throw NativeFailure(
                "INVALID_RANGE", "A trail of \(total) points needs a trail duration.")
        }
        if let pointer = overlay.pointer {
            try validate(point: pointer, width: width, height: height)
        }
    }

    private func validate(point: CursorPoint, width: Int, height: Int) throws {
        guard point.atSourceUs >= 0, point.atSourceUs <= TimeSpan.maximumMicroseconds,
            point.isOnRaster(width: width, height: height)
        else {
            throw NativeFailure(
                "INVALID_RANGE",
                "Cursor point \(point.x),\(point.y) at \(point.atSourceUs)us is not inside the \(width)x\(height) source image."
            )
        }
    }
}
