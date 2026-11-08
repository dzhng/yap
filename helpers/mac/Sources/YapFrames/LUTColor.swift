import CoreImage
import Foundation
import YapMedia

/// Unit-grid trilinear cube with edge-linear extrapolation in unpremultiplied linear-sRGB; the cube never authors alpha.
public enum LUTColor {
    private static let kernel = CIKernel(source: """
        vec3 lookup(sampler cube, vec3 p, float n) {
            return sample(cube, vec2(p.x + 0.5, p.y + p.z * n + 0.5)).rgb;
        }
        kernel vec4 trilinearLUT(sampler source, sampler cube, float n) {
            vec4 pixel = unpremultiply(sample(source, samplerCoord(source)));
            vec3 p = pixel.rgb * (n - 1.0);
            vec3 lo = clamp(floor(p), 0.0, n - 2.0), hi = lo + 1.0, t = p - lo;
            vec3 a = mix(lookup(cube, lo, n), lookup(cube, vec3(hi.x, lo.y, lo.z), n), t.x);
            vec3 b = mix(lookup(cube, vec3(lo.x, hi.y, lo.z), n), lookup(cube, vec3(hi.x, hi.y, lo.z), n), t.x);
            vec3 c = mix(lookup(cube, vec3(lo.x, lo.y, hi.z), n), lookup(cube, vec3(hi.x, lo.y, hi.z), n), t.x);
            vec3 d = mix(lookup(cube, vec3(lo.x, hi.y, hi.z), n), lookup(cube, hi, n), t.x);
            return premultiply(vec4(mix(mix(a,b,t.y), mix(c,d,t.y), t.z), pixel.a));
        }
        """)
    public static var implementationId: String? {
        guard kernel != nil else { return nil }
        return "coreimage-unit-linear-srgb-cube-trilinear-v1:" + ProcessInfo.processInfo.operatingSystemVersionString
    }
    static func requireImplementation(_ identity: String?) throws {
        guard let identity else {
            throw NativeFailure("INTERNAL_ERROR", "The compiled plan has no bound implementation.")
        }
        guard identity == implementationId else {
            throw NativeFailure("PINNED_IMPLEMENTATION_UNAVAILABLE", "The bound native LUT recipe is unavailable.")
        }
    }
    public static func apply(_ cube: CubeLUT, to image: CIImage) throws -> CIImage {
        guard let kernel else { throw NativeFailure("PREREQUISITE_MISSING", "The native LUT recipe is unavailable.") }
        if cube.isIdentity { return image }
        let size = cube.metadata.size
        let bytes = cube.rgba.withUnsafeBytes { Data($0) }
        let samples = CIImage(bitmapData: bytes, bytesPerRow: size * 16,
            size: CGSize(width: size, height: size * size), format: .RGBAf, colorSpace: nil)
        let sampler = CISampler(image: samples, options: [kCISamplerFilterMode: kCISamplerFilterNearest])
        guard let output = kernel.apply(extent: image.extent,
            roiCallback: { index, rect in index == 0 ? rect : samples.extent },
            arguments: [image, sampler, Float(size)]) else {
            throw NativeFailure("INVALID_REQUEST", "Native LUT application failed.")
        }
        return output
    }
}
