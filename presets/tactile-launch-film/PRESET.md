---
id: tactile-launch-film
name: Tactile launch film
description: A 30–60 second wordless launch or announcement film. Warm daylight close-ups of hands making a physical object that stands for the product, slow dissolves, small serif headlines that build line by line, and a calm end card. Use when the user wants a quiet, premium, crafted announcement with no one talking to camera.
version: 6
references:
  - https://x.com/humansand/status/2098115046438215791
---

# Tactile launch film

## The one idea that matters

**The made object is the message.** Nobody explains the product. Hands make one
physical thing that stands for what the product does, and three or four short
lines of text say what it means. Everything else (window light, dissolves, a
cream end card, silence apart from music) exists to keep attention on that object.

It fails in two ways: an object with no clear link to the product (pretty but
meaningless), or text that does the explaining while the picture just decorates.

## Any footage

This preset is a mood, not a shot list: calm, warm, tactile and unhurried. The mood
lives in the grade, the music, the long holds joined by dissolves, the near-silence
and the few lines of quiet serif text. Apply it to whatever the user gives you and
never ask them to reshoot. Footage made for this style works best (see `## Shoot`
when they ask what to film), but any footage can carry the mood:
- **Choose for stillness and touch.** Prefer the calmest moments: hands, objects,
  surfaces, light through a window, slow movement. Hold them long.
- **Let music lead.** If the footage has speech, keep one or two essential lines at
  most, under the music, or turn the key sentences into the text lines.
- **Keep the language:** dissolves between ideas, a hard cut only where a new idea
  starts, the grade on every video track, and a still end card.

Find the object before anything else. Say in one sentence what the hands make and
what that means. Earlier mappings:

| Product idea | Made object |
| --- | --- |
| A model of people (the example) | A fruit painted in many small dots; a wall of differently painted versions |
| Personalisation | One cup thrown on a wheel for each person, each glaze different |
| Reliability or uptime | A dry-stone wall laid course by course, then a hand pressing on it |
| Speed | A paper plane folded in five crisp folds and thrown |
| Collaboration | Two pairs of hands weaving one strip of fabric from both ends |
| Privacy | A letter folded, sealed with wax, pressed with a seal |
| Search or discovery | Hands sorting a tray of buttons until one exact match is found |

The last six are ideas, not examples; prove one before treating it as a pattern.

## Examples

Open the closest example before you plan. Each folder has stills named by what
they show, a storyboard and the measured numbers.

- [examples/humansand-persimmon](examples/humansand-persimmon/README.md): a 42 s
  model launch. A fruit painted in dots stands for a model of people; a wall of
  variations stands for scale. Four long shots with three hard cuts; inside them, dissolves
  and a particle transition carry the changes. Music only.

## References in this preset

Read these as you need them. Paths are relative to this file.

| Reference | Use it for |
| --- | --- |
| `examples/<name>/README.md` | The source link, measured numbers, a table of stills and what the example teaches |
| `examples/<name>/NN-*.jpg` | Named stills: framing, text placement, end cards. Compare your frames with these |
| `examples/<name>/storyboard-*.jpg` | The whole rhythm at a glance |
| `examples/<name>/motion-*.jpg` | Frame-by-frame filmstrips of how text comes on, which a still can't show |
| `examples/<name>/timeline.svg` | Sections, cuts, loudness and luma on one time axis |
| `examples/<name>/profile.json` | The measured profile: every cut, shot statistics, levels per sample, palette, loudness per second |
| `examples/<name>/sections.json` | The hand-labelled structure behind the timeline |
| `examples/<name>/scope-*.jpg` | Vectorscope and waveform of the graded picture, for matching colour by eye |
| `examples/<name>/music*.json` | Soundtrack numbers: tempo and whether it is reliable, cuts on beat, bed level under speech, brightness |
| `examples/<name>/pacing-*.json` | Speech pacing as numbers: words per minute, pauses, phrase lengths (speech presets only) |
| [targets.json](targets.json) | The ranges your export must land in, each with why |
| [look.cube](look.cube), [look.json](look.json), [look-before-after.jpg](look-before-after.jpg) | The grade, its intent, and what it does to plain footage (ours: left graded, right raw) |
| [shoot-plan.svg](shoot-plan.svg) | A diagram to show the user when guiding the shoot |
| `../kit/` | Shared tools: `measure.mjs` (profile any video), `check.mjs` (profile vs targets), `timeline.mjs` (draw a profile), `music.mjs` (soundtrack analysis), `pacing.mjs` (speech pacing from a Yap transcript), `make-look-lut.mjs` (rebuild the cube after changing `look.json`) |

