# Native capture and media

This package owns platform capture and bounded media execution. The
[package manifest](Package.swift) defines targets and dependencies. The rule for
placement is the platform responsibility, not a second interpretation of edits:

- [Capture](Sources/YapCapture/README.md) owns selected inputs, the
  acquisition clock, source writers, journals and cursor geometry.
- [Protocol policy](Sources/YapProtocol) reads shared requirements and refusal rules
  without depending on platform media frameworks.
- [Media primitives](Sources/YapMedia/README.md) own physical support,
  descriptor containment and new-output publication shared by native consumers.
- [Pictures](Sources/YapFrames/README.md) and
  [audio](Sources/YapAudio/README.md) execute compiled plans.
- [Speech](Sources/YapSpeech/README.md) owns local engine execution and
  source-bound word timing.

The [composition compiler](../../packages/composition/README.md) owns project
meaning; the [core source owners](../../packages/core/README.md) own admission and
evidence identity. Native code consumes their explicit selections and requirements.

## Owned worker lifetime

The [wire boundary](Sources/YapWire/Wire.swift) owns native dispatch and
strict decoding. Request types are authoritative; unknown fields cannot silently
become ignored instructions. Retry meaning distinguishes a transient execution
failure from an invalid identity or occupied output.

A worker is owned work, not another service. Closing request input is not a parent
death signal: ordinary callers close stdin after sending. The
[parent watcher](Sources/YapNative/ParentLifetime.swift) observes process
exit and rechecks identity after registration to cover reparenting races. Service
cancellation terminates the worker; attempt ownership must therefore clean staging
even when native cleanup cannot run.

The private [CLI mode](Sources/YapNative/CommandWorker.swift) uses this
same parent watcher to own an argv-only child and its inherited process group.
Standard streams and source descriptors pass through unchanged; an explicitly
reserved output slot is replaced only by the requested allocation. A private
completion pipe follows caller descriptors and is closed on command exec. The
wrapper reports command status there and keeps parent watching active until
the service retires its group. The service
creates the group, retires it on cancellation or unexpected wrapper exit, and
waits for kernel absence before settling work; parent death retires the group
from the native watcher when the service can no longer do so.

[Recovery](Sources/YapWire/MediaRecovery.swift) restores each source's
proven support independently. Optional audio cannot shorten video extent, and an
unrequested track is different from an unexplained missing one. Library reconciliation
belongs to the service; recovery cannot manufacture completion or editorial intent.

[Normalized evidence export](Sources/YapWire/SourceEvidenceExport.swift)
streams original observations and integrity disposition. Journal record order is
not global source-time order; consumers index explicit clocks rather than inventing
movement or treating a completion claim as new media validation.

## External publication

[Publication](Sources/YapWire/PublicationOperation.swift) retains complete staged
bytes and the displaced destination until acknowledged. Cooperative publishers
share a destination-directory lock; replacements validate the displaced inode
and digest after the kernel swap. Confirmed replacement evidence outlives an
interrupted cleanup, and accounting measures each private inode once. Retained
swap symlinks contribute only their no-follow metadata length, never referent
bytes; they remain unknown displacement, not owned payloads.

macOS has no pathname swap conditional on an expected inode and digest. A
noncooperating same-user writer can race the final check, including by injecting
a symlink leaf: rename swaps the link itself without following its referent.
Such unknown displacement is a conflict, may leave new output visible without a
committed receipt, and stays retained. Recovery never rolls back over a possible
successor or removes unknown entries. This boundary is not protection against a
writer that ignores ownership.

## Verification

[Journal byte references](Tests/fixtures/journal-goldens/README.md) pin historical
normalization and receipts independently of reader implementation.

The [primary-camera fixture](Tests/YapCaptureTests/PrimaryCameraPublicationTests.swift)
substitutes prerecorded pictures at the input boundary and exercises ordinary native
finish, recovery and held-byte evidence admission. Run the capture test product with
`YAP_PRIMARY_CAMERA_PUBLICATION_OUTPUT` naming a new evidence directory; without
that override the case participates in the ordinary capture suite. The
[core admission probe](Tests/fixtures/primary-camera-admission.mjs) consumes that same
directory after building core, proving publication and normalized evidence survive
catalog reopen. Neither fixture opens a media device or requests capture permission.

The [native test runner](../../scripts/test-native.mjs) owns anonymous output outside
the child, including on failure or signal. Explicit evidence remains caller-owned.
Wire setup produces only required operands; numerical and public-boundary checks
keep separate owners rather than rerunning a full behavioral suite as setup.

The [verification guide](../../packages/test-harness/README.md) locates independent
references, platform reproductions and retained acceptance limits. Compile success
cannot establish physical device behavior, framing, synchronization or listening.

CLI callers may explicitly name inherited source slots for rewind. The private
runner permits this only for regular read-only files and seeks them to byte zero
before execution. Invocation-owned read leases avoid shared cursor races; omitted
rewind leaves admitted descriptors unchanged. No pathname is reopened to obtain
another read description.

CLI output allocation is explicitly requested in a reserved `/dev/null` slot;
the shared media primitive creates a new leaf through the inherited private
directory. Completion records its lossless device/inode, never final size or
media readiness. Source, directory and control slots cannot become output slots.

SDR correction runs once in the shared picture executor, using its established
extended-linear-sRGB context. The provider/OS recipe is part of render identity,
so caches, queued jobs and exports retain it through the existing admission and
replay contracts. Missing or different recipes refuse; they never select another
backend. Identity parameters skip their filters. Source profile admission and
final color conversion retain their existing owners.
