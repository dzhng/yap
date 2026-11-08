# Media workflows

Read the sections relevant to the requested operation before execution. Discover
parameters from the installed CLI; these rules preserve media identity, clocks
and readiness across inspection, editing and delivery.

## Managed projects and processing

Discover the connected service's managed-project operations and pin the selected
project revision before editing. A recording supplies source facts; it does not
supply a composition revision. An unavailable operation is not permission to
reinterpret a project request as a recording edit. Use the connected service's
matching CLI and help: an installed launcher may expose older operation names or
parameter schemas than a development checkout.

Prepare imported media through the advertised asset/job operations before the edit
batch. For an existing captured-source directory, use the advertised acquisition
import/get operations to retain its journal and capture gaps. Wait for the import
job, then use its returned asset/stream bindings and explicitly set `acquisitionId`
on those clips. Omitting it uses physical file support. For synchronized placement,
convert each asset timestamp back to capture time by subtracting that binding's
`sourceToAssetOffsetUs`; do not independently zero every stream. Replacing media
selects a new complete binding: omitted acquisition means physical support even
when processing is kept.

Use `asset.get` to discover immutable stream headers and each stream's
`segmentCount`. Read full physical timing with `asset.segments`, preserving every
returned ordinal and empty gap. Follow the complete `nextCursor` until null; a
cursor belongs to its asset and stream. Headers never embed partial segment arrays.
The cursor is an opaque base64url string; send it unchanged in the next request's
`cursor` field and keep the collection plus `nextCursor` at the response top level.
These rows describe source media, not project time or newly inferred capture support.
Preserve returned fractional bounds and signed origins exactly when placing or
replacing media. To request complete raw audio, omit its range or use the discovered
exact bounds; flooring an endpoint can omit a final sample, and ceiling can exceed
support. Never independently zero streams that share a physical origin.

For imported speech, select the returned `assetId` and audio `streamId` explicitly
when requesting a source transcript; include `acquisitionId` only when you intend
its capture gaps. These ranges are normalized file timestamps, not project time.
Keep the complete returned cursor when paging or searching; changing selection or
generation requires a fresh read. The app prepares the default transcript model in
the background at install and update; ordinary calls use it directly. Every
recording and import is then transcribed automatically, each audio stream on its own,
at a priority that never delays your requests; asking for the same full-source
transcript joins that work. Call `transcript.transcribe` when a bounded or new
execution is required;
`transcript.get` and search inspect retained evidence and never run inference. If
an operation reports `MODEL_NOT_PREPARED`, ask the user before acquiring the
optional model/runtime, then use `model.prepare` and retry after it is ready. A
preparation's `sourceRange` limits primary
source ownership; its outer `context` expands decoding without extending that
ownership. A read's `range` only filters retained observations. Pin the returned
`generation` when reading bounded evidence; omitting it selects full-support
preparation, never the latest bounded take. For project reads, pass advertised
`sourceGenerations` pins to use bounded source evidence. Context observations and
boundary decisions remain in raw evidence; unowned decoded context is
`not_observed`, not silence or missing physical media.

Transcription decodes overlapping windows, explicit ranges included, and always
publishes; never hand-chunk a long source to get a transcript. Read the
generation's issues in `published.issues` on any ready source read (a project
read's `dependencies[].issues`), not only on rows: some anchor to no published
word. `boundary-unresolved` marks a word at a window seam that the
two windows disagreed on (`published` says whether it reached the transcript),
`timing-clamped` an estimate past the decoded edge, and `word-dropped` a token
the engine timed impossibly. Check those words against the audio or the raw
evidence; never repair word timestamps.

When the installed release advertises `transcript.review`, use it as the
agent-friendly bounded review operation. It is the convenience combination of
`transcript.transcribe` and `transcript.get`: call it directly to request the
selected transcription and preserve the normal rows, generation and continuation
it returns. If it reports `MODEL_NOT_PREPARED`, ask the user before acquiring the
optional model/runtime, then prepare and retry as described above. It never invents
words or edits a project. `transcript.get` remains the strictly read-only half of
that combination, while `model.prepare` remains the explicit, user-approved model
download and verification control.

