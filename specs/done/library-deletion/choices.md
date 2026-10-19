# Choices ledger

Decisions made during implementation where the spec was silent or turned out to be
wrong. Each entry stands alone. Verdicts: **sound** (keep), **provisional** (revisit at
the named point), **user** (the user may want to weigh in; the recorded call stands
until they do).

## Slice 01: retryability per error code

- **Unknown errors stay retryable** (sound). The spec said errors that aren't a known
  refusal should become non-retryable. That broke 41 tests, each pinning a real
  contract: after an ordinary unexpected failure, an explicit retry must be possible.
  An unknown error may well be temporary. The audit's real problem was known,
  deterministic codes marked retryable, and the ledger fixes those.
- **One code per condition, not per call site** (sound). Where one code had been thrown
  both ways, the two meanings became two codes. The established name keeps
  its established meaning; the new name describes the other condition:

  | Code | Retryable | Condition |
  |---|---|---|
  | `ARTIFACT_CHANGED` / `DEPENDENCY_LOST` | no / yes | a stale pinned identity / an evicted prerequisite that explicit retry rebuilds |
  | `LIMIT_EXCEEDED` / `CAPACITY_EXCEEDED` | no / yes | a fixed size or work bound / temporary capacity (request admission, delivery leases, queue pressure) |
  | `NOT_READY` / `PREREQUISITE_MISSING` | yes / no | a prerequisite that will still arrive / one retrying will not supply (a missing runtime or implementation, an unindexed generation, "prepare first") |
  | `SERVICE_STOPPED` / `OWNER_CLOSED` | yes / no | a lifetime that can reopen / an owner that has closed (capture, delivery, package registry, project packages) |
  | `INVALID_STORAGE` / `PACKAGE_STORAGE_UNAVAILABLE` | no / yes | invalid identity or shape / recoverable package I/O |
  | `INVALID_RESPONSE` / `CONTROL_RESPONSE_INVALID` | no / yes | a malformed reply / an unreadable control answer whose outcome is unknown |
  | `NOT_FOUND` / `ACQUISITION_NOT_FOUND` | no / yes | a durable absence / a donor that can reappear |
  | `INVALID_PATH` / `ACQUISITION_PATH_UNAVAILABLE` | no / yes | a malformed path / donor access that can recover |
  | `MEDIA_WORKER_UNAVAILABLE` / `MEDIA_WORKER_NOT_RUNNABLE` | yes / no | descriptor or process exhaustion / a worker that cannot run |
  | `DEPENDENCY_FAILED` / `DEPENDENCY_REFUSED` | yes / no | a dependency failure explicit retry can repeat / one it cannot (via `dependencyRefusal`) |
  | `RECOVERY_FAILED` / `RECOVERY_REFUSED` | yes / no | per Swift recovery's classification, cause in `details.cause` |

- **Retryability was preserved site by site** (sound). The first draft guessed ledger
  values; a script then compared every literal call at the pre-slice revision with the
  ledger and found 70 sites whose behaviour had silently changed (`UNSUPPORTED_MEDIA`
  made retryable, 23 permanent `NOT_READY`s made retryable, nine capacity limits made
  permanent, and more). Each was renamed to a code with its old meaning:
  `PREREQUISITE_MISSING`, `OWNER_CLOSED`, `CAPACITY_EXCEEDED`, `INVALID_RESPONSE`,
  `DEPENDENCY_LOST` or `PACKAGE_STORAGE_UNAVAILABLE`.
- **One code for temporary capacity** (sound). Request admission, delivery leases and
  queue pressure were three spellings of "capacity is full, retry later", so they
  share `CAPACITY_EXCEEDED`. `LIMIT_EXCEEDED` now means only a fixed bound.
- **Dependency refusals keep their cause** (sound). Eleven sites reported a
  dependency's failure under their own code, with the dependency's retryability.
  `dependencyRefusal` keeps that code when the ledger agrees, and otherwise reports
  `DEPENDENCY_FAILED` or `DEPENDENCY_REFUSED`, with the original in
  `details.dependencyCode`.
- **Recovery answers with a classified pair** (sound). Swift recovery decides retry
  policy from its own deny-list, and the same capture codes mean different things
  outside recovery. Recovery refuses as `RECOVERY_FAILED` or `RECOVERY_REFUSED`, with
  the specific code in `details.cause`, and the service records that cause as the
  take's diagnostic. `NativeFailure` gained string `details` to carry it. Rejected:
  a parity test between the deny-list and the ledger. It failed on 40 codes because
  those codes legitimately mean other things outside recovery.
- **A failed workspace creation is `PACKAGE_STORAGE_UNAVAILABLE`, retryable** (sound).
  It was `INVALID_STORAGE` with a hand-set retryable flag, which the first derivation
  missed because the flag sat on its own line. The draft compensated with a service-side
  rewrite keyed on the error _message_, now removed. A replaced or linked directory stays
  `INVALID_STORAGE`, not retryable, which native tests pin. A directory that changed
  while being opened is `STORAGE_CHANGED`, retryable, as before.
- **`ARTIFACT_CHANGED` is not retryable; an evicted prerequisite is `DEPENDENCY_LOST`**
  (sound). A stale pin never succeeds on an identical retry. Acoustic inspection's
  "prerequisite was evicted" is rebuilt by an explicit retry, which is a different
  condition.
- **Single-word codes are scanned where refusals are built** (sound). The ledger
  scanner only matched codes containing an underscore, so `TIMEOUT`, `UPDATING`,
  `UNAVAILABLE`, `ABORTED`, `CANCELED` and `CONFLICT` were missing and silently
  defaulted to not retryable. They are now recognised as the first argument of an
  `Error`, `operationError` or `NativeFailure` constructor.
- **Test fixtures throw real codes** (sound). Seven invented test codes had been
  added to the product ledger. Fixtures now throw real codes with the retryability
  they need (mostly `MEDIA_WORKER_FAILED`), and the ledger test requires every code to
  appear in product source.
