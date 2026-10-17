import CryptoKit
import CoreImage
import Foundation
@testable import YapFrames
import YapMedia

func verifyTextVerticalPlacement() throws {
    let fontURL = URL(fileURLWithPath: "/System/Library/Fonts/Supplemental/Arial.ttf")
    let digest = SHA256.hash(data: try Data(contentsOf: fontURL)).map { String(format: "%02x", $0) }.joined()
    let binding = try JSONDecoder().decode(
        FontAssetBinding.self,
        from: JSONEncoder().encode(["assetId": digest, "path": fontURL.path]),
    )
    func layout(_ alignment: String?) throws -> TextLayout {
        try TextRaster(TextSource(
            kind: "text", text: "Tall caption\nSecond line", font: .init(assetId: digest, postScriptName: "ArialMT"),
            width: 420, height: 200, size: 32, color: "#ffffffff", alignment: "left",
            verticalAlignment: alignment, stroke: nil, shadow: nil, background: nil,
            highlight: nil, activeRanges: nil, wrap: true), binding: binding).layout
    }
    let top = try layout(nil)
    let center = try layout("center")
    let bottom = try layout("bottom")
    precondition(top.verticalOffset == 0, "Omitted vertical alignment must retain top placement")
    precondition(top.inkBounds[1] < center.inkBounds[1] && center.inkBounds[1] < bottom.inkBounds[1],
        "Glyph bounds must move down from top to center to bottom")
    precondition(abs(center.inkBounds[1] + center.inkBounds[3] / 2 - 100) < 1,
        "Centered glyph bounds must center in the requested box")
    precondition(abs(bottom.inkBounds[1] + bottom.inkBounds[3] - 200) < 1,
        "Bottom glyph bounds must end at the requested box edge")
    precondition(center.visibleBounds.count == 4 && bottom.visibleBounds.count == 4)
    let empty = try TextRaster(TextSource(
        kind: "text", text: "", font: .init(assetId: digest, postScriptName: "ArialMT"),
        width: 420, height: 200, size: 32, color: "#ffffffff", alignment: "left",
        verticalAlignment: nil, stroke: nil, shadow: nil, background: nil,
        highlight: nil, activeRanges: nil, wrap: true), binding: binding).layout
    precondition(empty.inkBounds == [0, 0, 0, 0] && empty.visibleBounds.isEmpty,
        "Empty text must render as a transparent zero-bounds layout")
    print("PASS native text glyph bounds honor top/center/bottom alignment")
}