The other convenience operations follow the same pattern. `caption.propose`
combines bounded `transcript.get` with caption drafting; `inspect.open` combines
revision resolution, history and native preview opening; `cursor.render` combines
`cursor.raw` with `frame.get`; `frame.batch` and `index.frames` batch repeated
frame/index reads; `index.get` handles scene/index preparation and the paged index
read; `transcript.disfluency.get` and `transcript.search` are filtered/search
transcript reads; and `audio.measure`, `waveform.get`, `spectrogram.get` and
`audio.pause.get` combine `audio.get` with their analysis. Call these directly
unless you need to control one of their lower-level stages.

Call the requested feature directly. If it returns
`unavailable:model_not_prepared`, read its model ID, purpose, download scope and
size, ask the user whether to download it, then call `model.prepare` only after an
explicit yes; poll until `ready` and retry the same selection. `model.prepare`
downloads/acquires and verifies the selected model/runtime; it does not perform
transcription, alignment, speaker analysis or voice generation. Supply verified
local sources when required instead of guessing temporary paths or installing
dependencies during reads. Keep incidental probes read-only. Diagnose
failed/canceled work before `job.retry` with the transcript jobId and surface the exact returned
reason when a retry still fails. Phrase search can cross accepted inference seams,
but cannot cross unavailable, unobserved or skipped source support. Preserve
overlapping estimates and zero-width instant pins as returned. Unfiltered source
enumeration retains all observations; explicit source/project ranges use half-open
membership. Never turn an instant into playable duration or treat overlapping
estimates as clean cuts. A source phrase cannot cross an inference segment.

When anonymous speaker observations are requested, call `speaker.observe` and
`speaker.get` directly. If the operation reports a missing model, ask the user
before using `model.prepare` to download its pinned model/runtime inputs. A
verified local runtime/model source may still be supplied when available. Select
one explicit source
channel and a complete caller-selected range of 80ms score cells, from 80ms
through at most 30 seconds, with the start on the 16k sample grid. Separate
windows are independent observations; slot numbers do not carry identity across
windows or sessions. A read selects the original `observationRange`; its `sourceRange`
only filters display and never requests inference. Keep generation, source pins
and returned exact endpoints. Slots are anonymous and local to each observation;
simultaneous slots may overlap, and raw scores are uncalibrated. Unavailable or
unobserved coverage cannot be described as silence. Continue empty pages while
a cursor exists. Read-only generations remain usable without the local runtime.
Use only source/project selectors advertised by the installed release. Project
reads project retained source intervals through a pinned revision; unobserved
regions are explicit and the read never schedules acoustic inference. When package
reads are advertised, the opened handle supplies the same source/project evidence
without adoption. Poll any returned metadata job with the same query, preserve its
cursor, and treat closure or restart as expiration of that handle.

For speech as it appears in an edited project, request the project transcript at
the intended revision. Rows identify each repeated/retimed clip occurrence and
retain exact source/project fragments. A query window selects words; it does not
trim their editorial fragments or change whether the edit cut a word. Preserve
fractional timestamps instead of rounding them into edit boundaries. Keep the
complete continuation, including across empty pages; it pins the original revision
even when the head changes. If evidence expires or changes, start a fresh query.
Project retry rebuilds the query manifest only; diagnose and explicitly retry any
failed source dependency using its returned selection. Use project phrase search
only when advertised; source search cannot stand in for edited speech order.

For fresh recognition of what an edit produced, discover `transcript.render.prepare` and
select the exact revision, tap, range and PCM rendition. This convenience operation
combines `audio.extract` with fresh rendered-speech recognition; prepare required first-class
speech models through the advertised model operation. Keep the returned rendered
generation and read it with `transcript.render.get`; preserve PCM origin, model
provenance and both PCM/project ranges. These reads need no inference. Diagnose
failed/canceled work before `job.retry` with the returned jobId. Missing source support refuses rather than reading as silence; the
refusal names the gaps, so select a range on one side of them. Fresh ASR may complete
a clipped word: compare it with source evidence and inspect actual boundary audio
before deciding that a join is clean or defective.

For any paginated project inspection, including raw cursor/event reads, keep the
first page's full `dependencies` array for that query. Continuations
return `dependencies: { manifestId }` for that same query, even on the last page.
If you need the full metadata again, repeat the original first-page request with
the same pinned query and verify its manifest identity before reusing it with a
saved cursor. Changed/expired evidence requires a fresh traversal.

