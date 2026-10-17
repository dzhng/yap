# Choices ledger

Decisions made during implementation where the plan was silent, with a verdict.
*Sound* means kept on purpose; *provisional* names when to revisit.

## Format and index

- **Frontmatter parser:** a restricted parser for flat scalars and a
  `references:` list, with no YAML dependency. *Sound*: every package uses only
  that shape. Names the parser would misread (a colon, `#`, quotes, edge spaces)
  are written JSON-quoted by the scaffold, and the parser undoes JSON escapes, so
  they round-trip (`preset-scaffold.test.ts`). References are written unquoted; a
  local path containing ` #` would be cut short. *Provisional*: no such path has
  appeared.
- **`## Any footage` is a required section**, like `## Shoot` and `## Edit`.
  *Sound*: `preset.get` tells the agent to start there, so a preset without it
  would send the agent nowhere. Added after the final review.
- **Links inside `authoring/template/` are exempt from the link check.** The
  template holds placeholders on purpose and is never served as a preset. *Sound*.
- **A missing `index.json` at the merge base counts every package as new.**
  *Sound*: that is the first merge; afterwards versions are compared.
- **An example with no `profile.json` is skipped, not failed.** *Provisional*: it
  lets a new example land before it is measured. Revisit if examples ever ship
  unmeasured.
- **One pass over the tree.** `validateTree` parses each package once, with its
  folder, so the id-matches-folder rule runs in core, and `presets-index.mjs` takes
  its manifests from that pass. The id pattern, package folders and valid
  references each have one owner in `preset-format.ts`. *Sound*: the release
  review found the script parsing twice and reporting problems twice.
- **`source/` folders are skipped, not refused.** The tree walk never enters them,
  so a checkout can hold full reference videos (Git ignores them) and `preset.get`
  on a local preset lists files by `stat` only, never reading or hashing them.
  *Sound*: the release review found `preset.get` hashing whole reference videos on
  the service's event loop.
- **The index check runs in `test:tools` and in `presets-checks.yml`**, since every
  install refreshes against `main`'s index. *Sound*.
- **The index check tests examples only against `targets.json`.** Section targets
  (`targets-teaser.json`, `targets-body.json`) measure parts of an export, and an
  example's `profile.json` is the whole reference. *Provisional*: revisit if
  examples ship section profiles. A malformed `profile.json` is skipped like a
  missing one.

## Install and store

- **`local.json` is `{ "ids": [...] }`, owned by `PresetStore`.** Any other shape
  is an error. *Sound*: one owner, no compatibility shims.
- **Conflicts live in `receipt.conflicts`.** A remote preset whose id matches a
  local one is recorded there and never installed. *Sound*: the receipt describes
  only what is on disk.
- **Concurrency is an in-process queue per target directory**, no file lock.
  *Sound*: one service owns `~/.yap/presets/`. Revisit if a second writer appears.
- **`list()` takes name, description and version from the installed `PRESET.md`**,
  with the receipt's version as fallback. *Sound*: the file on disk is the truth.
- **The installer refuses a remote package whose id or kind is outside the
  format**, and `preset.get` serves only installed or local ids matching it, so a
  crafted `../x` is not-found. *Sound*: found by the whole-branch review (P1).

## Read and bundling

- **`createPresets` finishes the bundled install before returning**, and a failure
  is reported as `refresh.error` until the first refresh completes, rather than
  stopping the service. *Sound*: recording and editing must keep working without
  presets, and a successful refresh installs what the bundle couldn't.
- **`preset.get`'s instructions give absolute paths** to `shoot-plan.svg`,
  `measure.mjs` and `check.mjs`. *Sound*: the agent can act on them directly.
- **The bundled path is resolved by `main.ts` from `runtime.json`**, not passed
  through Swift like `ffmpegDirectory`. *Sound*: one owner in TypeScript, no
  native change.

## Refresh

- **Not shared with model preparation's downloader.** The two share about ten
  lines of hash-and-count; models opens files exclusively, syncs them and raises a
  typed error at each failure point, while presets read a stream from a source and
  report a reason per package. *Accepted overlap*. Both stop a file at its first
  overrun and clear stale staging at startup.

- **Remote tests inject `fetch` instead of running an HTTP fixture server.**
  *Sound*: same contract (pinned URLs, statuses, streams), and it runs where
  sockets can't be opened. The plan named a local server.
- **Timeouts:** one configurable timeout (default 30 s) for each request and for
  each read of a file stream, with no time or size cap on a whole package file; the
  index is capped at 4 MiB. *Sound*: no per-preset cap means a large file may take
  long, but a stalled one may not.
- **Download, checksum and unreachable-source failures are reported, not
  refused.** The plan named `PRESET_DOWNLOAD_FAILED` and `PRESET_HASH_MISMATCH`;
  they became `failed` entries in the update report and `refresh.error`. *Sound*:
  a refresh covers many packages, and one failure mustn't hide the others'
  results. The final audit found an unreachable source still escaped as
  `INTERNAL_ERROR`; `Presets.update` now reports it (`presets.test.ts`).
- **An id-scoped `preset.update` also refreshes the kit and guide**, and removes
  only packages it owns. *Sound*: a preset may depend on a newer kit.
