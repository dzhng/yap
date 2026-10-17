---
id: studio-podcast
name: Studio interview podcast
description: A long-form (30–75 minute) three-camera studio interview in a dark, warmly lit set. It opens with a fast teaser cold open of the best lines, with kinetic word captions and illustrative inserts, then cuts to the active speaker and keeps a corner brand mark. Use when the user wants a polished tech or business interview podcast for YouTube or X.
version: 6
references:
  - https://x.com/a16z/status/2110385202581197049
---

# Studio interview podcast

## The one idea that matters

**A loud minute, then a calm hour.** The teaser is the only designed, fast part:
the best lines, big kinetic key words and illustrative inserts, a cut every few
seconds. After a beat of black, the conversation runs calm and patient, cutting
only to whoever is speaking in a dark, warmly lit set.

It fails in two ways: a teaser with no rise (just clips in order), or bringing the
teaser's busyness (captions, inserts, fast cuts) into the body.

## Any footage

This preset is a mood, not a set: thoughtful, calm and intellectual, after one
designed minute that sells the ideas. The mood lives in the matte, warm grade, the
patient cutting to whoever matters in the moment, the teaser with kinetic key words
and inserts, the tight dialogue sound and the quiet brand mark. Apply it to whatever
the user gives you, even a holiday film or a single phone camera, and never ask them
to reshoot. Footage made for this style works best (see `## Shoot` when they ask what
to film), but any footage can carry the mood:
- **The teaser** takes the strongest lines or moments, whatever the source.
- **The body** holds shots patiently and cuts on sentences or beats.
- **The grade** applies to every video track. It gives a lighter version of the look
  in bright footage, which is still the look.

Pick each teaser insert by what the line is doing:

