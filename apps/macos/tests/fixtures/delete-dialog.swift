import AppKit
import YapControls

// The delete question in its three states, rendered by the app's own alert presenter.
@main struct DeleteDialogCheck {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let output = CommandLine.arguments[1]
        var state = LibraryState()
        state.media = [
            .init(kind: .imported, target: .asset("a"), title: "launch-teaser-v2.mp4", durationUs: 42_000_000, sizeBytes: 22_000_000, createdAt: "2026-10-17T20:46:00Z"),
            .init(kind: .recording, target: .recording("r"), title: "2026-10-16T15:05:00Z", durationUs: 690_000_000, sizeBytes: 61_000_000, createdAt: "2026-10-16T15:05:00Z"),
        ]
        let refusal = #"{"recordingId":"r","usedBy":[{"kind":"project","projectId":"p1","title":"Q4 demo","revisions":14},{"kind":"project","projectId":"p2","title":"Bug report: export","revisions":3}],"acquisitions":[],"derivedAssets":[],"freesBytes":61000000,"cascadeFreesBytes":1400000000}"#
        let inUse = try! JSONDecoder().decode(DeleteConfirmation.InUse.self, from: Data(refusal.utf8))
        for (name, dialog) in [
            ("plain", state.confirmation(for: .recording("r"))!),
            ("imported", state.confirmation(for: .asset("a"))!),
            ("cascade", DeleteConfirmation.cascade(.recording("r"), name: state.confirmationName(for: .recording("r"))!, inUse: inUse)),
        ] {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                let alert = DeleteAlert.alert(for: dialog)
                alert.window.appearance = NSAppearance(named: appearance)
                alert.layout()
                precondition(alert.buttons.first?.title == dialog.confirm && alert.buttons.first?.hasDestructiveAction == true
                    && alert.buttons.last?.title == "Cancel" && alert.buttons.last?.keyEquivalent == "\u{1b}",
                    "The action sits on the right and is destructive; Cancel answers Escape")
                alert.window.orderBack(nil)
                RunLoop.current.run(until: Date().addingTimeInterval(0.15))
                let frame = alert.window.contentView!.superview!
                let bitmap = frame.bitmapImageRepForCachingDisplay(in: frame.bounds)!
                frame.cacheDisplay(in: frame.bounds, to: bitmap)
                let suffix = appearance == .darkAqua ? "-dark" : ""
                try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(output)/\(name)\(suffix).png"))
                alert.window.orderOut(nil)
            }
        }
    }
}