Read the target stack, then set its entire ordered list through `edit.apply`.
Keep existing step IDs when changing order, settings or bypass, or adding neighboring
effects; omit IDs for new steps or copies to another target so they get independent
IDs. Read `processing.capabilities` for each processor's supported targets, acquisition
requirements and execution readiness before choosing its scope. Parent stacks process
combined results; an exception needs a compatible clip treatment or separate track,
not an inherited override. Authored settings with execution unavailable are not
processed audio/video. Verify returned settings separately from rendered
media, and report whichever stage is still unavailable.

For advertised `sdr-correction`, choose exposure, contrast, saturation and source
neutral white balance explicitly. Use advertised shadow/highlight recovery for
separate tonal shaping when a global contrast change crushes the subject before
controlling a bright background. Zero recovery leaves that tonal treatment off;
do not infer a request from measured regions. Neutral Kelvin/tint describe the illuminant the
processor corrects toward its neutral reference; they are not a warmth slider or
camera calibration. Start from identity, adjust one cause at a time and compare
the same dry/processed frames at the intended viewing size. Settings apply in the
ordered stack, so moving the step can change its input. Preserve the native recipe
identity and refuse unavailable execution rather than substituting another grade.

For an explicit HDR-to-SDR conversion, inspect `asset.convert` help and select
the immutable asset, one whole video stream and any audio stream to preserve.
Use the advertised frozen recipe; do not invent exposure or color settings.
Poll the shared job and inspect the returned derivative, stream IDs and clock
mapping before placing it. The original remains intact. Trim or place the
derivative through ordinary edits; conversion does not accept excerpt/acquisition
selections or create an HDR export. An unsupported source remains a refusal.

To retain a lossless processed mix, call `audio.prepare` with an explicit project
and revision. Omit the tap for the complete final mix, or select the same processing
tap used for inspection; preparation retains whole processing-state domains rather
than a cold excerpt. Use it to settle requested normalization before spending time
on video encoding. A dry or intermediate preparation cannot substitute for the
export's final mix. It does not edit the project. Pin that
selection while polling; use `job.get/retry/cancel` for its attempts rather than
expecting a repeated request to restart failed or canceled work. Read the published
audio asset ID, discover its stream with `asset.get`, then inspect it through the
ordinary audio/waveform/spectrogram operations. Unavailable processing still
refuses; preparation does not make an unverified denoiser or retimer executable.
Preserve the preparation receipt's unavailable-support information; rendered zero
samples do not by themselves prove recorded silence. A stateful processor
(denoise, limiter, normalization) never runs over a hole in its input: it
restarts after the gap, and the output carries a `support-gap` issue naming the
gap and the split steps. Expect a level or noise-profile change across it.
Speaker and alignment inputs need one contiguous supported span; their refusal
lists the `available` runs to choose from.

Normalization and limiting always publish their best result. When a gain-only
loudness target would push the true peak past its ceiling, the ceiling wins and
`normalization-target-unmet` reports `peakToLoudnessDb` (true peak minus
integrated loudness) and `maximumFeasibleTargetLufs` (ceiling minus that ratio).
Dynamic mode reports its selected attempt and why correction stopped;
`limiter-ceiling-unmet` gives the measured peak. Accept the result, or re-target:
ask for at most the feasible loudness, or reduce peaks earlier in the stack. Taps
upstream of the output stack (dry, after-step) never carry these issues, so
measure there while choosing targets.

To keep an independent excerpt, discover `audio.extract`. Select an admitted
asset/stream (and acquisition when applicable) in source time, or name an explicit
project revision, project-time range and processing tap. Set the output rendition's
rate and mono/stereo channels; use mono 24 kHz for a voice reference. Omit the raw
source range only when acquiring its complete audio. Complete matching Float32
WAVs preserve their original bytes; conversion uses exactly the selected PCM and
reports its actual frame count. Poll the pinned request, use `job.retry/cancel`
explicitly, then keep the returned asset/stream and the specific extraction origin.
Inspect the retained asset before deleting a donor project. Its provenance remains
historical after donor deletion; identical bytes can have several origins, so never
infer one from the asset ID or silently choose another origin. Missing-support
metadata remains evidence, even if filtering spreads neighbors into selected zeroes.

