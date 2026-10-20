# 11 — Prompt from capture facts; `recording.get --wait`

Depends on: 05 (`NOT_READY` with `retryAfterMs`), 08 (take summary).

## Contract

`recording.prompt` never waits and never refuses a take that exists, including live, importing
and failed-import takes. It still refuses with `NOT_FOUND` when there is no recording, and
`UNAVAILABLE` for a discarded take (caller cases). Text describes; it lists no marks, clicks,
times, windows or display ids, and names no operations except the closing skill pointer.

Approved shape:

```
I recorded my screen to show you something. Watch it with Yap and act on what I asked for.
Recording: <id> (3:10, screen, camera, microphone, no system audio).
I left numbered pins and drew on screen while talking. Each one is a moment I'm pointing at.
The transcript is being prepared automatically.
Use the yap skill to work with this recording (or run `yap --help`).
```

Variants: no mic drops "while talking"; pins only or strokes only reword line 3; no marks or an
old summary without the field drops line 3; camera-only and voice-only keep today's openers
(`recording-prompt.ts:46-53`); a live take reads `Recording: <id> (still recording, …)` with
no duration. The transcript line appears only when the mic was captured and auto-transcribe is
on, and after import reflects the real state ("ready", or nothing once it failed).

`recording.get --wait` stays pending while the take is recording, paused or finalizing, or any
`sourceAdmissions[].job` is queued or running. A failed import settles (exit 1) with its
`details.retry`. Waiting never retries.

Agent calls that need the finished take (e.g. `timeline.events`, `acquisition.get` before import)
return retryable `NOT_READY` with `retryAfterMs: 15000` and a message that says what is
happening and "Retry in 15 seconds." (`acquisitions.ts:520` `PREREQUISITE_MISSING` per 01).

⌥⇧V during a live take requests that take's prompt by id.

## Seam

- `packages/core/src/recording-prompt.ts`: `recordingPromptFacts` reads the capture store, the
  take summary, `capture.status` for live takes, the backlog, and auto-transcribe from service
  options (passed in). It no longer needs the acquisition, except for the post-import transcript
  state. Facts shape: `{live, durationUs?, captured, kind?, marks?, transcript}`.
  `renderRecordingPrompt(facts)` stays pure.
- `apps/service/src/project-service.ts` (~1478): passes auto-transcribe.
- `apps/cli/src/wait.ts`: `stillPending` (~21) learns recording states and source admissions;
  add `recording.get` as its own read.
- `apps/macos/Sources/Yap/RecordingControls.swift` `.pastePrompt`: pass the live take's id when
  one is live.

## Run or see

Golden prompt strings, one per variant, in `recording-prompt.test.ts`; a CLI transcript of
`recording.get --wait` from live through ready.

## Verification (red first)

- `recording-prompt.test.ts` table of goldens (all variants above), through production stores.
- `project-service.test.ts` (~124-141): the prompt for an unpublished take now succeeds;
  `NOT_FOUND` with no recordings stays.
- `apps/cli/src/wait.test.ts`: pends through recording and import; failed import settles with
  `details.retry`.
- A live take's `timeline.events` returns `NOT_READY` with `retryAfterMs`.

## Delegated

Punctuation and joining within the approved shape.

## Review

Checkpoint H2: prompt goldens, non-blocking.

## Stays green

Project and asset handoff prompts (`handoffPrompt`), transcript truthfulness (P5).
