# 10 — Derived limits and the 12-hour stop

Depends on: 02 (H1), 03, 07.

## Contract

- Every bound in `limit-verdicts.md` is either computed from a requirement with
  `derivedBound(...)` in its owning module, with the derivation beside it, or deleted.
- A take ends cleanly at `MAXIMUM_TAKE_US` of recorded time: the ordinary finish path runs, the
  take is `complete`, it imports normally, and the app shows a status line (not an error) that
  the take reached 12 hours.
- A synthetic 12-hour journal passes publication, export, import and reads (00's generator).

## Seam

- Constants per `limit-verdicts.md`, in their owning modules; no shared "limits" grab-bag
  besides the two requirements.
- Stop: the writer or `CaptureClock` owner triggers the existing finish path
  (`NativeCapture` / `CaptureController.finish`) when source time reaches the requirement. The
  lifecycle records a reason such as `maximumDuration`; it is not a failure code.
- If 02 decided the stop-time passes must fold (`CaptureSourcePublication.swift:339-381`,
  `acquisitions.ts:1027`), fold them into one streamed pass here.
- If 02 decided a free-disk check, add it here with its derivation.

## Run or see

00's generator at 12 hours through each stage, with the same table format; the before/after
table goes into `assets/probes/README.md`.

## Verification (red first)

- A scan test: the retired literals (`268_435_456`, `1_048_576` outside schema ≤3
  interpretation, line `65536`) no longer appear in capture, evidence, publication or package
  source.
- `PrerecordedCaptureInput` with only the clock faked crosses 12 hours and publishes a complete
  take; pause time doesn't count.
- 12-hour synthetic stages pass within the deadlines 02 derived.
- `SelectedCaptureMediaTests` (~111-129) expectation of `EVIDENCE_LIMIT` updated to the derived
  behaviour.

## Delegated

Trigger placement; margins already fixed in 02.

## Stays green

Media clocks, publication authority, camera toggling, cancellation cleanup.
