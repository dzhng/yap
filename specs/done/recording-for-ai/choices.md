# Implementation choices

Historical recording-design record. The [recording guide](README.md) owns its
scope and points to current implementation; this document does not reopen old work.

## Bootstrap and tooling

### Local bundle identity

- **When:** bootstrap.
- **Decision:** build a locally ad-hoc-signed ScreenRecorder.app with stable bundle
  identifier com.david.screenrec. Its status-bar label is ScreenRec.
- **Gap:** the project had no product name, signing identity or distribution setup.
- **Rationale:** a stable local app identity supports later macOS permission testing;
  public signing/notarization belongs to the separately planned public release.
- **Consequence:** the personal build needs no distribution account; public release
  must explicitly choose its signing and product identity.

### Build dependency pins

- **When:** bootstrap.
- **Decision:** pin the installed registry versions of TypeScript, Vitest, Turbo,
  oxfmt, oxlint, Zod and Node 24 types; Bun and Node retain the spec's runtime split.
- **Gap:** the spec delegated exact dependency versions.
- **Rationale:** one lockfile and exact direct versions make the initial toolchain
  reproducible rather than copying another repo's older numbers without a reason.
- **Consequence:** updates are deliberate dependency changes and require focused checks.

### Native build caching

- **When:** bootstrap.
- **Decision:** disable Turbo caching for the native bundle build and process/conformance tests;
  include the shared TypeScript compiler config in global cache inputs.
- **Gap:** package-local build outputs do not describe the root .app directory.
- **Rationale:** a cached success must not skip creating the actual app after output
  deletion. Swift already performs incremental compilation.
- **Consequence:** root builds always invoke native packaging/signing, and native process checks
  execute even when inputs outside the app package change.

## Actual-agent inspection

### Evidence without personal recordings

- **When:** image-access gate.
- **Decision:** use randomly generated digit PNGs and an isolated Claude Code
  session to prove both MCP image blocks and CLI-file image ingestion.
- **Gap:** the spec needed an actual-client proof before any recorded fixture existed.
- **Rationale:** hidden expected text plus retained tool exchanges distinguishes
  seeing pixels from receiving a plausible file path or inferring a scripted answer.
- **Consequence:** this establishes the transport/client boundary only; readability
  of real screen recordings and the eventual edit loop still need their own gates.

## Speech evaluation

### Repeated-word alignment

- **When:** local speech preparation.
- **Decision:** compare words in order, then use their times to break equally good
  text matches. A repeated “like” close to the observed audio is preferred over a
  distant occurrence; timing never excuses a worse transcription.
- **Gap:** the acceptance gate specifies timing accuracy but not ambiguous matching.
- **Rationale:** choosing the last repeated occurrence by array order can turn one
  omitted word into an invented multi-second timing error. Sequence plus proximity
  preserves the distinction between missing words and bad boundaries.
- **Consequence:** ambiguous matches use the reference timing; this small annotated
  evaluation remains evidence for the fixture, not universal speech accuracy.

### Keep raw inference evidence

- **When:** local speech preparation.
- **Decision:** preserve upstream reports in a separate directory beside normalized
  results, including when the recording itself is named “result”.
- **Gap:** diagnostic layout was unspecified.
- **Rationale:** separate paths prevent filename collisions without rejecting valid
  recording names. Raw confidence/segment data remains available for review.
- **Consequence:** the test harness retains both reports; production artifact layout
  remains owned by the processing slice.

## Revision persistence

### Bound database contention

- **When:** durable revision transactions.
- **Decision:** wait at most one second for a competing SQLite writer, then return
  retryable `STORAGE_BUSY`. The same request ID can safely be retried.
- **Gap:** the spec required bounded waiting but did not choose the duration.
- **Rationale:** edit transactions are short; brief contention should succeed while
  a held lock must not freeze the caller indefinitely. No custom retry loop or
  second storage authority is needed.
- **Consequence:** lock contention can surface as a retryable result. The service
  must keep encoding and transcription outside these transactions.

## Local transport

### Sound — medium confidence

#### Accept a request when its complete JSON line arrives

- **When:** 06b local transport.
- **Choice:** A client sends a JSON message ending in a newline and keeps the socket open while waiting. Once that valid bounded line arrives, the service may run its handler. Waiting for the client to close its writing side would prevent the server from observing a later disconnect on the tested Node Unix sockets. Later bytes cannot undo an already accepted edit.
- **Gap:** The plan specified one request per connection but did not specify whether newline or end-of-stream establishes acceptance.
- **Reach:** All clients must use the same framing convention; handlers receive a cancellation signal when the live connection closes. The returned signal cannot reverse a committed database transaction.
- **Verdict:** Sound. This keeps client disconnects observable without adding a session or acknowledgement protocol; the framing parser rejects invalid or oversized frames before dispatch.
- **Confidence:** Medium.

#### Put correlation ID alongside the operation result

- **When:** 06b local transport.
- **Choice:** A response contains the caller's `id` together with `ok` and either `data` or `error`. A client verifies this ID against the request snapshot it actually sent. Reusing the caller's JavaScript request object for another operation cannot change that in-flight comparison.
- **Gap:** The plan required a correlated typed envelope but left its exact outer shape unspecified.
- **Reach:** Future CLI and MCP adapters can pass through the same operation result without another nested transport result object. Existing request parsing remains strict; response parsing tolerates additive metadata according to the project review rules.
- **Verdict:** Sound. One shared protocol schema owns both success/error variants and their correlated response forms.
- **Confidence:** Medium.

#### Close invalid request connections; keep operation failures structured

- **When:** 06b local transport.
- **Choice:** If incoming bytes or the request envelope are invalid, the service closes that connection without invoking a handler. It does not invent a trusted request ID from malformed data. A valid request whose handler fails receives a correlated error; an oversized handler result produces `LIMIT_EXCEEDED`. Such an error does not imply that a prior mutation was rolled back.
- **Gap:** The plan required rejection but left server-side error behavior for uncorrelatable input and oversized output unspecified.
- **Reach:** Clients distinguish transport failures from domain results and retain request IDs for explicit replay after uncertain outcomes. Registry/domain handlers remain responsible for actionable domain errors; unexpected thrown failures become a generic internal error.
- **Verdict:** Sound. This avoids dispatching malformed requests or leaking arbitrary internal exception text while retaining correlated errors wherever an accepted ID exists.
- **Confidence:** Medium.

### Sound — high confidence

#### Refuse a pre-existing runtime directory that is not already private

- **When:** 06b local transport.
- **Choice:** The listener creates missing directories privately, but an existing directory must already be owned by the current user with mode 0700. If somebody passes a shared directory such as `/tmp`, startup refuses it instead of changing that directory's permissions. The actual socket is set to 0600.
- **Gap:** The plan required a private runtime directory without specifying repair behavior for an existing unsuitable path.
- **Reach:** Application setup must supply its own private runtime directory. The listener never changes access to unrelated pre-existing directories.
- **Verdict:** Sound. It meets the privacy contract without changing arbitrary user filesystem permissions.
- **Confidence:** High.

The no-live-unlink invariant and direct libuv-owned socket cleanup were explicitly clarified by the parent during this pass and should be treated as the updated plan, not a new inferred lifecycle mechanism. Internal names, fixture locations, and package scripts follow delegated implementation discretion.

## Native finalization

### Wait for a busy encoder without blocking capture control

- **When:** native finalization, Claude Opus pass plus integration review.
- **Choice:** If Stop reaches an encoder that is still busy, observe its readiness
  and append the held final frame when it can accept data. Give that readiness wait
  two seconds, then report an interrupted result if the frame still cannot be
  accepted. Recheck actual writer status/readiness at the deadline. This replaces
  immediate failure on ordinary backpressure without waiting indefinitely.
- **Gap:** The capture contract did not choose a readiness wait mechanism or budget.
- **Reach:** A stopped take can finish normally after a brief encoder backlog. The
  two-second bound applies to accepting the held frame, not a guarantee about every
  container-finalization operation. App lifetime/recovery must handle failure there.
- **Verdict:** Sound. A single readiness observation and deadline fit the existing
  push-style capture input; real AVFoundation tests reached backpressure and decoded
  the appended frame. There is no polling loop or general retry framework.
- **Confidence:** Medium. The precise budget is an engineering default, not a
  measured universal limit; a healthy case exceeding it warrants revisiting it.

## Native acquisition and frame execution

### Sound — medium confidence

#### Record accepted audio ranges beside media

- **When:** native recovery checkpoint.
- **Choice:** When an audio buffer is accepted by the writer, append its time range
  to the capture journal. Recovery intersects decoded audio with those ranges. For
  example, if narration begins a quarter-second late, decoder-generated leading
  silence cannot be mistaken for captured speech. Without the journal, decoded audio
  remains accessible but is explicitly unverified as acquisition evidence.
- **Gap:** The plan required honest usable audio intervals but did not account for
  the platform decoder synthesizing padding inside a nonempty audio track.
- **Reach:** Transcription must consume verified acquired ranges. Per-buffer journal
  writes are flushed by normal OS writes; durable capture transitions synchronize
  the journal. Sudden power-loss guarantees remain outside the tested contract.
- **Verdict:** Sound. Media decoding proves readable bytes; the acquisition journal
  separately proves what was recorded. Neither source of evidence substitutes for
  the other.
- **Confidence:** Medium. Generated PCM and actual device interruption still need
  separate verification before accepting the full recording workflow.

#### Expose frame execution as a native worker operation

- **When:** 09a native decoder integration.
- **Choice:** The core supplies an immutable source path, a time interval that survives
  the edit, and a destination for the PNG. The native worker returns the actual frame
  timestamp and file details. It does not search the library or reinterpret edits.
  A later service pool can cancel a worker process without putting media decoding on
  the menu-bar app's control thread.
- **Gap:** The plan required a worker binding but did not prescribe its internal
  request shape or allocation boundary.
- **Reach:** The service must resolve revisions and allocate derivative paths before
  dispatch. Frame caching, concurrency and cancellation remain service work; this
  operation adds no second timeline owner.
- **Verdict:** Sound. The operation is a thin boundary over the existing decoder,
  with strict request fields and no additional library or state store.
- **Confidence:** Medium. Worker lifetime and reuse still need measurement when the
  service composes it into the complete inspection path.

## Shared native sample timing

### Sound — high confidence

- **When:** recovery timing correction.
- **Choice:** Frame inspection and crash recovery share one translation between a
  video's internal sample times and the timeline shown to a caller. If an edit
  shifts a frame by 200 ms, both readers apply that same shift before interpreting
  the frame's timestamp or duration.
- **Gap:** The plan assigned native media execution one owner but did not name the
  shared utility needed when both recovery and image selection read edit lists.
- **Reach:** Future native media readers should use `ScreenRecorderMediaTime` rather
  than recreating timestamp conversion. It adds one Swift target, no external dependency.
- **Verdict:** Sound. A real fixture showed a 300 ms under-report from mixing the
  two clocks; a single mapping prevents the corrected readers from drifting apart.
- **Confidence:** High.

## App-owned service startup

### Sound — medium confidence

- **Choice:** The app resolves its build-recorded Node interpreter, with explicit
  override and conventional installation paths, instead of bundling Node. A Finder
  launch therefore does not depend on the developer shell's PATH.
- **Gap:** Personal-host Node 24 was specified; interpreter discovery was delegated.
- **Reach:** Moving or removing Node requires rebuilding or setting the override.
  Tester/public packaging remains separate work.
- **Verdict:** Sound within the personal-host prerequisite. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Hold an operating-system file lock for the service lifetime before
  reclaiming a dead socket. The lock file stays in place; process death releases
  ownership automatically.
- **Gap:** The plan required a single owner without prescribing the lock mechanism.
- **Reach:** Startup uses macOS file-lock semantics; no custom stale-PID lock owner
  or extra native launcher is added.
- **Verdict:** Sound. **Confidence:** High.

- **Choice:** Normal app quit waits for a bounded interpreter probe to finish
  cleanup, and prevents any late startup callback from launching the service.
- **Gap:** The plan did not name ownership during interpreter validation.
- **Reach:** Quit can take the remainder of the probe deadline and escalation;
  forced app death while probing a noncooperative executable is outside this guarantee.
- **Verdict:** Sound. **Confidence:** High.

## Service library binding

### Sound — medium confidence

- **Choice:** Open the catalog during service startup, after claiming ownership,
  and make an unusable catalog a reported startup failure.
- **Gap:** The plan specified one catalog writer but did not say whether opening
  the database was eager or deferred until the first library call.
- **Reach:** Ordinary launch creates the empty catalog; readiness now means the
  library can be opened as well as the socket. A damaged catalog prevents a false
  ready state and is reported through the existing bounded startup path.
- **Verdict:** Sound. **Confidence:** Medium.

## Cursor retention and recording lifecycle

### Sound — medium confidence

- **Choice:** Keep at most 240 recent native geometry placements in memory while
  preserving the full recorded geometry journal. If a delayed reading predates that
  retained window, keep its raw point and mark its projection unknown.
- **Gap:** Sampling was required to be bounded; retention during a long pause with
  continuing window movement was unspecified.
- **Reach:** A very delayed point may need later reconstruction from the journal;
  the worker does not invent a placement to hide a dropped in-memory entry.
- **Verdict:** Sound. **Confidence:** Medium; the count remains a measured tuning
  point rather than a promise about a fixed number of seconds.

### Sound — high confidence

- **Choice:** Retain a canceled take's catalog identity as a tombstone, excluded
  from latest and unavailable to revision/history/edit reads.
- **Gap:** Cancel removes a take from discovery, but request replay still needs to
  resolve its former identity and reject late capture results.
- **Reach:** Media deletion remains service work; the retained metadata prevents
  a replayed start from creating a second take or reviving discarded evidence.
- **Verdict:** Sound. **Confidence:** High.

- **Choice:** Finalize an interrupted take only after recovery has determined
  whether video exists. A terminal zero-video outcome and an attached duration
  cannot replace each other later.
- **Gap:** The precise transaction boundary around recovery was unspecified.
- **Reach:** Service reconciliation must finish validating media before publishing
  a terminal interruption; it cannot use zero-video as a temporary processing state.
- **Verdict:** Sound. **Confidence:** High.

## CLI/MCP adapter seam

### Sound — high confidence

- **Choice:** Keep transport correlation IDs separate from durable mutation request
  IDs, and retain a parsed transport ID even when local JSON validation fails.
- **Gap:** Mutations already required replay identity; the CLI's error behavior
  before a service call was unspecified.
- **Reach:** Automation can correlate failed invocations while retrying edits with
  their original mutation identity. Invalid command-line syntax is diagnosed on
  stderr, which also protects MCP's stdout before mode parsing has succeeded.
- **Verdict:** Sound. **Confidence:** High.

## Recording discovery

### Sound — high confidence

- **Choice:** Browse recordings newest first using the last returned creation
  sequence as the continuation boundary. Recording states and current revisions
  are read when each page is requested.
- **Gap:** The spec bounded recording lists but did not choose their order or
  whether list pages freeze the whole recording's metadata.
- **Reach:** If a new take starts between pages, the agent continues through older
  takes without duplicates or a shifting offset. A new traversal finds the new
  take. A recording that finishes meanwhile reports its current state; opening it
  by ID still resolves and pins the inspection revision separately.
- **Verdict:** Sound. **Confidence:** High.

## Native audio excerpts

### Sound — medium confidence

- **Choice:** Support mono and stereo excerpts; refuse wider layouts with an
  explicit unsupported-format error. A mono track reaches both channels when mixed
  with stereo, and no channel is copied into an invented surround position.
- **Gap:** The app's audio contract did not specify surround-channel mapping.
- **Reach:** Ordinary narration and system-audio inspection work; a future wider
  input layout needs an explicit mapping and its own verification.
- **Verdict:** Sound. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Inspection excerpts use float PCM WAV at the higher source sample
  rate. Output placement rounds cumulative playback time once at each boundary.
- **Gap:** The excerpt container and mapping from microseconds to indivisible audio
  samples were unspecified.
- **Reach:** Many tiny cuts cannot accumulate duration drift. Rate conversion may
  need a read ending up to one output sample beyond the nominal microsecond range
  to produce those allocated samples. Requested edit spans remain unchanged; human
  video encoding and its AAC soundtrack stay with the video renderer.
- **Verdict:** Sound. **Confidence:** High.

## Local request admission