For an inserted pause or replacement, keep ambience treatment an explicit editorial
choice. To retain background sound, inspect a quiet source range, acquire it with
`audio.extract` when independent retention is needed, then place it as an ordinary
audio layer. Fill longer intervals with explicit repeated occurrences; set gain
and overlap fades deliberately. Low waveform energy or absent transcript words do
not certify speech-free room tone. Extraction does not separate noise from speech.
To reduce background noise instead, choose the processing target and supported
noise-reduction settings through the existing stack. Neither workflow implies the
other: do not automatically denoise, add ambience, or switch policy when a sample
is unsuitable. Verify the requested treatment in context and preserve originals.

For replacement speech, discover `voice.generate` and the registered model's
`generationProfile` through `model.list`. Supply a retained mono24k Float32
reference, its exact transcript and the desired text; do not choose wording or
infer a transcript. Echo the specific reference origin when one was selected;
omission explicitly selects none. Defaults come from the immutable profile, with
supported overrides and a decimal-string seed. Keep requested/effective settings,
exact frames and completion evidence from the result. An incomplete token-budget
result is a failure, not usable finished speech.

Repeat the same request to recover saved output before considering preparation;
existing output remains usable with model/runtime files absent. New execution
requires explicit model preparation, and failed/canceled work uses `job.retry`.
Generation retains its reference bytes and never edits a project. Inspect the
saved asset, then use ordinary `edit.apply` for explicit placement/replacement and
fit, preserving compatible target processing. Room tone, overlaps and transitions
are authored choices. Render before/after context and undo; byte equality proves
preservation, while pronunciation, voice identity, level and joins still require
separate listening judgments.

For animated processors, use the supported number-or-curve fields in the existing
stack. Clip curves default to normalized clip time; parent curves use project
microseconds. Preserve returned `window` and `evaluationRange` when changing an
existing step. Structural edits retain its original clock, so re-read the edited
settings instead of rebuilding the curve from a preview range. For gain changes,
compare bounded dry/after-step/processed WAVs before judging level or joins.
For denoise strength, use its advertised mix control and ordinary keys. A zero
mix restores the immediate upstream audio; it does not mute the clip. Keep one
continuous processor through a fade instead of inserting bypasses that change
learned state, and inspect both dry neighbors and the processed transition.
After denoise, render speech on the dry and processed taps and diff the words.
For a word that changed or vanished, compare `waveform.get` on both taps over its
range with buckets of about 20 ms: denoise spares a word's loud middle and takes
its onset and tail with the noise, so one level over the whole word hides the
loss. Lower the mix over that word only when the caller wants it back.

For a spoken cut that should shorten picture and sound together, select both
media clips and name both tracks in the ripple scope. A cut adds no implicit
audio ramp: author the intended join with existing gain curves or fades, then
compare the complete delivered audio and verify undo. Do not infer filler bounds
or repetition intent from the fact that an edit is executable.

For a simple fade or uniform zoom, discover the `fade`/`zoom` variants in
`edit.apply`. Choose explicit start/end values and an anchor window. Fade requires
an audio/video choice even at output. Use whole microseconds for project/source
convenience endpoints; normalized clip windows use fractions. Zoom accepts crop, rectangle, fit, pivot and
rotation for its new geometry step. These append ordinary steps: inspect the
returned full stack and keep existing IDs when editing or bypassing them later.
Outside the window the new step is dry; an interior fade-out returns to full level
at its end. To remain faded out, author ordinary keys through the intended end.
Pair fades on already overlapping tracks in one batch for a crossfade; arrange
overlap yourself and inspect the result. Audio sums while video uses alpha-over,
so opposing ramps do not promise constant perceived loudness or brightness. Zoom
consumes the preceding image in stack order; inspect existing geometry before
choosing its crop and rectangle. Retimed delivery still requires advertised
executor readiness.

For an explicit font dependency, import the local font file through `asset.import`
and wait for its job. Read `asset.get.fontFaces`; pair the immutable asset ID with
an exact returned PostScript name when choosing a face. A collection contains
multiple faces; do not choose its first entry implicitly or look up an installed
font with the same name. `asset.list.fontFaceCount` identifies fonts without
advertising playable media streams. Admission preserves the font bytes and names;
use caption/render operations only when advertised, and verify glyph coverage and
actual rendered text separately. Importing a font does not install it globally.

For literal captions, discover `place` with `source.kind: "text"` and `text.set`
through `edit.apply`. Supply the literal, exact imported font face and every style
field. Put text on a video track and choose the existing project, content or
normalized clip anchor according to what should move with an edit. Text has no
media stream or source clock. `text.set` replaces the text/style while preserving
placement; it does not change a source transcript.