- **New deletion codes arrive with their slices** (sound). The ledger test forbids codes
  that no product code throws, so `DELETE_IN_PROGRESS`, `IN_USE`, `ASSET_DELETED` and
  `MODEL_IN_USE` enter in slices 03, 04/08 and 11.
- **Malformed CLI replies are `INVALID_RESPONSE`; an unrunnable worker is
  `MEDIA_WORKER_NOT_RUNNABLE`** (sound). Both had shared a retryable code with
  temporary failures. Exhausting descriptors or processes stays
  `MEDIA_WORKER_UNAVAILABLE`, which is retryable.
- **`CONNECTION_CLOSED` and `CONNECTION_ERROR` are retryable** (sound). The CLI had
  always treated every `CONNECTION_*` error as retryable, and the ledger now records
  that.
- **Re-throws that forced retryability were checked too** (sound). The first site
  comparison only covered literal codes. A second pass found base re-throws that kept a
  dynamic code but forced `retryable: true`. Assembly cleanup stays retryable through
  `dependencyRefusal` (an export's recovery is pinned as retryable until its owned
  identity returns). `FFMPEG_UNAVAILABLE` is retryable, as it was everywhere it was thrown.
  Recording deletion, export retirement and failed workspace admission keep their pinned
  codes and take the ledger's retryability for them; their intents stay durable, so
  startup resumes them regardless.

## Slice 02: deletion coordinator and plans

- **Plan phases are `planned`, `tombstoned`, `drained`, `files` and `rows`** (sound).
  Each phase is written only after its work is complete, so a restart repeats at most
  an idempotent phase and never reports success before the plan row is cleared.
- **The test seam reports boundaries as `check`, `plan`, `tombstone`, `drain`,
  `files`, `rows` and `clear`, before and after each durable phase write** (sound).
  The hook is constructor-only and has no public operation or persisted effect.
- **Project `deletedAt` remains its durable tombstone** (sound). Project row
  retention is existing request/history behavior; clearing the deletion plan is the
  coordinator's terminal cleanup for projects, while recording tombstones are removed
  by their existing final row cleanup.
- **Existing tombstones are adopted as `tombstoned` plans** (sound). This keeps
  legacy markers on the same active-map, scoped retirement and paged resume path
  without a second cleanup implementation.
- **Recording source retirement owns one scope across all post-tombstone phases**
  (sound). Queue drain happens immediately before `CaptureSources.retire`; its
  lifetime and retiring fence then cover quiesce, file removal, row cleanup and
  finish, including retries after a phase fault.

## Slice 03: deletion fence

- **The fence starts at `tombstoned`, not `planned`** (sound). A `planned` plan has not
  yet committed to deleting, so it refuses nothing. Every later phase fences.
- **`DELETE_IN_PROGRESS` is a retryable conflict, with `{assetId}` or
  `{acquisitionId}` in its details** (sound). A caller retries after the deletion either
  finishes (and the retry fails as not found) or is abandoned (and the retry succeeds).
- **Synchronous callers are tested by order, not latches** (sound). Revision publish,
  `jobs.retainInputs` and package adoption each retain inside one synchronous SQLite
  transaction, so a tombstone cannot land mid-call; tombstoned-before and
  cleared-after cover every interleaving. Asset publish has real async gaps, so its
  two orderings race staging against `AssetStore.unlinkFile` and check rows and files
  agree before and after a restart.
- **Publish keeps a second tombstone check after staging** (sound). Staging links the
  file under the publication lock, and the row is written later. If deletion wins in
  between, publish refuses and removes a file it linked for a row that never existed.

## Slice 04: who uses this?

- **Byte counts ask the owners deletion uses** (sound). `LibraryUsers` takes one required
  `files` dependency (asset, acquisition, recording and project paths), built in the
  service from `AssetStore.path`, `AcquisitionImporter.managedPaths`,
  `ManagedFiles.recordingPaths`, and the project index and derived cache's `ownedPaths`.
  The first draft guessed the library folder from an arbitrary asset row and counted a
  recording as 0 bytes in a catalog without assets.
- **The recording path is mirrored, not shared** (provisional, slice 09). The native
  helper removes a recording's folder in Swift, so `ManagedFiles.recordingPaths` repeats
  the same layout in TypeScript. Slice 09, which takes recording copies, should test that
  the two agree.
- **The screenshot index has one owner for its directory layout** (sound). Lookup and
  `ownedPaths` both build from one `parts()` helper; the draft's second copy is gone.
- **Only a missing path counts as 0 bytes** (sound). Any other file-system error
  propagates.
- **No caching** (sound). The query reads current ownership directly; it runs once per
  delete request or confirmation.
- **Results are project-level with a revision count** (sound, as the spec decided).
  Entries sort by id; acquisitions and derived assets use `{kind, acquisitionId}` and
  `{kind, assetId}`.

## Slice 05: one paging contract

- **A continuation repeats every request parameter except `limit`** (sound). The cursor
  stores a digest of the request's filters (`pageFilters(params)`: everything but
  `cursor` and `limit`, key order and undefined fields ignored). A mismatch is
  `INVALID_PARAMS`; `ARTIFACT_CHANGED` is only a stale pin, meaning the evidence the
  cursor pinned was republished or replaced. Filters are bound once in
  `pageCursor.encode/decode`, so no reader checks them on its own. Several evidence
  readers had answered a filter change with `ARTIFACT_CHANGED`; they were split into a
  filter check and a pin check, and `speaker.get`'s description, `pageParams()` and the
  skill now state the rule.
- **Cursors are canonical JSON with a SHA-256 integrity digest, in base64url** (sound).
  They detect tampering and foreign scopes; they are not secret, since the caller owns
  the library.
- **Library listings are newest first; ordered evidence keeps its meaningful order**
  (sound). Projects and assets page by descending sequence, exports by descending rowid,
  presets and models by id (neither has a creation sequence). Segments, revisions and
  evidence keep ordinal order.
