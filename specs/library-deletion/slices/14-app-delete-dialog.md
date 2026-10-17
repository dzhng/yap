# 14 App: one delete confirmation

**Contract.** Every delete in the app shows one confirmation dialog:
`DeleteConfirmation`, a pure presentation in YapControls rendered as an `NSAlert`.
- **Title:** "Delete *name*?"
- **Body:**
  - "This can't be undone.";
  - the bytes freed;
  - for an imported video, "Your original file isn't touched".
- **Buttons:** Cancel and **Delete**.
- **When the item has users,** the same dialog lists them (project title and
  revision count, as in the `IN_USE` details) and its button reads **Delete all**.
  Confirming sends `cascade: true`. There is never a second dialog.
- **Flow:** the app calls delete without `cascade` first. A plain delete shows the
  simple dialog before calling. An `IN_USE` refusal turns into the cascade dialog,
  built from `ServiceFailure.details`; the app makes no queries of its own.
- **Projects** use the same dialog. This replaces today's unconfirmed
  "Delete Project" (`LibraryController.swift:166-190`).

**Slice variable.** The dialog only, in three states: plain, imported, cascade.

**Seam.** `DeleteConfirmation` (pure state to text and buttons, unit-tested), plus
one presenter.

**Run or see.** In the Library window, trigger each of the three states on the
slice 13 fixture library.

**Verify.**
1. Unit tests: the text for each state; refusal leading to the cascade state; the
   cascade button sending `cascade: true`; cancel sending nothing.
2. Shots of all three states.
3. Run [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md)
   against the approved mock
   ([../visualizations/delete-mock.html](../visualizations/delete-mock.html), right
   panel). Judge the wording, the hierarchy and the button labels.
4. **Last check before accepting:** run
   [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md),
   unprimed.
5. **Non-blocking review:** use
   [preview-shots](../../../.agents/skills/preview-shots/SKILL.md) and allow about
   5 minutes. If the user is silent, decide on the evidence, record the decision,
   close the shots and continue.

**Firewall.** The UI never invents a cascade policy and never lists derived or
generated assets on its own.

**Delegated.** Layout details within a standard `NSAlert`.
