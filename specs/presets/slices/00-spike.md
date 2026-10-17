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

## Results

_Not run yet._