Run the kit with the Node from `yap service.tools`; set `YAP_FFMPEG` and `YAP_FFPROBE`
to the tools it lists, or use ffmpeg from PATH.

## Shoot

Advice for footage made for this style, when the user asks what to film or hasn't
recorded yet. It is never a requirement: see `## Any footage`.

- **A physical metaphor for the product.** One object the user can make, draw,
  build or assemble by hand that stands for what the product does. The whole film
  is about that object.
- **Light.** One large window as the only light source, late morning or afternoon,
  with soft shadows falling across the table. No overhead lights and no ring light.
  Shadows of window frames on a wall are a bonus.
- **Set.** A pale wooden table, a cream or white wall, and paper and props in warm
  neutrals. One accent colour, which comes from the object itself.
- **Shots (landscape 16:9, 24 fps if the camera allows; each 8–20 s, the camera
  on a tripod or sliding slowly):**
  1. Macro of hands starting the object: the first marks or parts.
  2. Overhead or 45° shot of the process advancing.
  3. The finished object propped up in the room, wide enough to show the window light.
  4. Many variations of the object together, for example pinned on a wall or laid
     out in a grid. This stands for scale.
  5. The real thing next to the made thing. Hands place it in frame.
  6. A clean final placement, with room left on one side for the end card.
- **Audio.** None needed. Ask the user for a licensed calm instrumental (piano,
  soft strings) or permission to deliver the film silent with a music placeholder.
- **Copy.** One product name, one tagline under 8 words, three or four short
  claim lines (2–6 words each), and a URL.

## Music

The music carries the whole soundtrack, so choose it before cutting. Measured in
the example ([music.json](examples/humansand-persimmon/music.json)): no steady
beat (pulse strength 1.29, under the 1.5 a cuttable beat needs), and a dark, soft
timbre (median spectral centroid ~660 Hz, low for music). Read that as sustained
piano or soft strings in a low register, with no drums.

- Ask the user for a licensed track, or offer to deliver with a placeholder. Never
  use a track from a reference.
- Look for: free time or a slow, unhurried pulse with no percussion (the example
  has no measurable beat, so it gives no tempo to copy), one instrument or a small
  ensemble, no vocals, and a phrase that resolves near the 35–45 s mark.
- Shape: music from frame one (1 s fade in), the scale shot (4) on a phrase change,
  the last note ringing over the end card (2–3 s fade).
- Cuts follow phrases, not beats. Check with
  `node ../kit/music.mjs track.wav --profile export-profile.json`: expect
  `tempoReliable: false` or few cuts on the beat.

## Edit

1. Import the clips and the music. Read the storyboards with `index.get` and pick
   the steadiest, most tactile 4–8 s moments. Order them so one idea builds: making,
   then meaning, then scale, then the reveal. Footage shot to `## Shoot` maps onto
   this directly; anything else is ordered by the same build.
2. **Cut rhythm.** Hold each idea 4–25 s; the example's shots run 2.8 to 24 s.
   Use a hard cut only where a new idea starts (about three in a film), and
   12–24 frame dissolves for changes inside an idea. The reference runs 42 s;
   let the material set the length. Don't speed-ramp, shake or zoom-punch.
