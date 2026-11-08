# 13 `⌥⇧V` paste

**Contract unlocked:** D8: one key puts the prompt into the front app.

**Seam:** `Paster.paste(text) → .pasted | .copied` in the app. It writes the pasteboard, then,
if Accessibility is trusted, posts ⌘V with **Command-only** flags (the held ⌥⇧ would otherwise
make ⌥⇧⌘V, "Paste and Match Style"). Otherwise it shows a non-activating notice built on
`OverlayPanel`: "Copied, press ⌘V". `PermissionKind` gains an optional `accessibility` case;
every exhaustive switch handles it and the required-permission filter excludes it
(`Permissions.swift:59-62`, `RecordingControls.swift:947`). Settings explains the trade-off.

**Slice variable:** the notice and the Accessibility row in Settings.

**Verify:** unit test with an injected event poster (flags are Command only); a controls
journey for the copied path; one installed, signed-build check of the pasted path (dev builds
lose trust on rebuild, `scripts/update-lab.mjs:289`). Visual: `screenshot-critique` on the
notice and Settings row, `compare-screenshots` against the existing overlay style,
`preview-shots`, non-blocking.

**Delegated:** notice duration and placement.
**Depends on:** 06, 12.
