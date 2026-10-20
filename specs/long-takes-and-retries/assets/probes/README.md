# Schema-3 long-take scale probe

Measured 2026-10-20 on Apple M5 Pro, Darwin 25.6.0, Node v24.14.0, Swift 6.3.3, optimized native code. Production revision: `e21db58b5e1a01aa844f94717ed94a5abf220e04`; only the harness/spec files differ. Exact source hashes, individual commands, byte counts, peak RSS and failure envelopes are in [results.json](results.json).

The 1-hour combined typical journal is **115,185,583 bytes / 60 = 1.920 MB/min** (decimal MB), within 10% of the required approximate 2 MB/min reference. No origin recording or library was accessed.

Every requested length finished. The complete 12-hour matrix took approximately **480.1 s** from the first generation start to the last stage log, including between-stage statistics; its enforced budget was 3,600 s. No stage needed early termination. A focused check separately exercised the stop path and verified peak-RSS collection.

## Inputs and scope

[The harness](../../../../packages/test-harness/long-take/README.md) owns invocation and fixture semantics. It calls the production Swift `CaptureJournal` writer, uses its existing 30-sample cursor batches, and supplies fixed clocks, 48 kHz mono PCM mappings at 94 appends/s, and 60 Hz pointer samples. Typical motion changes coordinates on 26% of transitions; schema 3 still writes every tick. Worst-case motion changes every transition. Geometry moves horizontally every minute. Events add one pin, one click and one five-minute stroke offered at 60 points/s. The existing writer thins the stroke to fit its own line cap; this is observed behavior, not a probe fix.

The separate camera mapping is a deterministic **size model** at 30 fps. It uses production `CameraFrameMapping` and rational-time encoders with a fixed callback envelope matching `CaptureClockIngress.log`. It does **not** run the ingress writer or verify camera media. Camera bytes are excluded from journal growth and journal-stage input sizes. The camera-only journal contains only header/origin/completion; its stage results measure that empty journal, not the mapping. Full media creation, capture devices, camera publication and media import were skipped at every length. Catalog ingest here means production `SourceEvidenceStore.ingest`, with a real scratch `CaptureStore` allocation and its normal owner validator, not asset/media admission.

Publication calls `CaptureSourcePublication.publish` on a completed journal-only fixture. With no `video.mov`, smaller journals reach a missing-member prerequisite (`INVALID_MEDIA`). This is not a successful source publication. Export is independently measured through production `SourceEvidenceExport` without a source-authority receipt. No receipt or normalized file is fabricated to bypass a failed stage.

## Commands and measurement

From the repository root, build only protocol/composition/core as needed, then:

```sh
node packages/test-harness/long-take/probe.mjs --output /tmp/long-take-probe --hours 1,2.2,12
```

The measured runs used the runner's `--build` option to reuse native modules. Reproduce the extra publication bracket with `--hours 2.4 --profiles combined-typical`. `results.json` preserves each runner invocation and all per-stage argv arrays; `$REPO`, `$BUILD`, `$OUT`, `$CORRECTED`, and `$BRACKET` replace disposable local prefixes. Build uses `swiftc -O -swift-version 6 -package-name YapNative`; native media/capture libraries use `-enable-testing` to access existing internal camera encoders, without modifying product sources.

Each stage runs alone in a new process under `/usr/bin/time -l`. Wall time includes process startup; peak RSS is the worker's full maximum resident set, not a delta. File statistics run afterward and are excluded from stage timings. A single observation per cell describes this machine/run, not a latency guarantee. No cache purge was performed.

For each row below, `D=$OUT/<hours>h-<profile>` (`$BRACKET` for 2.4 h; `$CORRECTED` for 2.2 h), `S=$D/source`, `B=$BUILD/long-take`, `N=hours*3600`. Table columns name these commands, all prefixed with `/usr/bin/time -l`:

