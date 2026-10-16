@preconcurrency import AVFoundation
import CoreImage
import Foundation
import YapMedia

/// Executes compiled pictures for both direct inspection and movie delivery.
public final class CompositionPictureExecutor {
    static let maximumSequentialAdvanceUs: Int64 = 1_000_000
    public struct Canvas: Codable {
        struct FPS: Codable {
            let numerator: Int
            let denominator: Int
        }
        let width: Int
        let height: Int
        let fps: FPS
        let background: String
        func validate() throws {
            guard width > 0, height > 0, width <= 8192, height <= 8192,
                width.isMultiple(of: 2), height.isMultiple(of: 2),
                fps.numerator > 0, fps.denominator > 0
            else {
                throw NativeFailure(
                    "INVALID_REQUEST",
                    "Pictures require even canvas dimensions up to 8192 and a positive frame rate.")
            }
        }
    }
    public struct Frame: Codable {
        struct Layer: Codable {
            let clipId: String
            let trackId: String
            let assetId: String?
            let streamId: String?
            let text: TextSource?
            let kind: String
            let sourceUs: ExactTime?
            let availability: String
            let width: Double
            let height: Double
            func mediaKey() throws -> String {
                guard let assetId, let streamId, text == nil else {
                    throw NativeFailure("INVALID_REQUEST", "Media layers require an asset stream binding.")
                }
                return assetId + "\u{0}" + streamId
            }
        }
        struct Node: Codable, Equatable {
            let target: CompositionProcessing.Target
            let inputs: [CompositionProcessing.Target]
            let operations: [Operation]
        }
        struct Operation: Codable, Hashable {
            struct Point: Codable, Hashable {
                let x: Double
                let y: Double
            }
            let points: [Point]?
            let kind: String
            let x: Double?
            let y: Double?
            let width: Double?
            let height: Double?
            let matrix: [Double]?
            let exposureEV: Double?
            let contrast: Double?
            let saturation: Double?
            let shadows: Double?
            let highlights: Double?
            let neutralKelvin: Double?
            let neutralTint: Double?
            let mode: String?
            let assetId: String?
            let colorSpace: String?
            let interpolation: String?
            let samples: Int?
            let shutter: Double?
            func correction() throws -> SDRCorrection.Parameters {
                guard let exposureEV, let contrast, let saturation, let shadows, let highlights,
                    let neutralKelvin, let neutralTint else {
                    throw NativeFailure("INVALID_REQUEST", "Missing SDR correction parameters.")
                }
                return SDRCorrection.Parameters(
                    exposureEV: exposureEV, contrast: contrast, saturation: saturation,
                    shadows: shadows, highlights: highlights,
                    neutralKelvin: neutralKelvin, neutralTint: neutralTint)
            }
            let opacity: Double?
            let stepId: String?
            let trailUs: Int64?
            let geometryPrefix: [Int]?
        }
        let index: Int64
        let sampleAtUs: Int64
        let visibleRange: TimeSpan
        let layers: [Layer]
        let visual: [Node]
    }
    public struct Sample: Encodable {
        let value: String
        let timescale: Int32
        let originUs: ExactTime
    }
    public struct Picture: Encodable {
        var kind = "video"
        let status: String
        var clipId: String? = nil
        var assetId: String? = nil
        var streamId: String? = nil
        var requestedSourceUs: ExactTime? = nil
        // Physical sample rounded to microseconds, ties away from zero, then origin subtracted.
        // The sample field retains exact native time.
        var actualSourceUs: Int64? = nil
        var sample: Sample? = nil
        var reason: String? = nil
        var layout: TextLayout? = nil
    }
    /// A text raster's `TextFallback`, attributed to the clip whose text it drew.
    public struct TextFallbackReport: Encodable, Equatable {
        let clipId: String
        var fallback: TextFallback
        enum CodingKeys: String, CodingKey { case clipId, face, substituted, missing }
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(clipId, forKey: .clipId)
            try container.encode(fallback.face, forKey: .face)
            try container.encode(fallback.substituted, forKey: .substituted)
            try container.encode(fallback.missing, forKey: .missing)
        }
    }
    private func recordFallbacks(_ fallbacks: [TextFallback], clipId: String) {
        for fallback in fallbacks {
            if let index = textFallbacks.firstIndex(where: { $0.clipId == clipId && $0.fallback.face == fallback.face }) {
                textFallbacks[index].fallback.add(substituted: fallback.substituted, missing: fallback.missing)
            } else {
                textFallbacks.append(TextFallbackReport(clipId: clipId, fallback: fallback))
            }
        }
    }
    private struct LayerKey: Equatable {
        let clipId: String
        let reader: Int
        let binding: String
        let sampleTime: CMTime?
        let available: Bool
        var text: TextSource? = nil
    }
    private struct PointerRasterKey: Equatable {
        let clipId: String
        let stepId: String
        let captureUs: Int64?
        let overlay: FrameOverlay?
    }
    private struct RasterKey: Equatable {
        let layers: [LayerKey]
        let visual: [Frame.Node]
        let pointers: [PointerRasterKey]
    }
    private struct PreparedPicture {
        let key: RasterKey
        var surfaces: [CompositionProcessing.Target: CIImage]
        let pointerRows: [PreparedPointers.Row]
    }
    private final class Reader {
        let source: PresentationSource
        let binding: String
        let ordinal: Int
        var at: ExactTime
        init(source: PresentationSource, binding: String, ordinal: Int, at: ExactTime) {
            self.source = source
            self.binding = binding
            self.ordinal = ordinal
            self.at = at
        }
    }
    private let sdrCorrectionImplementationId: String?
    private let preparedPointers: PreparedPointers?
    private let canvas: Canvas
    private let deliveredSize: (width: Int, height: Int)
    private let assets: [String: CompositionAsset]
    private let fonts: [String: FontAssetBinding]
    private let lutBindings: [String: LUTAssetBinding]
    private var luts: [String: CubeLUT] = [:]
    private let lutImplementationId: String?
    private let background: CIImage
    private let backgroundIsOpaque: Bool
    let color = CVImageBufferCreateColorSpaceFromAttachments(
        [
            kCVImageBufferColorPrimariesKey as String: kCVImageBufferColorPrimaries_ITU_R_709_2,
            kCVImageBufferTransferFunctionKey as String:
                kCVImageBufferTransferFunction_ITU_R_709_2,
            kCVImageBufferYCbCrMatrixKey as String: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ] as CFDictionary)!.takeRetainedValue()
    // Provisional profile work bounds; representative release-scale capacity is a separate gate.
    private static let maximumDecodedPixels: Int64 = 8192 * 8192
    private static let maximumIntermediatePixels: Int64 = 8192 * 8192
    private static let maximumCoverageBytes: Int64 = 64 * 1024 * 1024
    private var coverageMasks: [Frame.Operation: CIImage] = [:]
    let context = CIContext(options: [
        .cacheIntermediates: false,
        .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
        .workingFormat: CIFormat.RGBAh.rawValue,
    ])
    private var readers: [String: Reader] = [:]
    private var stills: [String: StillImageSource] = [:]
    private var texts: [TextSource: TextRaster] = [:]
    private(set) var decodedImages = 0
    private var decoded = 0
    private(set) var opens = 0
    private(set) var maximumActiveSources = 0
    private(set) var rasterized = 0
    private(set) var pointerRasterizations = 0
    private var retainedRaster: (key: RasterKey, buffer: CVPixelBuffer)?
    private(set) var pictures: [Picture] = []
    /// Every font fallback drawn so far, one entry per text clip and face, in first-drawn order.
    private(set) var textFallbacks: [TextFallbackReport] = []
    private(set) var outputIsKnownOpaque = false
    var decodedSamples: Int { decoded + readers.values.reduce(0) { $0 + $1.source.decodedCount } }

    init(canvas: Canvas, deliveredSize: (width: Int, height: Int), bindings: [CompositionAsset], fonts: [FontAssetBinding] = [], luts: [LUTAssetBinding] = [], lutImplementationId: String? = nil, pointers: PreparedPointersReceipt? = nil, sdrCorrectionImplementationId: String? = nil)
        throws
    {
        self.sdrCorrectionImplementationId = sdrCorrectionImplementationId
        self.lutImplementationId = lutImplementationId
        self.preparedPointers = try pointers.map(PreparedPointers.init)
        try canvas.validate()
        var assets: [String: CompositionAsset] = [:]
        for asset in bindings {
            let key = asset.assetId + "\u{0}" + asset.streamId
            guard assets.updateValue(asset, forKey: key) == nil else {
                throw Self.invalid("Duplicate source binding.")
            }
        }
        let background = try Self.background(canvas)
        self.background = background.image
        self.backgroundIsOpaque = background.opaque
        self.canvas = canvas
        self.deliveredSize = deliveredSize
        self.assets = assets
        var fontBindings: [String: FontAssetBinding] = [:]
        for font in fonts {
            guard fontBindings.updateValue(font, forKey: font.assetId) == nil else { throw Self.invalid("Duplicate font asset binding.") }
        }
        self.fonts = fontBindings
        var lutBindings: [String: LUTAssetBinding] = [:]
        for lut in luts {
            guard lutBindings.updateValue(lut, forKey: lut.assetId) == nil else {
                throw Self.invalid("Duplicate LUT asset binding.")
            }
        }
        self.lutBindings = lutBindings
    }

    func image(_ frame: Frame) async throws -> CIImage {
        var prepared = try await prepare(frame)
        let sourceContext = CIContext(options: [.cacheIntermediates: false])
        // Materialize decoded CV video in the source-picture colors used by raw PNG publication.
        // ImageIO/glyph sources and the movie graph retain their existing color preparation.
        for layer in prepared.key.layers where layer.reader > 0 && layer.available {
            try Task.checkCancellation()
            let target = CompositionProcessing.Target(kind: "clip", id: layer.clipId)
            let source = prepared.surfaces[target]!
            let edge = Int(max(source.extent.width, source.extent.height).rounded())
            let rendered = try FrameImage(oriented: source, maxLongEdge: edge)
                .renderedImage(context: sourceContext)
            prepared.surfaces[target] = CIImage(cgImage: rendered)
        }
        return try compose(prepared)
    }

    func render(_ frame: Frame, allocate: (CVPixelBuffer?) async throws -> CVPixelBuffer)
        async throws -> CVPixelBuffer
    {
        let prepared = try await prepare(frame)
        // Consume source and pointer evidence even when an already validated graph holds its pixels.
        if let retainedRaster, retainedRaster.key == prepared.key {
            return try await allocate(retainedRaster.buffer)
        }
        let image = try compose(prepared)
        let destination = try await allocate(nil)
        // Composition operations are authored in canvas coordinates. A preview can use a
        // smaller delivery buffer, but that must scale the complete canvas into the buffer;
        // rendering the unscaled image with smaller bounds would crop its top-left quadrant.
        let deliveredImage = image.transformed(by: CGAffineTransform(
            scaleX: CGFloat(deliveredSize.width) / CGFloat(canvas.width),
            y: CGFloat(deliveredSize.height) / CGFloat(canvas.height)))
        context.render(
            deliveredImage, to: destination,
            bounds: CGRect(x: 0, y: 0, width: deliveredSize.width, height: deliveredSize.height),
            colorSpace: color)
        CVBufferSetAttachment(
            destination, kCVImageBufferCGColorSpaceKey, color, .shouldPropagate)
        CVBufferSetAttachment(
            destination, kCVImageBufferColorPrimariesKey,
            kCVImageBufferColorPrimaries_ITU_R_709_2,
            .shouldPropagate)
        CVBufferSetAttachment(
            destination, kCVImageBufferTransferFunctionKey,
            kCVImageBufferTransferFunction_ITU_R_709_2,
            .shouldPropagate)
        CVBufferSetAttachment(
            destination, kCVImageBufferYCbCrMatrixKey,
            kCVImageBufferYCbCrMatrix_ITU_R_709_2,
            .shouldPropagate)
        // Reuse pixels only when physical samples and every compiled operation agree.
        retainedRaster = (prepared.key, destination)
        rasterized += 1
        return destination
    }

    private func prepare(_ frame: Frame) async throws -> PreparedPicture {
        try Task.checkCancellation()
        guard frame.layers.count <= 256, !frame.visual.isEmpty, frame.visual.count <= 10_000 else {
            throw Self.invalid("Compiled picture graph exceeds execution bounds.")
        }
        let requiredMasks = try preflightSurfaces(frame)
        let active = Set(frame.layers.map(\.clipId))
        guard active.count == frame.layers.count else {
            throw Self.invalid("Duplicate picture occurrence.")
        }
        let videoActive = Set(frame.layers.filter { $0.kind == "video" }.map(\.clipId))
        for id in readers.keys where !videoActive.contains(id) {
            decoded += readers.removeValue(forKey: id)!.source.decodedCount
        }
        let imageBindings = try Set(
            frame.layers.filter { $0.kind == "image" }.map { try $0.mediaKey() })
        stills = stills.filter { imageBindings.contains($0.key) }
        let activeTexts = Set(frame.layers.filter { $0.kind == "text" && $0.availability == "available" }.compactMap(\.text))
        texts = texts.filter { activeTexts.contains($0.key) }
        var media: [String: PresentationSource.Media] = [:]
        for reader in readers.values { media[reader.binding] = reader.source.media }
        var decodedPixels: Int64 = 0
        for layer in frame.layers {
            try Task.checkCancellation()
            if layer.kind == "text" {
                guard let text = layer.text, layer.assetId == nil, layer.streamId == nil, layer.sourceUs == nil,
                    layer.width == Double(text.width), layer.height == Double(text.height) else { throw Self.invalid("Invalid text layer identity.") }
                continue
            }
            let key = try layer.mediaKey()
            guard let asset = assets[key] else {
                throw Self.invalid("Missing retained source binding.")
            }
            if layer.kind == "image" {
                guard layer.sourceUs == nil, asset.streamId == "image:0" else {
                    throw Self.invalid("Still layers have image identity without a source clock.")
                }
                continue
            }
            guard layer.kind == "video", layer.sourceUs != nil else {
                throw Self.invalid("Video layers require a source clock.")
            }
            if media[key] == nil {
                let prepared = try await PresentationSource.prepare(
                    source: URL(fileURLWithPath: asset.path), streamId: asset.streamId)
                try await VideoColorPolicy.requireSupportedColor(prepared.track)
                media[key] = prepared
            }
            decodedPixels += media[key]!.decodedPixels
        }
        // Reserve retained images and every video's declared decode before opening a new image.
        // ImageIO must reject an oversized header before allocating its pixels.
        var reservedPixels =
            decodedPixels
            + stills.values.reduce(0) {
                $0 + Int64($1.width) * Int64($1.height)
            } + texts.values.reduce(0) { $0 + $1.pixels }
        try Self.requireBudget(
            "decoded-source-pixels", requested: reservedPixels,
            limit: Self.maximumDecodedPixels, frame: frame.index)
        for layer in frame.layers where layer.kind == "image" {
            try Task.checkCancellation()
            let key = try layer.mediaKey()
            if stills[key] == nil {
                let remaining = Self.maximumDecodedPixels - reservedPixels
                guard remaining > 0 else {
                    throw NativeFailure(
                        "LIMIT_EXCEEDED",
                        "No decoded-source pixel budget remains for a still image.")
                }
                guard
                    let still = try StillImageSource.open(
                        URL(fileURLWithPath: assets[key]!.path), maximumPixels: remaining)
                else {
                    throw Self.invalid("Selected source is not a PNG or JPEG still image.")
                }
                stills[key] = still
                reservedPixels += Int64(still.width) * Int64(still.height)
                opens += 1
                decodedImages += 1
            }
        }
        for text in activeTexts where texts[text] == nil {
            guard text.width > 0, text.width <= 4096, text.height > 0, text.height <= 4096 else { throw Self.invalid("Invalid text raster dimensions.") }
            let pixels = Int64(text.width) * Int64(text.height)
            try Self.requireBudget("decoded-source-pixels", requested: reservedPixels + pixels,
                limit: Self.maximumDecodedPixels, frame: frame.index)
            guard let binding = fonts[text.font.assetId] else { throw Self.invalid("Missing retained font binding.") }
            texts[text] = try TextRaster(text, binding: binding)
            reservedPixels += pixels
        }
        coverageMasks = coverageMasks.filter { requiredMasks.contains($0.key) }
        var surfaces: [CompositionProcessing.Target: CIImage] = [:]
        var keys: [LayerKey] = []
        pictures = []
        for layer in frame.layers {
            try Task.checkCancellation()
            guard layer.width > 0, layer.height > 0, layer.width <= 32768, layer.height <= 32768
            else { throw Self.invalid("Invalid compiled layer.") }
            if layer.kind == "text", let text = layer.text {
                guard layer.availability == "available" || layer.availability == "anchor-unavailable" else { throw Self.invalid("Invalid text availability.") }
                let available = layer.availability == "available"
                let raster = texts[text]
                if available, let raster { recordFallbacks(raster.fallbacks, clipId: layer.clipId) }
                pictures.append(Picture(kind: "text", status: available ? "available" : "unavailable",
                    clipId: layer.clipId, reason: available ? nil : layer.availability, layout: available ? raster?.layout : nil))
                keys.append(LayerKey(clipId: layer.clipId, reader: 0, binding: text.font.assetId,
                    sampleTime: nil, available: available, text: text))
                surfaces[.init(kind: "clip", id: layer.clipId)] = available ? raster!.image : CIImage(color: .clear).cropped(to: CGRect(x: 0, y: 0, width: text.width, height: text.height))
                continue
            }
            let binding = try layer.mediaKey()
            guard let asset = assets[binding] else {
                throw Self.invalid("Missing retained source binding.")
            }
            switch layer.availability {
            case "available", "source-unavailable", "anchor-unavailable": break
            default: throw Self.invalid("Unknown compiled source availability.")
            }
            if layer.kind == "image" {
                let still = stills[binding]!
                guard Double(still.orientedWidth) == layer.width,
                    Double(still.orientedHeight) == layer.height
                else {
                    throw Self.invalid("Compiled image dimensions disagree with oriented source.")
                }
                let available = layer.availability == "available"
                pictures.append(
                    Picture(
                        kind: "image", status: available ? "available" : "unavailable",
                        clipId: layer.clipId, assetId: layer.assetId, streamId: layer.streamId,
                        reason: available ? nil : layer.availability))
                keys.append(
                    LayerKey(
                        clipId: layer.clipId, reader: 0, binding: binding,
                        sampleTime: nil, available: available))
                surfaces[.init(kind: "clip", id: layer.clipId)] =
                    available
                    ? still.oriented
                    : CIImage(color: .clear).cropped(
                        to: CGRect(x: 0, y: 0, width: layer.width, height: layer.height))
                maximumActiveSources = max(maximumActiveSources, readers.count + stills.count)
                continue
            }
            guard let sourceUs = layer.sourceUs, sourceUs.numerator >= 0,
                try sourceUs.compare(ExactTime(Int128(TimeSpan.maximumMicroseconds))) != .orderedDescending
            else {
                throw Self.invalid("Invalid compiled video source clock.")
            }
            let at = try sourceUs.adding(asset.originUs)
            guard try at.compare(ExactTime(-Int128(TimeSpan.maximumMicroseconds))) != .orderedAscending,
                try at.compare(ExactTime(Int128(TimeSpan.maximumMicroseconds))) != .orderedDescending
            else { throw Self.invalid("Source clock exceeds native precision.") }
            if let reader = readers[layer.clipId],
                try reader.binding != binding || at.compare(reader.at) == .orderedAscending
                    || at.subtract(reader.at).compare(ExactTime(Int128(Self.maximumSequentialAdvanceUs))) == .orderedDescending
            {
                decoded += readers.removeValue(forKey: layer.clipId)!.source.decodedCount
            }
            if readers[layer.clipId] == nil {
                let source = try PresentationSource(media: media[binding]!, startUs: at.sample(1_000_000))
                opens += 1
                readers[layer.clipId] = Reader(
                    source: source, binding: binding, ordinal: opens, at: at)
            }
            maximumActiveSources = max(maximumActiveSources, readers.count + stills.count)
            let reader = readers[layer.clipId]!
            reader.at = at
            let selected = try reader.source.selection(
                at: at, end: .positiveInfinity)
            var picture = Picture(
                status: "unavailable", clipId: layer.clipId, assetId: layer.assetId,
                streamId: layer.streamId, requestedSourceUs: layer.sourceUs,
                reason: layer.availability == "available" ? "physical-empty" : layer.availability
            )
            var image = CIImage(color: .clear).cropped(
                to: CGRect(x: 0, y: 0, width: layer.width, height: layer.height))
            let available = layer.availability == "available" && selected.buffer != nil
            if available, let buffer = selected.buffer {
                guard let sampleTime = selected.sampleTime else {
                    throw Self.invalid("Selected picture has no physical sample time.")
                }
                image = orientedVideoImage(buffer, transform: reader.source.transform)
                guard abs(image.extent.width - Double(layer.width)) < 0.001,
                    abs(image.extent.height - Double(layer.height)) < 0.001
                else {
                    throw Self.invalid(
                        "Compiled source dimensions \(layer.width)x\(layer.height) disagree with oriented media \(image.extent.width)x\(image.extent.height)."
                    )
                }
                picture = Picture(
                    status: "available", clipId: layer.clipId, assetId: layer.assetId,
                    streamId: layer.streamId, requestedSourceUs: layer.sourceUs,
                    actualSourceUs: try ExactTime(sampleTime).subtract(asset.originUs).sample(1_000_000, nearest: true),
                    sample: Sample(
                        value: String(sampleTime.value), timescale: sampleTime.timescale,
                        originUs: asset.originUs))
            }
            pictures.append(picture)
            keys.append(
                LayerKey(
                    clipId: layer.clipId, reader: reader.ordinal, binding: binding,
                    sampleTime: selected.sampleTime,
                    available: available))
            surfaces[.init(kind: "clip", id: layer.clipId)] = image
        }
        var pointerKeys: [PointerRasterKey] = []
        var pointerRows: [PreparedPointers.Row] = []
        for node in frame.visual {
            for operation in node.operations where operation.kind == "pointer" {
                guard let preparedPointers, let clipId = node.target.id else {
                    throw Self.invalid("Enabled pointer requires prepared source evidence.")
                }
                let row = try preparedPointers.take(
                    frame: frame, clipId: clipId, operation: operation,
                    layer: frame.layers.first(where: { $0.clipId == clipId }),
                    picture: pictures.first(where: { $0.clipId == clipId }))
                pointerRows.append(row)
                pointerKeys.append(
                    PointerRasterKey(
                        clipId: clipId, stepId: row.stepId, captureUs: row.captureUs,
                        overlay: row.overlay))
            }
        }
        outputIsKnownOpaque =
            backgroundIsOpaque && frame.visual.last!.target.kind == "output" && frame.visual.last!.operations.isEmpty
        return PreparedPicture(
            key: RasterKey(layers: keys, visual: frame.visual, pointers: pointerKeys),
            surfaces: surfaces, pointerRows: pointerRows)
    }

    private func compose(_ prepared: PreparedPicture) throws -> CIImage {
        let canvasRect = CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height)
        let transparent = CIImage(color: .clear).cropped(to: canvasRect)
        var surfaces = prepared.surfaces
        let projections = try pointerProjections(prepared)
        var pointerRow = 0
        var seen = Set<CompositionProcessing.Target>()
        var image = transparent
        for node in prepared.key.visual {
            guard seen.insert(node.target).inserted, node.operations.count <= 1024,
                ["clip", "track", "group", "output"].contains(node.target.kind),
                node.target.kind == "output" ? node.target.id == nil : node.target.id != nil
            else { throw Self.invalid("Invalid visual graph target.") }
            if node.target.kind == "clip" {
                guard node.inputs.isEmpty else {
                    throw Self.invalid("A clip cannot have visual inputs.")
                }
                image = surfaces[node.target] ?? transparent
            } else {
                image = node.target.kind == "output" ? background : transparent
                for input in node.inputs {
                    guard seen.contains(input), let child = surfaces.removeValue(forKey: input)
                    else {
                        throw Self.invalid("Visual inputs must precede their one parent.")
                    }
                    image = try composite(child, over: image, mode: blendMode(for: input, in: prepared.key.visual))
                }
                image = image.cropped(to: canvasRect)
            }
            for operation in node.operations {
                if operation.kind == "blend" { continue }
                if operation.kind != "pointer" {
                    image = try apply(operation, to: image)
                    continue
                }
                let row = prepared.pointerRows[pointerRow]
                pointerRow += 1
                if let overlay = row.overlay, let width = row.width, let height = row.height,
                    let at = row.captureUs, let projection = projections[node.target],
                    projection.scale > 0, !projection.visible.isEmpty,
                    let drawn = try CursorOverlay.image(
                        overlay, agedFromUs: at, width: width, height: height,
                        visibleLongEdge: projection.longEdge, deliveredScale: projection.scale)
                {
                    pointerRasterizations += 1
                    var pointer = CIImage(cgImage: drawn)
                    for index in operation.geometryPrefix! {
                        pointer = try apply(node.operations[index], to: pointer)
                    }
                    image = pointer.composited(over: image)
                }
            }
            surfaces[node.target] = image
        }
        guard surfaces.count == 1 else {
            throw Self.invalid("Visual graph has unconsumed surfaces.")
        }
        return image
    }

    private func blendMode(for target: CompositionProcessing.Target, in nodes: [Frame.Node]) throws -> String {
        guard let node = nodes.first(where: { $0.target == target }) else {
            throw Self.invalid("Visual input has no compiled node.")
        }
        let modes = node.operations.compactMap { $0.kind == "blend" ? $0.mode : nil }
        guard modes.count <= 1 else { throw Self.invalid("A visual surface cannot declare multiple blend modes.") }
        guard let mode = modes.first else { return "normal" }
        guard ["normal", "multiply", "screen", "soft-light"].contains(mode) else {
            throw Self.invalid("Unknown layer blend mode.")
        }
        return mode
    }

    private func composite(_ source: CIImage, over backdrop: CIImage, mode: String) throws -> CIImage {
        switch mode {
        case "normal": return source.composited(over: backdrop)
        case "multiply":
            return source.applyingFilter("CIMultiplyBlendMode", parameters: [kCIInputBackgroundImageKey: backdrop])
        case "screen":
            return source.applyingFilter("CIScreenBlendMode", parameters: [kCIInputBackgroundImageKey: backdrop])
        case "soft-light":
            return source.applyingFilter("CISoftLightBlendMode", parameters: [kCIInputBackgroundImageKey: backdrop])
        default: throw Self.invalid("Unknown layer blend mode.")
        }
    }

    private func preflightSurfaces(_ frame: Frame) throws -> Set<Frame.Operation> {
        var masks = Set<Frame.Operation>()
        let requiredLuts = Set(frame.visual.flatMap(\.operations).filter { $0.kind == "lut" }.compactMap(\.assetId))
        luts = luts.filter { requiredLuts.contains($0.key) }
        var lutBytes: Int64 = 0
        var seenLuts = Set<String>()
        var intermediatePixels: Int64 = 0
        var overlayPixels: Int64 = 0
        let area = Int64(canvas.width) * Int64(canvas.height)
        for node in frame.visual {
            guard node.operations.count <= 1024 else {
                throw Self.invalid("Picture operation count exceeds execution bounds.")
            }
            var geometry: [Int] = []
            for (index, operation) in node.operations.enumerated() {
                if operation.kind == "pointer" {
                    guard node.target.kind == "clip", let id = node.target.id,
                        let stepId = operation.stepId, !stepId.isEmpty,
                        let trail = operation.trailUs, trail >= 0,
                        trail <= FrameLimits.maximumTrailUs,
                        operation.geometryPrefix == geometry
                    else {
                        throw Self.invalid(
                            "Pointer requires a complete backward geometry prefix and source context."
                        )
                    }
                    if let layer = frame.layers.first(where: { $0.clipId == id }),
                        layer.availability == "available"
                    {
                        guard layer.width.isFinite, layer.height.isFinite, layer.width > 0,
                            layer.height > 0,
                            layer.width <= 8192, layer.height <= 8192
                        else {
                            throw Self.invalid("Pointer source dimensions exceed raster bounds.")
                        }
                        overlayPixels += Int64(layer.width) * Int64(layer.height)
                        for reference in geometry
                        where node.operations[reference].kind == "rasterize" {
                            intermediatePixels += area
                        }
                    }
                } else if operation.kind == "lut" {
                    try LUTColor.requireImplementation(lutImplementationId)
                    let cube = try lut(operation)
                    if seenLuts.insert(operation.assetId!).inserted {
                        lutBytes += Int64(cube.rgba.count * MemoryLayout<Float>.size)
                        try Self.requireBudget("lut-sample-bytes", requested: lutBytes,
                            limit: 16 * 1024 * 1024, frame: frame.index)
                    }
                } else if operation.kind == "sdr-correction" {
                    try SDRCorrection.requireImplementation(sdrCorrectionImplementationId)
                    try operation.correction().validate()
                } else if operation.kind == "motion-blur" {
                    guard let samples = operation.samples, samples >= 1, samples <= 8,
                        let shutter = operation.shutter, shutter.isFinite, shutter >= 0, shutter <= 1
                    else { throw Self.invalid("Invalid bounded motion-blur recipe.") }
                    if samples > 1 && shutter > 0 {
                        intermediatePixels += Int64(samples) * area
                    }
                } else if operation.kind != "opacity" && operation.kind != "blend" {
                    geometry.append(index)
                }
            }
            for operation in node.operations
            where operation.kind == "rasterize" || operation.kind == "coverage" {
                guard operation.width == Double(canvas.width),
                    operation.height == Double(canvas.height)
                else {
                    throw Self.invalid("Compiled picture surface must match the fixed canvas.")
                }
                if operation.kind == "rasterize" {
                    intermediatePixels += area
                } else {
                    masks.insert(operation)
                }
            }
        }
        try Self.requireBudget(
            "pointer-source-pixels", requested: overlayPixels,
            limit: Self.maximumIntermediatePixels, frame: frame.index)
        try Self.requireBudget(
            "intermediate-pixels", requested: intermediatePixels,
            limit: Self.maximumIntermediatePixels, frame: frame.index)
        try Self.requireBudget(
            "coverage-mask-bytes", requested: Int64(masks.count) * area,
            limit: Self.maximumCoverageBytes, frame: frame.index)
        return masks
    }

    func finishPointers() throws { try preparedPointers?.finish() }

    private static func requireBudget(_ kind: String, requested: Int64, limit: Int64, frame: Int64)
        throws
    {
        guard requested <= limit else {
            throw unsupported(
                "h264-rec709 profile limit \(kind): frame \(frame) requests \(requested), bound \(limit); reduce simultaneous sources or processing surfaces."
            )
        }
    }

    private static func clampRect(_ operation: Frame.Operation) throws -> CGRect {
        guard let x = operation.x, let y = operation.y, let width = operation.width,
            let height = operation.height,
            [x, y, width, height].allSatisfy({
                $0.isFinite && abs($0) <= Double(TimeSpan.maximumMicroseconds)
            }), width > 0, height > 0
        else { throw invalid("Invalid sampling clamp primitive.") }
        // Compiled bounds name sample centers; Core Image clamps pixel cells.
        return CGRect(x: x - 0.5, y: y - 0.5, width: width + 1, height: height + 1)
    }

    private static func affine(_ operation: Frame.Operation) throws -> CGAffineTransform {
        guard let m = operation.matrix, m.count == 6,
            m.allSatisfy({ $0.isFinite && abs($0) <= Double(TimeSpan.maximumMicroseconds) })
        else { throw invalid("Invalid affine primitive.") }
        return CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5])
    }

    private func coveragePoints(_ operation: Frame.Operation) throws -> [CGPoint] {
        guard let points = operation.points, points.count == 4,
            points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }),
            operation.width == Double(canvas.width), operation.height == Double(canvas.height)
        else { throw Self.invalid("Invalid polygon coverage primitive.") }
        return points.map { CGPoint(x: $0.x, y: $0.y) }
    }

    /// Source-space visibility and source-to-delivery scale follow the same compiled geometry
    /// as the pixels. A pointer's geometry prefix makes this context independent of step order.
    private struct PointerProjection {
        var visible: [CGPoint]
        var matrix: CGAffineTransform
        var scale: Double {
            let determinant = matrix.a * matrix.d - matrix.b * matrix.c
            let squared = matrix.a * matrix.a + matrix.b * matrix.b + matrix.c * matrix.c + matrix.d * matrix.d
            let maximum = (squared + sqrt(max(0, squared * squared - 4 * determinant * determinant))) / 2
            return maximum > 0 ? abs(determinant) / sqrt(maximum) : 0
        }
        var longEdge: Double {
            let xs = visible.map(\.x), ys = visible.map(\.y)
            return max((xs.max() ?? 0) - (xs.min() ?? 0), (ys.max() ?? 0) - (ys.min() ?? 0))
        }
        static func polygon(_ rect: CGRect) -> [CGPoint] {
            [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
             CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.maxY)]
        }
        mutating func intersect(_ boundary: [CGPoint]) {
            guard boundary.count >= 3 else { visible = []; return }
            let area = boundary.indices.reduce(CGFloat(0)) { sum, index in
                let a = boundary[index], b = boundary[(index + 1) % boundary.count]
                return sum + a.x * b.y - b.x * a.y
            }
            let sign: CGFloat = area >= 0 ? 1 : -1
            for index in boundary.indices {
                let a = boundary[index], b = boundary[(index + 1) % boundary.count]
                func distance(_ p: CGPoint) -> CGFloat {
                    sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))
                }
                let input = visible
                visible = []
                guard var previous = input.last else { return }
                var previousDistance = distance(previous)
                for point in input {
                    let currentDistance = distance(point)
                    if (currentDistance >= 0) != (previousDistance >= 0) {
                        let fraction = previousDistance / (previousDistance - currentDistance)
                        visible.append(CGPoint(x: previous.x + fraction * (point.x - previous.x),
                                               y: previous.y + fraction * (point.y - previous.y)))
                    }
                    if currentDistance >= 0 { visible.append(point) }
                    previous = point
                    previousDistance = currentDistance
                }
            }
        }
    }

    private func pointerProjections(_ prepared: PreparedPicture) throws -> [CompositionProcessing.Target: PointerProjection] {
        guard !prepared.pointerRows.isEmpty else { return [:] }
        let canvasPolygon = PointerProjection.polygon(CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height))
        var contexts: [CompositionProcessing.Target: PointerProjection] = [:]
        var sources: [CompositionProcessing.Target: PointerProjection] = [:]
        guard let last = prepared.key.visual.last else { return sources }
        contexts[last.target] = PointerProjection(visible: canvasPolygon,
            matrix: CGAffineTransform(scaleX: Double(deliveredSize.width) / Double(canvas.width),
                                      y: Double(deliveredSize.height) / Double(canvas.height)))
        for node in prepared.key.visual.reversed() {
            guard var projection = contexts.removeValue(forKey: node.target) else { continue }
            for operation in node.operations.reversed() {
                switch operation.kind {
                case "affine":
                    let matrix = try Self.affine(operation)
                    if matrix.a * matrix.d - matrix.b * matrix.c == 0 {
                        projection.visible = []
                    } else {
                        projection.visible = projection.visible.map { $0.applying(matrix.inverted()) }
                    }
                    projection.matrix = matrix.concatenating(projection.matrix)
                case "clamp": projection.intersect(PointerProjection.polygon(try Self.clampRect(operation)))
                case "coverage": projection.intersect(try coveragePoints(operation))
                default: break
                }
            }
            if node.target.kind == "clip", let source = prepared.surfaces[node.target] {
                projection.intersect(PointerProjection.polygon(source.extent))
                sources[node.target] = projection
            } else {
                // Each parent composites its children into the fixed canvas before its own operations.
                projection.intersect(canvasPolygon)
                for input in node.inputs { contexts[input] = projection }
            }
        }
        return sources
    }

    private func lut(_ operation: Frame.Operation) throws -> CubeLUT {
        guard operation.colorSpace == "linear-srgb", operation.interpolation == "trilinear",
            let assetId = operation.assetId, let binding = lutBindings[assetId] else {
            throw Self.invalid("LUT requires an explicit immutable asset and supported interpretation.")
        }
        if let cube = luts[assetId] { return cube }
        let cube = try CubeLUT.load(binding)
        luts[assetId] = cube
        return cube
    }

    private func apply(_ operation: Frame.Operation, to image: CIImage) throws -> CIImage {
        switch operation.kind {
        case "clamp":
            return image.clamped(to: try Self.clampRect(operation))
        case "coverage":
            let points = try coveragePoints(operation)
            let mask: CIImage
            if let cached = coverageMasks[operation] {
                mask = cached
            } else {
                guard
                    let bitmap = CGContext(
                        data: nil, width: canvas.width, height: canvas.height,
                        bitsPerComponent: 8, bytesPerRow: canvas.width,
                        space: CGColorSpace(name: CGColorSpace.linearGray)!,
                        bitmapInfo: CGImageAlphaInfo.none.rawValue)
                else { throw Self.invalid("Cannot allocate polygon coverage.") }
                bitmap.setShouldAntialias(true)
                bitmap.setFillColor(gray: 1, alpha: 1)
                bitmap.move(to: CGPoint(x: points[0].x, y: points[0].y))
                for point in points.dropFirst() {
                    bitmap.addLine(to: CGPoint(x: point.x, y: point.y))
                }
                bitmap.closePath()
                bitmap.fillPath()
                guard let picture = bitmap.makeImage() else {
                    throw Self.invalid("Cannot rasterize polygon coverage.")
                }
                mask = CIImage(cgImage: picture)
                coverageMasks[operation] = mask
            }
            return image.applyingFilter(
                "CIBlendWithMask",
                parameters: [
                    kCIInputBackgroundImageKey: CIImage(color: .clear), kCIInputMaskImageKey: mask,
                ]
            ).cropped(to: CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height))
        case "rasterize":
            guard let width = operation.width, let height = operation.height,
                !image.extent.isInfinite, image.extent.width <= width, image.extent.height <= height
            else {
                throw Self.unsupported(
                    "Rasterized picture domain exceeds the supported source dimensions.")
            }
            return image.insertingIntermediate(cache: false)
        case "affine":
            let matrix = try Self.affine(operation)
            if matrix.a * matrix.d - matrix.b * matrix.c == 0 { return CIImage.empty() }
            return image.transformed(by: matrix)
        case "lut":
            return try LUTColor.apply(lut(operation), to: image)
        case "sdr-correction":
            return try SDRCorrection.apply(operation.correction(), to: image)
        case "opacity":
            guard let opacity = operation.opacity, opacity.isFinite, opacity >= 0, opacity <= 1
            else {
                throw Self.invalid("Invalid opacity primitive.")
            }
            return image.applyingFilter(
                "CIColorMatrix",
                parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: opacity)])
        case "motion-blur":
            guard let samples = operation.samples, samples >= 1, samples <= 8,
                let shutter = operation.shutter, shutter.isFinite, shutter >= 0, shutter <= 1
            else { throw Self.invalid("Invalid bounded motion-blur recipe.") }
            if samples == 1 || shutter == 0 { return image }
            // Keep the blur envelope proportional to the shutter interval.
            // Sample count is a bounded work budget; it must not change the
            // requested appearance for the same authored trajectory.
            let radius = max(0.25, shutter)
            return image.applyingFilter(
                "CIMotionBlur",
                parameters: [
                    kCIInputRadiusKey: radius,
                    kCIInputAngleKey: 0,
                ])
        default: throw Self.unsupported("Unknown compiled picture primitive.")
        }
    }

    static func requireOpaque(_ buffer: CVPixelBuffer) throws {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else {
            throw invalid("Missing rendered pixels.")
        }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        for y in 0..<CVPixelBufferGetHeight(buffer) {
            try Task.checkCancellation()
            for x in 0..<CVPixelBufferGetWidth(buffer)
            where bytes[y * CVPixelBufferGetBytesPerRow(buffer) + x * 4 + 3] != 255 {
                throw unsupported(
                    "The h264-rec709 profile requires opaque pixels after output processing.")
            }
        }
    }

    private static func background(_ canvas: Canvas) throws -> (image: CIImage, opaque: Bool) {
        guard canvas.background.count == 9, canvas.background.first == "#",
            let rgba = UInt32(canvas.background.dropFirst(), radix: 16)
        else {
            throw invalid("Canvas requires an RGBA background.")
        }
        let image = CIImage(
            color: CIColor(
                red: CGFloat((rgba >> 24) & 255) / 255,
                green: CGFloat((rgba >> 16) & 255) / 255, blue: CGFloat((rgba >> 8) & 255) / 255,
                alpha: CGFloat(rgba & 255) / 255)
        )
        .cropped(to: CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height))
        return (image, rgba & 255 == 255)
    }
    private static func invalid(_ message: String) -> NativeFailure {
        NativeFailure("INVALID_REQUEST", message)
    }
    private static func unsupported(_ message: String) -> NativeFailure {
        NativeFailure("NOT_READY", message)
    }

}
