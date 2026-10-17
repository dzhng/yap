# 01 Format and index

**Unlocks:** one validated shape for everything under `presets/`, and a generated
index every later slice reads.

**Seam:** `packages/core/src/preset-format.ts` (pure; add it to `exports` in
`packages/core/package.json`):
- `parsePackage(files: Map<string, Uint8Array>, policy: { origin: "repo" | "local" })`
  → `{ ok: true, manifest } | { ok: false, issues }`. A *package* is any top-level
  folder with an entry document whose frontmatter has `id` and `version`:
  `PRESET.md` (kind `preset`), `kit/KIT.md` (kind `kit`, new) and
  `authoring/AUTHORING.md` (kind `authoring`, frontmatter added).
- `buildIndex(manifests)` → `{ format: 1, packages: [{ id, kind, name?, description?, version, files: [{ path, bytes, sha256 }] }] }`, files sorted by path.
- `validateTree(root)` → issues for: a file over 20 MB; a shipped preset over 50 MB;
  a symlink; a Git LFS pointer; a `source/` folder (repo origin only); a relative
  link that doesn't resolve to an indexed file in the tree (so `../kit/…` passes,
  `../../x` fails); a preset missing `## Shoot` or `## Edit`; an id that doesn't
  match its folder or `[a-z0-9-]+`; references that aren't https (repo origin) or
  https or an existing absolute path (local origin).

`scripts/presets-index.mjs` writes `presets/index.json`; `--check` fails on any
issue, a stale index, a package whose files changed without a version bump
(compared with the index at the merge-base with `origin/main`, not `HEAD`), or an
example whose `profile.json` fails its preset's `targets.json` (`kit/check.mjs`).
Add `presets/**/source/` to `.gitignore`, and `node --test presets/kit/*.test.mjs`
to the root `test:tools` script.

**Run or see:** `node scripts/presets-index.mjs --check` prints each package with
kind, version and file count.

**Proof (tests first):** `packages/core/src/preset-format.test.ts` gives every issue
above a named failing case; one byte changes exactly one index entry. Narrow run:
`cd packages/core && bunx vitest run src/preset-format.test.ts`.

**Delegated:** the frontmatter parser (core has no YAML dependency; a restricted
parser for this flat schema is fine) and issue wording.
