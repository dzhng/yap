# 16 Full check, review, release

1. Run the full suite once (`AGENTS.md`: once, at the end of a spec) and fix every
   failure, including pre-existing ones.
2. Run [review](../../../.agents/skills/review/SKILL.md): refactor-clean, then
   code-review, then write-docs. Confirm `RecordingDeletion` and `ProjectDeletion`
   are gone, there's one paging codec and one state vocabulary, and no
   compatibility alias survives.
3. Get a second opinion with `codex review`.
4. Make one real-bytes check on a scratch library: import, use in a project,
   refuse, duplicate, delete, `asset.delete`. `storage.usage` must fall by exactly
   the reported `freedBytes`.
5. Release through the [release skill](../../../.claude/skills/release/SKILL.md).
   The release notes call out the breaking API changes for scripts that call Yap
   directly.
6. Run [close-spec](../../../.agents/skills/close-spec/SKILL.md).
