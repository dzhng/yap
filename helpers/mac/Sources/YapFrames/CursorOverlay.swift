import CoreGraphics
import Foundation
import YapInk
import YapMedia

/// Rasterizes the supplied ink, pointer and trail into a transparent image the size of the oriented
/// source frame, so the caller can composite it before cropping and scaling.
///
/// Every coordinate and time comes from the core. Nothing here selects history, decides a cutoff,
/// interpolates a missing sample or joins one run of points to the next.
enum CursorOverlay {
    /// Pointer height as a share of the source long edge. A real macOS pointer covers about this
    /// much of a Retina display, and sizing against the source keeps both marks proportional after
    /// the frame is bounded to its requested long edge.
    private static let pointerShare = 0.012
    private static let trailShare = 0.0025
    /// Floors, in the pixels the caller is delivered rather than in source pixels. A share of a large
    /// source is plenty on its own; these carry the marks on a small output, where the same share is
    /// a fraction of a pixel. They are the smallest sizes at which a magenta core still survives the
    /// downscale inside its own outline instead of being averaged into one washed-out hairline.
    private static let deliveredPointerFloor = 16.0
    private static let deliveredCoreFloor = 2.0
    private static let deliveredHaloFloor = 2.0
    /// How much of the delivered long edge the pointer floor is allowed to claim. The floor grows as
    /// the frame shrinks, and on a thumbnail a glyph large enough to read is a lid over the thing it
    /// points at; past this share the mark gives way to the content instead.
    private static let deliveredPointerCeiling = 0.2
    /// Magenta: neither the recorded surfaces nor the fixture's own markers use it, so the trail
    /// reads as an annotation rather than as content.
    private static let trailColor = CGColor(red: 1, green: 0.22, blue: 0.70, alpha: 1)
    private static let newestAlpha = 0.95
    private static let oldestAlpha = 0.15
    /// Segments are stroked in age bands rather than one at a time: overlapping round caps on every
    /// 60 Hz segment would bead the trail with darker joints.
    private static let bands = 12

    /// One run of points sharing an age band, drawn as a single polyline.
    private struct Stroke {
        let alpha: Double
        let points: [CGPoint]
    }

    /// `deliveredScale` is how much the frame will shrink after this raster is composited: 1 when it
    /// is delivered at source size, 0.5 when its long edge is halved. Widths are chosen in delivered
    /// pixels and divided back out, so a mark holds the same apparent weight at every output size.
    static func image(
        _ overlay: FrameOverlay, agedFromUs: Int64, width: Int, height: Int, visibleLongEdge: Double,
        deliveredScale: Double
    ) throws -> CGImage? {
        guard width > 0, height > 0 else {
            throw NativeFailure.decodeFailed("Overlay raster has no pixels.")
        }
        guard deliveredScale > 0 else {
            throw NativeFailure.decodeFailed(
                "Overlay raster has no scale to size its marks against.")
        }
        guard overlay.pointer != nil || overlay.trail.contains(where: { !$0.isEmpty })
            || overlay.ink?.marks.isEmpty == false
        else { return nil }
        guard
            let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else {
            throw NativeFailure.decodeFailed("Cannot allocate the cursor overlay raster.")
        }
        if let ink = overlay.ink { drawInk(ink, in: context, agedFromUs: agedFromUs, height: height) }
        // Overlay points are stated in top-left source pixels; Core Graphics grows y upward.
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        let longEdge = Double(max(width, height))
        /// Source pixels for a width stated in delivered pixels.
        func sourcePixels(_ delivered: Double) -> Double { (delivered / deliveredScale).rounded() }
        let core = max(sourcePixels(deliveredCoreFloor), (longEdge * trailShare).rounded())
        let strokes = strokes(for: overlay, agedFromUs: agedFromUs)
        // The whole trail is haloed before any of it is coloured, so one run crossing another is
        // never buried under the second run's dark outline. That outline is what keeps a thin
        // stroke legible over a light button and over dark text alike.
        draw(
            strokes, in: context,
            width: core + max(sourcePixels(deliveredHaloFloor), (core * 0.8).rounded()),
            color: CGColor(red: 0, green: 0, blue: 0, alpha: 1), alphaShare: 0.6)
        draw(strokes, in: context, width: core, color: trailColor, alphaShare: 1)
        if let pointer = overlay.pointer {
            // A share of the visible long edge in source pixels is that same share of the delivered
            // long edge once the bound has been applied. Only the floor is capped: a tight crop is a
            // zoom, where a glyph sized against the source it was measured in is already right.
            let pointerFloor = min(
                sourcePixels(deliveredPointerFloor), visibleLongEdge * deliveredPointerCeiling)
            drawPointer(
                context, at: CGPoint(x: pointer.x, y: pointer.y),
                size: max(pointerFloor, (longEdge * pointerShare).rounded()))
        }
        guard let image = context.makeImage() else {
            throw NativeFailure.decodeFailed("Cannot produce the cursor overlay image.")
        }
        return image
    }

