# humans& model launch

Source: https://x.com/humansand/status/2098115046438215791. These are stills for
style reference only; watch the full film at the link.

## Measured

- 42 s, 1920×1080, 24 fps, H.264. No speech; music only, −16.9 LUFS integrated, loudness range 5.5 LU.
- Three hard cuts (2.8, 14.1 and 18.2 s) make four shots of 2.8 to 24.2 s; every other change is a dissolve, a particle transition or an in-camera move.
- Picture: bright (average luma 167/255, average low 116), warm, low saturation (SATAVG 13.3). All from profile.json.
- Text: a light book serif, near-black on light areas and off-white on dark ones.
  The product name is centred near the top; claim lines are top-left in two lines,
  where the first line stays and the second changes with the shot.

## What each still shows

| Still | Shows |
| --- | --- |
| [01-process-macro](01-process-macro.jpg) | Opening macro: hands with the object in progress, very shallow focus |
| [02-first-marks](02-first-marks.jpg) | The first marks on a blank surface, from above |
| [03-title-over-object](03-title-over-object.jpg) | The product name over the finished object, with negative space above it |
| [04-title-and-subtitle](04-title-and-subtitle.jpg) | The name with a small subtitle, in the wide room shot that shows the window light |
| [05-claim-over-process](05-claim-over-process.jpg) | A claim line top-left over an overhead process shot |
| [06-claim-over-scale-wall](06-claim-over-scale-wall.jpg) | Many variations on a wall, standing for scale, with window-frame shadows |
| [07-transition-particles](07-transition-particles.jpg) | The one designed transition: the marks scatter into the next shot |
| [08-real-beside-made](08-real-beside-made.jpg) | The real object beside the made one |
| [09-final-placement](09-final-placement.jpg) | Hands placing the made object; the last live-action beat |
| [10-end-card](10-end-card.jpg) | End card: object on the left, name, tagline and URL on cream |
| [storyboard-1s](storyboard-1s.jpg) | One frame per second for the whole film |
| [motion-claim-line-in](motion-claim-line-in.jpg) | A claim line arriving about 1 s after the cut, at 6 frames per second |
| [timeline](timeline.svg) | Sections, cuts, loudness and luma on one axis, drawn from `profile.json` and `sections.json` |
| [scope-vectorscope](scope-vectorscope.jpg), [scope-waveform](scope-waveform.jpg) | Colour and luma distribution averaged over the body |

## What it teaches

The metaphor (dots, then many dots) carries the idea. The text never explains
the picture; each line names what the shot under it already shows.

## Data

- [profile.json](profile.json): the measured profile from `../../../kit/measure.mjs` (the shared kit beside the presets).
- [sections.json](sections.json): the hand-labelled structure.
- [music.json](music.json): soundtrack analysis from `../../../kit/music.mjs` (tempo, beat reliability, cuts on beat, bed level under speech, brightness). Numbers only; no audio is kept.
