import CoreGraphics
import Foundation

/// The window evidence attached to a mark. The resolver is supplied by the caller so gesture
/// recognition remains independent of AppKit and ScreenCaptureKit.
public struct MarkWindow: Codable, Equatable, Sendable {
    public let app: String
    public let title: String
    public let bounds: GeometryRect

    public init(app: String, title: String, bounds: GeometryRect) {
        self.app = app
        self.title = title
        self.bounds = bounds
    }
}

public protocol WindowUnderPoint {
    func windowUnderPoint(_ point: CGPoint) -> MarkWindow?
}

public struct MarkPoint: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let hostUs: Int64

    public init(x: Double, y: Double, hostUs: Int64) {
        self.x = x
        self.y = y
        self.hostUs = hostUs
    }
}

public struct MarkSample: Sendable {
    public let hostUs: Int64
    public let shift: Bool
    public let otherModifiers: Bool
    public let point: CGPoint
    public let buttonDown: Bool

    public init(
        hostUs: Int64, shift: Bool, otherModifiers: Bool, point: CGPoint, buttonDown: Bool
    ) {
        self.hostUs = hostUs
        self.shift = shift
        self.otherModifiers = otherModifiers
        self.point = point
        self.buttonDown = buttonDown
    }
}

/// A mouse-down from the global monitor. Its own ⇧ flag decides pin versus click, because a
/// ⇧+click made within one sampler tick of pressing ⇧ has not reached the polled state yet.
public struct MarkPress: Sendable {
    public let hostUs: Int64
    public let point: CGPoint
    public let shift: Bool

    public init(hostUs: Int64, point: CGPoint, shift: Bool) {
        self.hostUs = hostUs
        self.point = point
        self.shift = shift
    }
}

public struct MarkRelease: Sendable {
    public let hostUs: Int64
    public let point: CGPoint

    public init(hostUs: Int64, point: CGPoint) {
        self.hostUs = hostUs
        self.point = point
    }
}

public struct MarkEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case stroke
        case pin
        case click
    }

    public let kind: Kind
    public let pin: Int?
    public let points: [MarkPoint]
    public let window: MarkWindow?

    public init(kind: Kind, pin: Int?, points: [MarkPoint], window: MarkWindow?) {
        self.kind = kind
        self.pin = pin
        self.points = points
        self.window = window
    }
}

/// Pure Q6/P2 gesture recognition. It only classifies caller-provided samples and global mouse
/// monitor edges; the caller owns capture state, journal writes and any drawing.
public struct MarkRecognizer {
    public init(
        windowUnderPoint: any WindowUnderPoint,
        paused: Bool = false,
        hasFirstFrame: Bool = false,
        cameraOnly: Bool = false
    ) {
        self.windowUnderPoint = windowUnderPoint
        self.paused = paused
        self.hasFirstFrame = hasFirstFrame
        self.cameraOnly = cameraOnly
    }

    private let windowUnderPoint: any WindowUnderPoint
    private var stroke: [MarkPoint] = []
    private var strokeTravel: Double = 0
    private var pendingPress: MarkPress?
    private var buttonDown = false
    /// Pin numbers only count up within a take, so a retracted pin's number is never reused.
    private var nextPinNumber = 1

    public var paused: Bool
    public var hasFirstFrame: Bool
    public var cameraOnly: Bool

    /// The stroke while ⇧ is still held, before it is a mark: what the overlay draws under the
    /// pointer. It empties when the stroke ends, recorded or not.
    public var activeStroke: [MarkPoint] { stroke }

    /// Updates the capture facts supplied by the owner. Blocking state clears an in-progress
    /// gesture so evidence from before a pause or source transition cannot leak afterward.
    public mutating func updateCaptureState(
        paused: Bool, hasFirstFrame: Bool, cameraOnly: Bool
    ) {
        self.paused = paused
        self.hasFirstFrame = hasFirstFrame
        self.cameraOnly = cameraOnly
        if blocked {
            clearTransientGesture()
        }
    }

    public mutating func feed(sample: MarkSample) -> [MarkEvent] {
        guard !blocked else {
            clearTransientGesture()
            return []
        }

        if sample.buttonDown {
            buttonDown = true
            return []
        }
        if buttonDown { return [] }

        guard pendingPress == nil, sample.shift, !sample.otherModifiers else {
            return finishStroke()
        }

        if let previous = stroke.last {
            let dx = sample.point.x - previous.x
            let dy = sample.point.y - previous.y
            strokeTravel += (dx * dx + dy * dy).squareRoot()
        }
        stroke.append(MarkPoint(x: sample.point.x, y: sample.point.y, hostUs: sample.hostUs))
        return []
    }

    public mutating func feed(press: MarkPress) -> [MarkEvent] {
        guard !blocked else {
            clearTransientGesture()
            return []
        }

        buttonDown = false
        var events = finishStroke()
        if press.shift {
            let pin = nextPinNumber
            nextPinNumber += 1
            events.append(
                MarkEvent(
                    kind: .pin, pin: pin,
                    points: [MarkPoint(x: press.point.x, y: press.point.y, hostUs: press.hostUs)],
                    window: windowUnderPoint.windowUnderPoint(press.point)))
        } else {
            pendingPress = press
        }
        return events
    }

    public mutating func feed(release: MarkRelease) -> [MarkEvent] {
        guard !blocked else {
            clearTransientGesture()
            return []
        }
        buttonDown = false
        guard let press = pendingPress else { return [] }
        pendingPress = nil
        return [
            MarkEvent(
                kind: .click, pin: nil,
                points: [MarkPoint(x: press.point.x, y: press.point.y, hostUs: press.hostUs)],
                window: windowUnderPoint.windowUnderPoint(press.point))
        ]
    }

    private var blocked: Bool { paused || !hasFirstFrame || cameraOnly }

    private mutating func finishStroke() -> [MarkEvent] {
        guard !stroke.isEmpty else { return [] }
        defer { stroke.removeAll(keepingCapacity: true) }
        defer { strokeTravel = 0 }
        guard let first = stroke.first else { return [] }
        guard strokeTravel >= 8 else { return [] }
        return [
            MarkEvent(
                kind: .stroke, pin: nil, points: stroke,
                window: windowUnderPoint.windowUnderPoint(CGPoint(x: first.x, y: first.y)))
        ]
    }

    private mutating func clearTransientGesture() {
        stroke.removeAll(keepingCapacity: true)
        strokeTravel = 0
        pendingPress = nil
        buttonDown = false
    }
}
