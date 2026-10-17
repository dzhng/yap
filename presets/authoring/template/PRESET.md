---
id: style-name
name: Style name in plain words
description: One or two sentences an agent can match a request against. Say the format, the length, the look, and when to use it.
version: 1
references:
  - https://example.com/the-first-reference-video
---

# Style name in plain words

## The one idea that matters

**One bold sentence.** Two or three sentences on what everything else serves.

It fails in two ways: …, or ….

## Examples

Open the closest example before you plan.

- [examples/source-slug](examples/source-slug/README.md): length, format, what it shows best.

## References in this preset

| Reference | Use it for |
| --- | --- |
| `examples/<name>/…` | See each example README |
| [targets.json](targets.json) | Ranges an export must land in |
| [look.cube](look.cube), [look.json](look.json), [look-before-after.jpg](look-before-after.jpg) | The grade |
| [shoot-plan.svg](shoot-plan.svg) | A diagram for guiding the shoot |
| `../kit/` | measure, check, timeline, music, pacing, make-look-lut |

## Shoot

What to ask the user for before they record: people, cameras and angles, light,
set, audio, coverage (shot list with lengths), and the copy or identity assets.

## Music

What the examples measured (link each `music*.json`), what to look for in a
licensed track, where it enters and leaves, whether cuts follow the beat, and how
far the bed sits under speech.

## Edit

Numbered steps in Yap operations, in order: import and evidence, structure,
cutting rules, grade, text, music and sound, export.

## Check

```sh
node ../kit/measure.mjs export.mp4 --out export-profile.json
node ../kit/check.mjs export-profile.json targets.json
node ../kit/timeline.mjs export-profile.json --out export-timeline.svg
```

Then the checks only eyes can make.

## Limits

What the footage must supply, and what current operations can't produce.
