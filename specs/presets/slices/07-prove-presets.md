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

### Part 2: one footage, three moods (2026-10-17, installed Yap 0.1.53)

Three independent agents each got the launch-video session footage, one preset as
files (the installed app predates `preset.get`) and its rendered `instructions`.
None was told about the others or what to expect. Every agent passed every mood
check; form lines came out as notes, as designed.

| Preset | Export | Mood checks | Storyboard |
| --- | --- | --- | --- |
| `tactile-launch-film` | 48.5 s; wordless and music-led; the clip-on mic as the made object; claim lines taken from the narration | all ok | [storyboard](../assets/07-launch-footage/tactile-launch-film-storyboard.jpg) |
| `on-location-conversation` | 2:13; B-roll cold open, two topic chapters held as unbroken wides, sign-off over the fireplace | all ok | [storyboard](../assets/07-launch-footage/on-location-conversation-storyboard.jpg) |
| `studio-podcast` | 2:01; 32 s teaser with gold and white kinetic words and screen inserts on cards, black beat, two-camera body, dark end card | all ok (whole, teaser) | [storyboard](../assets/07-launch-footage/studio-podcast-storyboard.jpg) |

An unprimed critique of full frames and crops confirmed these defects. Each one is
now a rule in its preset (version 5):
- A tactile claim pair that didn't read as a phrase ("Your agent gets / and the
  hands"), set beside a mouth.
- Fire shots hotter and more saturated than the grade, in two of the three videos.
  Every preset now balances outlier shots.
- A zoom transition smearing a studio teaser frame. The teaser is hard cuts only.
- Kinetic words losing contrast over a pale curtain, and an on-location sign-off
  over a bright flame.

Dismissed with reason: "studio isn't low-key enough" and "tactile isn't hands
crafting". Those are the lighter, adapted versions of each mood that `## Any
footage` asks for.

Preset gaps the agents found, fixed in version 4:
- The cube alone missed the mood targets on dark and on bright footage. Every
  Grade step now fits the cube with exposure, contrast and saturation trims until
  the checks pass, with the trial values as examples.
- Text sizes as a percentage don't map to Yap's text `size`. Tactile now gives px
  on a 1080-line canvas.
- The suggested open fonts aren't installed. macOS fallbacks are named.
- On-location structure assumed long form. The label delay and ending now scale
  with length, and the size table has a 2–5 min row.
- The studio whole-video median shot length fought the teaser on short edits. Body
  rhythm moved to `targets-body.json`.

Yap findings for separate fixes (not preset bugs):
- A text clip with a background box failed to render ("Malformed picture receipt"
  in a failed job while the call returned ok).
- Text has no letter-spacing setting.
- Overlapping text clips each need their own track.
- `edit.apply` labels resolve only within one request.
- The bundled ffmpeg lacks `drawtext`, `eq` and `boxblur`.
- About 64 concurrent frame reads were refused with `LIMIT_EXCEEDED`.
- With `--wait`, export output starts with progress lines before the JSON.
- `kit/measure.mjs`'s scene threshold (0.3) misses cuts between similar framings of
  one room (22 of 26 found). Agents can pass `--scene 0.2`.
