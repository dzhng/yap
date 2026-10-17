# 02 Install and store

**Unlocks:** one installed tree, `~/.yap/presets/`, written only through a verified,
atomic installer, and one reader of it. Reads never choose between copies.

**Seam:**
- `packages/core/src/preset-install.ts`:
  `installPackages(source: PackageSource, target: string, select: (remote, installed) => boolean): Promise<InstallReport>`,
  where `PackageSource = { index(): Promise<PresetIndex>; file(pkg, path, expect: { bytes, sha256 }, signal): Promise<ReadableStream> }`.
  Each package is staged in `target/.staging/<uuid>`, hashed while streaming, then
  swapped in with two renames (old folder to `.staging`, new one into place, as in
  `packages/core/src/models.ts`). The report updates `receipt.json`:
  `{ packages: { [id]: { version, source: "bundled" | "downloaded", commit?, files } } }`.
- `packages/core/src/preset-store.ts`: `PresetStore(root)` with
  `list(): PresetSummary[]`, `get(id): { id, text, path, kitPath, guidePath, files, source }`
  and `local.json` (temp file + rename). Sources: `bundled`, `downloaded`, `local`.

Rules the installer owns: a higher version replaces the installed copy; a tie keeps
what is installed; a local preset is never touched; a package missing from a newer
remote index is removed only if its source is `downloaded`. If an official id
arrives that matches a local id, the local preset keeps the id and `list` flags the
conflict.

**Proof (tests first):** `preset-install.test.ts` (tampered byte keeps the previous
copy and names the path; a stream dropped halfway leaves no folder; the tie rule;
local untouched; removal rule) and `preset-store.test.ts`.

**Delegated:** stream plumbing, lock or join mechanism for concurrent installs.
