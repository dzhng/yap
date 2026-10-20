# Choices ledger

Decisions made during implementation where the spec was silent. Per-pass entries; consolidated
at close.

## Slice 03

- **`derivedBound` takes growth per second and rounds up.** Sampling and write rates are stated
  per second, and a bound must hold whole units. Sound.
- **Swift mirror is `YapMedia.Requirements` with `Int64` microseconds.** `YapMedia` is the
  lowest module both capture and wire code import, and native time is `Int64` µs. Sound.
- **The Swift equality check runs in the existing `YapCaptureTests` executable** (selector
  `YAP_REQUIREMENTS`, also in the default run) instead of a new test target. Matches how every
  other capture test is wired. Sound.

## Slice 04

- **`details.retry` is validated against `operationSchema`** and an invalid directive throws when
  the error is built. A bad directive is a programming error and should fail loudly. Sound.
- **An owner's explicit directive wins over the adapter's self-retry rule**, and the self-retry
  rule applies only to retryable failures. Sound (corrected in review: it first applied to every
  refusal, which told agents to resend `NOT_FOUND` reads).
- **The Swift app reads the bundled `service/refusal-ledger.json`** for its own errors; a missing
  ledger is a fatal error, and source-compiled test fixtures stage the file beside their binary.
  Sound (corrected in review: it first fell back to a build-machine checkout path).
- **Self-retry is attached on every adapter path** (socket, control channel), not per handler.
  Sound: one rule, one owner (`apps/service/src/operation-errors.ts`).

## Slice 07

- **The TS reader reuses protocol's `JsonLineStream`** rather than a second splitter; Swift
  keeps a scan offset and compacts once per chunk. Sound: one line splitter per language.
- **Swift restates the record-bound formula** (`60 × 103 × stroke seconds × 2`) and a test
  checks it equals protocol's `JOURNAL_RECORD_BYTES`. Sound, matching how the requirements
  themselves are mirrored.
- **Export reads batch up to 256 rows within a 1 MiB byte budget**, cut in SQL with a running
  sum, and a larger record advances alone. Sound (corrected in review: it first fetched one
  row per query, 18.6 s vs 0.85 s on 240k cursor rows; the byte-bounded version takes 1.37 s).
- **Golden pre-change exports are stored gzip-compressed** (364 KB for 6.7 MB). Sound.
- **The 1 MiB writer guard stays for all writes until slice 08** switches new takes to
  schema 4. Sound: schema 3 must keep its rule.

## Slice 08

- **The take summary's kind is `take.kind`**, not `kind`, because the published source already
  uses `kind` for its authority (primary vs camera). Sound.
- **`cursorSampling.intervalUs` is an integer of microseconds** (16,667). Sound: every other
  journal time is integer µs.
- **A stroke split at 5 minutes keeps its gesture recognition**: travel accumulates across the
  split, so a continuation shorter than the 8-point travel threshold isn't dropped. Sound
  (found in review).
- **Readers select behaviour by the persisted layout**, so inspection accepts schemas 1–4 and
  refuses higher with the version in the message. Sound.

## Slice 09

- **Trail length is bounded only by its duration** (`maximumTrailUs`, 10 s); the 1,200-point and
  5,000-observation caps are deleted in TS and Swift, and trails stream instead of reading one
  page. Sound: the limits audit derives point counts from time.
- **A held sample carries its position across cuts and scene changes** for `holds: true`
  journals; physical gaps (pauses) still reset it, and trails still reset at cuts. Old journals
  keep today's rules and outputs. Sound.
- **The stale-pointer suppression is skipped for held samples**, because a held sample is still
  where the pointer is. Sound.
- **`cursor.raw` returns the held sample at a page's start outside the page's forward allowance**,
  so pagination still advances. Sound.

## Slice 05

