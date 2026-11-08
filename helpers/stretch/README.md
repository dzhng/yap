# Time/pitch dependency

This package preserves the adopted Signalsmith recipe. The
[vendored source manifest](Sources/CSignalsmith/vendor/sources.json) owns source and
license identity; both native execution and the independent research reference
consume that owner. Exact presets and representation limits belong to the adapter,
not a second settings table here.

[The file adapter](Sources/YapStretch/SignalsmithProcessor.swift) serves
native preparation without splitting the upstream call into independent windows.
The algorithm revisits input and corrects earlier output using reflected tail
support, so forward-only streaming would change the recipe. Immutable input and a
distinct writable scratch output retain that access pattern under bounded pages.
The caller owns descriptors, partial-output cleanup and final publication.

Equal selected/output counts retain exact identity. Metadata admission uses the
same representability and short-input rules as execution, but cannot certify sample
finiteness or file availability. Unsupported input refuses rather than publishing
an upstream failure buffer as successful sound.

Stereo uses one upstream instance with both channels because shared energy analysis
and phase coupling differ from two independent mono processors. Counts are frames,
not individual channel samples. Cancellation at page transfers bounds adapter work
between checks, not every upstream loop or operating-system IO latency.

The [native retime owner](../mac/Sources/YapAudio/CompositionRetime.swift)
uses this seam through existing prepared-audio, job and asset lifetimes.
[Bounded](../../specs/done/agent-editing/assets/14-bounded-stretch/README.md)
and [stereo evidence](../../specs/done/agent-editing/assets/14c-stereo-stretch/README.md)
retain measured scope. Numerical parity cannot establish natural speech or a general
cancellation latency guarantee.