func verifyTextDecorations() throws {
    let fontURL = URL(fileURLWithPath: "/System/Library/Fonts/Supplemental/Arial.ttf")
    let digest = SHA256.hash(data: try Data(contentsOf: fontURL)).map { String(format: "%02x", $0) }.joined()
    let binding = try JSONDecoder().decode(
        FontAssetBinding.self,
        from: JSONEncoder().encode(["assetId": digest, "path": fontURL.path]),
    )
    let font = TextSource.Font(assetId: digest, postScriptName: "ArialMT")
    let plainRequest = TextSource(
        kind: "text", text: "Decorated", font: font, width: 420, height: 200, size: 32,
        color: "#ffffffff", alignment: "left", verticalAlignment: "center", stroke: nil,
        shadow: nil, background: nil, highlight: nil, activeRanges: nil, wrap: true)
    let decoratedRequest = TextSource(
        kind: "text", text: "Decorated", font: font, width: 420, height: 200, size: 32,
        color: "#ffffffff", alignment: "left", verticalAlignment: "center",
        stroke: .init(color: "#ff0000ff", width: 4),
        shadow: .init(color: "#000000aa", offsetX: 6, offsetY: 8, blur: 5),
        background: .init(color: "#112233dd", padding: 12, cornerRadius: 8),
        highlight: nil, activeRanges: nil, wrap: true)
    let plain = try TextRaster(plainRequest, binding: binding)
    let decorated = try TextRaster(decoratedRequest, binding: binding)
    precondition(decorated.layout.stroke == decoratedRequest.stroke)
    precondition(decorated.layout.shadow == decoratedRequest.shadow)
    precondition(decorated.layout.background == decoratedRequest.background)
    precondition(decorated.layout.decorationBounds[2] > plain.layout.inkBounds[2])
    precondition(decorated.layout.decorationBounds[3] > plain.layout.inkBounds[3])

    guard let image = CIContext().createCGImage(decorated.image, from: decorated.image.extent),
          let provider = image.dataProvider, let cfData = provider.data else {
        throw NativeFailure.decodeFailed("Cannot inspect decorated text raster.")
    }
    let data = cfData as Data
    let alphaBytes = data.withUnsafeBytes { raw in
        stride(from: 3, to: raw.count, by: 4).reduce(into: 0) { count, index in
            if raw[index] != 0 { count += 1 }
        }
    }
    precondition(alphaBytes > 0, "Decorated text must produce visible pixels")

    let pointed = try TextRaster(TextSource(
        kind: "text", text: "AVW", font: font, width: 420, height: 200, size: 80,
        color: "#ffffffff", alignment: "center", verticalAlignment: "center",
        stroke: .init(color: "#ff0000ff", width: 16), shadow: nil, background: nil,
        highlight: nil, activeRanges: nil, wrap: true), binding: binding)
    guard let pointedImage = CIContext().createCGImage(pointed.image, from: pointed.image.extent),
          let pointedData = pointedImage.dataProvider?.data else {
        throw NativeFailure.decodeFailed("Cannot inspect pointed caption stroke.")
    }
    let bounds = pointed.layout.decorationBounds
    var outsidePixels = 0
    (pointedData as Data).withUnsafeBytes { raw in
        for y in 0..<pointedImage.height {
            for x in 0..<pointedImage.width {
                let alpha = raw[y * pointedImage.bytesPerRow + x * 4 + 3]
                if alpha > 16,
                   Double(x) < floor(bounds[0]) - 1 || Double(x) >= ceil(bounds[0] + bounds[2]) + 1
                    || Double(y) < floor(bounds[1]) - 1 || Double(y) >= ceil(bounds[1] + bounds[3]) + 1 {
                    outsidePixels += 1
                }
            }
        }
    }
    precondition(outsidePixels == 0,
        "Caption stroke must fit its reported decoration bounds, allowing one antialias pixel; outside=\(outsidePixels)")

    // Core rejects a receipt whose decoration bounds do not contain its ink bounds, compared exactly
    // as the reported numbers (packages/core/src/frame-inspection.ts). Decorations that add no extent
    // (a flush background, a zero-width stroke, an unblurred unoffset shadow) must still satisfy it.
    let avenirURL = URL(fileURLWithPath: "/System/Library/Fonts/Avenir Next.ttc")
    let avenirDigest = SHA256.hash(data: try Data(contentsOf: avenirURL)).map { String(format: "%02x", $0) }.joined()
    let avenir = try JSONDecoder().decode(
        FontAssetBinding.self,
        from: JSONEncoder().encode(["assetId": avenirDigest, "path": avenirURL.path]),
    )
    let flush: [(stroke: TextSource.Stroke?, shadow: TextSource.Shadow?, background: TextSource.Background?)] = [
        (nil, nil, .init(color: "#0000008C", padding: 0, cornerRadius: 0)),
        (.init(color: "#ff0000ff", width: 0), nil, nil),
        (nil, .init(color: "#000000aa", offsetX: 0, offsetY: 0, blur: 0), nil),
    ]
    var violations: [String] = []
    for decoration in flush {
        for text in ["W H A T   Y A P   I S", "N O   A I   O F   I T S   O W N", "Decorated", "AVW"] {
            for (size, box) in [(28.0, (520, 64))] + stride(from: 12.0, through: 96.0, by: 2.5).map({ ($0, (640, 128)) }) {
                let layout = try TextRaster(TextSource(
                    kind: "text", text: text, font: .init(assetId: avenirDigest, postScriptName: "AvenirNext-DemiBold"),
                    width: box.0, height: box.1, size: size, color: "#FFFFFFFF", alignment: "center",
                    verticalAlignment: "center", stroke: decoration.stroke, shadow: decoration.shadow,
                    background: decoration.background, highlight: nil, activeRanges: nil, wrap: false),
                    binding: avenir).layout
                let (x, y, w, h) = (layout.decorationBounds[0], layout.decorationBounds[1], layout.decorationBounds[2], layout.decorationBounds[3])
                let (ix, iy, iw, ih) = (layout.inkBounds[0], layout.inkBounds[1], layout.inkBounds[2], layout.inkBounds[3])
                if !(x <= ix && y <= iy && x + w >= ix + iw && y + h >= iy + ih) {
                    violations.append("\(text) @\(size) in \(box): decoration \(layout.decorationBounds) ink \(layout.inkBounds)")
                }
            }
        }
    }
    precondition(violations.isEmpty,
        "Decoration bounds must contain ink bounds as reported; \(violations.count) violations, first: \(violations.prefix(3))")
    print("PASS native text stroke, shadow and background decorations are rendered and receipted")
}