| Key | Command / production owner |
| --- | --- |
| G | `B generate S profile N 300 94 60 30` — production journal writer; also creates the separate camera size model |
| S | `B stream S` — `CaptureJournal.streamEvidence`, including its private `readRecords` loop |
| P | `B publish S <N*1000000>` — `CaptureSourcePublication.publish` |
| E | `B export S D/evidence.jsonl D/receipt.json` — `SourceEvidenceExport.write` |
| T | `node packages/test-harness/long-take/ts-stage.mjs ts-read D` — `sourceEvidenceRecords` |
| I | `node packages/test-harness/long-take/ts-stage.mjs ingest D` — `SourceEvidenceStore.ingest` |

## Measured file growth

Exact bytes and terminated lines. G supplies journal/mapping statistics; E supplies normalized statistics. “—” means absent, not zero.

| h | Profile | Journal bytes | Journal lines | Largest journal line, bytes | Camera model bytes / lines | Normalized bytes / lines |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | combined-typical | 115,185,583 | 345,668 | 762,822 | 54,389,338 / 108,000 | 37,573,841 / 216,064 |
| 1 | combined-worst | 115,185,661 | 345,668 | 762,822 | 54,389,338 / 108,000 | 37,573,919 / 216,064 |
| 1 | pcm | 84,054,590 | 338,404 | 358 | — | 0 / 0 |
| 1 | cursor-typical | 30,352,826 | 7,264 | 4,322 | — | 36,810,643 / 216,061 |
| 1 | cursor-worst | 30,352,904 | 7,264 | 4,276 | — | 36,810,721 / 216,061 |
| 1 | events | 781,608 | 67 | 762,819 | — | 780,013 / 64 |
| 1 | camera | 705 | 3 | 353 | 54,389,338 / 108,000 | 0 / 0 |
| 2.2 | combined-typical | 253,384,731 | 760,460 | 762,822 | 120,096,538 / 237,600 | 81,984,493 / 475,336 |
| 2.2 | combined-worst | 253,384,771 | 760,460 | 762,822 | 120,096,538 / 237,600 | 81,984,533 / 475,336 |
| 2.2 | pcm | 185,574,590 | 744,484 | 358 | — | 0 / 0 |
| 2.2 | cursor-typical | 67,020,527 | 15,976 | 4,353 | — | 81,221,295 / 475,333 |
| 2.2 | cursor-worst | 67,020,567 | 15,976 | 4,307 | — | 81,221,335 / 475,333 |
| 2.2 | events | 802,813 | 139 | 762,819 | — | 800,170 / 136 |
| 2.2 | camera | 705 | 3 | 353 | 120,096,538 / 237,600 | 0 / 0 |
| 12 | combined-typical | 1,392,503,313 | 4,147,928 | 762,822 | 658,589,339 / 1,296,000 | — |
| 12 | combined-worst | 1,392,503,241 | 4,147,928 | 762,822 | 658,589,339 / 1,296,000 | — |
| 12 | pcm | 1,021,920,328 | 4,060,804 | 360 | — | — |
| 12 | cursor-typical | 369,635,100 | 87,124 | 4,383 | — | — |
| 12 | cursor-worst | 369,635,028 | 87,124 | 4,337 | — | — |
| 12 | events | 977,121 | 727 | 762,819 | — | 965,657 / 724 |
| 12 | camera | 706 | 3 | 354 | 658,589,339 / 1,296,000 | 0 / 0 |
| 2.4 | combined-typical | 276,441,182 | 829,592 | 762,822 | 131,047,738 / 259,200 | — |

## Isolated stage cost

Cells are **status · wall seconds / peak RSS MiB** (MiB = 1,048,576 bytes). ✓ = success; M = missing-media prerequisite; L = byte-budget failure; R = normalized-record limit; B = blocked because production export produced no input. Each failure's original code/message is retained in JSON. G includes the camera model where selected.

