# 04 Refresh

**Unlocks:** a new or changed preset, kit or guide reaches every install by merging
to `main`, with no app release and no action from anyone.

**Seam:**
- `packages/core/src/preset-remote.ts`: `remoteSource({ baseUrl, fetch, maxIndexBytes, maxFileBytes, timeoutMs })`.
  It resolves `main` once to a 40-hex commit through the GitHub commits API, then
  fetches `presets/index.json` and each file at that commit from
  `raw.githubusercontent.com`. Every request uses the pinned commit.
- `packages/core/src/preset-refresh.ts`: `PresetRefresh({ install, clock, everyMs })`
  with `run(id?)` (overlapping calls join the one in flight), `state()`, `start()`,
  `close()`. Runs at startup and every 24 h; the timer is unref'd and closed with the
  service. Opt-in in `startProjectService` (about 18 test callers start the
  service); `main.ts` turns it on.
- Operation `preset.update { id? }`: runs the refresh now; add a wait budget in
  `waits` in `operations.ts`. New codes: `PRESET_DOWNLOAD_FAILED`, `PRESET_HASH_MISMATCH`.

**Run or see:** point a dev service's base URL at a branch with a bumped version.
After startup, `yap preset.list` shows it as `downloaded` without any call;
`yap preset.update` does it at once.

**Proof (local HTTP fixture server, fake clock, no real network):**
`preset-refresh.test.ts`: startup run, daily run, joined calls, offline (error
recorded, previous copy served), a tampered file, a dropped connection, only newer
versions fetched, local presets untouched.

**Risks:** the unauthenticated GitHub API limit (one call a day per install is
fine); the first full download (bounded by the 50 MB-per-preset budget).

**Later, not v1:** an index signature, before presets come from anyone but us.
