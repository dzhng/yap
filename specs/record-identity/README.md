# Record identity

One identity rule for every record Yap stores or returns, held by the producers
themselves, with no key translation anywhere between storage, core, the service
edge and its callers.

## Next Agent Prompt

*Status, 2026-10-19:* slices 01–04 landed (04's app side is in 06); 07 is in progress; next is 05. Branch `t3/fix-audio-tail-coverage`
carries unpushed work (probe deletion, work-state rule, naming lint removal) that this
builds on.

You are picking this up. Read this README, then work the slices in order; each one leaves
every suite it touches green. For each slice: invoke `write-tests` first, run that slice's
narrow checks only, and commit. Slices 06 and 07 (Swift app, skill/evals/docs) can run in
parallel once 05 lands. Run the full repository check once, in slice 09. Update this
section and the TODO list before you end a pass.

- [x] 01 Owner references are `{kind, id}` everywhere (core `JobOwner`/`JobTarget`, evidence owners)
- [x] 02 Jobs: `JobQueue.inspect` is the one public job record; `JobQueue.work` is what an operation that started a job reports
- [x] 03 Library records name themselves `id`
- [x] 04 Pictures and capture devices: faces, regions, words, cameras, microphones, displays, windows (the app's side is in 06)
- [ ] 05 Catalog format 30 and package version 7, each with a tested migration
- [ ] 06 macOS app decoders
- [ ] 07 CLI, skill, evals and docs
- [ ] 08 Quantity names without translation: the audio/acoustic receipt converters and `internalAudioSelection`
- [ ] 09 Closeout: full run, close-spec, release

## The rule

1. A record names its own identity `id`.
2. A reference to one kind of record is `<noun>Id` (`<noun>Ids` for a list).
3. A reference that can point at several kinds is `{kind, id}`; a kind with no identity
   (the output of a processing graph) is `{kind}` alone. Qualifiers stay references:
   a project job's target is `{kind: "project", id, revisionId}`.

Operation parameters name what they act on by reference, so `asset.get {assetId}`
returns `{id, …}`, and a delete returns the deleted record's stub `{id, deleted,
freedBytes}`. The rule is the edit document's, which already follows it, and the common
resource-identifier convention (JSON:API's `{type, id}`). It replaces the earlier
"identities are `<noun>Id`" rule from [library deletion](../done/library-deletion/README.md),
which renamed core `id`s at the service edge.

Producers own the names. Core records use the rule; the service passes them through. No
`({ id, ...x }) => ({ ...x, assetId: id })` survives anywhere, in either direction.

Storage follows the records it holds. SQLite column names are the store's own schema and
stay; a store maps its row to its record as it always has. JSON that stores a public
record verbatim (revisions, replay receipts) is rewritten once by a catalog migration, so
no reader accepts two shapes.

## Public contract after this spec

What a caller sees, operation by operation. Parameters keep `<noun>Id` throughout.

- **Records name themselves `id`:** `project.get/list/create/duplicate` (`project.id`,
  `revision.id`), `revision.get/history`, `edit.apply` and other edits (`revision.id`),
  `inspect.open` (`history[].id`), `recording.get/list` and every `capture.*` result,
  `asset.get/list` (and `streams[].id`), `export.create/status/recover/list` (and
  `export.abandon` → `{id, abandoned}`), `preset.list/get/create/delete`,
  `package.open/status/close`, `model.list/status/prepare/remove` and
  `service.health.models[]`, `job.get/retry/cancel`, `correspondence.prepare/get`'s
  receipt, transcript word rows (`rows[].id`, `caption.propose`'s `words[].id`),
  `media.list` items, faces (`faces[].id`), observation regions (`regions[].id`, in
  `frame.get`/`frame.batch`/`index.get` parameters too), and `capture.sources` displays,
  windows, cameras and microphones.
- **Deletes** return `{id, deleted, freedBytes}` (`asset`, `project`, `recording`, `model`
  delete/remove); `preset.delete` returns `{id, trashed, trashedPaths, instructions}`.
- **Polymorphic references are `{kind, id}`:** a job's `target` (`{kind: "project", id,
  revisionId}` for project work), evidence `owner`, IN_USE details (`usedBy[]`,
  `acquisitions[]`, `derivedAssets[]`), `media.list` items (`kind` is `"recording"` or
  `"asset"`), and `capture.start`'s `source` (`{kind: "display"|"window"|"camera", id}`;
  a region is `{kind: "region", displayId, x, y, width, height}`).
- **Starting a job reports its work:** `asset.import`/`acquisition.import` return
  `{target, state, jobId, attemptId, attemptGeneration, reason, retryable, published}`;
  `job.get` returns the job itself, `{id, state, attemptGeneration, target, …}`. The CLI's
  `--wait` output names the job it waited on as `wait.job.id`.
- **References stay `<noun>Id`** wherever a record points at another: `revision.projectId`,
  `project.currentRevisionId`, `export.projectId`/`jobId`, work statuses' `jobId`, refusal
  details naming the subject, and every operation parameter.

## Decisions

- **`{kind, id}` over `{kind, assetId}`** (user asked for the correct solution). The kind
  is said once, a consumer finds the identity in one place, and `{kind: "output"}` fits
  the same shape. The job queue already stores targets as `targetKind`/`targetId`.
- **The job owner speaks WorkState.** A job record is `{id, state, …}` with no `jobId`, so
  the edge's "state and `jobId`" rule cannot reach it. `JobQueue.inspect` maps its stored
  words through `workState` itself, and is the only job projection: `job.get` and every
  nested `job` (capture source admissions) are the same record.
- **Catalog 29 → 30 with a migration, not read-time compatibility.** The catalog's own
  rule: a changed stored shape needs a format bump and an explicit migration owner. This is
  the first since launch. It rewrites stored JSON in `project_revisions.content`,
  `projects.createResult`, `project_requests.result`, `deletion_requests.result` and any
  other row that stores a renamed record, and re-points `export_intents.snapshot`'s
  `$.revisionId` query if the snapshot's shape changes. A library at 29 opens at 30;
  nothing older is newly supported.
- **Package version 7 with a version-6 converter on import.** Packages live outside the
  library, so a user may hold version-6 files. Import converts them once into the version-7
  shape before validation; export writes 7.
- **Internal wires keep their contracts unless they carry a public record.** The native
  capture files (`source.publication.json`, journal headers) hold references, not a record's
  own identity, and stay. The native face and region producers emit public records and
  change at the producer (Swift), with retained index frames refusing `ARTIFACT_CHANGED`
  and regenerating, as they already do.
- **Edit results stop renaming away from `id`.** `createdIds[]` entries are `{kind, id}`
  references (was `entityId`), `changes[]` entries name themselves `id` (was `changeId`),
  and a model's `generationProfile` keeps its `id` (was `profileId`).

## Inventory

From responses recorded across the service, CLI and service node suites (2026-10-19), and a
producer trace. Own identities to rename to `id`:

| Record | Today | Producer |
|---|---|---|
| project | `projectId` | `packages/core/src/projects.ts` (`Project`, list/get/create/duplicate) |
| revision | `revisionId` | `projects.ts` (`ProjectRevision`, history, apply/undo/restore) |
| job | `jobId` | `packages/core/src/jobs.ts` `inspect`; service `status()` folds into it |
| export | `exportId` | `apps/service/src/exports.ts` status/publicStatus/list/abandon |
| recording | `recordingId` | `packages/core/src/capture-store.ts` `Recording` |
| asset | `assetId` (edge rename) | `packages/core/src/assets.ts` (already `id`) |
| stream | `streamId` | `assets.ts` `describe` renames core `id` |
| preset | `presetId` (edge rename) | `packages/core/src/presets.ts`, `preset-store.ts` (already `id`) |
| package admission | `packageId` (edge rename) | `apps/service/src/package-registry.ts` (already `id`) |
| model | `modelId` | `packages/core/src/models.ts` list/statuses/remove; service `model.*` |
| correspondence receipt | `evidenceId` | `packages/core/src/correspondence.ts` |
| media item | `assetId`/`recordingId` + `kind` | `packages/core/src/media-listing.ts` |
| transcript word | `wordId` | `packages/core/src/transcript-read.ts` |
| face, region | `faceId`, `regionId` | `helpers/mac/Sources/YapFrames/*Observations.swift`, protocol `faces.ts`/`picture.ts` |
| camera, microphone, display, window | `cameraId`, `microphoneId`, `displayId`, `windowId` | macOS app `CaptureController.swift`, protocol `capture.ts` |
| text, speaker correction | core `textId`/`correctionId` (edge renames to `id`) | `layout-diagnostics.ts`, `speaker-attribution.ts` |
| delete results, IN_USE details | `<noun>Id` | `apps/service/src/library-deletion.ts` and retirements, `library-users.ts`, protocol `in-use.ts` |

Polymorphic references to convert to `{kind, id}`: job `target`, evidence `owner`, core
`JobOwner`/`JobTarget` (267 sites), `media.list` items.

Bugs the trace found, fixed by the owning slice:
- The preview timeline decodes `revision.history` entries as `{id}` while the service sends
  `revisionId`, so it never shows (slice 03 makes the service right; 06 checks the app).
- The CLI waits on `package.status` with `pins.id` while the service renames it to
  `packageId` (03).
- `model.prepare` returns no model identity though `modelStatusSchema` requires one (03).
- Nested `sourceAdmissions[].job` is a different shape from `job.get` (02).
- `ProjectStore` replay refuses a stored revision that has `id` and no `revisionId` as
  obsolete (05 removes the guard with the migration).

## Slices

**01 Owner references.** `JobOwner`/`JobTarget` become `{kind, id}` (`revisionId` stays
on project targets), one type with `ResourceOwner`/`ResourceReference` if they mean the
same thing. Evidence `owner` likewise. Storage is unchanged (`targetKind`/`targetId`).
Check: core and service type-check and suites; job.get `target` shape test.

**02 Jobs.** `JobQueue.inspect` returns the public job record: `id`, WorkState `state`,
`attemptGeneration`, the publication with a string generation. The service's `status()`
wrapper and capture's raw use both read it. An operation that starts a job
(`asset.import`, `acquisition.import`) reports `JobQueue.work`: the status of that work,
`{target, state, jobId, attemptId, attemptGeneration, reason, retryable, published}`, like
every other work-starting operation, so its `id` is never mistaken for the new asset's. The
CLI's `--wait` follows a job record by its `id` and a work status by its `jobId`. Check: core
jobs tests; CLI wait tests; service publication tests.

**03 Library records.** Every producer in the inventory except pictures and devices names
itself `id`; the service edge's renames are deleted; delete results and IN_USE details
follow; `model.prepare` returns the model record. Protocol schemas (`modelStatusSchema`,
`jobStatusSchema`, `inUse*`, `waitJobSchema`, correspondence) follow. Fix the three edit-result
renames. Check: protocol, core, service, CLI suites; rerun the identity inventory (record
every `id`/`*Id` key path across the suites) and confirm no own identity is `<noun>Id`.

**04 Pictures and devices.** Swift producers emit `id` for faces and regions; region
parameters take `id`; capture device lists use `id`. Check: helpers/mac tests, native
picture suite, index refusal of an old retained frame.

**05 Storage.** Catalog format 30 with a migration owner (a named module, one transaction,
tested against a format-29 fixture built by the previous release's code paths); package
version 7 with a version-6 import converter tested on a real version-6 package. Remove the
obsolete-revision guard. Check: migration tests, package import/export tests, opening a
real 0.1.61 library copy.

**06 macOS app.** Every `Decodable` that reads a renamed record. Check: app unit tests,
controller journey, a real launch reading the library, the preview timeline showing.

**07 CLI, skill, evals, docs.** `wait.ts` pins, skill scripts and references, eval
fixtures, protocol and package readmes. Check: CLI suite, `test:tools`, eval tests.

**08 Quantity names without translation.** Library deletion kept three translations "on
purpose": typed converters in `audio-inspection.ts` and `acoustic-inspection.ts` that rename
`bytes`/`frames`/`range`/`sampleRange.start` to `sizeBytes`/`frameCount`/`sourceRange`/
`startSamples` between core and public receipts, and `internalAudioSelection` (public
`sourceRange` → core `range`). Under the relaxed convention (a key may leave out what its
parent says) they are translation layers like the identity renames: one name per field, held
by the producer, with stored receipts in the old shape refusing `ARTIFACT_CHANGED` and
regenerating as they already do. Found by `project-audio.test.ts` ("native mixer serves every
project audio tap"), which runs only with `YAP_NATIVE` and has failed since slice 07b of
library deletion.

**09 Closeout.** Full repository check once; `close-spec`; release after the user's go.

## Firewalls

- No compatibility readers, aliases or edge renames; a stored shape changes only through
  the migration.
- The edit document's format does not change; it already follows the rule.
- Internal worker wires keep their names unless they carry a public record (see Decisions).

## Findings for the migration (2026-10-19)

Recorded by logging every job input with an owner object while the core, service and
service node suites ran:

- Only two job inputs embed an owner: frame and index work carries scene evidence
  metadata (`scenes.owner`, `scenes[].owner`), and project audio processing carries its
  recipe's `target`. No transcript, alignment or speaker input does, and no owner hides in
  a nested input string. Both are derived without model inference.
- Input hashes key only the `jobs` and `artifacts` rows (exports hash their own id), so the
  migration rewrites those inputs and recomputes `inputSha256` in both tables; no file
  path changes.
- Owners in evidence tables are already stored as `ownerKind`/`ownerId` columns; only the
  JSON metadata copies (strictly validated: transcript, scene, speaker, alignment evidence)
  need rewriting.
- Slice 07b of library deletion left two read-time shims in `ProjectStore`'s replay: one
  refused a stored revision named by `id`, the other stripped an `edit.document` older replays
  carried. Slice 03 removed both; the migration rewrites `project_requests.result` (revision
  identity, no `edit.document`) so no reader needs them.
- Preset request receipts (`<presets>/.request-receipts.json`) store raw results; a
  `preset.delete` receipt names its preset `presetId`. Slice 05 rewrites that file too.
- `capture.start` request arguments are stored for replay; their `source` changes shape in
  slice 04, so the migration rewrites stored capture request arguments as well.
- Completeness check for slice 05: build catalogs with the format-29 code through the
  suites, migrate them, and assert that no JSON column anywhere still holds an old shape.