- **Readers own the envelope** (sound). Each reader takes the opaque cursor and returns
  `{<plural>, nextCursor, ...facts}` itself. The draft's service-side page flattener and a
  runtime result re-validation keyed on a duplicated list of collection names were
  removed; the conformance test is the proof.
- **Index pages stop early at the response frame budget** (sound). `index.get` and
  `face.trajectory.get` moved from a 200 cap to the shared 1–1000, so a page also ends
  when its serialized size approaches `RESPONSE_FRAME_BYTES`, returning a cursor.
- **Conformance is driven by the schema** (sound). `hasPageParams` finds every paged
  operation; each needs a fixture or a named exclusion. 18 run against a live service.
  Five (`index.get`, `index.coverage`, `face.trajectory.get`, `audio.pause.get`,
  `transcript.render.get`) need native analysis to seed, and each exclusion names the
  core reader test that runs the same checks.
- **The conformance work found nine paging bugs** (sound, fixed). Among them:
  `transcript.review` ignored its cursor; disfluency, `index.coverage` and correspondence
  continuations were refused; `transcript.render.get` and `face.trajectory.get` dropped
  their pinned generation; several readers capped limits below the schema's 1000.
- **`preset.list` is paged** (sound). It landed from main after the spec; it pages like
  `model.list`.

## Slice 06: one async vocabulary

`WorkState` is the protocol vocabulary. Stored catalog strings remain unchanged and are mapped
once at the service or app boundary:

| Stored vocabulary     | Old word                                                                                                                | WorkState     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| JobQueue              | `waiting`, `queued`                                                                                                     | `queued`      |
| JobQueue              | `running`                                                                                                               | `running`     |
| JobQueue              | `ready`                                                                                                                 | `ready`       |
| JobQueue              | `failed`                                                                                                                | `failed`      |
| JobQueue              | `unavailable`                                                                                                           | `unavailable` |
| JobQueue              | `canceled`                                                                                                              | `canceled`    |
| Artifact readiness    | `not_requested`                                                                                                         | `idle`        |
| Artifact readiness    | `queued`, `not_ready`                                                                                                   | `queued`      |
| Artifact readiness    | `processing`, `preparing`, `opening`, `closing`, `cleanup_pending`, `updating`, `checking`, `downloading`, `installing` | `running`     |
| Artifact/model/preset | `ready`, `complete`, `completed`, `committed`, `installed`                                                              | `ready`       |
| Model lifecycle       | `absent`                                                                                                                | `unavailable` |
| Model lifecycle       | `preparing`                                                                                                             | `running`     |
| Model lifecycle       | `ready`                                                                                                                 | `ready`       |
| Model lifecycle       | `invalid`, `failed`                                                                                                     | `failed`      |
| Skill lifecycle       | `updating`                                                                                                              | `running`     |
| Skill lifecycle       | `installed`                                                                                                             | `ready`       |
| Skill lifecycle       | `missing`, `unmanaged`, `disabled`                                                                                      | `unavailable` |
| Skill lifecycle       | `needs_attention`                                                                                                       | `failed`      |
| CLI lifecycle         | `installed`                                                                                                             | `ready`       |
| CLI lifecycle         | `missing`, `different`, `unavailable`                                                                                   | `unavailable` |
| CLI lifecycle         | `needs_attention`                                                                                                       | `failed`      |

The rule is: a word is a `WorkState` only when it says where some work is in its lifecycle.
Domain facts remain separate and keep their existing words. The protocol fields that carry those
facts are:

| Status owner | Fact field | Stored fact words (unchanged) |
| --- | --- | --- |
| Skill | `installation` | `installed`, `missing`, `unmanaged`, `disabled`, `needs_attention` |
| CLI | `installation` | `installed`, `missing`, `different`, `unavailable`, `needs_attention` |
| Model | `presence` | `absent`, `ready`, `invalid` |
| Update | `availability` | `available`, `disabled`, `unavailable` |

The lifecycle `state` on each of those records is the mapped `WorkState`; the fact field is never
collapsed into that lifecycle word.
`idle` means no work has been requested, `queued` means admitted work is waiting, `running` means
an attempt is active, and `unavailable` means the requested result cannot currently be supplied.
Every async status carries `jobId`; app-owned operations expose their native operation identity
through that field.

- **Unknown stored words throw** (sound). A stored state with no mapping is a bug in the
  mapping, not a failed job, so `mapWorkState` throws instead of reporting `failed`.
- **`job.retry` reuses the owner's retry where one already repaired prerequisites** (sound).
  For an export job it runs `MediaExports.retry`, which re-runs a failed audio or preview step
  and keeps the export's abandon and owner fences. For rendered recognition it re-runs a failed
  PCM extraction, as `transcript.render.retry` did, because the item's status names only the
  recognition job. Every other job is re-queued directly. Rejected: a general "retry the failed
  dependency" rule; no other owner needed one.
- **A ready `index.get` carries the `jobId` its status reported** (sound). A continuation page
  names no job (`jobId: null`). The ready read had dropped it, so a caller could not retry from
  a read.
- **Every removed `*.retry` has a recovery test through `job.retry`** (sound). Each drives the
  item to `failed`, retries the `jobId` the item's own status returned, and checks it reaches
  `ready`. Writing them found the two `job.retry` gaps and the missing `jobId` above.
- **Model `presence` reads the installed files** (sound). Core's model status has one word
  for both lifecycle and files, so while preparing or after a failed preparation the
  service asks `Models.presence`, a metadata-only receipt check, instead of copying
  `preparing` or `failed` into a field whose schema allows only `absent`, `ready` and
  `invalid`.
- **`batch-prepare` manifests are not migrated** (sound, hard cutover). A manifest written
  before this slice that still holds `not_requested` or `processing` will not resume
  correctly; rerun the batch. The sweep also fixed a real bug there: a transcript request
  interrupted before it reached the service reads back `idle`, and is now sent again.

