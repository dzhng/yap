import CoreGraphics
import CoreImage
import CoreText
import Foundation
import YapMedia

struct TextSource: Codable, Hashable {
    struct Font: Codable, Hashable { let assetId: String; let postScriptName: String }
    let kind: String
    let text: String
    let font: Font
    let width: Int
    let height: Int
    let size: Double
    let color: String
    let alignment: String
    let verticalAlignment: String?
    struct Stroke: Codable, Hashable { let color: String; let width: Double }
    struct Shadow: Codable, Hashable { let color: String; let offsetX: Double; let offsetY: Double; let blur: Double }
    struct Background: Codable, Hashable { let color: String; let padding: Double; let cornerRadius: Double }
    struct Highlight: Codable, Hashable { let activeColor: String; let inactiveColor: String }
    let stroke: Stroke?
    let shadow: Shadow?
    let background: Background?
    let highlight: Highlight?
    let activeRanges: [[Int]]?
    let wrap: Bool

    // Swift String equality normalizes Unicode; receipts retain exact UTF-16 literals.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.kind == rhs.kind && lhs.text.utf16.elementsEqual(rhs.text.utf16)
            && lhs.font == rhs.font && lhs.width == rhs.width && lhs.height == rhs.height
            && lhs.size == rhs.size && lhs.color == rhs.color
            && lhs.alignment == rhs.alignment && lhs.verticalAlignment == rhs.verticalAlignment
            && lhs.stroke == rhs.stroke && lhs.shadow == rhs.shadow && lhs.background == rhs.background
            && lhs.highlight == rhs.highlight && lhs.activeRanges == rhs.activeRanges
            && lhs.wrap == rhs.wrap
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(kind)
        hasher.combine(Array(text.utf16))
        hasher.combine(font)
        hasher.combine(width)
        hasher.combine(height)
        hasher.combine(size)
        hasher.combine(color)
        hasher.combine(alignment)
        hasher.combine(verticalAlignment)
        hasher.combine(stroke)
        hasher.combine(shadow)
        hasher.combine(background)
        hasher.combine(highlight)
        hasher.combine(activeRanges)
        hasher.combine(wrap)
    }
}

struct TextLayout: Encodable {
    struct Line: Encodable {
        let range: [Int]
        let text: String
        var origin: [Double]
        let width: Double
        let fonts: [String]
    }
    let font: TextSource.Font
    let text: String
    let visibleRange: [Int]
    let lines: [Line]
    let inkBounds: [Double]
    let visibleBounds: [Double]
    let decorationBounds: [Double]
    let verticalOffset: Double
    let stroke: TextSource.Stroke?
    let shadow: TextSource.Shadow?
    let background: TextSource.Background?
    let highlight: TextSource.Highlight?
    let activeRanges: [[Int]]?
}

/// One face CoreText drew with other than the pinned one, or one that lacked glyphs. `substituted`
/// lists the code points another installed face drew in place of the pinned face; `missing` those
/// drawn as a placeholder box (this face's glyph 0, or CoreText's last resort face). Both keep first-occurrence order without repeats. Core turns these facts into
/// `font-substituted` and `glyph-missing` issues (`packages/core/src/text-fallback.ts`).
struct TextFallback: Encodable, Equatable {
    let face: String
    private(set) var substituted: [UInt32]
    private(set) var missing: [UInt32]

    init(face: String, substituted: [UInt32], missing: [UInt32]) {
        self.face = face
        self.substituted = []
        self.missing = []
        add(substituted: substituted, missing: missing)
    }

    mutating func add(substituted: [UInt32], missing: [UInt32]) {
        for value in substituted where !self.substituted.contains(value) { self.substituted.append(value) }
        for value in missing where !self.missing.contains(value) { self.missing.append(value) }
    }
}

struct TextRaster {
    let image: CIImage
    let layout: TextLayout
    let pixels: Int64
    let fallbacks: [TextFallback]

