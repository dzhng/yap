import AVFoundation
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
@testable import YapFrames
import YapMedia

private func compositionPNGRequest(source: URL, output: URL, translation: Int = 0) throws
    -> CompositionFrameRenderer.Request
{
    let clip: [String: Any] = ["kind": "clip", "id": "c"]
    let operations: [[String: Any]] = [
        ["kind": "clamp", "x": 0.5, "y": 0.5, "width": 319, "height": 239],
        ["kind": "affine", "matrix": [1, 0, 0, 1, translation, 0]],
        ["kind": "coverage", "width": 320, "height": 240,
         "points": [["x": translation, "y": 0], ["x": 320 + translation, "y": 0],
                    ["x": 320 + translation, "y": 240], ["x": translation, "y": 240]]],
    ]
    let layer: [String: Any] = [
        "kind": "image", "clipId": "c", "trackId": "t", "assetId": "a", "streamId": "image:0",
        "availability": "available", "width": 320, "height": 240,
    ]
    let visual: [[String: Any]] = [
        ["target": clip, "inputs": [], "operations": operations],
        ["target": ["kind": "output"], "inputs": [clip], "operations": []],
    ]
    let frame: [String: Any] = [
        "index": 0, "sampleAtUs": 0, "visibleRange": ["startUs": 0, "endUs": 33333],
        "layers": [layer], "visual": visual,
    ]
    let body: [String: Any] = [
        "output": output.path, "profile": "h264-rec709", "processing": [], "frame": frame,
        "canvas": ["width": 320, "height": 240, "fps": ["numerator": 30, "denominator": 1], "background": "#000000ff"],
        "assets": [["assetId": "a", "streamId": "image:0", "path": source.path, "originUs": 0]],
        "maxLongEdge": 320,
    ]
    return try JSONDecoder().decode(CompositionFrameRenderer.Request.self,
        from: JSONSerialization.data(withJSONObject: body))
}

func verifyCompositionPNG(in directory: URL) async throws {
    let source = directory.appendingPathComponent("composition-source.png")
    try FixtureFrame.referencePNG(index: 7, atUs: 0, width: 320, height: 240).write(to: source)
    let output = directory.appendingPathComponent("composition-identity.png")
    let request = try compositionPNGRequest(source: source, output: output)
    let result = try await CompositionFrameRenderer.write(request)
    let actual = try FixtureImage(contentsOf: output)
    let expected = try FixtureImage(contentsOf: source)
    precondition(actual.hasSamePixels(as: expected),
        "Compiled identity PNG must preserve every source RGBA sample")
    precondition(result.width == 320 && result.height == 240 && result.decodedImages == 1
        && result.decodedSamples == 0 && result.readerOpens == 1)
    precondition(result.pictures[0].kind == "image" && result.pictures[0].status == "available"
        && result.pictures[0].assetId == "a" && result.pictures[0].sample == nil)
    let translated = directory.appendingPathComponent("composition-translated.png")
    _ = try await CompositionFrameRenderer.write(compositionPNGRequest(source: source, output: translated, translation: 40))
    let translatedImage = try FixtureImage(contentsOf: translated)
    let exposed = translatedImage.color(x: 10, y: 10, width: 1, height: 1)
    precondition(exposed.red == 0 && exposed.green == 0 && exposed.blue == 0,
        "Compiled PNG geometry must expose canvas rather than bypass the graph")
    precondition(!translatedImage.hasSamePixels(as: expected))
    print("PASS compiled identity PNG preserves every asymmetric fixture RGBA sample and source receipt")
}