## Slice 07: identity, naming and result shapes

- **Replay identity is `requestId` for every write, including exports and speaker bindings** (sound). Export status continues to use the generated `exportId`; the request ID is the durable replay key.
- **Preset deletion reports its existing Trash outcome** (sound). Presets move to macOS Trash, so they keep a `trashed`-style result rather than claiming permanent deletion.
- **Range names follow the clock, not the numeric representation** (sound). `range` always names a project-clock interval and `sourceRange` always names a source-clock interval; both clocks retain their existing integer-µs or rational representations. Side-labelled correspondence anchors keep `leftRange` and `rightRange` because the side is part of their identity.
- **Delete byte accounting is measured before the deletion plan runs through `LibraryUsers` owners** (sound). Project and recording results report the measured `freedBytes` from the same paths the coordinator removes.
- **`artifact.renew` and `update.check` are request-identified writes, not target-idempotent operations** (sound). Renewal extends a lease deadline and a check performs a fresh updater attempt; repeating either can change state, unlike `artifact.close` or a preference setter.
- **The public export identity is generated from `requestId`** (sound). `exportId` is a read/status identity only; `export.create` no longer accepts it as an input.
- **Rational source selections use `sourceRange` at every public audio/alignment boundary** (sound). Core owners continue to use their internal `range` field after the service translates the public name.
- **Public delivery metadata uses `sizeBytes`, `expiresAtMs`, `offsetBytes` and `nextOffsetBytes`** (sound). These fields carry byte and epoch units explicitly; internal buffers may retain shorter local variable names.
- **Correction and sampled-text identities are `correctionId` and `textId`; issue caps use `maxIssueCount`** (sound). These are public records/params and must not expose a bare `id` or an unqualified count.
- **Native capture discovery uses noun IDs at the wire boundary** (sound). `CaptureController` emits `displayId`, `windowId`, `cameraId` and `microphoneId`; the macOS controls decoder translates those into its existing local `ControlsState` fields, which remain implementation-local names.
- **Native picture and face observation Codable records use `regionId` and `faceId`** (sound). The retained observation structures and calculations keep their local identity variables, while the JSON encoder/decoder boundary emits and accepts only the public noun names. The retained picture control receipt was migrated once to the new public names.
- **Evidence retained before the noun-ID cutover is stale, not migrated** (sound). The renderers that emit observation records moved their pins (`native-source-picture-v8-cursor`, `native-source-image-v3`, `native-composition-picture-v22`), so a fresh `frame.get` or `index.get` regenerates instead of reusing a bare-`id` receipt. A read that names an older index generation or cursor (`index.get`, `index.frame(s)`, `face.trajectory.get`) refuses with `ARTIFACT_CHANGED` when a retained frame record fails the domain's current strict retained-frame schema; requesting the index again regenerates it. Old renderer pins whose records still parse stay readable.
- **Content-addressed operations are classified as idempotent instead of accepting an unused replay key** (sound, user verdict). Repeating the same input joins the same job or evidence receipt; only operations that can create a second thing or apply a change twice carry `requestId` and use the existing request-identity owner.
- **`update.check` has no non-identity input to conflict on** (sound). Its replay test proves a repeated `requestId` returns the saved native result without another check; the strict schema leaves no second parameter whose differing value could form a request conflict.

The operation classification is explicit and exhaustive. `readOnlyOperations` is:

`project.get`, `project.list`, `inspect.open`, `caption.propose`, `layout.diagnostics`, `processing.get`, `output.capabilities`, `processing.capabilities`, `acquisition.get`, `asset.get`, `asset.segments`, `asset.origins`, `asset.list`, `job.get`, `export.list`, `export.status`, `package.status`, `storage.usage`, `index.get`, `face.trajectory.get`, `index.coverage`, `index.frame`, `index.frames`, `correspondence.get`, `alignment.get`, `speaker.continuity.get`, `speaker.get`, `join.verify`, `transcript.render.get`, `transcript.get`, `transcript.disfluency.get`, `transcript.search`, `preset.list`, `preset.get`, `model.list`, `model.status`, `preview.get`, `audio.get`, `frame.get`, `waveform.get`, `spectrogram.get`, `audio.pause.get`, `artifact.read`, `timeline.events`, `cursor.raw`, `login.status`, `update.status`, `skill.status`, `cli.status`, `service.health`, `service.tools`, `capture.sources`, `capture.status`, `recording.list`, `media.list`, `recording.get`, `revision.get`, and `revision.history`.

`idempotentOperations` is:

`asset.convert`, `correspondence.prepare`, `alignment.observe`, `speaker.continuity.prepare`, `speaker.observe`, `transcript.render.prepare`, `transcript.transcribe`, `transcript.review`, `frame.batch`, `cursor.render`, `voice.generate`, `audio.extract`, `audio.prepare`, `audio.measure`, `job.retry`, `job.cancel`, `export.cancel`, `export.abandon`, `package.close`, `model.prepare`, `artifact.close`, `login.setEnabled`, `update.setEnabled`, `skill.install`, `skill.uninstall`, `skill.update`, `cli.install`, `cli.uninstall`, `capture.pause`, `capture.resume`, `capture.setCamera`, `capture.stop`, `capture.cancel`, and `recording.cleanup`. The first group is content-addressed work whose same input joins one job/evidence receipt; the remaining entries repeat a target state without another change.

Every remaining catalog operation takes `requestId` and replays through its existing owner, or refuses a conflicting parameter set: `project.create`, `project.delete`, `edit.apply`, `speaker.correct`, `text.seed`, `acquisition.import`, `asset.import`, `export.create`, `export.recover`, `package.open`, `package.adopt`, `recording.delete`, `transcript.import`, `speaker.bind`, `preset.update`, `preset.create`, `preset.delete`, `artifact.renew`, `update.check`, `capture.start`, `capture.restart`, `edit.undo`, `edit.restore`, `model.remove`, `asset.delete`, and `project.duplicate`.

