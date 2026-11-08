# 09 — Change-only cursor samples

Depends on: 08.

## Contract

- The sampler still reads the pointer at 60 Hz. A sample is written only when its projected
  position, buttons, eligibility or geometry epoch differ from the last written sample. The
  first reading of a take and of each resume is always written.
- Samples flush every 500 ms of take time and at seal, not every 30 readings.
- Header `cursorSampling.holds: true`: a sample holds until the next one.
- Readers hold the last sample. Nothing interpolates.
- `cursor.raw`: a page may begin with the sample in force at its start, so a still pointer never
  reads as absent.
- The mark recognizer still receives every reading.

## Seam

- `helpers/mac/Sources/YapCapture/CursorGeometry.swift`: dedup in `CursorTrack.writePending`
  after projection (~300-319), comparing against the last written sample across batches;
  time-based flush replaces `batchSize` (~213, ~288). Stats split `sampled` and `written`.
  `pendingLimit`/`placementLimit` follow `limit-verdicts.md`.
- Readers: `evidence-read.ts:154` `latestCursor` already holds; confirm, don't rewrite.
  `raw-cursor.ts:31` adds the in-force sample. `trails.ts:41` `maximumPoints` and its native
  mirror `FrameTypes.swift:51` become time-based per `limit-verdicts.md`. Index coverage
  (`index-coverage.ts:58-85`) needs no change (still steps add no travel).
- Pointer eligibility after a reset (cut, scene change; `trails.ts:206-212`,
  `presentation-pointer-history.ts:183-198`) must use the sample in force at the reset when the
  journal holds. With every tick written, a fresh sample arrives within one frame after a cut,
  so a still pointer shows; with change-only samples no new sample arrives, so today's rule
  would hide a still pointer until it moves. That is the main risk of this slice; do it first.
  Pauses and geometry epochs need no reader change because the writer always writes a sample
  on resume and on an epoch change. Trails still reset at cuts and scene changes
  (`recording-for-ai/MAP.md:93`): only the pointer itself carries over.
  The stale-pointer branch (`trails.ts:251-285`) calls `prior.at(spanIndex, latest.sourceUs)`,
  which throws for a sample before the kept span (`presentation-evidence.ts:313-320`); clamp the
  held sample's time to the span start instead.

## Run or see

A dense (every tick) and an equivalent change-only journal of the same motion render the same
pointer through production still and presentation planning.

## Verification (red first)

- `CursorGeometryTests.swift`: a still pointer for 10 s writes one sample; a move, button, epoch
  or eligibility change writes one; a 500 ms flush happens with no new readings needed; the
  recognizer sees every reading (`MarkRecognizerTests` unchanged).
- Dense vs change-only equivalence: `trails.test.ts`, `cursor-render.test.ts`, raw cursor page
  tests produce identical pointer output, including a still pointer across a cut, a scene
  change, a trimmed clip start and reordered project clips. Write the still-pointer-after-cut
  case first; it fails before the reader change.
- Old journals (07 goldens) unchanged.
- `CursorGeometryProbe.swift` (dev probe) still runs or is updated to read held samples.

If the visual equivalence check produces shots, run `screenshot-critique` last and
`compare-screenshots` dense vs change-only.

## Delegated

Internal bookkeeping names.

## Stays green

Geometry truth, pause handling, marks, live ink.

## Feedback that would change this slice

If the user later wants a lower sampling rate, change the interval constant; the header already
records it and readers already hold.

## Implementation evidence

The [synthetic conformance evidence](../assets/cursor-holds/README.md) retains native
dense/change-only still and project frames. The cut regression was red first:
dense showed the pointer while sparse returned null. It passes after the hold-aware
reset rule. Portable-page propagation was separately falsified by dropping the
sampling declaration; that regression returned null, then passed when restored.

The active public source adapters use `CaptureSourceRead`, so its raw-page prefix and
the service's cursor overlay follow the same sampling declaration as the retained
trail planner. Old page metadata omits the added declaration; only holding journals
need it. Prefix context does not consume forward-page progress. Held trail endpoints
repeat observed coordinates over elapsed time rather than creating intermediate
positions. Physical gaps remain pointer resets.

Focused verification covers native cursor/header and recognizer selectors, core
trails/raw/portable evidence, native still/presentation rendering with compiler-driven
reordered clips, the public raw/render operations, and all historical byte goldens.
The geometry probe was updated to select the predecessor held sample; live desktop
capture is outside this synthetic verification.
