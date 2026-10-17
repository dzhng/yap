# 01 Format

**Unlocks:** a preset is a folder with a validated manifest, and `presets/index.json`
is generated from the folders, so every later slice reads one shape.

**Seam:** a pure module, `packages/core/src/presets.ts` (or a sibling the
implementer judges better owned), with:
- `parsePreset(files) -> Preset | issues` validates frontmatter (id matches folder,
  `[a-z0-9-]+`, positive integer `version`, `references` are https URLs) and the
  required `## Shoot` and `## Edit` sections. Every relative link in `PRESET.md`
  must name a file in the folder; links that escape it, and symlinks, are rejected.
- `buildIndex(root) -> Index` returns the files sorted by path, with bytes and sha256.

A repo script `scripts/presets-index.mjs` writes `presets/index.json`.
`--check` fails when the committed index is stale or a preset is invalid.

**Run or see:** `node scripts/presets-index.mjs --check` prints each preset with
its version and file count.

**Proof (write tests first):**
- An invalid id, a missing section, an id that doesn't match its folder, and a
  non-https reference are each rejected with a named issue.
- Changing one byte of a file changes that file's index entry. The check fails
  until the index is regenerated.
- A file changed without a `version` bump fails the check. Compare against the
  index at `HEAD`.

**Stays green:** the core package's own tests, and `node --test presets/kit/*.test.mjs`
(add it to the root `test:tools` script). Every example passes its preset's
`targets.json` with `kit/check.mjs` (a check in `presets-index.mjs --check`). No catalog or project change.

**Delegated:** module naming, the frontmatter parser (use an existing dependency
if the repo has one), and the issue wording.

**Feedback that would change it:** a request for presets in another shape, such
as a single file, or for user-local presets now.
