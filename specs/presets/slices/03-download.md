# 03 Download

**Unlocks:** a new preset or a new version reaches users by merging to `main`,
with no app release and no action from the user or agent. The service refreshes
on its own; `preset.update` runs the same refresh on demand.

**Seam:** one `refresh(id?)` on the same catalog owner. The service calls it at
startup and once a day (an unref'd timer, so it never keeps the process alive),
and `preset.update {id?}` calls it directly. Concurrent calls join the one in
flight. It:
1. Resolves `main` of `dzhng/yap` to one commit, using the GitHub API for commits.
2. Fetches `presets/index.json` at that commit from `raw.githubusercontent.com`.
3. Fetches each listed file of the selected presets at that commit into
   `~/.yap/presets/.staging/<uuid>`, checking bytes and sha256 against the index.
4. Renames each preset into `~/.yap/presets/<id>/<version>/` and writes
   `receipt.json` (commit, time, files).

Any mismatch, network failure or size bound leaves the installed state unchanged
and reports the preset id and file path. Older installed versions are removed
after a successful install. The base URL is a service option, so tests can point
it at a local HTTP fixture server; production uses the fixed repo.

Bound each download: a cap on the index size and on each file's size, and a
request timeout. That follows `audit-performance`'s bounded-work rule.

**Run or see:** bump a preset's version on a branch and point a dev service's
base URL at it. Without calling anything, `yap preset.list` shows the new version
as `downloaded` after the startup refresh. `preset.update` does the same at once.

**Proof (local fixture server, no real network in tests):**
- A newer version installs, and `preset.list` reports it.
- One tampered byte fails with the file path, and the previous version is still served.
- A server that drops halfway leaves no partial folder and no receipt change.
- Two concurrent refreshes (the timer and `preset.update`) join into one run and
  don't corrupt the installed copy.
- The startup refresh runs without a call, and a failed one leaves the previous
  copy served and records the error in `preset.list`'s refresh state.
- Only presets with a higher remote version are fetched.

**Delegated:** the HTTP client, the join mechanism, and whether `preset.list --remote`
reuses the last refresh's index.

**Later, not v1:** index signature.