/// An ImageIO source carries the same CoreMedia709 profile as an actual decoded video picture.
/// Encoding the untouched ramp preserves that input profile before either public renderer runs.
func verifyCompositionSourceColors(in directory: URL) async throws {
    let color = CVImageBufferCreateColorSpaceFromAttachments([
        kCVImageBufferColorPrimariesKey as String: kCVImageBufferColorPrimaries_ITU_R_709_2,
        kCVImageBufferTransferFunctionKey as String: kCVImageBufferTransferFunction_ITU_R_709_2,
        kCVImageBufferYCbCrMatrixKey as String: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
    ] as CFDictionary)!.takeRetainedValue()
    var rgba = Data(capacity: 320 * 240 * 4)
    for y in 0..<240 {
        for x in 0..<320 {
            rgba.append(contentsOf: [UInt8(x % 256), UInt8(y), UInt8((x * 17 + y * 31) % 256), 255])
        }
    }
    let image = CGImage(width: 320, height: 240, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: 320 * 4, space: color, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: CGDataProvider(data: rgba as CFData)!, decode: nil, shouldInterpolate: false,
        intent: .defaultIntent)!
    let source = directory.appendingPathComponent("composition-coremedia709-source.png")
    try encodePNG(image).write(to: source)
    let raw = directory.appendingPathComponent("composition-coremedia709-raw.png")
    let rawRequest = try JSONDecoder().decode(SourceImageRenderer.Request.self,
        from: JSONSerialization.data(withJSONObject: [
            "asset": ["assetId": "a", "streamId": "image:0", "path": source.path],
            "output": raw.path, "maxLongEdge": 320,
        ]))
    _ = try SourceImageRenderer.write(rawRequest)
    let output = directory.appendingPathComponent("composition-coremedia709.png")
    let result = try await CompositionFrameRenderer.write(compositionPNGRequest(source: source, output: output))
    let actual = try FixtureImage(contentsOf: output)
    let expected = try FixtureImage(contentsOf: raw)
    precondition(actual.hasSamePixels(as: expected),
        "Compiled media PNG must preserve every canonical source-picture RGBA sample")
    precondition(result.pictures[0].kind == "image" && result.pictures[0].status == "available"
        && result.pictures[0].sample == nil && result.decodedImages == 1 && result.decodedSamples == 0)
    print("PASS CoreMedia709 source and composition PNG have equal complete RGBA pixels")
}

private func blendPNGRequest(
    red: URL, blue: URL, output: URL, mode: String
) throws -> CompositionFrameRenderer.Request {
    let redClip: [String: Any] = ["kind": "clip", "id": "red"]
    let blueClip: [String: Any] = ["kind": "clip", "id": "blue"]
    func layer(_ clipId: String, _ assetId: String) -> [String: Any] {
        [
            "kind": "image", "clipId": clipId, "trackId": clipId, "assetId": assetId,
            "streamId": "image:0", "availability": "available", "width": 16, "height": 16,
        ]
    }
    let frame: [String: Any] = [
        "index": 0, "sampleAtUs": 0, "visibleRange": ["startUs": 0, "endUs": 33333],
        "layers": [layer("red", "red"), layer("blue", "blue")],
        "visual": [
            ["target": redClip, "inputs": [], "operations": []],
            ["target": blueClip, "inputs": [], "operations": [["kind": "blend", "mode": mode]]],
            ["target": ["kind": "output"], "inputs": [redClip, blueClip], "operations": []],
        ],
    ]
    let body: [String: Any] = [
        "output": output.path, "profile": "h264-rec709", "processing": [], "frame": frame,
        "canvas": ["width": 16, "height": 16, "fps": ["numerator": 30, "denominator": 1], "background": "#000000ff"],
        "assets": [
            ["assetId": "red", "streamId": "image:0", "path": red.path, "originUs": 0],
            ["assetId": "blue", "streamId": "image:0", "path": blue.path, "originUs": 0],
        ],
        "maxLongEdge": 16,
    ]
    return try JSONDecoder().decode(CompositionFrameRenderer.Request.self,
        from: JSONSerialization.data(withJSONObject: body))
}

