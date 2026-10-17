# 13 App: imported videos in the Recordings tab

**Contract.**
- **The Recordings tab is driven by `media.list`.**
- **Imported rows** show the original filename as the title, an "Imported" badge,
  and duration, size and import date on the detail line. Their actions are Play,
  Copy agent prompt and Delete.
- **Recording rows** keep Play and Copy agent prompt, and gain Delete. Project rows
  keep "Delete Project".
- **Storage line:** library total, split into media and models (`modelBytes`).
- **Plumbing** (Swift adapters only):
  - `MediaTarget` gains `.asset(String)` (`MediaTarget.swift:4-6`), and the agent
    prompt for an asset names its asset ID.
  - Delete dispatches by target kind.
  - `ServiceFailure` gains `details` (`ServiceBundle.swift:4-10`) for slice 14.
- **The existing deletion state machine is extended, not duplicated:**
  `state.library.deletions`, `LibraryPresentation.swift:27-78` and
  `LibraryState.swift:80-100`.

**Slice variable.** The row list only: the badge, the title, the detail line, and
the action menu. The dialog belongs to slice 14 and is out of scope here.

**Seam.** `LibraryPresentation` (pure, unit-tested) and the `LibraryController`
paging.

**Run or see.** Open the Library window on a fixture library containing a
recording, an imported video, a project and a deletion in progress.

**Verify.**
1. YapControls unit tests: rows built from `media.list` pages, paging, and the
   deletion state for asset targets.
2. Shots: `apps/macos/tests/library-view-shots.mjs`, before and after.
3. Run [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md),
   with the old Recordings tab and the approved mock
   ([../visualizations/delete-mock.html](../visualizations/delete-mock.html), left
   panel) as targets. Judge only the slice variable.
4. **Last check before accepting:** run
   [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md),
   an unprimed second opinion, on the new shots.
5. **Non-blocking review:** open the shots with
   [preview-shots](../../../.agents/skills/preview-shots/SKILL.md) and allow about
   5 minutes for a response. If the user is silent, decide on the evidence, record
   the decision here, close the shots and continue.

**Firewall.** No service or protocol changes. If the app needs data the service
lacks, that goes back to slice 12.

**Delegated.** Badge styling, detail-line formatting and byte formatting, all
within the mock's intent.
