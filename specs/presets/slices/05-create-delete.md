# 05 Create and delete

**Unlocks:** any agent can make a local preset by asking Yap, and gets told exactly
what to do next; a local preset can be removed recoverably.

**Seam:** `packages/core/src/preset-scaffold.ts`:
- `presetId(name, taken: ReadonlySet<string>): string | null`: lower-case ASCII,
  words joined by `-`, other characters dropped, at most 48 characters, then `-2`,
  `-3`… until free. `taken` is installed ids plus the last refresh's `available`
  list, never a network call.
- `scaffold({ template, target, id, name, references })`: copies
  `authoring/template/` through staging and a rename, fills `id`, `name` and
  `references`, adds the id to `local.json`.

Operations:
- `preset.create { name, references? }` → `{ id, path, guidePath, kitPath, instructions }`.
  References are https URLs or absolute paths to existing files, recorded and
  never fetched. `instructions` render `presets/authoring/instructions.md` (new,
  with `{{id}}`, `{{path}}`, `{{kitPath}}`, `{{guidePath}}` placeholders), so the
  steps can change with a refresh. `AUTHORING.md`'s Method links to it; a test
  checks every step there appears in the Method.
- `preset.delete { id }` → `{ id, trashedPaths, instructions }`. Local presets only
  (`PRESET_NOT_LOCAL` otherwise). Moves the folder with an injectable
  `trash(path)` (production: `/usr/bin/trash`, proven in slice 00) and removes the
  `local.json` entry; a failed move leaves `local.json` unchanged.
- New codes: `PRESET_NOT_LOCAL`, `PRESET_NAME_UNUSABLE`, `PRESET_REFERENCE_INVALID`.

Shipping one of ours is a Git change: copy the finished folder into the repo's
`presets/` (drop `source/`), run `node scripts/presets-index.mjs`, open a PR.

**Run or see:** `yap preset.create --params '{"name":"Vertical explainer"}'` twice
gives `vertical-explainer` then `vertical-explainer-2`; `preset.list` shows both as
`local`; `preset.delete` puts one in the Trash.

**Proof (tests first):** `preset-scaffold.test.ts` (ids and suffixes, a refused
reference writes nothing, an interrupted copy leaves nothing) and service wire
tests with a fake trash (create, list, get, delete, refusal of bundled ids, the
rendered `instructions` name the real paths).

**Dogfood gate:** create a local preset of an existing style with a new reference
video, follow the `instructions` to a finished preset, record where the guide fell
short, and fix the guide.

**Delegated:** templating details and error wording.
