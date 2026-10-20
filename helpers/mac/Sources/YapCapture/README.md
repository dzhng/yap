# Capture sources and acquisition evidence

[Native capture](NativeCapture.swift) owns device state and source production.
Discovery preserves identities without selecting, opening or authorizing a device.
Input preparation opens only the requested selection under existing authorization;
missing inputs refuse rather than silently choosing another. An omitted camera
selection touches no camera boundary. Pending SDK starts remain owned until their
replies are joined and each attempted resource is stopped.

## One acquisition clock

Delivered tracks share the host timestamp domain. The first usable primary
picture establishes source zero; preceding samples are omitted. Pauses remove the
same elapsed interval from every track, including late callbacks after resume.
An audio buffer crossing a pause boundary is omitted so paused speech cannot leak
through. Intentional omission and writer backpressure are different observations.

Screen, microphone, system sound and camera retain their independent source media.
Whole-system sound does not become application-only sound when a window is chosen.
Capture does not mix or retime those inputs. Submitted buffers can extend beyond
the finished file; submission statistics are not decoded availability.

[PCM normalization](CapturePCM.swift) changes representation without resampling or
reordering channels. Live callbacks may omit frame duration: the declared sample
rate supplies the frame grid, while the callback supplies the first timestamp.
Missing optional timing must not make otherwise usable narration interrupt a take.
PCM placement compares adjacent accepted callback timestamps on the native sample
grid. Small synchronization-clock residue must not accumulate into invented gaps
or make continuous input appear to overlap; actual gaps, backward overlaps and
pause exclusions remain distinct. The journal retains the callback timestamps
independently of their admitted placement.

Marks a person makes during a screen take (strokes while ⇧ is held, ⇧-click pins, plain
clicks) are capture evidence like the pointer, so they live in the same journal
with the same clock and geometry epoch. The [recognizer](MarkRecognizer.swift) owns the gesture
rules and stays free of AppKit; the writer feeds it modifier state and pointer readings, never
keys, and projects each point through the same placement cursor samples use. Undo appends a
retraction instead of rewriting the journal, so a published take still proves its prefix.

Take and stroke endings follow the shared
[requirements and derived-bound rule](../../../../DEVELOPMENT.md#limits-come-from-requirements).

A healthy ending can hold proven last-picture support through stop. Interrupted
capture stops at available support instead of fabricating a tail. Hidden windows
may deliver blank frames; pixel color cannot distinguish that from source loss.
Only the platform's interruption signal supplies that lifecycle fact. Interruption
seals the native clock and writers, then the app uses the same joined stop/discard
path rather than creating a second teardown owner.

Primary authority is an allocation role, independent of a physical camera or screen
source. The primary writer accepts usable host-time pictures; its ScreenCaptureKit
adapter separately owns screen completeness and geometry. Primary camera keeps the
ordinary packed journal without companion binding or camera proof members. The
companion camera keeps its device binding, independent origin and camera proofs.
Camera-primary narration uses the same AVFoundation session clock as its pictures;
optional whole-system audio uses the same audio-only ScreenCaptureKit stream as
screen capture. Only that requested system-audio path requires screen access.
Camera-primary capture without system audio reaches no screen or cursor boundary.

## Closure is separate from publication

Closed source descriptors retain physical media and journal authority after inputs
and encoders stop. Primary and camera publication can succeed independently; final
stop joins both before releasing authority. A ready sibling does not inherit the
other source's verification delay or failure.

The [source publisher](CaptureSourcePublication.swift) owns completion and recovery
authority. Camera verification can use private immutable checkpoints while capture
continues; encoded bytes or mapping metadata alone do not certify decoded pictures.
The closing checkpoint picture begins the next window. Physical
closure freezes final operands, and publication or discard joins remaining proof
work before releasing the journal. This does not establish a general Stop latency.

Admission binds complete frozen authority to the expected source and held canonical
members. A verified completion receipt and a recovered source have different
provenance. Neither a positive duration nor a copied locator can manufacture that
authority. A later journal append may preserve an earlier trusted prefix without
making its new payload part of the earlier proof.

## Camera off time is a gap

A companion camera can be turned off and on during a take. Off time is a gap in
the camera source, never a held picture. The writer records a picture only when
its whole host interval lies inside an on window, and each run of pictures starts
on a key frame so no run decodes from another. The raw movie stays continuous; the
canonical movie states each gap as an explicit empty edit, and verification
accepts a gap only where the mapping's runs place one. The mapping logs camera
callbacks only, so its size follows camera time and an off camera adds nothing;
screen and audio callbacks are the primary's evidence. Older mappings, including
those of release 0.1.33, also hold screen and microphone rows, which readers skip. The receipt keeps `support`
as the outer span and lists `gaps` only when there are any, so a camera that was
never turned off publishes the same receipt as a release that had no off time.
[CameraAvailability](CameraMedia.swift) is the one owner of that interval
arithmetic for publication, admission and recovery.

A reserved companion camera is open only while it is on. Each turn-on opens a new
session on the device and each turn-off releases it, so an off camera holds no
device and no light. Sessions that open again may describe the same picture format
differently; the writer accepts any compatible one and refuses a different size
before opening. Colour tags must keep matching, since one track cannot play two. A
turned-on session that delivers an otherwise incompatible picture ends its run: the
picture is not recorded and the camera turns off. Only the session whose picture
established the format interrupts the take by changing it. A camera that is off at stop and recorded nothing, whether never
turned on or turned off before any picture, leaves the take complete with the
camera unavailable; only a camera on at stop that never delivered interrupts it.
Ending the take while a turn-on is starting cancels that turn-on: its session is
released and the camera closes as if it had never been asked. Losing the device
while it is off is found at the next turn-on; losing it while on interrupts the
take. Turn-ons per take are bounded so the availability stays within what
publication and recovery accept.

## Journals and crash boundaries

[The journal](CaptureJournal.swift) owns record types, validation, ordering and
write durability. A torn final record is a crash boundary; malformed content or
broken sequence invalidates the following suffix. A clean ending alone does not
prove media completion. Streaming readers retain observations without materializing
an entire pointer history in memory.

Fragmented media can preserve a decodable process-crash prefix. A crash before the
opening fragment may leave none; these guarantees do not establish power-loss
durability. When the encoder flushed a reordered picture before earlier pictures,
the camera prefix ends at the first missing one. Keep raw journals and media
distinct from normalized evidence and publication receipts so recovery cannot
overwrite its own source authority.

## Cursor and geometry clocks

[Cursor geometry](CursorGeometry.swift) projects observations through the geometry
in effect when sampled, not when later written. Frame callbacks can describe an
earlier placement than the current frame, while cursor sampling advances separately.
Each observation must retain its matching geometry epoch; missing support stays
explicit instead of being filled with an invented movement.

AppKit's global bottom-left origin uses the display at the global origin, which
need not be the key window's main screen. Retain that display height with each
relevant geometry epoch so replay does not use today's monitor arrangement.
ScreenCaptureKit's content rectangle and scaling describe letterboxing as well as
resizing; fixed output dimensions cannot determine the source transform alone.

Outside coordinates remain outside rather than being clamped into the capture.
Pointer eligibility states captured-content support, while ScreenCaptureKit renders the pointer
into screen frames for playback. Bounded sampling reports missing observations instead of retaining an
unlimited backlog. Physical projection findings and remaining unmeasured source
modes belong to the [recording evidence](../../../../specs/done/recording-for-ai/README.md).