func verifyCompositionBlends(in directory: URL) async throws {
    func solid(_ red: UInt8, _ green: UInt8, _ blue: UInt8, at url: URL) throws {
        let pixels = Data(repeating: 0, count: 16 * 16 * 4).enumerated().map { index, _ in
            switch index % 4 { case 0: return red; case 1: return green; case 2: return blue; default: return 255 }
        }
        let image = CGImage(width: 16, height: 16, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: 16 * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
            provider: CGDataProvider(data: Data(pixels) as CFData)!, decode: nil,
            shouldInterpolate: false, intent: .defaultIntent)!
        try encodePNG(image).write(to: url)
    }
    let red = directory.appendingPathComponent("blend-red.png")
    let blue = directory.appendingPathComponent("blend-blue.png")
    try solid(255, 0, 0, at: red)
    try solid(0, 0, 255, at: blue)
    var samples: [String: (red: Double, green: Double, blue: Double)] = [:]
    for mode in ["multiply", "screen", "soft-light"] {
        let output = directory.appendingPathComponent("blend-" + mode + ".png")
        _ = try await CompositionFrameRenderer.write(
            try blendPNGRequest(red: red, blue: blue, output: output, mode: mode))
        samples[mode] = try FixtureImage(contentsOf: output).color(x: 4, y: 4, width: 8, height: 8)
    }
    let multiply = samples["multiply"]!, screen = samples["screen"]!, softLight = samples["soft-light"]!
    precondition(multiply.red < 0.05 && multiply.green < 0.05 && multiply.blue < 0.05,
        "Multiply must combine red and blue to black")
    precondition(screen.red > 0.9 && screen.green < 0.05 && screen.blue > 0.9,
        "Screen must combine red and blue to magenta")
    precondition(softLight.red > 0.9 && softLight.green < 0.05 && softLight.blue < 0.05,
        "Soft-light must preserve its bounded source-dependent response")
    print("PASS native multiply, screen and soft-light layer combinations match swatch expectations")
}

func verifyCompositionMovieTerminal(in directory: URL) async throws {
    let source = directory.appendingPathComponent("composition-source.png")
    let request = try compositionPNGRequest(source: source, output: directory.appendingPathComponent("unused.png"))
    let executor = try CompositionPictureExecutor(canvas: request.canvas, deliveredSize: (request.canvas.width, request.canvas.height), bindings: request.assets)
    var allocations = 0
    func allocate(_ retained: CVPixelBuffer?) async throws -> CVPixelBuffer {
        if let retained { return retained }
        allocations += 1
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 320, 240, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &buffer) == kCVReturnSuccess)
        return buffer!
    }
    let first = try await executor.render(request.frame, allocate: allocate)
    let heldFrame = CompositionPictureExecutor.Frame(index: 1, sampleAtUs: 33333,
        visibleRange: TimeSpan(startUs: 33333, endUs: 66666),
        layers: request.frame.layers, visual: request.frame.visual)
    let held = try await executor.render(heldFrame, allocate: allocate)
    precondition(first === held && allocations == 1 && executor.rasterized == 1)
    precondition(executor.decodedImages == 1 && executor.opens == 1 && executor.outputIsKnownOpaque)
    precondition(CVPixelBufferGetPixelFormatType(first) == kCVPixelFormatType_32BGRA)
    let attachments = CVBufferCopyAttachments(first, .shouldPropagate) as! [String: Any]
    precondition(attachments[kCVImageBufferColorPrimariesKey as String] as? String == "ITU_R_709_2")
    precondition(attachments[kCVImageBufferTransferFunctionKey as String] as? String == "ITU_R_709_2")
    precondition(attachments[kCVImageBufferYCbCrMatrixKey as String] as? String == "ITU_R_709_2")
    let color = attachments[kCVImageBufferCGColorSpaceKey as String] as! CGColorSpace
    precondition(color.name.map { $0 as String } == executor.color.name.map { $0 as String })
    let changed = try compositionPNGRequest(source: source, output: directory.appendingPathComponent("unused-shifted.png"), translation: 40)
    let changedFrame = CompositionPictureExecutor.Frame(index: 2, sampleAtUs: 66666,
        visibleRange: TimeSpan(startUs: 66666, endUs: 99999),
        layers: changed.frame.layers, visual: changed.frame.visual)
    let shifted = try await executor.render(changedFrame, allocate: allocate)
    precondition(shifted !== first && allocations == 2 && executor.rasterized == 2)
    precondition(executor.decodedImages == 1 && executor.opens == 1)
    CVPixelBufferLockBaseAddress(shifted, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(shifted, .readOnly) }
    let pixels = CVPixelBufferGetBaseAddress(shifted)!.assumingMemoryBound(to: UInt8.self)
    let offset = 10 * CVPixelBufferGetBytesPerRow(shifted) + 10 * 4
    precondition(Array(UnsafeBufferPointer(start: pixels + offset, count: 4)) == [0, 0, 0, 255],
        "Translated graph must expose opaque canvas, rather than reuse held pixels")
    try executor.finishPointers()
    print("PASS movie terminal retains held buffer/allocation and Rec.709 attachments; geometry invalidates held pixels")
}

