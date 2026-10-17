# 07 Prove the three presets

**Unlocks:** the user hands over raw footage, names a style, and gets that style.

Three independent sub-slices, cheapest first: `tactile-launch-film`,
`on-location-conversation`, `studio-podcast`. The speech presets need the separate
fix for the transcription bug (MP4 audio running past the video); until it lands,
extract audio to WAV first, as the guide says.

**Per preset:**
1. Footage: start with retained fixtures; if none fits the style, ask the user to
   shoot to the preset's `## Shoot` (record the request; don't block other presets).
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
