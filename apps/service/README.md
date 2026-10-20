# Local service composition

The menu-bar app owns this service process. The [canonical entry](src/main.ts)
composes the local listener, durable [core owners](../../packages/core/README.md)
and native execution. CLI, MCP and app controls call the same operations. Building
this composition does not install it or migrate a person's library.

## Acceptance and process lifetime

The app's inherited control pipe carries multiple framed requests; the private
socket accepts one request per connection. [Protocol framing](../../packages/protocol/README.md)
owns shared bounds. A complete request line is the acceptance boundary: waiting
for EOF would make a later disconnect invisible on a half-closed Unix socket.
Bytes after acceptance cannot roll back an already committed request.

Disconnect and deadline cancellation signal accepted handlers, which must drain
their asynchronous work. Transport performs no automatic mutation retries.
Correlated bounded failures remain answerable even when the handler's result is
too large for its original response channel.

EOF or broken control output closes the listener and settles owned work. Startup
reports readiness or a structured failure; the app does not hide failure behind
a second daemon or an endless restart loop.

## Update admission

Public updater commands belong to the app, which answers them on its own socket,
so the UI and CLI share one check, preference and inspection contract that keeps
working while this service cannot. The service refuses them with a pointer to the
app; it takes part in updates only through the private permit below. A one-shot
check leaves the automatic-update preference unchanged, and SDK replacement still
waits for existing work and CLI clients to finish.

The [admission gate](src/update-admission.ts) joins evidence from existing work
owners and transport lifetimes. Waiting for an update leaves ordinary operations
usable. A private preparation briefly fences new requests and either returns
blockers immediately or grants one service-owned replacement permit. Prepared
admission returns retryable `UPDATING` before acquiring product resources; no work
is canceled to make the service idle.

