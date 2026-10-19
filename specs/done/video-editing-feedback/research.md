# Research and replication gates

Research informs candidate experiments. It does not establish local execution, model quality or permission to install dependencies. [Source receipts](assets/research/sources.json) record fetched URLs, byte hashes and retained excerpts. Mutable upstream documentation is frozen by its observed hash.

## Speech

The repo pins FluidAudio 0.15.7 in [the native package](../../../helpers/mac/Package.swift). Its [token merger](../../../helpers/mac/Sources/YapSpeech/WordTimingMerger.swift) already distinguishes spoken and recognition spans and adjusts overlap. The pinned upstream CLI grouping is retained in [the timing excerpt](assets/research/fluidaudio-timing.txt).

[WhisperX](https://github.com/m-bain/whisperX) separates ASR from phoneme alignment and documents unalignable dictionary tokens, language-specific models and imperfect diarization. These are constraints to test, not endorsements of a provider or sponsored accuracy claims.

[CTC segmentation](https://github.com/lumaku/ctc-segmentation) requires CTC emissions, vocabulary/blank semantics and a correct frame duration. It is not a standalone recognizer. A TDT token sequence cannot be substituted for CTC logits.

[Newer FluidAudio model documentation](assets/research/fluidaudio-models.txt) places Qwen3-ForcedAligner-0.6B among evaluated, unsupported models with a large multi-model footprint. It is a candidate investigation, not a supported feature of the pinned SDK.

Replication gate: benchmark available local candidates on correct/wrong supplied text, repeated words, numerals, false starts, overlaps and abrupt versus contextual joins. Freeze runtime/model/hash/language, missing-token behavior, time mapping, observed work and reference outputs before selecting exactly one product provider. Prefer existing prepared inputs; download/prepare pinned models for first-class Yap features as needed. Recommend a required capability outside Yap rather than installing it by default. No implicit cloud ASR.

## Speaker labeling

The [current optional worker](../../../helpers/speaker/README.md) and
[public contract](../../../packages/protocol/src/operations.ts) support exactly one
30-second selected-channel observation. Its four slots are invocation-local.
The [original acoustic research](../../done/ffmpeg-parity/evidence/speaker-original/README.md)
and [runtime checkpoint](../../done/ffmpeg-parity/evidence/speaker-runtime/README.md)
prove matched short-window behavior, not arbitrary-length continuity, named people
or per-word labels. Training-overlap limitations remain explicit.

Replication gate: inspect the pinned recipe's actual streaming state and compare
continuity/association on multiwindow mixed interviews with isolated per-person
inputs and independently constructed controls. Include returning/similar voices,
silence, overlap, mic bleed, unsupported count and changed generations. Freeze
exact recipe, support envelope, score meaning, identity scope and resource bounds
before extending public preparation. Name binding is explicit caller metadata;
word attribution reads both evidence and transcript pins. No automatic cross-session
voice identity and no human labeling oracle. Slices 31–32 own this gate and port.

## Picture

[Apple face detection](https://developer.apple.com/documentation/vision/vndetectfacerectanglesrequest) and [object tracking](https://developer.apple.com/documentation/vision/vntrackobjectrequest) supply observations, not person names, editorial crop authorization or proof of a complete track. The project already uses Vision and AVFoundation; retain and reproduce that mechanism before improving it.

The [native color policy](../../../helpers/mac/Sources/YapFrames/VideoColorPolicy.swift), [frame owners](../../../helpers/mac/Sources/YapFrames/README.md) and existing encoded-appearance labs own interpretation. Match presentation timestamps, orientation, profile/transfer/matrix/range and raster conversion before comparing pixels.

Replication gate: use asymmetric color/edge controls and real white-wall/backlit scenes; preserve actual returned sample times, failed sample requests, detector version and all face boxes. Compare player-oriented native decoding with a declared FFmpeg recipe. Freeze known discrepancies before adding metrics/grades. No universal “face must have this luma” rule.

## Audio

The fetched [FFmpeg 9.0.2 filter source](assets/research/ffmpeg-filters.txt) matches [the bundled dependency recipe](../../../helpers/ffmpeg/provenance.json). Its loudnorm mode has target/statistical inputs, dynamic rate behavior and linear-mode fallback conditions; compressor supports explicit makeup. Documentation alone does not establish actual prepared-runtime behavior.

Existing [audio preparation](../../../apps/service/src/audio-processing.ts), [measurement admission](../../../packages/core/src/audio-measurement.ts), and [independent audio recipe labs](https://github.com/dzhng/yap/blob/4b4e708c/packages/test-harness/editing/audio-recipes/README.md) already retain strict before/after proof. Reuse these instead of inventing a new mastering engine.

Replication gate: pin PCM, channel policy, meter identity, resampling and peaky mix; reproduce undershoot and compare bounded offset/target solving. Freeze tolerances already specified by Core. Strict targets remain strict; no silent gain-only→dynamic switch, relaxation or best-effort publication.

## Synchronization

The original project found raw sources sharing a session clock but weak envelope correlation between single-speaker microphones. Equal durations do not prove equal origins, and an edited reference is not globally related to raw footage by one offset.

Replication gate: first preserve explicitly declared offsets. Compare acoustic and transcript-anchor estimators on known shifts, unrelated speech, muted channels, clock drift and edited reference discontinuities. Estimates remain evidence with competing peaks/coverage; declaration is explicit. Start with constant-offset segments; drift/piecewise mismatch is reported, not silently retimed.

## Graphics and transitions

The fetched FFmpeg blend/curves/LUT/xfade definitions provide comparator semantics, not permission to move the product renderer to FFmpeg. Native Core Image/CoreText and composition clocks remain owners.

Freeze static color/alpha arithmetic before blending; typography before word animation; basic transition continuity before motion-blur samples. LUTs are immutable imported dependencies, grain seeds/animation phase are deterministic, and flash/crop changes remain explicit.

External image/music/SFX/advanced motion tools belong to the discovered agent workflow. ProRes 4444 overlays remain a supported import pattern; final transparent delivery is a separate contract. Preserve actual generated bytes/prompts/code instead of claiming stochastic generation will reproduce identical assets.

## Feasibility disposition

The named spikes in the slice graph own unresolved provider/recipe decisions. A spike completes with a passed frozen reference or a recorded failure and resliced plan. It cannot mark the full feature done by returning an unavailable stub.
