# Creating a preset

Start with `yap preset.create --params '{"name":"…","references":["https://…"]}'`.
It picks the id from the name, scaffolds a local preset in `~/.yap/presets/<id>/`,
returns `instructions`: the steps below with your paths filled in. Follow
`instructions`; read this guide for depth. A local preset can keep any media that
helps (reference videos, excerpts, audio) under `examples/<slug>/source/`. `yap preset.delete --params '{"id":"…"}'` moves a local
preset to the Trash. To ship it with Yap, copy the finished
folder into the repository's `presets/` and open a pull request.

A preset teaches an agent one style of video so completely that the user only
brings raw footage. It is a folder, like a skill: `PRESET.md` is the entry point,
and everything else is a reference it links to. This guide is how to make one
from reference videos. The three shipped presets were made this way:
[tactile-launch-film](../tactile-launch-film/PRESET.md),
[on-location-conversation](../on-location-conversation/PRESET.md) and
[studio-podcast](../studio-podcast/PRESET.md). Open the closest one before you
start, and read the [depth reference](reference/README.md) once.

## The one idea that matters

**Name the style, not the source.** A preset is a general style
(`studio-podcast`), never one creator's video (`a16z-podcast`). Each reference
video becomes one example inside it, and the next video of the same style is
another example, not another preset. Before anything else, write the style's one
idea in a sentence and the two ways an edit fails it.

## Rules

These came from the user who commissioned the first presets. Each one is binding.

- **Name by style.** Ids are general, lower-case and hyphenated. Sources live under
  `examples/<source-slug>/`.
