# Two real speaker controls

These eight-second mono Float32 excerpts come from the already retained
speaker-continuity input. Known speaker ownership follows its frozen RTTM/source
mapping, not model predictions or human listening. The first excerpt is explicitly
attenuated12dB as a quiet-host control; the other retains its exact Float32 samples.
Both original cropped hashes and resulting WAV/PCM hashes live in
[manifest.json](manifest.json). This is a real two-speaker processing fixture with
an authored level control, not a replay of the removed trailer mix.

[Derivation](derive.mjs) takes the exact retained source Float32 file and a new
fixture destination, verifies the input/crop hashes and writes deterministic WAVs.
It performs no resampling, compression, transcription or source mutation. Its
usage owns the arguments. WAVs use the existing fixture LFS rule.
