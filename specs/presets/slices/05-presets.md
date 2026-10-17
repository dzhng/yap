# 05 The three presets

**Unlocks:** the user hands over raw footage, names one of the three styles, and
gets a video in that style.

Split into three independent sub-slices, one per preset, each of which can ship
alone: `tactile-launch-film` first (short, cheapest to iterate), then
`on-location-conversation`, then `studio-podcast`.

**Status:** drafts of all three exist in repo `presets/`, from the
[study](../study.md). Steps 1 and 2 are done as drafts; step 3 is next. Revise a
draft from what step 3 shows, and bump its `version`.

**Per preset:**
1. **Study.** Download the reference locally, outside the repo, import it as an
   inspiration asset, and measure it with Yap evidence operations: shot lengths
   and cut cadence (scene evidence), framing and camera angles (frames and
   storyboards), caption presence, placement and type, color and grade (frames,
   plus `yap ffmpeg` statistics), audio treatment, intro/outro structure, and
   aspect ratio. Record the measurements, as numbers and our own descriptions,
   in the preset's text and in [study.md](../study.md). Don't commit frames or transcripts.
2. **Write.** Write `PRESET.md`. `## Shoot` is what the user must capture: cameras
   and angles, framing, lighting, audio, and which takes or B-roll. `## Edit` is
   the operation-level procedure: structure, cut rules, captions, grade, audio,
   and export settings. `## Check` compares the result against the reference
   measurements. Add scripts only where a step is computed.
3. **Prove.** Run a fresh agent with the consumer skill on raw footage (start with
   retained fixtures; see the README's known unknowns) and the prompt "make this in
   the <preset> style". Compare storyboards of the output with the reference using
   [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md), one
   variable at a time: cadence, then framing, then captions, then grade. Then run
   [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) as the
   last check, and show the user with
   [preview-shots](../../../.agents/skills/preview-shots/SKILL.md).

**Human checkpoint (non-blocking):** open the output beside the reference
storyboard with preview-shots and wait about 5 minutes. If there's no reply,
decide on the evidence, record the decision here and continue.

**Gaps:** when a trait can't be produced with current operations, write it in the
preset as a known limitation and list it in the README's known unknowns. Don't
change the product inside this slice.

**Delegated:** preset ids (rename freely before the first release), how much goes
in `references/` versus `PRESET.md`, and which measurements earn a data file.
