import Foundation

public struct JournalMarkPoint: Codable, Sendable, Equatable {
    public let hostUs: Int64
    public let globalX: Double
    public let globalY: Double
    public let x: Double?
    public let y: Double?
    public init(globalX: Double, globalY: Double, x: Double?, y: Double?, hostUs: Int64) {
        self.hostUs = hostUs
        self.globalX = globalX
        self.globalY = globalY
        self.x = x
        self.y = y
    }
}

public struct JournalMarkWindow: Codable, Sendable, Equatable {
    public let app: String
    public let title: String
    public let bounds: GeometryRect
    public init(app: String, title: String, bounds: GeometryRect) {
        self.app = app; self.title = title; self.bounds = bounds
    }
}

/// When a stroke or pin was on the person's screen, in host time: at full strength until
/// `fadeHostUs`, then fading until it is gone at `untilHostUs`. An undo can clear it sooner.
public struct JournalMarkScreen: Codable, Sendable, Equatable {
    public let fadeHostUs: Int64
    public let untilHostUs: Int64
    public init(fadeHostUs: Int64, untilHostUs: Int64) {
        self.fadeHostUs = fadeHostUs; self.untilHostUs = untilHostUs
    }
}

/// A stroke, pin or click, or an undo. An undo row names in `retracts` the mark it cleared from
/// the screen, and carries no points; the mark it names stays evidence.
public struct JournalMark: Codable, Sendable, Equatable {
    public let hostUs: Int64
    public let sourceUs: Int64
    public let epoch: Int
    public let id: String
    public let kind: String
    public let pin: Int?
    public let points: [JournalMarkPoint]
    public let window: JournalMarkWindow?
    public let onScreen: JournalMarkScreen?
    public let retracts: String?
    public init(
        hostUs: Int64, sourceUs: Int64, epoch: Int, id: String, kind: String, pin: Int? = nil,
        points: [JournalMarkPoint], window: JournalMarkWindow? = nil,
        onScreen: JournalMarkScreen? = nil, retracts: String? = nil
    ) {
        self.hostUs = hostUs; self.sourceUs = sourceUs; self.epoch = epoch; self.id = id
        self.kind = kind; self.pin = pin; self.points = points; self.window = window
        self.onScreen = onScreen; self.retracts = retracts
    }
}

func validMark(_ mark: JournalMark) -> Bool {
    guard mark.hostUs >= 0, mark.sourceUs >= 0, mark.epoch >= 0,
        !mark.id.isEmpty, mark.id.utf8.count <= 256,
        ["stroke", "pin", "click"].contains(mark.kind),
        mark.retracts == nil || (!mark.retracts!.isEmpty && mark.retracts!.utf8.count <= 256),
        mark.retracts == nil ? !mark.points.isEmpty : mark.points.isEmpty,
        mark.kind == "pin" ? (mark.pin ?? 0) > 0 : mark.pin == nil else { return false }
    guard mark.points.allSatisfy({
        $0.hostUs >= 0 && $0.globalX.isFinite && $0.globalY.isFinite
            && (($0.x == nil) == ($0.y == nil))
            && ($0.x == nil || ($0.x!.isFinite && $0.y!.isFinite))
    }) else { return false }
    if let screen = mark.onScreen {
        guard mark.kind != "click", mark.retracts == nil,
            screen.fadeHostUs >= 0, screen.untilHostUs > screen.fadeHostUs else { return false }
    }
    if let window = mark.window {
        guard !window.app.isEmpty, window.app.utf8.count <= 256,
            window.title.utf8.count <= 4096,
            window.bounds.x.isFinite, window.bounds.y.isFinite,
            window.bounds.width.isFinite, window.bounds.height.isFinite else { return false }
    }
    return true
}