3. **Grade.** Import [look.cube](look.cube) with `asset.import` and apply it with an `edit.apply`
   `processing.set` on each video track (`target: { kind: "track", id }`; a new step has
   no `id`) with a LUT (`colorSpace: "linear-srgb"`,
   `interpolation: "trilinear"`). The cube is built for linear input. The intent is
   in [look.json](look.json): lifted warm blacks, cream highlights and about 20%
   less saturation. Then check one frame per shot. Highlights must not clip, and
   the window must read as cream, not white.
   Then fit the grade to the footage: measure with `../kit/measure.mjs` and add
   exposure, contrast or saturation steps on the same track until every mood line in
   `../kit/check.mjs` passes. The cube carries the look; trims carry it onto this
   footage. In the first trials, dark or indoor footage needed +0.3 EV, contrast 0.95, saturation 1.6 and lifted shadows before the cube to reach the brightness and saturation targets.
   Balance every shot to the look before judging it: a source much hotter or more
   saturated than the rest (fire, sky, a screen) gets its own exposure and
   saturation trim, so no shot breaks the mood.
4. **Text.** Use a light serif (the user's brand serif if supplied; otherwise an
   open book serif such as EB Garamond or Cormorant Garamond at a light weight, or
   Hoefler Text, which ships with macOS;
   import it with `asset.import` and compare with the example stills) in near-black on light areas and off-white on dark areas.
   - The title (product name), centred near the top over shot 3, about 120 px on a
     1080-line canvas (Yap's text `size`), with a small subtitle under it at about 2% (see still 04).
   - Claim lines are about 64 px on a 1080-line canvas, two lines at most, placed in the
     shot's empty space: top-left over a wall, lower-middle over a tabletop. Where a
     sequence of claims shares a first line, it stays put and only the second line
     changes, and every pair must read as a phrase on its own ("Your agent gets /
     the hands", never "Your agent gets / and the hands"). Keep text clear of faces
     and mouths. Each line comes in about 1 s after the cut with a quick 4–6 frame
     reveal and holds at least 2.5 s. See [motion-claim-line-in](examples/humansand-persimmon/motion-claim-line-in.jpg).
   - Don't use captions, lower thirds, boxes, drop shadows or motion graphics.
5. **End card.** About 5 s on a flat cream background (#F6F1E8). A round crop of
   the object on the left, the product name in the serif at about 8% height, the
   tagline under it, and a small URL and brand mark at the bottom. Dissolve into it
   from the last shot.
6. **Audio.** Fit the music to the film. Fade it in over 1 s, end it on the end
   card with a 2–3 s fade, and bring it to −16 LUFS integrated.
7. Export a 1920×1080 H.264 file at the source frame rate. If the user asks for
   social versions, make a 1080×1350 crop as well, with the text repositioned
   inside the crop.

## Check

Measure the export and compare it with [targets.json](targets.json). `FAIL` lines are
mood (grade, loudness, cut rhythm): fix each or tell the user why it stands. `note`
lines are form (length, shot count, longest take). They describe the reference,
depend on the footage you were given, and are never a reason to pad, cut or reject.

```sh
node ../kit/measure.mjs export.mp4 --sample-every 1 --scene 0.2 --out export-profile.json
node ../kit/check.mjs export-profile.json targets.json
node ../kit/timeline.mjs export-profile.json --out export-timeline.svg
```

Put `export-timeline.svg` beside the example's `timeline.svg`: the rhythm should
read alike. Then check by eye:

- Hard cuts only at new ideas; everything else dissolves.
- Music leads. Any speech is one or two essential lines under the music.
- Saturation visibly lower than the raw footage; the window reads cream, not white.
- Every text line is readable at phone size and stays up long enough to read twice.
- The end card holds still for at least 4 s.

## Limits

Grade each video track, not `{ kind: "output" }`: per-track grading lets you balance
one shot, and on Yap 0.1.53 and earlier a LUT on the output fails the export with
"Unsupported audio processing step".

Not yet proven with Yap's operations: the particle transition (still 07), the
round crop of the object on the end card, and the line-reveal animation. Until
they are, use a 12-frame dissolve, a square crop and a short fade, and tell the user.

The grade warms and softens whatever light the footage has. It can't create window
light, so overhead-lit footage gets a flatter version of the look. Apply it anyway.
