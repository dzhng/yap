# 12 Prompt operation

**Contract unlocked:** one public operation produces the handoff text; the app and CLI share it.

**Shipped shape:** the prompt contains capture summary facts and mark presence, never
individual marks, clicks, times or windows. An agent waits for the recording and its imports
with `recording.get --wait`, then reads marks with `timeline.events`. The durable retry and
readiness contract lives in [long takes and honest retries](../../long-takes-and-retries/README.md).

**Seam:**
- Core `recordingPromptFacts(recordingId) → { id, durationUs?, captured: { screen, camera,
  mic, system }, kind?, marks?: { pins, strokes }, transcript: none | pending | ready }`,
  reading capture facts and the transcript state (P5); individual marks remain owned by
  `timeline.events`.
- Pure `renderRecordingPrompt(facts) → string`.
- Service operation `recording.prompt { recordingId? } → { text, facts }`; omitted id means the
  latest recording. Name to confirm with the user (README checkpoint). Projects: the same
  operation returns today's one-line ID handoff for a project id (P4).
- Delete `LibraryPresentation.agentPrompt` (`LibraryPresentation.swift:6-10`) and
  `copyAgentPrompt` (`RecordingControls.swift:785-789`); the Library's copy action calls the
  operation.

**Text (D2/D3′).** Describes the captured sources, duration or live status, mark presence and
transcript readiness. It names no operations and gives no "start here" guidance. The exact
renderer and variant goldens live in `packages/core/src/recording-prompt.test.ts`; mark rows
come from `timeline.events` after the recording is ready.

**Verify:** prompt goldens contain no operation names or individual evidence rows, make no
transcript claim when the backlog has nothing, and never wait (D12). Mark reading remains
covered by `timeline.events` and the long-takes-and-retries contract.

**Delegated:** wording within the approved summary shape. The exact variants and goldens are
owned by `packages/core/src/recording-prompt.test.ts`; this slice does not duplicate their
source rows or evidence details.

Settled while implementing: the prompt carries only summary facts and mark presence; the
recording ID is resolved explicitly before evidence reads. The operation takes exactly one of
`recordingId` (optional), `projectId` or `assetId`, so the app passes its `MediaTarget` and
nothing guesses an ID's kind. Copy agent prompt is disabled while the service is down.
