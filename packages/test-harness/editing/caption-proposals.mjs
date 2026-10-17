import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { captionProposals } from "../../../skills/yap/scripts/caption-proposals.mjs";
import { applyBatch, createCompiler, validateComposition } from "../../composition/dist/index.js";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";

const out = resolve(process.argv[2] ?? "");
assert.ok(
  process.argv[2] && process.env.YAP_NATIVE,
  "YAP_NATIVE=... node caption-proposals.mjs NEW_EVIDENCE_DIRECTORY",
);
await mkdir(out);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const worker = mediaWorker();
const fontPath = "/System/Library/Fonts/Supplemental/Arial.ttf";
const fontId = hash(await readFile(fontPath));
const report = {
  passed: false,
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  fontSha256: fontId,
  pictures: [],
  syntheticWords: true,
  noASR: true,
};
const canvas = {
  width: 640,
  height: 360,
  fps: { numerator: 8, denominator: 1 },
  background: "#142032ff",
};
const style = {
  font: { assetId: fontId, postScriptName: "ArialMT" },
  width: 560,
  height: 100,
  size: 32,
  color: "#ffffffff",
  alignment: "center",
  wrap: true,
};
const words = ["readable", "captions", "keep", "their", "source", "pins."].map((text, index) => ({
  type: "word",
  id: `fixture-word-${index}`,
  ordinal: index,
  kind: "word",
  text,
  segment: 0,
  partial: false,
  clipId: "speech",
  trackId: "speech-track",
  assetId: "fixture-audio",
  streamId: "audio",
  generation: "fixture-words",
  sourceRange: { startUs: index * 250000, endUs: (index + 1) * 250000 },
  fragments: [
    {
      source: { startUs: index * 250000, endUs: (index + 1) * 250000 },
      project: { startUs: index * 250000, endUs: (index + 1) * 250000 },
    },
  ],
}));
const input = {
  entry: {
    identity: { projectId: "fixture-project", revisionId: "fixture-revision" },
    state: "ready",
    complete: true,
    rows: words,
  },
  rowIndexes: words.map((_, i) => i),
  corrections: [{ rowIndex: 0, text: "Readable" }],
  trackId: "captions",
  canvas: { width: canvas.width, height: canvas.height },
  style,
  constraints: {
    widthGraphemes: 23,
    maxLines: 2,
    minDwellUs: 500000,
    maxDwellUs: 3000000,
    maxCps: 30,
    pauseUs: 400000,
    breakOnPunctuation: true,
    separator: " ",
    safeArea: { x: 32, y: 20, width: 576, height: 300 },
  },
};
const proposal = captionProposals(input);
await writeFile(join(out, "input.json"), JSON.stringify(input, null, 2));
await writeFile(join(out, "proposal.json"), JSON.stringify(proposal, null, 2));
assert.equal(proposal.proposals.length, 1);
const assets = [
  { id: fontId, streams: [], fontFaces: ["ArialMT"] },
  {
    id: "fixture-audio",
    streams: [
      {
        id: "audio",
        kind: "audio",
        bounds: { startUs: 0, endUs: 2000000 },
        available: [{ startUs: 0, endUs: 2000000 }],
      },
    ],
  },
];
const base = {
  canvas,
  tracks: [
    { id: "speech-track", kind: "audio", order: 0 },
    { id: "captions", kind: "video", order: 0 },
  ],
  groups: [],
  processing: [],
  syncGroups: [],
  clips: [
    {
      id: "speech",
      trackId: "speech-track",
      assetId: "fixture-audio",
      streamId: "audio",
      source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
    },
  ],
};
try {
  for (const name of ["plain-seed-control", "proposal"]) {
    const draft = structuredClone(proposal.proposals[0]);
    if (name === "plain-seed-control")
      draft.clip.source.text = "Readable captions keep their source pins.";
    const edited = applyBatch(
      base,
      [
        { operation: "place", label: "caption", clip: draft.clip },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "caption" } },
          steps: [draft.geometry],
        },
      ],
      { assets, namespace: name },
    );
    const model = validateComposition(edited.document, assets);
    const plan = createCompiler(model, name).videoWindow({
      range: { startUs: 0, endUs: 125000 },
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const params = {
      output: join(out, name + ".png"),
      canvas,
      frame: [...plan.frames()][0],
      processing: plan.processing(),
      assets: [],
      fonts: [{ assetId: fontId, path: fontPath }],
      profile: "h264-rec709",
      maxLongEdge: 640,
    };
    await writeFile(join(out, name + "-request.json"), JSON.stringify(params, null, 2));
    const result = await worker("media.renderCompositionFrame", params);
    await writeFile(join(out, name + "-reply.json"), JSON.stringify(result, null, 2));
    const receipt = nativeResult(result);
    report.pictures.push({ name, receipt, sha256: hash(await readFile(params.output)) });
    const text = receipt.pictures.find((picture) => picture.kind === "text");
    assert.deepEqual(text.layout.visibleRange, [0, draft.clip.source.text.length]);
    assert.ok(
      text.layout.lines.every(
        (line) => line.width <= style.width && line.fonts.every((face) => face === "ArialMT"),
      ),
    );
    assert.equal(text.layout.lines.length, 2);
  }
  assert.notEqual(
    report.pictures[0].sha256,
    report.pictures[1].sha256,
    "Line break proposal must actually change rendered pixels",
  );
  report.passed = true;
} finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, evidence: out }));