The text box is a transparent source raster. Set an explicit geometry rectangle
when its font pixels must map one-to-one to output pixels; ordinary fitting may
scale it. Inspect the returned layout and the actual `frame.get` PNG for clipping,
glyph coverage and contrast. A font name or echoed string does not prove visible
text. When the pinned face lacks a character, the frame still renders and reports
it: `font-substituted` when another installed face drew it, `glyph-missing` when a
placeholder box was drawn. Each names the requested face, the face used and the
code points. Keeping that output or choosing another admitted face or literal is
your call. PNG output preserves canvas alpha;
H.264 preview/export still requires opaque final pixels, including timeline gaps
and output processing. Verify text after structural edits and package relocation.

To seed captions, read a pinned project transcript and choose explicit cue groups
from individual occurrences. Call `text.seed` with each group's source selection,
generation, occurrence clip ID and exact word ordinals/source ranges, plus its
separator, style, target video track and anchor domain. Use original source word
ranges for the pins, not projected project fragments; partial words keep their
verbatim text while placement is clipped to the chosen occurrence. Review and
correct display text explicitly. Repeated speech has distinct occurrence clip IDs
even when it shares one source generation. Save the normalized placement/labels;
seeding is one atomic edit and replay uses the same request and expected revision.
A cue containing only instant observations has no inferred dwell: retain those
pins and author literal text with an explicit extent if a caption is requested.

Seed origin is immutable evidence separate from display text. Split/copy and
`text.set` preserve it; the original clip may later disappear. New seed claims
require an occurrence in the pre-edit revision, so re-read the project transcript
after structural changes before seeding again. Referenced source generations,
media, acquisition context and fonts stay retained through history and packages.

For visual layout, change the canvas for the output aspect ratio and place overlapping
footage on separately ordered video tracks. Place imported PNG/JPEG images with
`source: { kind: "hold", atUs: 0 }` and a project placement duration; that zero
selects the whole image, not a sampled instant. Images use the same geometry,
opacity, target taps, previews, exports and retained project indexes as footage.
Use advertised geometry/opacity steps;
changing an inspection size does not change the edit. Geometry uses top-left pixels:
the first clip geometry consumes the oriented source, later geometry and parent
stacks consume a canvas-sized image. Read admitted source dimensions before cropping.
Use the destination rectangle for position/size and choose contain or cover to
preserve aspect; stretch deliberately distorts it. Preserve independent audio clips
when changing picture layout. Inspect the processed output and relevant target taps,
including every layer's picture provenance. Parent opacity affects the combined
picture, so it is not interchangeable with opacity on each child. H.264 delivery
requires an opaque final canvas; report an unsupported transparent movie request
rather than silently adding a background after the output stack.

For externally rendered motion graphics, import a finite movie through ordinary
asset admission, then place its admitted video stream as a layer. A supported
ProRes 4444 alpha source can preserve transparency in composition; this does not
advertise transparent final movie delivery. Verify alpha over both light and dark
backgrounds, orientation, exact first/last sample support and the local animation
phase after trims, repeats or retiming. Keep the original movie in editable
packages; the external authoring project is separate task material.

For audio inspection, choose the source stream or a pinned project deliberately.
Source selection uses asset/stream identity and optional acquisition; its range is
source time. Project audio uses project time and defaults to processed output.
Start with a bounded range. Read the target stack to select a dry, after-step or
processed tap using returned target/step IDs. Dry skips only that target's stack;
its children remain processed. Child taps exclude ancestors. Compare the same
pinned range across taps to isolate level or processing changes; do not normalize
or judge a join's sound merely because rendering succeeds. Preserve the returned
sample clock, channel layout and unavailable ranges when analyzing delivered WAVs.

For waveform inspection, reuse the same source/project selection, range and tap.
Read the delivered JSON file, not just its readiness receipt. Start with the
automatic overview, then narrow the range and set bucketFrames for short sounds.
Preserve its sampleRate and absolute sampleRange; a ranged excerpt does not reset
the clock to zero. Compare channels separately and account for partial edge
buckets and unavailable support. Min/max/RMS can locate energy changes but cannot
prove silence, speech boundaries or a natural join. For a visual view, request
format:image and open the delivered PNG. Use spectrogram.get on a short window to
inspect frequency content; narrow the range or adjust the advertised resolution
when a limit refuses the request. Read each channel's axes and scale before comparing
images. Incomplete FFT warnings can reflect missing audio outside the displayed
range; inspect the returned context as well as the visible support. Pin the project
revision while polling. Explicit acoustic retry recovers its prerequisites;
ordinary reads do not restart canceled or failed work.