- **Refresh is opt-in for `startProjectService`**; `main.ts` turns it on. *Sound*:
  dozens of test and harness callers start the service and must not reach the
  network.
- **When refresh is off, `preset.update` succeeds with a failed report** and
  instructions saying nothing was downloaded. *Provisional*: a refusal would also
  be defensible.
- **`close()` waits for a run in flight**, and `preset.update`'s instructions name
  only downloaded presets, not kit or guide updates. *Sound*: whole-branch review
  (P2).

## Create and delete

- **Ids use Unicode NFKD before dropping non-ASCII**, so accented names keep a
  readable ASCII base ("Café Noir" → `cafe-noir`). *Sound*.
- **`preset.create` waits for a refresh in flight and reserves every id in the last
  remote index plus installed ids.** *Sound* (P2). A preset published later can
  still collide; the installer records a conflict and the local preset keeps its id.
- **Local file references must be regular files.** *Sound*: a directory is
  refused before anything is written (`presets.test.ts`).
- **Create reads the installed authoring template and instructions**, so guide
  changes reach new presets without an app release. *Sound*.
- **Refusals are core's existing `CatalogError`** with the four `PRESET_*` codes.
  *Sound*: an earlier `PresetError` hierarchy duplicated it.
- **The isometric-motion skill is copied whole into `authoring/reference/`**, scripts
  and examples included, about 1.8 MB that every install downloads. *Sound*: the
  user asked for the skill copied in as the depth reference, and an author studies
  how its examples and tools are built, not only its prose. Revisit if the
  authoring package grows slow to refresh.
- **Trash is injectable**; production uses `/usr/bin/trash`. *Sound*: the wire
  test uses a fake.

## Skill route

- **The routing paragraph sits in the skill's "Task references" section**, with
  the other "go read X" pointers. *Sound*.
- **The eval case accepts an honest "unavailable"** when the service can't run in
  the Linux trial. *Sound*: it grades routing, not native readiness.

## Moods, not footage requirements

- **`targets.json` aspects:** grade, loudness and median shot length are `mood`;
  duration, shot count and longest take are `form`, notes only. *Sound*: form
  depends on the footage. Median shot length stays mood because it is how the cut
  feels at any length, except studio-podcast's whole-video median, which the fast
  teaser dilutes: it is form there, and the teaser and body targets carry the mood
  median.
- **A mood FAIL is fixed or explained.** `preset.get`'s instructions say to tell
  the user why a line stands when the footage can't reach it without breaking it
  (a low-key range on bright footage). *Sound*: the final review found that "fix
  every FAIL" would push agents to crush or lift footage, the forcing the mood rule
  forbids. Eye checks that demanded footage (camera counts, one continuous shot,
  no speech, fixed lengths) became "as far as the footage allows" or reference
  notes.
- **`## Shoot` is advice**, shown when the user asks what to film or hasn't
  recorded. *Sound*: user requirement.

## Proof

- **The trial ran on installed Yap, not a dev build.** *Sound*: `edit.apply` and
  export don't depend on the preset operations, and the installed app has the
  native media helper a worktree lacks. Agents got each preset as files with its
  rendered `instructions`, because the installed app predates `preset.get`.
- **Presets say to grade each video track.** On the installed app a LUT on the
  output failed at export. *Sound* either way: per-track grading also lets an
  agent balance one shot. The Limits name the failure as Yap 0.1.53 and earlier,
  because presets refresh into apps that predate the fix.

## Product fixes found by the proof

- **A video processor on the output stack reached the audio program.** The audio
  lowering (`temporalProcessing().audio` in `packages/composition/src/temporal-processing.ts`)
  now keeps only processors whose registry `mediaKind` is `audio`, and the native
  audio renderer's own list of video processors to skip was deleted. A LUT on the
  output now exports. Test: `lut.test.ts`, "a LUT on the output grades the picture
  and never reaches the audio program". *Sound*: the processor registry is the one
  owner of media kind.
- **A new processing step with an invented `id` got "does not belong to this
  target".** It now says the id names no existing step and to omit it to add one
  (`edits.test.ts`). *Sound*.
- **A text clip with a background box failed its frame read** with "Malformed
  picture receipt". The native rasteriser joined the ink box with the padded box,
  and Core Graphics' rect union can lose the last bit, so a flush background
  reported decoration bounds a hair smaller than the ink, breaking the receipt
  rule that decoration contains ink. `TextRaster.containing` now widens the
  reported box to the ink edge; pixels are unchanged, so the renderer version was
  not bumped (`TextVerticalTests.swift`, `--text-decorations`). *Sound*: the TS
  receipt schema was right; the native side broke the contract.
- **The stale picture-step stripping in `apps/service/src/native-processing.ts` was
  deleted.** With the audio program holding only audio processors, no picture step
  reaches native metadata. *Sound*.
- **Not bugs:** `--wait` progress goes to stderr and stdout stays JSON (the agent
  had merged the streams); concurrent frame reads past the open-delivery bound are
  refused `LIMIT_EXCEEDED` with `retryable: true`, a deliberate limit.
