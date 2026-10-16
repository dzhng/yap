# Faster project previews

The Library preview opens the first ten seconds of a project as a playable MP4
with audio, then continues with the same pinned revision and selected range.
The launch-video benchmark reaches first playback in 3.67 seconds cold and
0.17 seconds warm. The first receipt is a 960-pixel-long-edge draft; the full
continuation is rendered in the background. Full-canvas previews and exports
remain available through the public operation.

## Why this shape

A complete launch-video preview took 50.74 seconds from a cold request. Lowering
the raster bound helped only modestly: the matched 320-pixel trial still took
38.37 seconds. The latency target therefore comes from publishing a bounded,
honest receipt early rather than waiting for the complete movie. The continuation
keeps the preview useful beyond the first ten seconds without introducing a live
renderer that could diverge from export composition.

The draft bound is part of the pinned preview identity. A cached 960-pixel movie
must never answer a later full-canvas request merely because both refer to the
same revision. Prepared audio is resolved opportunistically for an exact retained
revision; callers do not have to bind its internal resource ID to the first-play
request, and the receipt still carries the pinned processing evidence.

## Principles and invariants

- The first receipt and continuation identify the same project revision and
  selected project interval; a stale or foreign receipt is rejected.
- A partial receipt is playable and explicitly bounded. The controller only
  hands off after the full receipt is ready, at the partial boundary in the
  selected movie's clock.
- The service range in the preview answer is the fallback boundary when the nested movie
  descriptor does not repeat that range; the handoff remains pinned to the same selected interval.
- Delivery leases are released on close, replacement, invalid answers, playback
  failure and handoff. Source media and project revisions remain untouched.
- Draft preview settings never flow into export. Callers that need the canvas
  request `maxLongEdge: null` through the public preview contract.
- Readiness stays honest: queued, processing, failed and unavailable states do
  not reach the player as if they were a ready movie.

## Pointers

`PreviewController` owns the Library's first-range request, continuation polling,
identity checks, relative handoff seek and lease lifecycle in
[`apps/macos/Sources/Yap/PreviewController.swift`](../../../apps/macos/Sources/Yap/PreviewController.swift).
`PreviewWindow` owns the AVPlayer boundary and end callback in
[`apps/macos/Sources/Yap/PreviewWindow.swift`](../../../apps/macos/Sources/Yap/PreviewWindow.swift).
The preview identity, draft bound and pinned composition admission live in
[`packages/core/src/project-preview.ts`](../../../packages/core/src/project-preview.ts);
the public request contract is described in
[`packages/protocol/src/operations.ts`](../../../packages/protocol/src/operations.ts).
Native control coverage is in
[`apps/macos/tests/preview-controls.test.mjs`](../../../apps/macos/tests/preview-controls.test.mjs),
and cache identity and revision coverage is in
[`packages/core/src/project-preview.test.ts`](../../../packages/core/src/project-preview.test.ts).

## Evidence and visual provenance

The research ledger in [`research.md`](research.md) records the fixed benchmark,
parameter-effect map and raw evidence paths. The retained benchmark montages in
[`assets/`](assets/) compare the ten-second receipt with the matching source
service full preview at each second. They are generated from the real launch
revision; pixel comparison and the recorded visual review found no
candidate-specific difference.

## Dead ends

Raster reduction alone was retained as a rendition capability but rejected as the
latency strategy. Reusing prepared audio was measured as a future optimization,
not required for the target. A live source playback path was rejected because it
would duplicate composition behavior and weaken the pinned-render contract.