| The line… | Insert |
| --- | --- |
| names a trend or a number (the example's opening) | A chart on a pale card that builds as the line plays |
| names companies or products | Their logos or UI on a pale card (user-supplied or licensed) |
| makes a metaphor | A stylised illustration of the metaphor |
| refers to news | A licensed clip, framed small inside a set or a screen |
| is a strong claim | No insert: the speaker's single with gold key words |

## Size

| Cut | Length | What changes |
| --- | --- | --- |
| Clip | 30–90 s | One idea, the speaker's single camera, kinetic key words, one insert at most |
| Teaser alone | 45–90 s | [cold-open.md](cold-open.md) as a trailer, ending on the show card |
| Episode | 30–75 min | Everything in this preset |

## Examples

Open the closest example before you plan. Each folder has stills named by what
they show, storyboards and the measured numbers.

- [examples/a16z-show](examples/a16z-show/README.md): a 59 min episode with one
  host and one guest at a round table, three cameras and a ~70 s teaser.

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

- **Set.** A dark wall (slate, charcoal or deep green), a round table in light
  wood, two warm practical lamps in shot, and one lit brand element on the back
  wall (a sign, a print or a logo). Keep the room dark apart from the key lights.
- **Light.** One soft key per person from the front side. Lamps and the brand
  element provide the background glow. No flat overhead light.
- **Cameras (all recording the whole conversation, landscape 16:9):**
  1. A wide two-shot from the front showing the table, both people and the brand element.
  2. A medium single of the host from across the table, about 30° off axis.
  3. A medium single of the guest, mirrored.
  Clap once at the start so the cameras can be lined up.
- **Audio.** A dynamic broadcast mic on an arm per person, recorded to separate
  tracks. Water glasses and notes on the table are part of the look.
- **For the teaser.** A list of 3–6 topics the guest will hit. After the shoot,
  gather any screenshots, diagrams, product UI or licensed clips that illustrate
  them.
- **Identity.** A small brand mark (PNG with transparency), the show name and an
  end card design, or permission to build a simple one.

## Music

Music lives only in the teaser and the cards. Measured in the example:
- [Teaser](examples/a16z-show/music-teaser.json): the gaps between lines sit
  ~13 dB under the speech (−34 vs −21 dBFS RMS), so there is a quiet bed under
  every line. It has no strong beat (pulse 1.37), and only ~28% of cuts land on
  one, so the cuts follow the speech, not the music.
- [Body](examples/a16z-show/music-body-15m.json): no bed. Gaps sit ~1 dB under
  the speech, which is the other mic and the room.

So:
- Teaser: a low, pulsing licensed instrumental 12–15 dB under the speech, cut to
  the lines rather than the beat. It stops on the beat of black.
- Body: no music.
- End card: a short sting or the teaser bed returning, 4–6 s.
- Ask the user for licensed tracks; never use a track from a reference.

## Edit

1. Import all camera files and audio tracks. Use the clap or `join.verify` to
   align the cameras to the mic tracks. Transcribe the guest and host tracks.
2. **Body cutting.** Find who speaks when from the per-mic levels (`audio.measure` on each track), or from speaker turns (`speaker.observe`, an optional model download the user must approve). Cut to the active speaker's single.
   Use the wide shot (a) at the start of the conversation, (b) for quick
   back-and-forth exchanges and (c) every 2–4 minutes as a breather. Hold a single
   while one person speaks at length; minutes on one camera is right. Cut on
   sentence boundaries, never mid-word. Remove false starts and long pauses only if
   the user's brief asks for tightening.
3. **Teaser cold open (45–90 s).** Build it as described in
   [cold-open.md](cold-open.md): 5–8 of the strongest lines, kinetic word captions,
   illustrative inserts, then a beat of black before the wide shot.
4. **Grade.** Import [look.cube](look.cube) and apply it with an
   `edit.apply` `processing.set` on each video track (`target: { kind: "track", id }`; a
   new step has no `id`) with a LUT (`colorSpace: "linear-srgb"`,
   `interpolation: "trilinear"`). The intent, in [look.json](look.json): matte
   lifted blacks, highlights held well below white and slightly warm skin. Match the
   three cameras so a cut never changes the colour.
   Then fit the grade to the footage: measure with `../kit/measure.mjs` and add
   exposure, contrast or saturation steps on the same track until every mood line in
   `../kit/check.mjs` passes. The cube carries the look; trims carry it onto this
   footage. In the first trials, a bright daylight room needed −0.5 EV before the cube for the low-key level; a contrast step before the cube crushes the blacks, because the cube's lift is the floor.
   Balance every shot to the look before judging it: a source much hotter or more
   saturated than the rest (fire, sky, a screen) gets its own exposure and
   saturation trim, so no shot breaks the mood.
5. **Brand mark.** Place it top-right at about 4% of frame height and 60% opacity,
   from the first frame through the last line, inserts included (see stills 04–05).
   Leave it off the end card.
6. **Captions.** None in the body by default. Kinetic captions belong to the
   teaser only. Offer SRT/VTT export as a separate file.
7. **End.** After the last line, cut to a 10–16 s still end card (the example holds about 16 s,
   after a legal card) with the show name,
   the brand mark and a subscribe prompt on a dark brand-colour background. Add a
   legal or disclaimer card only if the user supplies the text.
8. **Audio.** Keep each speaker's track and gate the inactive mic lightly to cut
   room spill. Bring the episode to −16 LUFS integrated (−24 if the user targets
   broadcast) with a loudness range of 4 LU or less.
9. Export 1920×1080 H.264, or the source resolution if lower. If the user wants
   social clips, cut 30–90 s single-topic excerpts from the body with the kinetic
   caption treatment from [cold-open.md](cold-open.md).

## Check

Measure the export and compare it with [targets.json](targets.json). `FAIL` lines are
mood (grade, loudness, cut rhythm): fix each or tell the user why it stands. `note`
lines are form (length, shot count, longest take). They describe the reference,
depend on the footage you were given, and are never a reason to pad, cut or reject.

```sh
node ../kit/measure.mjs export.mp4 --sample-every 15 --out export-profile.json
node ../kit/check.mjs export-profile.json targets.json
node ../kit/timeline.mjs export-profile.json --out export-timeline.svg
```

Put `export-timeline.svg` beside the example's `timeline.svg`: the rhythm should
read alike. Then check by eye:

- The teaser is fast and the body calm, with no cut landing inside a word. (The
  reference's teaser runs 45–90 s with 15 or more cuts; scale it to the footage.)
- Whoever is speaking is on screen whenever there is an angle of them.
- The camera angles match: their average luma is within about 8 levels of each
  other.
- The teaser passes [targets-teaser.json](targets-teaser.json) and the body passes
  [targets-body.json](targets-body.json) (commands in each `$about`).
- The brand mark is present and unchanged throughout the body.

## Limits

Grade each video track, not `{ kind: "output" }`: per-track grading lets you balance
one shot, and on Yap 0.1.53 and earlier a LUT on the output fails the export with
"Unsupported audio processing step".

Not yet proven with Yap's operations: the gold metallic glow on key words, charts
that build while a line plays, and the blurred-backdrop inset card. Until they are,
use plain gold text with a soft shadow, a chart revealed in two or three steps, and
the flat cream card, and tell the user what differs.

The grade mattes and warms any footage. A bright room or an outdoor film gets a
lighter version of the low-key look; apply it anyway. With fewer than three
cameras, cut between the angles available, and use crops of a wide shot (an
`edit.apply` crop) as stand-in singles.
