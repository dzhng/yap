import CoreImage
import Foundation
import YapMedia

/// Source-neutral correction in the picture executor's extended-linear-sRGB/RGBAh context.
public enum SDRCorrection {
  public struct Parameters: Codable, Hashable, Sendable {
    var exposureEV: Double
    var contrast: Double
    var saturation: Double
    var shadows: Double
    var highlights: Double
    var neutralKelvin: Double
    var neutralTint: Double
    func validate() throws {
      guard exposureEV.isFinite, (-8...8).contains(exposureEV),
        contrast.isFinite, (0...2).contains(contrast),
        saturation.isFinite, (0...2).contains(saturation),
        shadows.isFinite, (0...1).contains(shadows),
        highlights.isFinite, (0...1).contains(highlights),
        neutralKelvin.isFinite, (2000...10000).contains(neutralKelvin),
        neutralTint.isFinite, (-100...100).contains(neutralTint)
      else { throw NativeFailure("INVALID_REQUEST", "Invalid static SDR correction parameters.") }
    }
  }
  public static var implementationId: String? {
    guard
      ["CITemperatureAndTint", "CIExposureAdjust", "CIColorControls", "CIHighlightShadowAdjust"].allSatisfy({
        CIFilter(name: $0) != nil
      })
    else { return nil }
    return "coreimage-sdr-source-neutral-recovery-v2:" + ProcessInfo.processInfo.operatingSystemVersionString
  }
  static func requireImplementation(_ identity: String?) throws {
    guard let identity else {
        throw NativeFailure("INTERNAL_ERROR", "The compiled plan has no bound implementation.")
    }
    guard identity == implementationId else {
      throw NativeFailure("PINNED_IMPLEMENTATION_UNAVAILABLE", "The bound native SDR correction recipe is unavailable.")
    }
  }
  static func apply(_ parameters: Parameters, to image: CIImage) throws -> CIImage {
    try parameters.validate()
    var result = image
    if parameters.neutralKelvin != 6500 || parameters.neutralTint != 0 {
      result = result.applyingFilter(
        "CITemperatureAndTint",
        parameters: [
          "inputNeutral": CIVector(x: parameters.neutralKelvin, y: parameters.neutralTint),
          "inputTargetNeutral": CIVector(x: 6500, y: 0),
        ])
    }
    if parameters.exposureEV != 0 {
      result = result.applyingFilter(
        "CIExposureAdjust", parameters: [kCIInputEVKey: parameters.exposureEV])
    }
    if parameters.contrast != 1 || parameters.saturation != 1 {
      result = result.applyingFilter(
        "CIColorControls",
        parameters: [
          kCIInputContrastKey: parameters.contrast, kCIInputSaturationKey: parameters.saturation,
          kCIInputBrightnessKey: 0,
        ])
    }
    if parameters.shadows != 0 || parameters.highlights != 0 {
      result = result.applyingFilter(
        "CIHighlightShadowAdjust",
        parameters: [
          "inputShadowAmount": parameters.shadows,
          "inputHighlightAmount": 1 - parameters.highlights,
        ])
    }
    return result
  }
}
