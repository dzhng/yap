# 02 Read operations

**Unlocks:** an agent can run `yap preset.list` and `yap preset.get <id>` and
receive raw preset text, the way a skill delivers text.

**Seam:**
- Protocol: `preset.list` and `preset.get` entries in
  `packages/protocol/src/operations.ts`, written like `model.list`. They are
  service-routed: don't add `preset` to the `appOperations` regex. The
  `.describe()` text says what a preset is and that it is unrelated to
  `settings.preset`.
- Service: a preset catalog owner constructed in `startProjectService` from a
  bundled directory option (environment variable `YAP_PRESETS_DIRECTORY`, set by
  the app) and `~/.yap/presets`. Its handler cases sit next to `model.list`.
- Build: `scripts/build-macos.mjs` copies repo `presets/` into
  `Contents/Resources/presets`, and the native launcher passes its path.
- `preset.get` returns `PRESET.md` text, the absolute folder path and the file
  list. It doesn't read other files itself; the agent follows the relative links,
  as with a skill. The installed folder never contains symlinks or files outside
  the index.

**Run or see:** with one stub preset in `presets/`, run `yap preset.list` and
`yap preset.get <id>` against a dev service. Run `yap preset.get --help` to see
the schema.

**Proof:**
- Protocol test: both operations admit valid params and reject extra params
  (`packages/protocol/src/index.test.ts`).
- Service wire test, modeled on "model discovery crosses the public wire"
  (`apps/service/src/project-service.test.ts`): list and get; the higher version
  wins when an id is both bundled and downloaded; a version tie goes to bundled;
  every relative link in a returned `PRESET.md` resolves inside the returned
  folder; unknown id → `PRESET_NOT_FOUND`.
- CLI/MCP parity: the existing `apps/cli/src/main.test.ts` parity tests cover the
  new operations with no adapter code.

**Delegated:** the result field names beyond the README contract, and the error
code wording.