### Sound — high confidence

- **Choice:** Limit open local connections separately from unfinished handlers;
  reject excess work instead of buffering it. An abandoned handler keeps its slot
  until it actually finishes, even if its client disconnects.
- **Gap:** Individual frame sizes and timeouts were bounded, but simultaneous local
  connections and requests had no total admission limit.
- **Reach:** Repeated client timeouts cannot build an unlimited queue behind native
  capture. A saturated handler pool gives a retryable limit error; saturation before
  request parsing closes the connection. The caller decides whether to retry.
- **Verdict:** Sound. **Confidence:** High.

## Capture request recovery

### Sound — medium confidence

- **Choice:** If a native start and its cleanup stop both go unanswered, retain the
  take as unproved. A retry attempts to end that same take and recover its media,
  rather than starting another or reattaching the caller to an ongoing capture.
- **Gap:** The spec required durable replay but did not prescribe recovery after
  both control answers are lost while the service is still alive.
- **Reach:** The caller may receive a recovered interrupted recording instead of a
  continuing capture. It never receives a false terminal no-video answer while the
  device may still be running. `UNRESOLVED_START` remains retryable until an outcome
  can be proved.
- **Verdict:** Sound. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Start and restart share a capture-allocation request-ID namespace,
  with canonical source/audio/target arguments stored beside the allocated take.
- **Gap:** Capture replay's precise identity scope was unspecified.
- **Reach:** Retrying the same request returns its existing identity across service
  relaunch; reusing that ID for another operation, source or audio choice fails with
  `REQUEST_CONFLICT`. Callers use a fresh ID for a new intended take.
- **Verdict:** Sound. **Confidence:** High.

## Cursor evidence styling

### Sound — medium confidence

- **Choice:** Keep a readable minimum trail width and pointer size in the delivered
  image, even when the caller scales the screen down. Cap the pointer minimum on
  tiny thumbnails. Use a magenta trail with a dark halo and a white arrow.
- **Gap:** The spec required readable fading evidence but did not choose styling
  or the tradeoff between small marks and covering recorded content.
- **Reach:** Small outputs retain recognizable pointing evidence, at the cost of
  covering more of the underlying label. Paths and hotspots never move to avoid
  content. A clean or larger image resolves obstruction; arbitrary backgrounds
  and very small text cannot be guaranteed readable from these fixtures.
- **Verdict:** Sound, reversible styling. **Confidence:** Medium.

## Durable work identity

### Sound — medium confidence

- **Choice:** Store each distinct recording/revision/artifact/input combination
  separately. An exact repeat returns its existing result or failure; only an
  explicit retry creates a new attempt and generation. Canceled work can be
  explicitly retried while its recording still exists.
- **Gap:** The spec required pinned results and one automatic attempt but did not
  choose the queue's exact identity or canceled-job retry semantics.
- **Reach:** A later edit or different frame option cannot receive an earlier
  job's result. Source-only processors should explicitly use the original revision;
  transcript projection through edits must not start recognition again. Derived
  cache eviction and retained-evidence lifecycle still require their own owners.
- **Verdict:** Sound. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** The queue owns its job/artifact tables in the existing catalog
  connection and allows 32 waiting jobs in addition to the prescribed active slots.
  Inputs are canonical strings supplied by each artifact's owning adapter.
- **Gap:** Storage layout, pending admission limit and executor payload shape were
  implementation choices.
- **Reach:** There is one metadata writer; overload is explicit rather than an
  unbounded backlog. The queue does not interpret transcription or media settings.
  New adapters must define stable inputs and pass cancellation to the native runner.
- **Verdict:** Sound. **Confidence:** High.

## Cursor evidence transfer

### Sound — medium confidence

- **Choice:** Export normalized cursor/geometry observations to a caller-owned JSONL
  file through the existing native journal reader. Limit a transfer to 256 MiB of
  input and output and keep the provenance header within 16 KiB.
- **Gap:** The spec required bounded raw-history access but did not choose the
  ingestion format or per-worker transfer budget.
- **Reach:** Core can ingest evidence once without copying native geometry rules or
  loading all samples into memory. Very large journals produce an explicit limit
  error; chunked ingestion beyond that budget is not implemented. Public pagination
  must use the later index, not rescan this file for every page.
- **Verdict:** Sound for this bounded internal seam. **Confidence:** Medium.

## Personal app discovery

### Sound — medium confidence

- **Choice:** Let the client locate a personal app through `SCREENREC_APP` or the
  default user Applications path. If an app already runs with another library home,
  leave it running and let discovery of the requested home time out.
- **Gap:** The launch/home mismatch behavior was unspecified.
- **Reach:** A client cannot silently restart a recording app or switch its library.
  The caller can select an existing socket, or quit and relaunch the app with the
  intended home. The error identifies the requested service and connection options.
- **Verdict:** Sound. **Confidence:** Medium.

## Source processing admission and raw reads

### Sound — medium confidence

- **Choice:** Automatically prepare cursor evidence for every finalized usable take,
  including takes discovered after relaunch. For example, if the app stops after
  saving a recording but before scheduling its evidence, relaunch finds the missing
  job and schedules it. A take whose processing actually failed stays failed until
  the caller explicitly retries.
- **Gap:** The spec required durable readiness but did not choose how finalization
  and job admission recover when only one of the two transactions committed.
- **Reach:** An ordered scan of recordings reuses the queue's durable job identity;
  no second queue or recurring timer is introduced. Capacity becoming available
  admits the next missing take, even when the initial backlog exceeds queue limits.
- **Verdict:** Sound: closes the crash gap while preserving deliberate retry.
  **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Raw cursor pages remain in original source time after edits. If an
  agent cuts the first second, a sample originally at two seconds still says two
  seconds in a raw query; an edited frame reader separately maps it to playback
  time. Page tokens identify the source, published processing attempt and time
  range, so changing those inputs cannot silently splice two result sets.
- **Gap:** The spec required raw access but did not prescribe continuation identity.
- **Reach:** Raw observations are reusable evidence rather than another edit-owned
  copy. Future projected cursor reads must label their playback coordinates and
  retain the source references.
- **Verdict:** Sound: immutable evidence and edited views keep distinct meanings.
  **Confidence:** High.

## Abandoned evidence lifecycle

### Sound — high confidence

- **Choice:** Reclaim unfinished cursor derivatives after startup and before another
  attempt for the same recording. Suppose a process dies halfway through indexing:
  the next service removes that abandoned attempt's files and rows, while leaving
  the original video and the published attempt untouched. A canceled worker still
  writing counts as active until it actually exits, even if a retry is already queued.
- **Gap:** Durable jobs identified interrupted attempts, but the spec did not name
  the owner that removes their unpublished files and partially indexed records.
- **Reach:** Source processing owns this narrow cleanup; it is not the cache policy
  or user recording deletion. Scans stream candidates and delete rows in batches,
  so cleanup can yield to client requests and abort before catalog shutdown.
- **Verdict:** Sound: prevents repeated interrupted attempts accumulating unused
  evidence without treating a canceled-but-running worker as safe to delete.
  **Confidence:** High.

## Cache regeneration

### Sound — high confidence

- **Choice:** Regeneration names the exact published generation it found missing.
  For example, two frame readers notice an evicted file; the first starts a new
  decode, and the second cannot erase that new work using its old observation.
  The new decode keeps the original requested edit revision even if the user cuts
  the recording while it waits.
- **Gap:** The cache contract required evicted files to be recreatable but did not
  specify the queue transition or its stale-observer protection.
- **Reach:** Disposable media owners use regeneration for cache misses; ordinary
  retry of completed retained evidence remains idempotent. Queue admission and
  obsolete-publication removal happen together, so a full queue loses no metadata.
- **Verdict:** Sound: cache eviction does not weaken durable attempt identity.
  **Confidence:** High.

## Disposable cache ownership

### Sound — medium confidence

- **Choice:** Hold cached files in a dedicated directory with accounting in the
  library catalog. A reader acquires an open file handle and pins that entry until
  release; if all candidates are held, another publication reports retryable
  pressure instead of evicting a file somebody is reading.
- **Gap:** The spec fixed the cache budget and LRU policy but not read lifetime or
  restart accounting. A pathname alone could disappear before a client reads it.
- **Reach:** Frame/audio producers must publish only completed output, and service
  delivery must release handles on success, error, timeout and shutdown. Startup
  reconciliation runs before producers and repairs missing files without touching
  source media or retained evidence. Native per-output limits bound pending files.
- **Verdict:** Sound: cache pressure cannot silently truncate an active delivery.
  **Confidence:** Medium.

## Image delivery lifetime

### Sound — medium confidence

- **Choice:** The service gives a ready image a short-lived read token, transfers it
  in chunks and closes it after delivery. A token lasts at most 30 seconds, no
  matter how often it is read; at most 32 tokens may hold files, and one read is
  capped at 512 KiB. If a client disappears, expiry releases the file automatically.
- **Gap:** The spec allowed images larger than a metadata socket response but did
  not choose the binary transfer or abandoned-reader lifetime.
- **Reach:** CLI and MCP consume the same bytes without racing cache eviction.
  Repeated offsets remain deterministic, including the final chunk. Slow callers
  can request a fresh image delivery; they cannot pin cache files indefinitely.
- **Verdict:** Sound for bounded local image delivery. **Confidence:** Medium.

### Sound — medium confidence

- **Choice:** CLI image inspection uses an explicit output path when supplied, or
  creates a temporary PNG and returns its absolute path. It refuses to overwrite
  an existing file. MCP returns actual image content alongside matching metadata.
- **Gap:** The spec required a CLI file but did not choose its default destination
  or collision behavior.
- **Reach:** An external agent can inspect the returned local path immediately;
  users who want a retained destination pass one explicitly. Temporary images are
  delivered files, separate from the service's evictable internal cache.
- **Verdict:** Sound and reversible. **Confidence:** Medium.

## Streamed source timing

### Sound — high confidence

- **Choice:** Emit completed audio intervals when a gap or end of input proves
  their end, while emitting cursor observations as they arrive. A narration span
  can therefore appear after cursor samples whose timestamps fall inside it.
- **Gap:** The normalized evidence format did not prescribe ordering across event
  types. Sorting the entire recording would require retaining all its events.
- **Reach:** Consumers index explicit source timestamps instead of treating file
  order as global chronology. Native recovery and export share the same merge
  rule; only one pending interval per audio role is retained during streaming.
- **Verdict:** Sound: bounded export preserves timing without inventing a second
  clock or parser. **Confidence:** High.

### Sound — high confidence

- **Choice:** Malformed audio roles, negative times and empty acquisition intervals
  end the trusted journal prefix. If a damaged record claims another audio role,
  export keeps earlier valid evidence and reports the stopping boundary instead
  of extending the role set or pretending the record was valid.
- **Gap:** The source timing extension needed a corruption rule for new records.
- **Reach:** Only captured narration/system roles enter excerpt planning; incomplete
  pauses remain explicit without fabricated elapsed time.
- **Verdict:** Sound: consumers can distinguish missing evidence from silence.
  **Confidence:** High.

## Public audio delivery and background admission

### Sound — medium confidence

- **Choice:** Audio delivery allows up to 48 MiB while PNG delivery retains its
  existing 32 MiB bound. A maximum thirty-second, stereo, 192 kHz float excerpt
  needs about 46 MB of sample bytes, so the shared transfer must carry that
  native-supported result instead of refusing it because images are smaller.
- **Gap:** The spec bounded excerpt duration but did not choose adapter byte limits.
- **Reach:** Both CLI and MCP use one chunk reader; this bounds transfer memory,
  but does not guarantee every external MCP host accepts the largest audio block.
- **Verdict:** Sound and reversible: covers the full native output bound.
  **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Automatically admit one source-processing job at a time. When many
  old recordings need indexing at startup, one can use the single heavy worker
  while a foreground image or audio request still has room in the waiting queue.
  Finishing a job admits the next old recording. Explicit retries remain targeted.
- **Gap:** The shared queue's waiting limit did not prescribe backfill admission.
- **Reach:** Startup and capture finalization share the same admission rule;
  background work cannot fill every waiting slot without increasing throughput.
- **Verdict:** Sound: preserves background progress and foreground access.
  **Confidence:** High.

### Sound — high confidence

- **Choice:** The native audio writer chooses WAVE independently of the output
  filename. An opaque cache path ending in .cache therefore contains the same
  WAVE bytes as a user-facing .wav file.
- **Gap:** Cache naming and the native staging-file suffix had incompatible owners.
- **Reach:** Cache storage stays media-independent; the decoder owns its container.
- **Verdict:** Sound: one owner for each independent decision. **Confidence:** High.

## Shared visual observations and comparisons

### Sound — medium confidence

- **Choice:** A scene boundary can be either a large changed image area or a
  smaller change spread across many cells. Scrolling a mostly white webpage
  moves thin text across the screen; requiring a large changed area alone can
  miss it. A compact caret or button highlight does not reset the synthetic cases.
- **Gap:** The spec delegated deterministic thresholds but did not prescribe them.
- **Reach:** Local trails and whole-recording screenshot selection share this
  comparison policy. Real UI acceptance must tune it before default trails ship;
  broad animation can still look like a boundary and very brief states can be missed.
- **Verdict:** Sound as a provisional measured heuristic, not semantic recognition.
  **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Keep requested times, actual decoded times and their distance, and
  compare each distinct decoded frame once. Several requests during a static
  frame retain their coverage records without inventing visual transitions.
  Include the requested endpoint and a preceding sample inside the kept span.
- **Gap:** Sampling boundaries and held-frame comparison were not fully specified.
- **Reach:** Chunked analysis can carry its previous observation forward and use
  the same comparison policy. This does not decide where a cursor trail belongs
  when the nearest frame comes from before or after the request.
- **Verdict:** Sound: preserves the evidence needed for that later timing decision.
  **Confidence:** High.

## Native decode retry classification

### Sound — high confidence

- **Choice:** A native media decode failure permits another explicitly requested
  attempt. If an audio file temporarily cannot be opened, subsequent reads keep
  reporting the failed result; a retry request may start the decoder again. The
  same rule applies to frames. Bad request shapes and invalid ranges stay terminal.
- **Gap:** The native error envelope had marked every failure terminal, even
  transient file access, codec and allocation failures.
- **Reach:** One shared wire policy owns this classification. A corrupt file can
  still fail on every explicit attempt; retry permission promises no repair and
  creates no automatic retry loop or source-repair capability.
- **Verdict:** Sound: preserves deliberate retry without hidden background work.
  **Confidence:** High.

## Ordered frame batches

### Sound — medium confidence

- **Choice:** A valid batch can succeed while individual images are pending or
  failed. For example, five cached images remain usable when a sixth cannot be
  read. The top-level response and CLI exit code report a valid batch; callers
  inspect each item's explicit result. Invalid input rejects the whole batch
  before any work starts, whereas runtime failures stay local to an item.
- **Gap:** The eight-image limit did not choose batch failure semantics.
- **Reach:** MCP image content indices identify ready items even when other items
  produce no image; callers must not treat top-level success as all-images-ready.
- **Verdict:** Sound and reversible: preserves useful results without hiding
  individual failures. **Confidence:** Medium.

### Sound — medium confidence

- **Choice:** An explicit CLI batch destination is a new directory. Ordered names
  keep repeated timestamps distinct. An existing directory is refused without
  modifying its contents; callers polling a partly ready batch use a fresh
  destination or request remaining images individually.
- **Gap:** The spec did not choose multi-image output layout or collision behavior.
- **Reach:** Prevents accidental replacement while keeping the existing shared
  single-image transfer path and temporary-directory default.
- **Verdict:** Sound and reversible. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Consume each ready image in order through the existing byte reader,
  release its held cache read, and continue after individual transfer/write errors.
  Duplicate timestamps reuse one frame job but remain separate response items.
- **Gap:** Batch execution and transfer lifetime were not specified.
- **Reach:** No batch queue, new worker, or second transfer owner; each request
  resolves one revision before admitting any of its images.
- **Verdict:** Sound: reuses the existing bounded owners. **Confidence:** High.

## Sparse-frame cursor evidence

### Sound — medium confidence

- **Choice:** A future decoded image may veto an old cursor path but never advance
  cursor time. At requested second 1.5, if the nearest image is from second 2,
  compare it with the last available image at or before 1.5. Compatible pixels and
  pause/geometry evidence allow only gestures through 1.5. A changed screen
  produces an explicitly empty eligible overlay; it cannot borrow a later pointer.