### Range inventory and naming

| Operation | Field(s) | Type | Clock | Chosen public name |
|---|---|---|---|---|
| `preview.get`, `inspect.open`, `audio.get`, `audio.pause.get`, `transcript.get`, `transcript.search`, `index.*`, `timeline.events`, `cursor.raw` (project selectors) | `range` | `{startUs,endUs}` | project clock | `range` |
| `sourceCaptureParams` (capture/event source selectors) | `sourceRange` | integer `{startUs,endUs}` | source clock | `sourceRange` |
| `audio.get`, `audio.extract`, `audio.measure`, `waveform.get`, `spectrogram.get`, `audio.pause.get`, `alignment.*`, `speaker.*`, `transcript.*` (source selectors) | `sourceRange` | rational `{startUs,endUs}` | source clock | `sourceRange` |
| `correspondence.prepare` endpoints | `sourceRange` | rational `{startUs,endUs}` | source clock | `sourceRange` |
| `correspondence` anchors | `leftRange`, `rightRange` | rational `{startUs,endUs}` | source clock | side-labelled names retained |
| `frame.get`, `frame.batch`, `cursor.render` | `atUs` | integer µs point(s) | source or project selector clock | `atUs` |
| `layout.diagnostics`, `timeline.events` project rows | `projectAtUs` | integer µs point | project clock | `projectAtUs` |
| transcript execution context | `beforeUs`, `afterUs` | integer µs durations | source clock context | unit-suffixed scalar names retained |

The public rule is clock-based: `range` means a project-clock interval and `sourceRange` means a source-clock interval. Numeric representation follows the clock and does not choose the field name. Top-level project start/end pairs use the `range` object; rational source selections remain exact.

### Generation identity

Evidence and publication generations remain strings under the single public field `generation`. The numeric job-attempt counter is renamed `attemptGeneration` in wait metadata and adapter job summaries; it is not evidence identity.

### Operation classification

`readOnlyOperations` contains every operation that only reads retained state/evidence. `idempotentOperations` contains content-addressed repeats and target-state no-ops. Every remaining operation is a changing operation and carries a required `requestId`; the operation's existing owner replays the original result or refuses a conflicting request.

- **`recording.get` without an id and no take refuses `NOT_FOUND`** (sound). The latest-take shorthand has the same absence contract as an id-specific get; macOS callers treat that refusal as “no take yet.”
- **Stored job results use the slice 07b names and old payloads are stale** (sound). Retained receipts use `sizeBytes`, `frameCount`, and sample-count range endpoints; old shapes are never parsed. Renderer/job pins moved with the cutover: `verified-wav-copy-v2`, `verified-whole-source-v2`, `native-source-audio-v6`, `native-finite-pcm-v2`, `native-acoustic-image-v2`, `native-source-image-v4`, `native-source-picture-v9-cursor`, `transcript-v5`, and `project-transcript-v4`.

Implementation follow-up: retained audio, acoustic, frame, index, transcript and rendered-speech producers publish unit-bearing names directly and reject obsolete retained shapes. Internal materializers read the retained public receipt into their native types at the owner boundary; public readers keep the unit-bearing record. Project edit receipts persist the same `entityId`/`changeId` shape they return, including replay and historical reads. The service suite is green (51 files, 366 passed, 24 skipped), core is green (93 files, 969 passed, 1 skipped), CLI is green (6 files, 122 passed), and the ordered tool, Yap, eval, formatting, native and macOS checks are complete. The macOS suite is 144 passed, 1 skipped and the one permitted failure remains the killed-while-stopping recovery case. No compatibility translator was reintroduced.

## Slice 08: asset deletion

- **Cascade ownership stays in `LibraryDeletion`** (sound). Asset retirement records members and the coordinator invokes the registered project, asset and acquisition retirements, so there is one crash-resumable deletion path.
- **The subject's own files and rows finish before cascade members run** (sound). The asset is fenced and removed first; recorded members then retire through their own owners without sharing a second asset cleanup path.
- **Member traversal uses the plan's stable `(memberKind, memberId)` order** (sound). Replaying the same plan sees the same members and can safely skip members already retired before a crash.
- **Row cleanup uses 256-row pages** (sound). The page matches the existing owner-reference and job-retirement bounds and keeps each resume turn bounded.
- **Asset retirement force-purges retained evidence** (sound). Once the asset is tombstoned, no retained transcript, scene, index, alignment, speaker or cache reference can outlive its source asset.
- **Cascade results report `cascadeFreesBytes`** (sound). A cascade removes every user recorded by the refusal query, so its byte result must match the same measured closure the refusal exposed.
- **`ASSET_DELETED` is a non-retryable conflict and `IN_USE` is a non-retryable destructive refusal** (sound). A deleted import request cannot be replayed, while a live owner requires an explicit cascade decision.
- **Finished deletion request results live in the durable deletion-plan owner** (sound). Replaying the same request after restart must return its saved `freedBytes` even after the subject row and plan are gone.

## Slice 09: recording deletion

- **Shared content-addressed assets survive while another acquisition owns them** (sound). The retiring acquisition releases only its ownership reference, so an independent import keeps the shared bytes and row.
- **Recording-owned copies retire without a public cascade while projects require it** (sound). A recording owns its unused capture acquisitions, but a project or derived asset is a user that needs explicit cascade intent.
- **Legacy markers have no members and keep the old semantics** (sound). Startup adopts a marker without reconstructing the new ownership plan, so it finishes the historical recording-only cleanup.
- **Derived assets count as recording users** (sound). HDR conversions and generated voice assets remain users of their source and therefore produce the same `IN_USE` refusal as asset deletion.

## Slice 10: project duplicate

- **The default duplicate title is the source title followed by ` copy`** (sound). The wording is explicit, stable and keeps the source title intact while making the new project distinguishable in listings.

## Slice 11: model removal

