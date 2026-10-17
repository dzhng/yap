---
id: on-location-conversation
name: On-location conversation
description: A long-form (20–60 minute) two-person conversation filmed outdoors as one wide locked two-shot per location. The pair moves through several places, with a short B-roll cold open, small tracked-caps chapter labels and a faded-film daylight look. Use when the user wants a relaxed, documentary-feeling interview episode rather than a studio podcast.
version: 1
references:
  - https://x.com/ashebytes/status/2107522974568103969
---

# On-location conversation

## The one idea that matters

**The place changes, the framing doesn't.** Each location is one long, unbroken
wide shot of both people side by side. Moving to a new place is the only cut the
viewer notices, and it marks a new chapter. The city does the work that cutaways
and close-ups do in a studio show.

It fails in two ways: cutting inside a location (it turns into a generic
interview), or so many locations that no conversation has room to settle.

Choose the walk before the shoot: each location should suit the topic it holds.

| Topic of a chapter | Location that carries it |
| --- | --- |
| Origin story, early life (the example's first chapter) | A street bench near where it started |
| Big-picture views | An open park or a long view |
| A sensitive or personal subject | A shaded, quieter spot |
| Institutions, rules, history | The steps of a civic or historic building |
| The guest's work today | Their café, studio or office, as the coda |

Only the first row is from an example; prove the others before relying on them.

## Size

| Cut | Length | What changes |
| --- | --- | --- |
| Clip | 45–90 s | One stretch inside one location, its chapter label on, no cold open |
| Episode | 20–60 min | Everything in this preset |
| Series trailer | 60–90 s | One strong line per location over each location's B-roll, then the series card |

## Examples

Open the closest example before you plan. Each folder has stills named by what
they show, storyboards and the measured numbers.

- [examples/ashe-frontier-tech](examples/ashe-frontier-tech/README.md): a 51 min
  episode of a tech interview series across four main locations and a short café coda, with a 12 s
  B-roll cold open and a looser montage at the end.

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

Ask the user for this before they record:

- **People.** Host and guest, each with a visible clip-on lav mic. The lav audio is
  the only dialogue source.
- **Camera.** One camera on a tripod, landscape 16:9, framing both people side by
  side from knees or mid-thigh up, with the street or park behind them. Put the
  camera at seated eye height. Don't zoom or reframe during a take.
- **Locations.** 3–6 places on a walk: a café bench, a park, steps of an
  interesting building, a café table, the guest's workplace. Record each one as a
  single uninterrupted take of 5–15 minutes.
- **Light.** Open shade or overcast daylight. Avoid direct midday sun on faces;
  sunglasses are fine.
- **B-roll (about 15–25 clips of 3–6 s, handheld is fine).** Street details, coffee
  being made, food, building facades, interiors of the places you visit, and a
  few close handheld singles of the guest between locations. Shoot two or three
  dim, moody interior shots for the ending.
- **Series identity.** A series title, an episode title, the host's handle, and a
  short label (2–5 words) for each location's topic.

## Music

Music only frames the episode; the conversation itself has none. Measured in the
example:
- [Cold open](examples/ashe-frontier-tech/music-cold-open.json): a clear beat
  (pulse 1.91) at about 134 BPM, bright (centroid ~1960 Hz). That reads as an
  upbeat, light instrumental under the B-roll and the title card.
- [Body](examples/ashe-frontier-tech/music-body-15m.json): no beat (pulse 1.25,
  speech only). Gaps between words sit only ~3 dB under the speech, which is
  street ambience, not a bed.
- [Ending](examples/ashe-frontier-tech/music-ending.json): no steady beat (1.26),
  darker (~1470 Hz). A softer instrumental or ambience under the montage.

So:
- Cold open: a light, rhythmic licensed instrumental at 120–140 BPM. Cut the B-roll
  on its beats where you can and land the cut to the first location on a downbeat.
  Fade it under the first spoken words within 1 s.
- Body: no music. Keep the street sound; it is the bed.
- Ending: a calmer instrumental, or none, under the montage, about 15 dB under any
  speech, fading out over the sign-off card.
- Ask the user for licensed tracks; never use a track from a reference.

## Edit

1. Import every take and B-roll clip. Transcribe the location takes. Use
   the transcript and `audio.pause.get` to find each take's natural start and
   end. Trim only dead air and setup at the edges; keep the conversation intact
   inside a take.
2. **Cold open (10–15 s).** Find one strong line from the guest with
   `transcript.search` and the user's brief. Put its audio over 4–5 quick B-roll
   shots (2–3 s each, hard cuts). Hold the last B-roll shot under the series title,
   then hard cut to the first location's two-shot.
3. **Body.** Lay the location takes in walking order, each as one continuous wide
   shot. Between locations, insert one or two 3–5 s B-roll shots of the next place,
   with the conversation audio continuing under them where it bridges naturally,
   or room tone where it doesn't. Don't cut back and forth inside a location; the
   single framing is the style.
4. **Text.** Use one geometric or humanist sans with wide letter-spacing (about
   0.3 em), all caps, white, small (2.5–3% of frame height). Open choices that read
   close to the example: Montserrat or Open Sans at semibold; import with
   `asset.import`.
   - The series title is centred on the lower third of the cold open's last shot
     for about 3 s, with the guest's handle larger above it (see still 04).
   - A chapter label goes bottom-left about 30 s into each location: a
     translucent dark box (about 55% black) holding a thin vertical bar and the
     label. It switches on and off in one frame, with no fade, and holds 6–8 s.
     See [motion-chapter-label-in](examples/ashe-frontier-tech/motion-chapter-label-in.jpg).
   - Don't add captions or a burned-in transcript.
5. **Grade.** Import [look.cube](look.cube) and apply it to every clip with an
   `edit.apply` call whose operation is `processing.set` with a LUT (`colorSpace: "linear-srgb"`,
   `interpolation: "trilinear"`). The intent, in [look.json](look.json): lifted
   blacks, softly compressed highlights and about 25% less saturation, a faded film
   feel. Check that the sky behind the pair holds detail.
6. **Ending (45–75 s).** After the last location, cut a looser montage of handheld
   guest singles, workplace B-roll and the dim interiors, at 3–6 s per shot under
   the closing conversation or a soft instrumental. End on a dim interior with a
   centred two-line sign-off in the same tracked caps and the host's handle, held
   about 5 s.
7. **Audio.** Keep the speech natural. Match the takes' loudness to each other
   within 1 LU and target about −24 LUFS integrated for the episode. Reduce
   traffic noise only if the user asks or it masks words. Let room tone carry the
   B-roll bridges.
8. Export 1920×1080 H.264 at the source frame rate. If the user wants clips, cut
   45–90 s excerpts from inside one location; each one keeps the wide two-shot
   and gets the chapter label.

## Check

Measure the export and compare it with [targets.json](targets.json); fix every
`FAIL` line or tell the user why it stands:

```sh
node ../kit/measure.mjs export.mp4 --sample-every 15 --out export-profile.json
node ../kit/check.mjs export-profile.json targets.json
node ../kit/timeline.mjs export-profile.json --out export-timeline.svg
```

Put `export-timeline.svg` beside the example's `timeline.svg`: the rhythm should
read alike. Then check by eye:

- Every location is one continuous shot; no cuts inside it apart from the B-roll
  bridges.
- The cold open is 10–15 s and the ending is 45–75 s.
- Each chapter label appears once per location and is readable on a phone.
- Saturation lower than the raw footage and no clipped sky.
- Loudness of the location segments varies by 1 LU or less.

## Limits

Not yet proven with Yap's operations: the chapter label's translucent box with a
bar. Until it is, render the box and bar as a PNG overlay asset and lay the text over it.

The style depends on long uninterrupted takes. If the user's takes are cut up or
reframed, say so and keep the single-framing rule within each piece you have.