- **One Swift reader of the ledger, `YapMedia.RefusalLedger`, serves the app and the native
  helper.** Inside an `.app` it reads the bundled `service/refusal-ledger.json` (fatal if
  missing); a source-built tool or test reads the checkout's JSON. Sound (corrected in review:
  the app and helper first had separate readers, and the app's fixtures staged copies).
- **The C launcher's verdicts are compiled from the ledger at build** (`scripts/launcher/verdicts.mjs`),
  because the launcher must answer when the app's files can't be opened. Sound: a generated
  projection, not a second table.
- **Caller-supplied evidence is classified at the boundary that knows provenance**
  (`INVALID_INPUT_EVIDENCE`), so a reader never guesses from file names. Sound.
- **Stored capture diagnostics ignore their historical retry bit on read** and use the ledger.
  Sound, and needs no migration.
- **A test fixture hard-links verified immutable tool files** instead of cloning them, because the
  clone missed an existing 2-second probe deadline under the pinned Node. Sound: test
  infrastructure only, production deadlines unchanged.
- **Codes that state a fact about immutable captured bytes are non-retryable** (13 codes, e.g.
  `AUDIO_UNAVAILABLE`, `INVALID_JOURNAL_PREFIX`, `PUBLICATION_CONFLICT`), because the native
  helper publishes a take without a source whose failure is non-retryable and holds it pending
  otherwise. Sound (corrected after the recovery tests failed: making them retryable would have
  held such takes pending forever). Codes where our reader wrongly rejected valid bytes, such as
  `INVALID_EVIDENCE`, stay retryable.

## Integration (05 with 07–09)

- **Only schema 4 can declare held cursor samples**; an older header's `holds: true` is ignored.
  Slice 09's capability gate is the rule, and slice 08's schema test now asserts it. Sound.
- **The schema-3 long-stroke fixture was regenerated** after slice 09 added `written` to the
  `finished` cursor statistics. Nothing decodes those statistics from old journals (Swift's
  `JournalFinished` reads only state, duration and failure; TS never parses them). Sound.

## Slice 10

- **New dependency `@streamparser/json`** parses whole JSON documents (transcripts, package pages,
  evidence manifests) as streams, behind one core module (`json-stream.ts`). The limits audit
  deleted their 256 MiB caps because no rate derives them, so reading them whole would leave
  memory unbounded. Provisional: a structural addition the user owns; the alternative is reading
  whole documents with no bound.
- **`archive.cleanup` runs with no deadline**, relying on cancellation and parent ownership. The
  audit deleted its fixed 30 s and no unlink rate is measured to derive one. Low confidence: a
  hung cleanup waits until cancelled.
- **Long work budgets are observed, not fixed**: a deadline may be a function re-read every
  second as an archive streams, and deadlines longer than one Node timer re-arm. Sound.
- **The 12-hour stop runs the ordinary finish path** and records `maximumDuration` as lifecycle
  provenance, not a failure; the app shows "Take complete — reached 12 hours." as status text.
  Sound.
- **Stop-time journal passes are not folded**: measured journal work stayed under the derived
  budget. Sound, per the H1 decision.

## Slice 06

- **Historical cancelled rows are classified by reason**: `<kind>_unavailable` means the owner
  was deleted (non-retryable `OWNER_DELETED`); every other reason, including unrecognised ones,
  is a retryable `CANCELED`. One SQL expression interprets them; no backfill. Sound (corrected in
  review: unrecognised reasons first defaulted to non-retryable, against the user's rule that
  non-retryable is the last resort).
- **Startup skips only takes whose finalization actually failed**; a recovery cut short by
  shutdown or an app update (`RECOVERY_CANCELED`) is finished automatically at the next start.
  Sound (corrected in review: every recorded finalization error was skipped, which would have
  left update-interrupted takes stuck until a manual retry).
- **A failed capture recovery is retried only by `capture.stop`** (Retry Finalization), and the
  test fake now answers `INVALID_STATE` for a stop with no take, as the native helper does.
  Sound.
- **Existing `errorDetails` diagnostics stay; the resolving call is added as `details.retry`.**
  Sound.
