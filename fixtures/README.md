# Retained source media

Fixtures preserve real inputs that generated media cannot replace. The
[narrated workbench](narrated-workbench/README.md) supports speech and source-evidence
checks; [pathological speech timing](speech-timing/README.md) preserves a small
real overlap reproduction; the [screen/camera take](screen-camera-timing/README.md) supports ordinary
media import and cross-source timing measurements.
The [launch-video session inputs](launch-video/README.md) reproduce long-media
transcription failures and supply a multicam synchronization pair.
The [real editing corpus](video-editing-feedback/README.md) retains compact
authorized excerpts with exact original clocks. Byte/sample certification and
recognizer defect reproduction remain separate verdicts.

Original bytes, capture context and clocks belong to each fixture's metadata and
journals. Derived transcripts, frames and exports belong to their producing
verification result. Never overwrite an original to reconcile a duration, fill a
gap or make a comparison pass. An interrupted original can still be useful without
being silently relabeled complete.

Fetch only the large files required by the selected check. Git LFS pointers are
not media bytes; the repository's attributes identify which files need acquisition.
[Verification tools](../packages/test-harness/README.md) explain how to admit copies
into isolated state and reuse retained results before requesting new recordings.
Treat the footage and narration as personal content.

[Journal fixtures](journal/README.md) are synthetic writer-produced inputs for
format and import checks, separate from the retained media corpus.