- **Gap:** Nearest video selection and requested-time pointing diverge on sparse
  sources; their compatibility rule was unspecified.
- **Reach:** Local and global consumers share one scene comparison policy. A
  missing past reference is unavailable evidence, not a silent clean fallback.
  Endpoint comparison stays bounded even across long video gaps.
- **Verdict:** Sound as the implementation rule; rendering acceptance remains
  required. **Confidence:** Medium.

## Geometry evidence and delayed source timing

### Sound — high confidence

- **Choice:** Add derived geometry indexes and bounded predecessor/range reads to
  the existing source index. A caller can find the last observed pointer even if
  it was outside the recording, instead of reviving an older inside point.
  Unplaced geometry remains explicitly untimed. Oversized reset lists fail rather
  than silently dropping boundaries.
- **Gap:** Trail planning needed indexed context beyond raw cursor pages.
- **Reach:** Two geometry indexes support these reads without scanning unrelated
  cursor/audio history; no original data or clock mapping is rewritten.
- **Verdict:** Sound: one evidence owner with bounded reads. **Confidence:** High.

### Sound — high confidence

- **Choice:** Confirm an untimed geometry epoch when a usable frame later supplies
  source time. A window resized while paused keeps its raw untimed observation;
  the first eligible resumed frame records its placement under the same epoch.
  No invented geometry change or retrospective timestamp replaces the observation.
- **Gap:** Unchanged geometry after pause or before first video had no later
  placement, because only changed geometry triggered a journal record.
- **Reach:** Geometry records can outnumber epochs. Consumers distinguish a
  confirmation from a reset and never assume delivery order is occurrence order.
- **Verdict:** Sound: the native acquisition owner supplies the missing evidence.
  **Confidence:** High.

### Sound — high confidence

- **Choice:** Use a native pausePlaced record when delayed source zero makes an
  earlier pause placeable. If a valid frame from before a pause arrives after
  resume, keep that media and append the real pause marker once. This record
  leaves any currently open pause intact; it is not another resume operation.
- **Gap:** An earlier pauseEnded could not supply source time before source zero
  existed, leaving media timing without its explanatory pause marker.
- **Reach:** Adds one internal journal event; normalized pause shape stays the same.
  The capture clock owns placement and export remains streaming. Wholly pre-origin
  pauses remain raw controls rather than invented media intervals.
- **Verdict:** Sound: preserves valid video and truthful timeline placeholders.
  **Confidence:** High.

## Requested-time trail planning and delivery

### Sound — medium confidence

- **When:** Core trail planner and public frame integration.
- **Choice:** A stationary pointer does not expire merely because its last sample
  is old. If the pointer was last observed before the requested trail window, compare
  the old and current screen endpoints and check intervening known pauses and
  geometry changes. Matching endpoints permit the old position with its original
  observation time; they do not claim every intermediate screen was identical.
- **Gap:** The plan specified honest cursor history without an age cutoff or a
  method for checking distant pointer evidence.
- **Reach:** Work stays bounded over long quiet periods. A transient change and
  return can escape sampled endpoint comparison; metadata preserves that limitation.
- **Verdict:** Sound provisional evidence policy, with explicit sampled coverage.
  **Confidence:** Medium.

### Sound — medium confidence

- **When:** Core trail planner and public frame integration.
- **Choice:** A window move resets its old path but may retain new pointing over
  a held image when the output pixels have unchanged dimensions and placement.
  A resize or changed scaling cannot reuse mismatched coordinates. A point exactly
  at a pause boundary is omitted because buffered journal delivery cannot prove
  whether it happened before or after the pause.
- **Gap:** Raw placement changes and equal-time controls did not fully define
  eligibility over sparse images.
- **Reach:** Native coordinates remain authoritative. No guessed clock conversion
  or coordinate remapping hides uncertain acquisition evidence.
- **Verdict:** Sound: preserves supported pointing while rejecting ambiguous resets.
  **Confidence:** Medium.

### Sound — medium confidence

- **When:** Core trail planner.
- **Choice:** A frame request fails explicitly when its bounded evidence exceeds
  5,000 raw observations or 1,200 retained rendering points. It never silently
  drops the middle of a gesture to fit a budget.
- **Gap:** The ten-second request limit did not bound unusually dense journals.
- **Reach:** Memory and native payload work stay bounded; callers can shorten the
  requested trail after a limit error. These limits can be tuned without changing
  the no-silent-truncation rule.
- **Verdict:** Sound and reversible operational bounds. **Confidence:** Medium.

### Sound — high confidence

- **When:** Public frame/audio integration.
- **Choice:** Inspecting a newly recorded take admits that take's first source
  preparation before older history that has not entered the queue. It waits behind
  work already running or admitted; failed preparation still requires explicit retry.
- **Gap:** One-at-a-time historical backfill left a current inspection waiting
  behind every older recording unless demand named its source explicitly.
- **Reach:** Frames and audio share existing idempotent preparation and queue
  fairness, without another queue or automatic failure loop.
- **Verdict:** Sound: useful demand makes progress without changing retry promises.
  **Confidence:** High.

### Sound — high confidence

- **When:** Default frame integration.
- **Choice:** Public image metadata carries evidence identity, measured coverage,
  cutoff reasons and pointer timing, while raw RGB samples and complete rendering
  point lists stay internal. A native receipt must confirm the planned selected
  frame and overlay, even when no eligible point remains.
- **Gap:** The plan required inspectable provenance without choosing its response
  size or how to detect disagreement between planning and native rendering.
- **Reach:** CLI/MCP share one compact projection. A mismatch fails rather than
  publishing misleading pixels; raw cursor history stays available separately.
- **Verdict:** Sound: bounded responses with explicit evidence and honest failure.
  **Confidence:** High.

## Shared visual observation reuse

### Sound — medium confidence

- **When:** Observation reuse pass.
- **Choice:** Cache complete bounded native batches by finalized source path,
  exact selection bounds, request times and policy. Two overlapping batches may
  keep duplicate small images; there is no separate file/index per video frame.
  Moving the library causes a cache miss rather than guessing that paths still match.
- **Gap:** The plan required policy-bound observation reuse without choosing its
  storage unit or lookup identity.
- **Reach:** Local and global consumers reuse one sampler. Exact bounds prevent a
  cut or past-only request from borrowing a future image. Batch storage keeps the
  mechanism small; per-frame deduplication remains unnecessary until measured.
- **Verdict:** Sound and reversible: correctness before maximum cache hit rate.
  **Confidence:** Medium.

### Sound — high confidence

- **When:** Observation reuse pass.
- **Choice:** A cache lookup row belongs to its disposable file through a database
  foreign key with cascading deletion. Removing an old file automatically removes
  its lookup; repeated novel requests cannot leave dead rows forever. Concurrent
  requests may decode the same miss, then retain one publication and delete the loser.
- **Gap:** The cache contract did not specify lookup cleanup or concurrent miss handling.
- **Reach:** Existing byte accounting, reconciliation and worker lanes stay in charge.
  Retained scene/index evidence remains outside this disposable lifetime.
- **Verdict:** Sound: platform-owned cleanup without another queue or periodic sweeper.
  **Confidence:** High.

## Durable canonical scenes

### Sound — medium confidence

- **When:** Canonical scene scan integration.
- **Choice:** Whole-source analysis runs as one heavy artifact job with bounded
  ten-second decoding calls. A local frame can use its independent frame lane;
  heavy work already running completes before the next heavy request starts.
  Background discovery admits one scene job, not the entire recording history.
- **Gap:** The plan fixed worker limits without specifying scan admission granularity.
- **Reach:** No second queue or chunk-job dependency graph is introduced. A long
  source scan can delay another heavy request; source chunking bounds memory but
  does not imply preemption of the heavy lane.
- **Verdict:** Sound within the specified single-heavy-job contract; measure long
  native scans before deciding whether cooperative rescheduling is warranted.
  **Confidence:** Medium.

### Sound — high confidence

- **When:** Durable scene store and scan integration.
- **Choice:** Retain one bounded report per canonical chunk plus a generation row
  tracking complete coverage. If a future frame is first selected early, its
  comparison stays at its real video time. Overlapping chunks share a predecessor;
  duplicate comparison pairs are removed while requested-image coverage stays exact.
- **Gap:** Local trail boundary clipping cannot be concatenated into global evidence.
- **Reach:** Screenshot selection and packages can consume durable actual-time
  evidence without rescanning or inventing a second scene detector.
- **Verdict:** Sound: one measurement policy and explicit timing provenance.
  **Confidence:** High.

### Sound — high confidence

- **When:** Durable scene store and scan integration.
- **Choice:** Deleting a partial generation first makes it unreadable, then removes
  bounded batches of rows. A crash during cleanup leaves its identity available
  for the next cleanup pass. Queue publication alone makes a completed scan ready.
- **Gap:** Yielding cleanup must not expose a partly deleted result as complete.
- **Reach:** Startup can reclaim abandoned attempts while preserving active and
  published evidence. Internal deletion state is not another public readiness state.
- **Verdict:** Sound: bounded cleanup and atomic visibility without whole-scan buffers.
  **Confidence:** High.
## Public trail boundary fixture — 2026-09-16

- **Choice:** Reuse the generated page/journal fixture with a denser encoding only
  for cut comparisons. A cut can remove the only frame before the requested
  moment in the sparse video; inserting regular encoded frames lets this test
  judge retained pointing while the original sparse case still judges held frames.
  **Gap:** The plan names cut coverage without prescribing fixture cadence.
  **Reach:** Future cut tests must include a real retained frame when claiming
  successful annotation. **Verdict:** sound; it isolates cut behavior without
  relaxing missing-frame handling. **Confidence:** high.
- **Choice:** Induce retryable source failure by withholding write permission on
  the test's derivative directory. Once repaired, a frame request must still show
  the failure until the caller retries source processing. A malformed journal is
  rejected permanently and would test a different contract.
  **Gap:** The plan specifies explicit source retry without selecting a failure.
  **Reach:** The macOS integration test requires an ordinary non-root account
  whose filesystem enforces directory permissions. **Verdict:** sound; this tests
  a real storage failure and leaves the source journal intact. **Confidence:** high.

## Screenshot selection and retained production — 2026-09-16

### Sound — medium confidence

- **Choice:** Merge separate bounded evidence streams even though a static recording
  may require a linear scan before its first selection event. For a thirty-minute
  still screen, the adapter searches the chunked scene reports for the next boundary
  while keeping only one pending event per stream. An extra stored boundary index
  could shorten that startup, but would add another durable representation to maintain.
  **Gap:** The plan specified bounded memory without selecting the merge access plan.
  **Reach:** Memory remains bounded; startup reads are not claimed constant-time.
  **Verdict:** Sound for the measured baseline, with foreground latency retained as
  a public integration gate. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Delay candidate emission while an earlier cursor endpoint is unresolved.
  When movement stops just before a coverage screenshot is due, the selector waits
  for observed stillness or a bounded acquisition gap before emitting the later image.
  The gap is labeled missing acquisition, not proof that the cursor stood still.
  Reusing an older image for spacing also preserves any intervening uncertainty.
  **Gap:** Idle confirmation and coverage timing can otherwise reverse output order
  or falsely label changing content as equal. **Reach:** Retained rows remain ordered
  and static-image reuse keeps its evidence limitations. **Verdict:** Sound; uncertainty
  is preserved rather than repaired by sorting or invented observations.
  **Confidence:** High.

- **Choice:** Store coverage separately from selected images and keep a coverage count
  on each image row. A long static segment can reuse one screenshot for many time
  windows; listing that image stays bounded, while the caller pages through its
  coverage separately. **Gap:** One image can have an unbounded number of supporting
  intervals. **Reach:** Public listing and package readers must expose paged coverage,
  not embed the entire interval history in each image. **Verdict:** Sound; both reads
  and storage updates have explicit bounds. **Confidence:** High.

- **Choice:** An open retained-image read keeps its file descriptor until delivery
  releases it. If cleanup unlinks the image meanwhile, an already-started delivery
  can finish from that descriptor. Cleanup continues through unrelated generations
  after a failure and reports a bounded error. **Gap:** The plan required cleanup and
  byte delivery without defining their overlap. **Reach:** Delivery can reuse the
  existing lease lifecycle without copying files or blocking all cleanup.
  **Verdict:** Sound for the local filesystem contract. **Confidence:** High.

- **Choice:** Count a canceled index as occupying the background slot until its
  executor exits. If decoding is still stopping, a new index receives a retryable
  admission limit while foreground work can use the remaining slot. Releasing the
  reservation at the cancel request would allow two decoders to overlap and consume
  both slots. **Gap:** Durable job state alone cannot represent a closing executor.
  **Reach:** The queue exposes active artifact ownership; index admission uses it
  alongside queued/running rows. **Verdict:** Sound; capacity follows actual resource
  lifetime. **Confidence:** High.

## Public retained index — 2026-09-16

### Sound — high confidence

- **Choice:** A continuation carries the recording, edit revision and completed
  processing generation. When the user edits between pages, omitting a new revision
  continues the old page; explicitly asking for a conflicting revision is rejected.
  Coverage continuations also carry the selected-image filter. A selected image can
  be read only when that exact generation was published by the job queue, even if
  its files were fully written before a crash. **Gap:** The plan required pinned
  pagination without fixing its public reference shape. **Reach:** CLI, MCP and
  later package readers can preserve stable references across edits without mixing
  evidence from different runs. **Verdict:** Sound; identity is explicit at every
  page and image boundary. **Confidence:** High.

- **Choice:** Byte delivery accepts an acquisition callback from the file's owner.
  A retained PNG and a disposable cached frame therefore share expiry, chunk reads
  and release behavior. The callback runs only after delivery capacity is available;
  a refused request never opens a file that then needs cleaning up.
  **Gap:** Delivery originally assumed every image belonged to the cache.
  **Reach:** Retained and future exported media can reuse the bounded transport
  without being mislabeled as disposable cache entries or creating another transport.
  **Verdict:** Sound; storage ownership stays separate from byte transfer.
  **Confidence:** High.

## Index workload and before-event images — 2026-09-16

### Sound — high confidence

- **Choice:** Reuse native observations by requested timestamp while retaining
  bounded batch files. When two trail windows overlap, lookups point to the already
  decoded slots and only missing timestamps reach native decoding. Source path,
  exact kept bounds and policy still distinguish requests: a before-event prefix
  must not borrow a future frame selected with wider bounds. Concurrent overlap
  retains the first publication for shared keys; empty losing files are removed.
  **Gap:** The long-source workload exposed repeated decoding hidden by whole-batch
  matching. **Reach:** This supersedes that earlier lookup decision; batch storage,
  LRU accounting and cascading lookup cleanup remain. Old disposable lookup rows are
  dropped, while their files stay accounted until ordinary eviction.
  **Verdict:** Sound; bounded reuse reduces measured repetition without changing
  selection or adding another cache. **Confidence:** High.

- **Choice:** Keep a before-event image request immediately before the event, but
  forbid the decoder from choosing a sample at or after it. For example, requesting
  2.999999 seconds before a page change at 3 seconds now selects the preceding frame
  at 2.75 seconds, even though the new page is nearer. The delivered metadata keeps
  the revision's span and names the extra selection ceiling separately.
  **Gap:** A timestamp on the earlier side does not guarantee nearest-frame decoding
  returns an earlier image. **Reach:** Annotation planning and image decoding share
  the same ceiling, so their receipts agree and callers can inspect both states.
  **Verdict:** Sound; it fixes the actual earlier-side contract without inventing
  cursor timing or changing arbitrary-frame requests. **Confidence:** High.

## Sampled stillness — 2026-09-16

### Sound — medium confidence

- **Choice:** Allow each low-resolution RGB channel to vary by at most two integer
  levels across an entire stillness run. A compressed recording of an unchanged
  page can oscillate by one or two levels, so demanding exact equality produced
  redundant images. Allowing a fresh small difference at each step would instead
  hide slow cumulative changes. The source-wide minimum/maximum stops that drift:
  a third level starts a new run, even across processing chunks. Genuine changes
  confined to two levels can still collapse; original media and timestamp requests
  remain available. **Gap:** The plan did not define tolerance for codec rounding.
  **Reach:** Only ordinary sampled coverage can collapse; mandatory events survive.
  **Verdict:** Sound; bounded loss is explicit and the unchanged encoded fixture
  supplies the measured allowance. **Confidence:** Medium.