| h | Profile | G | S | P | E | T | I |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | combined-typical | ✓ · 5.371 / 27.25 | ✓ · 2.496 / 17.83 | M · 5.348 / 18.11 | ✓ · 3.561 / 24.52 | R · 0.100 / 101.77 | R · 0.191 / 105.88 |
| 1 | combined-worst | ✓ · 4.231 / 27.22 | ✓ · 2.542 / 17.78 | M · 5.461 / 18.22 | ✓ · 3.563 / 24.45 | R · 0.115 / 102.80 | R · 0.197 / 106.19 |
| 1 | pcm | ✓ · 2.743 / 12.55 | ✓ · 1.975 / 12.70 | M · 4.104 / 13.17 | ✓ · 2.042 / 13.16 | ✓ · 0.077 / 85.17 | ✓ · 0.084 / 86.56 |
| 1 | cursor-typical | ✓ · 0.436 / 12.77 | ✓ · 0.460 / 12.89 | M · 1.204 / 13.52 | ✓ · 1.815 / 13.64 | ✓ · 0.390 / 176.48 | ✓ · 1.390 / 204.09 |
| 1 | cursor-worst | ✓ · 0.507 / 12.75 | ✓ · 0.562 / 12.92 | M · 1.182 / 13.34 | ✓ · 1.763 / 13.59 | ✓ · 0.398 / 177.05 | ✓ · 1.380 / 184.34 |
| 1 | events | ✓ · 0.050 / 28.23 | ✓ · 0.066 / 17.55 | M · 0.121 / 17.91 | ✓ · 0.082 / 24.20 | R · 0.096 / 85.47 | R · 0.102 / 87.11 |
| 1 | camera | ✓ · 1.150 / 12.67 | ✓ · 0.011 / 12.42 | M · 0.012 / 12.70 | ✓ · 0.011 / 12.91 | ✓ · 0.086 / 85.36 | ✓ · 0.091 / 86.42 |
| 2.2 | combined-typical | ✓ · 9.149 / 27.13 | ✓ · 5.388 / 17.81 | M · 11.392 / 18.88 | ✓ · 7.638 / 24.44 | R · 0.093 / 101.02 | R · 0.179 / 104.69 |
| 2.2 | combined-worst | ✓ · 9.498 / 27.11 | ✓ · 5.752 / 17.86 | M · 18.114 / 19.67 | ✓ · 11.118 / 24.50 | R · 0.135 / 102.94 | R · 0.306 / 106.36 |
| 2.2 | pcm | ✓ · 7.113 / 12.50 | ✓ · 4.892 / 12.63 | M · 9.942 / 13.14 | ✓ · 4.902 / 13.09 | ✓ · 0.093 / 85.44 | ✓ · 0.095 / 86.94 |
| 2.2 | cursor-typical | ✓ · 1.047 / 12.81 | ✓ · 1.118 / 12.86 | M · 2.313 / 13.34 | ✓ · 3.485 / 13.56 | ✓ · 0.659 / 237.98 | ✓ · 2.677 / 237.86 |
| 2.2 | cursor-worst | ✓ · 1.034 / 12.81 | ✓ · 1.094 / 12.88 | M · 2.277 / 13.33 | ✓ · 3.582 / 13.56 | ✓ · 0.668 / 238.27 | ✓ · 2.655 / 229.11 |
| 2.2 | events | ✓ · 0.050 / 26.94 | ✓ · 0.064 / 17.55 | M · 0.125 / 17.89 | ✓ · 0.075 / 24.16 | R · 0.091 / 85.48 | R · 0.096 / 86.52 |
| 2.2 | camera | ✓ · 2.441 / 12.61 | ✓ · 0.011 / 12.42 | M · 0.011 / 12.69 | ✓ · 0.013 / 12.88 | ✓ · 0.094 / 85.44 | ✓ · 0.099 / 86.72 |
| 12 | combined-typical | ✓ · 123.531 / 29.81 | ✓ · 51.863 / 17.84 | L · 9.877 / 17.97 | L · 0.015 / 11.64 | B | B |
| 12 | combined-worst | ✓ · 81.948 / 27.31 | ✓ · 45.965 / 17.84 | L · 9.444 / 17.94 | L · 0.014 / 11.63 | B | B |
| 12 | pcm | ✓ · 53.051 / 12.58 | ✓ · 39.489 / 12.64 | L · 10.038 / 12.83 | L · 0.018 / 11.72 | B | B |
| 12 | cursor-typical | ✓ · 6.899 / 12.83 | ✓ · 7.845 / 12.91 | L · 5.323 / 12.97 | L · 0.012 / 11.63 | B | B |
| 12 | cursor-worst | ✓ · 5.533 / 12.81 | ✓ · 5.897 / 12.91 | L · 4.573 / 13.00 | L · 0.011 / 11.63 | B | B |
| 12 | events | ✓ · 0.055 / 26.84 | ✓ · 0.067 / 17.52 | M · 0.117 / 17.89 | ✓ · 0.086 / 24.16 | R · 0.083 / 85.31 | R · 0.093 / 87.09 |
| 12 | camera | ✓ · 12.697 / 12.66 | ✓ · 0.012 / 12.38 | M · 0.011 / 12.69 | ✓ · 0.012 / 12.88 | ✓ · 0.084 / 85.53 | ✓ · 0.089 / 86.59 |
| 2.4 | combined-typical | ✓ · 11.234 / 27.20 | ✓ · 6.120 / 17.84 | L · 6.017 / 17.88 | L · 0.010 / 11.63 | B | B |

