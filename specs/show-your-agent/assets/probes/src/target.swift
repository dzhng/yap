import AppKit
// A small window at a fixed spot for the poster to click into, so no real app receives the click.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 240, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
w.title = "yap probe target"; w.level = .floating; w.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(0) }
app.run()
