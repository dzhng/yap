# 11 Index: mark reasons and stricter coverage, one policy bump

**Contract unlocked:** D5 and D21 in one change to index identity.

**Seam:**
- Source: `selectSourceIndex(support, chunks, moments?)` (`packages/core/src/source-index-selection.ts:51`)
  gains `IndexMoment = { sourceUs, kind: "mark" | "pin" | "click", markId }` from the slice 02
  reader and pointer travel from cursor samples, both only when the selection has an
  `acquisitionId`. New reason kinds `mark`, `pin`, `click`. The identity
  (`source-index.ts:42-50`) gains the acquisition evidence generation.
- Project: the project selector (`project-index-selection.ts:34-50`) receives moments through
  the occurrences it already maps.
- Coverage (D21), one pure rule both selectors use:
  `coverageDue({ sinceLastChosenUs, pictureChanged, pointerTravelPt, displayWidthPt })` is true
  only when the picture changed since the last chosen frame and either 30 s passed with no
  other frame or travel during continuous change reached one display width. Project indexes
  lose the unconditional 5 s cadence (`project-index-selection.ts:137-142`) and use the scene
  evidence they already read (`:171-174`).
- Policy ids bump (`source-presentation-selection-v2`, `project-picture-selection-v2` → v3).
  Old generations are deleted on upgrade (replacing retention at `index-processing.ts:698-704`)
  and rebuilt lazily; package import drops index records with a foreign policy
  (`project-packages.ts:619,644`).

**Verify:** `source-index-selection.test.ts` (`:138` changes as a named decision) and
`project-index-selection.test.ts` (`:82-338` rewritten deliberately; the 20000-candidate limit
test must still reach its limit by other means). New cases: a deterministic 20-minute static
narration yields only first, last, marks, clicks and scene changes; a 30 s gap; display-width
travel; a mark coinciding with a scene merges into one candidate; no `acquisitionId` → no mark
reasons. Package import of an old `.yap` drops its index; upgrade deletes old generations.

**Visual gate:** a contact sheet of the slice 04 recording's index frames, before and after:
`screenshot-critique`, then `compare-screenshots` before against after, then `preview-shots`.

**Delegated:** tuning the two thresholds on one fixture without loosening the static-page case.
