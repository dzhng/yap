# Run inspection helpers

Use these examples after discovering the installed helper's `--help`. Run them
in the task workspace with the Node path returned by `yap service.tools` and the
scripts from the **installed** skill folder. Save each JavaScript block as a task
file and run `"$yap_node" <file.mjs> > <request.json>`, then pass that JSON to the
named helper. Helpers return plain JSON; service receipts have an `ok` envelope.

Prerequisites: `revision.json` is the saved successful `revision.get` receipt;
`range.json` is an explicitly selected project-time window of at most 60 seconds,
for example `{"startUs":0,"endUs":1000000}` when that interval exists.
`cli.json` is `{}` for the default launcher, or explicit `executable`/`socket`
options. These examples neither prepare transcripts nor write edits. Readiness,
failed jobs and partial coverage remain facts to inspect, not success claims.

## Feedback review

When the installed CLI advertises the first-class review operations, use this
short path before the lower-level helpers. `transcript.review` is the convenience
combination of `transcript.transcribe` and `transcript.get`: it may download the
registered local speech model and prepare bounded transcription, then returns the
bounded rows; poll the same params while pending. `cursor.render` combines
`cursor.raw` evidence with `frame.get` delivery and is read-only. Save complete responses and
preserve generations, revisions, acquisitions and continuations.

```json
{"operation":"transcript.review","params":{"projectId":"…","revisionId":"…","range":{"startUs":0,"endUs":60000000}}}
{"operation":"cursor.render","params":{"projectId":"…","revisionId":"…","atUs":[12000000,24000000],"trailUs":600000,"maxLongEdge":1280}}
```

`frame.get` is intentionally clean and does not show capture overlays. Use
`cursor.raw` for exact pointer observations. If an older release does not
advertise these operations, use the explicit transcript preparation/read and
raw cursor plus frame pipeline instead.

## Compact transcript

Run this request through `compact-transcripts.mjs`; save its output as
`compact.json` and its request as `transcript-request.json`.

```javascript
// transcript-request
import { readFile } from 'node:fs/promises';
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const receipt = await read('revision.json');
if (!receipt.ok) throw new Error('revision.get failed');
console.log(JSON.stringify({
  selections: [{projectId: receipt.data.projectId, revisionId: receipt.data.revision.id,
    range: await read('range.json')}],
  maxPages: 1, cli: await read('cli.json')
}));
```

When `compact.json` has a continuation, keep it verbatim. This request gets the
next page without following a newer project head. Save each page separately;
row indexes are local to its entry, so do not casually merge caption indexes.

```javascript
// transcript-continuation
import { readFile } from 'node:fs/promises';
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const previous = await read('compact.json');
if (!previous.continuation) throw new Error('No remaining page');
console.log(JSON.stringify({...await read('transcript-request.json'), continuation: previous.continuation}));
```

## Timeline inspection

Run the generated request through `timeline-inspection.mjs`. This minimal example
requests words, cuts and waveform; choose `frames` explicitly for picture evidence.
Its SVG is a navigation sheet, not a full playback verdict. Check the manifest
for failed/unavailable work and transcript/event continuations.

```javascript
// timeline-request
import { readFile } from 'node:fs/promises';
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const receipt = await read('revision.json');
if (!receipt.ok) throw new Error('revision.get failed');
console.log(JSON.stringify({
  target: {projectId: receipt.data.projectId, revisionId: receipt.data.revision.id},
  range: await read('range.json'), frames: 0, cli: await read('cli.json')
}));
```

## Revision review

Run through `review-bundle.mjs`. The range is a caller selection, not a certified
whole-revision extent. For before/after, supply two saved explicit revision IDs
with their own ranges/provenance. The bundle collects evidence; it does not judge
picture quality or sound. Investigate its skipped windows and missing evidence.

```javascript
// review-request
import { readFile } from 'node:fs/promises';
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const receipt = await read('revision.json');
if (!receipt.ok) throw new Error('revision.get failed');
console.log(JSON.stringify({
  projectId: receipt.data.projectId,
  revisions: [{revisionId: receipt.data.revision.id, range: await read('range.json'),
    extentProvenance: 'Explicit task selection saved in range.json'}],
  timeline: {frames: 0}, cli: await read('cli.json')
}));
```

## Caption proposals fallback

Use this helper only when the installed release does not advertise
`caption.propose`. Save a complete ready **project** compact entry as
`entry.json`. Save chosen `rowIndexes`, caption `trackId`, `canvas`, `style` and
`constraints` in `caption-settings.json`; the helper's help owns the fields.
Use the actual admitted font asset/face and caption track ID from current receipts.
This constructs a complete request without rewriting word evidence:

```javascript
// caption-request
import { readFile } from 'node:fs/promises';
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
console.log(JSON.stringify({...await read('caption-settings.json'), entry: await read('entry.json')}));
```

The result is a draft with issues, not an applied or checked caption. A
`{label: "captions"}` reference is valid only within the edit batch that creates
that label. Later revisions need the real returned track/clip IDs. Retain exact
seed generations, word ordinals, occurrence IDs and fractional ranges. Inspect
applied frames for font fit and the moving preview for dwell time before delivery.