### Sound — high confidence

- **Choice:** Persist the stillness run's start with existing scene coverage, while
  keeping channel minima/maxima only in the active source scan. After failure the
  scan restarts from zero, reconstructing the same run rather than resuming without
  its earlier bounds. **Gap:** A cross-chunk proof needs an owner and restart rule.
  **Reach:** Selection consumes one canonical proof without another RGB table or
  checkpoint format. Policy identities invalidate earlier derived evidence.
  **Verdict:** Sound; it matches the existing restart behavior and bounds memory.
  **Confidence:** High.

## Long-source measurement and deletion planning — 2026-09-16

### Sound — high confidence

- **Choice:** Keep the native thirty-minute benchmark outside ordinary tests and
  persist a bounded progress report while it runs. If a long run fails, already
  measured foreground latency and completed image counts remain inspectable.
  Input and bundle hashes distinguish comparable recordings and executables; the
  supplied recording is copied, never changed. **Gap:** The partial baseline lost
  its in-memory latency result and was not reproducible through a project command.
  **Reach:** Future performance changes have a repeatable full-workload gate.
  **Verdict:** Sound; this adds measurement, not a weaker acceptance threshold.
  **Confidence:** High.

- **Choice:** Plan deletion around one durable intent marker and existing resource
  owners. A delete first hides the recording, then waits for its producers and
  releases its readers before removing files; after a crash it repeats those
  idempotent steps. There is no deletion artifact job inside the queue being
  canceled. **Gap:** The original delete requirement did not specify concurrent
  capture, reads or restart behavior. **Reach:** Storage and lifetime owners gain
  per-record operations without a second queue or phase journal. **Verdict:** Sound;
  successful deletion must mean no owner can recreate or continue serving the data.
  **Confidence:** High. Implementation and its lifetime proof remain pending.

## Per-record cache cleanup — 2026-09-16

### Sound — high confidence

- **Choice:** Run cache purge through the existing publication order. If a frame
  publication was already queued when deletion began, it settles before purge
  removes that recording's reservations. A later publisher finds no reservation
  and cannot recreate it. Cleanup yields between batches, so other recordings can
  still be read, although their new publications wait behind the purge.
  **Gap:** The plan required safe cleanup without specifying its ordering primitive.
  **Reach:** One existing owner controls publication and removal, with no additional
  deletion lock or queue. **Verdict:** Sound; the recording is fenced and producers
  stopped before this bounded cleanup begins. **Confidence:** High.

## Index measurement deadline — 2026-09-16

### Sound — medium confidence

- **Choice:** Permit the full thirty-minute-input benchmark to run for up to
  forty-five minutes before failing its safety guard. The earlier thirty-minute
  guard came from a temporary probe; the product spec sets no index wall-time SLA.
  The partial run suggests the complete measurement may take longer than that
  guard, so keeping it would cut off the evidence needed to judge performance.
  **Gap:** The spec requires elapsed-time measurement but does not specify the
  harness termination deadline. **Reach:** Reports still expose the actual runtime,
  and completion still requires every image, bounded paging and process cleanup.
  **Verdict:** Sound; this bounds a measurement without declaring its speed acceptable.
  **Confidence:** Medium.

### Managed file deletion and live usage (storage/deletion integration)

- **Choice:** Usage is a live scan with an explicit uncategorized owned-byte total.
  A file created while the scan is running may be missed; callers can ask again.
  A file under a recording that is neither source, evidence nor cache still counts
  under `otherBytes`, so it does not disappear from the recording's total.
- **Gap:** The plan specified live observation but did not name an owned category
  for miscellaneous files or define concurrent directory-rename omissions.
- **Reach:** The operation does not freeze recording, snapshot the filesystem, or
  maintain a second byte-accounting database. Kernel no-symlink file opens prevent
  measuring files reached through external links; totals are not an atomic snapshot.
- **Verdict:** sound; complete categories and explicit live semantics match ongoing
  capture and cleanup. **Confidence:** medium.


- **Choice:** Native directory handles anchor removal. If another process replaces
  a recording folder with a link while deletion runs, deletion continues only
  through the directory already opened and verified. The alternative—checking a
  name and later asking Node to remove that name—can resolve to different files.
  Decimal strings preserve exact filesystem identities across the JSON boundary.
- **Gap:** The plan required contained removal but did not select the filesystem
  mechanism. A reproduced directory swap made the path-based implementation unsafe.
- **Reach:** Cache ownership stays in core; the existing short-lived native worker
  receives bounded file identities. No resident process or dependency is added.
- **Verdict:** sound; removal is tied to the verified directory rather than its
  replaceable name. **Confidence:** high.


## Shared in-flight storage observations — 2026-09-16

- **Choice:** Requests for the same recording, or for the aggregate library, share
  that scope's running storage scan. If a client times out and asks again, it joins
  the work already reading the disk. Completion or failure releases the scope;
  the next request measures again. A different recording can still be inspected.
- **Gap:** Live-scan semantics did not specify repeated calls while a slow scan
  outlives its transport response. UI refresh exposed that overlapping calls could
  keep starting duplicate traversals whose original replies had been abandoned.
- **Reach:** The existing storage owner's active-operation collection also owns
  joining; shutdown still waits for actual observations. No result cache, durable
  scanner, timer, or second job owner is introduced.
- **Verdict:** sound; a shared observation has the same documented live semantics
  while bounding duplicate work. **Confidence:** high. Held-file and failure/retry
  regressions verify independent-scope progress and fresh reads after settlement.

## Recent recording storage controls — 2026-09-16

- **Choice:** The menu shows one aggregate recording-storage observation with its
  scan time, instead of scanning every recent recording whenever the clock ticks.
  Opening the menu, an explicit refresh, or a completed action requests another
  observation. A separate task keeps capture status responsive during the scan.
  **Gap:** Slice 07 requested a storage total without specifying refresh cadence
  or per-record breakdowns. **Reach:** The service owns classification; the UI
  retains a dated observation and shows failures without inventing zero bytes.
  **Verdict:** sound, medium confidence; native visual review remains open.
- **Choice:** A deletion requested from the menu keeps its explicit ID visible
  through pending or failed cleanup, even after ordinary discovery hides the take.
  Retry uses the same ID. The presentation lasts only for this app session;
  durable restart cleanup remains the catalog's job. The deliberate Delete action
  needs no extra confirmation dialog. **Gap:** Service intent hides discovery
  before cleanup finishes, which otherwise removes the person's retry control.
  **Reach:** No persisted UI deletion registry, implicit latest target, or second
  deletion owner is introduced. **Verdict:** sound, high confidence.
- **Choice:** A storage result updates compatible native menu items in place.
  Compatibility includes nested action IDs, so changing the recording or source
  replaces the relevant menu instead of retargeting an old action object.
  **Gap:** The original renderer rebuilt all rows for a changed observation and
  could remove an unrelated open submenu. **Reach:** The existing last-rendered
  entries remain the comparison owner; actual NSMenu identity has a focused
  regression separate from the visual gate. **Verdict:** sound, high confidence.

## Opaque video empty-edit appearance — 2026-09-16

- **Choice:** Render proven empty video edits as opaque black in H.264 MP4,
  matching the measured default AVPlayerView appearance. Held source images use
  proven sample support; unknown support fails. **Gap:** A no-display reference
  does not itself choose an opaque pixel value, and passthrough edit lists lose
  trailing empties and produce incompatible decoding behavior. **Reach:** Only
  rendered opaque video changes representation; original media, package gaps and
  the stricter still-image contract remain intact. **Evidence:** Owned-window
  captures and independent decoder receipts in the
  [video checkpoint](assets/video-render/review.md). **Verdict:** sound, high
  confidence for the measured standard-player/opaque-MP4 contract; other player
  backgrounds are not claimed equivalent.
- **Choice:** Give each encoded sample its retained duration as well as its
  presentation time. **Gap:** Timestamp-only append with an explicit session end
  can report the right asset duration while producing a shorter final sample.
  **Reach:** One sequential native owner uses the core's exact plan, a bounded
  pixel pool and the shared orientation/segment mapping. It publishes exclusively
  after completion. **Verdict:** sound, high confidence from fractional,
  one-microsecond and trailing-gap independent decoding; job cancellation and
  abandoned staging reclamation remain explicit follow-on gates.


## Portable snapshot and inspection ownership — 14a, 2026-09-17

- **History belongs to admission time, independently of the chosen edit.** A user
  can export r0 after making r1 and r2. The snapshot includes the history already
  known at that moment, while still identifying r0 as the exported view; an r3
  created afterward does not appear midway through history paging. The original
  export contract did not choose this boundary for historical exports. The 14
  reslice chose it, and one catalog transaction now pins both values. This enables
  stable audit history without silently changing the chosen media edit.
  **Verdict:** sound; **confidence:** high. No alternate timeline or history store.
- **Package lifetime differs from its embedded recording ID.** Opening a moved
  package must remain usable if the original library recording is deleted, even
  though both carry the same UUID. The reslice therefore assigns future package
  workers, caches and delivery handles to a package context rather than the live
  recording's lifetime. Current 14a preserves provenance only; the actual isolated
  handle lifetime remains 14c work. The contract promised relocation but did not
  previously name this collision. **Verdict:** sound; **confidence:** high. Future
  integration must extend existing resource owners, never invent library rows.
- **Reported readiness cannot certify unimplemented transcript payloads.** A test
  can report that a speech job is ready so dependency planning can be exercised.
  That report cannot validate transcript contents or turn synthetic fixtures into
  accepted speech. The structural validator therefore rejects all narrated complete
  manifests until the accepted 08 validator exists; non-narration metadata remains
  inspectable internally. This makes the missing production owner explicit instead
  of providing a permissive callback. **Verdict:** sound; **confidence:** high.

Implementation discretion: the existing pinned Zod version is now an explicit core
dependency for strict schemas; timeline constructors remain the semantic owner.
Canonical source filenames, ASCII inventory names, explicit caller-provided byte/
entry/history/path limits and separate bounded revision JSON are internal format
choices delegated by 14a. They do not alter destination names or add a public format.

## Retained audio stream ownership — 2026-09-17

- **Choice:** One finite PCM stream exposes resolved output format and exact frame
  count before consumption, then awaits a consumer for every bounded block. The
  excerpt WAVE writer uses it directly. **Gap:** Whole-output allocation could not
  support movie duration, and a future encoder must not rebuild format policy or
  quantization from track reports. **Reach:** Converter state survives block
  boundaries; edits and acquisition intervals remain reset boundaries. No parallel
  mixer, process, queue or public long-excerpt route is added. **Verdict:** sound,
  high confidence from 25 byte-exact baseline comparisons and five-minute memory,
  frame-count and failure evidence in the [stream report](assets/streaming-audio/review.md).
- **Choice:** Keep the public thirty-second excerpt limit while the shared native
  stream accepts longer validated timelines. Samples are interleaved Float32 with
  explicit mono/stereo layout and valid block lengths. **Gap:** The old allocation
  bound and the user-facing inspection bound had coincided. **Reach:** Internal
  long WAVE output is a verification consumer; AAC, muxing, durable publication and
  speech audition remain parent work. **Verdict:** sound, high confidence for the
  numerical seam; no audible speech-quality claim is made.

## AAC movie feasibility — 2026-09-17

### Sound — medium confidence

- **Preserve arbitrary cuts in native playback and document tiny AAC decoder
  differences.** A 20 µs movie plays to exactly that endpoint in the
  native player and retains a nonzero audio sample, while FFmpeg returns no audio.
  The probe records both outcomes instead of choosing a minimum cut length or
  silently dropping audio. The plan did not define identical raw decoder arrays
  as a product promise. Native presentation is the provisional personal-release playback
  contract, so production integration can proceed with this decoder difference
  documented for the later export/consumer contract. This checkpoint keeps the
  candidate in the optional probe until that next integration pass; no public
  movie operation is added here.

- **Use 96 kb/s per channel for the AAC feasibility fixture.** The PCM format and
  mix stay those already resolved by the shared stream; only the compression
  budget is selected here. The plan specified AAC but not a bitrate. This gives
  the generated comparison a reproducible setting, not a claim that speech quality
  is accepted. Production adoption must accompany the remaining audition gate;
  changing this number does not change edits or input sample counts.

### Sound — high confidence

- **Assemble rendered H.264 and streamed PCM in one final writer.** After video
  rendering, the candidate copies its compressed frames while encoding audio.
  Each pump holds one block and waits for the writer. The plan left multiplexing
  unspecified; separately encoding AAC and exporting an AVFoundation composition
  produced a measurable priming shift. The candidate needs intermediate compressed
  video disk space, but does not add a video decode/re-encode pass, another mixer,
  edit interpreter, or process owner. Production integration must reuse the
  existing service attempt lifetime for that intermediate file.

- **Choose a movie clock that represents both microseconds and audio samples.**
  At 48 kHz, one sample lasts 20.833… µs. A clock with six million ticks per second
  can represent both boundaries exactly; a million-tick clock rounded one audio
  edit upward and exposed an extra decoded sample. The plan specified both clocks
  but not their container representation. The candidate uses their least common
  multiple and explicitly refuses an unrepresentable timescale. It preserves
  existing PCM rounding and exact video timing instead of inventing another cut
  or resampling policy.


## Full-revision acquisition planning

- **When:** shared retained-audio planning pass after 13c feasibility.
- **Choice:** keep excerpt limits at the excerpt boundary. If an agent removes
  one thousand small ranges in one allowed edit, the movie may have one thousand
  and one remaining pieces. Planning those pieces uses the same recorded-audio
  evidence as a short excerpt, with a bounded ten-thousand-interval movie budget;
  the excerpt keeps its existing smaller budget. Native streaming uses the same
  larger bound and scans ordered acquisition intervals monotonically. A movie with neither acquired
  track gets explicit absent-track reasons and remains silent, while requesting
  an audio-only excerpt still reports unavailable.
- **Gap:** the original excerpt planner combined acquisition truth with limits
  intended for short inspection requests. The native video plan already accepts
  up to ten thousand retained spans, but the audio defaults originated in excerpts.
- **Reach:** full-movie callers inherit one acquisition policy. This does not
  eliminate the source reader's per-range budget or certify arbitrary fragmented
  exports; paged execution remains necessary beyond current bounded plans.
- **Verdict:** sound, medium confidence. Separating request limits prevents a valid
  ordinary edit batch from accidentally inheriting the excerpt restriction,
  without dropping tracks or widening the public excerpt API.

## Movie presentation evidence — 2026-09-17

- **Stream one clean picture per supported interval.** When a recording holds one
  picture while the cursor moves, native exports that picture's supported time
  interval once; later core work can answer many cursor moments without launching
  a worker for each one. JSONL means one independently bounded JSON record per
  line. The caller supplies a total byte budget, and success publishes only the
  finished file. **Gap:** the native-to-core transport was unspecified.
  **Reach:** movie planning must stream or index these records, not load the whole
  file. **Verdict: sound, medium confidence** — bounded storage trades a second
  sequential decode and temporary disk for independent policy planning.
- **Preserve exact fractions at frame boundaries.** A 30 fps picture ends between
  whole microseconds. Rounding that boundary can assign a nearby cursor moment to
  the wrong picture. Records preserve the native clock numerator as a decimal
  string and its integer timescale, while the familiar rounded sample timestamp
  remains descriptive metadata. **Gap:** exact transport encoding was unspecified.
  **Reach:** the future reader must compare exact fractions for membership; it
  cannot treat the rounded sample timestamp as the interval start.
  **Verdict: sound, high confidence** — preserves the renderer's proven timing.

## Movie worker and attempt promotion — 2026-09-17

### Sound — high confidence

- **Share one render-attempt lifetime across video and movies.** When a caller
  supplies resolved audio tracks, the existing attempt owner asks the same native
  worker for a movie; without tracks, it keeps the real video-only path. Both
  return through the same cancellation and cleanup boundary. The plan did not
  specify the service API shape. This avoids two cleanup wrappers that could
  disagree about when a child has stopped or when a consumer may use its file.
  The renamed `withRenderedMedia` replaces the old helper rather than keeping an
  alias. Acquisition decisions stay in the core planner.