For picture inspection, choose a raw source stream or a pinned project before
requesting frames. Read the admitted stream kind first. For a raw PNG/JPEG image,
use assetId and streamId with optional maxLongEdge; omit atUs and acquisitionId.
The delivered PNG is already upright; its receipt retains the source orientation.
An image has no sample clock. Timed video requests use asset/stream identity,
optional acquisition, and source time; do not add a recording or project revision.
Frame batches remain timed; inspect multiple images individually. Project requests use
project time and the inspected revision. The returned global project sample can
precede the requested time; preserve its sample time, visible range and occurrence
provenance instead of treating it as a wrong frame. `atUs` is the request instant;
`frame.visibleRange` is the full interval displaying that project frame. Authored
clip edges can fall inside a displayed frame; use the sampled frame and its range
to describe visible changes, rather than assuming an edit edge is a new picture.
A raw source image excludes
project processing, crop/zoom and capture overlays. An unavailable source gap is
missing evidence, not a black frame. Poll the same selection while processing;
inspect failure before `job.retry` with the returned frame jobId. For batches, preserve per-item order
and errors, and deliver only ready pictures. Check the returned dimensions and
sample identity; an inspection size bound does not author a crop or aspect ratio.

When the installed release advertises `cursor.render`, use it for the visible
pointer trail during feedback review. It follows the same source/project selector
families and pinning rules as `cursor.raw` and frame delivery, accepts explicit
frame times and `trailUs`, and is read-only: its render plan is ephemeral and does
not add a `processing.set` step. Poll the same pinned request and use `job.retry` with its returned jobId, preserve
per-frame errors and delivery receipts, and treat absent/off-crop/gapped pointer
coverage as evidence. Use `cursor.raw` for exact coordinates and capture events;
`frame.get` remains intentionally overlay-free.

For a storyboard, choose a source index for raw footage or a project index for the
edited composition. Source selection uses asset/stream and optional acquisition;
project selection pins a revision and optionally a video tap, defaulting to processed
output. Project indexes cover the whole revision, including holds and background.
Poll the same selection while preparation is pending; inspect terminal failures
before `job.retry` with the returned index jobId, which also recovers retryable prerequisites. Read
`index.coverage` as well as entry pages, following every returned cursor. Fetch
images using returned complete references; do not
reconstruct their revision, generation, tap or size. Preserve per-image batch errors.
A ready index can contain zero images. Project coverage proves only each delivered
frame's sampled visibility; unproven intervals do not establish unchanged pictures.
Use direct frames or a preview to investigate those intervals. Source support gaps
are known exclusions, while unavailable observations remain missing evidence. Source
indexes exclude project edits; measured source scenes are not authored project cuts.

A range that runs past its source or project is clamped to the part inside it: the
result carries a `range-clamped` issue with the requested range, the applied range
and the bounds, so read the applied range rather than assuming the request. A
range with no part inside refuses with `INVALID_RANGE` and names the bounds.
The issue is always in the result's own `issues`, recomputed for each request,
never stored with an output: work is keyed by the applied range, so a range past
the end shares the output a request for the applied range gets. That holds for
reads, a transcription `sourceRange`, rendered recognition and project
alignment alike; `--wait` keeps the clamp on the read it settles with.

For timeline inspection, use advertised `timeline.events` reads. Video scene changes
need a selected asset/stream, not capture metadata; add acquisition only to apply
its support. Source ranges use source time, while project reads use the pinned
revision and identify repeated/retimed occurrences. For whole-project inspection,
omit the range or derive it from the inspected revision, never from source duration.
A partial query cannot establish every occurrence or gap. Preserve exact physical sample
clocks, projected times and first-page coverage. Follow every returned cursor,
including empty pages. A scene change is measured source evidence, not an authored
project cut; unsupported categories remain unknown. Initial reads may prepare
scenes: inspect returned dependencies/jobs, poll the same selection and explicitly
retry failed/canceled prerequisites using the advertised job operation. Retrying a
project query alone does not repair its source dependencies.

