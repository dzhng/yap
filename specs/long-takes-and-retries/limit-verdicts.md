# Take-growth limit verdicts

Slice 02 decision record; no product behavior changes here. Slices 07–10 apply these
verdicts in the existing owners. H1 belongs to the orchestrator and has not run.
Locations refer to the source audited for this slice, not to future line numbers.

The only product requirements are **T = 43,200 recorded seconds** and **S = 300 stroke
seconds**, from `packages/protocol/src/requirements.json:1`. Pauses do not consume T
(`specs/long-takes-and-retries/README.md:64`). A finite recorded duration therefore
does not bound wall-clock callbacks, pause transitions, camera toggles or authored
project complexity. Do not turn an observed rate into a new input-rate restriction.

**derive** means `ceil(rate × T or S × stated margin)` in the concept's current owner,
using protocol's `derivedBound` (`packages/protocol/src/requirements.ts:6`). The default
margin is **2×**, applied once. **delete** means remove the arbitrary ceiling, retain
structural validation, identity/receipt equality, cancellation and forward-progress
checks, and stream/batch the input. It does not mean allocate an entire file or trust
an unterminated record. **not-take-sized** means a chunk, cadence, single-item shape,
numeric representation or paginated response; its one-line reason is in the row.
Those limits cannot be used as aggregate take ceilings.

## Rates and schema-4 arithmetic

The probe measured schema 3. Target-state estimates below are **inferences**, not a
second measurement. Decimal B/MB/GB are used except where MiB/GiB is explicit.

| Quantity | Evidence (`file:line`) | Rate and requirement arithmetic |
| --- | --- | --- |
| PCM bookkeeping, one role | `specs/long-takes-and-retries/assets/probes/README.md:62`; `specs/long-takes-and-retries/assets/probes/results.json:3220` | Measured 94 appends/s, 4,060,800 appends and 1,021,920,328 B at T: 23,655.563 B/s. Two roles at the same rate are an inference: 188 appends/s and 2,043,840,656 B/T. This is metadata, not PCM media. |
| Cursor reads and writes | `specs/long-takes-and-retries/assets/probes/results.json:3359`; `specs/long-takes-and-retries/slices/09-change-only-cursor.md:7` | Reads stay 60/s: `60 × T × 1 = 2,592,000`. Schema-4 writes: typical `60 × 0.26 × T × 1 = 673,920`, worst `60 × T × 1 = 2,592,000`, plus forced first/resume observations. The measured typical change count is 673,919; the extra first sample explains the nominal 673,920. Epoch/eligibility/button changes can raise typical writes toward worst case. |
| Cursor flush envelopes | `specs/long-takes-and-retries/slices/09-change-only-cursor.md:10`; `helpers/mac/Sources/YapCapture/CaptureJournal.swift:195` | Inference: `2 flushes/s × T × 1 = 86,400` timed opportunities, at most 30 ordinary readings per 500 ms, plus seal/resume boundaries. Never scale the envelopes by 26%; never wait for 30 changed samples. |
| Cursor storage estimate | `specs/long-takes-and-retries/assets/probes/README.md:63`; `helpers/mac/Sources/YapCapture/CaptureJournal.swift:247` | Measured maximum batch line 4,383 B/30 = 146.1 B/read including amortized envelope. Conservative schema-4 inference: retain that per-sample proxy and add 128 B/flush (inferred envelope allowance for the fixed keys and integer widths): typical `146.1 × 15.6 × T + 128 × 2 × T = 109,518,912 B`; worst `146.1 × 60 × T + 128 × 2 × T = 389,750,400 B`, before extra geometry/resume records. These are planning estimates, not file ceilings. |
| Camera mapping | `specs/long-takes-and-retries/assets/probes/results.json:3870`; `specs/long-takes-and-retries/assets/probes/README.md:13` | Measured size model only: `30 × T = 1,296,000` rows, 658,589,339 B, 15,245.124 B/s, largest line 510 B. Nominal 2× budgets would be 2,592,000 rows and 1,317,178,678 B. Actual camera callback rate is device-selected, not universally 30 Hz (`helpers/mac/Sources/YapCapture/CameraCaptureInput.swift:465`); these are not valid universal caps. |
| Stroke point bytes | `specs/long-takes-and-retries/assets/probes/README.md:65`; `packages/test-harness/long-take/Main.swift:109`; `helpers/mac/Sources/YapCapture/CaptureJournal.swift:215`; `specs/long-takes-and-retries/slices/02-limits-audit.md:33` | Probe offers 18,000 points; the current writer keeps even indices plus the last: 9,001 points. Its 762,819 B line gives **84.748 B/retained point including amortized envelope** (inference from measured bytes and code). The slice supplies **~103 B/point** as its measured planning reference; results.json has no separate 103 B/point statistic. Use the larger 103 B planning rate, not 762,819 B as a schema-4 stroke size. |
| Schema-4 largest record: an unthinned stroke | `helpers/mac/Sources/YapCapture/CaptureJournal.swift:749`; `specs/long-takes-and-retries/slices/08-schema-4.md:7`; `specs/long-takes-and-retries/slices/02-limits-audit.md:32` | `60 points/s × S = 18,000` points, `103 × 60 × S = 1,854,000 B` nominal, **`103 × 60 × S × 2 = 3,708,000 B` record bound**. Margin covers numeric widths, envelope/window metadata and a boundary point; it is not permission to thin. Cursor batches (~4.4 KB), PCM rows (360 B measured) and modeled mapping rows (510 B) are smaller. Apply this to journal and normalized record bytes; do not grant every historical schema a different format. |
| Continuous marking | `helpers/mac/Sources/YapCapture/MarkRecognizer.swift:143`; `specs/long-takes-and-retries/slices/08-schema-4.md:7` | Inference for held ⇧: `T/S = 144` consecutive strokes; `103 × 60 × T = 266,976,000 B` nominal point payload, 533,952,000 B with 2×. The probe's **one** thinned stroke is not an upper bound on marks per take. Mouse-monitor clicks/retractions have no measured maximum rate: delete aggregate mark ceilings. |
| Combined schema-4 storage model | `specs/long-takes-and-retries/assets/probes/results.json:3220`; `specs/long-takes-and-retries/slices/09-change-only-cursor.md:7`; `helpers/mac/Sources/YapCapture/MarkRecognizer.swift:143` | Inference combining the above rates, before additional geometry/resume/click envelopes: one PCM role + typical cursor + continuous strokes = `1,021,920,328 + 109,518,912 + 266,976,000 = 1,398,415,240 B/T`. Two PCM roles + worst cursor + continuous strokes = `2,043,840,656 + 389,750,400 + 266,976,000 = 2,700,567,056 B/T`. Neither is a ceiling on valid files. |

