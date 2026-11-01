# Storyboard contract

Times are integer microseconds on the source clock (Yap's exact fractions are
accepted on input). Crops and face boxes are source pixels, top-left origin. Every
helper reads one JSON request on stdin and prints JSON; a request field that takes
JSON also accepts the path of a saved file. Failures print `{"error": {code, message}}`
on stderr and exit 1. Results carry `issues`: evidence for you to weigh, not refusals.

## Inputs you write

Chapters:

```json
{"title": "Guest Name · Lab",
 "chapters": [
  {"startUs": 0, "endUs": 19000000, "label": "Pre-roll: mic check", "call": "cut"},
  {"startUs": 552000000, "endUs": 665000000, "label": "The guest's core argument",
   "call": "keep", "note": "Strongest line", "keyLinesUs": [583000000]}]}
```

`call` is `keep`, `trim`, `cut` or `decide`. Chapters tile the recording in order.

Turns, each lasting until the next: `[{"startUs": 19000000, "speaker": "Host"}, ...]`.

## Helpers

`sample-stills.mjs` calls `yap frame.batch` (read-only) eight instants per call:

```json
{"assetId": "…", "streamId": "track:1", "ranges": [{"startUs": 0, "endUs": 2466000000}],
 "stepUs": 2000000, "maxLongEdge": 960, "out": "work/stills", "cli": {"executable": "yap"}}
```

It writes `out/batch-NNNN.json` receipts with their stills, and `out/stills.json`:

```json
{"source": {"assetId": "…", "streamId": "track:1", "width": 3840, "height": 2160},
 "stills": [{"atUs": 0, "actualSourceUs": 0, "file": "/abs/batch-0001/01.png",
   "width": 960, "height": 540, "sourceWidth": 3840, "sourceHeight": 2160,
   "faces": [{"x": 1236, "y": 916, "width": 396, "height": 400, "confidence": 0.81}]}],
 "issues": []}
```

A rerun reuses every complete batch. A refused call saves `batch-NNNN.refused.json`.

`plan-shots.mjs` is pure:

```json
{"chapters": "chapters.json", "turns": "turns.json", "stills": "work/stills/stills.json",
 "words": ["transcript/page-001.json", "transcript/page-002.json"],
 "host": "Host", "guest": "Guest", "hostSide": "left",
 "layout": "multicam", "aspect": "16:9", "out": "plan.json"}
```

`words` takes saved `transcript.review` receipts or `[{startUs, endUs, text}]`.
Optional tuning: `views` (`{"GUEST": {"width": 2400, "height": 1350}}`), `minShotUs`,
`maxShotUs`, `longAnswerUs`, `openerUs`, `keyLineUs`. The plan is the chapters
document plus `layout`, `aspect`, `source`, `host`, `guest` and
`totals: {shots, cuts, viewUs}`. Each chapter gains snapped `startUs`/`endUs` (with
`authoredStartUs`/`authoredEndUs` when snapping moved them) and `shots`:

```json
{"startUs": 24000000, "endUs": 41000000, "view": "HOST", "why": "host question",
 "cut": true, "crop": {"x": 115, "y": 590, "width": 2400, "height": 1350},
 "spoken": "Yeah. For the new audience, could you share…", "summary": "Host asks about the guest's research"}
```

`view` is `WIDE`, `TWO`, `GUEST`, `GUEST_TIGHT`, `HOST` or `SPLIT`. A `SPLIT` shot has
`crops` (left to right as the people sit) instead of `crop`. You add `summary`.
`spoken` is the transcript text for writing summaries; the site never shows it.
Cut chapters have no shots.

`build-site.mjs`: `{"storyboard": "plan.json", "stills": "work/stills/stills.json", "out": "site"}`.
It writes `site/index.html` and hard-links the stills it shows into `site/stills/`,
returning `{index, chapters, shots, minutes, issues}`. Issues: `still-distant` (no
still within 2 s of a shot), `summary-missing`, `summary-long` (over 9 words).

`serve-site.mjs SITE_DIR [--port N]` serves the directory read-only on 127.0.0.1,
on a free port by default, until stopped, and prints `{"url": "http://127.0.0.1:PORT/"}`.
