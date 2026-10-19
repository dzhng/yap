# Unlike-microphone synchronization operands

These WAVs losslessly wrap complete selected-channel Float32 operands from the
three original participant recordings. They retain separate source clocks and
microphone signals; equal window selections do not mean the cameras are synced.
The [manifest](manifest.json) binds original identity, selections, captured PCM
hashes and retained WAV bytes. WAV files use the existing Git LFS owner.

The [frozen research](../../../specs/done/video-editing-feedback/assets/20-synchronization/README.md)
records the acoustic refusals and separates byte preservation from synchronization
quality. External originals remain unchanged. These inputs carry no speaker or
lexical labels and authorize no edit or clock declaration.

The [multicam corpus verifier](../../../packages/test-harness/editing/multicam-corpus.mjs)
certifies the three-source, three-window physical bank and its frozen manifest
identity. Equal selected windows establish fixture coverage only; the verifier
always reports synchronization as not established.

[Mixed-reference bridge operands](bridge/README.md) retain the separate research
recipe and every successful/refused local case without replacing these original
unlike-microphone inputs.
