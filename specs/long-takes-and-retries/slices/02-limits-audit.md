# 02 — Limits audit

Depends on: 00 (rates).

## Contract

`specs/long-takes-and-retries/limit-verdicts.md`: every size, count and time bound that a
take's growth can reach, each with a derivation from the two requirements or a deletion
verdict. Slices 07 and 10 apply it.

## Seam

One row per bound: file:line, what grows, unit, rate (from 00), requirement it derives from
(12-hour take or 5-minute stroke), `rate × requirement × margin`, verdict (derive / delete /
not take-sized), owning slice.

Seeds (not exhaustive; sweep with grep for numeric literals in capture, evidence, publication,
package and presentation code):
- line bounds: `CaptureJournal.swift:93` (1 MiB writer), `evidence.ts:380,421` (64 KiB),
  `evidence-pages.ts:38`, `ordered-pages.ts:122-135`, `capture-source-read.ts:26-31`;
- file bounds (`268_435_456`): `CaptureSourcePublication.swift:99`, `CameraMedia.swift`
  (172, 305-337, 507, 529, 766, 1182, 1202), `ClosedCameraSource.swift:52`,
  `SourceEvidenceExport.swift:129`, `evidence.ts:128`, `capture-publication.ts:30`,
  `acquisitions.ts:110,1034,1047`, `source-admission.ts:82`;
- counts: `CaptureAudioMaterializer.swift:263`, `acquisitions.ts:759,1247`,
  `presentation-evidence.ts:27-30`, `PresentationEvidence.swift:49`, `composition-pointer.ts:27-36`,
  `ordered-pages.ts:10-12`, `CameraMedia.swift:197,439`, `CaptureClockIngress.swift:41`,
  `trails.ts:41` with its mirror `FrameTypes.swift:51`, `raw-cursor.ts:31`, `evidence-read.ts:127`;
- archive: `package-archive.ts:7-9`;
- capture queues: `CursorGeometry.swift:213,380` (batch 30, pending 240, placements 240);
- deadlines: `capture.ts:728-734`, `publication.ts:429-440`;
- the journal record bound: derived from the 5-minute stroke (18,000 points at 60 Hz × measured
  ~103 B/point × margin) for schema 4; schemas 1–3 keep their writer's 1 MiB rule as format
  interpretation.

Also decide, with 00's numbers:
- free disk: whether capture checks space, and against what derivation;
- `pcmAppend` volume: reduce only if a derived budget requires it;
- stop-time cost: whether slice 10 must fold the ~six journal passes at stop
  (`CaptureSourcePublication.swift:339-381`) into one.

Separate total-input bounds from streaming chunk sizes and scheduling cadence; chunk sizes are
not limits on what a take can hold.

## Run or see

The verdict file with the derivations as arithmetic.

## Verification

Every `268_435_456`, `1_048_576` and line-bound `65536` in capture, evidence, publication and
package code has a row. No row says "safety" without a derivation.

## Delegated

Margins (state each; 2× is the default unless measured variance says otherwise).

## Review

Checkpoint H1, non-blocking.

H1 (limits): opened for the user at 14:35 with a summary, including the ~5-minute stop for a
12-hour take; no response by 14:40. Decision: the verdicts stand as written. Slices 07 and 10
apply them; slice 10 folds the stop passes only if its measured end-to-end stop exceeds the
derived budget.
