import AppKit
// Logs ⇧ state (polled, as the cursor sampler would) and global mouse-down events for N seconds.
let out = FileHandle(forWritingAtPath: "/tmp/yap-probe/log.jsonl") ?? { FileManager.default.createFile(atPath: "/tmp/yap-probe/log.jsonl", contents: nil); return FileHandle(forWritingAtPath: "/tmp/yap-probe/log.jsonl")! }()
out.truncateFile(atOffset: 0)
func log(_ s: String) { out.write((s + "\n").data(using: .utf8)!) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
log("{\"event\":\"start\",\"axTrusted\":\(AXIsProcessTrusted()),\"listenAccess\":\(CGPreflightListenEventAccess())}")
_ = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { e in
  log("{\"event\":\"\(e.type == .leftMouseDown ? "down" : "up")\",\"shift\":\(e.modifierFlags.contains(.shift)),\"x\":\(Int(e.locationInWindow.x)),\"y\":\(Int(e.locationInWindow.y))}")
}
var last = false
Timer.scheduledTimer(withTimeInterval: 1.0/60, repeats: true) { _ in
  let shift = NSEvent.modifierFlags.contains(.shift)
  if shift != last { last = shift; log("{\"event\":\"shift\",\"held\":\(shift),\"buttons\":\(NSEvent.pressedMouseButtons)}") }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 25) { log("{\"event\":\"end\"}"); exit(0) }
app.run()