    init(_ request: TextSource, binding: FontAssetBinding) throws {
        func validColor(_ value: String) -> Bool {
            value.count == 9 && value.first == "#" && UInt32(value.dropFirst(), radix: 16) != nil
        }
        guard request.kind == "text", request.width > 0, request.width <= 4096,
            request.height > 0, request.height <= 4096,
            request.size.isFinite, request.size > 0, request.size <= 512,
            request.text.utf16.count <= 8192, request.color.count == 9, request.color.first == "#",
            validColor(request.color),
            request.stroke.map({ validColor($0.color) && $0.width.isFinite && $0.width >= 0 && $0.width <= 64 }) ?? true,
            request.shadow.map({ validColor($0.color) && $0.offsetX.isFinite && $0.offsetX >= -256 && $0.offsetX <= 256 && $0.offsetY.isFinite && $0.offsetY >= -256 && $0.offsetY <= 256 && $0.blur.isFinite && $0.blur >= 0 && $0.blur <= 128 }) ?? true,
            request.background.map({ validColor($0.color) && $0.padding.isFinite && $0.padding >= 0 && $0.padding <= 256 && $0.cornerRadius.isFinite && $0.cornerRadius >= 0 && $0.cornerRadius <= 256 }) ?? true,
            request.highlight.map({ validColor($0.activeColor) && validColor($0.inactiveColor) }) ?? true,
            request.activeRanges == nil || request.highlight != nil,
            request.activeRanges?.allSatisfy({ range in range.count == 2 && range[0] >= 0 && range[1] > range[0] && range[1] <= request.text.utf16.count }) ?? true else {
            throw NativeFailure("INVALID_REQUEST", "Invalid text layout request.")
        }
        let font = try FontFile.load(binding, postScriptName: request.font.postScriptName, size: request.size)
        let graphicsFont = CTFontCopyGraphicsFont(font, nil)
        var alignment: CTTextAlignment
        switch request.alignment {
        case "left": alignment = .left
        case "center": alignment = .center
        case "right": alignment = .right
        default: throw NativeFailure("INVALID_REQUEST", "Invalid text alignment.")
        }
        let verticalAlignment = request.verticalAlignment ?? "top"
        guard ["top", "center", "bottom"].contains(verticalAlignment) else {
            throw NativeFailure("INVALID_REQUEST", "Invalid vertical text alignment.")
        }
        var lineBreak: CTLineBreakMode = request.wrap ? .byWordWrapping : .byClipping
        let paragraph = withUnsafePointer(to: &alignment) { alignmentPointer in
            withUnsafePointer(to: &lineBreak) { breakPointer in
                let settings = [
                    CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: alignmentPointer),
                    CTParagraphStyleSetting(spec: .lineBreakMode, valueSize: MemoryLayout<CTLineBreakMode>.size, value: breakPointer),
                ]
                return CTParagraphStyleCreate(settings, settings.count)
            }
        }
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        func cgColor(_ value: String) -> CGColor? {
            guard value.count == 9, value.first == "#", let raw = UInt32(value.dropFirst(), radix: 16) else { return nil }
            return CGColor(colorSpace: colorSpace, components: [24, 16, 8, 0].map { CGFloat((raw >> $0) & 255) / 255 })
        }
        let color = cgColor(request.highlight?.inactiveColor ?? request.color)!
        let attributed = NSMutableAttributedString(string: request.text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
            NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
        ])
        if let highlight = request.highlight, let activeColor = cgColor(highlight.activeColor) {
            for range in request.activeRanges ?? [] {
                attributed.addAttribute(
                    NSAttributedString.Key(kCTForegroundColorAttributeName as String),
                    value: activeColor,
                    range: NSRange(location: range[0], length: range[1] - range[0]))
            }
        }
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let box = CGRect(x: 0, y: 0, width: request.width, height: request.height)
        let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), CGPath(rect: box, transform: nil), nil)
        let lines = CTFrameGetLines(frame) as! [CTLine]
        var origins = [CGPoint](repeating: .zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
        var reports: [TextLayout.Line] = []
        var glyphBounds = CGRect.null
        var fallbacks: [TextFallback] = []
        let utf16 = Array(request.text.utf16)
        func scalar(at offset: Int) -> UInt32 {
            let unit = utf16[offset]
            if UTF16.isLeadSurrogate(unit), offset + 1 < utf16.count, UTF16.isTrailSurrogate(utf16[offset + 1]) {
                return UTF16.decode(UTF16.EncodedScalar([unit, utf16[offset + 1]])).value
            }
            return UInt32(unit)
        }
        func record(_ face: String, substituted: [UInt32] = [], missing: [UInt32] = []) {
            let index = fallbacks.firstIndex { $0.face == face } ?? {
                fallbacks.append(TextFallback(face: face, substituted: [], missing: []))
                return fallbacks.count - 1
            }()
            fallbacks[index].add(substituted: substituted, missing: missing)
        }
        for (index, line) in lines.enumerated() {
            try Task.checkCancellation()
            let range = CTLineGetStringRange(line)
            var usedFonts: [String] = []
            for run in CTLineGetGlyphRuns(line) as! [CTRun] {
                let attributes = CTRunGetAttributes(run) as NSDictionary
                let used = attributes[kCTFontAttributeName] as! CTFont
                let face = CTFontCopyPostScriptName(used) as String
                // CoreText falls back per run; the frame keeps that choice and reports it. Its last
                // resort face draws a placeholder box for a code point no installed face covers, so
                // those code points are missing glyphs rather than a substitution.
                if face != request.font.postScriptName || !CFEqual(CTFontCopyGraphicsFont(used, nil), graphicsFont) {
                    let span = CTRunGetStringRange(run)
                    let drawn = (span.location..<span.location + span.length)
                        .filter { !UTF16.isTrailSurrogate(utf16[$0]) }.map(scalar)
                    if face == "LastResort" { record(face, missing: drawn) } else { record(face, substituted: drawn) }
                }
                let count = CTRunGetGlyphCount(run)
                var glyphs = [CGGlyph](repeating: 0, count: count)
                var offsets = [CFIndex](repeating: 0, count: count)
                CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
                CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &offsets)
                let blank = zip(glyphs, offsets).filter { $0.0 == 0 }.map { scalar(at: $0.1) }
                if !blank.isEmpty { record(face, missing: blank) }
                usedFonts.append(face)
            }
            reports.append(.init(range: [range.location, range.length],
                text: (request.text as NSString).substring(with: NSRange(location: range.location, length: range.length)),
                origin: [origins[index].x, Double(request.height) - origins[index].y],
                width: CTLineGetTypographicBounds(line, nil, nil, nil), fonts: usedFonts))
            glyphBounds = glyphBounds.union(CTLineGetBoundsWithOptions(line, .useGlyphPathBounds).offsetBy(dx: origins[index].x, dy: origins[index].y))
        }
        let hasGlyphBounds = !glyphBounds.isNull
        guard !hasGlyphBounds || (glyphBounds.width.isFinite && glyphBounds.height.isFinite) else {
            throw NativeFailure("FONT_GLYPH_BOUNDS_UNAVAILABLE", "The drawn glyphs have no finite bounds to lay out.")
        }
        let baseGlyphBounds = glyphBounds
        let verticalOffset: CGFloat
        if hasGlyphBounds {
            let targetMinY: CGFloat
            switch verticalAlignment {
            case "bottom": targetMinY = 0
            case "center": targetMinY = (CGFloat(request.height) - glyphBounds.height) / 2
            default: targetMinY = glyphBounds.minY
            }
            verticalOffset = targetMinY - glyphBounds.minY
            glyphBounds = glyphBounds.offsetBy(dx: 0, dy: verticalOffset)
        } else {
            verticalOffset = 0
            glyphBounds = .zero
        }
        if verticalOffset != 0 {
            reports = reports.map { line in
                var line = line
                line.origin[1] += -Double(verticalOffset)
                return line
            }
        }
        guard let context = CGContext(data: nil, width: request.width, height: request.height,
            bitsPerComponent: 8, bytesPerRow: request.width * 4, space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NativeFailure("LIMIT_EXCEEDED", "Cannot allocate text raster.")
        }
        context.textMatrix = .identity
        context.clip(to: box)
        context.translateBy(x: 0, y: verticalOffset)
        let backgroundRect = hasGlyphBounds
            ? baseGlyphBounds.insetBy(dx: -(request.background?.padding ?? 0), dy: -(request.background?.padding ?? 0))
            : .zero
        if let shadow = request.shadow, hasGlyphBounds, let color = cgColor(shadow.color) {
            context.saveGState()
            context.setShadow(offset: CGSize(width: shadow.offsetX, height: -shadow.offsetY), blur: shadow.blur, color: color)
            if request.background != nil {
                context.setFillColor(cgColor(request.background!.color)!)
                context.addPath(CGPath(roundedRect: backgroundRect, cornerWidth: request.background!.cornerRadius, cornerHeight: request.background!.cornerRadius, transform: nil))
                context.fillPath()
            } else {
                context.setFillColor(cgColor(request.color)!)
                CTFrameDraw(frame, context)
            }
            context.restoreGState()
        }
        if let background = request.background, hasGlyphBounds, let color = cgColor(background.color) {
            context.setFillColor(color)
            context.addPath(CGPath(roundedRect: backgroundRect, cornerWidth: background.cornerRadius, cornerHeight: background.cornerRadius, transform: nil))
            context.fillPath()
        }
        if let stroke = request.stroke, hasGlyphBounds, let color = cgColor(stroke.color) {
            context.saveGState()
            context.setTextDrawingMode(.stroke)
            context.setLineWidth(stroke.width)
            context.setLineJoin(.round)
            context.setStrokeColor(color)
            CTFrameDraw(frame, context)
            context.restoreGState()
        }
        CTFrameDraw(frame, context)
        guard let image = context.makeImage() else { throw NativeFailure.decodeFailed("Cannot create text raster.") }
        let visible = CTFrameGetVisibleStringRange(frame)
        let visibleGlyphBounds = hasGlyphBounds ? glyphBounds.intersection(box) : .null
        var decorationBounds = glyphBounds
        if request.background != nil { decorationBounds = decorationBounds.union(glyphBounds.insetBy(dx: -(request.background!.padding), dy: -(request.background!.padding))) }
        if let stroke = request.stroke { decorationBounds = decorationBounds.insetBy(dx: -stroke.width / 2, dy: -stroke.width / 2) }
        if let shadow = request.shadow {
            let spread = max(shadow.blur * 2, 0)
            decorationBounds = decorationBounds.union(decorationBounds.offsetBy(dx: shadow.offsetX, dy: -shadow.offsetY).insetBy(dx: -spread, dy: -spread))
        }
        let inkBounds = hasGlyphBounds
            ? [glyphBounds.minX, Double(request.height) - glyphBounds.maxY, glyphBounds.width, glyphBounds.height]
            : [0, 0, 0, 0]
        self.image = CIImage(cgImage: image)
        self.layout = .init(
            font: request.font, text: request.text, visibleRange: [visible.location, visible.length], lines: reports,
            inkBounds: inkBounds,
            visibleBounds: visibleGlyphBounds.isNull ? [] : [visibleGlyphBounds.minX, Double(request.height) - visibleGlyphBounds.maxY, visibleGlyphBounds.width, visibleGlyphBounds.height],
            decorationBounds: hasGlyphBounds
                ? Self.containing(inkBounds, [decorationBounds.minX, Double(request.height) - decorationBounds.maxY, decorationBounds.width, decorationBounds.height])
                : [0, 0, 0, 0],
            verticalOffset: Double(verticalOffset), stroke: request.stroke, shadow: request.shadow, background: request.background,
            highlight: request.highlight, activeRanges: request.activeRanges)
        self.pixels = Int64(request.width) * Int64(request.height)
        self.fallbacks = fallbacks
    }

    /// The receipt promises decoration bounds contain ink bounds, compared as the reported numbers.
    /// CGRect union and inset recompute width from edges, which can lose the last bit, so a
    /// decoration that adds no extent (a flush background) would otherwise report a box a hair
    /// smaller than its ink. Widen each axis until `origin + size` reaches the ink edge.
    static func containing(_ ink: [Double], _ bounds: [Double]) -> [Double] {
        func axis(_ inkOrigin: Double, _ inkSize: Double, _ origin: Double, _ size: Double) -> (Double, Double) {
            let start = min(origin, inkOrigin)
            let end = max(origin + size, inkOrigin + inkSize)
            var extent = end - start
            while start + extent < end { extent = extent.nextUp }
            return (start, extent)
        }
        let (x, width) = axis(ink[0], ink[2], bounds[0], bounds[2])
        let (y, height) = axis(ink[1], ink[3], bounds[1], bounds[3])
        return [x, y, width, height]
    }
}
