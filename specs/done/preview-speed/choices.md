# Preview-speed choices

## Sound

### Draft size is part of preview identity

When the Library opens a project, it asks for a bounded draft raster and the
preview cache identity includes that bound. A full export still uses the
composition canvas. Without this identity field, a 960-pixel file could answer
a later full-canvas request, so the caller would receive a file with the right
revision ID but the wrong rendition. The spec allowed lower-resolution previews
but did not prescribe the cache shape; binding the size to the existing pinned
preview is the smallest general contract.

- **Gap:** the spec allowed a lower-resolution preview without defining its
  identity or where the setting belonged.
- **Reach:** future progressive or quality variants must retain the same rule:
  every rendition-affecting input belongs in the pinned identity.
- **Verdict:** sound — the cache cannot confuse draft and full renditions.
- **Confidence:** high.

### Keep full-quality output explicit

Library playback defaults to a 960-pixel long edge, while callers can request
`maxLongEdge: null` for full-canvas preview and exports never consume preview
settings. This chooses a usable draft for the interactive path while retaining
an exact inspection path. The spec made lower resolution acceptable but did not
say whether it should be the default; the measured curve showed that this
choice alone cannot satisfy the latency goal, so it remains reversible.

- **Gap:** default versus opt-in draft quality was unspecified.
- **Reach:** the eventual progressive path must preserve a full-quality option.
- **Verdict:** sound — the shipped default is covered by the launch benchmark and
  visual comparison, and callers retain an explicit full-canvas option.
- **Confidence:** high.

## Progressive first play

### The 960-pixel draft was selected before the cold target was met

The Library now asks for 960×540 because it is half the launch canvas. The
matched trials showed 960 pixels takes 48.46 seconds cold and 320 pixels still
takes 38.37 seconds, so the choice does not solve the stated goal. The corrected
decision is to make first-play latency come from a progressive pinned range;
resolution remains a quality/performance parameter inside that path.

- **Gap:** the first implementation slice needed a concrete draft default
  before progressive playback existed.
- **Reach:** leaving this as the main optimization would spend time tuning a
  parameter that the evidence has already shown is insufficient.
- **Verdict:** rejected as the primary strategy — progressive publication supplies
  the latency win while retaining this draft rendition capability.
- **Confidence:** high.

### First play uses a bounded receipt and a pinned continuation

Library playback requests the first ten seconds of the selected project
revision with the draft raster bound in the request identity. A ready receipt
starts immediately with its audio. The controller requests the full selected
range in the background using the returned revision, and switches at the
partial receipt's declared end time. The partial delivery is released only
after the full delivery is installed. A full-quality export never consumes
this draft path.

- **Gap:** a complete MP4 was the only playback boundary, so the renderer's
  cold work blocked the first sound.
- **Reach:** the continuation must preserve revision identity, delivery leases,
  explicit user ranges and source immutability.
- **Verdict:** sound — the focused native control test and launch revision
  benchmark cover immediate play, pinned continuation, boundary seek and lease
  handoff.
- **Confidence:** high.

### Continuation seeks in the selected movie's clock

The service receipt names the selected project interval in absolute project
microseconds, while the MP4 for that interval starts playback at zero. When a
caller asks for a range beginning at 20 seconds, the first receipt covers
20–30 seconds and the full receipt covers the selected range from its own zero
point. The handoff therefore seeks to `partialEndUs - selectedStartUs` (10
seconds), not to the absolute 30-second project timestamp. This preserves the
same visible point for nonzero user ranges.

- **Gap:** the initial default starts at zero, so an absolute seek looked
  correct until an explicit offset range was exercised.
- **Reach:** every future continuation, including timeline-selected ranges,
  must use the playback clock declared by the rendered file.
- **Verdict:** sound — the focused control test covers both zero-based and
  offset ranges.
- **Confidence:** high.
