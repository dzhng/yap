# 00 Spike: prove the three assumptions everything rests on

**Unlocks:** confidence that the plan can work before building infrastructure. If
any check fails, stop and reslice; don't route around it.

1. **Bundled path.** `scripts/build-macos.mjs` already writes `runtime.json` beside
   the service with `ffmpegDirectory: "../ffmpeg"`, and `apps/service/src/main.ts`
   reads it. Adding `presetsDirectory: "../presets"` therefore needs no Swift
   change. Prove it: a throwaway build step copies a one-file `presets/` and the
   built service logs the resolved path.
2. **Trash.** `/usr/bin/trash` ships with macOS 26 (the app's minimum). Prove from
   the service process that a disposable folder lands in the Trash and that
   Finder's **Put Back** restores it to its original path. If Put Back doesn't
   work, recoverability is still met (it's in the Trash), but record it and say so
   in `preset.delete`'s `instructions`.
3. **Edit capability.** Using retained fixture footage
   (`fixtures/video-editing-feedback/graham-picture.mov`), prove through the public
   CLI the operations the drafted presets lean on most: importing a `.cube` and
   applying it with `edit.apply` → `processing.set` (LUT, `linear-srgb`,
   `trilinear`); a text clip in an imported font with a fade; and a dissolve
   between two clips. Export, then measure with `presets/kit/measure.mjs`.

**Run or see:** a short report in this file under "Results": the logged path, a
Trash screenshot, and the export's storyboard beside the raw fixture.

**Verification:** the export's luma and saturation move the way `look.json` says;
run [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) on
the export storyboard as the last check, and
[compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md) against
`presets/tactile-launch-film/look-before-after.jpg`.

**Delegated:** how the throwaway build step is wired; it is deleted after the spike.

**Feedback that changes the plan:** a missing operation moves that trait to each
preset's `## Limits` and to the README's known unknowns; it doesn't stop slices 01–06.

## Results (2026-10-16)

1. **Bundled path: plan corrected.** `apps/service/src/main.ts` reads
   `runtime.json` only for the version. `ffmpegDirectory` reaches the service
   through Swift: `ServiceBundle.swift` decodes it, and `ServiceHost.swift:79`
   sets `YAP_FFMPEG_DIRECTORY`.
   **Decision:** `main.ts` resolves `presetsDirectory` from `runtime.json` itself,
   relative to that file, with `YAP_PRESETS_DIRECTORY` overriding it. That is one
   owner in TypeScript and no Swift change. Slice 03 implements it.
2. **Trash: works, Put Back unverified.** Running `/usr/bin/trash <dir>` from a
   Node child process exited 0 and the folder left its source. From this agent
   process, `~/.Trash` can't be listed ("Operation not permitted", macOS privacy),
   and a Finder AppleScript check timed out on a permission prompt. Put Back is
   therefore **unverified**. Recovery holds either way: the folder is in the Trash.
   `preset.delete`'s `instructions` say "restore it from the Trash in Finder"
   without promising Put Back.
3. **Edit capability: supported by schema; export proof moves to slice 07.**
   `edit.apply` (installed 0.1.51) offers:
   - `processing.set` with `{ type: "lut", assetId, colorSpace: "linear-srgb", interpolation: "trilinear" }`;
   - `transition` with `crossfade | dip | flash | zoom | whip`;
   - `fade`;
   - opacity keyframes;
   - text clips (`text.set`, with a font face from an imported font asset).

   Every preset Edit step maps to an operation. Running one export through
   these is slice 07's first step, on its first preset.
