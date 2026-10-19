import CoreGraphics
import Foundation
import Vision
import YapMedia

/// Requests all faces in the delivered, upright picture. Detection is evidence only.
public struct FaceObservationRequest: Codable, Sendable, Equatable {
    let recipe: String

    func validate() throws {
        guard recipe == "vision-face-rectangles-v1" else {
            throw NativeFailure("INVALID_REQUEST", "Unknown face observation recipe.")
        }
    }
}

public struct FaceObservations: Encodable {
    struct Face: Encodable {
        let id: String
        let boundingBox: Box
        let confidence: Double
        // Landmark coverage is quality evidence for the caller. `core` means the
        // detector returned the core landmark groups; it is not a complete-head
        // guarantee and must not authorize an automatic crop by itself.
        let landmarkCoverage: String
        let landmarkGroups: [String]
    }
    struct Box: Encodable {
        let x: Int
        let y: Int
        let width: Int
        let height: Int
    }
    let recipe = "vision-face-rectangles-v1"
    let implementationId: String
    let coordinateSpace = "delivered-top-left-pixels"
    let width: Int
    let height: Int
    let status: String
    let faces: [Face]
    let reason: String?

    static func detect(_ image: CGImage, request: FaceObservationRequest) throws -> Self {
        try request.validate()
        let width = image.width, height = image.height
        guard width > 0, height > 0, width <= 8192, height <= 8192 else {
            throw NativeFailure("INVALID_RESPONSE", "Delivered picture has invalid face-observation dimensions.")
        }
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        let request = VNDetectFaceRectanglesRequest()
        var implementationId = "vision-face-rectangles-v1:revision-\(request.revision):"
            + ProcessInfo.processInfo.operatingSystemVersionString
        func result(status: String, faces: [Face], reason: String?) -> Self {
            Self(implementationId: implementationId, width: width, height: height,
                status: status, faces: faces, reason: reason)
        }
        do {
            try handler.perform([request])
        } catch {
            return result(status: "error", faces: [], reason: String(String(describing: error).prefix(4096)))
        }
        let results = request.results ?? []
        guard results.count <= 64 else {
            return result(status: "error", faces: [], reason: "face_count_exceeds_limit")
        }
        for observation in results {
            let confidence = Double(observation.confidence)
            guard confidence.isFinite, (0...1).contains(confidence) else {
                return result(status: "error", faces: [], reason: "invalid_face_confidence")
            }
        }

        // Run landmarks against the exact rectangles we are publishing. A
        // landmark failure leaves rectangle evidence available and marks its
        // quality as unavailable; it never expands a detector box to make the
        // frozen full-face oracle pass.
        let landmarkRequest = VNDetectFaceLandmarksRequest()
        landmarkRequest.inputFaceObservations = results
        var landmarkResults: [VNFaceObservation] = []
        if (try? handler.perform([landmarkRequest])) != nil {
            landmarkResults = landmarkRequest.results ?? []
        }
        implementationId += ":landmarks-revision-\(landmarkRequest.revision)"
        func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
            let intersection = a.intersection(b)
            guard !intersection.isNull, intersection.width > 0, intersection.height > 0 else { return 0 }
            let area = a.width * a.height + b.width * b.height - intersection.width * intersection.height
            return area > 0 ? (intersection.width * intersection.height) / area : 0
        }
        func coverage(for rectangle: VNFaceObservation) -> (String, [String]) {
            guard let landmarks = landmarkResults.max(by: {
                overlap($0.boundingBox, rectangle.boundingBox) < overlap($1.boundingBox, rectangle.boundingBox)
            }), overlap(landmarks.boundingBox, rectangle.boundingBox) >= 0.5,
            let face = landmarks.landmarks else {
                return ("unavailable", [])
            }
            let groups: [(String, VNFaceLandmarkRegion2D?)] = [
                ("face_contour", face.faceContour),
                ("left_eye", face.leftEye),
                ("right_eye", face.rightEye),
                ("left_eyebrow", face.leftEyebrow),
                ("right_eyebrow", face.rightEyebrow),
                ("nose", face.nose),
                ("nose_crest", face.noseCrest),
                ("median_line", face.medianLine),
                ("outer_lips", face.outerLips),
                ("inner_lips", face.innerLips),
                ("left_pupil", face.leftPupil),
                ("right_pupil", face.rightPupil),
            ].compactMap { name, region in
                guard let region, region.pointCount > 0 else { return nil }
                return (name, region)
            }
            let names = groups.map(\.0)
            let core = ["face_contour", "left_eye", "right_eye", "nose", "outer_lips"].allSatisfy(names.contains)
            return (core ? "core" : (names.isEmpty ? "unavailable" : "partial"), names)
        }
        let faces: [Face] = results.sorted {
            if $0.boundingBox.minX != $1.boundingBox.minX { return $0.boundingBox.minX < $1.boundingBox.minX }
            return $0.boundingBox.minY > $1.boundingBox.minY
        }.enumerated().compactMap { index, observation -> Face? in
            let box = observation.boundingBox
            let x = max(0, min(width, Int((box.minX * Double(width)).rounded(.down))))
            let y = max(0, min(height, Int(((1 - box.maxY) * Double(height)).rounded(.down))))
            let right = max(x, min(width, Int((box.maxX * Double(width)).rounded(.up))))
            let bottom = max(y, min(height, Int(((1 - box.minY) * Double(height)).rounded(.up))))
            guard right > x, bottom > y else { return nil }
            let landmark = coverage(for: observation)
            return Face(id: "face-\(index)", boundingBox: Box(x: x, y: y, width: right - x, height: bottom - y), confidence: Double(observation.confidence), landmarkCoverage: landmark.0, landmarkGroups: landmark.1)
        }
        return result(status: faces.isEmpty ? "no_face" : "available", faces: faces, reason: faces.isEmpty ? "no_face" : nil)
    }
}