func verifyTextHighlights() throws {
    let fontURL = URL(fileURLWithPath: "/System/Library/Fonts/Supplemental/Arial.ttf")
    let digest = SHA256.hash(data: try Data(contentsOf: fontURL)).map { String(format: "%02x", $0) }.joined()
    let binding = try JSONDecoder().decode(
        FontAssetBinding.self,
        from: JSONEncoder().encode(["assetId": digest, "path": fontURL.path]),
    )
    let font = TextSource.Font(assetId: digest, postScriptName: "ArialMT")
    let highlight = TextSource.Highlight(activeColor: "#ff0000ff", inactiveColor: "#ffffffff")
    let baseRequest = TextSource(
        kind: "text", text: "word two", font: font, width: 500, height: 160, size: 64,
        color: "#ffffffff", alignment: "left", verticalAlignment: "center", stroke: nil,
        shadow: nil, background: nil, highlight: highlight, activeRanges: nil, wrap: true)
    let activeRequest = TextSource(
        kind: "text", text: "word two", font: font, width: 500, height: 160, size: 64,
        color: "#ffffffff", alignment: "left", verticalAlignment: "center", stroke: nil,
        shadow: nil, background: nil, highlight: highlight, activeRanges: [[0, 4]], wrap: true)
    let base = try TextRaster(baseRequest, binding: binding)
    let active = try TextRaster(activeRequest, binding: binding)
    precondition(active.layout.highlight == highlight)
    precondition(active.layout.activeRanges == [[0, 4]])

    func colorCounts(_ raster: TextRaster) throws -> (red: Int, white: Int) {
        guard let image = CIContext().createCGImage(raster.image, from: raster.image.extent),
              let provider = image.dataProvider, let cfData = provider.data else {
            throw NativeFailure.decodeFailed("Cannot inspect highlighted text raster.")
        }
        let data = cfData as Data
        return data.withUnsafeBytes { raw in
            var red = 0
            var white = 0
            for index in stride(from: 0, to: raw.count - 3, by: 4) {
                let r = Int(raw[index]), g = Int(raw[index + 1]), b = Int(raw[index + 2]), a = Int(raw[index + 3])
                if a > 0, r > 180, g < 100, b < 100 { red += 1 }
                if a > 0, r > 220, g > 220, b > 220 { white += 1 }
            }
            return (red, white)
        }
    }
    let baseColors = try colorCounts(base)
    let activeColors = try colorCounts(active)
    precondition(baseColors.red == 0, "Inactive text must not contain active highlight pixels")
    precondition(activeColors.red > 0, "Active range must render active-color pixels")
    precondition(activeColors.white < baseColors.white, "Active range must replace inactive-color pixels")
    print("PASS native text active ranges render highlighted glyphs and receipt mappings")
}
