# Long takes and honest retries: four-quadrant map

Status: discovery record, 2026-10-20. The build plan is [README.md](README.md); where this map
and the README differ, the README wins. Later decisions recorded only in the README: cursor
stays 60 Hz (Q3 revised; Q11 was withdrawn), retry is explicit (Q4 revised), a stroke ends at 5 minutes
(Q14), data compatibility only with journal schema 4 for new takes.

Origin: a 3:10 take (`99099abb-fb1c-4018-a364-b263dcd58057`) recorded fine but showed
`NOT_READY: Recording has not finished importing` with a Retry button that starts a new
recording. One 11-second ⇧ stroke wrote a 68,916-byte journal line; the importer refuses
lines over 64 KiB; the failure was filed as non-retryable; nothing retries a capture import.
The media and marks are intact on disk.

## Requirements (superseded)

The [current requirements](README.md#requirements) set a 12-hour take and a
5-minute stroke. This discovery record's single-requirement framing is superseded.

## 1. Known knowns

### Contracts this work changes

| Contract | Today | After |
|---|---|---|
| Error envelope (`packages/protocol/src/index.ts:28`) | `code, message, retryable, details` | adds optional `retryAfterMs`; `details.retry: {operation, params}` names the resolving call |
| Retryability (`packages/protocol/src/refusal-ledger.json`) | 51 of 228 codes retryable, unknown codes default false (`refusal-ledger.ts:9`) | non-retryable only when re-running can never succeed |
| Job rows (`packages/core/src/jobs.ts:382`) | store a `retryable` bit at failure (`jobs.ts:294`) | column kept but unread; retryability looked up from `errorCode` |
| Capture journal header | `schemaVersion`, size, source | adds the cursor sampling interval and "samples hold until the next" |
| Cursor samples (`CursorGeometry.swift:154`) | every 60 Hz tick, batches of 30 | 60 Hz, written only on change, flushed every 500 ms |
| Source publication summary (`capture-publication.ts:19`) | members, duration, journal receipt | optional take kind and marks presence, new takes only |
| `recording.prompt` (`recording-prompt.ts`) | refuses until import, lists every mark | never refuses for an existing take; descriptive, no data lists |
| Journal and evidence line/file budgets | 64 KiB, 1 MiB, 256 MiB literals | derived from 12 h or removed |

### Facts from the code

- Retryability is per code in one ledger; the ledger test checks categories but ties none to
  retryability (`refusal-ledger.test.ts:141`).
- `job.retry` already reruns a capture import given the job id from `recording.get`
  (`project-capture.test.ts:540`); it refuses rows stored non-retryable (`jobs.ts:676`).
- `submit()` returns an existing failed job unchanged (`jobs.ts:608`).
- Capture imports are only admitted for sources with no acquisition row
  (`acquisitions.ts:379`), so a failed import is never re-admitted.
- The screen video already contains the macOS cursor (`CaptureInputSession.swift:197`).
  Cursor samples feed the opt-in pointer overlay and trails, agent cursor reads, index
  coverage and ⇧ ink.
- No reader interpolates cursor samples; the frame holds the latest sample at or before it
  (`evidence-read.ts:154`, `CursorOverlay.swift:9`).
- The library catalog is `~/.yap/library/catalog.sqlite`.
- The deleted capture-panel Retry (`RecordingControls.swift:1210`) dates from `c1d0162c`,
  appears after any failure, and starts a recording. No test references it.
- Measured on the origin take: journal 6.25 MB for 3:10 (about 2 MB/min); `pcmAppend` is
  4.3 MB of it (about 94 lines/s); 11,413 cursor samples of which 2,979 (26%) were changes.

## 2. Decision ledger

Delegation: the user said the customer is AI agents and asked the agent to answer as that
customer. Agent answers are scoped to agent-facing behaviour and to questions their
earlier answers settle; each is marked and carries its reason.

| # | Decision | Closed by | Why |
|---|---|---|---|
| Q1 | An error is non-retryable only when re-running can never succeed: bad parameters, a missing reference, deleted. Our files, our code and the machine are retryable. A cancel is retryable. | user (cancel correction: agent) | A fix or a later moment can change the outcome. Cancel → retry is pinned by docs and six tests. |
| Q2 | Cursor samples are written only on change of position, buttons, eligibility or geometry epoch. The header records the interval and "a sample holds until the next". Readers hold the last sample. Batches flush every 500 ms. | user | Any rate is readable, and "didn't move" is never confused with "missing". |
| Q3 → Q11 | Keep 60 Hz with dedup. No interpolation. | user (reopened on evidence) | 15 Hz needed interpolation with pause handling, lost the pointer during window drags, dropped quick ⇧ flicks. Dedup alone cuts 74%. |
| Q4 | Retry is explicit: `job.retry` in the CLI, a Retry button in the app, and `details.retry` in every failure. Requests never rerun a failed job implicitly. | agent | Rerunning on request loops forever: internal callers and pollers resend the same request (`index-frame.ts:8`, `PreviewController.swift:306`, `SKILL.md:208`). The user offered both options. |
| Q5 | Keep finishing interrupted work (deletions, export cleanup, stranded takes, first imports). Remove automatic retries of failures (transcript backlog counter, finalization re-attempt). | user | Finishing what was asked is not retrying a failure. |
| Q6 | Every error shown in the app carries its action: Retry rerunning the exact request, or the fix for a caller mistake. | user | An error with no action makes the product feel broken. |
| Q7 | Copy prompt never waits. | user | Copying is instant; the import finishes in seconds. |
| Q8 | One prompt, descriptive, no data lists. Lines unlock as facts exist. It never names operations except the closing pointer to the skill. D2/D3′ stands. | user | The skill owns how an agent explores. |
| Q9 | No made-up limits. Every bound is derived from the 12-hour take or removed. Readers stream and scan linearly. | user | The 256 MiB budgets broke takes longer than about 2 h 10 min. |
| Q10 | One audit pass with written verdicts: every error code (ledger, helper denylist, app hand-set errors, `JOB_FAILED`, `JOB_INTERRUPTED`) and every byte, count and time limit. | user | The user asked for every error; the same reasoning covers every limit. |
| C2 | Retryability is looked up from the error code. The job-row column stays, unread; input-retention SQL calls the ledger through a registered SQLite function. | agent | A bit frozen at failure lies after an upgrade fixes the cause. No catalog migration, so rollback still opens the library. |
| C3 | Failures name their resolving call in `details.retry`. Not-ready refusals carry `retryAfterMs: 15000` and say "Retry in 15 seconds." | agent (15 s: user) | Agents can't be expected to discover `recording.get → sourceAdmissions → job.retry`. |
| Q12 | Errors with no possible action are prevented by enabling or disabling an existing control, or shown as status text. No new Relaunch action. | user | Don't over-engineer. |
| Q13 | ⌥⇧V during a live take pastes that take's prompt marked "still recording". Agent calls that need the finished take return retryable `NOT_READY` with `retryAfterMs`. `recording.get --wait` waits while the take records or imports. | user | The agent should see it's in progress and know to poll. |
| P1 | Old takes keep their prompt without a marks line when their summary has no marks field. Layout 1 and 2 journals can't have marks. | agent | Published records are immutable; only new takes gain the field. |
| P2 | The transcript line appears only when auto-transcribe is on and the mic was captured, and reflects the real state after import. | agent | Rule P5: never claim a transcript that isn't coming. |
| P3 | The skill's paste section explains: `recording.get`, wait for its import, then `timeline.events`. | agent | Agents act before import now. |
| R1 | Your origin take recovers by pressing Retry on its Library row after upgrading. No recovery code and no database edit. | follows from C2 + Q6 | The user ruled out special recovery logic. |

### The prompt (approved shape)

```
I recorded my screen to show you something. Watch it with Yap and act on what I asked for.
Recording: <id> (3:10, screen, camera, microphone, no system audio).
I left numbered pins and drew on screen while talking. Each one is a moment I'm pointing at.
The transcript is being prepared automatically.
Use the yap skill to work with this recording (or run `yap --help`).
```

Variants: no mic drops "while talking"; pins only or strokes only reword line 3; camera-only
and voice-only keep today's openers; a live take says "(still recording)".

## 3. Unknown knowns

- Consumers: Claude and Codex agents. Error wording and `retryAfterMs` must be followed by
  both.
- Old recordings must keep working: play in the Library, and edit through an agent.
- Done: released, and the origin take imports after upgrading.
- Taste: the prompt describes, it doesn't prescribe or list data. The app never shows an error
  without a way forward. Simplicity beats completeness; text is acceptable where an action
  would add machinery.
- The 12-hour take is the only real requirement; document it in `DEVELOPMENT.md` and link
  it from the capture helper's README.

## 4. Unknown unknowns

### Decided

| Finding | Evidence | Resolution |
|---|---|---|
| A rerun-on-request rule in `submit()` loops on internal submits and pollers | `index-frame.ts:8`, `jobs.ts:1288`, `PreviewController.swift:306`, `jobs.test.ts:1678` | Q4 explicit retry |
| `JOB_INTERRUPTED` missing from the ledger | single-quoted SQL at `jobs.ts:402`, scanner `refusal-ledger.test.ts:89` | add it as retryable; extend the scanner or add by hand |
| Stored bits disagree with the ledger; cancelled rows have no code | `jobs.ts:291-294`, `jobs.ts:1393-1398` | C2; cancel gets a code |
| Retention SQL reads the column | `jobs.ts:1203-1240` | registered ledger function |
| 15 Hz costs | `CursorGeometry.swift:407`, `trails.ts:206`, `MarkRecognizer.swift:192` | Q11 |
| Portable package import re-exports evidence and demands a byte-identical result | `source-admission.ts:84-106` | old journals export unchanged; new fields optional |
| Facts unknown to TS before import | `capture-store.ts:18`, `capture-publication.ts:19` | optional summary fields, new takes only (P1) |
| Skill promises mark lines; doesn't explain waiting for import | `SKILL.md:14-26`, `capability-catalog.md:50` | P3 |
| Failed import shows "Ready" in the Library | `LibraryPresentation.swift:49` | Q6 failed-import row |

### Sharp edges (no decision needed, the build must respect them)

- Removing the line cap: both readers rescan the buffer per chunk (`CaptureJournal.swift:298`,
  `evidence.ts:377`); keep a scan offset. The cap also decides torn tail vs corrupt, and
  recovered takes re-verify that verdict (`CaptureSourcePublication.swift:255`); keep the old
  classification for existing journals.
- More 256 MiB and count caps than first listed: `CaptureSourcePublication.swift:99` (fails at
  stop after about 2.1 h), `CameraMedia.swift` (about 4.7 h of camera mapping),
  `capture-publication.ts:30`, `acquisitions.ts:110`, `source-admission.ts:82`,
  `ClosedCameraSource.swift:52`, 100,000 audio runs (`CaptureAudioMaterializer.swift:263`,
  `acquisitions.ts:759`), 1M presentation records (`presentation-evidence.ts:27`),
  composition-pointer 1M rows (`composition-pointer.ts:27`), ordered pages about 1M cursor
  rows (`ordered-pages.ts:10`), package archive 8 GiB per member (`package-archive.ts:7`),
  native trail 1200 mirrors `trails.ts:41` (`FrameTypes.swift:51`).
- Dedup must run after projection, at batch write (`CursorGeometry.swift:300`). The mark
  recognizer keeps receiving every reading, not the deduped samples.
- `cursor.raw` must include the held sample at the start of a page, or a still pointer reads as
  absent (`raw-cursor.ts:31`).
- `recording-for-ai/MAP.md:92` left "dedup must retain evidence of emphasis" OPEN.
- The client parser strips unknown fields (`packages/client/src/transport.ts:79`):
  `retryAfterMs` must be added to the shared schema as optional. The Swift app drops `details`
  when re-encoding errors (`ServiceHost.swift:414`, `AppSocket.swift:163`).
- `NOT_READY` mixes "wait" with "this pinned implementation is gone"
  (`frame-inspection.ts:980`, `project-preview.ts:144`); split before attaching `retryAfterMs`.
  `exports.ts:984` keys on the code.
- The capture helper's own retry denylist (`CaptureTypes.swift:160`) disagrees with the
  ledger on about 40 codes; the audit reconciles it to the ledger.
- A finalization error stored on shutdown is `RECOVERY_CANCELED` with its own stored
  `retryable` (`capture.ts:558-571`, `protocol/src/capture.ts:106`).
- App errors are a single string cleared by any click and overwritten by background reads
  (`ControlsState.swift:49`, `RecordingControls.swift:438`). Library-triggered errors show in
  the capture panel. A start retry must reuse the start logic (`ControlsState.swift:645`);
  a paste retry is Copy.
- Stopping a take parses the journal about six times and keeps three copies
  (`CaptureSourcePublication.swift:339-381`, `acquisitions.ts:1027`).
- Recording-prompt, retry and cursor docs and tests that pin today's behaviour are listed in
  the sweep reports; update them in the same change as the behaviour.

### OPEN

| Item | What unblocks it |
|---|---|
| Plain-language cause | Resolved: the ledger entry owns `cause` ([slice 04](slices/04-error-envelope.md)) |
| `pcmAppend` volume | Moved to the [limits audit](slices/02-limits-audit.md), decided from the scale probe |
| Free-disk check | Moved to the [limits audit](slices/02-limits-audit.md) |
| Finalization re-attempt at startup | Confirmed by the planning drafts (`capture.ts` `reconcileStranded`); removed in [slice 06](slices/06-job-retryability.md) |

## Build plan (superseded)

Superseded by the [slice ladder](README.md#slice-graph). Kept as discovery history.

### Original sketch

Judgment calls first:

1. Error audit verdicts: every code with its rule-1 verdict and reason, the `NOT_READY` split,
   plain-language text owner. Review before code changes.
2. Limits audit: every bound with its 12-hour derivation, or marked for deletion.
3. Prompt variants and the live-take line.
4. App errors: which are prevented, which become status text, which get Retry.

Mechanical (trust the builder):

5. `DEVELOPMENT.md` section "Limits come from one requirement"; link from
   `helpers/mac/Sources/YapCapture/README.md`.
6. Remove the capture-panel Retry.
7. Ledger changes, the registered SQLite lookup, envelope fields, `details.retry`, client and
   Swift decoding.
8. Remove the transcript retry counter and the finalization re-attempt.
9. Journal readers: linear scanning, no line cap, old tail classification kept.
10. Derived limits and the 12-hour stop.
11. Cursor dedup, header interval, time-based flush, hold semantics in readers, `cursor.raw`
    held sample.
12. Summary fields, prompt rewrite, skill and catalog docs, release note entry.
13. Library failed-import row with Retry.
14. Full run once at the end; release; press Retry on the origin take and confirm Copy
    prompt and Play.

## Implementation request (superseded)

Use the [Next Agent Prompt](README.md#next-agent-prompt) instead.


```
Implement specs/long-takes-and-retries/MAP.md. Write a spec with slices first
(write-spec), starting with the error audit and the limits audit as reviewable
verdict lists before any code changes. Follow write-tests red/green for each
behaviour. Keep the origin take untouched; it is the final acceptance check after
release.
```
