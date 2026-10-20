# Shared physical media primitives

This module owns the native meaning of media handles, time support, failures and
new-output publication. Capture, recovery, picture and audio consumers share these
rules so the same bytes cannot acquire different availability in different workers.

[Failure verdicts](../YapProtocol/RefusalLedger.swift) are the app and workers' single Swift reader of the
protocol ledger. Native diagnostics serialize the code and message; consumers derive
retryability, retry delays and the plain-language cause people see from that code.
Executables inside an app require its bundled service ledger; source-built tools and tests read
the checkout's authoritative JSON directly.

## Held authority beats a mutable path

Storage operations use inherited descriptors and retained file identity, then
walk contained members without following links. Reopening a pathname after
admission could select another inode. Locks on a shared open-file description
remain held while inherited copies survive; a crashed worker cannot release the
parent's retained authority. The [wire descriptor owner](../YapWire/Descriptors.swift)
owns transfer admission, while shared scans and removal stay descriptor-relative.

[Native media inputs](MediaInput.swift) retain a regular-file descriptor for both
ordinary source paths and inherited handles. AVFoundation borrows positional reads
from that authority; preparation and later decoding never reopen the source path.
Logical read accounting includes ordinary paths and remains distinct from physical
disk traffic. Still-image loading and generated-output validators have their own
contracts; this input owner governs native timed-media source consumption.

[Exclusive allocation](ExclusiveFile.swift) creates a single new leaf through a
held private directory. Both new-file writers and the private CLI runner use it;
a stale locator cannot redirect allocation.

[New-file publication](OutputFile.swift) stages privately beside an output and
publishes exclusively. An existing destination or source alias must never be
replaced. A killed worker can leave staging, so its attempt owner supplies cleanup.
A retained candidate can remain available for explicit recovery; closing handles
is not permission to delete an unidentified replacement.

Durable destination publication is a separate acknowledgement protocol in the
[publication owner](../YapWire/PublicationOperation.swift). A successful
native write cannot substitute for its committed receipt. Archive work uses the
[OS libarchive binding](../CLibArchive/README.md), with admitted member identity and
file-version checks rather than trusting a donor name.

## Presented support is not packet timing

Asset and stream clocks map through edit-list segments. Empty edits and decoder
padding cannot count as acquired sound or pictures. A final picture has no successor
from which to infer duration; explicit sample-cursor support is required. The gap
to the previous picture is not an alternative tail oracle.

Probing describes original bytes and bounded timing summaries. Successful metadata
inspection does not establish actual decoding or canonical capture authority;
those belong to their source and execution consumers.

Video probes retain exact first/last presented time and the actual final sample's
support separately from rounded summaries. A streaming digest retains exact
ordered presentation starts and durations, including repeats and gaps; its only
normalization is uniform translation from the earliest occupied segment start. Conversion validation must use fresh
held-source facts, not cached summaries or packet timing. Per-format color
[declarations](MediaProbe.swift) preserve absence as null, malformed color types
and special interpretation extensions. A range default is a consumer policy,
never a fabricated source declaration. Native picture admission consumes these
same facts; HDR conversion does not broaden default SDR admission.

Explicit compressed [inspection](CompressedVideoInspection.swift) inventories every
native decode packet, including hidden preroll, through the held asset. Missing
inspection is never evidence that interpretation metadata is absent. Its bounded
HEVC payload inventory includes out-of-band codec configuration and reports
refused and incomplete interpretations; it does not replace the presented timing digest or declare decoded appearance correct. Normal
admission does not request this work. Whole-track inspection borrows the existing
streaming read purpose after bounded metadata discovery; ordinary metadata keeps
its finite byte allowance. Codec atom names remain separate declaration evidence because a dynamic interpretation may live in a packet even when the
sample description has only ordinary codec configuration.

A sample's native storage locator must resolve to its primary asset.
Matching format and timestamps cannot authorize an external MOV data reference.
Ordinary probe admission traverses chunk-storage metadata, including hidden and
audio chunks, without reading packet payloads. Shared input construction forbids
external media references during decoding; the explicit compressed scan additionally
checks the same storage ownership before buffer generation. The platform restriction
does not itself make ordinary metadata loading refuse a reference movie. Loader failures retain
their underlying bounded-work refusal instead of losing that evidence behind an
AVFoundation wrapper error.

Explicit [decoded-audio inspection](DecodedAudioInspection.swift) observes native-rate
PCM emitted by the retained decoder without a requested range, resampling, edit
mask or synthesized padding. Emitted frame counts and exact run positions are
decoder observations; compressed packet capacity and a renderer's requested
quota cannot substitute. Decoder-supplied silence in an empty edit is not physical
occupancy. Priming/edit treatment is observed through emitted frames, not assumed
from packet capacities or absence of residual trim attachments. Residual trim attachments remain an unqualified contract rather
than being silently applied twice. Declared segments remain separate: a caller
must qualify the observed runs against occupancy before preserving their clock.
The PCM digest identifies this decoder's output; it is not identity with a lossy
source's independently authored pre-encode samples. Ordinary probes never request
this scan.
