# Choices ledger

Decisions made during implementation where the spec was silent, with a verdict.
Appended per pass. Consolidated when the spec closes.

## Slice 01 (format and index)

- **Frontmatter parser:** a restricted parser for flat scalars and a
  `references:` list, with no YAML dependency. *Sound*: the spec delegated it, and
  every package uses only that shape.
- **Links inside `authoring/template/` are exempt from the link check.** The
  template holds placeholders such as `examples/source-slug/…` on purpose.
  *Sound*: the template is never served as a preset.
- **A missing `index.json` at the merge base counts every package as new.** *Sound*:
  that is the case on the first merge; afterwards the check compares versions.
- **An example with no `profile.json` is skipped, not failed.** *Provisional*: it
  lets a new example land before it is measured. Revisit if examples ever ship
  unmeasured.
- **`presets-index.mjs` checks id against folder itself.** `parsePackage` sees
  paths relative to the folder, so it can't. *Accepted overlap*: a small,
  explicit duplicate of one rule, not a second owner of the format.
- **Dependencies installed in this worktree** with `bun install --frozen-lockfile`,
  hardlinked from Bun's cache, so vitest and `tsc` could run. Codex's sandbox could
  not fetch them.

## Slice 02 (install and store)

- **`local.json` format is `{ "ids": [...] }`**, owned by `PresetStore`. Any other
  shape is an error. *Sound*: one owner, no compatibility shims. Review caught an
  earlier draft that accepted four shapes.
- **Conflicts live in `receipt.conflicts`.** A remote preset whose id matches a
  local one is recorded there and never installed. *Sound*: the receipt only
  describes what is actually on disk. Review caught an earlier draft that wrote a
  fake `packages` entry.
- **Concurrency:** an in-process queue per target directory, no file lock.
  *Sound*: one service owns `~/.yap/presets/`. Revisit if a second writer appears.
- **`directorySource` labels its packages `bundled`; any other source defaults to
  `downloaded`.** *Sound*: matches the two install paths in the spec.
- **`list()` takes name, description and version from the installed `PRESET.md`.**
  The receipt's version is the fallback. *Sound*: the file on disk is the truth.

## Slice 03 (read operations and bundling)

- **`createPresets` is async and completes installation before returning the facade.**
  *Sound*: package installation streams and atomically swaps files, so callers never read a
  partially installed tree.
- **Unknown ids throw `PresetNotFoundError` with code `PRESET_NOT_FOUND`.**
  *Sound*: the service's existing error adapter can preserve the normal refusal envelope while
  keeping the core facade typed.
- **Instruction templates use uppercase exported constants.**
  *Sound*: the template strings are public data owned by `preset-instructions`, and the names
  distinguish them from rendered instruction lists.
- **A failed bundled install never stops the service.** `createPresets` catches the
  failure and reports it as `refresh.error` in `preset.list`. *Sound*: presets are an
  add-on; recording and editing must keep working. Added in review.
- **`preset.get`'s instructions point at `shoot-plan.svg` and the kit's
  `measure.mjs` and `check.mjs` by absolute path.** *Sound*: the agent gets paths it
  can act on directly.

## Slice 04 (refresh)

Codex wrote the remote source and the refresh, then stopped twice on "model at
capacity". Review fixes and the service wiring were done by hand.

- **Remote tests inject `fetch` rather than run an HTTP fixture server.** *Sound*:
  same contract (pinned URLs, statuses, streams), and it runs inside a sandbox
  that can't listen on sockets. The spec named a local server.
- **Timeouts:** a request timeout plus a fixed per-read inactivity timeout (30 s
  default), with no limit on a whole file. *Sound*: there's no per-preset cap, so a
  large file may take long but a stalled one may not. Review removed a version that
  scaled per-read timeouts by file size and leaked a timer on every request.
- **An id-scoped `preset.update id` also refreshes the kit and guide**, and only
  removes packages it owns. *Sound*: a preset may depend on a newer kit.
- **Refresh is opt-in for `startProjectService`**; `main.ts` turns it on and
  `YAP_PRESETS_REFRESH=0` turns it off. *Sound*: about 18 test callers start the
  service and must not hit the network.
- **When refresh is off, `preset.update` succeeds with a failed report and
  instructions saying nothing was downloaded.** *Provisional*: a refusal code would
  also be defensible. Kept as output-by-default.
- **`preset.update` uses the `drain` wait budget**, like other long operations.
  *Sound*.

## Slice 06 (skill route)

- **The routing paragraph sits in the skill's "Task references" section.** That is
  where every other "go read X" pointer lives. *Sound*.
- **The eval case runs with the CLI available and accepts an honest "unavailable"**
  when the service can't run in the Linux trial. *Sound*: it grades routing, not
  native readiness, like the existing `*-reference-routing` cases.
- **The skill names `preset.create` and `preset.delete` one slice before they
  exist.** *Provisional*: slice 05 lands next on the same branch, before any
  release.

## Slice 05

- **Generated ids use Unicode NFKD before dropping non-ASCII characters.** *Sound*: names with accents retain their readable ASCII base while the public id contract stays ASCII.
- **Local file references must point to regular files.** *Sound*: a directory is not a reference media file and should be refused before any scaffold is written.
- **Create reads the installed authoring template and instructions.** *Sound*: bundled and refreshed authoring packages are the runtime source of truth, so guide changes reach new local presets without an app release.
- **Delete reports the original preset path in `trashedPaths`.** *Sound*: that is the path passed to the Trash operation and lets callers identify what was moved.
- **One `PresetError` base carries code, message and details**, and the service maps
  it with a single check. *Sound*: review replaced a four-way `instanceof` chain.
- **Names that the frontmatter parser would misread** (a colon, `#`, quotes, or
  edge spaces) are written JSON-quoted. *Sound*: found in review; covered by a test.
- **The create/delete wire test was written by hand.** Codex's sandbox can't open
  the service socket.

## Slice 07 (proof, part 1)

- **The export proof used the installed Yap 0.1.51, not a dev build.** *Sound*:
  `edit.apply` and export don't depend on the preset operations, and the installed
  app has the native media helper this worktree lacks.
- **The proof grades the video track, not the output.** This is forced by the
  output-target export bug recorded in slice 07.

## Whole-feature review (Codex, against main)

All five findings were confirmed in the code and fixed, test first.

- **`preset.get` serves only installed or local preset ids** that match the id format.
  A crafted id such as `../x` returns not-found. *Sound* (P1).
- **The installer refuses a remote package whose id or kind is outside the format**
  before building any path from it. A remote index is untrusted input. *Sound* (P1).
- **`PresetRefresh.close()` waits for a run in flight.** The service awaits it before
  releasing ownership. *Sound* (P2).
- **`preset.update` names only downloaded presets** as things to `preset.get`; kit and
  guide updates aren't presets. *Sound* (P2).
- **`preset.create` waits for a refresh in flight and reserves every id in the last
  remote index**, not just newer ones. *Sound* (P2). A preset published after that
  index can still collide; the installer then records a conflict and the local
  preset keeps its id.
