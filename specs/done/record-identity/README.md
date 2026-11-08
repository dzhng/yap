# Record identity

Every record Yap stores or returns names itself the same way, and the code that produces a
record owns its names: nothing renames keys between storage, core, the service edge and its
callers.

## The rule

1. A record names its own identity `id`.
2. A reference to one kind of record is `<noun>Id` (`<noun>Ids` for a list).
3. A reference that can point at several kinds is `{kind, id}`; a kind with no identity is
   `{kind}` alone (a processing graph's output). Qualifiers stay references: a project
   job's target is `{kind: "project", id, revisionId}`.

Operation parameters name what they act on by reference, so `asset.get {assetId}` returns
`{id, …}`, a delete returns the deleted record's stub `{id, deleted, freedBytes}`
(`preset.delete` moves a preset to the Trash and says so: `{id, trashed, …}`), and a
record a caller writes into parameters (an observation region, a layout text, a speaker
correction) names itself `id` too. Operations that start a job report the status of that
work, which refers to the job (`{target, state, jobId, attemptId, …}`); `job.get`,
`job.retry` and `job.cancel` return the job itself (`{id, state, attemptGeneration, …}`),
so an import's response is never mistaken for the new asset.

## Why this rule

The edit document, the format agents write most, already followed it: clips and tracks are
`id`, references are `trackId`/`assetId`, routing and processing targets are `{kind, id}`.
It is also the common resource-identifier convention (JSON:API's `{type, id}`). The rule it
replaced, from [library deletion](../library-deletion/README.md), named every identity
`<noun>Id` and was enforced by renaming core's `id` at the service edge (asset, preset,
package admission, cue), while other records were renamed the other way (texts,
corrections) and some core records already said `projectId` of themselves. Two shapes for
one concept, held together by translations, was the defect; this rule has no exceptions,
so no translation is needed anywhere.

`{kind, id}` won over `{kind, assetId}` because the kind is said once, a consumer finds the
identity in one place whatever the kind, and a kind with no identity (`{kind: "output"}`)
fits the same shape. The job queue already stored targets as `targetKind`/`targetId`.

## What must hold

- **No key translation.** No `({ id, ...x }) => ({ ...x, assetId: id })` in either
  direction, in the service or anywhere else. A field changes name at its producer.
- **Storage holds the record's shape.** SQLite columns are the store's own schema and stay;
  JSON that stores a record verbatim holds the current shape. An older shape changes only
  through a versioned migration, never through a reader that accepts both.
- **One job record.** `JobQueue.inspect` is the public job: `job.get` and every job nested in
  another answer (capture source admissions) are the same record, in the public state
  words. `JobQueue.work` is what an operation that started a job reports.
- **Internal worker wires keep their own contracts** (the native capture files, worker PCM
  receipts). The owner that turns a worker's receipt into a public one maps it inside
  itself and types each side truthfully; see the audio receipts below.

## Pointers

- Owner references: `JobOwner`/`Owner<Kind>`/`ownerIdentity` in `packages/core/src/jobs.ts`,
  `EvidenceOwner` in `evidence.ts`.
- Jobs: `JobQueue.inspect` and `JobQueue.work` (`jobs.ts`); `jobStatusSchema` and
  `waitJobSchema` (`packages/protocol`). The CLI's `--wait` follows a job record by its `id`
  and a work status by its `jobId` (`jobOf` in `apps/cli/src/wait.ts`), and pins a
  returned record's `id` to that record's getter (`recordGetters`).
- Migration: `packages/core/src/record-identity-migration.ts` owns every rewrite of an older
  stored shape: `migrateToFormat30` (run by `Catalog` when it opens a format-29 library,
  in one transaction), `packageMemberFromVersion6` (project packages, `project-package.ts`),
  and `presetReceiptsFrom0161` (`presets.ts`, for the unversioned receipts file 0.1.61
  wrote; this build writes version 2). `catalogFormat` is 30 and
  `minimumSupportedCatalogFormat` 29 (`catalog.ts`); packages are written at version 7.
- Tests that pin it: `record-identity-migration.test.ts` (a round trip from what this build
  writes, aged into 0.1.61's shapes, back to the same bytes; and two catalogs 0.1.61 wrote,
  `packages/core/fixtures/format-29-*.sqlite`); `apps/service/tests/package-version-6.mjs`
  (five packages 0.1.61 wrote, `apps/service/tests/fixtures/packages-v6/`);
  `presets.test.ts` (a 0.1.61 deletion receipt); `jobs.test.ts` ("a job's public record").

## How it diverged from the plan

- **Starting a job reports its work, not the job.** The plan had `asset.import` keep
  returning the job record; once that record named itself `id`, an agent would read the
  import's `id` as the new asset's. Imports and `recording.cleanup` return `JobQueue.work`.
- **Job targets went further than planned.** Core's `JobOwner` had two shapes inside core
  (`{kind, assetId}` beside `ResourceOwner`'s `{kind, id}`); 267 sites now use one, and the
  per-kind converters between them are gone.
- **The migration became generic.** One rule (an owner reference becomes `{kind, id}`)
  runs over every JSON column and every JSON document held in a string; a few
  table-specific rules handle stored revisions, project create/edit/undo replays, project
  snapshots and delete replays. A job input that changes recomputes its `inputSha256` in
  the same row. Replay keys stored as canonical (sorted) JSON are re-sorted. Stored
  capture arguments are positional and needed nothing.
- **Real data drove it.** A temporary v0.1.61 checkout kept every catalog (1,541) and
  package (12) its own suites wrote. The first pass missed an INTEGER PRIMARY KEY quirk,
  project snapshots inside adoption keys and unfinished package exports, and JSON held in
  strings (a packaged scene publication's `result`); after those, every catalog migrates
  with no old shape left and every package opens and adopts.
- **The audio receipt converters stayed.** They looked like edge translations but map the
  native worker's receipt (`bytes`, `frames`, `sampleRange.start/end`) to the public one
  inside the owner. What was wrong was the type: the published receipt was typed as the
  worker's shape while carrying the public one, which hid that the native mixer test in
  `project-audio.test.ts` had failed since 0.1.60. It is now `PublicSourceAudioReceipt`/
  `PublicProjectAudioReceipt`. The one real edge translation, `internalAudioSelection`
  (public `sourceRange` → core `range`), is gone: core's source audio inputs take
  `sourceRange` (`selectedRange` reads either domain's).
- **Faces and regions regenerate rather than migrate.** Retained index frames hold them;
  the frame and still renderers moved versions, so old results miss instead of failing.
- **Bugs found on the way:** the preview timeline never showed (it decoded
  `revision.history` as `{id}` while the service sent `revisionId`); `model.prepare` named
  no model; nested capture jobs had a different shape from `job.get`; the CLI waited on a
  package admission by a key the service had renamed; the app decoded `job.retry`'s answer
  as an export or a preview (it now reads the export or preview back); and library
  deletion's identity change had rewritten an archived evidence file
  (`specs/done/video-editing-feedback/assets/14-picture-statistics/control-receipts.json`),
  now back to its frozen bytes.

## Dead ends

- **`<noun>Id` everywhere** (library deletion's rule): it needed edge renames for every
  record core named `id`, and records written by callers went the other way.
- **Read-time compatibility.** Library deletion's naming change (0.1.60) had left two such shims in
  `ProjectStore`'s replay; a reader that accepts two shapes never stops accepting them.
- **A naming lint over every response**: it cost more than the mistakes it caught, and
  agents learn the API on demand; the convention lives here and in the
  [protocol readme](../../../packages/protocol/README.md).
