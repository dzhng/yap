# 15 Skill recipe and evals

**Contract.** `skills/yap/SKILL.md` gains a short section, "Removing media and
reclaiming space":
1. Delete what the user named with `asset.delete`, `recording.delete`,
   `project.delete` or `model.remove`.
2. An `IN_USE` refusal lists the projects using the item and the bytes each choice
   frees. Report this to the user. Use `cascade: true` or delete a project **only
   when the user asked for that.**
3. **To free a clip that only a project's history holds:**
   - `edit.apply` to remove the clip;
   - `project.duplicate` at the head revision;
   - check the copy (preview, or `revision.get`);
   - `project.delete` the original;
   - `asset.delete` the clip.
4. Package adoption can bring a deleted item back. Original files and committed
   exports are never touched.

`references/capability-catalog.md` already lists each new operation (slices 08–12).
This slice checks the catalog is complete and that no removed name remains anywhere
in `skills/`.

**Evals.** Add `evals/cases.json` cases:
- **Refused delete:** the agent reports the users and doesn't cascade unasked.
- **Authorized free-a-clip:** the agent follows the recipe end to end against the
  scripted CLI fixture, using the returned IDs, cursors and byte receipts.

**Run or see.** Run the two eval cases.

**Verify.** Both cases pass. A sweep of `skills/` for removed names
(`recording.latest`, `inspect`, `UNKNOWN_MODEL`, `afterSequence`) finds nothing.

**Firewall.** Docs and evals only.

**Delegated.** Wording, within the skill's existing tone.