- **Observe SDK finalization through internal callbacks, not worker test flags.**
  The native lifetime test must cancel after `finishWriting` has actually started,
  rather than guess from an elapsed delay. An optional internal callback observes
  that boundary; a second injects a named pump error after a real compressed sample
  append. Neither is accepted from JSON or the environment, and the optional test
  target imports the production owner instead of copying it. The plan required
  terminal-behavior proof but left the test seam unspecified. This keeps the
  production process protocol unchanged while exposing the narrow native lifetime
  events the tests need.

- **Budget sequential movie work in its own call deadline.** A movie first decodes
  through the last kept source position, then assembles retained audio. Its bounded
  deadline adds retained playback time to the existing video budget, still capped
  to a safe platform timer. The plan did not give a movie timeout formula. This
  respects the actual two phases without raising deadlines for unrelated native
  calls or introducing another watchdog owner.

## Presentation point inspection — 2026-09-17

- **Validate once, then use independent forward cursors.** Before inspection starts,
  the reader checks that the entire native file covers the pinned cuts. A cursor
  then walks forward through that file while keeping only its current picture;
  a second cursor can independently find the picture under an earlier pointer.
  Backwards queries fail instead of quietly scanning the recording again.
  **Gap:** the bounded lookup strategy was unspecified. **Reach:** sequential
  movie work can inspect long recordings without retaining every raster, at the
  cost of a validation read and separate forward reads. **Verdict: sound, medium
  confidence** — an explicit sequential API fits the next movie consumer; random
  access would need a separately justified index.
- **Empty presentation does not carry a pointer.** When native proves that an
  interval has no source picture, point inspection reports that state directly.
  A pointer observation from that empty interval cannot reappear over the next
  picture. **Gap:** pointer behavior over explicit empty edits was unspecified.
  **Reach:** future movie planning must preserve this state instead of treating
  missing pixels as valid black scene evidence. **Verdict: sound, medium
  confidence; provisional for final video composition** — there is no captured
  surface to attach pointing evidence to. Revisit only with an explicit product
  decision and its own composition test.

## Encoded movie scale proof — 2026-09-17

### Sound — high confidence

- **Compare encoded clocks, independent signals and retained PCM separately.**
  A movie and its reference can agree because they share the same mistake. The
  long proof therefore also checks the known generated signal phase and gain,
  exact video presentation timestamps and source-frame identities. AAC padding
  is counted separately from its presented samples. The scale plan did not specify
  this oracle layout. It makes the timing claim stronger without inventing a
  bit-exact lossy codec contract or claiming physical listening/device behavior.

- **Keep the full-duration lossless reference in the optional audio test target.**
  To check five minutes of encoded audio around fractional cuts, the test needs
  the shared stream's complete sample clock. It drains `AudioPCMStream` through
  the existing WAVE sink rather than splitting the reference into excerpts whose
  outer boundaries could round differently. The plan did not specify reference
  generation. This adds only a test-mode entry point; the production excerpt API
  and its thirty-second limit are unchanged.

## Preview publication — 2026-09-17

### Sound — high confidence

- **Use the existing disposable cache for preview movies.** Preview completion
  publishes the cache file before the existing job publishes its metadata. A crash
  between those commits can leave an unused cached movie, which normal LRU can
  reclaim; it cannot make a partial movie ready. The plan did not choose the
  publication transaction layout. This follows existing frame/audio ownership
  without another table or commit log. Interrupted native staging has a separate
  lifetime and must be proven before public integration.

## Browser text fidelity checkpoint

- **Keep AVFoundation automatic H.264 bitrate.** The spec delegates encoder
  settings subject to readable text and timing. Three bitrate-only settings were
  compared against the same real captured browser sources. The largest slightly
  improves source-distance and adds roughly 5% bytes; unprimed review sees no
  meaningful full-frame readability advantage. That does not justify a new
  global bitrate rule. The smaller settings lose detail. The complete
  [comparison and limitations](assets/text-fidelity/README.md) retain all variants.
- **Keep capture-tail authority separate from text testing.** A measured 121 µs
  stop/container mismatch refuses a full-original render. Use an explicit
  interior revision only for this controlled comparison; do not clamp production
  plans or claim public full-original preview is ready.

## Sequential pointer schedule — 2026-09-17

- **Bound source work separately from output size.** A million stationary cursor
  observations can produce a tiny schedule but still consume substantial work.
  The caller therefore supplies both a visited-event budget and an output-byte
  budget. Each kept span seeks directly into the existing source index; deleted
  prefixes do not consume the event budget. **Gap:** work admission was unspecified.
  **Reach:** the preview/export owner must set both budgets from its pinned inputs.
  **Verdict: sound, high confidence** — compact output cannot hide unbounded work.
- **Compress unchanged glyphs without losing fresh pointing evidence.** A stationary
  cursor's new observations still refresh eligibility, but the schedule emits only
  coordinate/visibility changes and each span's initial state. Native draws the
  supplied state without adding its own age rule. **Gap:** output compaction was
  unspecified. **Reach:** avoids encoding redundant frames when only an observation's
  timestamp changed. **Verdict: sound, high confidence** — human movies have no
  fading trail, so unchanged coordinates draw the same glyph.

## Capture source-duration authority

- **Encode the existing source clock exactly.** Set capture movie/video timebases
  to microseconds instead of letting the container round to its 600 Hz default.
  Actual finalized bytes and recovered support now agree with the published
  revision. The delegated encoder internals allow this precision fix; no source
  duration is silently clamped and no second post-capture timeline is introduced.
  Audio input timebases remain native per the platform contract.
- **Recovery admits only representable supported video ticks.** Fractional legacy
  sample/segment ends round down, since nearest rounding can exceed actual media.
  Existing persisted revisions are not rewritten. The exact failing source and
  generated/actual proofs are in the [duration evidence](assets/capture-duration/README.md).

## Archive workspace and effective names — 2026-09-17

- **Sound; medium confidence:** An encoded ZIP filename may decode to a safe ASCII
  inventory name. Accept that name when every member is enumerated, duplicates are
  rejected and bytes match the manifest. Rejecting every unusual raw encoding would
  require another ZIP parser without improving containment. The OS parser remains
  a dependency, so its runtime version and adversarial alias tests travel together.
- **Sound; high confidence:** A package verification attempt borrows an already-open
  empty private directory from its owner. That parent-held descriptor survives a
  killed decoder and permits cleanup without trusting the old pathname. An advisory
  lock excludes another cooperating owner; it does not pretend to defeat arbitrary
  same-user process tampering. Later package-context provisioning/recovery must
  preserve this lifetime rather than expose a temporary path as authority.
- **Sound; high confidence:** Keep verification metadata inside the existing worker
  reply: cap manifest/revision JSON and the combined receipt, instead of adding a
  resident two-way protocol merely to parse JSON. Limits reject an oversized package
  explicitly. A cleanup failure overrides success and retains both failure messages
  so the caller knows its still-owned workspace needs recovery.

Parser/header selection and numeric policy were delegated by 14c; the owning slice
records them. These choices add no public export choice or transcript readiness.

## CLI media publication — 2026-09-17

### Sound — high confidence

- **Stream file delivery and publish after completion.** Large previews should not
  require a movie-sized memory buffer. Single-media CLI output therefore shares
  chunk validation with inline image/audio content, but writes to temporary staging
  and exclusively links the completed file into place. The plan left the client
  file-publication mechanism unspecified. A failed transfer leaves no partial output
  and never replaces an existing destination. Inline model content keeps its bounded
  buffers; this adds no export format or persistent publication authority.

### 13d4 — Inspect actual timing before opening the encoder

- **Choice:** Walk retained sample metadata and the bounded pointer stream before
  encoding, then consume the pointer stream again through the same open file. A
  source can advertise many clock ticks it never uses. Combining all those unused
  ticks with narration can exceed the movie format's clock limit, even when every
  real transition fits. Actual transition times select a common clock with microsecond edits;
  unrepresentable transitions fail instead of rounding. The second pointer read
  retains only one next state and verifies that the bytes still match the receipt.
- **Gap:** The plan required exact clocks and bounded reads but did not choose how
  native discovers the clock before configuring its encoder.
- **Reach:** Adds a metadata scan and a second sequential schedule read, with no
  extra video decode or encoding pass. Future mux consumers must preserve that clock.
- **Verdict:** Sound; the existing mono-audio regression demonstrated why unused
  container ticks cannot define the required clock.
- **Confidence:** High.

## Render workspace restart ownership

- **Lock the dedicated workspace, not per-attempt PID records.** One heavy render
  lane already owns admission, so a nonblocking exclusive directory lock gives
  one stable lifetime shared with every native child. A dead parent is not proof
  of child termination; inherited directory ownership is. Busy admission fails
  retryably without polling. Startup/deletion admission uses the same locked helper,
  skipping absent workspaces without spawning native work; no scanner or scheduler.
- **Keep cleanup descriptor-relative and writes under an explicit ownership rule.**
  The service keeps its private workspace ancestry stable during path-based
  AVFoundation writes. Cleanup verifies the inherited directory identity and uses
  shared ManagedFiles traversal, preserving replacements and external link targets.
  The lock does not pretend to prevent arbitrary same-user filesystem mutations.
- **Prepare pointer evidence within the existing attempt.** The optional callback
  receives a worker bound to the same lock and signal, finishes all its subprocess
  work, and returns the core schedule receipt. Native pointer consumption is
  integrated from 13d4; no second outer temporary directory or process owner is added.

## Public preview preparation and delivery

- **When:** public preview service/CLI/MCP integration.
- **The choice:** bound intermediate work and fail the whole preview instead of
  silently dropping pointing evidence. Rendering first writes the exact picture
  schedule, then joins cursor observations onto it. Those temporary files may use
  at most 1 GiB and 128 MiB respectively; the join may inspect one million input
  events. For example, a very dense recording can exceed a limit even when its
  final compressed MP4 would be small. The caller receives a failed job, never a
  video that quietly omits the remaining cursor movements. These bounds allow
  headroom above short walkthroughs while keeping temporary disk and CPU work
  finite. Existing byte/event exhaustion checks own the boundary behavior.
- **The gap:** the sequential owners require budgets but the plan did not set
  production admission values.
- **The reach:** longer or unusually dense recordings can require revisiting the
  admission policy. Changing these internal values needs representative workload
  evidence, not an automatic retry with a larger budget.
- **Verdict:** sound; explicit bounded failure preserves evidence fidelity.
- **Confidence:** medium; the values are conservative operational defaults, not a
  measured maximum recording duration guarantee.

- **When:** public preview service/CLI/MCP integration.
- **The choice:** expose playable video over the existing transfer contract. A CLI
  caller gets a streamed MP4 file. An MCP caller gets metadata and a short-lived
  token, then requests bounded pieces with `artifact.read` and releases it with
  `artifact.close`. The token keeps the underlying cache file readable until it
  closes or expires; deleting the recording revokes it. This avoids asking the
  model protocol to accept unsupported inline video content or allocating an entire
  movie in memory. The existing transfer deadline applies equally to previews;
  an expired transfer reports a retryable error rather than a partial success.
- **The gap:** the plan required machine preview access without choosing its MCP
  representation.
- **The reach:** native app playback must establish its own correct lifetime over
  this shared delivery mechanism; the transfer token alone is not an unlimited
  player lease.
- **Verdict:** sound; one bounded delivery owner serves all derived media.
- **Confidence:** high.

- **When:** public preview deletion review.
- **The choice:** deletion waits for the shared render workspace to be safely
  cleared. If another recording's worker still owns that workspace, deletion
  returns a retryable busy error and retains its pending-deletion record instead
  of claiming all bytes are gone. A later retry or startup completes the same
  intent. This uses the existing exclusive owner rather than introducing a second
  per-recording staging tracker.
- **The gap:** the spec required truthful deletion but did not choose how to handle
  a shared workspace occupied by an unrelated render.
- **The reach:** deleting one recording can temporarily wait on another recording's
  preview. No active worker's files are removed to make deletion appear immediate.
- **Verdict:** sound; the finite busy refusal preserves both worker ownership and
  truthful completion without another storage ledger.
- **Confidence:** medium; a future throughput need could justify separate workspaces.

## Native player lifetime: renew the existing cache lease

- **When:** native preview playback preparation after the public preview pass.
- **The choice:** an active player renews the existing delivery token instead of
  downloading a second private movie copy. A lease is the service's promise to
  keep the same cached bytes available until a deadline. `artifact.renew` extends
  that promise for the same finite interval; it cannot reopen an expired or deleted
  recording. The player must stop using its cache URL when renewal fails and close
  the token when its window closes. If the app crashes, renewals stop and the
  existing timer releases the cache automatically. Recording deletion still
  revokes the lease and removes the cache file without finding a second app copy.
- **The gap:** the required player lifetime can exceed a download token's deadline;
  the plan did not choose renewal, streaming or an app-owned copy.
- **The reach:** one small public operation serves all CLI/MCP/native active
  consumers, while the native app owns renewal for its actual player lifetime.
  It relies on the trusted local service's immutable private cache URL, not a
  remotely supplied path. Clients cannot treat a once-valid URL as valid forever.
- **Verdict:** sound; the existing pin/timer/revocation owner already has the
  lifecycle needed, so another movie store and janitor are unnecessary.
- **Confidence:** high.
### 14c2 — Bound bytes handed to the native media framework

- **Choice:** Descriptor-backed inspection yields after every 64 KiB read and stops
  after delivering 64 MiB during one asset lifetime, with at most eight concurrent
  requests. When a media framework asks for an entire recording before seeking its
  metadata, a synchronous loop can feed the whole file before noticing cancellation.
  Yielding lets that seek happen; the lifetime byte ceiling also bounds material
  retained by the framework after each response. A larger valid inspection fails
  explicitly instead of quietly returning less media.
- **Gap:** The retained-file plan required bounded work but could not prescribe
  AVFoundation's request behavior before the real descriptor probe.
- **Reach:** These approved internal limits cover bounded frames, scene samples and
  excerpts. A future full-movie descriptor consumer needs its own measured policy;
  ordinary-path decoding remains unchanged.
- **Verdict:** Sound; the real thirty-minute source seeks without whole-file loading,
  while the high-bandwidth audio fixture demonstrates explicit limit failure.
- **Confidence:** High.

### 14c2 — Retained context ownership

- **Sound; medium confidence:** Keep package files private under one cooperating
  owner, and compare native extraction identity with the actual opened file before
  reading. A pathname is only a locator. Missing or replaced locators fail instead
  of reconstructing a fake library path. This defends controlled ancestor/member
  replacements without pretending to defeat arbitrary same-user in-place writes.
- **Sound; medium confidence:** One context admits one native request at a time,
  up to 32 open files and 128 MiB of derivatives. Failed output attempts retain
  their reservation until close. This bounds abandoned partial files without a
  second cache or cleanup scheduler. Public scheduling and lifetime identity stay
  with the later handle owner; these internal limits may need measured adjustment.
- **Sound; high confidence:** The context borrows its caller's locked directory
  descriptor and drains workers before revoking reads and cleaning it. A close
  failure preserves explicit recovery responsibility. Native extraction identities
  remain local receipts, separate from portable inventory hashes and history.
- **Sound; high confidence:** Existing audio planning may use absolute inventory
  locators. The context maps only exact inventoried media locators to admitted
  descriptors; it never treats arbitrary paths as authority or changes the common
  timeline/media planner. Request values are copied at admission so a caller cannot
  change an output label or media request while native work is pending.

## Native preview interaction

- **Choice:** one player window; opening another preview replaces it. The window
  stays on the revision resolved when opened, even if another client edits later.
  Preparation is observed through the existing controls cadence and failed preview
  jobs offer an explicit retry. Source-processing failures remain their owner's
  failure rather than being silently retried by the player.
- **Gap:** the plan required native playback but did not choose window count or
  how edits made during playback should affect an open view.
- **Reach:** bounds active native player resources and keeps the displayed movie
  truthful to its pinned title. Standard AVPlayerView supplies playback controls.
- **Verdict:** sound; no new rendering, timeline, scheduler or copied-file owner.
- **Confidence:** high for lifetime; actual menu/player visual integration remains
  independently verifiable through the app.


## External publication ownership (14d1)

### Sound — medium confidence

- **One time budget per publication owner.** A large completed movie must be
  hashed before publication and again when a lost response forces recovery. Giving
  only the commit step extra time can successfully create the export and then
  report a timeout while checking it. The owner now applies the caller's chosen
  native-worker deadline to preparation, commit, reconciliation and acknowledgement;
  recovery does not inherit a canceled request signal. Product consumers still
  choose their bounded budget from the actual work rather than introducing a new
  unbounded worker lane.

