import AppKit
import CoreGraphics
import CoreText

/// How the ink a person draws during a take looks, wherever it is drawn: live over their displays,
/// and over review frames of the recording, so an agent sees the marks the way the person did.
///
/// Sizes are in screen points. A caller drawing in another space passes how many of its units one
/// point covers. Points are in the context's own space, with y growing upward.
public enum Ink {
    public static let color = CGColor(srgbRed: 1, green: 0x3b / 255, blue: 0x30 / 255, alpha: 1)
    public static let lineWidth: CGFloat = 5
    public static let pinRadius: CGFloat = 16

    /// How strongly a mark shows at `atUs` while it fades from `fadeFromUs` to `untilUs`: full
    /// strength before the fade, readable for a moment, then faster as it ends; nil once it is gone.
    public static func opacity(atUs: Int64, fadeFromUs: Int64, untilUs: Int64) -> Double? {
        guard atUs < untilUs else { return nil }
        guard atUs > fadeFromUs, untilUs > fadeFromUs else { return 1 }
        let progress = Double(atUs - fadeFromUs) / Double(untilUs - fadeFromUs)
        return 1 - progress * progress
    }

    public static func drawStroke(
        _ points: [CGPoint], opacity: CGFloat, in context: CGContext, scale: CGFloat = 1
    ) {
        guard let first = points.first, opacity > 0 else { return }
        context.saveGState()
        defer { context.restoreGState() }
        let path = CGMutablePath()
        path.move(to: first)
        path.addLines(between: points)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        // A white edge under the ink separates it from red or busy content beneath, and a soft
        // shadow carries that edge onto light backgrounds where white alone disappears.
        context.saveGState()
        setEdgeShadow(context, scale: scale)
        context.setLineWidth((lineWidth + 3) * scale)
        context.setStrokeColor(CGColor(gray: 1, alpha: 0.85 * opacity))
        context.addPath(path)
        context.strokePath()
        context.restoreGState()
        context.setLineWidth(lineWidth * scale)
        context.setStrokeColor(color.copy(alpha: opacity) ?? color)
        context.addPath(path)
        context.strokePath()
    }

    public static func drawPin(
        _ number: Int, at center: CGPoint, opacity: CGFloat, in context: CGContext, scale: CGFloat = 1
    ) {
        guard opacity > 0 else { return }
        // The badge fades as one picture, so its number never shows through a faded fill.
        context.saveGState()
        context.setAlpha(opacity)
        context.beginTransparencyLayer(auxiliaryInfo: nil)
        defer {
            context.endTransparencyLayer()
            context.restoreGState()
        }
        let r = pinRadius * scale
        let badge = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
        // The same white edge and shadow as the strokes, so a badge keeps its outline on red,
        // busy or light content alike.
        context.saveGState()
        setEdgeShadow(context, scale: scale)
        context.setFillColor(color)
        context.fillEllipse(in: badge)
        context.restoreGState()
        context.setStrokeColor(CGColor(gray: 1, alpha: 1))
        context.setLineWidth(2 * scale)
        context.strokeEllipse(in: badge)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 17 * scale, weight: .heavy) as CTFont
        let line = CTLineCreateWithAttributedString(
            NSAttributedString(
                string: String(number),
                attributes: [.font: font, .foregroundColor: CGColor(gray: 1, alpha: 1)]))
        var ascent: CGFloat = 0
        var descent: CGFloat = 0
        let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
        context.textPosition = CGPoint(
            x: center.x - width / 2, y: center.y - (ascent + descent) / 2 + descent)
        CTLineDraw(line, context)
    }

    /// The shadow's blur is in device pixels, outside the context's scaling, so it is sized from
    /// both: the same soft edge on a Retina display and in a frame of its recording.
    private static func setEdgeShadow(_ context: CGContext, scale: CGFloat) {
        let device = context.userSpaceToDeviceSpaceTransform
        let deviceScale = (device.a * device.a + device.b * device.b).squareRoot()
        context.setShadow(
            offset: .zero, blur: 3 * scale * deviceScale, color: CGColor(gray: 0, alpha: 0.35))
    }
}
