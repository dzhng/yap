# ashe: frontier tech series episode

Source: https://x.com/ashebytes/status/2107522974568103969. These are stills for
style reference only; watch the full episode at the link.

## Measured

- 51 min, 1920×1080, 29.97 fps. About 22 shots in total.
- Scene changes at ~4, 6, 8 and 12 s (cold open), then at 3.1, 18.8, 21.7, 31.7
  and 37.9 min, and a quick run from 50.2 to 51.2 min (ending montage). Some
  changes inside a location are camera moves, so `sections.json` groups them into
  four main locations and a short café coda.
- Speech starts at 0.8 s over B-roll. One line plays, then about 10 s of B-roll with
  the guest and series card, then the first location.
- Loudness: −26.9 LUFS integrated over the 5 minutes from 15:00, LRA 8.9. Natural lav
  sound with street ambience left in.
- Picture: lifted blacks (average low 43/255), rolled highlights (202), average 122,
  low saturation (SATAVG 7.5). All from profile.json.
- Text: wide-tracked, all-caps sans in white. The series name sits in the lower
  centre; the guest's handle is larger above it; chapter labels go bottom-left
  after a thin vertical bar; the sign-off is centred on a dark interior.

## What each still shows

| Still | Shows |
| --- | --- |
| [01-cold-open-street](01-cold-open-street.jpg) | The first frame: a street establishing shot under the opening line |
| [02-cold-open-detail](02-cold-open-detail.jpg) | A handheld detail shot (coffee) in the cold open |
| [03-cold-open-food](03-cold-open-food.jpg) | A warm, saturated food detail in the cold open |
| [04-guest-and-series-card](04-guest-and-series-card.jpg) | The guest's handle and the series name over B-roll |
| [05-chapter-label](05-chapter-label.jpg) | The first location's two-shot with its chapter label bottom-left |
| [06-location-park](06-location-park.jpg) | A park bench location; the same framing rule |
| [07-location-shade-with-label](07-location-shade-with-label.jpg) | A shaded bench location with its chapter label |
| [08-location-steps](08-location-steps.jpg) | Building steps; the pair sits lower and the framing follows |
| [09-ending-workplace-broll](09-ending-workplace-broll.jpg) | Workplace B-roll in the ending montage |
| [10-location-cafe](10-location-cafe.jpg) | The final café location, with its signage behind the pair |
| [11-sign-off-card](11-sign-off-card.jpg) | The tracked-caps sign-off over a dim, warm interior |
| [storyboard-opening-2min](storyboard-opening-2min.jpg) | One frame every 2.5 s for the first two minutes |
| [storyboard-1min](storyboard-1min.jpg) | One frame per minute for the whole episode; the locations show as bands |
| [motion-chapter-label-in](motion-chapter-label-in.jpg) | The chapter label switching on in one frame inside its dark box |
| [timeline](timeline.svg) | Sections, cuts, loudness and luma on one axis, drawn from `profile.json` and `sections.json` |
| [scope-vectorscope](scope-vectorscope.jpg), [scope-waveform](scope-waveform.jpg) | Colour and luma distribution averaged over the body |

## What it teaches

The location bands in the per-minute storyboard are the structure: each band is
one take, and each change is a chapter.

## Data

- [profile.json](profile.json): the measured profile from `../../../kit/measure.mjs` (the shared kit beside the presets).
- [sections.json](sections.json): the hand-labelled structure.
- [pacing-body-15m.json](pacing-body-15m.json): Speech pacing over the 5 minutes from 15:00: 170 words/min, ~20 pauses a minute, median pause 0.56 s. Numbers only; no words are kept.
- [music-body-15m.json](music-body-15m.json), [music-cold-open.json](music-cold-open.json), [music-ending.json](music-ending.json): soundtrack analysis from `../../../kit/music.mjs` (tempo, beat reliability, cuts on beat, bed level under speech, brightness). Numbers only; no audio is kept.
