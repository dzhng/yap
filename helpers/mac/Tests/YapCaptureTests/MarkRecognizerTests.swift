import CoreGraphics
import Foundation
import YapCapture

private struct TestWindowSource: WindowUnderPoint {
    let result: MarkWindow?

    func windowUnderPoint(_ point: CGPoint) -> MarkWindow? { result }
}

private func markRecognizer(
    paused: Bool = false, hasFirstFrame: Bool = true, cameraOnly: Bool = false
) -> MarkRecognizer {
    MarkRecognizer(
        windowUnderPoint: TestWindowSource(
            result: MarkWindow(
                app: "Safari", title: "Deploys", bounds: GeometryRect(x: 10, y: 20, width: 800, height: 600))),
        paused: paused, hasFirstFrame: hasFirstFrame, cameraOnly: cameraOnly)
}

private func sample(
    _ hostUs: Int64, _ x: Double, _ y: Double, shift: Bool = true,
    otherModifiers: Bool = false, buttonDown: Bool = false
) -> MarkSample {
    MarkSample(
        hostUs: hostUs, shift: shift, otherModifiers: otherModifiers,
        point: CGPoint(x: x, y: y), buttonDown: buttonDown)
}

private func press(_ hostUs: Int64, _ x: Double, _ y: Double, shift: Bool = true) -> MarkPress {
    MarkPress(hostUs: hostUs, point: CGPoint(x: x, y: y), shift: shift)
}

private func release(_ hostUs: Int64, _ x: Double, _ y: Double) -> MarkRelease {
    MarkRelease(hostUs: hostUs, point: CGPoint(x: x, y: y))
}

func runMarkRecognizerTests() {
    let window = MarkWindow(
        app: "Safari", title: "Deploys", bounds: GeometryRect(x: 10, y: 20, width: 800, height: 600))

    let table: [(String, () -> Bool)] = [
        ("shift plus eight points emits one stroke", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(sample: sample(20, 108, 100))
            let events = recognizer.feed(sample: sample(30, 108, 100, shift: false))
            return events.count == 1
                && events[0].kind == .stroke
                && events[0].pin == nil
                && events[0].points.map(\.hostUs) == [10, 20]
                && events[0].window == window
        }),
        ("shift plus seven point nine emits nothing", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(sample: sample(20, 107.9, 100))
            return recognizer.feed(sample: sample(30, 107.9, 100, shift: false)).isEmpty
        }),
        ("other modifiers never draw", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100, otherModifiers: true))
            _ = recognizer.feed(sample: sample(20, 120, 100, otherModifiers: true))
            return recognizer.feed(sample: sample(30, 120, 100, shift: false)).isEmpty
        }),
        ("shift press emits a pin and ends the stroke", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(sample: sample(20, 108, 100))
            _ = recognizer.feed(sample: sample(25, 108, 100, buttonDown: true))
            let events = recognizer.feed(press: press(30, 120, 130))
            return events.count == 2
                && events[0].kind == .stroke
                && events[1].kind == .pin
                && events[1].pin == 1
                && events[1].points == [MarkPoint(x: 120, y: 130, hostUs: 30)]
        }),
        ("pin numbers count up across a take", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100))
            let first = recognizer.feed(press: press(20, 100, 100))
            _ = recognizer.feed(sample: sample(40, 110, 100))
            let second = recognizer.feed(press: press(50, 110, 100))
            return first.first?.pin == 1 && second.first?.pin == 2
        }),
        ("a press carrying ⇧ pins before the sampler has seen ⇧", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100, shift: false))
            let events = recognizer.feed(press: press(12, 100, 100, shift: true))
            return events.count == 1 && events[0].kind == .pin && events[0].pin == 1
        }),
        ("plain click emits at press point", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100, shift: false))
            _ = recognizer.feed(press: press(20, 120, 130, shift: false))
            let events = recognizer.feed(release: release(30, 140, 150))
            return events == [
                MarkEvent(
                    kind: .click, pin: nil,
                    points: [MarkPoint(x: 120, y: 130, hostUs: 20)], window: window)
            ]
        }),
        ("a drag still emits one click", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100, shift: false))
            _ = recognizer.feed(press: press(20, 120, 130, shift: false))
            _ = recognizer.feed(sample: sample(25, 160, 180, shift: false, buttonDown: true))
            let events = recognizer.feed(release: release(30, 160, 180))
            return events.count == 1 && events[0].kind == .click
                && events[0].points == [MarkPoint(x: 120, y: 130, hostUs: 20)]
        }),
        ("paused takes emit nothing", {
            var recognizer = markRecognizer(paused: true)
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(press: press(20, 100, 100))
            return recognizer.feed(release: release(30, 100, 100)).isEmpty
        }),
        ("a take without its first frame emits nothing", {
            var recognizer = markRecognizer(hasFirstFrame: false)
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(press: press(20, 100, 100))
            return recognizer.feed(release: release(30, 100, 100)).isEmpty
        }),
        ("camera-only takes emit nothing", {
            var recognizer = markRecognizer(cameraOnly: true)
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(press: press(20, 100, 100))
            return recognizer.feed(release: release(30, 100, 100)).isEmpty
        }),
        ("a dropped sampler tick does not split a stroke", {
            var recognizer = markRecognizer()
            _ = recognizer.feed(sample: sample(10, 100, 100))
            _ = recognizer.feed(sample: sample(16_667, 104, 100))
            _ = recognizer.feed(sample: sample(50_001, 108, 100))
            let events = recognizer.feed(sample: sample(50_002, 108, 100, shift: false))
            return events.count == 1 && events[0].kind == .stroke
                && events[0].points.map(\.hostUs) == [10, 16_667, 50_001]
        }),
    ]

    for (name, test) in table {
        precondition(test(), name)
        print("PASS \(name)")
    }
}
