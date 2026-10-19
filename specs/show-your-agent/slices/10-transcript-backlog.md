# 10 Transcript backlog: every recording and import transcribed

**Contract unlocked:** D13–D15 and D22. The transcript usually exists before an agent asks.

**Seam:** a core `TranscriptBacklog` owner in an additive catalog table (the catalog creates
additive tables idempotently, `packages/core/src/catalog.ts:2-8`; format stays 29):
`enqueue(selection)`, `drain()`, `state(selection) → none | pending | submitted`.
- Enqueued from recording publication inside `acquisition.import` (recordings bypass
  `asset.import`, `acquisitions.ts:1101-1145`) and from real `asset.import`, not conversions
  (`asset-conversion.ts`). One row per **audio** stream (other kinds throw
  `UNSUPPORTED_MEDIA`, `transcript-processing.ts:66`). Recordings use the selection that
  carries `acquisitionId`, the one agents use, so work joins one job (`:143`).
- Drained, submitting background jobs (slice 09), whenever the model becomes ready: service
  start, after `model.prepare`, after review-triggered preparation (`project-service.ts:394-402,686-689,1426-1429`).
  If the model never becomes ready (non-Mac CLI host, `YAP_AUTO_PREPARE_MODELS=0`, a failed
  download), rows wait; no job is created.
- `transcript.review` keeps reporting `model_not_prepared` correctly because nothing waits on
  the model (`transcript-processing.ts:282-286`).

**Verify:** invert `project-service.test.ts:1370-1409` (import → backlog row → one background
job per audio stream after the model is ready); no model → row persists, no job; a service
restart drains; an empty transcript completes cleanly; an explicit `transcript.transcribe`
joins; non-audio and conversion outputs are never enqueued. Use the fixture model
(`project-service.fixture.ts:94`), no real transcription.

- A background job an app update interrupted (slice 09 lets updates proceed past background
  work) ends failed and retryable; the backlog resubmits it on the next drain.

**Delegated:** table shape.
**Firewall:** no new job queue; the backlog only decides when to submit.