## First failing bounds and consequences

| Requested length | First observed size/count bound | Earlier prerequisite / downstream disposition |
| --- | --- | --- |
| 1 h | T and I reject the five-minute stroke at the existing 65,536-byte normalized-line read budget | P first reaches missing video; S and E finish. Cursor-only/PCM-only evidence can be indexed. |
| 2.2 h | T and I reject the same stroke line; combined journals remain below 268,435,456 bytes | P reaches missing video, not the publication byte cap. S and E finish. |
| 12 h | P fails with `EVIDENCE_LIMIT` at the 268,435,456-byte journal budget for PCM, cursor and combined profiles; E refuses those journals at its input-size check | S reads the entire journal successfully. T/I are blocked, not timed on substitute input. Events-only still hits the stroke line bound; camera-only is an empty-journal control. |

The expected approximate 2.1-hour publication failure was **not** reproduced at 2.2 hours: the combined typical journal is 253,384,731 bytes. The additional 2.4-hour combined-typical pass crosses the cap and fails in P with `EVIDENCE_LIMIT`; its exact bytes and stage costs are included above. This brackets this model's publication size failure in **(2.2 h, 2.4 h]**, rather than changing rates or production limits to match the expectation. The publisher's `journalLimit` is the bound declared at `CaptureSourcePublication.swift:99`; its bounded summary read trips before snapshot/media publication. The exporter independently checks the same current journal byte ceiling.

The supplied aggregate reference (about 2 MB/min) is sufficient for a growth check, not byte identity or an exact failure-time prediction. Field widths, callback clocks, selected roles and event density affect the threshold. Typical cursor repetition barely changes schema-3 byte cost because all 60 Hz samples are still stored. Camera mapping growth is additional storage and was not passed through camera verification; do not infer its own first failing bound from the journal stages. No limits, readers, retry policy, schemas or product behavior were changed.

Only this report, machine-readable measurements and reproducible harness are retained. Generated journals, normalized files, catalogs, binaries and scratch logs are removed after inspection.

Focused verification: `YAP_LONG_TAKE_BUILD=$BUILD node --test packages/test-harness/long-take/probe.test.mjs` passed, including deterministic journal/mapping bytes, stored cursor values, the production five-minute-stroke refusal and the deadline stop with peak RSS. The floating-duration regression first failed with 121 cursor samples where 120 were required, then passed after duration normalization. The independent Codex review identified that rounding issue and a compiler-descendant timeout leak; both were fixed. Only the affected 2.2-hour measurements were repeated; integer-hour fixture outputs were unaffected. Focused formatter/linter checks and protocol/composition/core compilation passed; the full repository suite was not run.