### Sound — high confidence

- **Keep private prepared evidence until the caller acknowledges external truth.**
  If the service dies immediately after creating the user's export, a failed job
  row cannot tell whether the file exists. A small synchronized private receipt
  identifies the completed file and its bytes, while a retained hard link prevents
  its inode from being reused. Reopening under the inherited directory lock lets
  the service distinguish its committed output from somebody else's identical
  bytes. Closing does not clean evidence; a later catalog owner must first record
  the observed commit, then request acknowledgement cleanup. This is process-crash
  recovery, with no claim that directory entries survive sudden power loss.

- **Private cleanup cannot contain the selected destination.** If an integration
  accidentally selects the staging directory as the export destination, ordinary
  cleanup could erase a supposedly published file. The native owner walks the
  retained destination's ancestors and rejects that arrangement. It removes only
  its owned private leaves and leaves unexpected entries untouched. A normal output
  directory needs no private-directory permission or exclusive lock; only staging
  does. The owner still assumes other processes do not maliciously mutate its
  exclusively controlled private staging while a syscall is executing.

- **Return observed publication outcome even after a late worker failure.** If
  cancellation arrives after the kernel creates the destination, deleting it would
  destroy a completed export. The service waits until the actual child exits and
  independently checks identity and contents. A committed file stays committed;
  missing, replaced and modified remain explicit outcomes. Repeated cleanup and
  close calls reach the same end state, and every close caller waits for the active
  operation before descriptors are released.
### 14c3a — Transient package job authority

- **Sound; medium confidence:** Four package contexts may remain open or closing,
  each retaining at most 32 jobs and bounded request/result metadata. A consumer
  explicitly releases completed metadata before asking for more; no active or
  draining job is evicted. This caps memory while allowing an already-open package
  to serve unlimited sequential requests. Public storage limits remain separate.
- **Sound; high confidence:** Package scheduling uses an in-process capability
  issued by the existing queue, rather than accepting a caller's context ID as
  authority. Closure is remembered only while that capability remains reachable;
  discarded handles require no everlasting tombstone map. Restart invalidates them.
- **Sound; high confidence:** Keep durable library jobs in their existing tables and
  transient package jobs in bounded memory, but choose starts with one admission
  sequence and execute through one attempt owner. Package jobs have no fictional
  recording/revision row, and deleting a same-ID library recording cannot own them.

### 14c3b1 — Output release and delivery ownership

- **Sound; high confidence:** Releasing a package output retires new reads and
  waits for existing leases before removing its file. Successful disposal returns
  capacity, so a long-lived package can keep serving requests. Unconfirmed creation
  or cleanup retains its reservation until explicit recovery/full close; an error
  never silently makes possibly occupied storage available again.
- **Sound; high confidence:** Reuse the retained package's output owner and the
  existing delivery owner rather than creating package rows in the library cache.
  Delivery ownership includes its recording/package kind, so matching embedded IDs
  cannot cross-revoke files. Owner values are copied before callbacks can mutate them.
- **Sound; high confidence:** Media work and output disposal share one bounded
  native-call lifetime per context. Concurrent release requests can wait for one
  another, but cannot launch a burst of cleanup workers outside execution ownership.

### 14c3b2 — Archive admission and workspace recovery

- **Sound; medium confidence:** A requested ZIP is pinned by an open file handle,
  byte size and modification time before copying. Renaming its pathname still
  copies that original object: admission excludes metadata-change time because a
  rename changes it. The copy compares a full before/after stamp and validates the
  actual snapshot. This detects ordinary in-place changes without pretending to
  defeat an arbitrary same-user process rewriting bytes and restoring timestamps.
- **Sound; medium confidence:** Workspace creation drains to its bounded native
  receipt before honoring cancellation. That gives cleanup the exact new directory
  identity. A crash before that receipt retains an explicit failure and its name;
  the next registry must hold storage credit until recovery proves removal. Killing
  creation immediately would lose that authority more often.
- **Sound; high confidence:** Workspace removal closes its admission handle and
  independently reacquires the directory lock beneath the retained parent. If an
  old native child inherited the original handle, cleanup stays busy until it exits.
  Reusing the original lock description would falsely authorize deletion while the
  child still uses the tree. Under the exclusively owned private parent, an absent
  named child is already removed, allowing retry after a lost success reply. A
  different existing child still rejects. External child renaming is outside that
  ownership model; parent pathname movement is supported by the held descriptor.
- **Sound; high confidence:** Failed full close permanently fences package reads
  and work but allows an explicit cleanup retry through the same owner. Storage
  charge returns only after cleanup succeeds. Concurrent close calls share the
  attempt; there is no automatic retry loop or promise of renewed inspection.

## Durable video intent (14d2a)

### Sound — medium confidence

- **Committed status reports a past publication event, not ongoing file integrity.**
  A user may delete or replace an exported video after the app successfully saved
  it. The app retains that historical receipt but does not hash the entire video
  every time an agent asks for status. Such polling could launch repeated large
  reads outside the shared worker limit. Retrying this same completed intent never
  recreates the user's deleted file; making another export requires another
  request. Uncertain crash recovery still verifies the staged file's identity and
  bytes before first recording that publication succeeded.

### Sound — high confidence

- **One catalog intent records what the queue cannot promise after cancellation.**
  If the filesystem saves a video and cancellation arrives before the worker's
  result reaches the queue, ordinary job settlement correctly ignores the late
  answer. The export's pinned snapshot and committed native receipt live in one
  separate catalog row, so that ignored job answer cannot erase a real external
  save. Attempt state remains solely in JobQueue; there is no extra execution
  scheduler. Successful recording deletion removes this intent and its private
  context while preserving the deliberately exported file.

- **Use the existing cache and library-root authorities for the first video consumer.**
  Copying a ready preview by its advertised path could race cache cleanup or copy
  another file. The cache now lends its validated open descriptor until the native
  copy actually finishes. The existing managed-files owner also rejects a selected
  directory inside the library by filesystem identity: otherwise deleting the
  recording could erase a file the app had called external. No unrelated external
  directory is prohibited. This internal ready-preview checkpoint does not turn
  cache capacity or immediate dependency readiness into a new public export limit.

- **Reserve identity before bytes, and publish complete preparation evidence atomically.**
  The catalog records the random staging name before making its directory, then
  records the directory identity before any payload is written. A crash in between
  can therefore leave only an empty private directory; a nonempty substitute is
  refused. The prepared receipt is synchronized under a pending name before its
  canonical name is created atomically. A one-byte interrupted receipt cannot be
  mistaken for a completed preparation or permanently prevent recording deletion.
  Both receipt names belong to the same existing publication cleanup owner.

- **Private deletion does not depend on being able to read the user's export.**
  An unrelated destination may have permissions that prevent reading it. Once the
  exporter has drained, deleting the recording only needs authority over its own
  staging directory: it leaves every external file untouched and removes the
  intent's status along with other private metadata. It therefore does not hash or
  classify that external file first. A replaced or unsafe private staging directory
  still blocks deletion, because that is where cleanup would actually write.

## Deferred dependency admission (14d2b1)

### Sound — medium confidence

- **Waiting jobs have a separate finite allowance in the existing queue.** When
  many exports all need the same preview, they wait without consuming the runnable
  backlog that the preview needs to enter. Promotion joins the back of the shared
  library/package queue once dependencies are ready. The plan required bounded
  waiting but did not specify a fairness rule; runnable-entry order preserves the
  queue's existing ordering without letting old blocked requests jump ahead. This
  is one jobs table and scheduler, not an export-owned pending-work loop.

- **Dependency identifiers use the existing queued reason field.** An agent asking
  for artifact readiness sees queued and the dependency identifier while work is
  blocked; internal queue code can distinguish waiting from runnable queued work.
  No new public state is required. The plan left the transport of dependency detail
  open; richer export responses can project this information without redefining
  execution state in the export intent.

### Sound — high confidence

- **Install dependency admission only after its owners exist.** Reopening a catalog
  can find old waiting jobs before the service has constructed its preview owner.
  They remain inert until the service explicitly installs its admission callback.
  Existing dependency requests made by that callback cannot recursively restart
  admission. The plan left initialization and reentrancy mechanics open; this
  avoids fake default-success callbacks and work launched against undefined owners.

- **Retry remembers that a job requires prerequisites.** A durable boolean on the
  existing job row distinguishes ordinary work from deferred work even after a
  failure or completed publication. Retrying or regenerating that job checks its
  prerequisites again; repeated status reads do not. The schema follows the existing
  development hard-cutover policy: old catalogs are rejected before writes, rather
  than guessing how their jobs should execute. A partial index limits admission
  scans to the bounded active waiting set, not accumulated historical jobs.

## Private export storage observation (2026-09-17)

- **Choice:** Measure private file lengths without taking the writer's exclusive
  lock. While a video is being copied, a storage request can see how large its
  partial file has become; it does not wait for the movie to finish or read the
  exported movie. The native publication owner supplies the same fixed file set
  to measurement and cleanup.
- **Gap:** The spec required truthful temporary storage totals but did not define
  whether measurement blocks publication or estimates bytes from intent metadata.
- **Reach:** Public totals must label this as a live observation, matching the
  existing storage API. Concurrent growth or cleanup can change the next reading;
  this does not claim a single instant snapshot or physical disk allocation.
- **Verdict:** Sound: actual file metadata reports partial work without creating a
  second storage owner or blocking exports. Identity checks reject replacement.
- **Confidence:** High.

## Pinned waiting video consumer (14d2b2)

### Sound — medium confidence

- **Canceled and failed export requests still count against the retained-intent allowance.**
  A canceled export may later retry the exact source evidence it originally selected.
  Dropping that protection on cancellation would let cleanup erase evidence needed
  for the promised retry. Counting every uncommitted intent, even one still waiting
  for its first evidence, bounds this obligation. The plan left the retention limit
  and cancellation interaction open. Public release must also offer explicit export
  abandonment that drains one intent and frees its private resources while preserving
  its recording and external files; deleting recordings is not the public escape hatch.

### Sound — high confidence

- **Source evidence is chosen once when available, while revision/history are chosen at request.**
  A user can request an export before source processing finishes and edit the recording
  while it waits. The export keeps the original edit revision and history bound, then
  records the first ready source-evidence generation before asking for its preview.
  A later source reprocessing run cannot redirect retries to newer evidence. The
  existing source cleanup owner consults the intent's retention predicate, keeping
  filesystem and database reclamation under one authority. A committed export stops
  protecting that generation because its historical receipt forbids regeneration.

- **Cache loss returns the settled export attempt to prerequisite admission.**
  If another operation evicts a preview after the export was queued, rebuilding it
  inside the exporter would occupy the heavy worker needed to render that preview.
  Instead the exporter closes its publication handles, invalidates the obsolete
  preview selection, and gives JobQueue a typed lost-dependency outcome. The same job
  receives a fresh attempt before the existing preview owner rebuilds its pinned
  input. The plan required forward progress but left this race's handoff unspecified.
  Actual prepared publication evidence is reconciled first so missing dependencies
  cannot hide a file that has already committed externally.

## Export storage composition (2026-09-17)

### Sound — high confidence

- **A completed movie is excluded even if the process dies before saving its receipt.**
  Publication creates an extra file link to transfer a completed payload to the user's
  destination. Storage can observe that link count without opening or hashing the
  movie; it excludes the payload and keeps counting private receipt metadata. Known
  durable commit truth also excludes the payload if the external file later disappears.
  The plan required avoiding double counting but left this crash gap unspecified.
  This is an accounting observation only; it never authorizes reporting export success.

- **Remember confirmed private-byte cleanup independently of historical commit.**
  A finished export remains in history after its private bytes have been removed.
  The added catalog marker and partial index let storage skip that history, so moving
  the destination does not break future storage reads or launch one native worker per
  completed export. The plan left completed-history accounting open. The original
  staging identity remains for directory retirement; the marker asserts zero owned
  file bytes, not that the directory itself was removed.

- **Export bytes join the existing storage owner's other-bytes category.**
  A failed export's temporary files appear in its recording and global totals even
  though they live outside the library. The existing owner coalesces repeated requests
  and aborts and drains observations during shutdown. The plan specified attribution
  without requiring another public category; this keeps one accounting lifetime.
### 14c3b3 — Internal package admission lifetime

- **Sound; high confidence:** Opening first returns an admission ID, and only
  verified extraction creates the usable package handle. A recording in progress
  may keep the shared heavy queue paused; callers can inspect or cancel that
  queued admission instead of keeping a request blocked. Restart invalidates both
  identities, and neither identity is the embedded recording UUID.
- **Sound; medium confidence:** Keep the 32 most recently retired admission
  receipts in completion order. An old close remains idempotent while its receipt
  exists, then explicitly expires. This bounds server memory without permanent
  tombstones; it does not evict any active or cleanup-failed resource owner.
## Per-export abandonment (14d2b3)

### Sound — medium confidence

- **Completed abandonment forgets its identity instead of retaining a tombstone.**
  Abandoning an export removes its private status and recording context after cleanup.
  Repeating abandonment for that now-absent UUID succeeds. If a caller subsequently
  creates an export with the same UUID, that is a new request, not a lookup of the
  abandoned result. The plan left post-abandonment replay policy open; this follows
  the existing no-tombstone privacy decision, at the cost of clients retaining any
  historical result they still need.

### Sound — high confidence

- **One durable boolean prevents abandoned work from restarting.** A request marks
  its intent before waiting for workers, so a concurrent retry cannot start another
  copy while cleanup is removing staging. Failed cleanup keeps the marker, and an
  explicit abandonment retry resumes retirement. Recording deletion shares the same
  cleanup promise; it cannot erase catalog rows while abandonment still uses them.
  The plan required safe cleanup but left its concurrency and durable representation
  unspecified. No separate job scheduler or lifecycle table is needed.

- **Source retention and admission capacity end at different confirmed events.**
  Cancellation can race a successful external commit. Once that commit is durable,
  source evidence is no longer needed to regenerate this export and may be reclaimed.
  Its abandonment still consumes pending admission capacity until private retirement
  succeeds, so repeated failed cleanup cannot make that obligation disappear from
  admission accounting. An already committed export gains no new source pin merely
  because the user abandons its private status. This resolves the late-commit case
  without recording whether abandonment started before or after publication.

- **Retire the job's result and identity together after all attempts exit.** A retry
  can be queued while an older canceled worker is still closing. Single-job drain
  waits for both lifetimes before forgetting anything; the queue then removes its
  ready artifact and job identity atomically. The intent marker remains until private
  cleanup and queue retirement are confirmed, making interruption between those
  steps repeatable without preserving stale results or deleting the recording.

### 14c3c1 — Public package selection and recovery

- **Sound; medium confidence:** An open returns an admission receipt, and close
  accepts that receipt's ID even before a readable handle exists. Status without
  an ID lists only the bounded active admissions and their storage/recovery state.
  If an open reply is lost, the caller can discover and close the still-owned
  admission; opening the same file again remains a separate lifetime, not replay.
  Retired receipt history is not a new public listing or persistent package library.
- **Sound; high confidence:** Package initialization and orphan recovery are a
  separate availability boundary from capture/library startup. An unavailable
  native helper, busy inherited lock or invalid private package directory reports
  a package error while existing library operations continue. Explicit open
  retries recovery; there is no additional timer or polling service.
- **Sound; high confidence:** Retain parsed history and the index reader only as
  long as the admitted context is reachable. Repeated image/page reads therefore
  reuse the accepted history instead of reparsing it, while handle lookup still
  fences every request and evidence rows retain their shared lazy validation.
- **Sound; high confidence:** Public archive inputs require an absolute path
  with no symlink components, preserving the admitted-file owner's containment
  rule rather than resolving a client path relative to the service's directory.
  The service's own private package root supports ordinary home-path aliases by
  matching its non-symlink leaf identity before and after canonical open.
## Queued publication recovery (14d2b4)

### Sound — medium confidence

- **Publication deadlines grow with known bytes, using a conservative per-call allowance.**
  A large movie on a slower volume can legitimately outlast the generic short worker
  deadline. Publication now budgets two complete byte passes at four MiB per second
  plus startup overhead, capped at the existing worker maximum. The plan required
  size-aware deadlines but did not set a throughput allowance. This covers the copy
  and verification paths without another timer; it is a policy allowance rather than
  a promise that every destination can sustain that rate. Timeout does not authorize
  automatic retries or a claim that no external file was created.

