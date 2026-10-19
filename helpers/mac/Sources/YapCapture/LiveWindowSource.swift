import AppKit
import CoreGraphics

/// Resolves the frontmost layer-0 window under a global top-left point. Yap's own processes are
/// removed before hit-testing so controls and overlays never become evidence for the take.
public struct LiveWindowSource: WindowUnderPoint, Sendable {
    public init() {}

    public func windowUnderPoint(_ point: CGPoint) -> JournalMarkWindow? {
        let ownPIDs = Set(
            NSRunningApplication.runningApplications(
                withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").map(\.processIdentifier))
        let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for window in windows {
            let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            let app = window[kCGWindowOwnerName as String] as? String ?? ""
            let title = window[kCGWindowName as String] as? String ?? ""
            guard layer == 0, !app.isEmpty, !ownPIDs.contains(pid),
                let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                rect.contains(point)
            else { continue }
            return JournalMarkWindow(app: app, title: title, bounds: GeometryRect(rect))
        }
        return nil
    }
}
