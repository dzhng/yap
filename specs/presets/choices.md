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
