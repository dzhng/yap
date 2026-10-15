# Preview-speed research record

## Contract

- **Objective:** start the launch-video preview as a playable video with audio within 10 seconds.
- **Evaluation:** the real launch revision `8f551f16-a69c-4fa8-ad70-e1178a21c675` from project
  `b071876f-8470-485d-8918-c056168030f4`, rendered through the local service on the owner's Mac.
- **Cold:** a new preview identity, so no derived preview can answer the request.
- **Warm:** the exact same identity requested again.
- **Metric:** wall time from CLI request through delivered MP4; audio must be present.
- **Non-regression:** pinned revision, source bytes, composition timing and audio contract remain
  unchanged; full-canvas export remains available.
- **Current coverage:** one 124.96-second, 1920×1080 launch revision. No visual quality gate has
  been run for the draft sizes yet.

## Hypothesis queue

1. **Draft raster reduction** — tested and insufficient alone. Smaller output should reduce Core
   Image compositing and encoding. Next action: keep the identity-bound option, but do not select a
   smaller default based on speed alone.
2. **Reusable prepared audio** — next if the first-range benchmark remains above target. The cold runs repeatedly execute the complete audio recipe;
   the installed catalog already contains a ready full-range processed audio artifact, but preview
   rendering does not consume it. Prediction: reusing an exact pinned audio result removes a large
   fixed cost while preserving audio bytes and evidence.
3. **Progressive first-range playback** — implemented in the Library controller. It requests and
   plays an honest 10-second receipt, then continues the same pinned revision at the boundary while
   retaining the full-quality export path. The source-service cold/warm timing is still pending.
4. **Draft encoder controls** — pending. Only test after audio/dependency work, since raster trials
   show the current bottleneck is not primarily final pixel count.

## Parameter-effect map

| Candidate | Cold wall time | Warm wall time | Output | Verdict |
| --- | ---: | ---: | --- | --- |
| Full canvas, compact preset | 50.74 s | 0.60 s | 1920×1080, 49 MB | Baseline |
| `maxLongEdge: 960` | 48.46 s | 0.39 s | 960×540, playable with audio | Keep capability; insufficient target effect |
| `maxLongEdge: 640` | 48.13 s | 0.60 s | 640×360, playable with audio | Insufficient target effect |
| `maxLongEdge: 480` | 43.84 s | 0.34 s | 480×270, playable with audio | Insufficient target effect |
| `maxLongEdge: 320` | 38.37 s | 0.28 s | 320×180, playable with audio | Insufficient and unreviewed quality |

The exact full-range `audio.prepare` operation for this revision took **23.53 s** and published a
reusable prepared resource. The public preview request currently has no way to bind that resource;
`preparedResourceId` remains an internal preview binding. This supports the prepared-audio hypothesis
but does not yet measure the combined render with the resource attached.

The full-canvas baseline was measured before the source-service trials through the installed app.
Draft trials used the source service, the same assets and revision, `compact` video settings, and
the CLI `--wait` delivery path. Raw outputs are retained under `/tmp/yap-preview-speed-*` on the
measurement machine.

## Attempt ledger

| Attempt | Parent | Change | Result | Evidence |
| --- | --- | --- | --- | --- |
| baseline | installed service | none; fresh `compact` identity | 50.74 s cold, 0.60 s warm | `/tmp/yap-preview-speed-baseline-1792086393` |
| draft-960 | source service | `maxLongEdge: 960` | 48.46 s cold, 0.39 s warm | `/tmp/yap-preview-speed-trials-1792088106` |
| draft-640 | source service | `maxLongEdge: 640` | 48.13 s cold, 0.60 s warm | `/tmp/yap-preview-speed-trials-1792088106` |
| draft-480 | source service | `maxLongEdge: 480` | 43.84 s cold, 0.34 s warm | `/tmp/yap-preview-speed-trials-1792088106` |
| draft-320 | source service | `maxLongEdge: 320` | 38.37 s cold, 0.28 s warm | `/tmp/yap-preview-speed-trials-1792088106` |
| audio-prepare | source service | full processed output, exact revision | 23.53 s, reusable resource published | `/tmp/yap-preview-speed-audio-prepare.json` |
| progressive-controls | native fixture | 10-second receipt, background full receipt, boundary handoff | focused control test passes; real wall time pending | `apps/macos/tests/preview-controls.test.mjs` |
| first-range-admission | fresh bound source service | launch revision, 10-second range, 960 draft | refused before render: `NOT_READY` because compressor/limiter/normalization capabilities were unavailable; no timing verdict | `/tmp/yap-preview-speed-bound-1792092843/measure/cold.json` |

## Handoff

The implementation currently keeps the 960-pixel Library default because it is a usable draft
size; the research result does not justify claiming the 10-second target. The next discriminating
experiment is a cold and warm first-range request on the launch revision. The fresh source-service
harness now reaches preview admission but refuses this revision because the active native
capability receipt reports its compressor, limiter and normalization processors as unavailable.
`project.get` and `frame.get` remain usable. The first-range wall time therefore needs a
processor-capability/runtime match before it can be recorded. If the first-range wall time remains
above 10 seconds after that repair, bind an exact ready full-range processed-audio artifact and
compare it with the 960 draft parent.
