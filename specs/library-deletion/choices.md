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
  both ways, the two meanings became two codes (table in
  [slices/01-error-ledger.md](slices/01-error-ledger.md)). The established name keeps
  its established meaning; the new name describes the other condition.
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
- **Stored job results keep `bytes` on published file receipts and `range` on the audio job publication** (questionable, user verdict pending). Both live inside job results retained on disk; renaming them would move every renderer pin that emits them and discard valid evidence. The naming lint covers operation params and exported protocol records, not retained job payloads. Revisit if a later slice already moves those pins.

## Slice 08: asset deletion

- **Cascade ownership stays in `LibraryDeletion`** (sound). Asset retirement records members and the coordinator invokes the registered project, asset and acquisition retirements, so there is one crash-resumable deletion path.
- **The subject's own files and rows finish before cascade members run** (sound). The asset is fenced and removed first; recorded members then retire through their own owners without sharing a second asset cleanup path.
- **Member traversal uses the plan's stable `(memberKind, memberId)` order** (sound). Replaying the same plan sees the same members and can safely skip members already retired before a crash.
- **Row cleanup uses 256-row pages** (sound). The page matches the existing owner-reference and job-retirement bounds and keeps each resume turn bounded.
- **Asset retirement force-purges retained evidence** (sound). Once the asset is tombstoned, no retained transcript, scene, index, alignment, speaker or cache reference can outlive its source asset.
- **Cascade results report `cascadeFreesBytes`** (sound). A cascade removes every user recorded by the refusal query, so its byte result must match the same measured closure the refusal exposed.
- **`ASSET_DELETED` is a non-retryable conflict and `IN_USE` is a non-retryable destructive refusal** (sound). A deleted import request cannot be replayed, while a live owner requires an explicit cascade decision.
- **Finished deletion request results live in the durable deletion-plan owner** (sound). Replaying the same request after restart must return its saved `freedBytes` even after the subject row and plan are gone.

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