- **Superseded by "Commit retires export staging" below.** An empty staging directory still requires verified retirement. After private
  bytes are cleared, a moved destination volume cannot invalidate the historical
  committed receipt or make ordinary retry touch that volume. Its empty staging
  directory has not thereby been removed, however. Abandonment/deletion retains its
  identity and can require restored access before directory retirement completes.
  The plan distinguished byte cleanup from directory ownership but left this missing-
  volume case open; no detached cleanup registry or unverified removal is introduced.

### Sound — high confidence

- **Recovery has an attempt identity in the existing heavy queue.** Restarting after
  a publication crash schedules an observation of the existing staged receipt and
  destination, not another writer. A bounded metadata scan submits only identities
  the queue has not seen, and failures remain terminal until an explicit request.
  Source processing failures do not prevent discovering a file already committed.
  The plan left admission representation open; using the queue preserves shared
  capacity, cancellation, retry and shutdown instead of adding an export scheduler.

- **Explicit observation refresh differs from automatic admission.** If recovery
  observes a missing file and the user later restores it, explicit recovery must be
  able to inspect again. It regenerates that observation job; repeated startup scans
  and status reads do not. A negative observation remains a point-in-time statement,
  not proof that publication never happened. A known acknowledged receipt stays
  historical and never causes another export merely because the file moved.

- **Cancel and abandonment cover recovery workers as well as publication workers.**
  Cancel can stop a long recovery read, while the shared queue retains its slot until
  the native worker closes. Any commit already observed is still recorded. Abandonment
  then drains and forgets every recovery identity belonging to that export, using
  validated UUID boundaries so a neighbor's jobs remain untouched. No separate
  cancellation registry or destination-deletion authority is added.

## 14d3 shared export request identity

- **Choice:** Kind belongs to the existing durable export request. A caller that
  repeats a video UUID asking for a package receives a conflict; a new package
  request receives an explicit unsupported error before anything is queued or
  stored. The existing video request remains intact.
- **Gap:** The two product choices were settled, but the order of replay conflict
  and not-yet-supported handling needed a concrete rule.
- **Reach:** One lifecycle remains usable by public adapters. Future package work
  adds a producer to this owner rather than another intent table or scheduler.
- **Verdict:** sound; changed requests cannot silently reuse another format's work.
- **Confidence:** high. The owner rename and required kind are the agreed shared
  contract, not new product scope. Older development catalogs retain the existing
  refusal policy rather than silently assuming a kind.

## Public video export composition

### Sound — high confidence

- **Completed output paths describe publication history.** After the user moves a
  movie, status still reports the canonical path used when it was committed and
  its recorded receipt. Retry does not recreate the missing path. The plan required
  an output path but did not define whether it remains visible after movement;
  returning history avoids extra filesystem reads and keeps moved files successful.
- **Destination validation belongs to the export owner's shutdown lifetime.** A
  client can request an export just before the service exits. Before a queue job
  exists, the native destination check may still hold a directory descriptor.
  Export close now prevents new creation, cancels that check, and waits for its
  promise before the catalog closes. The plan required worker draining but left
  pre-queue validation implicit; this closes the same lifetime instead of creating
  another queue for quick destination checks.
- **Export dependency admission waits for cache startup; recovery does not.** On
  restart, a valid cached preview must be reconciled before export admission tries
  to read it. Waiting on that existing startup promise prevents a transient cache
  state from becoming a durable failure. Observation of an already published file
  does not need cached media, so recovery remains independently runnable. This
  ordering keeps the shared queue and avoids automatic retries to mask startup races.

## 14d3a ZIP byte producer

- **Choice:** ZIP stores media entries without applying a second compression pass.
  A large video is copied through a fixed buffer; packaging does not spend CPU
  trying to compress bytes that the video codec already compressed. JSON may take
  more space than a compressed ZIP. Existing archive size limits include overhead.
- **Gap:** The package contract did not choose a ZIP compression method.
- **Reach:** Output is a standard ZIP readable by the existing native reader. A
  later compression policy may change bytes without changing the export lifecycle.
- **Verdict:** sound; predictable bounded work is appropriate for media packaging.
- **Confidence:** medium.

- **Choice:** A bounded file descriptor carries the selected member plan. A package
  with many screenshots can exceed the control message limit even though it is a
  valid package. Sending an already-open plan file preserves the existing wire
  limit and avoids keeping one open descriptor per screenshot. Each media member
  is opened and verified when copied.
- **Gap:** The producer needs metadata larger than a control request may carry.
- **Reach:** The future assembler must own and register its plan and scratch
  lifetime before writing, using the same export intent. No new scheduler is added.
- **Verdict:** sound; bounded metadata and streamed media use existing ownership.
- **Confidence:** high.

- **Choice:** Prove the byte producer before wiring prerequisite retention. Public
  package requests still fail before creating an intent. The next vertical pass
  can connect real retained evidence to an actual writer rather than introduce a
  test-only intent API for a package producer that does not exist.
- **Gap:** The prerequisite-only pass had no honest admitted consumer while package
  creation remained unsupported; its order needed refinement.
- **Reach:** The accepted complete-package and narrated-transcript gates remain.
- **Verdict:** sound; verified byte production now supplies the missing consumer.
- **Confidence:** high; coordinated with the parent before implementation.

## Core verification worker ceiling

### Sound — medium confidence

- **Run at most four core test files concurrently by default.** With the automatic
  worker count, the file-heavy portable-index and storage fixtures exceeded their
  existing five-second test limit; the same complete suite passed with four workers.
  The core test command now carries that ceiling, so an ordinary run uses the
  verified scheduling configuration. No test, assertion or timeout changed, and
  tests of product concurrency still drive that concurrency themselves. The plan
  did not specify test-process parallelism; four is a conservative host-work budget,
  not a product capacity limit or guarantee against all host-load variation.


## Portable timeline events — 2026-09-17

- **Sound, medium confidence — Split equal-time groups across portable pages.**
  Store individual ordered events with a playback position and ordinal instead
  of one potentially unbounded array for all events at a cut boundary. Consumers
  combine adjacent equal-position rows, continuing by ordinal. This preserves
  the logical grouped timeline while keeping each read bounded.
- **Sound, high confidence — Certify completeness against pinned evidence.**
  Page hashes and valid timestamps cannot show that no event was omitted. The
  package assembler compares every event with the same source/scene projection
  used by its writer before publication. This uses the existing readers and
  introduces no event database or scheduler.
- **Sound, high confidence — Journal order breaks simultaneous source ties.**
  Pause and geometry markers at the same source position retain journal sequence;
  scenes and interruption follow them deterministically. The timeline owner still
  controls cut placement and boundary inclusion.

## Arbitrary package frames (14c3c2a)

### Sound — medium confidence

- **Retained images are a bounded working set.** When a long inspection asks for
  another image, the package owner removes the least recently read output that
  has no active reader until its existing budget can admit the new frame. A held
  delivery keeps its bytes; if every candidate is held, the request reports a
  retryable limit instead of waiting while occupying a processing slot. The plan
  required continued progress but did not choose eviction order. This favors
  recently inspected images without adding another cache or changing the budget.
- **Expired result metadata admits a new job identity.** After many different
  requests, drained frame job receipts can leave the bounded queue metadata set.
  Asking for that image again starts a new job and output, even if an older held
  delivery still has its bytes. Attempt generations belong to each job, so the
  fresh job starts its own sequence. The plan left the relationship between
  metadata and image eviction open; independent bounded lifetimes avoid a second
  request map and preserve existing delivery promises.

### Sound — high confidence

- **Clean frames need only media and timeline.** A caller asking for a clean
  screenshot does not consume cursor evidence, so this route does not parse source
  metadata and reports no annotation-evidence summary. Annotated requests use the
  same receipt and normalized-row validators as library inspection. The portable
  package already defers row validation until use; keeping that boundary avoids
  making an unrelated malformed annotation page prevent clean image inspection.
- **Both storage policies share one frame controller.** Library frames and package
  frames use the same option checks, pinned revision, batch behavior, materializer
  and failure cleanup contract. Their adapters own only their existing queue and
  output storage policy. The plan required reuse but did not specify its seam;
  this keeps timeline and trail decisions in one place without treating package
  provenance as a live library recording.

## Repeatable package/export verification

### Sound — medium confidence

- **Use a freshly built bundle and at most two test files at once for the export gate.**
  The native tests previously required separate commands and environment settings;
  forgetting one made a relocation check refuse to run. The root `lab:exports`
  command now builds first and supplies that same bundle to all package/export
  fixtures. Two test-file processes bound host contention while each test still
  exercises the real product queues and workers. The plan required a repeatable
  export checkpoint but left its orchestration unspecified. This creates no
  runtime product limit, skips no selected checks, and does not turn unfinished
  speech or package capabilities into claimed successes.

## Public package audio (14c3c2b)

### Sound — high confidence

- **Frame and audio receipts share the package's existing bounded working set.**
  If an agent asks for many screenshots and then an audio excerpt, either kind's
  drained terminal job receipt may leave the metadata set to admit new work. A
  held image or audio delivery still keeps its file alive independently. The
  original frame pass specified frame-only reclamation because it had one
  consumer; two separate policies would let one kind block the other after
  filling the same queue. A common package media owner now applies the same
  lifetime rules to both without another cache, budget or scheduler.
- **Audio sources use admitted member identities through the existing resolver.**
  The shared planner still receives absolute logical paths, while retained native
  execution resolves those names to already-inventoried descriptors before reading.
  Moving a ZIP therefore needs no rewritten timeline or ambient source file. The
  plan required containment but left adapter shape open; keeping resolution at the
  existing file owner preserves the native decoder and avoids a package-only
  audio planner.


## Complete package consumer

### Sound — high confidence

- **Assembly bytes have one lifetime owner.** The existing export intent registers
  two direct managed recording children before creation and saves identities before
  writing. Existing workspace locks protect exactly what cleanup removes. This
  avoids an unlocked enclosing directory and gives recording deletion the same
  survivor fence as ordinary package cleanup.
- **Committed truth and private cleanup remain independent.** Source, scene and
  index retention ends at durable commit; pending intent capacity remains charged
  while private workspace cleanup is unresolved. Explicit retry cleans those bytes
  without requiring the moved external destination or publishing a second ZIP.
- **Portable serialization uses existing immutable evidence ownership.** Assembly
  validates its produced pages against pinned evidence, checks normalized receipt
  size, and copies selected media with descriptor-relative identity checks. It does
  not introduce a second normalized parser or a per-page native writing protocol.
  JavaScript page writers still require stable private app-owned directories.

## Public timeline inspection — 2026-09-17

- **Sound, medium confidence — Empty pages can still mean forward progress.**
  Long static or cut-away source stretches may have no retained markers. The reader
  limits consumed input as well as returned rows, and returns a continuation when
  more scanning remains. Agents follow the cursor even after an empty page; this
  bounds a single request without silently dropping evidence or rescanning from zero.
- **Sound, medium confidence — Timeline continuations are opaque strings.**
  A bounded cursor carries target, revision, both evidence generations and stream
  positions. Clients resend it without knowing source-reader internals. It is not an
  authorization token: existing library/package authority is resolved before and
  after the read. An edit of the current revision does not retarget the cursor.
- **Sound, high confidence — Complete timeline reads wait for source and scenes.**
  The operation returns readiness errors until both evidence owners have published,
  rather than claim a complete timeline while silently omitting scene boundaries.
  Transcript readiness is independent and does not gate timeline inspection.


## Export discovery

- **Sound, high confidence — Discovery is a live lexical page.** Existing UUID
  identity orders rows without a new sequence or snapshot owner. Filters travel in
  the cursor; new arrivals before its position require a new traversal. This makes
  restart discovery explicit without claiming a frozen view of active work.
- **Sound, high confidence — Cleanup does not rewrite publication truth.** A
  committed export stays committed while its summary separately shows remaining
  private cleanup. Abandonment stays visible even after byte cleanup. The unfinished
  filter therefore finds actionable obligations without mislabeling external files.
- **Sound, high confidence — Summary reads select before joining.** Bounded rows
  expose IDs and state, with partial indexes excluding completed history for either
  filter scope. Status retains details; discovery does not spawn filesystem work or
  another recovery attempt merely because an app restarted.

## Source receipt locators — 2026-09-17

- **Sound, high confidence — Preserve the caller's locator after checking identity.**
  Native code may canonicalize directories for containment, but it returns the
  original requested output spelling only after checking that it names the inode
  the exporter created. Core keeps exact request/receipt equality instead of
  accepting arbitrary equivalent-looking paths. This repairs alias handling
  without changing the immutable-generation ownership contract.


## Whole-codebase review — 2026-09-17

Seven parallel review lanes (core store, core evidence, service exports, service
core/protocol/CLI, macOS app, native helpers, docs) reported verified findings. Each
lane then fixed its own findings on a branch, and the branches merged with native
export controls. The choices below are the ones that change behavior or format.

### Most consequential

- **Commit retires export staging; a finished export never needs its folder again.**
  - **When:** service-export review fix.
  - **Decision:** a successful export used to leave an empty hidden
    `.screenrec-export-<id>` directory in the destination until the export was
    abandoned or its recording deleted. Retirement then needed that folder, so
    someone who moved or deleted their export folder could never delete the
    recording. Acknowledgement now removes the empty directory while the
    publication is still verified. Deletion and abandonment treat a destination
    that is gone or replaced as nothing to clean, and never remove foreign
    content. Startup recovery still refuses to mark unreachable staging cleared,
    so a briefly unmounted volume does not orphan real staging bytes.
  - **Gap:** the earlier plan left the missing-destination case open.
  - **Rationale:** a protection against leaving an empty directory must not ban
    a valid deletion forever.
  - **Consequence:** exports leave only their file. An unreachable destination
    during deletion may leave an empty directory on a volume that later returns.
- **The catalog carries one format stamp and refuses anything else.**
  - **When:** core-store review fix.
  - **Decision:** `RevisionStore` stamps a new catalog with `PRAGMA user_version`
    and refuses a different stamp, or an unstamped catalog that already has
    tables, with `UNSUPPORTED_CATALOG`. Before this it sniffed old development
    columns, including one table owned by the service.
  - **Gap:** the spec says fresh version 1 with no migrations.
  - **Rationale:** one stamp owned by one module replaces a growing list of
    other modules' schema details.
  - **Consequence:** the existing personal `~/.screen-recorder/library.sqlite`
    holds no recordings but predates the stamp. The app refuses it until that
    file is removed. A future format change bumps the stamp.
- **Client deadlines come from the operation, not one 10-second default.**
  - **When:** service-core review fix.
  - **Decision:** protocol declares each operation's client deadline from the
    service's own inner bounds plus a margin:
    - reads get 15 seconds;
    - `capture.stop` and `capture.start` get 45 and 55 seconds;
    - operations that join unbounded drains (delete, abandon, package
      open/close, storage) get 185 seconds.
    Before, the CLI reported `TIMEOUT` while the service was still legitimately
    working, and agent retries piled up.
  - **Gap:** only a single default existed.
  - **Rationale:** the caller should hear the service's own answer or refusal.
  - **Consequence:** a hung service takes longer to surface for those operations.

### Native app

- **D10 overrides the earlier source-routing choice at this ledger entry.** The ⌥⇧S hotkey
  records the display under the pointer; the menu's selected source remains the menu path.
- **A repeated lost start that returns an ended take asks for a new take.** The
  menu used to replay a lost start request forever. After that take had been
  stopped, pressing Start again silently "succeeded" without recording. Now the
  stale request is dropped and the same press starts a new take.
- **A closed chosen window leaves the source unselected.** The first display is
  offered only before any source has ever been chosen, so a shortcut never
  silently records a whole display after a window closes.
- **Every quit finalizes a running take within two call deadlines plus 10
  seconds.** This covers the Quit menu, SIGTERM and system quits such as logout,
  through `applicationShouldTerminate`. A stuck but alive service can hold quit
  for about 30 seconds.
- **Probes need an explicit `--probe <name>`.** An unrelated launch argument is an
  ordinary launch.
