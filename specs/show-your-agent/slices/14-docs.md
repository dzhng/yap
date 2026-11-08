# 14 Skill, principles, catalog, release notes

**Contract unlocked:** agents and contributors read the new behaviour from its owners.

- `skills/yap/SKILL.md`: how to explore a pasted prompt (read the existing transcript first;
  use marks via `timeline.events`; frames via `index.get`, which now has mark reasons);
  `:192-204` no longer presents transcription as something to request first; `:36` on model
  downloads. `references/media-workflows.md:40-45` ("ask before acquiring") updated for the
  automatic backlog. `references/capability-catalog.md` lists `shortcuts.*` and
  `recording.prompt`.
- `DEVELOPMENT.md:21-47`: automatic *evidence* (transcripts) is allowed; automatic *edits*
  never are.
- `apps/macos/README.md` (shortcuts, countdown default, prompt), `apps/service/README.md`
  (backlog, background priority).
- `scripts/release-notes.md`: an entry for the release; the skill reaches users only with a
  release (`scripts/build-macos.mjs:73`).
- Changing `AGENTS.md` (for example "transcribing" as an expensive run) requires
  `audit-agents` first.

**Verify:** the `readme`, `skill-*` and first-party model evals in `evals/cases.json` that
these files feed, run once here, not per edit. Load `write-docs` before writing.