- **`model_removals` is additive and request identified** (sound). It is created with
  `IF NOT EXISTS` and has `modelId TEXT NOT NULL`, `requestId TEXT NOT NULL UNIQUE`,
  `removedAtMs INTEGER NOT NULL`, `freedBytes INTEGER NOT NULL`, nullable
  `completedAtMs INTEGER`, and nullable `clearedAtMs INTEGER`, with a composite primary
  key of `(modelId, requestId)`. A row is an unfinished removal until `completedAtMs`
  is set. Service startup finishes every unfinished removal before any preparation can
  start (synchronously in the `Models` constructor, where no flight exists), so a later
  replay only returns the receipt and can never undo a model prepared after the restart;
  `freedBytes` then counts the bytes still there at restart. A completed row is
  the request receipt forever. The removal fence is a completed row whose
  `clearedAtMs` is NULL; explicit `model.prepare` sets `clearedAtMs` and keeps every
  receipt for replay.
- **Model removal keeps staging names model scoped** (sound). Preparation stages under
  `models/.staging/<modelId>/<flightId>` so `freedBytes` can include only the selected
  model's in-flight staging while `storage.usage.modelBytes` counts all model bytes.
- **`Models` always owns a catalog connection** (sound). The constructor requires the
  shared `Catalog`; model removal cannot silently run without durable request receipts
  or a persistent preparation fence.

## Slice 12: media.list

- **The merged tie-break is `kind:identity` ascending after `createdAt` descending** (sound). `kind` keeps recordings and imports in one deterministic order, and the stable identity suffix makes equal timestamps and cross-kind boundaries cursor-safe.
- **Media byte measurements use the deletion owner** (sound). `MediaListing` receives the service's `LibraryUsers.usersOf(subject).freesBytes` callback and invokes it only for rows on the returned page. This is the same path inventory used by asset and recording deletion; stored publication and asset metadata byte fields are not size owners. `durationUs` remains measured from the retained capture record for recordings and stream timing metadata for imports; titles remain the capture timestamp and import provenance basename.

## Slice 13: imported videos in the Recordings tab

- **The tab reads `media.list`, then `recording.get` for each recording on the page** (sound). `media.list` carries order and measured facts; a recording's status, sources and finalization come from the recording itself, so the existing status presentation and the source-job tick keep one owner. A page costs at most five extra reads.
- **An import plays the library's own copy, located through `asset.get`'s `fileName`** (sound). The app already plays recordings from the library folder; `asset.get` already returns the immutable file name, so no service change was needed.
- **Badge and detail line** (sound, delegated). The "Imported" badge is a small accent chip right after the title (light text on a muted accent in dark mode, as in the mock). The detail line reads duration · size · "imported <date>", matching the mock, though the word repeats the badge; the mock shows both.
- **Long import titles truncate in the middle** (sound). A filename's ending (version, extension) is what tells two imports apart; the unprimed critique flagged tail truncation hiding it.
- **The storage footer shows three lines: total, media, models** (sound). The sidebar is too narrow for the mock's single line; the critique found the one-line split truncated.
- **Recording rows gain Delete, retried as "Retry Delete" after an unconfirmed delete** (sound). Same deletion state machine and request identity as projects; the confirmation dialog is slice 14.
- **Review** (non-blocking). Before/after comparison against the mock's requirements: candidate accepted. Unprimed critique: dark-mode badge contrast and long-title truncation fixed; the subtle "Deleting" status and short-window scrolling are existing behaviour shared by every row, outside this slice's variable. Shots: [assets/13-app-rows](assets/13-app-rows/).

## Slice 14: one delete confirmation

- **Wording follows the approved mock** (sound). Plain: "Delete “name”?", what is removed with its measured size, "Your original file isn’t touched" for imports, "This can’t be undone." Cascade: "This <kind> is used by:", one line per project ("Project “title” — N revisions"), "Deleting it also deletes these projects (size total)", button "Delete all". The unprimed critique questioned "Delete all", the cascade sentence and naming a recording by its time; those are the mock's approved choices and stay.
- **Users the refusal names only by count are said as a count, never as projects** (sound). Derived files and recording sources appear as "N files made from it" / "N recording sources", so the dialog never invents a project or lists assets on its own.
- **A project's plain dialog names no size** (questionable). `project.list` carries no size and the app makes no query of its own; the cascade dialog always has the refusal's total.
- **The cascade is its own request** (sound). It follows a refused plain delete with different parameters, so it gets a new `requestId`; retrying either keeps that request's identity. "Retry Delete" resends the already-confirmed request without asking again; a declined cascade restores the row.
- **The users list is an accessory text view with a hanging indent** (sound). Plain informative text wrapped a long project line back under its bullet (both reviewers flagged it); the count is kept with its project by non-breaking spaces.
- **Destructive button contrast is unverified live** (known). The harness renders the alert in an inactive offscreen window, where AppKit draws the destructive button pale; in the app it is a sheet on the active Library window.
- **Review** (non-blocking). Mock comparison: accept with the list-wrap fix, done. Shots: [assets/14-delete-dialog](assets/14-delete-dialog/).

- **Audio and acoustic producers keep an internal working type behind one typed boundary** (sound, reviewed). `audio-inspection.ts` and `acoustic-inspection.ts` write and read the stored/public record (`sizeBytes`, `frameCount`, `{startSamples,endSamples}`) through one explicit converter per record type inside the owning module; their internal artifact types keep `bytes`/`frames`/`{start,end}` for the media math. There is one stored and one public shape, no unit is guessed, and an old stored shape is refused `ARTIFACT_CHANGED`. Renaming every internal use across core was judged churn without a contract benefit; a service-level key translator (tried twice) was rejected.

## Review findings resolved