In project event results, distinguish editorial cuts from measured source scenes.
A cut reports a track-local source-mapping transition: inspect both sides, exact
project time and audio/video plane. Entrances/exits can belong to an overlay while
underlying tracks continue. Pure splits add no cut; rate changes can, without
proving an audible or visible discontinuity. Project cut authority comes from the
pinned revision, not a source generation. Keep availability gaps separate and do
not infer missing capture metadata from an empty cut list.

For capture-specific cursor, pause, geometry and interruption evidence, use an
explicit acquisition binding; a scene row does not supply capture provenance.
Keep original capture times alongside source/project times. Unavailable metadata
is not evidence that nothing happened. Raw cursor coordinates do not simulate the
edited crop or zoom. Capture-end interruption markers close their supported range;
follow the operation's boundary rules rather than treating every event as an
ordinary half-open point.

Use project time for a managed preview range. Keep the returned revision and range
when polling so a concurrent edit cannot change the result. After replacing only
audio or video, inspect both planes: the requested replacement must change while
the protected plane keeps its source and timing. A downloaded preview is a viewing
artifact; it does not establish that a durable export intent has published.

For a final audio file, inspect `output.capabilities` with `kind: "audio"`, then
use project `export.create` with `kind: "audio"` and pin the intended revision.
Choose the advertised standalone format in `settings`; omission selects the
lossless project WAV rendition. AAC/M4A settings explicitly choose output rate,
layout and encoding controls. Audio export works while video remains; removing
video is a separate undoable edit only when the user's task requires it.
Poll the same `exportId` until `ready` and deliver its actual output path.
Preserve the original request for replay/retry; changed settings need a new export
identity. A ready `audio.get` rendition is inspection audio, not a published export.
Do not substitute video output, raw source audio or an unsupported codec.

Before choosing project video delivery settings, inspect `output.capabilities` and
operation help. Presets are defaults: override individual controls or pass the
returned resolved settings. Keep canvas dimensions/frame rate in the composition.
Read the actual encoded profile/level and audio format in the result; requested
average bitrate is not measured file bitrate. Preserve the original request for
export retries, and report unsupported combinations instead of silently substituting.
When selecting an encoder, inspect its own control availability and the discovered
AAC format choices. For controls that advertise it, explicit null leaves the encoder
default instead of requesting an unsupported preset value. Required selection
constraints must be honored; preferred selection can fall back as documented.

Choose H.264 or advertised HEVC deliberately for an MP4 delivery. HEVC uses its
own settings; do not carry H.264-only entropy/profile/level controls into that
request. Current core video delivery is opaque Rec.709 SDR; HEVC alone does not
make an export HDR or transparent. Check actual codec, color, duration and A/V
alignment in the receipt and delivered file. An unavailable HEVC encoder refuses;
changing codec or backend is a new explicit choice.

## Extra media tasks

Before a direct FFmpeg task, check selected-app media readiness with `service.tools`,
then verify both `yap ffmpeg -version` and `yap ffprobe -version`.
If either command is unknown or fails argument parsing, follow
[launcher refresh](installation.md#refresh-the-media-tool-launcher) from a verified
release kit and repeat verification. App updates can leave an older external
launcher in place. Discover the required filters and codecs from these bundled
tools; consumers need no separate FFmpeg installation. A missing service or tool
is an unresolved prerequisite, not an executable path to guess.

Write a new standalone artifact and retain the source. For a requested edited
project, first obtain the pinned managed delivery to use as conversion input.
A direct output never replaces a failed managed export. Verify the actual file
before delivery; tool exit success alone is insufficient.

For GIF, inspect playback, dimensions, actual frame delays and duration. GIF stores
hundredths of a second, so some frame rates require rounding; an exact project
clock does not establish exact GIF timing. Keep that difference visible.

## Editable project transfer

For an editable project transfer, discover `export.create` package support and
poll its durable export intent until `ready`. Open the resulting ZIP, inspect
`package.status`, then explicitly adopt it with a stable request ID. Poll the same
adoption request; its ready result supplies durable project/revision IDs. Use those
IDs for history, rendering and edits. Opening alone owns a temporary package
handle; closing it cancels unfinished adoption but preserves a committed project.
Omit the revision to transfer the current head, or select an explicit historical
revision to transfer that moment and its history/undo stack. Later donor edits are
excluded from the historical package; exporting does not change the donor. Report
unsupported dependencies instead of dropping them or substituting a flattened
movie. Verify the adopted project's playback and undo before presenting a transfer
as complete.
