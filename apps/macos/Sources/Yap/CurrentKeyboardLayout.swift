import Carbon.HIToolbox
import YapControls

extension KeyboardLayout {
    /// The printable character this Mac's current input layout types for each physical key,
    /// unshifted, read the way Settings sees a pressed key.
    static func current() -> KeyboardLayout {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return KeyboardLayout(characters: [:]) }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
        var characters: [UInt32: String] = [:]
        data.withUnsafeBytes { bytes in
            guard let layout = bytes.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
            for code in UInt16(0)..<128 {
                var dead: UInt32 = 0
                var length = 0
                var units = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(
                    layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, units.count, &length, &units)
                guard status == noErr, length > 0 else { continue }
                let typed = String(utf16CodeUnits: units, count: length)
                guard !typed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
                else { continue }
                characters[UInt32(code)] = typed
            }
        }
        return KeyboardLayout(characters: characters)
    }
}