- **Recording member deletes inherit the parent cascade mode, and recording-owned resources are fenced at tombstone time** (sound). A plain `recording.delete` therefore refuses a newly used acquisition/member instead of silently cascading into its project. The fence is durable in `resource_fences`, so a reference admitted during drain cannot race the retirement plan; surviving shared assets are unfenced when their acquisition retires, and deleted resources clear their fence.
- **Asset cascades preserve sibling assets** (sound). When an acquisition is reached through an asset cascade, its tombstoned initiating asset is retired without cascading into the acquisition's other asset members. The acquisition row and its references still retire, while sibling assets remain available to their own users.
- **Recording byte results ignore the recording's own acquisition owners** (sound). `LibraryUsers` treats acquisition owners in the subject's own closure as non-live, so `freedBytes` matches the storage removed by a plain recording delete.
- **Cascade mode is part of deletion identity** (sound). Active and persisted plans refuse a request whose `cascade` differs from the planned mode with `REQUEST_CONFLICT`; callers in either order cannot coalesce incompatible intent.
- **Preset request receipts are durable local state** (sound). `Presets` stores replay inputs and results in an atomic receipt file beside the local preset store, allowing a reconstructed facade to return the original result without creating or updating a second preset.
- **Model preparation and removal share one per-model flight** (sound). Removal serializes concurrent requests, cancels and waits for an existing preparation, and preparation waits for an unfinished removal. Only explicit `model.prepare` clears the removal fence; automatic review preparation does not.
- **Shape cleanup keeps one owner per public field** (sound). Prepared audio, extracted audio, retained screenshots and alignment PCM publish and consume their unit-bearing names directly; obsolete stored names refuse as stale artifacts. Package adoption passes the retained screenshot shape through its core owner instead of translating keys in the service.
- **Users, byte accounting and paged reference cleanup each have one owner** (sound). `LibraryUsers.hasUsers`, required deletion byte callbacks, and `ResourceReferences.releaseResourcePage` are shared by every registration; unused recording path and acquisition marker adapters were removed. Media listing delegates recording visibility to `CaptureStore.listable` and only retains the deletion-plan check needed for crash resume.

## Slice 15: skill recipe and evals

- **Eval prompts state the user's goal, not the steps** (sound). The first draft spelled out the free-a-clip recipe and the "don't cascade" rule in the prompts, which tests prompt-following, not the skill; the bars still require the recipe order and no unasked cascade.
- **Model trials use a local CLI bundle** (sound). No release carries the new operations yet, so the two cases run with `node evals/run.mjs --cli <bundle>` built from this branch; contracts-only checks pass offline.
- **The free-a-clip bar allows a refused plain `asset.delete` first** (sound, corrects the drafted bar to the spec). The skill's step 1 is "delete what the user named"; a plain delete without cascade can only be refused or free exactly what was asked. The drafted bar demanded `edit.apply` as the first mutation and an explicit `revisionId` on the copy check, both stricter than slice 15's contract; recipe order from `edit.apply` on, no cascade, returned ids and the final `freedBytes` stay required.
- **Model trials: Claude runner and judge, 2/2 on each case** (known gap). `refused-delete` and `authorized-free-a-clip` both passed twice with Claude as runner and judge against a CLI bundle built from this branch. The harness could not find Codex credentials it can pass into its containers, so the Codex runner was not trialled; no sign-in was changed.

## Slice 16: full check, review, release

