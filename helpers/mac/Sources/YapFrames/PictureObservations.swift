import CoreGraphics
import CryptoKit
import Foundation
import YapMedia

/// Explicit masks address the delivered raster, after orientation, composition and sizing.
public struct PictureObservationRequest: Codable, Sendable, Equatable {
    public struct Rect: Codable, Sendable, Equatable {
        let x: Int
        let y: Int
        let width: Int
        let height: Int
    }
    public struct Region: Codable, Sendable, Equatable {
        let id: String
        let rect: Rect
    }
    let darkAtOrBelow: Int
    let brightAtOrAbove: Int
    let edgeDarkFraction: Double
    let edgeOpaqueFraction: Double
    let regions: [Region]

    func validate() throws {
        guard (0...255).contains(darkAtOrBelow), (0...255).contains(brightAtOrAbove),
            darkAtOrBelow < brightAtOrAbove,
            edgeDarkFraction.isFinite, (0...1).contains(edgeDarkFraction),
            edgeOpaqueFraction.isFinite, (0...1).contains(edgeOpaqueFraction),
            regions.count <= 8, Set(regions.map(\.id)).count == regions.count,
            regions.reduce(0, { $0 + $1.rect.width * $1.rect.height }) <= 8192 * 8192,
            regions.allSatisfy({
                !$0.id.isEmpty && $0.id.utf8.count <= 128
                    && (-1_000_000...1_000_000).contains($0.rect.x)
                    && (-1_000_000...1_000_000).contains($0.rect.y)
                    && (1...8192).contains($0.rect.width) && (1...8192).contains($0.rect.height)
            })
        else { throw NativeFailure("INVALID_REQUEST", "Invalid picture observation masks or thresholds.") }
    }
}

