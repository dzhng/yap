import CoreGraphics
import CoreImage
import Foundation
import YapMedia

@testable import YapFrames

func verifySDRCorrection(in directory: URL) async throws {
  let missingTone: [String: Any] = [
    "kind": "sdr-correction", "exposureEV": 0, "contrast": 1, "saturation": 1,
    "neutralKelvin": 6500, "neutralTint": 0,
  ]
  let incomplete = try JSONDecoder().decode(CompositionPictureExecutor.Frame.Operation.self,
    from: JSONSerialization.data(withJSONObject: missingTone))
  do {
    _ = try incomplete.correction()
    preconditionFailure("Incomplete correction must not acquire implicit tone defaults")
  } catch let error as NativeFailure { precondition(error.code == "INVALID_REQUEST") }
  let linear = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
  let context = CIContext(options: [
    .workingColorSpace: linear, .workingFormat: CIFormat.RGBAh.rawValue,
  ])
  let source: [Float] = [0.1, 0.2, 0.3, 1, 0.05, 0.1, 0.15, 0.5, 0, 0, 0, 0, -0.1, 1.2, 0.5, 1]
  let image = CIImage(
    bitmapData: source.withUnsafeBytes { Data($0) }, bytesPerRow: 64,
    size: CGSize(width: 4, height: 1), format: .RGBAf, colorSpace: linear)
  func pixels(_ value: CIImage) -> [Float] {
    var out = [Float](repeating: 0, count: source.count)
    out.withUnsafeMutableBytes {
      context.render(
        value, toBitmap: $0.baseAddress!, rowBytes: 64,
        bounds: image.extent, format: .RGBAf, colorSpace: linear)
    }
    return out
  }
  let identity = SDRCorrection.Parameters(
    exposureEV: 0, contrast: 1, saturation: 1, shadows: 0, highlights: 0,
    neutralKelvin: 6500, neutralTint: 0)
  let unchanged = try SDRCorrection.apply(identity, to: image)
  precondition(pixels(unchanged) == pixels(image))
  var shadowsOnly = identity
  shadowsOnly.shadows = 0.5
  let independentShadows = image.applyingFilter(
    "CIHighlightShadowAdjust",
    parameters: ["inputShadowAmount": 0.5, "inputHighlightAmount": 1.0])
  let shadowsResult = pixels(try SDRCorrection.apply(shadowsOnly, to: image))
  precondition(
    shadowsResult == pixels(independentShadows),
    "Shadow recovery must not implicitly enable highlight recovery")
  var previous = pixels(image)
  for amount in [0.25, 0.5, 1.0] {
    var config = identity
    config.highlights = amount
    let actual = pixels(try SDRCorrection.apply(config, to: image))
    let independent = image.applyingFilter(
      "CIHighlightShadowAdjust",
      parameters: ["inputShadowAmount": 0.0, "inputHighlightAmount": 1 - amount])
    precondition(actual == pixels(independent), "Highlight recovery amount has reversed provider meaning")
    for i in 0..<3 {
      precondition(actual[i] <= previous[i] + 0.00001, "More recovery must not brighten highlights")
    }
    for i in stride(from: 3, to: actual.count, by: 4) {
      precondition(actual[i] == source[i], "Tone correction must preserve alpha")
    }
    previous = actual
  }
  for ev in [-1.0, 1.0] {
    var config = identity
    config.exposureEV = ev
    let actual = pixels(try SDRCorrection.apply(config, to: image))
    for i in actual.indices {
      let expected = i % 4 == 3 ? source[i] : source[i] * Float(pow(2, ev))
      precondition(
        abs(actual[i] - expected) < 0.002,
        "SDR exposure must preserve numeric/alpha/extended behavior")
    }
  }
  for contrast in [0.8, 1.2] {
    var config = identity
    config.contrast = contrast
    let actual = pixels(try SDRCorrection.apply(config, to: image))
    for i in actual.indices {
      let alpha = source[(i / 4) * 4 + 3]
      let expected = i % 4 == 3 ? alpha : (source[i] - alpha * 0.5) * Float(contrast) + alpha * 0.5
      precondition(abs(actual[i] - expected) < 0.002)
    }
  }
  for saturation in [0.0, 1.5] {
    var config = identity
    config.saturation = saturation
    let actual = pixels(try SDRCorrection.apply(config, to: image))
    for i in actual.indices {
      let start = (i / 4) * 4
      let luma = source[start] * 0.2125 + source[start + 1] * 0.7154 + source[start + 2] * 0.0721
      let expected = i % 4 == 3 ? source[i] : luma + (source[i] - luma) * Float(saturation)
      precondition(abs(actual[i] - expected) < 0.002)
    }
  }
  let combined = SDRCorrection.Parameters(
    exposureEV: 0.5, contrast: 1.15, saturation: 0.7, shadows: 0, highlights: 0,
    neutralKelvin: 5000, neutralTint: 10)
  let white = image.applyingFilter(
    "CITemperatureAndTint",
    parameters: [
      "inputNeutral": CIVector(x: 5000, y: 10), "inputTargetNeutral": CIVector(x: 6500, y: 0),
    ])
  let expected = white.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: 0.5])
    .applyingFilter(
      "CIColorControls",
      parameters: [kCIInputContrastKey: 1.15, kCIInputSaturationKey: 0.7, kCIInputBrightnessKey: 0])
  let actual = pixels(try SDRCorrection.apply(combined, to: image))
  precondition(
    actual == pixels(expected), "Production must preserve the frozen combined recipe exactly")
  precondition(actual[12] < 0 || actual[13] > 1, "No early gamut clamp")
  for i in 8..<12 { precondition(actual[i] == 0, "Transparent black remains zero") }
  for i in 0..<3 { precondition(abs(actual[i + 4] - actual[i] * 0.5) < 0.002) }
  do {
    try SDRCorrection.requireImplementation("other-host")
    preconditionFailure("Wrong native recipe admitted")
  } catch let error as NativeFailure { precondition(error.code == "PINNED_IMPLEMENTATION_UNAVAILABLE") }
  var invalid = identity
  invalid.exposureEV = 9
  do {
    _ = try SDRCorrection.apply(invalid, to: image)
    preconditionFailure("Out-of-range correction admitted")
  } catch let error as NativeFailure { precondition(error.code == "INVALID_REQUEST") }
  print(
    "PASS SDR production recipe numeric controls, frozen order, identity, alpha, extension, bounds and recipe refusal"
  )
}
