# 00 — Scale probe

Depends on: nothing. Changes no product code.

## Contract

Measured growth rates and per-stage costs for a journal of 1, 2.2 and 12 hours, so the
limits audit (02) derives bounds from numbers, not guesses.

## Seam

A deterministic generator under `packages/test-harness/long-take/` (or the nearest existing
harness owner; check `packages/test-harness` first) that writes a schema-3 journal of N hours
through the production Swift `CaptureJournal` writer, driven by `PrerecordedCaptureInput`
style fake hardware. Inputs are rates, outputs are files in a temporary directory. Never
checked in, never derived from a user's take.

Streams to model separately and together:
- `pcmAppend` at the measured ~94 lines/s;
- cursor at 60 Hz, worst case (pointer always moving) and typical (26% changes, measured on
  the origin take);
- geometry changes, pins, clicks, and one 5-minute stroke;
- camera mapping at 30 fps.

Stages, each timed alone with peak RSS: Swift `readRecords`/`streamEvidence`, publication
(`CaptureSourcePublication.publish` on a journal-only recovery fixture), `SourceEvidenceExport`,
TS `sourceEvidenceRecords` and catalog ingest.

## Run or see

`assets/probes/README.md` in this spec: a table of bytes, line counts, wall time, peak RSS and
the first bound that fails at each length. Expected today: publication fails near 2.1 hours on
`CaptureSourcePublication.swift:99`.

Run the 12-hour pass in the background with visible progress and a stop point.

## Verification

The table exists, each number names its command, and the 1-hour pass reproduces the origin
take's measured growth (about 2 MB/min) within 10%.

## Delegated

Generator structure and file location within the harness owner; whether full media at 12 hours
is attempted (expected not; say what was skipped).

## Stays green

Everything; no product change.

## Feedback that would change this slice

If the user wants real long recordings as evidence, add a device run to slice 13, not here.