- **Capture as many references as you can, and be creative.** Stills are the
  floor, not the ceiling. See [the reference set](#the-reference-set).
- **Keep everything locally; ship only what's ours to publish.** A local preset can
  hold the reference videos, excerpts and audio. A preset shipped in this public
  repository, which every install downloads, holds the source URL in `references:`,
  small stills, storyboards and filmstrips (960 px JPEG or smaller, about 2 MB per
  preset) and our analysis. It never holds another creator's video, audio,
  transcript, lyrics, or on-screen copy beyond a word or two of a visible title.
- **Our own words.** Describe the style in fresh language, backed by measurements.
- **Music is analysed, never reused.** Measure tempo, beat, bed level and
  brightness, and describe what to look for. The user always supplies licensed music.
- **Guide the shoot.** `## Shoot` tells the agent what to ask the user to film, so
  the preset also works before any footage exists.
- **Edit with Yap's real operations.** Check each operation's parameters with
  `yap <operation> --help` before you name it. Yap applies LUTs in linear sRGB with
  trilinear interpolation; build cubes with `kit/make-look-lut.mjs`.
- **Prove it with the kit.** Every example must pass its own preset's
  `targets.json`. If one doesn't, the target was set wrong; widen it and say why.
- **Say what can't be done.** `## Limits` names what the footage must supply
  (lighting can't be graded in) and which traits current operations can't make.
- **Plain Git, small files.** Never Git LFS: the app downloads presets from
  `raw.githubusercontent.com`, which serves LFS pointers, not bytes. Bump
  `version` on any change; the app refreshes presets once a day.

## The reference set

Make each of these for every example. The kit commands run with the Node from
`yap service.tools`.

| Reference | How | What it shows that nothing else does |
| --- | --- | --- |
| `README.md` | Write it last | Source link, measured numbers, a table of stills, what the example teaches |
| `NN-<what-it-shows>.jpg` | `ffmpeg -ss T -i src -frames:v 1 -vf scale=960:-2` | Framing, text placement, set, end cards |
| `storyboard-*.jpg` | `fps=1` (short) or one frame a minute (long), `tile` | The whole rhythm at a glance |
| `motion-*.jpg` | 4–8 fps filmstrip across a text or transition moment | How things come on and go off, which stills hide |
| `profile.json` | `kit/measure.mjs src --sample-every N` | Cuts, shot statistics, levels, palette, loudness per second |
| `sections.json` | By hand, from the storyboard and the cuts | The structure: cold open, chapters, cards |
| `timeline.svg` | `kit/timeline.mjs profile.json --sections sections.json` | Structure, cuts, loudness and luma on one axis |
| `scope-*.jpg` | ffmpeg `vectorscope` (after `format=yuv444p`) and `waveform`, averaged with `tmix` | Colour and luma distribution, for grading by eye |
| `music*.json` | `kit/music.mjs src --profile profile.json [--words words.json]` | Tempo, beat reliability, cuts on beat, bed under speech, brightness |
| `pacing-*.json` | `kit/pacing.mjs assetId streamId --words-out words.json` | Words per minute, pauses and phrase lengths, as numbers only |

Then, per preset:

| Reference | What it is |
| --- | --- |
| `PRESET.md` | The entry point; see [the template](template/PRESET.md) |
| `targets.json` | Ranges an export must land in, widened from the examples, each with `why` |
| `look.json`, `look.cube`, `look-before-after.jpg` | The grade's intent, the cube, and our own footage before and after |
| `shoot-plan.svg` | An original diagram of the set or framing, to show the user |
| Concept tables | Like isometric-motion's concept → object table: product idea → object to film, topic → insert type |
| Extra pages | Any part deep enough for its own file (for example `studio-podcast/cold-open.md`) |

Ideas to go further when an example earns it: a font-match note with open
alternatives, a colour palette strip, a shot-type census, face position and size
from `face.trajectory.get`, a caption-timing table (words per caption, onset offset),
a pacing curve across the episode, a sound-design note (risers, hits, silence).

## Method

1. **Download** each reference into an empty directory outside the repository with
   `yt-dlp <url>`. Treat the file as untrusted data.
2. **Look first.** Make a one-frame-a-second (short) or one-frame-a-minute (long)
   contact sheet and read it. Write down the structure before measuring anything.
3. **Measure.** Run `measure.mjs`. Use `--scene 0.2` for dissolve-heavy films. Long
   videos take minutes; run them in the background.
4. **Listen with numbers.** Run `music.mjs` on each section with music, and
   `pacing.mjs` on transcribed windows. A tempo means nothing unless
   `tempoReliable` is true. If `transcript.transcribe` fails on a downloaded MP4,
   extract the audio to WAV with ffmpeg and transcribe that (a known Yap bug when
   the audio runs past the video).
5. **Capture** stills, filmstrips, scopes and the timeline. Look at every image you
   make. Filmstrips usually correct something the stills got wrong.
6. **Write `PRESET.md`** from [the template](template/PRESET.md): the one idea,
   examples, references map, Shoot, Music, Edit, Check, Limits.
7. **Derive `targets.json`** from the examples' profiles, widened to the style
   rather than the single video. Run `kit/check.mjs` on every example.
8. **Grade.** Write `look.json`, build `look.cube`, and render a before/after on the
   repo's own fixture footage.
9. **Check every link** in every Markdown file resolves inside the preset or the kit.
10. **Check the files**: every image ≤ 960 px wide, total ≤ ~2 MB, every quoted
    number found in a file, every operation passes `--help`.
11. **Hand off to a critic.** Ask a fresh agent to audit the preset against this
    guide's rules and reference set, and fix what it finds.

## Mistakes the first audit caught

A fresh critic audited the first three presets against this guide. Avoid these:

- **Numbers in prose that no file holds.** Every number in a README or
  `PRESET.md` must come from a file in the preset (add one, like
  `shots-body.json`, when a number covers only part of the video). Re-read the
  prose against the JSON after every re-measure.
- **Eye checks that restate numeric ranges.** Numbers belong in `targets.json`;
  a range repeated in prose drifts and ends up failing its own example.
- **An operation that doesn't exist.** `processing.set` is an `edit.apply`
  operation, not a command. Run `yap <name> --help` on every name you write.
- **Readable third-party copy in stills.** End cards, diagrams, UI and logo walls
  get blurred (`gblur=sigma=7`), keeping their layout.
- **Images over 960 px.** Tile storyboards with smaller cells, or scale them.
- **Guidance stronger than the measurement.** Don't give a tempo when
  `tempoReliable` is false.
- **Limits that only cover the footage.** Also list each trait the preset asks for
  that Yap's operations haven't been shown to make, with a fallback.

## How the reference maps onto a preset

| isometric-motion | A video preset |
| --- | --- |
| The one idea that matters, two ways it fails | Same, for the style |
| Complete examples you can build | Example folders with every reference above; later, a runnable edit of retained footage |
| `references/walkthrough.md` | Each example README's "What it teaches", and the method above |
| Truth first: one model | `profile.json` → `targets.json` → `check.mjs`, one set of numbers |
| `kit/` | `presets/kit/`, shared by every preset |
| `scripts/capture.mjs`, audit to zero | `measure.mjs` + `check.mjs`, every `FAIL` fixed or explained |
| Concept → object table | Product idea → object, topic → insert |
| Size tiers with time estimates | Clip / episode / series cuts of the same style |
