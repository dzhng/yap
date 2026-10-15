# Faster project previews

Status: progressive first-range implementation in progress; target measurement pending.

The experiment contract, hypothesis queue and parameter-effect map live in
[`research.md`](research.md).

## Current handoff

The identity-bound draft raster is implemented and Library playback requests a
960-pixel long edge. Research shows raster reduction alone leaves cold startup
at 38.37 seconds even at 320×180. Library playback now requests a pinned
10-second range, starts it as soon as its receipt is playable, and continues
with the full pinned revision at the range boundary. Reusable prepared audio
remains a supporting optimization, not a replacement for the first-play
contract. Full-canvas export and an explicit `maxLongEdge: null` preview remain
unchanged.

The goal is still open: cold and warm launch-video previews must start with
audio within 10 seconds. The native handoff and focused macOS controls checks
pass; the real first-range cold/warm measurement and draft visual quality review
are still pending.

## The question

Opening a project in the Library waits for a rendered preview before anything plays.
For a two-minute edit that wait is long enough to notice. How do we get to watching
sooner without giving up what a preview promises: the exact pinned revision, its real
composition and sound, and source media left untouched?

## What the owner's projects show

Read on 2026-10-15 from the library and the cached preview files, without rendering:

- **Previews render at the full canvas.** The three launch-video projects render
  1920×1080; "Cursor trail review" renders 3024×1964, the Retina capture size. There
  is no preview resolution today: [output settings](../../packages/composition/src/output-settings.ts)
  choose bitrate presets only.
- **Previews encode like exports.** The cached launch previews are H.264 at about
  8 Mbps (the `balanced` preset) and 135–140 MB for 2:20–2:25 of video.
- **The composition is heavy.** The launch project has 86 clips from 34 assets on
  8 video and 2 audio tracks, with up to 7 video layers at once, plus clip audio
  processing. Its largest sources are 4K HEVC (3840×2160) and 1080p ProRes.
- **The job record keeps no timings.** Jobs store state, not start or finish times, so
  past preview durations can't be recovered. Every preview is re-rendered when the
  revision changes.

## Where the time could go

Each points to a different fix, which is why the measurement comes first:

- **Decoding sources:** several 4K HEVC streams decoded at once to fill a 1080p frame.
- **Compositing:** up to seven layers per frame at canvas size.
- **Encoding:** an export-grade bitrate for something watched once.
- **Waiting on dependencies:** audio preparation, processing or other queued jobs
  before rendering starts.

## Measurement (next step)

Render the launch project's preview once with timing for each stage: dependency
wait, decode, composite, encode and audio. Record the wall time and how it compares
with the program's duration. Run it on the owner's Mac with the real project. It
uses a render, so run it once and keep the numbers here.

### Baseline — 2026-10-15

Measured against the owner's local catalog, project `b071876f-8470-485d-8918-c056168030f4`,
revision `8f551f16-a69c-4fa8-ad70-e1178a21c675` (124.96 s, 1920×1080, 3,746 frames),
using a fresh `compact` preview identity so an existing cached preview could not answer.
The installed service rendered the complete MP4 and delivered it to a local output file.

- Cold render and delivery: **50.74 s** (0.41× program duration), 49 MB output.
- Warm repeat with the exact identity: **0.60 s**, served from the derived cache.
- Native audio report: 5 source descriptors, 1,244,169 decoded frames, 1.84 GB peak resident memory.
- The public job record still has no stage timestamps, so this run establishes the cold/warm
  wall-time gap but does not yet apportion dependency, decode, composite, encode and audio time.

The cold result misses the ten-second target by roughly 5×. The first implementation slice adds
an identity-bound `maxLongEdge` draft limit and makes Library playback request a 960-pixel long
edge; full-canvas exports and explicit `maxLongEdge: null` previews remain available. Progressive
publication remains a separate slice because the current native renderer publishes one complete MP4
atomically.

## Candidate approaches

Ranked by how much of the work each removes, not yet by evidence:

1. **A preview resolution:** render previews at a fraction of the canvas, for example
   half, and decode sources at that size. Helps if decode or compositing dominates.
   The preview's identity must then include its resolution, and an export never uses it.
2. **A draft encode:** a lower bitrate or faster encoder settings for previews only.
   Helps if encoding dominates; cheap to try.
3. **Progressive preview:** render and publish the first seconds first, so playback
   starts while the rest renders.
4. **Live playback:** play the edit from its sources the way a recording with
   separate narration already plays, without a rendered file. Largest change: every
   composition feature would need a live path matching the renderer exactly.

## Must stay true

- A preview shows exactly its pinned revision; a faster path is never a different edit.
- An export never uses preview settings.
- Source media is never changed.
- When a preview is ready, its readiness is honest; a partial one says so.

## Open decisions for the owner

- Which approach, once the measurement is in.
- Whether a lower-resolution preview is acceptable for checking fine detail such as
  caption edges, or needs a full-resolution option beside it.
