# Durable library owners

Core owns persistent identity, revisions, source evidence, jobs and publication.
It shares one [catalog transaction boundary](src/catalog.ts). The
[package exports](package.json) identify the modules consumers can use; the
[service composition](../../apps/service/README.md) connects them to native work.
Core consumes [composition](../composition/README.md) for edit meaning instead of
maintaining another timeline interpreter.

## Assets, acquisitions and projects

An asset identifies immutable admitted bytes and their streams. An acquisition
binds those bytes to source provenance and available intervals. A project revision
places occurrences of selected streams; neither byte identity nor a recording
role selects an authored layout. The same asset can appear several times or in
several projects without merging their occurrence identities.

Stored asset metadata is a summary. Conversion consumes [fresh native facts](src/hdr-conversion-facts.ts)
from retained source bytes, including exact sample support and interpretation
evidence. Selected audio retains actual decoded native-rate runs and PCM identity
separately from video sample-cursor support; packet capacity never becomes decoded
audio evidence. Absent declarations remain absent; a successful parse does not establish
decoded appearance or authorize a treatment.

Converted assets retain their original dependency and frozen [conversion evidence](src/asset-origins.ts).
Portable adoption binds selected source and derivative occupied support to that
same clock, including unretimed media operands. A digest identifies fresh facts;
it never substitutes for those support bindings or grants conversion permission.

Read-only acoustic measurements retain the selected PCM generation and recipe.
Integrated loudness requires complete admitted support; a hole cannot become
measured silence or concatenate neighboring material. A null gate result is
evidence of measurement limits, never an instruction to normalize. Explicit
normalization publication retains complete before/after measurements and every
bounded candidate offset/result, and publishes the selected candidate with an
issue naming each missed target. A prepared signal's issues, including a `support-gap`
where its recipe split state, follow from its recipe and evidence: retained reads
re-derive them and refuse stored issues that differ, and a package import derives them
rather than carrying them. Prepared excerpts preserve that complete
processing evidence rather than relabeling it as an excerpt measurement. An explicit
prepared signal pin must match its complete tap, ordered processing recipe and revision
inputs. Selected taps retain the same whole state domains as ordinary inspection;
only a matching processed output may substitute for a video export's final mix.

[Transcript observations](src/transcript.ts) retain overlapping estimates and true
instant points without manufacturing playable duration. [Source enumeration](src/transcript-read.ts)
returns every retained observation when unfiltered; explicit interval queries use
half-open membership. Search and caption grouping preserve the widest selected
estimate rather than assuming the final word ends latest. Text seeds keep original
word pins; a selection consisting only of points requires caller-authored text extent.

Speech preparation owns execution scope; retained reads own selection. A bounded
preparation keeps the whole-source descriptor and pins its range, decode context
and recipe in generation identity. Decoded context does not expand primary
ownership: physical gaps, unobserved support and skipped support remain distinct.
[Transcript publication](src/transcript-processing.ts) resolves omitted generation
only through full-support identity; bounded reads and project dependencies pin the
retained generation explicitly. Native windows remain raw provenance, while
connected primary observation runs preserve phrase continuity across accepted seams.

A retained transcript generation whose recipe or transcript policy is no longer
current, or that this version can't read, is stale. Retained rows parse under a
historical schema and keep the identity that produced them; only new requests must
name the current recipe. Reads, inventories and package exports skip a stale
generation, cleanup forgets its publication and reclaims it, and the next request
regenerates it under the job key the current identity forms. A caption seed an
existing revision already pins stays readable as historical evidence; nothing new is
seeded from it. Any producer change that should retire old results, including old
failures, changes an identity in its job input.

[Rendered recognition](src/rendered-speech.ts) measures newly extracted revision PCM;
source-text projection remains a separate read. Each project attempt owns fresh
inference even when its bytes match an existing source asset. Its identity pins
model, decoder and transcript admission policy together. Retained words keep
the PCM clock and map to project time from the actual first selected sample.
Missing source support refuses recognition rather than becoming measured silence.
PCM, engine provenance and words remain readable without current model readiness.

Source evidence retains its source clock. Project evidence projects it through
a revision's exact mapping without rewriting the source observation. Generation
and dependency identity bind pagination, prepared output and caches; freshness
must be rechecked when asynchronous work crosses a publication boundary.

[Anonymous acoustic observations](src/speaker-evidence.ts) retain their invocation's
slots and complete native score operands. A slot never identifies a person across
observations, and a sigmoid value never claims calibrated assignment confidence.
Captured refusal operands remain evidence; only queue settlement publishes a
validated generation. Retained reads bind that generation's original decoder,
independently of the currently installed executable or prepared runtime. Chronological
pagination preserves native row ordinals and simultaneous observations.

[Conditional alignment](src/alignment-operands.ts) preserves literal supplied text,
complete native matrices and all-optimal provider correspondence. Supplied path
estimates and greedy observed words remain separate. A textual match never proves
lexical truth; ambiguous repetitions stay unknown, and native cells outside selected
physical support retain their bounds with a refusal. Retained acoustic classification
uses only the caller's threshold and never assigns a word or authorizes a cut.
[Publication](src/alignment-processing.ts) shares the existing jobs and Models owners;
[retained reads](src/alignment-read.ts) need neither inference nor runtime bytes.
Captured failed operands remain inspectable without claiming ready word evidence.

Project speaker reads keep the observation generation beside each clip occurrence.
Repeated uses and overlapping observations never merge anonymous slots. Coverage
separates unavailable source support from retained audio that has no observation;
neither becomes a speaker assignment. Continuations pin the selected channel,
model, revision and source generations through the existing evidence cache.
Clipping may collapse distinct starts; merge order follows chronological source
records while the returned native ordinals remain unchanged.

