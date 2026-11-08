import AppKit
import Carbon.HIToolbox
import YapControls

/**
 The key combinations this app holds while it is not the active application.

 A combination is only ever *asked for*. When the system refuses one — because something else
 already holds it — that binding is left off and named in the menu, so nothing is taken away from
 whatever the person already uses it for. A combination macOS itself has switched on is refused
 here before it is asked for, because `RegisterEventHotKey` answers with success for one that is
 already spoken for: see [system shortcuts](../YapControls/SystemShortcuts.swift). The key-code
 model passes the physical code and Carbon modifier mask directly to that registration call.
 Another application's own registration still cannot be detected, so the menu states what this app
 holds rather than promising the key is free.
 */
@MainActor
final class GlobalShortcuts {
    /// Where a person states combinations of their own when a suggested one is unavailable.
    static func overridePath(home: String) -> String {
        (home as NSString).appendingPathComponent("shortcuts.json")
    }

    enum ApplyError: Error, Equatable {
        case duplicate(String)
    }

    private var handlers: [UInt32: () -> Void] = [:]
    private var claimed: [UInt32: EventHotKeyRef] = [:]
    private var appliedIdentifiers: Set<UInt32> = []
    private var handler: EventHandlerRef?
    private var nextIdentifier: UInt32 = 1

    func apply(
        _ bindings: [ControlsAction: ShortcutBindings.Binding], recording: Bool = false,
        perform: @escaping (ControlsAction) -> Void
    ) throws(ApplyError) -> (held: Set<String>, unavailable: [String]) {
        // Both answers are action ids. The physical key and modifiers are the identity; a label
        // is only how it is shown.
        let grouped = Dictionary(grouping: bindings) {
            [$0.value.shortcut.keyCode, $0.value.shortcut.modifiers]
        }
        if let duplicate = grouped.values.first(where: { $0.count > 1 }) {
            throw .duplicate(duplicate.map { $0.key.id }.sorted().joined(separator: ", "))
        }
        releaseApplied()
        let systemHeld = SystemShortcuts.taken()
        var held: Set<String> = []
        var unavailable: [String] = []
        // The catalog's order, so a launch that cannot claim two combinations names them the same
        // way every time rather than in whatever order a dictionary happened to hold.
        for action in ShortcutBindings.catalog.map(\.action) {
            guard let binding = bindings[action], binding.lifetime == .app || recording else { continue }
            guard let identifier = register(
                binding.shortcut, systemHeld: systemHeld, perform: { perform(action) }) else {
                unavailable.append(action.id)
                continue
            }
            appliedIdentifiers.insert(identifier)
            held.insert(action.id)
        }
        return (held, unavailable)
    }

    /// Releases only the registrations made by `apply`; temporary `hold` claims have their own
    /// lifetime and remain active until their release closure runs.
    func suspend() { releaseApplied() }

    func hold(_ shortcut: Shortcut, perform: @escaping () -> Void) -> (() -> Void)? {
        guard let identifier = register(
            shortcut, systemHeld: SystemShortcuts.taken(), perform: perform)
        else { return nil }
        return { [weak self] in self?.release(identifier) }
    }

    /// Asks the system for one combination. Refusal is the answer here; nothing is taken.
    private func register(
        _ shortcut: Shortcut, systemHeld: Set<SystemShortcuts.Combination>,
        perform: @escaping () -> Void
    ) -> UInt32? {
        installHandler()
        let key = shortcut.keyCode
        let modifiers = shortcut.modifiers
        // Asking for one the system already has would be answered with success and then never
        // deliver a keystroke, so it is refused here where the refusal can be said out loud.
        if systemHeld.contains(SystemShortcuts.Combination(
            keyCode: key,
            control: modifiers & UInt32(controlKey) != 0,
            option: modifiers & UInt32(optionKey) != 0,
            command: modifiers & UInt32(cmdKey) != 0,
            shift: modifiers & UInt32(shiftKey) != 0)) {
            diagnostic("shortcut \(shortcut.label) is held by macOS itself")
            return nil
        }
        let identifier = nextIdentifier
        nextIdentifier += 1
        var reference: EventHotKeyRef?
        let status = RegisterEventHotKey(
            key, modifiers, EventHotKeyID(signature: Self.signature, id: identifier),
            GetApplicationEventTarget(), 0, &reference)
        guard status == noErr, let reference else { return nil }
        claimed[identifier] = reference
        handlers[identifier] = perform
        return identifier
    }

    private func release(_ identifier: UInt32) {
        if let reference = claimed.removeValue(forKey: identifier) {
            UnregisterEventHotKey(reference)
        }
        appliedIdentifiers.remove(identifier)
        handlers[identifier] = nil
    }

    private func releaseApplied() {
        for identifier in Array(appliedIdentifiers) { release(identifier) }
    }

    private func installHandler() {
        guard handler == nil else { return }
        var pressed = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, context in
                guard let event, let context else { return OSStatus(eventNotHandledErr) }
                var identifier = EventHotKeyID()
                let read = GetEventParameter(
                    event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                    nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier)
                guard read == noErr, identifier.signature == GlobalShortcuts.signature else {
                    return OSStatus(eventNotHandledErr)
                }
                // Carbon delivers hot keys on the main thread, which is where this app's controls
                // and its capture session already live.
                return MainActor.assumeIsolated {
                    let shortcuts = Unmanaged<GlobalShortcuts>.fromOpaque(context)
                        .takeUnretainedValue()
                    guard let perform = shortcuts.handlers[identifier.id] else {
                        return OSStatus(eventNotHandledErr)
                    }
                    perform()
                    return noErr
                }
            }, 1, &pressed, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    private static let signature = OSType(0x53_52_45_43) // SREC
}