`3,708,000` is a record bound, not a total-file or response bound. Portable evidence
wraps JSON inside a JSON string (`packages/core/src/evidence-pages.ts:38`): escaping
can make a row larger than its normalized line. Give a single row up to
`103 × 60 × S × 4 = 7,416,000 B` (2× record margin, then 2× serialization expansion),
and JSON array framing separately; do not silently omit a large row. Public event
responses return parsed data, not that double-encoded string. A page must close
before its transport budget and still advance by at least one complete record.

## Record, file and receipt bounds

Repeated sites in a row enforce the same bound; every site is cited. Rate names
refer to the arithmetic above. “—” means no justified finite rate, hence deletion
or the stated non-aggregate reason, never an invented margin.

| Bound and `file:line` | What grows / unit | Rate × requirement × margin, or reason | Verdict | Slice |
| --- | --- | --- | --- | --- |
| Journal `1_048_576`: `helpers/mac/Sources/YapCapture/CaptureJournal.swift:93`, `helpers/mac/Sources/YapCapture/CaptureJournal.swift:249`, `helpers/mac/Sources/YapCapture/CaptureJournal.swift:308` | One record / B | Schema 4: `103 × 60 × S × 2 = 3,708,000`. Schemas 1–3: retain writer's strict `< 1,048,576` rule and historical oversized/torn-tail classification as **format interpretation**, not a new duration derivation. | derive (4); not-take-sized (1–3 format) | 07, 08 |
| Stroke decimation: `helpers/mac/Sources/YapCapture/CaptureJournal.swift:210` | Points discarded to fit a line | —; recognizer ends at S, writes every point; no writer thinning in schema 4. | delete | 08 |
| TS line `65536`: `packages/core/src/evidence.ts:380`, `packages/core/src/evidence.ts:421` | Normalized record / B | `103 × 60 × S × 2 = 3,708,000` for schema 4; historical normalized records must admit everything their 1 MiB journal writer could emit. | derive | 07 |
| Portable content `65536`: `packages/core/src/evidence-pages.ts:38` | One record's JSON string | Same record bound, checked in UTF-8 bytes; portable wrapper needs the expansion allowance above. JS character count is not a byte derivation. | derive | 07 |
| Portable page `1_048_576`: `packages/core/src/ordered-pages.ts:10`, `packages/core/src/ordered-pages.ts:122`, `packages/core/src/ordered-pages.ts:124` | One serialized row/page / B | Single-row allowance `2 × JOURNAL_RECORD_BYTES = 7,416,000`, plus array framing. Smaller ordinary pages remain batches; no 256-fold allocation of maximum rows. | derive | 07, 10 |
| Journal `268_435_456`: `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:99` | Complete journal / B | One-role measured PCM alone is 1,021,920,328 B/T; two roles, geometry, strokes and callbacks vary. No finite universal byte rate is established. | delete | 10 |
| Recovery journal `268_435_456`: `helpers/mac/Sources/YapWire/MediaRecovery.swift:260` | Complete journal / B | Same journal growth; stream and retain prefix authority. | delete | 10 |
| Export input `268_435_456`: `helpers/mac/Sources/YapWire/SourceEvidenceExport.swift:71` | Complete journal / B | Same journal growth. | delete | 10 |
| Export output `268_435_456`: `helpers/mac/Sources/YapWire/SourceEvidenceExport.swift:122` | Normalized evidence / B | Change-only cursor can still reach 2,592,000 records/T; mark/callback rates are not universally bounded. | delete | 10 |
| Export scan `268_435_456`: `helpers/mac/Sources/YapWire/SourceEvidenceExport.swift:129` | Complete journal / B | Same journal growth; record bound is independent. | delete | 10 |
| Evidence `268_435_456`: `packages/core/src/evidence.ts:128`, `packages/core/src/evidence.ts:263`, `packages/core/src/evidence.ts:376` | Receipt and normalized file / B | Remove global ceiling; keep exact receipt.bytes and digest checks. | delete | 10 |
| Published journal `268_435_456`: `packages/core/src/capture-publication.ts:30` | Journal identity / B | Same journal growth; identity number must remain exact. | delete | 10 |
| Portable member `268_435_456`: `packages/core/src/acquisitions.ts:110`, `packages/core/src/acquisitions.ts:888` | Source evidence/package members / B | Member sizes come from their own types and pinned identities, not one aggregate constant. | delete | 10 |
| Imported journal `268_435_456`: `packages/core/src/acquisitions.ts:1035` | Source journal / B | Same journal growth. | delete | 10 |
| Imported mapping `268_435_456`: `packages/core/src/acquisitions.ts:1047` | Camera mapping / B | Model already 658,589,339 B/T; actual callback rate not fixed. | delete | 10 |
| Admission copy `268_435_456`: `packages/core/src/source-admission.ts:82` | Journal/mapping/authority members / B | Dispatch validation by member type; copy held exact identities without this ceiling. | delete | 10 |
| Mapping read `268_435_456`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:172` | Observations / B | Model 658,589,339 B/T, actual callback rate variable. | delete | 10 |
| Mapping retention `268_435_456`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:305`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:306`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:309`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:329`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:330` | Frozen mapping identity / B | Same mapping growth; keep copy/digest equality. | delete | 10 |
| Camera journal `268_435_456`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:337` | Camera source journal / B | Same journal growth; not the mapping size model. | delete | 10 |
| Mapping verification `268_435_456`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:507`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:529` | Mapping identity / B | Same mapping growth. | delete | 10 |
| Mapping request `268_435_456`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:766` | Checkpoint prefix / B | Same mapping growth; retain `request.bytes <= actual size` and prefix identity. | delete | 10 |
| Mapping closure `268_435_456`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:1182`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:1202`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:1203` | Closed observations/mapping / B | Same mapping growth. | delete | 10 |
| Closed mapping `268_435_456`: `helpers/mac/Sources/YapCapture/ClosedCameraSource.swift:52` | Observations identity / B | Same mapping growth. | delete | 10 |
| Mapping receipt branch: `packages/core/src/evidence.ts:319` | Mapping file / B | Delete maxBytes branch; keep held-file identity and schema validation. | delete | 10 |
| Mapping line `65536`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:197`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:215` | One fixed callback envelope / B | not-take-sized: fields per callback stay fixed; 510 B measured, no points array; duration grows line count. | not-take-sized | 10 (document classification) |
| Source authority `65536`: `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:214`, `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:386`, `packages/core/src/acquisitions.ts:234`, `packages/core/src/acquisitions.ts:1065` | Authority receipt / B | not-take-sized: fixed journal identity and fixed role-member inventory, no per-sample or per-gap array (`helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:203`). | not-take-sized | 10 |
| Camera receipt `65536`: `helpers/mac/Sources/YapCapture/CameraMedia.swift:536`, `packages/core/src/acquisitions.ts:1047`, `packages/core/src/evidence.ts:319` | Receipt including gaps / B | —; grows with camera on/off intervals; 499-gap rule is also deleted below. Stream/validate the gap inventory instead of replacing with another guessed ceiling. | delete | 10 |
| Audio receipt `65_536`: `helpers/mac/Sources/YapCapture/CaptureAudioPublication.swift:406`, `helpers/mac/Sources/YapCapture/CaptureAudioPublication.swift:409`, `helpers/mac/Sources/YapCapture/CaptureAudioPublication.swift:416`, `helpers/mac/Sources/YapCapture/CaptureAudioPublication.swift:426` | Fixed publication/intent identity / B | not-take-sized: receipts carry hashes/counts/extents, not every PCM run (`helpers/mac/Sources/YapCapture/CaptureAudioPublication.swift:23`). | not-take-sized | 10 |
| Portable metadata `65536`: `packages/core/src/evidence-pages.ts:119` | Source receipt / B | —; includes camera publication receipt/gaps via metadata, so cannot inherit a fixed authority-receipt allowance. | delete | 10 |
| Normalized receipt 32,768 B: `packages/core/src/evidence.ts:273` | Source receipt / B | —; camera publication includes growing gaps; remove this aggregate receipt ceiling together with the camera gap/receipt ceilings. | delete | 10 |
| Export provenance 16,384 B: `helpers/mac/Sources/YapWire/SourceEvidenceExport.swift:174` | Header, last lifecycle and completion / B | not-take-sized: fixed summary fields, not all lifecycle events or camera gaps. | not-take-sized | 10 |

## Counts, presentation and capture queues

| Bound and `file:line` | What grows / unit | Rate × requirement × margin, or reason | Verdict | Slice |
| --- | --- | --- | --- | --- |
| Sparse audio runs 100,000: `helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift:263` | Disjoint accepted runs | Measured nominal `94 × T × 2 = 8,121,600` per role if every callback is disjoint; callback sizes/rates vary (`helpers/mac/Sources/YapCapture/CaptureWriter.swift:490`). No valid universal run rate; stream runs, retaining existing materializer batching. | delete | 10 |
| Acquisition intervals 100,000: `packages/core/src/acquisitions.ts:758`, `packages/core/src/acquisitions.ts:1246` | Available intervals | Same run growth; do not silently merge gaps to fit a count. | delete | 10 |
| Camera observation rows 5,000,000: `helpers/mac/Sources/YapCapture/CaptureClockIngress.swift:41`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:197` | Callback rows, including rejected frames | Model `30 × T × 2 = 2,592,000` is not an actual maximum callback rate; paused elapsed time is unbounded. | delete | 10 |
| Camera represented frames 5,000,000: `helpers/mac/Sources/YapCapture/CameraMedia.swift:439` | Accepted pictures | `30 × T × 2 = 2,592,000` is only the model. Device-selected fps can differ; preserve positive/exact count and timescale validation. | delete | 10 |
| Camera gaps 499: `helpers/mac/Sources/YapCapture/CameraMedia.swift:55`, `packages/core/src/evidence.ts:45` | Off intervals | —; no user transition-rate requirement, and recorded time does not bound toggles during pause. | delete | 10 |
| Camera turn-ons 500: `helpers/mac/Sources/YapCapture/CameraCaptureInput.swift:211` | Device openings | —; mirror of gaps, remove both together; retain serialized session ownership. | delete | 10 |
| Portable pages 8,192: `packages/core/src/ordered-pages.ts:12`, `packages/core/src/ordered-pages.ts:103`, `packages/core/src/ordered-pages.ts:167` | All index pages | Cursor alone occupies two indexes (`packages/core/src/evidence-pages.ts:41`): `2 × 60 × T / 256 = 20,250` full pages before other evidence; even typical is ~5,266 before boundary/large-row pages. Other event rates are unbounded; iterate descriptors. | delete | 10 |
| Portable manifest 4,194,304 B: `packages/core/src/ordered-pages.ts:11`, `packages/core/src/ordered-pages.ts:134` | Page descriptors | —; grows with page count; no finite total rate after page cap deletion. Read/write descriptor inventory incrementally. | delete | 10 |
| Page rows 256: `packages/core/src/ordered-pages.ts:32`, `packages/core/src/ordered-pages.ts:42`, `packages/core/src/ordered-pages.ts:124` | Rows in a batch | not-take-sized: flushes another page; never a cap on total rows. | not-take-sized | 10 |
| Ordered read 5,001: `packages/core/src/ordered-pages.ts:220` | Requested rows + lookahead | not-take-sized: continuation pages expose the remainder. | not-take-sized | 10 |
| Source cursor page 5,000: `packages/core/src/evidence-read.ts:127` | Returned samples/page | not-take-sized: page cursor continues; a held sample at range start must not consume progress. | not-take-sized | 09 |
| Source export batches 256: `packages/core/src/evidence-read.ts:58`, `packages/core/src/evidence-read.ts:75`, `packages/core/src/evidence-read.ts:98` | Export read batch | not-take-sized: repeated production reads exhaust the index. | not-take-sized | 10 |
| Boundary arrays 1,000: `packages/core/src/evidence-read.ts:214`, `packages/core/src/evidence-read.ts:239` | Unplaced geometry / pause / geometry boundaries | —; methods refuse the whole selected range instead of returning a continuation. Frame-driven geometry can change ~30/s, so 1,000 is only ~33 s; pause events have no finite rate. Iterate existing index pages. | delete | 10 |
| Audio interval array 1,000: `packages/core/src/evidence-read.ts:268` | Disjoint audio support | —; at the probe's 94 callbacks/s, 1,000 disjoint callbacks is ~10.64 s; not a 12-hour contract. | delete | 10 |
| Raw cursor window 60,000,000 us: `packages/core/src/capture-source-read.ts` | Selected time range | Use `1 recorded s/s × T × 1 = 43,200 s` maximum selection (or caller's shorter range); results still page. Hold the sample in force at start. | derive | 09, 10 |
| Source event/cursor page counts 1,000/5,000: `packages/core/src/capture-source-read.ts:419` | Page rows | not-take-sized: continuation returns the rest; defaults 100/1,000 are batch choices. | not-take-sized | 10 |
| Source response: `packages/core/src/capture-source-read.ts` | One response | Derive `2 × JOURNAL_RECORD_BYTES` (7,416,000 B), beneath the eight-MiB transport bound. Close ordinary pages at one record budget with a continuation; retain room for clocks, context and JSON escaping. | derive | 07, 10, review 14 |
| Project evidence checkpoint 8 MiB: `packages/core/src/project-evidence.ts:80`, `packages/core/src/project-evidence.ts:578`, `packages/core/src/project-evidence.ts:595` | Full manifest/support checkpoint / B | —; availability fragments can grow with take support; this is not the paginated response. Stream the growing inventory through the existing checkpoint owner. | delete | 10 |
| Project evidence response: `packages/core/src/project-evidence.ts` | One response | Uses the shared source response bound (`2 × JOURNAL_RECORD_BYTES`); project pages close at one record budget with continuation. | derive | 10, review 14 |
| Presentation records 1,000,000: `packages/core/src/presentation-evidence.ts:29`, `helpers/mac/Sources/YapFrames/PresentationEvidence.swift:49` | Selected picture intervals | Nominal 30/s reaches 1,296,000/T, 60/s reaches 2,592,000/T; source fps, span cuts and replay change rate. No single universal rate; stream selected intervals. | delete | 10 |
| Decoded samples 1,000,000: `packages/core/src/presentation-evidence.ts:30`, `helpers/mac/Sources/YapFrames/PresentationEvidence.swift:50` | Decode scan per selection | —; growth follows actual media and decoder traversal, not nominal fps alone. Keep decoder no-progress detection. | delete | 10 |
| Presentation total 1 GiB: `packages/core/src/presentation-evidence.ts:28` | JSONL with thumbnails | Inference from RGB shape: `30 × T × (64 × 64 × 3 × 4/3) = 21,233,664,000 B` of base64 alone at square frames; 2× = 42,467,328,000 B, excluding envelope. Stream rather than invent one global cap. | delete | 10 |
| Presentation history 10,000: `packages/core/src/presentation-evidence.ts:35`, `packages/core/src/presentation-evidence.ts:64` | Kept spans / header spanCount | —; cuts are caller-authored, not duration-rate constrained. | delete | 10 |
| Presentation record 65,536 B: `packages/core/src/presentation-evidence.ts:21`, `helpers/mac/Sources/YapFrames/PresentationEvidence.swift:107` | One fixed thumbnail envelope | not-take-sized: max 64² RGB becomes 16,384 base64 bytes (`packages/core/src/presentation-evidence.ts:49`); more pictures produce more records. | not-take-sized | 10 |
| Prepared pointer rows 1,000,000: `packages/core/src/composition-pointer.ts:29`, `helpers/mac/Sources/YapFrames/PreparedPointers.swift:49` | Sampled layer observations | —; 30 fps alone exceeds 1m at T, layering/replay further multiply. | delete | 10 |
| Prepared pointer events 1,000,000: `packages/core/src/composition-pointer.ts:30`, `packages/core/src/presentation-pointer-history.ts:46` | Input evidence/reset events | —; worst cursor alone is 2,592,000/T, plus geometry/pause/scene events. | delete | 10 |
| Prepared pointer bytes 128 MiB: `packages/core/src/composition-pointer.ts:28`, `helpers/mac/Sources/YapFrames/PreparedPointers.swift:55` | Prepared stream / B | —; frame/layer rate not fixed, use streamed receipt equality. | delete | 10 |
| Pointer history bytes 1 GiB: `packages/core/src/composition-pointer.ts:32`, `packages/core/src/pointer-preparation.ts:128` | Input histories / B | —; presentation base64 alone can be 21.23 GB/T; stream/reuse held source histories. | delete | 10 |
| Prepared frames 1,000,000: `packages/core/src/composition-pointer.ts:33` | Output frames | —; 30 × T = 1,296,000 before higher requested output fps. | delete | 10 |
| Prepared operations 10,000,000: `packages/core/src/composition-pointer.ts:34` | Frame/layer operations | —; layers and replay are explicit authored input, no duration-to-layer-rate requirement. | delete | 10 |
| Pointer admission work 100,000: `packages/core/src/composition-pointer.ts:35` | Frame/layer admission visits | —; at one visit/frame and 30 fps this admits only ~55.6 min. Share compiler traversal, cancel/yield while advancing. | delete | 10 |
| Pointer sources 256: `packages/core/src/composition-pointer.ts:31` | Distinct authored source selections | not-take-sized: adding duration to one take does not add distinct source identities. | not-take-sized | 10 |
| Pointer row 256 KiB: `packages/core/src/composition-pointer.ts:36`, `helpers/mac/Sources/YapFrames/PreparedPointers.swift:55` | One prepared frame/layer observation | not-take-sized: fixed per-layer pointer state and bounded-time trail; frame count grows separately. | not-take-sized | 10 |
| Pointer schedule line 65,536: `packages/core/src/pointer-schedule.ts:52` | One state/header / B | not-take-sized: fixed pointer state per line; no whole-take history inside it. | not-take-sized | 10 |
| Pointer schedule total: `packages/core/src/pointer-schedule.ts:52` | Scheduled bytes and event budget | —; caller budget derives from the deleted aggregate pointer/presentation ceilings; remove those aggregate ceilings in producer and consumer together. | delete | 10 |
| Trail duration 10,000,000 us: `packages/composition/src/pointer.ts:5`, `helpers/mac/Sources/YapFrames/FrameTypes.swift:50` | One displayed trail | not-take-sized: caller's look-back rendering parameter, independent of take age; a held point is clipped to that interval. | not-take-sized | 09 |
| Trail points 1,200: `packages/core/src/trails.ts:41`, `helpers/mac/Sources/YapFrames/FrameTypes.swift:53` | Points visible in trail | —; replace sample-count semantics by elapsed trail time and streaming iteration; change-only samples must hold. Do not make dense versus sparse storage change output. | delete | 09 |
| Trail observations 5,000: `packages/core/src/trails.ts:42` | Events consumed to find displayed trail | —; geometry/reset events aren't pointer ticks and have no 60 Hz maximum; batch reads while advancing through time. | delete | 09 |
| Cursor batch 30: `helpers/mac/Sources/YapCapture/CursorGeometry.swift:213`, `helpers/mac/Sources/YapCapture/CursorGeometry.swift:288` | Readings awaited for flush | —; replace with **500 ms take-time cadence**, plus seal; changing samples are not a clock. | delete | 09 |
| Cursor pending 240: `helpers/mac/Sources/YapCapture/CursorGeometry.swift:380` | Outstanding deliveries | not-take-sized: instantaneous queue/backpressure, `240 / 60 = 4 s` of readings; observed drops stay explicit, not a total take cap. | not-take-sized | 09 |
| Placement retention 240: `helpers/mac/Sources/YapCapture/CursorGeometry.swift:213`, `helpers/mac/Sources/YapCapture/CursorGeometry.swift:337` | Placements awaiting sampling watermark | not-take-sized: live working-set eviction, not stored geometry total; retained matching epochs and forgotten-placement statistics remain authoritative. | not-take-sized | 09 |
| Sampling 16,667 us: `helpers/mac/Sources/YapCapture/CursorGeometry.swift:380` | Poll cadence | not-take-sized: approximately 60 Hz reads; schema 4 still feeds every read to marks. | not-take-sized | 09 |

## Packages and other evidence reached by take growth

An 8 GiB member admits one 12-hour 48 kHz mono float32 track
(`48,000 × 4 × T = 8,294,400,000 B`), but stereo is
`16,588,800,000 B`, above it. Two stereo roles total 33,177,600,000 B before video,
above the 16 GiB archive. These are **inferences** from the production PCM encoding
(`helpers/mac/Sources/YapCapture/CaptureWriter.swift:499`), not measured media.

| Bound and `file:line` | What grows / unit | Rate × requirement × margin, or reason | Verdict | Slice |
| --- | --- | --- | --- | --- |
| Compressed archive 16 GiB: `packages/core/src/package-archive.ts:7`, `apps/service/src/archive-input.ts:26` | Archive file / B | —; no measured or enforced compressed bitrate; content-dependent compression cannot derive this cap. | delete | 10 |
| Expanded archive 16 GiB: `packages/core/src/package-archive.ts:8` | Extracted members / B | —; two stereo PCM roles alone 33.18 GB/T, plus video/derived evidence/copies. | delete | 10 |
| Archive member 8 GiB: `packages/core/src/package-archive.ts:9` | One media/evidence member / B | —; stereo PCM 16.59 GB/T; encoded video rate unspecified. | delete | 10 |
| Archive entries 25,000: `packages/core/src/package-archive.ts:10`, `packages/core/src/project-package.ts:403`, `packages/core/src/project-package.ts:404`, `packages/core/src/project-package.ts:421`, `apps/service/src/project-packages.ts:1370` | Inventory members | —; dual cursor indexes need 20,250 ordinary pages before other resources; actual page/event/resource growth varies. Stream inventory. | delete | 10 |
| Manifest 2 MiB: `packages/core/src/package-archive.ts:14` | Member descriptors / B | —; grows with entries; fixed aggregate JSON read is a working-set choice, not valid format capacity. | delete | 10 |
| Archive receipt 7 MiB: `packages/core/src/package-archive.ts:18`, `helpers/mac/Sources/YapWire/ArchiveOperation.swift:25` | Inventory plus manifest / B | —; embeds growing inventory, not a fixed-size receipt; stream through the archive owner, retaining observed byte accounting. | delete | 10 |
| Project JSON working set 128 MiB: `packages/core/src/package-archive.ts:21` | Aggregate eager validation JSON / B | —; take evidence grows; validate independent typed resources incrementally, not all at once. | delete | 10 |
| Registry retained bytes 64 GiB: `apps/service/src/package-registry.ts:31` | Open-package expanded bytes | —; even one take can exceed it at supported PCM formats; do not hide a take behind library-wide byte accounting. Keep explicit close/cleanup ownership. | delete | 10 |
| Revision 1 MiB: `packages/core/src/package-archive.ts:15` | Authored document | not-take-sized: a longer source range does not create more document nodes; this is authored project complexity. | not-take-sized | 10 |
| Revision history 1,000: `packages/core/src/package-archive.ts:16` | Explicit edit revisions | not-take-sized: recording duration does not generate edits. | not-take-sized | 10 |
| Path 512 B: `packages/core/src/package-archive.ts:11` | One member name | not-take-sized: deterministic naming depth does not grow with source duration. | not-take-sized | 10 |
| Component 128 B: `packages/core/src/package-archive.ts:12` | One path component | not-take-sized: identifier representation, not media size. | not-take-sized | 10 |
| Path depth 16: `packages/core/src/package-archive.ts:13` | Directory depth | not-take-sized: page count adds siblings, not deeper paths. | not-take-sized | 10 |
| Initial archive read 8 MiB: `packages/core/src/package-archive.ts:17` | Native parser working set | not-take-sized if parser streams the inventory; must not become a second manifest/total-input cap when deleting the above ceilings. | not-take-sized | 10 |
| Registry owners 4: `apps/service/src/package-registry.ts:32` | Concurrent open handles | not-take-sized: one take's duration does not increase concurrent owners. | not-take-sized | 10 |
| Registry terminal 32: `apps/service/src/package-registry.ts:33` | Retained terminal statuses | not-take-sized: number of operations, not bytes or duration of one take. | not-take-sized | 10 |
| Transcript `268_435_456`: `packages/core/src/transcript.ts:351`, `packages/core/src/transcript.ts:175`, `helpers/mac/Sources/YapSpeech/SourceTranscript.swift:293` | Speech evidence / B | —; probe measured no speech output rate; code allows provider-produced text/events, not a finite bytes/s guarantee. | delete | 10 |
| Transcript line 67,108,864 B: `packages/core/src/transcript.ts:352` | Provider evidence arrays in one line | —; provider windows/metadata may grow; stream records instead of a giant growing record. No speech rate measured. | delete | 10 |
| Transcript availability/segments 10,000: `packages/core/src/transcript.ts:165`, `packages/core/src/transcript.ts:170`, `packages/core/src/transcript.ts:380`, `packages/core/src/transcript.ts:383` | Audio support segments | —; follows disjoint capture audio intervals, not a fixed speech cadence. | delete | 10 |
| Imported transcript raw bytes 256 MiB: `packages/core/src/project-package.ts:155` | Supplied transcript source / B | —; supplied text/cue rate is not constrained by the take requirement; keep original bytes and stream parsing. | delete | 10 |
| Packaged transcript receipt 8 MiB: `packages/core/src/project-package.ts:135` | Whole transcript receipt / B | —; contains availability/provider metadata that can grow with source support; stream through the transcript owner. | delete | 10 |
| Packaged scene chunk 8 MiB: `packages/core/src/project-package.ts:111` | One bounded scene chunk / B | not-take-sized: chunking continues through the scene owner; never a whole-take total. | not-take-sized | 10 |
| Packaged support intervals 100,000: `packages/core/src/project-package.ts:129` | Transcript availability intervals | —; same disjoint audio support growth as acquisition intervals. | delete | 10 |
| Imported transcript cues 100,000: `packages/core/src/project-package.ts:164` | Supplied timed cues | —; no caller cue-rate requirement; validate/stream every cue without editorial regrouping. | delete | 10 |
| Packaged index records 25,000: `packages/core/src/project-package.ts:66` | Retained index chunks | —; one sampled candidate/s already reaches 43,200 at T before grouping; actual policy and record sizes determine chunk count. | delete | 10 |
| Packaged index images 25,000: `packages/core/src/project-package.ts:77` | Candidate raster members | —; candidate count grows with take duration/policy; no universal candidate rate measured. | delete | 10 |
| Packaged scene chunks 25,000: `packages/core/src/project-package.ts:116` | Scene chunk inventory | —; scene/event density and chunk byte size vary, not a fixed count/T. | delete | 10 |
| Packaged alignment operands 8 MiB: `packages/core/src/alignment-operands.ts:50`, `packages/core/src/project-package.ts:86`, `packages/core/src/project-package.ts:87`, `packages/core/src/project-package.ts:88` | Native alignment receipt/report/correspondence | not-take-sized: this primitive explicitly selects at most 400,000 / 16,000 = 25 s of PCM (`packages/core/src/alignment-operands.ts:31`), not a whole-source transcript. | not-take-sized | 10 |
| Packaged speaker operands 1 MiB: `packages/core/src/project-package.ts:96`, `packages/core/src/project-package.ts:97`, `packages/core/src/speaker-evidence.ts:102`, `packages/core/src/speaker-evidence.ts:373`, `packages/core/src/speaker-evidence.ts:374` | Native speaker excerpt observations | not-take-sized: explicitly selected 480,000 / 16,000 = 30 s PCM excerpt (`packages/core/src/speaker-evidence.ts:38`); take growth does not expand that operand. | not-take-sized | 10 |
| Packaged transcript chunk 8 MiB: `apps/service/src/project-packages.ts:1486` | Words/gaps in one chunk | not-take-sized only with byte-driven chunk closure and continuation; row-count batching alone can overflow. | not-take-sized | 10 |
| Packaged origin metadata 8 MiB: `apps/service/src/project-packages.ts:1518` | Whole-source provenance JSON | —; can contain growing source evidence; no rate from the two requirements. | delete | 10 |
| Portable scene chunk 65,536 B: `packages/core/src/scene-evidence.ts:273`, `packages/core/src/source-scene-chunks.ts:171` | One scene chunk | not-take-sized only when the producer closes chunks by bytes and continues; total scene count remains pageable. | not-take-sized | 10 |
| Packaged scene chunk 262,144 B: `apps/service/src/project-packages.ts:1430` | One chunk | not-take-sized under the same producer chunk rule. | not-take-sized | 10 |
| Packaged/retained frame 32 MiB: `packages/core/src/project-package.ts:73`, `apps/service/src/project-packages.ts:1453`, `helpers/mac/Sources/YapFrames/FrameTypes.swift:48` | One raster asset | not-take-sized: duration adds frames, not pixels to one frame. | not-take-sized | 10 |
| Frame edge 8,192: `helpers/mac/Sources/YapFrames/FrameTypes.swift:47` | One raster dimension | not-take-sized: duration does not change image dimensions. | not-take-sized | 10 |
| Acoustic provenance 1,048,576 B: `helpers/mac/Sources/YapFrames/AcousticImage.swift:55` | Labels for one acoustic image | not-take-sized: a caller-supplied label collection, not the source sample history. | not-take-sized | 10 |
| Compiled frame line 65,536 B: `helpers/mac/Sources/YapWire/CompositionVideoOperation.swift:39`, `helpers/mac/Sources/YapWire/CompositionVideoOperation.swift:48` | One authored frame's layer description | not-take-sized: fixed composition per frame; total frame records stream independently. | not-take-sized | 10 |
| Project occurrence window 10,000: `packages/core/src/project-evidence.ts:290` | Selected authored occurrences | not-take-sized: source duration does not create project placements. | not-take-sized | 10 |
| Project cuts 20,000: `packages/core/src/project-evidence.ts:292` | Authored cuts in selection | not-take-sized: cuts are explicit editing complexity, not capture events. | not-take-sized | 10 |
| Project sources 1,024: `packages/core/src/project-evidence.ts:303` | Distinct selected sources | not-take-sized: one longer take still names the same sources. | not-take-sized | 10 |

## Time budgets and decisions

The 12-hour combined stream takes **51.863325166 s**, peak RSS **17.84 MiB**;
PCM alone takes 39.489 s (`specs/long-takes-and-retries/assets/probes/README.md:89`,
`specs/long-takes-and-retries/assets/probes/results.json:2917`). The stream rate is
`51.863325166 / T = 0.001200540 s work / recorded s`. This is a single machine/run,
not a latency promise. Publication failed at its byte ceiling before full media
work, so it is not an end-to-end stop measurement.

| Bound and `file:line` | What grows / unit | Rate × requirement × margin, or reason | Verdict | Slice |
| --- | --- | --- | --- | --- |
| Maximum take duration: `packages/protocol/src/requirements.json:1`, `helpers/mac/Sources/YapCapture/CaptureWriter.swift:753` | Recorded source time / s | `1 s/s × T × 1 = 43,200 s`; ordinary clean finish, excluding pause elapsed time. | derive | 10 |
| Maximum stroke duration: `packages/protocol/src/requirements.json:1`, `helpers/mac/Sources/YapCapture/MarkRecognizer.swift:143` | Held stroke source time / s | `1 s/s × S × 1 = 300 s`; commit and begin next stroke, retaining boundary continuity. | derive | 08 |
| Stop journal scan allowance: `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:339` | Summary/hash/snapshot/verification work / s | Inference: ~6 full-pass equivalents × measured `0.001200540 × T × 2 = 622.360 s` for the measured 1,392,503,313 B journal. **Scale by actual journal bytes**: with `rJ = actual journal B / T`, use `6 × (51.863325166 / 1,392,503,313) × rJ × T × 2`. The two-role/worst-cursor/continuous-stroke schema-4 model above projects to **1,206.981 s** at 2× before media work. Count actual passes in slice 10; don't weaken byte/prefix verification to meet timing. | derive | 10 |
| Recovery fixed 1,200,000 ms: `apps/service/src/capture.ts:732`, `apps/service/src/capture-cleanup.ts:101` | Canonical/fragmented-media work | —; delete fixed addend. Budget journal work above plus actual selected media work. No successful long media materialization was measured in 00. Use duration allowance below until measured. | delete | 10 |
| Publication 30,000 ms + 4 MiB/s: `apps/service/src/publication.ts:439` | Byte passes over payload/victim | Fixed startup addend has no requirement derivation: delete. Inference, code's throughput assumption: charge actual bytes `(3B + 2R) / 4,194,304 B/s × 2`; when using full-take rates `rB=B/T`, `rR=R/T`, this is `(3rB + 2rR) × T / 4,194,304 × 2`. Measured 1.3925 GB journal alone gives 1,991.992 s at this conservative rate. Keep actual-input sizing; never use 256 MiB to predict it. | derive byte work; delete fixed addend | 10 |
| Source export fixed 600,000 ms: `apps/service/src/source-export.ts:60` | Canonical verification + export | —; delete fixed allowance, share measured journal work and selected-media allowance; not another independent deadline owner. | delete | 10 |
| Media execution time allowance: `apps/service/src/worker.ts:33` | Selected render/materialization duration / ms | Inference: 1 s work / selected source s, 2× margin: `1 × T × 2 = 86,400 s` per full-take media traversal; scale actual selected duration and count sequential traversals/roles, then add separately charged journal/byte work. This is a fallback budget, not measured throughput. The process owner adds named fixed per-call `PROCESS_START_ALLOWANCE_MS` (30 s), for numeric and observed deadlines alike; this cost is independent of selected duration. | derive | 10 |
| Transcription time: `apps/service/src/worker.ts:46` | Selected narration / ms | Inference: same real-time assumption, `1 × T × 2 = 86,400 s` for full take; pauses excluded via available support. The process owner separately adds named fixed per-call `SPEECH_MODEL_LOAD_ALLOWANCE_MS` (600 s) for `speech.transcribe`, plus process start (30 s). Model loading/verification happens in each speech child even when preparation has finished; neither cost scales with take length. | derive | 10 |
| Archive open fixed 30 min: `apps/service/src/package-archive.ts:70` | Hash/copy/parse archive / ms | —; delete fixed deadline, use actual observed archive and extracted byte work at the explicitly inferred publication throughput/margin. Video bytes have no duration-only rate. | delete | 10 |
| Archive cleanup fixed 30 s: `apps/service/src/package-archive.ts:84` | Removing extracted take members | —; directory size/member count grow; use observed inventory work and cancellation, not 30 s for every take. No unlink throughput measured. | delete | 10 |
| Camera private backpressure 30 s: `helpers/mac/Sources/YapCapture/CameraMedia.swift:842`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:897` | Optimistic checkpoint attempt | not-take-sized: expiration selects full-scan fallback, not refusal of the take; fallback gets the duration/byte budget. | not-take-sized | 10 |
| Worker maximum 2,147,483,647 ms: `apps/service/src/worker.ts:26` | Timer representation | not-take-sized: ~24.86-day timer API ceiling; chunk/rearm a longer derived deadline, never clamp valid work into a shorter timeout. | not-take-sized | 10 |
| Default native 30,000 ms: `packages/protocol/src/framing.ts:9` | Otherwise unspecified worker call | not-take-sized for fixed operations only; take-sized callers must supply the derived work budget. | not-take-sized | 10 |
| Default control call 10,000 ms: `packages/protocol/src/framing.ts:7` | Control acknowledgement | not-take-sized: fixed IPC round trip, not journal processing or take completion. | not-take-sized | 10 |
| Free-disk admission: `helpers/mac/Sources/YapCapture/CaptureWriter.swift:145`, `helpers/mac/Sources/YapCapture/CaptureWriter.swift:499` | Prospective capture + finalization storage / B | **No new full-take free-disk check.** Video bitrate is neither measured nor bounded in these writer settings; no correct finite reserve follows from T. See numbers below. | delete proposed fixed reserve | 10 |
| PCM append reduction: `helpers/mac/Sources/YapCapture/CaptureJournal.swift:165`, `specs/long-takes-and-retries/assets/probes/README.md:91` | Bookkeeping volume / B | **Do not shrink.** One role: `(1,021,920,328/T) × T × 2 = 2,043,840,656 B`; two roles at same rate: 4,087,681,312 B with 2×. Streaming PCM RSS 12.64 MiB, time 39.489 s at T; no derived working-memory/file budget requires removing evidence. | not-take-sized decision: retain primitive | 10 |

**Free disk:** the probe excludes media. At its 48 kHz mono format, one float32 track
needs 8.2944 GB/T; four channels across two stereo roles need 33.1776 GB/T. At the
materializer's admitted 192 kHz × 8 channels (`helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift:300`),
one role can need `192,000 × 8 × 4 × T × 2 = 530,841,600,000 B` with 2× margin,
still excluding video, container overhead and temporary copies. A journal-only
~2–4 GB reserve would be false assurance; demanding ~531 GB before a short recording
would add a new restriction. Do not invent either. Normal write failures must
preserve recorded source bytes and report their cause; the source/publication
owners retain that responsibility. A future disk-pressure feature needs measured
selected-media growth and a stated remaining-work reserve, not a new take-length rule.

**Stop passes:** slice 10 is **not required to fold them into one**. The code's
freeze, summary, identity and verification stages (`helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:351`,
`helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:377`) protect different
authority boundaries. Six streaming passes project to `6 × 51.863325166 = 311.180 s`
and receive 622.360 s at 2× for the measured schema-3 input. The schema-4 combined
model with two PCM roles, worst cursor and continuous unthinned strokes is
2,700,567,056 B before additional geometry/boundary envelopes: scaling the measured
per-byte cost gives **603.490 s** for six passes and **1,206.981 s** at 2×. These
are inferences; actual bytes and record mix own the final measurement and deadline,
not a fixed 622-second ceiling. Memory does not scale with take length in the probe.
For comparison, the current recovery allowance with the measured 12-hour journal is
`1,200 + 30 + 3 × 1,392,503,313 / 4,194,304 = 2,225.996 s`, comfortably larger.
There is no stated stop-latency requirement that forces a new combined-pass API.
This comparison does not validate the old fixed addends. Slice 10 must measure a
successful complete path (including `packages/core/src/acquisitions.ts:1035`), which
00 could not reach; reduce passes if that proof exceeds the derived work budget.

## Chunks, shapes and scheduling are not take limits

| Bound and `file:line` | Classification and one-line reason | Slice |
| --- | --- | --- |
| 16,384 B journal read: `helpers/mac/Sources/YapCapture/CaptureJournal.swift:286` | not-take-sized: reusable read chunk; line scanner spans chunks and uses the separate record bound. | 07 |
| 16,384 B compiled-frame read: `helpers/mac/Sources/YapWire/CompositionVideoOperation.swift:51` | not-take-sized: reusable chunk capped by the per-frame record remainder. | 10 |
| 65,536 B identity reads: `helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift:34`, `helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift:381` | not-take-sized: hash chunks, repeated until exact byte identity is consumed. | 10 |
| 65,536 B source copies: `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:191`, `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift:327` | not-take-sized: copy chunk, not a snapshot-size ceiling. | 10 |
| 65,536 B mapping reads: `helpers/mac/Sources/YapCapture/CameraMedia.swift:181`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:222`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:323`, `helpers/mac/Sources/YapCapture/CameraMedia.swift:868` | not-take-sized: chunked prefix copy/hash; distinguish these from the mapping line and total guards above. | 10 |
| 65,536 B normalized reads: `packages/core/src/evidence.ts:374`, `packages/core/src/transcript.ts:1100` | not-take-sized: stream highWaterMark; does not constrain a line or total. | 07, 10 |
| 65,536 B archive reads: `helpers/mac/Sources/YapWire/ArchiveOperation.swift:13`, `apps/service/src/project-package-metadata.ts:37` | not-take-sized: incremental copy/hash buffer. | 10 |
| 65,536 B publication reads: `helpers/mac/Sources/YapWire/PublicationOperation.swift:62`, `helpers/mac/Sources/YapWire/PublicationOperation.swift:67` | not-take-sized: repeated pread buffer. | 10 |
| 65,536 B file reads: `packages/core/src/files.ts:237`, `packages/core/src/files.ts:260` | not-take-sized: copy/hash buffer, independent of source length. | 10 |
| 65,536 B wire-request reads: `helpers/mac/Sources/YapWire/WireRequest.swift:51` | not-take-sized: chunk inside a separately bounded request, not media ingestion. | 10 |
| Materializer 1,024-run batches: `helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift:468` | not-take-sized: repeated composition batches, not maximum run count. | 10 |
| Yield every 128/256 operations: `packages/core/src/composition-pointer.ts:171`, `packages/core/src/composition-pointer.ts:175` | not-take-sized: scheduling cadence; work continues and checks cancellation. | 10 |
| Still-picture repeat 100,000 us: `helpers/mac/Sources/YapCapture/CaptureWriter.swift:105` | not-take-sized: media flushing cadence for a still screen, not take duration. | 10 |
| Request 1 MiB: `packages/protocol/src/framing.ts:1` | not-take-sized: operation descriptor; full take media/evidence is not embedded in requests. | 10 |
| Response 8 MiB: `packages/protocol/src/framing.ts:2` | not-take-sized: one envelope; all evidence adapters need byte-aware continuation, including a complete schema-4 stroke. | 07, 10 |
| Control 64 KiB: `packages/protocol/src/framing.ts:3` | not-take-sized: one status/control message, not take content. | 10 |
| Native request 64 MiB: `helpers/mac/Sources/YapWire/WireRequest.swift:41`, `apps/service/src/composition-worker.ts:20` | not-take-sized: fixed call operands; growing streams go through held files, not inline requests. | 10 |
| IDs 128/256, errors 128/4,096: `helpers/mac/Sources/YapCapture/CaptureJournal.swift:771`, `packages/protocol/src/capture.ts:105`, `packages/protocol/src/capture.ts:108`, `packages/core/src/acquisitions.ts:116` | not-take-sized: bounded identifier/diagnostic fields, independent of take duration. | 10 |
| Mark window title 4,096 B: `helpers/mac/Sources/YapCapture/CaptureJournal.swift:783` | not-take-sized: one captured window title, not an accumulating history; included in the stroke record margin. | 07, 08 |
| Publication prepared receipt 4,096 B: `helpers/mac/Sources/YapWire/PublicationOperation.swift:90` | not-take-sized: fixed destination identity/digest receipt. | 10 |
| Acquisition bindings 256: `packages/core/src/acquisitions.ts:134` | not-take-sized: number of selected streams/assets, not intervals or samples in each stream. | 10 |
| Source roles 3: `packages/core/src/acquisitions.ts:127` | not-take-sized: fixed video/narration/system vocabulary, not take event count. | 10 |
| Alignment excerpt rows 1,024/2,500/313/512: `packages/core/src/alignment-evidence.ts:38`, `packages/core/src/alignment-evidence.ts:39`, `packages/core/src/alignment-evidence.ts:40`, `packages/core/src/alignment-evidence.ts:44` | not-take-sized: bounded explicit 25 s observation primitive; no whole-take loop ends at these counts. | 10 |
| Speaker excerpt rows 1,500/375: `packages/core/src/speaker-evidence.ts:87`, `packages/core/src/speaker-evidence.ts:88` | not-take-sized: one explicit 30 s observation primitive, not automatic whole-take speaker evidence. | 10 |
| Evidence ingest batches 256: `packages/core/src/evidence.ts:520`, `packages/core/src/transcript.ts:1087`, `packages/core/src/transcript.ts:1089` | not-take-sized: repeated transactions, not aggregate source counts. | 10 |
| Transcript read pages 1,000: `packages/core/src/transcript-read.ts:254`, `packages/core/src/transcript-read.ts:309` | not-take-sized: public continuation pages retain access to all words and gaps. | 10 |
| Raster columns/unavailable regions 4,096: `helpers/mac/Sources/YapFrames/AcousticImage.swift:56` | not-take-sized: finite output image resolution; more duration changes each column's interval, not image width. | 10 |
| Thumbnail base64 16,384 B: `packages/core/src/presentation-evidence.ts:51` | not-take-sized: one 64 × 64 RGB thumbnail's encoded shape. | 10 |
| Packaged index record 262,144 B: `packages/core/src/project-package.ts:65` | not-take-sized: one chunk, with total index chunks accounted for above. | 10 |
| Presentation time scale 2,147,483,647: `packages/core/src/presentation-time.ts:21` | not-take-sized: rational clock denominator representation, not source duration. | 10 |
| Exact time/byte integers 9,007,199,254,740,991: `helpers/mac/Sources/YapMedia/TimeSpan.swift:15`, `helpers/mac/Sources/YapWire/PublicationOperation.swift:133` | not-take-sized: lossless cross-language number representation, orders of magnitude above T in microseconds. | 10 |
| Native lifecycle sequence: `packages/protocol/src/capture.ts:102` | delete: lifecycle transitions accumulate without a rate bound; retain exact nonnegative monotonic integer validation, not a reserved-range cap. | 10 |
| Audio rates/channels: `helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift:300`, `helpers/mac/Sources/YapCapture/CaptureClock.swift:102` | not-take-sized: supported sample format and container integer representation, not sample totals; media storage calculations use the selected format. | 10 |
| Transcript word 1,024 characters: `packages/core/src/transcript.ts:393` | not-take-sized: one provider token, not all take words. | 10 |
| Transcript context ±4,000,000 us: `packages/core/src/transcript.ts:40` | not-take-sized: local decode context per request; source support continues separately. | 10 |
| Jobs input 65,536 characters: `packages/core/src/jobs.ts:113` | not-take-sized only for pinned descriptors: callers must not inline growing support/word/sample lists into a job input. | 10 |
| Scene result 65,536 characters: `packages/core/src/scene-processing.ts:32` | not-take-sized: job result locator/receipt, not the scene stream. | 10 |

## Coverage and verification boundary

The sweep covered numeric literals and comparisons in native capture, normalized
evidence/export/admission, source publication/recovery, archive/package transport,
and pointer/presentation producers and consumers. The explicit 256 MiB, 1 MiB and
64 KiB sites are accounted for above, including aliases and read chunks; rate
models do not override unknown device or authored-input rates. Unmeasured media
execution, camera verification and schema-4 serialization remain slice 10's
production-path proof, as required by `specs/long-takes-and-retries/slices/10-derived-limits.md:27`.

No behavior tests or scale fixtures were added or run for this data-only slice.
Verification is source-occurrence coverage, citation existence and arithmetic;
00's retained results are reused. No user recordings, user library or installed
runtime were accessed, and no editor/app or H1 checkpoint was opened.

## Whole-diff review corrections

| Limit | Quantity | Verdict and reason | Finding |
| --- | --- | --- | --- |
| `SpeechWindows.maximumWindows` 10,000 and transcript portable receipt `LIMIT 10001` | Physical speech runs / windows | **delete together**: even short takes can contain arbitrarily many disjoint runs. The metadata segment-count equality remains an integrity check; it imposes no ceiling. | 7 |
| Stroke-byte planning rate | Bytes per recorded stroke second | `STROKE_BYTES_PER_SECOND` is owned by protocol requirements JSON (60 points/s × 103 B); Swift mirrors that named rate and checks it against the JSON. Record margin is applied once, and portable rows use twice that record bound. | 14 |
| Held cursor sampling | Format capability | Only schema 4 holds. Portable page metadata must agree with the receipt when admitted together; older schema flags cannot enable holds. | 14 |
| Maximum-take notice | Display of the product duration | Derive hours from `Requirements.maximumTakeUs`, rather than adding another product-duration literal. | 14 |
