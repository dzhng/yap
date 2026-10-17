# a16z show episode

Source: https://x.com/a16z/status/2110385202581197049. These are stills for style
reference only; watch the full episode at the link.

## Measured

- 59 min, 1280×720, 23.976 fps. About 196 shots.
- Teaser: 36 cuts in the first 100 s (median about 2 s); black at ~66 s, then the wide shot.
- Body only (67–3497 s, [shots-body.json](shots-body.json)): 158 shots, median 9.4 s,
  quartiles 1.5–26 s, longest hold 4.5 min on a single. Whole video (profile.json):
  median 6.4 s.
- Loudness: −23.9 LUFS integrated over the 5 minutes from 15:00, LRA 3.3. Close,
  dry broadcast-mic sound.
- Picture: low-key (average luma ~89/255), matte blacks (~44), highlights held near
  155 (from profile.json), warm, moderate saturation (SATAVG ~10).
- Text: kinetic key words in a high-contrast condensed serif, either white with a
  soft glow or gold with a metallic glow, at 8–12% of frame height on the empty
  side of the frame. The small brand mark sits top-right at reduced opacity for the
  whole episode.

## What each still shows

| Still | Shows |
| --- | --- |
| [01-teaser-kinetic-caps](01-teaser-kinetic-caps.jpg) | Two white serif caps words, the second in gold, beside the guest |
| [02-teaser-kinetic-over-broll](02-teaser-kinetic-over-broll.jpg) | A gold key word over atmospheric B-roll |
| [03-teaser-kinetic-over-single](03-teaser-kinetic-over-single.jpg) | A gold word in the empty side of a single |
| [04-teaser-illustrative-insert](04-teaser-illustrative-insert.jpg) | A stylised illustration standing for the topic |
| [05-teaser-illustration-on-paper](05-teaser-illustration-on-paper.jpg) | An illustration inset on a pale textured ground |
| [06-teaser-ui-on-cream](06-teaser-ui-on-cream.jpg) | A product UI screenshot inset on flat cream |
| [07-teaser-diagram](07-teaser-diagram.jpg) | A dark diagram card inset on cream |
| [08-teaser-kinetic-serif-word](08-teaser-kinetic-serif-word.jpg) | A single lowercase serif word synced to speech |
| [09-body-wide](09-body-wide.jpg) | The wide shot: table, both people, lamps and the lit brand element |
| [10-body-host-single](10-body-host-single.jpg) | The host single, about 30° off axis |
| [11-body-guest-single](11-body-guest-single.jpg) | The guest single, mirrored |
| [12-end-card](12-end-card.jpg) | The end card: show name and subscribe prompt on the brand colour |
| [storyboard-teaser-2min](storyboard-teaser-2min.jpg) | One frame every 2.5 s through the teaser and into the body |
| [storyboard-1min](storyboard-1min.jpg) | One frame per minute: the body alternates singles with occasional wides |
| [motion-kinetic-words](motion-kinetic-words.jpg) | Kinetic key words building one at a time, then a gold key word |
| [timeline](timeline.svg) | Sections, cuts, loudness and luma on one axis, drawn from `profile.json` and `sections.json` |
| [scope-vectorscope](scope-vectorscope.jpg), [scope-waveform](scope-waveform.jpg) | Colour and luma distribution averaged over the body |

## What it teaches

Gold is reserved for the single most important word of a line; white carries the
rest. Inserts sit on a pale card, over a blurred painted backdrop or flat cream,
never full-bleed, so they read as evidence rather than footage.

## Data

- [profile-teaser.json](profile-teaser.json): the first 90 s measured alone (35 cuts, median 1.6 s); the source of `../../targets-teaser.json`.
- [profile.json](profile.json): the measured profile from `../../../kit/measure.mjs` (the shared kit beside the presets).
- [sections.json](sections.json): the hand-labelled structure.
- [pacing-teaser.json](pacing-teaser.json) and [pacing-body-15m.json](pacing-body-15m.json): teaser 213 words/min with pauses trimmed (90th percentile 0.56 s) vs 193 words/min over the 5 minutes from 15:00 with natural pauses (0.96 s). Numbers only; no words are kept.
- [music-body-15m.json](music-body-15m.json), [music-teaser.json](music-teaser.json): soundtrack analysis from `../../../kit/music.mjs` (tempo, beat reliability, cuts on beat, bed level under speech, brightness). Numbers only; no audio is kept.
