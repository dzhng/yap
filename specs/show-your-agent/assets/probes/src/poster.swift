import CoreGraphics
import Foundation
// Posts ⇧ down, a click at screen point (320, H-280) (inside the target window), ⇧ up, then a plain click.
let h = CGDisplayBounds(CGMainDisplayID()).height
let p = CGPoint(x: 320, y: h - 280)
let src = CGEventSource(stateID: .hidSystemState)
func key(_ down: Bool) { let e = CGEvent(keyboardEventSource: src, virtualKey: 56, keyDown: down)!; e.flags = down ? .maskShift : []; e.post(tap: .cghidEventTap) }
func click(shift: Bool) {
  for t in [CGEventType.leftMouseDown, .leftMouseUp] { let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!; if shift { e.flags = .maskShift }; e.post(tap: .cghidEventTap); usleep(40_000) }
}
print("posterTrusted", CGPreflightPostEventAccess())
key(true); usleep(300_000); click(shift: true); usleep(300_000); key(false); usleep(300_000); click(shift: false)
