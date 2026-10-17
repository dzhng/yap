# 00 Probes and open checks

**Contract.** Each risky assumption below is confirmed or replaced, with a file and
line, before a product slice depends on it. This slice writes no product code.
Put scratch work outside the repo.

| # | Assumption | Cheapest probe | If false |
|---|---|---|---|
| P1 | Transcription never prepares a removed model on demand: only startup auto-prepare (`models.ts:689-697`) or an in-flight `model.prepare` (`models.ts:531-540`) can bring it back | Read the readiness path. The descriptions of `transcript.transcribe`, alignment and render say models "must already be prepared" | Slice 11 also fences the on-demand path |
| P2 | Every asset-owned generation kind is known: transcript (`transcript.ts:412-436`), imported transcript (`imported-transcript.ts:93-153`), scene (`scene-evidence.ts:33`), screenshot index (`screenshot-index.ts:54`), alignment (`alignment-evidence.ts:467`), derived cache (`cache.ts:66`) | `grep` for ownerKind `asset` and every `assets/<id>` path | Add the missing kinds to slice 08's list |
| P3 | For each per-item `*.retry` (index, transcript, transcript.render, cursor.render, preview, audio, frame, waveform, spectrogram, export), whether its caller receives a `jobId` | Read each operation's result schema | That retry stays in slice 06 and its description says why |
| P4 | Every error code is thrown with only one retryable value | `grep` the `new CatalogError(` call sites and Swift `NativeFailure(` against the ledger | Slice 01 splits that code in two |
| P5 | Opening a format-29 catalog twice creates the new tables idempotently | A throwaway catalog opened twice with an extra `CREATE TABLE IF NOT EXISTS` | Stop: the no-migration decision needs revisiting with the user |
| P6 | One injected failure after unlink but before row cleanup, then a restart, finishes the delete and never reports success early | Sketch it on the current `deletion.test.ts` fault pattern | Slice 02's ordering changes before anything builds on it |
| P7 | Only one path can add a user mid-delete in the current code, the one named in L1 | Adapt the "deletion fences waiting jobs" case in `jobs.test.ts` to an asset | Slice 03 adds the extra paths to the fence |

**Delegated.** How each probe is run.

**Record** each outcome in a Results table below, and correct the owning slice's
text, before slice 02 starts.

## Results

*(none yet)*
