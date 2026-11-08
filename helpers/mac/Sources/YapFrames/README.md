# Compiled picture execution

[The picture executor](CompositionPictureExecutor.swift) executes one graph for
still images and movie frames. Project placement, source choice and parameter
clocks come from the [composition compiler](../../../../packages/composition/README.md).
Native code resolves physical sample support and draws pixels; it does not
reconstruct cuts or restart frame phase at a preview origin.

Prepared sources retain the shared media input for the decoder's entire lifetime.
Path replacement and closing an inherited caller handle cannot redirect the
selected pictures. Metadata preparation checks primary chunk storage before
enabling whole-source streaming; external reference movies refuse.

PNG and movie encoding consume the same graph through different output targets.
Keeping still encoding separate avoids quantizing an inspection image through
movie color conversion. Source support and orientation remain shared.

Physical empty edits and compiler-excluded source pictures can become background
only under the admitted selection. Missing ancestor support or unknown physical
timing cannot be repaired by finding another child picture. Reused decode state
must retain each occurrence's own selection and acquisition disposition.

Review frames of a source can also carry the person's ink: the strokes and pins on their screen
at that moment, chosen and timed by the core and drawn by [Ink](../YapInk/README.md) at the size
the person saw. Edited pictures never draw ink.

Pointer runs are supplied evidence, not inferred gestures. Missing observations
leave missing marks; coordinates use half-open source pixels. Readability is judged
in delivered pixels, so thumbnail sizing must account for source crops and ancestor
transforms rather than applying a second independent mark-size rule.

[The video renderer](CompositionVideoRenderer.swift) consumes bounded compiled
records with their original sample times and clipped visible intervals. Publication
uses the shared new-file owner. [Appearance and temporal references](../../../../packages/test-harness/editing/README.md#platform-reproductions)
separate pixel execution from codec loss and physical-input acceptance.

[Picture observations](PictureObservations.swift) measure the very CGImage sent
to lossless PNG encoding. The requested rectangles use delivered top-left pixels,
after orientation, sizing and composition. Observation does not draw, crop or
change color treatment. A separate profile-managed sRGB RGBA8 measurement retains
its raster digest, the rendered input profile and actual measurement profile;
a named CoreGraphics space without exportable ICC bytes keeps an explicit absent
hash. This is not source-media tag equivalence.

Only fully opaque pixels contribute to luma and channel metrics. Transparent,
partial-alpha, clipped and outside-raster coverage remain explicit. Edge bands
are measured contiguous dark candidates; a completely dark scene may reach the
opposite edge without an observed transition. Neither case proves letterboxing
or authorizes cropping. Region names describe the caller's rectangles, not native
face detection or universal exposure targets.

[Face observations](FaceObservations.swift) run Vision on that same delivered,
upright CGImage when explicitly requested. They return every detected box in
top-left pixel coordinates, preserve no-face and detector-error states, and
carry the landmark groups actually returned for each box as separate
`core`/`partial`/`unavailable` quality evidence. Landmark coverage does not claim
a complete head silhouette, and it carries no person identity or largest-face
selection. This is evidence for the caller; it never changes composition or
framing.

Native text retains its literal UTF-16 and imported font identity. Where the
pinned face lacks a character, the platform's per-character fallback is drawn and
reported: each receipt names the faces used and the code points they drew, or
drew as a placeholder box. A missing face, a changed font file or
unmeasurable glyphs still refuse with their own codes. Glyph-path
bounds own vertical placement; decorations retain separate bounds and clipping.
Rounded stroke joins keep acute glyph corners inside the reported half-width
expansion instead of producing unreported sharp spikes.

[SDR correction](SDRCorrection.swift) expresses both tonal recovery controls as
zero for no treatment. Core Image's highlight control uses the opposite direction;
the native owner translates that provider convention once. The recipe identity
includes that response and the tone provider's availability. The
[tone checkpoint](../../../../specs/done/video-editing-feedback/assets/25-tone-controls/README.md)
keeps independent provider references distinct from movie encoding loss.

[LUT execution](LUTColor.swift) evaluates imported samples in the shared linear
working space. [Admission](../YapMedia/CubeLUT.swift) owns the bounded .cube grid;
unknown transforms and non-unit domains refuse. The explicit recipe uses
trilinear interpolation with linear extension of the edge cells, preserves
alpha and leaves final output conversion with the existing picture owner.
Identity grids return the input directly, so an identity treatment cannot
introduce another quantization/resampling step. Ordinary cube text alone does
not establish that its samples describe linear sRGB; the caller declares that
interpretation. The [numeric and public checkpoint](../../../../specs/done/video-editing-feedback/assets/26-immutable-luts/README.md)
retains measured operands and scope.
