# 03 Read operations and bundling

**Unlocks:** `yap preset.list` and `yap preset.get <id>` on a built app, with
presets bundled in it.

**Seam:**
- Protocol: `preset.list {}` and `preset.get { id }` in
  `packages/protocol/src/operations.ts`, service-routed (not in `appOperations`).
  Descriptions say presets are unrelated to `settings.preset` and the voice
  profile `preset`. New codes go in `packages/protocol/src/refusal-ledger.json`
  (`PRESET_NOT_FOUND` first).
- Service: a `Presets` facade in `packages/core/src/presets.ts`, built in
  `startProjectService` from `presets?: { bundled?: string; refresh?: RefreshOptions }`.
  At startup it installs from a filesystem `PackageSource` over the bundled
  directory (so `kit/` and `authoring/` exist in `~/.yap/presets/` before any
  refresh). Handler cases sit beside `model.list`.
- `packages/core/src/preset-instructions.ts`: `render(template, vars): string[]`;
  an unknown placeholder throws. Every successful preset result carries
  `instructions: string[]`. For `get`: follow `## Shoot` if the user hasn't
  recorded, else `## Edit` on their footage, then `## Check`, with real paths.
- Build: `scripts/build-macos.mjs` copies `presets/` (without `source/`) to
  `Contents/Resources/presets` and writes `presetsDirectory: "../presets"` into
  `runtime.json`; `apps/service/src/main.ts` passes it, with
  `YAP_PRESETS_DIRECTORY` overriding for development.
- `list` returns `{ presets: [{ id, name, description, version, source, references, conflict? }], refresh: { checkedAt, commit, error, available } , instructions }`; it never touches the network.

**Run or see:** `yap preset.list`, `yap preset.get tactile-launch-film`,
`yap preset.get --help` on a dev service and on a built app.

**Proof:** `packages/protocol/src/index.test.ts`; a wire test in
`apps/service/src/project-service.test.ts` modelled on "model discovery crosses
the public wire" (list, get, `PRESET_NOT_FOUND`, links resolve inside the tree,
`catalogFormat` still 29); CLI/MCP parity in `apps/cli/src/main.test.ts`. Narrow:
`bunx vitest run apps/service/src/project-service.test.ts -t preset`.

**Delegated:** result field names beyond the above; facade internals.
