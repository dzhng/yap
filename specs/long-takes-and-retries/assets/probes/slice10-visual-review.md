# Slice 10 completion notice review

Target: a completed 12-hour take shows an ordinary readable status line; it has no
error styling, clipping or overlap. The before image is a historical baseline,
not a design reference. The candidate is rendered through the production
CapturePresentation and CaptureView with synthetic facts.

The original full images have different heights because the notice adds a line.
A full-frame parity check therefore refuses them as incomparable. Both full
images were inspected. Matched crops compare the unchanged controls and translated
footer without removing the notice from either retained full image. The expected
panel growth accommodates the notice above Start recording. The fixture's recent
recording label is an independent synthetic item, unchanged on both sides.

Fresh unprimed reviewer (`status_visual_review`), given both complete captures:

> The after image clearly shows “Take complete — reached 12 hours.” in ordinary
> muted status text above Start recording. Fully visible, comfortably separated,
> readable. No clipping, overlap, contrast, hierarchy defects. High confidence.

Direct boundary check: notice has clear space on all four sides; it crosses no
control or divider. The complete Start recording action remains visible beneath
it, and the footer remains readable. The candidate satisfies the stated target.

The user was shown both captures in one Preview window. Preview was closed after
the nonblocking review.

## Reproducible comparison

The screenshot runner was `SHOTS=$OUT node apps/macos/tests/capture-view-shots.mjs`
on each side. Before uses the historical CapturePresentation notice implementation;
all other fixture facts are the same. Candidate uses the current implementation.
The runner passed native layout/action/scroll assertions on both sides.

Matched comparison used the vendored PNG reader to crop the unchanged controls
and translated footer. The crop command's rectangles were:

```js
// Applied to each full source capture; the complete originals are retained.
['controls', 0, 740] // both sides, full source width
['footer', side === 'before' ? 838 : 902, 230]
```

These rectangles explicitly compensate for panel growth; they do not claim the
full images are identical. Comparison command run:

```sh
REFERENCE_DIR=/tmp/lt10-compare-before CANDIDATE_DIR=/tmp/lt10-compare-after \
  OUT_DIR=/tmp/lt10-compare-last \
  node .agents/skills/compare-screenshots/scripts/visual-parity-diff.mjs
```

Measured output was read from the generated JSON report with this command:

```sh
node --input-type=module -e 'import fs from "node:fs"; for (const r of JSON.parse(fs.readFileSync("/tmp/lt10-compare-last/visual-parity-diff.json")).results) console.log(r.id, JSON.stringify(r.grayscale), "edgeEnergyRatio", r.contentProxies.edgeEnergyRatio)'
```

Output:

```text
controls {"mae":0,"rmse":0,"diffRatio16":0,"diffRatio32":0,"diffRatio64":0,"pixelmatchRatio":0} edgeEnergyRatio 1
footer {"mae":0,"rmse":0,"diffRatio16":0,"diffRatio32":0,"diffRatio64":0,"pixelmatchRatio":0} edgeEnergyRatio 1
```

## Retained image identities

- `slice10-status-before.png`: sha256 `94888c5a1a261753a9b939c99ea20061b4d3c36bbef94b69c9823e8ba9957d11`.
- `slice10-status-after.png`: sha256 `83f5a488872d2e0ab63ca7423cdda74f35b46987771c87466d6eed3e49f44d3a`.
