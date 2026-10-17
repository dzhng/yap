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