- **Native export controls allow one save panel at a time, not one export at a
  time.**
  - The handoff asked for one active request. That would have blocked exporting
    another take while a request waited for its reply.
  - Only destination choice is serialized. Each request keeps its own export
    identity through a lost reply and is sent again only by an explicit action.
  - Committed, clean exports can be removed from the menu list; service history
    and files remain.
  - Unfinished exports are rediscovered at launch, on service readiness and on
    menu open.

### Service, core and native formats

- **A deferred job is automatically readmitted at most once after its
  prerequisite disappears.** A second loss fails it as retryable. Before, cache
  pressure could cycle an export forever.
- **Shutdown stops running work even if the catalog cannot record the
  interruption.** Startup already marks attempts left running as interrupted.
- **Status reads an export intent even while its recording is being deleted,**
  so discovery and status describe the same rows.
- **Storage usage counts unreachable export staging as zero** instead of failing
  the whole library total.
- **Missing index ordinals are `NOT_FOUND`; malformed ones are `INVALID_PARAMS`**
  on every reader path.
- **Portable scene chunks are validated for contiguity and duplicate comparisons
  when read.** Scene boundaries are derived from stored comparisons, not stored
  twice. The unused geometry-epoch evidence order was removed. These change the
  unshipped package version 1 format.
- **Native outputs are published through one no-overwrite primitive.** Repeating
  a native frame or audio output request for an existing path returns
  `INVALID_OUTPUT`; TypeScript callers always name fresh paths. Worker-only media
  recovery and source-evidence export left the app's capture library.
  `media.renderVideo` is gone; every render is `media.renderMovie`.
- **Native failures have one type and one retryable flag per failure.** A changed
  directory identity is now final in every operation family.
- **Journal records are capped at 1 MiB.** An oversized unterminated run is
  corruption (`invalidAtSequence`), not a crash tail. A sequence number is
  consumed only after a successful write.
- **Unknown service handler errors keep their message inside the service** for
  whole operations and batch items alike; callers see `INTERNAL_ERROR`.
- **An unconfirmed package output holds only its slot, not bytes,** so one lost
  output creation cannot wedge later frame and audio requests.

## Speech engine and transcription plan — 2026-09-17

- **Best-effort fillers ship with Parakeet.**
  - **When:** after the whole-codebase review, by user decision.
  - **Decision:** no evaluated engine reached the 95% verbatim filler gate. The user
    chose to ship word-timed transcripts without guaranteeing fillers. Parakeet TDT v2
    through FluidAudio is selected because it:
    - emitted most fillers while WhisperKit emitted none and rewrote hesitant speech;
    - keeps disfluent wording, which matters for cutting a quoted phrase;
    - has Apache-2.0 and CC-BY-4.0 licenses, unlike the restricted verbatim model.
  - **Gap:** the spec had no fallback product rule for a failed filler gate.
  - **Rationale:** the user owns the product scope. Among the engines, the only one
    that preserves disfluencies at all serves both phrase cuts and best-effort
    filler cuts.
  - **Consequence:** "cut out the ums" may miss fillers the model dropped. Boundary
    timing and warm resources remain gates to measure on real narration.
- **Transcription feeds only acquired narration intervals and refuses to load
  unverified models.** Native transcribes each readable narration interval
  separately and checks the pinned model file hashes before loading, so FluidAudio
  can never download at inference. This costs a hash pass per job but keeps "no
  network after prepare" enforceable rather than conventional.
- **FluidAudio is fetched at build time but links only into the worker.**
  - Building helpers/mac, and therefore the app package that depends on it by path,
    downloads the pinned FluidAudio revision and its NeMo text-normalization binary
    (49 MB, checksummed), even with traits disabled.
  - Symbol checks show neither in the ScreenRecorder app and no NeMo code in the worker.
  - Splitting the worker into its own package would avoid the fetch, but it restructures
    every native build and test target for a one-time pinned download on a personal host.
- **Native transcription forces FluidAudio offline mode and diverts stdout.** Without
  offline mode, a model that fails to load has its directory deleted for re-download.
  Core ML writes a late shape-inference message to stdout. The worker points stdout at
  stderr while transcribing, so its JSON response stays the only stdout content.
- **Model assets are ready only when an exact, receipt-matched file set is present.**
  Status never rehashes and never uses the network: it compares file set, sizes,
  modification times and inodes with the receipt written last during prepare. Native
  rehashes before each job. A failed prepare is remembered only in memory; after a
  restart, status reports the files as they are.
- **Transcript gaps are computed at ingest, and word IDs belong to one generation.**
  Gap rows (audio never acquired, or intervals too short) are stored with the words,
  so library and package reads share one simple record interface. A retry creates a
  new generation, and a continuation from the old one fails with `ARTIFACT_CHANGED`
  instead of mixing IDs.
- **Adding tables does not change the catalog format.** Every owner creates its tables
  idempotently, so the transcript tables need no bump; a changed existing table does.
  An earlier draft bumped the format, which would have refused the freshly installed
  personal library with no reason.
- **`model.prepare` answers at once and the download belongs to the service.**
  - Blocking on a roughly 465 MB download would outlast ordinary MCP call deadlines,
    and a disconnect would cancel it.
  - Prepare starts or joins the download and returns status; `model.status` reports
    progress.
  - A ready model admits waiting transcripts automatically.
- **Narrated package export waits on the transcript, but unprepared models fail the
  export.** Missing models start no transcription job, so there is nothing to wait
  on. The export reports a retryable `MODEL_NOT_PREPARED` that names the fix. A
  failed transcript is an actionable dependency failure, and retrying the export
  never silently restarts transcription.
- **Packages carry an edited transcript and validate it on open.** The pinned
  revision's projection is written as pages, like timeline events, and must equal a
  fresh projection of the portable source pages when the package opens. Tampering is
  refused before a handle exists.
- **Package transcript cursors still name the recording.** Continuations are owned by
  the shared transcript reader, so a package continuation carries the embedded
  recording ID beside the package handle target. A continuation from another
  recording or revision fails with `ARTIFACT_CHANGED`.
- **A span that starts between frames uses its first retained frame as the scene
  reference.** A cut ending between video frames used to fail screenshot indexing
  permanently. Nothing earlier is visible in that span, so its first retained picture
  is the reference, with no future comparison. This surfaced only once a real 30 fps
  take was cut at an arbitrary microsecond.
- **The personal install has its own bundle identity.**
  - **Observed:** development builds and their tests launch and kill many short-lived
    copies under `com.david.screenrec`. On this Mac, macOS then stopped showing that
    identity's menu-bar item. The installed app created its status item, but Control
    Center never displayed it. Toggling the Menu Bar setting and unregistering stale
    copies did not help.
  - **Decision:** the installer re-identifies and re-signs its copy as
    `com.david.screenrec.personal`, and the icon then appears.
  - **Why not rename the development identity:** the screen permission already granted
    to test builds would be lost.


## Settings window — 2026-09-18

- **A refused screen request this launch is what "denied" means.** macOS exposes
  screen recording access as one boolean preflight; unlike the microphone there is no
  "not asked yet" to read. `CGRequestScreenCaptureAccess` shows its prompt once ever
  and afterwards answers false without asking anything, so a request that came back
  refused in this launch is what tells the controls to stop offering a prompt and
  offer the privacy pane instead. A relaunch offers the prompt once more, which costs
  a person one click and never claims an access state macOS did not report.
- **A launch that serves a client request opens no window.** Discovery starts the app
  so a CLI or MCP call has a service; nobody asked to see the app then. That launch
  carries `SCREENREC_SERVICE_LAUNCH=1` and skips the window, so an agent's call never
  puts a window in front of whatever a person is doing. A person's own launch, and a
  reopen from Finder or Spotlight, still opens it.
- **Checks never activate this app and never read a person's defaults.** The app's
  preferences live in `UserDefaults`, so a check that launched the bundle would
  otherwise read and write the same domain a person's app uses, and the window would
  take the screen on every run. A launch names its own domain through
  `SCREENREC_DEFAULTS`, an absolute scratch path production ignores unless it is set,
  and a launch the controls fixture drives orders the window in behind everything
  instead of activating. Screenshots were brought forward through the accessibility
  API instead of synthetic clicks, which would have landed in whatever window was
  actually in front.
- **Access states for screenshots are displayed, not recorded.** A capture of the
  denied and unanswered rows states its access through `SCREENREC_FIXTURE_PERMISSIONS`,
  which replaces what the window displays and nothing else. Changing this Mac's real
  TCC record to take a picture would cost the development build the screen permission
  every capture test depends on.
- **The installed bundle is renamed, and the old name is replaced.** Finder, Spotlight
  and Login Items show a bundle's file name, so `ScreenRecorder.app` read as one word
  with no icon. The installer now writes `Screen Recorder.app` and removes a copy
  installed under the old name when it carries the personal identity, because two
  bundles of one app under one identity is what confuses Login Items.
- **The icon is a checked-in `.icns` rendered by a script.** Icon Composer needs a full
  Xcode, and this Mac has the command line tools, so the icon is drawn with Core
  Graphics at the iconset sizes and packed by `iconutil`. macOS 26 may still frame a
  legacy icon in its own container; the glyph is designed to read inside one.

## Preview speed and the overlays — 2026-09-18

- **A preview is a bounded rendition; an export is the capture.**
  - **Observed:** previewing a real 134-second take took 121 seconds, because every frame was
    drawn and encoded at the capture's 3120×1970. The person asked why auditing an edit takes
    that long.
  - **Decision:** preview renders at a 1600-pixel long edge, halving each dimension on this Mac:
    2× faster overall on the same take, 3.5× on the encode itself. The human video export keeps
    the captured resolution.
  - **Consequence:** the export no longer republishes the preview's file, so previewing and then
    exporting renders twice. Most of what remains in a preview is the evidence pass that decodes
    the whole source, which no bound touches; making that incremental is the next win.
- **Overlay panels are hidden from every capture, not only ours.** A whole-display filter can
  exclude applications macOS already lists as sharing something, and a menu-bar app showing
  nothing is not listed, so the countdown and controls could never be excluded that way after a
  take starts. They are marked unshared instead, which the window server honours from the moment
  they open. The cost is that another recorder cannot film them either.
- **The count happens before anything is allocated.** Escape during it abandons the start with no
  recording created, so a cancelled countdown leaves nothing behind.


## Word timing on real narration — 2026-09-19

- **A word's time is when it was spoken, not when the engine finished the sentence.**
  - **Observed:** the engine ends a sentence with a punctuation token of its own, placed where it
    decided the sentence was over — 630 ms after the last sound on a clip whose silence is
    digitally exact. The CLI merge this repository ports verbatim puts that token in the preceding
    word, so the word's span ran on through the silence, and a cut of that word took the silence
    with it.
  - **Decision:** a word now carries both times. The engine's own stay in the raw record, so it
    still compares token for token with the evaluated CLI; the span every read and edit is aimed
    by covers only the tokens that carry speech.
  - **Consequence:** sentence-final words tightened from about a second late to about 100 ms on
    the real take. Words with no punctuation are unchanged, because there was nothing to trim.
- **The boundary target is reported as missed rather than relaxed or chased.**
  - **Observed:** after that fix, hand-marked boundaries on this person's own narration give a
    median error of 135 ms against a 100 ms target and a p95 of 578 ms. Twelve of the fifteen sit
    outside the speech — starts early by about 180 ms, ends late — so a cut usually keeps its
    neighbours whole, which is what the narrator heard when they auditioned one. Three sit inside
    it by 60–100 ms, where a cut would clip a word, and two of those are endings the trim itself
    moved.
  - **Decision:** ship this and record the miss. Tightening it further means an acoustic detector
    deciding where speech is; on this narration, recorded while its narrator clicked and typed,
    every threshold that separated those from speech moved the answer by more than the thing
    being measured — and a detector that trims too far clips a word, the one failure a listener
    notices.
  - **For the user:** if cuts should hug the speech more tightly than this, that is the decision
    to reverse, and it costs the risk of clipped word edges. Nothing else in the release depends
    on it.
- **A word may not run into the next one, and core refuses a transcript where one does.**
  - **Observed:** the engine puts several tokens on one frame, so `I'm going` came back with the
    first word's span containing the second whole. A span is what a cut removes, so cutting `I'm`
    deleted `going` — from the media and from the transcript, with no partial word, no gap and no
    other trace that it had ever been said.
  - **Decision:** the worker clamps a word's span at the next word's start, and core rejects a raw
    transcript whose words overlap instead of storing one.
  - **Consequence:** a contraction's second word keeps only the time that is its own, which is
    already how every other word is treated. A future engine that overlaps words fails
    transcription loudly rather than quietly losing a word to a cut.
- **The measurement is hand-marked, and the pictures are committed.** Boundaries are drawn as
  spectrograms at a millisecond per pixel with a ruler, only where a real pause sits beside them,
  and the marks are millisecond offsets read off those pictures. Inside connected speech there is
  no boundary anybody can point at, so none is claimed.

## What a review of the finished surface changed — 2026-09-19

- **A run that is interrupted deletes its scratch, not only its apps.** One check records the
  whole display for two and a half seconds; a Ctrl-C used to leave that video of somebody's
  desktop in `/tmp` with nothing to remove it. Killing and deleting now happen in the same exit
  path, and a throw while burying an app no longer skips the deletion.
- **A launch owns its whole process tree.** The app owns a service and the service owns native
  media workers, so reaping direct children left a worker decoding half an hour of video while
  the run reported that nothing survived.
- **The local signing key is for signing.** It was imported with `-A`, which lets any program on
  the Mac use it without asking; it is now imported for `codesign` alone. An identity whose trust
  step fails is taken back out of the keychain rather than left untrusted to be imported again.
  **This person's existing key was created under the old flag**: recreating it is one command and
  their password, and nothing else depends on it.
- **This app's windows stay out of the take.** A preview window or a save panel opened while
  recording was captured into that recording; both are now unshared, as the floating controls
  already were.
- **What a person chose is not overwritten by what their Mac has today.** A selected microphone
  that is unplugged is remembered rather than replaced: takes use the system default meanwhile,
  the menu says which one it is waiting for, and the saved preference still names theirs.
- **A count that is running can be cancelled from the menu.** The row said "Start Recording" and
  did nothing while the three seconds ran; Escape was the only way out, and this app cannot
  always hold Escape.
- **Screen access says when it takes effect.** macOS answers that question once per launch, so a
  person who granted it and came back to an unchanged row had no way to know quitting was what
  was left.
- **A check that cannot prove its point says so.** The exclusion check compares how much the
  picture changed where the controls were against how much it changed everywhere; on a desktop
  with a video playing, that comparison passes whatever happened, so it now skips instead.

## Two capabilities the contract names and this release does not have — 2026-09-19

- **A relocated package plays its own edit, rendered beside its admission.**
  - **Observed:** the contract says a package answers the same inspection operations, and lists a
    playable revision preview among them. It did not: `preview.get` took a recording and nothing
    else.
  - **Three routes were tried and rejected before the fourth.** A package output is a descriptor
    the context hands the worker, and AVFoundation assembles a movie at a path — those do not
    meet. The derived cache is keyed by a recording that a package need not have. Copying through
    the archive seam would hand a package context a second workspace descriptor. Each of those
    bends an invariant that is there on purpose.
  - **Decision:** the movie is rendered beside the admission's own workspace, by a renderer built
    over the package's own evidence, and read through the lease the package already owns. The work
    occupies the package's job slot and stops when the package closes; the file goes with the
    admission, and the parent is cleared at startup, so a service that dies mid-render leaves
    nothing. No schema, no native change, no widened seam.
  - **Consequence:** a package preview is the same bounded rendition a library preview is, pointer
    overlay included, and costs disk only while the package is open. Two admissions of the same
    archive render twice rather than sharing one movie, which is the price of tying it to the
    admission instead of the cache.
- **A collision with macOS itself is now detected; a collision with another application still
  cannot be.** The contract says a collision disables the binding and shows a settings override.
  `RegisterEventHotKey` returns success for a combination that is already spoken for — this
  repository's own [two-process matrix](assets/recording-controls/shortcut-collisions.md) measured
  that — so asking the system is not an answer. What macOS has taken for itself is knowable: its
  enabled shortcuts live in one preference domain with their keys and modifiers, and a combination
  in that set is now refused before it is asked for, which is the common case a person meets.
  Another application's private registration remains undetectable by any public API, and
  registering exclusively would take the combination away from it, which is worse than not having
  it. The shortcut file stays the way out.