public struct PictureObservations: Encodable {
    struct Profile: Encodable {
        let name: String
        /// Some named CoreGraphics spaces have no exportable ICC bytes; absence stays explicit.
        let sha256: String?
        enum CodingKeys: String, CodingKey { case name, sha256, iccStatus }
        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(name, forKey: .name)
            try values.encode(sha256, forKey: .sha256)
            try values.encode(sha256 == nil ? "absent" : "present", forKey: .iccStatus)
        }
    }
    struct Metric: Encodable {
        let histogram: [Int]
        let mean: Double?
        let minimum: Int?
        let maximum: Int?
        let darkFraction: Double?
        let brightFraction: Double?
    }
    struct Channels: Encodable { let red: Metric; let green: Metric; let blue: Metric }
    struct Coverage: Encodable {
        let requestedPixels: Int
        let rasterPixels: Int
        let opaquePixels: Int
        let transparentPixels: Int
        let partialAlphaPixels: Int
    }
    struct Region: Encodable {
        let id: String
        let requestedRect: PictureObservationRequest.Rect
        let sampledRect: PictureObservationRequest.Rect?
        let state: String
        let reason: String?
        let coverage: Coverage
        let channels: Channels
        let luma: Metric
    }
    struct EdgeBand: Encodable {
        let edge: String
        let depthPixels: Int
        let rect: PictureObservationRequest.Rect
        let opaqueFraction: Double
        let darkFraction: Double
        let meanLuma: Double
        let histogram: [Int]
        /// Absent when the candidate reaches the opposite edge: no transition was observed.
        let adjacentMeanLuma: Double?
    }
    let recipe = "profile-managed-srgb-rgba8-rec709-encoded-luma-opaque-only-v1"
    let coordinateSpace = "delivered-top-left-pixels"
    private static let rec709Weights = [0.2126, 0.7152, 0.0722]
    let lumaWeights = Self.rec709Weights
    let alphaInterpretation = "only-alpha-255-contributes-to-color-metrics"
    let sourceProfile: Profile
    let measurementProfile: Profile
    let width: Int
    let height: Int
    let rgbaSha256: String
    let request: PictureObservationRequest
    let full: Region
    let regions: [Region]
    let edgeBands: [EdgeBand]

    /// Measures the very CGImage encoded by FrameImage. No pathname or video decoder is involved.
    static func measure(_ image: CGImage, request: PictureObservationRequest) throws -> Self {
        try request.validate()
        let width = image.width, height = image.height
        guard width > 0, height > 0, width <= 8192, height <= 8192,
            let sourceColor = image.colorSpace,
            sourceColor.name != nil || sourceColor.copyICCData() != nil,
            let color = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: color,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                    | CGBitmapInfo.byteOrder32Big.rawValue)
        else { throw NativeFailure("INVALID_RESPONSE", "Delivered picture has no measurable color profile or raster.") }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let data = context.data else {
            throw NativeFailure.decodeFailed("Cannot inspect delivered picture pixels.")
        }
        let pixels = Data(bytes: data, count: width * height * 4)
        let raster = PictureObservationRequest.Rect(x: 0, y: 0, width: width, height: height)
        var rows = [Axis](repeating: Axis(), count: height)
        var columns = [Axis](repeating: Axis(), count: width)
        func region(id: String, rect: PictureObservationRequest.Rect, axes: Bool = false) throws -> Region {
            let left = max(0, rect.x), top = max(0, rect.y)
            let right = min(width, rect.x + rect.width), bottom = min(height, rect.y + rect.height)
            let intersection = right > left && bottom > top
                ? PictureObservationRequest.Rect(x: left, y: top, width: right - left, height: bottom - top) : nil
            var histograms = [[Int]](repeating: [Int](repeating: 0, count: 256), count: 4)
            var opaque = 0, transparent = 0, partial = 0
            if intersection != nil {
                for y in top..<bottom {
                    try Task.checkCancellation()
                    for x in left..<right {
                        let offset = (y * width + x) * 4
                        if pixels[offset + 3] == 0 { transparent += 1; continue }
                        if pixels[offset + 3] != 255 { partial += 1; continue }
                        opaque += 1
                        let red = Int(pixels[offset]), green = Int(pixels[offset + 1]), blue = Int(pixels[offset + 2])
                        let luma = Int((rec709Weights[0] * Double(red) + rec709Weights[1] * Double(green)
                            + rec709Weights[2] * Double(blue)).rounded())
                        histograms[0][red] += 1
                        histograms[1][green] += 1
                        histograms[2][blue] += 1
                        histograms[3][luma] += 1
                        if axes {
                            rows[y].add(luma, dark: request.darkAtOrBelow)
                            columns[x].add(luma, dark: request.darkAtOrBelow)
                        }
                    }
                }
            }
            func metric(_ bins: [Int]) -> Metric {
                Metric(histogram: bins,
                    mean: opaque == 0 ? nil : Double(bins.enumerated().reduce(0) { $0 + $1.offset * $1.element }) / Double(opaque),
                    minimum: bins.firstIndex(where: { $0 > 0 }), maximum: bins.lastIndex(where: { $0 > 0 }),
                    darkFraction: opaque == 0 ? nil : Double(bins[0...request.darkAtOrBelow].reduce(0, +)) / Double(opaque),
                    brightFraction: opaque == 0 ? nil : Double(bins[request.brightAtOrAbove...255].reduce(0, +)) / Double(opaque))
            }
            return Region(id: id, requestedRect: rect, sampledRect: intersection,
                state: opaque > 0 ? "measured" : "unavailable",
                reason: opaque > 0 ? nil : intersection == nil ? "outside_raster" : "no_opaque_pixels",
                coverage: Coverage(requestedPixels: rect.width * rect.height,
                    rasterPixels: (intersection?.width ?? 0) * (intersection?.height ?? 0),
                    opaquePixels: opaque, transparentPixels: transparent, partialAlphaPixels: partial),
                channels: Channels(red: metric(histograms[0]), green: metric(histograms[1]), blue: metric(histograms[2])),
                luma: metric(histograms[3]))
        }
        let full = try region(id: "full", rect: raster, axes: true)
        let regions = try request.regions.map { try region(id: $0.id, rect: $0.rect) }
        func band(edge: String, axis: [Axis], breadth: Int, reverse: Bool) -> EdgeBand? {
            let ordered = reverse ? Array(axis.reversed()) : axis
            var depth = 0, total = Axis()
            for row in ordered {
                guard row.opaque > 0,
                    Double(row.opaque) / Double(breadth) >= request.edgeOpaqueFraction,
                    Double(row.dark) / Double(row.opaque) >= request.edgeDarkFraction else { break }
                depth += 1; total.opaque += row.opaque; total.dark += row.dark; total.sum += row.sum
                for i in 0..<256 { total.histogram[i] += row.histogram[i] }
            }
            guard depth > 0 else { return nil }
            let adjacent = depth < ordered.count && ordered[depth].opaque > 0
                ? Double(ordered[depth].sum) / Double(ordered[depth].opaque) : nil
            let rect = edge == "top" ? PictureObservationRequest.Rect(x: 0, y: 0, width: width, height: depth)
                : edge == "bottom" ? PictureObservationRequest.Rect(x: 0, y: height - depth, width: width, height: depth)
                : edge == "left" ? PictureObservationRequest.Rect(x: 0, y: 0, width: depth, height: height)
                : PictureObservationRequest.Rect(x: width - depth, y: 0, width: depth, height: height)
            return EdgeBand(edge: edge, depthPixels: depth, rect: rect,
                opaqueFraction: Double(total.opaque) / Double(depth * breadth),
                darkFraction: Double(total.dark) / Double(total.opaque), meanLuma: Double(total.sum) / Double(total.opaque), histogram: total.histogram,
                adjacentMeanLuma: adjacent)
        }
        return Self(sourceProfile: Profile(name: sourceColor.name.map { $0 as String } ?? "unnamed ICC",
                sha256: sourceColor.copyICCData().map { digest($0 as Data) }),
            measurementProfile: Profile(name: color.name.map { $0 as String } ?? "unnamed ICC",
                sha256: color.copyICCData().map { digest($0 as Data) }),
            width: width, height: height, rgbaSha256: digest(pixels), request: request, full: full, regions: regions,
            edgeBands: [band(edge: "top", axis: rows, breadth: width, reverse: false),
                band(edge: "bottom", axis: rows, breadth: width, reverse: true),
                band(edge: "left", axis: columns, breadth: height, reverse: false),
                band(edge: "right", axis: columns, breadth: height, reverse: true)].compactMap { $0 })
    }
    private struct Axis {
        var opaque = 0, dark = 0, sum = 0
        var histogram = [Int](repeating: 0, count: 256)
        mutating func add(_ value: Int, dark threshold: Int) {
            opaque += 1; sum += value
            histogram[value] += 1
            if value <= threshold { dark += 1 }
        }
    }
    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
