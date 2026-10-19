# Conditional word alignment

The [worker](worker.py) executes the pinned original NeMo auxiliary CTC head and
Torchaudio conditional path arithmetic. It preserves literal supplied tokenizer
inputs, full native Float32 scores, ceil-sized model support and complete path
operands. A forced path is evidence conditioned on supplied text; neither a path
nor an uncalibrated native score establishes lexical truth.

The model owner prepares the checkpoint and its
[offline runtime recipe](../model-runtime/README.md). Execution never installs,
downloads or substitutes another provider. Source-selected PCM is complete and
channel-specific; missing support cannot become padding. Word correspondence
uses the native ordered all-optimal owner after core text folding. Physical
admission remains separate from textual correspondence and never clamps a native
token cell into source support.

The [frozen reference](../../specs/done/video-editing-feedback/assets/09-local-alignment/README.md)
owns the accepted recipe, independent controls and interpretation limits.
