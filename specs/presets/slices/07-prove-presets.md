# 07 Prove the three presets

**Unlocks:** the user hands over raw footage, names a style, and gets that style.

Three independent sub-slices, cheapest first: `tactile-launch-film`,
`on-location-conversation`, `studio-podcast`. The speech presets need the separate
fix for the transcription bug (MP4 audio running past the video); until it lands,
extract audio to WAV first, as the guide says.

**Per preset:**
1. Footage: any footage carries a preset's mood. Use retained fixtures or the user's
   own footage; footage shot to the preset's `## Shoot` is a bonus, never a gate.
2. A fresh agent with only the consumer skill gets "make this in the <style> style".
3. It must read the preset (`preset.get`), follow `## Edit`, and run `## Check`
   until `kit/check.mjs` passes.
4. Judge one variable at a time against the example (cadence, then framing, then
   text, then grade, then sound) with
   [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md) on
   storyboards and timelines; run
   [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) last.
5. Revise the preset where the agent went wrong, bump its `version`.

**Human checkpoint (non-blocking):** open output beside the example storyboard with
[preview-shots](../../../.agents/skills/preview-shots/SKILL.md), wait about 5
minutes; if silent, decide on the evidence, record it here, close the shots, continue.

**Gaps:** a trait current operations can't make goes in the preset's `## Limits`
with its fallback, and in the README's known unknowns. Don't change the product here.

**Delegated:** fixture choice per preset and how many revise rounds.

## Results

### Export proof, part 1 (2026-10-17, installed Yap 0.1.51)

This is the deferred step from slice 00. On `fixtures/video-editing-feedback/graham-picture.mov`
it ran, through the public CLI:
- `asset.import` of the footage and of `tactile-launch-film/look.cube`;
- `project.create`;
- `edit.apply` with `track.add`, `place`, and `processing.set` with the LUT on the video track;
- `export.create`.

The export committed.
[Raw, predicted and exported frame](../assets/07-export-proof/raw-predicted-export.png):

| | Lifted black (Y low) | Average luma | Highlights (Y high) | Saturation |
| --- | --- | --- | --- | --- |
| Raw fixture | 112 | 173 | 204 | 11.2 |
| Cube simulated in linear sRGB | 125 | 175 | 199 | 9.7 |
| Yap export | 122 | 171 | 194 | 9.6 |

The rendered grade matches the cube's intent within a few levels, which H.264 and
Rec.709 encoding account for. **The preset LUTs work as designed.**

Findings, each fixed where it belongs:
- **The LUT must target the video track, not `{ kind: "output" }`.** The output target
  includes the audio chain. `edit.apply` accepts it, but the export fails with
  "Unsupported audio processing step". All three presets now say "each video track"
  (version 2). *Product bug:* `edit.apply` should refuse a video-only processor on a
  target that includes audio.
- **A new processing step must not carry an `id`.** A fresh `id` is refused with "Processing
  step does not belong to this target", which misleads (the schema shows `id` as
  optional). *Product bug:* the message should say that `id` names an existing step.
- **`kit/measure.mjs` measured 10-bit footage on a 0–1023 scale** (the ProRes fixture read
  as luma 687), which would fail every brightness target. It now converts to 8-bit
  first, with a test. Kit version 2.

### Part 2: a fresh agent edits raw footage into each style

No longer blocked. Presets carry a mood onto any footage, so all three are proven
on one set of raw footage: the launch-video session in the user's library (the
same bytes as `fixtures/launch-video/session/`): five 4K DJI clips of one speaker
by a window plus fireplace B-roll, a laptop camera take, a screen recording and
narration. One independent agent per preset, each given only the footage, the
preset and its `instructions`.
