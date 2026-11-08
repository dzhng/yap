# 06 Shortcut bindings: model, live registration, public operations

**Contract unlocked:** every action has a binding that can change while Yap runs, from Settings
or the CLI, with one meaning.

**Seam:**
- `ShortcutBindings` in `YapControls`: one `ControlsAction` list (replace both
  `ShortcutDefaults.suggested`, `ShortcutDefaults.swift:50`, and Settings' own list,
  `SettingsWindow.swift:459-462`), each action with a lifetime: `.app` (S, V) or `.recording`
  (Z, X, P, R). New actions: `pastePrompt`, `undoMark`.
- Defaults (D6): `⌥⇧S` start/finish, `⌥⇧V` paste, `⌥⇧Z` undo mark, `⌥⇧X` cancel, `⌥⇧P`
  pause, `⌥⇧R` restart.
- File `shortcuts.json` version 2: `{ version: 2, bindings: { action: { keyCode, modifiers, label } } }`.
  Key codes, not letters, because `kVK_ANSI_*` are physical positions
  (`GlobalShortcuts.swift:140-156`). A version-1 file is ignored (compat decision).
- `GlobalShortcuts.apply(bindings)` registers, unregisters and releases claims (today claims
  are never released, `:29-47`); `suspend()`/`resume()` for the Settings field. Duplicates
  inside the app are refused with a typed error. `SystemShortcuts.taken()` is re-read on apply.
- App operations `shortcuts.get` / `shortcuts.set`, the `update.setEnabled` pattern
  (`SparkleDriver.swift:51-66`): protocol schema, the `appOperations` prefix regex and the
  waits table (`packages/protocol/src/operations.ts:1796-1809`), routing in `apps/macos/Sources/Yap/main.swift:247-256`.
  `set` applies live.

**Verify:** `apps/macos/tests/YapControlsTests/ShortcutTests.swift` rewritten for D6 and key
codes (it pins ⌃⌥⌘ at `:8-39`); `apps/macos/tests/fixtures/capture-view.swift:400`;
`packages/protocol/src/index.test.ts:57`; `apps/macos/tests/app-socket.test.mjs` (a `set`
takes effect with no restart); `skills/yap/references/capability-catalog.md:103` lists the ops.

**Delegated:** file location (keep `~/.yap/`), error wording.
**Firewall:** no Settings UI (slice 07), no start routing (slice 08).
