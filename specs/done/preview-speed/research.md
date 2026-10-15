# Preview-speed research record

## Contract

- **Objective:** start the launch-video preview as a playable video with audio within 10 seconds.
- **Evaluation:** the real launch revision `8f551f16-a69c-4fa8-ad70-e1178a21c675` from project
  `b071876f-8470-485d-8918-c056168030f4`, rendered through the local service on the owner's Mac.
- **Cold:** a new preview identity, so no derived preview can answer the request.
- **Warm:** the exact same identity requested again.
- **Metric:** wall time from the preview request through a delivered MP4 that the
  Library can start with audio; the controller begins playback as soon as that
  receipt is ready, so this measures the open/click-to-playable boundary.
- **Non-regression:** pinned revision, source bytes, composition timing and audio contract remain
  unchanged; full-canvas export remains available.
- **Current coverage:** one 124.96-second, 1920×1080 launch revision, with cold and warm
  first-range measurements, full continuation, focused control tests and visual comparison.

## Hypothesis queue

1. **Draft raster reduction** — tested and insufficient alone. Smaller output reduces the delivered
   rendition cost, but the measured curve does not reach the first-play target by itself.
2. **Reusable prepared audio** — retained as an internal dependency optimization. The launch
   benchmark revision resolved a matching retained prepared resource automatically; the public
   caller did not bind `preparedResourceId`. An isolated no-prepared comparison was not run, so the
   benchmark does not attribute the 3.67-second result to progressive publication alone.
3. **Progressive first-range playback** — implemented and verified on the launch revision. It
   requests and plays an honest 10-second receipt, then continues the same pinned revision at the
   boundary while retaining the full-quality export path.
4. **Draft encoder controls** — not pursued after the progressive path met the target. Raster trials
   show that final pixel count is not the dominant first-play bottleneck.

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
| progressive-controls | native fixture | 10-second receipt, background full receipt, boundary handoff | focused control test passes | `apps/macos/tests/preview-controls.test.mjs` |
| first-range-admission | fresh bound source service | launch revision, 10-second range, 960 draft | refused before render: `NOT_READY` because compressor/limiter/normalization capabilities were unavailable; no timing verdict | `/tmp/yap-preview-speed-bound-1792092843/measure/cold.json` |
| first-range-benchmark | source service, corrected FFmpeg receipt and private scratch path | launch revision, 10-second range, 960 draft | **3.67 s cold**, **0.17 s warm**; 960×540 H.264 + 48kHz stereo AAC | `/private/tmp/yap-preview-speed-first-range-success-1792093973` |
| continuation-benchmark | same source service and pinned revision | full range, 960 draft | **21.28 s** to ready; 960×540 H.264 + 48kHz stereo AAC, revision unchanged | `/private/tmp/yap-preview-speed-first-range-success-1792093973/full*` |

The first-range MP4 was compared frame-for-frame against the same source-service
960-pixel full preview at each second from 0 through 9. Pixelmatch found no
mismatched pixels in the matched frames; the largest structural distance was
the seek-sensitive fourth-second frame, with edge difference below 0.001. The
installed-service full-canvas file was retained as historical evidence only; its
opening imagery differs from the source-service 960 cohort, so it is not the
visual reference for this rendition comparison.

## Handoff

The verified result is the 960-pixel progressive path: the launch revision starts in 3.67 seconds
cold and 0.17 seconds warm, with audio present, and the full pinned continuation remains available.
The earlier refusal was a harness error: the FFmpeg receipt hash was mistyped and the scratch path
went through `/tmp`, whose symlink component violates the package file boundary. The corrected
benchmark uses the verified receipt hash and `/private/tmp`.