    /// The person's marks as they saw them, under everything else: ink sits on their screen, below
    /// the pointer. Drawn before the flip, since a pin's number is text and must stay upright.
    private static func drawInk(_ ink: FrameInk, in context: CGContext, agedFromUs: Int64, height: Int) {
        let scale = CGFloat(ink.scale)
        func upright(_ point: FrameMark.Point) -> CGPoint { CGPoint(x: point.x, y: Double(height) - point.y) }
        for mark in ink.marks {
            let shown = mark.fade.map { Ink.opacity(atUs: agedFromUs, fadeFromUs: $0.fromUs, untilUs: $0.untilUs) } ?? 1
            guard let opacity = shown.map({ CGFloat($0) }) else { continue }
            if let number = mark.pin, let point = mark.runs.first?.first {
                Ink.drawPin(number, at: upright(point), opacity: opacity, in: context, scale: scale)
            } else {
                for run in mark.runs {
                    Ink.drawStroke(run.map(upright), opacity: opacity, in: context, scale: scale)
                }
            }
        }
    }

    private static func strokes(for overlay: FrameOverlay, agedFromUs: Int64) -> [Stroke] {
        var strokes: [Stroke] = []
        for run in overlay.trail {
            let aged = run.map {
                (
                    point: CGPoint(x: $0.x, y: $0.y),
                    band: band(of: $0, agedFromUs: agedFromUs, trailUs: overlay.trailUs)
                )
            }
            guard let first = aged.first else { continue }
            guard aged.count > 1 else {
                strokes.append(Stroke(alpha: alpha(inBand: first.band), points: [first.point]))
                continue
            }
            var open: (band: Int, points: [CGPoint])?
            for (previous, next) in zip(aged, aged.dropFirst()) {
                let band = (previous.band + next.band + 1) / 2
                if open?.band != band {
                    if let closing = open {
                        strokes.append(
                            Stroke(alpha: alpha(inBand: closing.band), points: closing.points))
                    }
                    // A new band reopens at the point the previous one ended on, so consecutive
                    // bands meet instead of leaving a hole in the path.
                    open = (band, [previous.point])
                }
                open?.points.append(next.point)
            }
            if let closing = open {
                strokes.append(Stroke(alpha: alpha(inBand: closing.band), points: closing.points))
            }
        }
        return strokes
    }

    private static func draw(
        _ strokes: [Stroke], in context: CGContext, width: Double, color: CGColor, alphaShare: Double
    ) {
        for stroke in strokes {
            let faded = color.copy(alpha: stroke.alpha * alphaShare) ?? color
            guard stroke.points.count > 1 else {
                // A run of one point is a real observation with nothing to connect it to.
                context.setFillColor(faded)
                context.fillEllipse(
                    in: CGRect(
                        x: stroke.points[0].x - width / 2, y: stroke.points[0].y - width / 2,
                        width: width, height: width))
                continue
            }
            context.setStrokeColor(faded)
            context.setLineWidth(width)
            context.beginPath()
            context.addLines(between: stroke.points)
            context.strokePath()
        }
    }

    /// A point's age band, oldest last. Points at or after the requested frame time are newest: the
    /// pointer sample nearest that time can legitimately sit just after it.
    private static func band(of point: CursorPoint, agedFromUs: Int64, trailUs: Int64) -> Int {
        guard trailUs > 0 else { return 0 }
        let age = max(0, agedFromUs - point.atSourceUs)
        return min(bands - 1, Int(Double(age) / Double(trailUs) * Double(bands)))
    }

    private static func alpha(inBand band: Int) -> Double {
        newestAlpha - (newestAlpha - oldestAlpha) * ((Double(band) + 0.5) / Double(bands))
    }

    /// An arrow whose tip is the hot spot and whose body extends down and to the right. The shape
    /// is deliberately asymmetric: a mirrored or transposed render is visible rather than plausible.
    private static func drawPointer(_ context: CGContext, at hotSpot: CGPoint, size: Double) {
        let outline = [
            (0.0, 0.0), (0.0, 0.75), (0.19, 0.58), (0.31, 0.88), (0.45, 0.82), (0.33, 0.53),
            (0.56, 0.52),
        ].map { CGPoint(x: hotSpot.x + $0.0 * size, y: hotSpot.y + $0.1 * size) }
        context.beginPath()
        context.addLines(between: outline)
        context.closePath()
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        context.setLineWidth(max(1, size * 0.08))
        context.drawPath(using: .fillStroke)
    }
}