Only the inherited app control pipe accepts [update coordination](../../packages/protocol/src/update.ts).
Release is safe to repeat and never releases a successor's permit; commitment
requires the current permit. The native app supplies update status, which health
projects beside the running release version. Until an updater reports, update
status is unavailable. Installed runtime metadata supplies the assembled app's
version; standalone builds use the [app manifest](../macos/package.json), following
the [release version owner](../../scripts/README.md#versioned-github-releases).
An unavailable updater or disabled automatic updating does not imply an unhealthy
service. This gate provides no
bundle-replacement, code-signing or launch-lock guarantee by itself.

## One runtime owner

Never unlink a live listener's path. Recovery needs proof the prior owner is gone;
a refused connection is distinct from a reachable listener or a non-socket entry.
Startup holds an exclusive advisory lock for its lifetime before probing and
reclaiming a stale socket. The lock's inode remains stable so competing starters
cannot each create a different lock after observing the same dead listener.
Kernel lock release handles process death; a PID file alone cannot supply that proof.

The listener removes only the path it bound. A second unlink after close could
remove a successor's socket. Pre-existing runtime directories must already be
private and owned; startup does not repair arbitrary directories in place.

## Coordinating work without another domain model

Public asynchronous replies use the [protocol publication contract](../../packages/protocol/README.md#published-work).
The operation boundary exposes validated domain output; execution recipes and
serialized worker results stay with their internal owners.

The service turns admitted requests into work for existing owners. Pure
[composition](../../packages/composition/README.md) defines edits and compiled
plans; [native workers](../../helpers/mac/README.md) execute physical media work.
Authoring support and execution readiness are separate. Capability discovery
must report actual prepared/native requirements rather than inventing a fallback.

Work someone asked for always comes first. Jobs carry a priority: on the single heavy lane an
interactive job starts before any background job, a running job is never preempted, and
background work has its own bound outside the interactive limits and never waits on a
dependency, so it cannot hold an update. The one background producer today is the
[transcript backlog](../../packages/core/src/transcript-backlog.ts): every published recording
and real import records its audio streams, and the backlog submits them once the speech model
is ready, at startup or after preparation. Nothing waits on the model; an explicit request for
the same transcript joins the queued job and promotes it.

`service.health` remains a cheap listener-readiness check. Its model readiness comes
from preparation receipts; hashing a prepared runtime grows with its size, so that
stays with preparation, explicit `model.status` and execution. Startup preparation
follows the same rule: a model whose receipt and runtime inventory (paths, kinds,
modes, sizes) still match is ready without a rehash; anything else is verified and repaired. Explicit `service.tools`
discovery verifies the selected app's bundled tool receipt and resource hashes,
then probes its executable version and configuration under bounded work. Missing
or altered tools report unavailable without blocking native operation discovery.
Inventory is evidence about those binaries, not a promise of typed editing support.

Capture admission and donor retirement share one [source coordinator](src/capture-sources.ts).
A ready acquisition owns its media independently of its recording donor. Deletion
joins borrowers and unfinished native work before donor removal; a mutable path
or alias cannot replace the frozen authority already admitted.
A recording deletion checks project users before fencing the take. It refuses with
`IN_USE` details when a capture-origin copy is retained by a project; `cascade: true`
retires those projects, the capture copies, their assets and evidence, and the donor
directory as one durable deletion plan. An import made from inside the donor folder
is an independent acquisition and survives the recording deletion.
An idle device report proves closure only when it carries no take or source
identity. Contradictory or pending native evidence keeps deletion fenced and
source bytes retained rather than interpreting a shutdown request as completion.

[Export coordination](src/exports.ts) executes a pinned durable intent. Video,
standalone audio, plain caption sidecars and portable packages use the same
publication lifetime. Caption bytes are frozen at admission and need neither a
media encoder nor speech inference; an edit during delivery cannot replace them.
Audio-only export does not require picture preparation. Output format meaning
belongs to the composition settings owner, not another service allowlist.

Replacement trusts the recorded file identity and complete bytes, never just a
pathname or a formerly owned name. Imported-original identity belongs to the
asset owner and remains protected through aliases. The [publication owner](src/publication.ts)
retains its destination lock across native workers. Export work in one service takes
turns per destination directory, so only a publisher in another process sees it busy. The [native publication boundary](../../helpers/mac/README.md#external-publication)
explains what cooperative ownership can guarantee and why unknown displaced
entries survive a conflict.

Package extraction proves containment and retained resource identity. Adoption
also validates dependency meaning and owns managed copies. Inspecting a handle
alone does not create a project; adopted projects survive handle closure and donor
removal. [Portable resources](../../packages/core/src/project-package.ts) own the
retained evidence and prepared outputs required by project history.

The [worker lifetime](src/worker.ts) is shared by native JSON requests and argv-only
CLI execution. CLI progress cannot certify completion: zero exit, bounded output
and retirement of the owned process group are required before its caller resumes.
The existing native executable watches parent death for CLI descendants as well.
The [runtime materializer](src/runtime-materialization.ts) lends that same lifetime
to explicit model preparation. Core owns acquisition and inventory admission;
offline assembly needs the public pinned interpreter and system tools, without
borrowing developer-installed packages or creating a second downloader.
A rare kernel retirement overrun retains the owned task, logs after five seconds,
and observes slowly until the group is absent; it cannot safely release capacity
or staging merely because the standard streams closed.

The bundled Node release's libuv can corrupt parent descriptor bookkeeping during
Darwin process creation with inherited files. The shared worker selects its safe
fork path by retaining the same real/effective user ID for ordinary non-root
accounts; byte authority, account groups and retirement remain unchanged. This
workaround has no root or changed-identity execution guarantee. Remove it when a
supported bundled LTS release includes [libuv's remap fix](https://github.com/libuv/libuv/pull/5284),
after rerunning the inherited-descriptor and worker-lifetime checks. It is one
process-owner correction rather than a media-domain admission cap.

Service shutdown drains jobs, readers, publication, storage observations and any
preset refresh in flight before closing the catalog. The [release disposition](../../specs/done/agent-editing/release-closeout.md)
records installed evidence separately from an isolated service check.

[Selected-channel observations](src/source-channel.ts) share complete support,
channel and native PCM receipt admission. [Speaker observations](src/speaker.ts)
and [conditional alignment](src/alignment.ts) each retain their provider's narrower
window policy and invoke an explicitly prepared runtime through the shared process
owner. Alignment preserves the literal supplied text and computes correspondence
through the shared native ordered arithmetic. Raw operands survive failed attempts;
retained source pages never invoke inference. Execution is offline. Original
sidecar operands are captured before attempt cleanup, including model refusals.
`speaker.get` reads retained source generations or their revision projection without
native or model execution; `speaker.observe` alone requests new acoustic work.
`speaker.bind` replaces caller-authored display labels for one retained generation;
it never changes acoustic evidence or infers identity.
`speaker.continuity.prepare/get` own the long-form quality envelope separately: they
accept only complete measured candidates, retain frozen gate outcomes on refusal, and
never promote anonymous slots or labels.
Portable packages preserve complete original operands and observation ordering.
Immutable alignment pages name the original generation and open package context;
their continuations cannot be reused in another context. Reading or adopting them
needs no model execution or native decoder. Evidence admission and publication
remain with the shared core owners.
Read-only package projections share the source projection, coverage and merge owners;
immutable checkpoints use the existing package context jobs and disappear on closure.
The context's metadata and job budgets apply to these inspections as to adoption.

FFmpeg operands borrow the existing held source authority. Native media facts own
support, common origin and geometry; the [input boundary](src/ffmpeg-input.ts)
uses FFprobe to bind an explicit stream to held bytes. Optional declared-color
inspection supplements the same selected stream and preserves missing fields;
it supplies neither source clocks nor permission to convert. The verified native
probe-file owner also carries explicitly selected decoded-audio inspection without
changing receipt, held-source or attempt ownership. Ordinary asset probes omit it. The
[HDR interpretation checkpoint](src/hdr-conversion.ts) consumes fresh native
whole-track interpretation evidence and agreeing declarations. Its private
selected-stream producer derives an exactly representable common movie clock and
validates the held SDR derivative before consumption. Explicitly selected audio
is copied only when actual native decoded samples, format and clock remain
identical; the work budget covers the selected support union. Chapter and timecode
metadata cannot add unselected output tracks. The [managed conversion owner](src/asset-conversion.ts) exposes explicit whole-stream
`asset.convert` through existing jobs and asset staging. It retains original dependencies,
frozen implementation hashes and exact selected source/output evidence. Current verified
paths locate those hashes; saved work recovers before execution readiness checks.
Range/acquisition conversion is unsupported.
Offline self-contained
input and a dedicated read lease per invocation prevent pathname substitution,
secondary resource resolution and shared cursor surprises. Source slots are
explicitly rewound in the existing CLI owner; this never reopens the donor path.

The render-attempt owner initializes its private parent on first use, including
when portable adoption admitted assets without a prior native import. Existing
parents still undergo the same privacy, identity and lock admission; initialization
never repairs an unsafe directory. Startup cleanup can skip an absent parent.

Managed FFmpeg artifacts reuse the render-attempt lifetime. The
[artifact seam](src/ffmpeg-artifact.ts) reserves an output slot in the held private
workspace, then requires the recipe's domain validator before exposing a readonly
identified file to its consumer. Allocation identity is distinct from completed
media evidence; hashing follows retirement and validation. Native validators and consumers use the provided attempt-bound worker so native
children retain the same directory locks if the service dies. Existing admission
and publication owners remain responsible for durable delivery.

[Loudness analysis](src/loudness.ts) consumes the same validated retained PCM as
other acoustic inspection. It executes the selected bundled scanner through the
existing CLI lifetime owner and records meter identity. Empty scanner gates are
reported as unmeasurable; peak evidence remains separate from integrated loudness.
Measurement JSON is delivered through the same cache-backed lease owner as other
acoustic evidence; callers do not reopen private cache paths. A requested sample
ceiling or a scoped meter comparison is not a universal encoded
true-peak guarantee.

[Typed audio processing](src/audio-processing.ts) borrows the native domain
scheduler: native renders complete exclusive program/detector prefixes and
consumes identified held results. The service runs only the requested static
recipe against that PCM. Full-domain state makes an excerpt a crop of the same
processed signal rather than a cold processor restart. Recipe artifacts share
one render attempt; each retained external domain adds one service file descriptor
and an inherited/duplicated descriptor pair in the consuming native child. The
compiler's existing plan bounds and worker/job admission still apply; this cost
is not a global concurrency guarantee, and descriptor exhaustion refuses work
without publishing a partial signal.

Normalization and the limiter always publish their best result. Whole-domain
before/after meter evidence is retained, and measured postconditions become
issues on the published audio, derived from that evidence alone. When a gain-only
loudness target and the peak ceiling conflict, the ceiling wins and loudness is
reported unmet; an unmeasurable signal passes through at unity. Prepared reads
retain those full measurements, and their issues, even when a consumer requests a
short excerpt. Native and bundled
implementation identities bind the prepared recipe; neither discovery nor an
empty measurement authorizes another treatment. Audio preparation settles the
complete selected processing tap without picture work. Movie rendering resolves
matching retained final audio, or executes its full audio processing, before
starting expensive picture encoding; the movie and its export carry the audio's
issues. A prepared dry signal
or intermediate step never substitutes for that final mix.

Dynamic normalization rerenders the original complete prefix with fixed first-pass
statistics and unchanged requested targets. The shared correction policy bounds
candidate count, offset and measurable progress. Every candidate's measured result
is retained and stays held through correction. The delivered selection is explicit:
the smallest miss beyond tolerance, then the closest loudness, then the earliest. Scheduling budgets
account for these bounded traversals; retained final audio skips recomputation.
AAC delivery is measured separately after decoding, because a compliant PCM master
does not establish an encoded true-peak ceiling.

The compressor recipe carries explicit post-compression `makeupGainDb`; omission
is unity. Preview, prepared audio and export consume the same native-admitted
recipe. Bypass leaves dry PCM unchanged; makeup never becomes an implicit
loudness-matching or mastering request.

## Checks

The review surface is owned here as service routing over existing owners:
`inspect.open`/`inspect` resolves revision history and asks the native app to
show its shared preview, while `caption.propose` and `layout.diagnostics` stay
read-only and bounded. Native rendering, preview leases and export publication
remain with their existing owners.

The package test script runs every node test in [`tests/`](tests) against the repo's
debug native worker unless `YAP_NATIVE` names another. [`capture-source-lifetime`](tests/capture-source-lifetime.mjs)
is a lab, not a test: it certifies a pinned native build from `YAP_NATIVE_PINS` and
writes evidence to `YAP_LIFETIME_OUTPUT`, so it runs only when an evidence run supplies them.


`recording.get` exposes `completionReason: "maximumDuration"` when the take reached
the product duration limit. Cleanup diagnostics cannot replace that completion
fact. Service-authored terminal outcomes also take precedence over late reports
from the same native controller, after source identity is checked.

Capture-source import jobs report `CANCELED`, `OWNER_DELETED` or `CONTEXT_CLOSED`
when cancellation, deleted ownership or context closure ends their work. The shared
job projection and refusal ledger own retryability and any resolving call.