func verifyCompositionMovieDownscale(in directory: URL) async throws {
    let source = directory.appendingPathComponent("composition-quadrants.png")
    var pixels = Data(count: 320 * 240 * 4)
    pixels.withUnsafeMutableBytes { bytes in
        let values = bytes.bindMemory(to: UInt8.self)
        for y in 0..<240 {
            for x in 0..<320 {
                let top = y < 120, left = x < 160
                let color: (UInt8, UInt8, UInt8) =
                    top && left ? (255, 0, 0) : top ? (0, 255, 0) : left ? (0, 0, 255) : (255, 255, 0)
                let offset = (y * 320 + x) * 4
                values[offset] = color.0
                values[offset + 1] = color.1
                values[offset + 2] = color.2
                values[offset + 3] = 255
            }
        }
    }
    let image = CGImage(width: 320, height: 240, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: 320 * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: CGDataProvider(data: pixels as CFData)!, decode: nil,
        shouldInterpolate: false, intent: .defaultIntent)!
    try encodePNG(image).write(to: source)
    let request = try compositionPNGRequest(source: source,
        output: directory.appendingPathComponent("unused-downscale.png"))
    let executor = try CompositionPictureExecutor(
        canvas: request.canvas, deliveredSize: (160, 120), bindings: request.assets)
    var buffer: CVPixelBuffer?
    precondition(CVPixelBufferCreate(nil, 160, 120, kCVPixelFormatType_32BGRA,
        [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &buffer) == kCVReturnSuccess)
    let rendered = try await executor.render(request.frame) { retained in
        precondition(retained == nil)
        return buffer!
    }
    CVPixelBufferLockBaseAddress(rendered, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(rendered, .readOnly) }
    let bytes = CVPixelBufferGetBaseAddress(rendered)!.assumingMemoryBound(to: UInt8.self)
    func color(x: Int, y: Int) -> [UInt8] {
        let offset = y * CVPixelBufferGetBytesPerRow(rendered) + x * 4
        return Array(UnsafeBufferPointer(start: bytes + offset, count: 4))
    }
    let samples = [color(x: 20, y: 20), color(x: 140, y: 20), color(x: 20, y: 100), color(x: 140, y: 100)]
    precondition(samples == [[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [0, 255, 255, 255]],
        "Downscaled quadrants changed orientation or scale: \(samples)")
    if ProcessInfo.processInfo.environment["YAP_FRAME_EVIDENCE"] != nil {
        let context = CIContext()
        let image = CIImage(cvPixelBuffer: rendered)
        guard let preview = context.createCGImage(
            image, from: CGRect(x: 0, y: 0, width: 160, height: 120)) else {
            preconditionFailure("Could not capture the downscaled composition fixture")
        }
        try encodePNG(preview).write(to: directory.appendingPathComponent("preview-candidate.png"))
    }
    print("PASS downscaled movie frames preserve the complete composition canvas")
}
