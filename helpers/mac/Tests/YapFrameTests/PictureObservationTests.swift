import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import YapFrames

func verifyPictureObservations(in parent: URL) throws {
    let directory = parent.appendingPathComponent("picture-observations")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let input = directory.appendingPathComponent("chart.png")
    // Independent authored top-left rows: white, red, yellow, black.
    let rows: [[UInt8]] = [[255, 255, 255, 255], [255, 0, 0, 255],
                           [255, 255, 0, 255], [0, 0, 0, 255]]
    let pixels = Data(rows.flatMap { Array(repeating: $0, count: 4).flatMap { $0 } })
    let provider = CGDataProvider(data: pixels as CFData)!
    let image = CGImage(width: 4, height: 4, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: 16, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let destination = CGImageDestinationCreateWithURL(input as CFURL,
        UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination), "Authored PNG must encode")
    let output = directory.appendingPathComponent("observed.png")
    let body: [String: Any] = [
        "asset": ["assetId": "chart", "streamId": "image:0", "path": input.path],
        "output": output.path, "maxLongEdge": 4,
        "observations": ["darkAtOrBelow": 5, "brightAtOrAbove": 250, "edgeDarkFraction": 0.98, "edgeOpaqueFraction": 1, "regions": [
            ["id": "top", "rect": ["x": 0, "y": 0, "width": 4, "height": 1]],
        ]],
    ]
    let request = try JSONDecoder().decode(SourceImageRenderer.Request.self,
        from: JSONSerialization.data(withJSONObject: body))
    let result = try SourceImageRenderer.write(request)
    let encoded = try JSONEncoder().encode(result)
    try encoded.write(to: directory.appendingPathComponent("observations.json"))
    let report = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    guard let observations = report["observations"] as? [String: Any] else {
        preconditionFailure("Requested observations must be returned from the delivered picture")
    }
    let full = observations["full"] as! [String: Any]
    let luma = full["luma"] as! [String: Any]
    let histogram = luma["histogram"] as! [Int]
    var expected = [Int](repeating: 0, count: 256)
    for bin in [0, 54, 237, 255] { expected[bin] = 4 }
    precondition(histogram == expected,
        "Encoded-sRGB Rec.709 luma bins must equal the independently authored chart")
    precondition(luma["darkFraction"] as! Double == 0.25
        && luma["brightFraction"] as! Double == 0.25,
        "Declared endpoint thresholds must count the actual black and white pixels")
    let regions = observations["regions"] as! [[String: Any]]
    precondition((regions[0]["luma"] as! [String: Any])["mean"] as! Double == 255,
        "Region coordinates must address delivered top-left pixels")
    let controls: [(String, Int, Int, [[UInt8]])] = [
        ("alpha", 3, 1, [[255,255,255,255], [0,0,0,0], [128,0,0,128]]),
        ("rotated", 4, 3, Array(repeating: [255,255,255,255], count: 4)
            + Array(repeating: [255,0,0,255], count: 4) + Array(repeating: [0,0,0,255], count: 4)),
        ("dark", 4, 4, Array(repeating: [0,0,0,255], count: 16)),
        ("border", 4, 4, Array(repeating: [0,0,0,255], count: 4)
            + Array(repeating: [255,255,255,255], count: 8) + Array(repeating: [0,0,0,255], count: 4)),
    ]
    for (name, width, height, values) in controls {
        let source = directory.appendingPathComponent("\(name)-source.png")
        let bytes = Data(values.flatMap { $0 })
        let picture = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: CGDataProvider(data: bytes as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        let writer = CGImageDestinationCreateWithURL(source as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(writer, picture, name == "rotated" ? [kCGImagePropertyOrientation: 6] as CFDictionary : nil)
        precondition(CGImageDestinationFinalize(writer))
        let original = try Data(contentsOf: source)
        let target = directory.appendingPathComponent("\(name).png")
        var body: [String: Any] = ["asset": ["assetId": name, "streamId": "image:0", "path": source.path],
            "output": target.path, "maxLongEdge": 4,
            "observations": ["darkAtOrBelow": 5, "brightAtOrAbove": 250, "edgeDarkFraction": 0.98, "edgeOpaqueFraction": 1,
                "regions": [["id": "outside", "rect": ["x": -10, "y": -10, "width": 2, "height": 2]],
                    ["id": "clipped", "rect": ["x": -1, "y": 0, "width": 2, "height": 1]]]]]
        func render(_ body: [String: Any]) throws -> Data {
            try JSONEncoder().encode(SourceImageRenderer.write(JSONDecoder().decode(SourceImageRenderer.Request.self,
                from: JSONSerialization.data(withJSONObject: body))))
        }
        let receipt = try render(body)
        try receipt.write(to: directory.appendingPathComponent("\(name).json"))
        let result = try JSONSerialization.jsonObject(with: receipt) as! [String: Any]
        let observation = result["observations"] as! [String: Any]
        let full = observation["full"] as! [String: Any], coverage = full["coverage"] as! [String: Any]
        let masks = observation["regions"] as! [[String: Any]]
        precondition(masks[0]["state"] as! String == "unavailable" && masks[0]["reason"] as! String == "outside_raster")
        precondition((masks[1]["coverage"] as! [String: Any])["rasterPixels"] as! Int == 1)
        if name == "rotated" {
            precondition(result["orientation"] as! Int == 6 && observation["width"] as! Int == 3 && observation["height"] as! Int == 4)
            precondition((masks[1]["luma"] as! [String: Any])["mean"] as! Double == 0, "Region must address the upright rotated top-left black pixel")
        }
        if name == "alpha" {
            precondition(coverage["opaquePixels"] as! Int == 1 && coverage["transparentPixels"] as! Int == 1
                && coverage["partialAlphaPixels"] as! Int == 1, "Alpha coverage must remain separate from color operands")
            precondition((full["luma"] as! [String: Any])["mean"] as! Double == 255,
                "Partial alpha is not a dark color observation")
        }
        let bands = observation["edgeBands"] as! [[String: Any]]
        if name == "dark" {
            precondition(bands.count == 4 && bands.allSatisfy { $0["depthPixels"] as! Int == 4 && $0["adjacentMeanLuma"] == nil },
                "A legitimate dark scene has whole-raster candidates with no observed transition")
        }
        if name == "border" {
            precondition(bands.count == 2 && bands.allSatisfy { $0["depthPixels"] as! Int == 1 && $0["adjacentMeanLuma"] as! Double == 255 },
                "Dark edge candidates must retain the measured transition")
        }
        body.removeValue(forKey: "observations")
        let plain = directory.appendingPathComponent("\(name)-plain.png")
        body["output"] = plain.path
        _ = try render(body)
        let plainBytes = try Data(contentsOf: plain), measuredBytes = try Data(contentsOf: target), sourceBytes = try Data(contentsOf: source)
        precondition(plainBytes == measuredBytes, "Read-only observations must not alter encoded pixels")
        precondition(sourceBytes == original, "Original stays readable")
    }
    // Extreme coordinates must refuse instead of overflowing or manufacturing sampled pixels.
    var invalid = body
    invalid["output"] = directory.appendingPathComponent("invalid.png").path
    invalid["observations"] = ["darkAtOrBelow": 5, "brightAtOrAbove": 250, "edgeDarkFraction": 0.98, "edgeOpaqueFraction": 1,
        "regions": [["id": "invalid", "rect": ["x": Int.min, "y": 0, "width": 1, "height": 1]]]]
    do {
        _ = try SourceImageRenderer.write(JSONDecoder().decode(SourceImageRenderer.Request.self,
            from: JSONSerialization.data(withJSONObject: invalid)))
        preconditionFailure("Out-of-contract integer must refuse")
    } catch { precondition(!FileManager.default.fileExists(atPath: invalid["output"] as! String)) }
    print("PASS authored chart, masks, alpha, dark scene, border transition, unchanged PNG and invalid integer refusal")
}