## Transactions, replay and lifetime

Edits commit document changes, dependency references and replay receipts together.
An uncertain answer is recovered with the original request, not a newly inferred
edit. Retained revisions keep dependencies reachable through undo. Incompatible
catalogs are refused rather than silently reconstructing missing semantic inputs;
[persisted reference fixtures](fixtures/README.md) preserve that refusal contract.

Background jobs retain attempt ownership through cancellation and resource drain.
A stale result cannot publish into a replacement attempt. Public
[job inspection](src/jobs.ts) uses the [publication contract](../protocol/README.md#published-work)
while retaining the original output identity beside current work; internal execution
and portable storage retain their serialized result contract. Readiness means admitted
and published output, not merely a completed native call. Models and generated
media share these owners rather than introducing separate queues or stores.

Job retryability is read from the refusal ledger for the job's error code when the
job is projected; the catalog's legacy retryable columns remain storage details and
are not a second authority. A failed job stays failed until an explicit `job.retry`
call, and reads, polling, waiting and startup reconciliation never retry it. A
retryable job projection carries the exact resolving call in `details.retry`, so an
agent can wait for any returned delay and then choose that call deliberately.

A producer reports problems with its output as [issues](../composition/src/issues.ts).
[Issue storage](src/issues.ts) is an additive table written in the publication's
transaction and keyed by the publishing attempt, so it lands, rolls back and is
retired with that publication. Retained evidence objects and portable packages never
carry issues, and a publication without rows, including one from an older catalog, reads as clean.
Where evidence holds the facts, the issues are derived from it alone: a picture's or
movie's font fallbacks become [text fallback issues](src/text-fallback.ts), and a
project index publishes the issues of the frames it retained.

Capture recovery receipts cross this boundary once through
[capture-publication.ts](src/capture-publication.ts): the bounded native receipt is
strictly admitted before source publication is interpreted, and ambiguous media
stays retained and retry-visible.

[Model preparation](src/models.ts) binds explicit model/runtime identities and
verified local readiness. Preparation can acquire pinned inputs; execution cannot
silently prepare another implementation. Prepared optional runtimes share one purpose-checked execution accessor; another
model purpose does not create another preparation or lifetime owner. Profiles
describe measured work bounds, not universal quality or capacity claims.
Registered acquisition policy can require explicitly supplied local model bytes;
it does not change execution identity. An already verified preparation remains
idempotent without repeating its original acquisition inputs. Startup trusts a
preparation whose receipt matches its model files and whose runtime matches its
registered inventory by metadata, instead of rehashing the runtime; anything else
falls through to full verification and repair, and execution still verifies the
runtime bytes before every run.

[Presets](src/presets.ts) are a separate installed tree, `~/.yap/presets/`,
outside the library: mood bundles the service installs from the app bundle,
refreshes from the repository's pinned index and serves through `preset.*`. The
[presets record](../../specs/done/presets/README.md) names each module's owner.

Curated runtime acquisition uses the same downloader and cancellation owner.
The [runtime recipe](../../helpers/model-runtime/README.md) identifies public
interpreter/package inputs and offline assembly; the service supplies execution
lifetime. Full measured inventory admission precedes publication. Neither a
successful installer nor a matching package version is runtime readiness.

## Publication and storage

Export intent pins revision and destination before execution. Acknowledgement
loss does not change that intent or repeat the content edit. Private staging
stays owned until retirement is confirmed; a committed external file remains
independent of project deletion. Portable adoption owns copied bytes and their
meaning rather than borrowing a donor path indefinitely.

The current project package format retains admitted speaker and conditional
alignment generations, their complete original operands and publication order.
The same evidence parsers admit live and portable observations. Older package formats are refused;
adoption stages evidence against package source facts and rechecks the published
live source owner inside the existing transaction before replaying readiness.
A stale transcript the package carries only as derived evidence is left out of
adoption and regenerated on request; one a revision pins is adopted as historical
evidence without a publication.

Deletion fences new borrowers, drains existing work and retires durable references
before removing owned files. Cache eviction cannot destroy original or generated
sources. Aggregate [storage observations](src/storage.ts) measure managed files;
shared media does not have an invented per-project byte share. Models and external
donors have separate ownership, and shutdown joins observations before closing
the catalog.

[Frame inspection](src/frame-inspection.ts) retains optional picture measurements
beside its existing source sample or compiled revision identity. Requested masks
and thresholds participate in the frame and index recipes, so plain pixels cannot
stand in for measured evidence and another rectangle cannot reuse its receipt.
The [pure public observation contract](../protocol/src/picture.ts) admits masks,
coverage and histogram operands; native still owns their computation on the
inspected raster. Index retention copies the complete evidence with its PNG and
proves only the sampled picture, never intervening visibility or a quality grade.


Terminal jobs use `CANCELED` for explicit cancellation, `OWNER_DELETED` when their
input owner was removed, and `CONTEXT_CLOSED` when a process-local context closed.
Only terminal non-ready jobs whose ledger code permits retry expose `details.retry`.
Retrying a non-retryable job preserves its own refusal code. A backlog resumes
`JOB_INTERRUPTED` work after restart automatically; ordinary failures still need
an explicit retry.

A completed recording can report `completionReason: "maximumDuration"`. This
closed lifecycle fact is independent of cleanup diagnostics and interruption codes;
ordinary caller stops omit it. It survives catalog reopen.
