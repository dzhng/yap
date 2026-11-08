import AppKit
import ScreenCaptureKit
import YapCapture

/// The pictures of the sources the capture panel lists. Pictures are taken only while the panel
/// is open, once per source each time it opens: current when it opens, not retaken on every status
/// poll, and a source that cannot be taken is not retried until the next opening. The last
/// opening's picture shows until the new one answers, and each answer calls `changed`.
@MainActor
final class SourcePreviews {
    private var pictures: [String: NSImage] = [:]
    private var requests = Set<String>()
    private let changed: () -> Void

    init(changed: @escaping () -> Void) {
        self.changed = changed
    }

    func display(_ id: Int, taking: Bool) -> NSImage? {
        picture(key: "display:\(id)", taking: taking) { content in
            content.displays.first { Int($0.displayID) == id }.map { CaptureExclusion.displayFilter($0, in: content) }
        }
    }

    func window(_ id: Int, taking: Bool) -> NSImage? {
        picture(key: "window:\(id)", taking: taking) { content in
            content.windows.first { Int($0.windowID) == id }.map { SCContentFilter(desktopIndependentWindow: $0) }
        }
    }

    /// Called while the capture panel is closed: the next opening takes every picture again, and
    /// only the pictures of sources the last opening listed are kept until then.
    func forgetRequests() {
        guard !requests.isEmpty else { return }
        pictures = pictures.filter { requests.contains($0.key) }
        requests.removeAll()
    }

    private func picture(
        key: String, taking: Bool, filter: @escaping (SCShareableContent) -> SCContentFilter?
    ) -> NSImage? {
        guard taking, requests.insert(key).inserted else { return pictures[key] }
        Task { [weak self] in
            guard let picture = try? await Self.thumbnail(filter), let self else { return }
            pictures[key] = NSImage(cgImage: picture, size: NSSize(width: picture.width, height: picture.height))
            changed()
        }
        return pictures[key]
    }

    /// A picture sized for the source chooser's cards, at the source's own pixel scale.
    private static func thumbnail(_ filter: (SCShareableContent) -> SCContentFilter?) async throws -> CGImage? {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let filter = filter(content) else { return nil }
        let config = SCStreamConfiguration()
        let scale = min(1, 180 / max(filter.contentRect.width, 1)) * CGFloat(filter.pointPixelScale)
        config.width = max(1, Int(filter.contentRect.width * scale))
        config.height = max(1, Int(filter.contentRect.height * scale))
        config.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }
}
