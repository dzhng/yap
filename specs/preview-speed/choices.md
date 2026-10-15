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
- **Verdict:** needs-user — provisional default is sound for iteration, but the
  final product may choose a different draft size after visual review.
- **Confidence:** medium.

## Needs revision

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
- **Verdict:** unsound as the primary strategy — redo the next slice around
  partial readiness and continuation.
- **Confidence:** high.
