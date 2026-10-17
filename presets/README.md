# Presets

Each folder here is a package the service installs into `~/.yap/presets/` and
serves through `preset.*`: one folder per preset (`PRESET.md` is the entry point),
`kit/` (the measuring and checking tools every preset links as `../kit/`) and
`authoring/` (the guide `preset.create` returns). The installed tree mirrors this
one, so relative links work the same in both.

- To make or change a preset, follow [AUTHORING.md](authoring/AUTHORING.md).
- Bump the package's frontmatter `version` on any change; installs only take higher
  versions.
- Regenerate the index with `node scripts/presets-index.mjs`, and check it with
  `--check` (stale index, broken links, unbumped versions, files over GitHub's
  100 MiB limit, examples that fail their own mood targets).
- Full reference videos go in `examples/<slug>/source/`, which Git ignores and the
  app bundle drops. Everything else here is public and downloaded by every install.
- Kit tests: `node --test presets/kit/*.test.mjs`.

Why presets work this way: `specs/done/presets/README.md` in the repository.
