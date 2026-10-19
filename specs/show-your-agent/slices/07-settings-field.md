# 07 Settings click-to-record field

**Contract unlocked:** D4 for people: click a field, press keys, the binding applies at once.

**Seam:** a recorder field per action in `SettingsWindow.swift`, calling `GlobalShortcuts.suspend()`
while focused (Carbon would otherwise fire the bound action before the field sees the keys,
`GlobalShortcuts.swift:115-122`) and writing through the same handler as `shortcuts.set`.
States: bound and active; active while recording (for `.recording` keys when idle, replacing
today's false "in use elsewhere", `SettingsWindow.swift:403`); refused by macOS; duplicate in
Yap. The "applies after restart" footer (`:393`) goes.

**Slice variable:** the field and its states only.

**Human can see:** `apps/macos/tests/settings-view-shots.mjs` with each state, light and dark.

**Verify:** `settings-window.test.mjs` (live rebind, duplicate refused, idle held key shows
"while recording"). `screenshot-critique` last; `compare-screenshots` against today's Settings
shortcuts section as the prior look; `preview-shots`, non-blocking as in the README.

**Delegated:** visual details within the existing Settings style.