- **Full run** (2026-10-18). Root `bun run test`: 19 of 20 turbo tasks green; `@yap/macos` 146 passed, 1 failed: "a take killed as it stops is recovered from the media it had already written", red on the pre-spec baseline too (a static screen writes no fragment before the kill); fixed below ("A still screen keeps reaching disk"). Test harness 156, service node 190, native helper 108.
- **Review.** refactor-clean + code-review subagent and `codex review` found: a plain `recording.delete` cascading into a project that gained a use mid-delete; an asset cascade deleting unlisted sibling assets; under-reported recording `freedBytes`; model remove/prepare races; coalesced cascade modes; in-memory preset receipts; five residual field translators; duplicate owners. All fixed test-first (see "Review findings resolved").
- **Real-bytes check** on a scratch library with the real service and native helper and a 35.7 MB clip: refused `IN_USE` with `freesBytes` = `cascadeFreesBytes` = 35,703,852; `project.duplicate` gave one revision; deleting the original left the copy as the user (still `IN_USE`); `asset.delete` freed 35,703,852 and `storage.usage` fell by exactly that. Project deletes freed 0 and usage fell by 0.
- **A still screen keeps reaching disk** (user, 2026-10-18; outside this spec's contract, fixed because the full run found it). The kill test above was not a regression: main's `CaptureWriter` never indexes a take whose screen stops changing, even 8 s in, so any force quit lost the whole take. The writer now repeats the last frame at 10 frames a second once the screen has been still for 100 ms. A slower floor (1–2 fps) was tried and failed the 1.8 s kill: the H.264 encoder holds several frames before writing any (about 3 in the app, about 19 inside the native test process), and the first index needs encoded samples past the 1 s fragment interval. Only screen capture repeats (a camera never goes still), and stillness is time since the last frame was delivered, not a gap in timestamps: frames can arrive stamped well before delivery, and measuring the gap let repeats land between a camera fixture's frames. A screen change delivered after a repeat that already covers its timestamp plays right after the repeat, rather than being dropped and leaving the stale picture repeating. The pixels are unchanged; a still screen now costs encoded duplicate frames instead of nothing.

## Release review (2026-10-18)

A fresh reviewer and `codex review --base origin/main` read the whole branch before release; a second fresh reviewer read the fixes (Codex's re-review twice hit model capacity).

- **Fixed, test first.** `model.remove` matches a running job by the model's content digest, which every model consumer pins, inside the model's own removal flight (the earlier `modelId` key never matched transcription). `--wait` on a take understands its capture lifecycle: `finalizing` is pending unless it carries `finalizationError`, and `complete` succeeds. A later delete of a re-imported (content-addressed) asset reports its own `freedBytes`. A member's `IN_USE` reaches the caller in every error mode. Smaller: string cursors in the app tests, a test-only guard removed from production, `waiting` dropped from the app, settled request promises released, unused model methods and history-narrating comments removed.
- **Dismissed with reason.** A job starting mid-removal stays the accepted sharp edge (it fails only that job). `IN_USE` after the plan exists, and a delete request joining between result save and in-flight cleanup, are unreachable: the tombstone fences new uses with no await after the users check, and the save and the cleanup run in one microtask chain.
- **Deferred to a follow-up change** (no wrong behaviour today). The service's response-wide `normalizeWork` guesses which `state` fields are work by neighbouring keys, a second owner of the work vocabulary; each owner should map its own. Fault hooks sit in the production delete path. `deletion_requests` and `model_removals` grow without a retention rule, which needs a decision on how long a replay stays valid.

## Follow-up (2026-10-18)

The release review's deferred items, done after 0.1.60 shipped, and what doing them found.

- **Model removal keeps its meaning; review keeps its model** (user). `model.remove` is for a user who no longer wants a model, such as before uninstalling Yap. Yap always keeps a transcription model, so `transcript.review` prepares `parakeet` again when it needs it, and the removal row stays so startup still skips it. The `model.remove` and `transcript.review` descriptions and the skill's delete recipe say so; the code did not change.
- **Each owner marks its own work status** (sound). The guessing rewriter, its twelve hint keys and its 27-word allow-list are gone. An owner returns its status through `storedWork` (`packages/protocol/src/work.ts`), a mark that survives object spread and never serializes, and the service edge maps only marked records, through one union of the owners' tables (a test holds owners that share a word to the same meaning). The union rather than one table per record because handlers spread an owner's status and override its state with another owner's word (`transcript.review` reports a model's `preparing` over a transcript status). Marked producers are typed to known words, so a new word is a compile error, not a runtime throw on someone else's response. The old and new edges ran side by side over the service, CLI and service node suites; output is identical except four named changes: a closed package admission reports `idle` and a failed cleanup `failed` (the old edge passed `closed` through and threw on `cleanup_failed`); a model with no file reports `unavailable` with `jobId: null` in `service.health` and transcript reads, as `model.status` already did (the old guess missed it because nothing sat beside its `state`); ready page reads, capture coverage entries and a refusal's details no longer carry the `jobId: null` a neighbouring key used to add; and the unused skill, CLI and update tables went, since the app answers those operations. Vitest in core compares marked statuses with an equality that ignores the mark.
- **Fault hooks left the production path** (sound). `LibraryDeletion` has no fault option. Tests inject `FaultingDeletionPlans` (`apps/service/src/deletion-faults.fixture.ts`), which fails around each durable write, and the service takes a `deletionPlans` factory for them. The `check` boundary was the same instant as `plan` and merged into it; `clear`/`after` now falls after the plan row is gone.
- **A plan and its request are written together** (found by moving the fault hooks). The old `plan`/`after` hook fired after the request record too, so it hid a crash window: a crash between writing the plan and recording its `requestId` left a plan that startup finishes, after which the client's retry with that `requestId` ran the delete again and refused `NOT_FOUND`. `DeletionPlans.create` now records the request in the plan's transaction, and a test crashes in exactly that place.
- **Replay records have no retention rule because they need none** (sound). No replay table in the catalog is pruned, each record is one small row per request, and a repeated delete or removal must keep returning its first result after its subject is gone. The protocol readme states the rule and a test pins it.
- **Slice 07b broke four internal wires in 0.1.60** (found by migrating the harness probes; shipped). It renamed fields the service sends to workers that still read the old names: the retained PCM a prepared-audio render reads (`bytes`, `dataOffset`, `frames`, `range`), the held PCM of typed audio processing (`frames`), and the `frames` of `alignment.observe` and `speaker.observe`. So 0.1.60 could not render a project whose audio was prepared or processed by a limiter, compressor or normalization, and refused every alignment and speaker observation. Each wire got its worker's names back; the naming rule covers public results, not a worker's contract. It shipped because the native-backed audio suite runs only with `YAP_NATIVE` and `YAP_FFMPEG_DIRECTORY` set, and the Python workers were faked; contract tests now run the real `worker.py` validation for both observers, and the audio suite passed against the bundled ffmpeg apart from four renders the machine's encoder refused (below).
- **Descriptor exhaustion is retryable again** (sound). Since slice 01 made `NATIVE_DECODE_FAILED` final, running out of file descriptors while opening an audio output read as a final failure. The native writer now reports `CAPACITY_EXCEEDED` for EMFILE, ENFILE and CoreAudio's too-many-files error, which the descriptor-pressure test requires.
- **The harness probes follow the current interface** (111 files). Four agents migrated them, leaving core-internal `id`s alone, and ran most end to end. Failures they reached that are not the interface: a native FFV1 refusal now `NATIVE_DECODE_FAILED` where `assets.mjs` expects `UNSUPPORTED_MEDIA`, raster comparisons in `layers`/`captions`/`source-frame-evidence`, `frame-evidence`'s use of `retimeImplementationId` (never public), and `video.mjs`'s cancellation receipt name.
- **A key may leave out what its parent says** (user). The rule had flagged a record's own `id`, a bare `count` or `bytes`, and `start`/`end` under `sampleRange`, which would have meant names like `samples.sampleCount`. Agents learn this CLI on demand, so a name that reads well in place wins over one that repeats its parent. The rule now flags only a quantity whose unit neither the key nor its parent names, and a non-canonical unit. Under it every response the suites exercise passes; the guard moved from the service fixture to the service edge, on when `YAP_NAMING_GUARD` is set, which the service and CLI test configs do, so every test response is checked rather than only the fixture's calls. Earlier `<noun>Id` names stay; nothing was renamed back.
- **Open: an explicit `AllowOpenGOP` can fail an export** (machine finding, predates this spec). On macOS 27.0.1 the encoder chosen for a 16×16 canvas, and sometimes for an ordinary preview, refuses the property the default settings pin (`openGop: false`) with -12900. Default exports at ordinary sizes passed the release smoke on the same machine.
