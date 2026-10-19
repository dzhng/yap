import { resolveOutputSettings } from "../../composition/dist/index.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { compositionAsset } from "../../core/dist/assets.js";
import { classify, corpusReferences } from "./render-membership.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["--case", "repeat-reorder"]);
const out = args[2] === "--out" ? resolve(args[3]) : await mkdtemp(join(tmpdir(), "sr-video-"));
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), [], "Evidence folder must be empty");
const native = process.env.YAP_NATIVE ?? join(root, "helpers/mac/.build/debug/yap-native");
const frozen = join(root, "specs/done/agent-editing/assets/06-platform-temporal");
const corpus = join(root, "specs/done/agent-editing/assets/00-corpus");
const bytes = 160 * 128 * 3;
function run(command, args, input) {
  const r = spawnSync(command, args, { input, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout;
}
function call(operation, params) {
  return JSON.parse(run(native, [], JSON.stringify({ id: "video", operation, params }) + "\n"));
}
function ff(args) {
  return run("ffmpeg", ["-v", "error", "-nostdin", ...args]);
}
const json = async (path) => JSON.parse(await readFile(path));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const refs = corpusReferences((id) =>
  ff([
    "-i",
    join(corpus, id + ".mov"),
    "-map",
    "0:v:0",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]),
);
const files = new Map();
async function asset(file) {
  if (files.has(file)) return files.get(file);
  const p = call("media.probe", { path: file });
  assert.equal(p.ok, true, JSON.stringify(p));
  const id = basename(file);
  const result = {
    asset: compositionAsset({ id, ...p.data }),
    binding: {
      assetId: id,
      streamId: p.data.streams.find((s) => s.kind === "video").id,
      path: file,
      originUs: p.data.originUs,
    },
  };
  files.set(file, result);
  return result;
}
async function compile(
  pictures,
  range,
  directory,
  fps = { numerator: 20, denominator: 1 },
  acquisitions = [],
) {
  const clips = [],
    bindings = [],
    assets = [];
  for (const picture of pictures) {
    const local =
      picture.localFile ??
      join(
        basename(picture.file) === "timestamp-gap.mov" ? corpus : frozen,
        basename(picture.file),
      );
    const a = await asset(local);
    const binding = picture.streamId ? { ...a.binding, streamId: picture.streamId } : a.binding;
    bindings.push(binding);
    assets.push(a.asset);
    clips.push({
      id: picture.id,
      trackId: "video",
      assetId: a.asset.id,
      streamId: binding.streamId,
      ...(picture.acquisitionId ? { acquisitionId: picture.acquisitionId } : {}),
      source:
        picture.holdUs === null
          ? { kind: "range", range: picture.source }
          : { kind: "hold", atUs: picture.holdUs },
      placement: { kind: "project", range: picture.project },
    });
  }
  const document = {
    canvas: { width: 160, height: 128, fps, background: "#000000ff" },
    tracks: [{ id: "video", kind: "video", order: 0 }],
    groups: [],
    clips,
    syncGroups: [],
    processing: [],
  };
  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  const compiled = createCompiler(
    validateComposition(
      document,
      unique(assets, (a) => a.id),
      acquisitions,
    ),
    "fixture",
  ).window({
    range,
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const frames = [...compiled.frames()];
  await writeFile(
    join(directory, "frames.jsonl"),
    frames.map((f) => JSON.stringify(f) + "\n").join(""),
  );
  await save(join(directory, "manifest.json"), compiled.manifest);
  return {
    frames,
    request: {
      output: join(directory, "video.mp4"),
      frames: join(directory, "frames.jsonl"),
      range,
      canvas: document.canvas,
      settings: resolveOutputSettings(),
      processing: compiled.processing(),
      assets: unique(bindings, (b) => b.assetId + b.streamId),
    },
  };
}
const sourceProfiles = [];
for (const [name, primaries, transfer, matrix, expectedPrimaries] of [
  ["hdr-pq", 9, 16, 9, "bt2020"],
  ["hdr-hlg", 9, 18, 9, "bt2020"],
  ["wide-p3", 12, 13, 1, "smpte432"],
]) {
  const file = join(out, name + ".mov");
  ff([
    "-i",
    join(frozen, "tagged-a.mov"),
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-bsf:v",
    `h264_metadata=colour_primaries=${primaries}:transfer_characteristics=${transfer}:matrix_coefficients=${matrix}`,
    "-color_primaries",
    String(primaries),
    "-color_trc",
    String(transfer),
    "-colorspace",
    String(matrix),
    file,
  ]);
  const metadata = JSON.parse(
    run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]),
  );
  assert.equal(metadata.streams[0].color_primaries, expectedPrimaries);
  const directory = join(out, name);
  await mkdir(directory);
  const { request } = await compile(
    [
      {
        id: name,
        file,
        localFile: file,
        holdUs: null,
        source: { startUs: 0, endUs: 50000 },
        project: { startUs: 0, endUs: 50000 },
      },
    ],
    { startUs: 0, endUs: 50000 },
    directory,
  );
  const response = call("media.renderCompositionVideo", request);
  sourceProfiles.push({
    name,
    colorPrimaries: metadata.streams[0].color_primaries,
    transfer: metadata.streams[0].color_transfer,
    response,
  });
}
assert.ok(
  sourceProfiles.every((r) => !r.response.ok && r.response.error.code === "NOT_READY"),
  JSON.stringify(sourceProfiles),
);
for (const { name } of sourceProfiles) {
  const files = await readdir(join(out, name));
  assert.ok(
    !files.includes("video.mp4") && !files.some((f) => f.startsWith(".yap-output-")),
    name + " leaked unsupported output",
  );
}
const results = [];
const names = [
  "av-replacement",
  "audio-replacement",
  "nonzero-preview",
  "held-frame",
  "subframe-source",
  "vfr-held-tail",
  "empty-edit",
  "empty-edit-preview",
];
const scenarios = [];
for (const name of names)
  scenarios.push({
    name,
    original: await json(join(frozen, name, "request.json")),
    expected: await json(join(frozen, name, "expected.json")),
  });
const picture = (id, file, start, end, at, until) => ({
  id,
  file,
  source: { startUs: start, endUs: end },
  project: { startUs: at, endUs: until },
  holdUs: null,
});
const repeated = (...groups) => groups.flatMap(([id, count]) => Array(count).fill(id));
scenarios.push({
  name: "repeat-reorder",
  original: {
    pictures: [
      picture("late", "tagged-a.mov", 1000000, 1500000, 0, 500000),
      picture("again", "tagged-a.mov", 0, 500000, 500000, 1000000),
      picture("b", "tagged-b.mov", 0, 500000, 1250000, 1750000),
    ],
    range: { startUs: 0, endUs: 1750000 },
  },
  expected: {
    frameIDsOnFullProjectGrid: repeated(
      ["A4", 5],
      ["A5", 5],
      ["A0", 5],
      ["A1", 5],
      ["black", 5],
      ["B0", 4],
      ["B1", 4],
      ["B2", 2],
    ),
  },
});
scenarios.push({
  name: "leading-partial-picture",
  original: {
    pictures: [picture("ended", "tagged-a.mov", 0, 50000, 0, 50000)],
    range: { startUs: 50001, endUs: 70000 },
  },
  fps: { numerator: 30000, denominator: 1001 },
  expected: { frameIDsOnFullProjectGrid: ["A0", "A0", "black"] },
});
scenarios.push({
  name: "retimed-picture",
  original: {
    pictures: [picture("slow", "tagged-a.mov", 0, 500000, 0, 1000000)],
    range: { startUs: 0, endUs: 1000000 },
  },
  expected: { frameIDsOnFullProjectGrid: repeated(["A0", 10], ["A1", 10]) },
});
const multi = join(out, "two-streams.mov");
ff([
  "-i",
  join(frozen, "tagged-a.mov"),
  "-i",
  join(frozen, "tagged-b.mov"),
  "-map",
  "0:v:0",
  "-map",
  "1:v:0",
  "-c",
  "copy",
  multi,
]);
const multiProbe = call("media.probe", { path: multi });
assert.equal(multiProbe.ok, true);
scenarios.push({
  name: "selected-second-stream",
  original: {
    pictures: [
      {
        ...picture("second", multi, 0, 500000, 0, 500000),
        localFile: multi,
        streamId: multiProbe.data.streams[1].id,
      },
    ],
    range: { startUs: 0, endUs: 500000 },
  },
  expected: { frameIDsOnFullProjectGrid: repeated(["B0", 4], ["B1", 4], ["B2", 2]) },
});
scenarios.push({
  name: "raster-reuse-transitions",
  original: {
    pictures: [
      picture("a", "tagged-a.mov", 0, 150000, 0, 150000),
      picture("a-after-gap", "tagged-a.mov", 0, 150000, 300000, 450000),
      picture("b-same-time", "tagged-b.mov", 0, 150000, 450000, 600000),
      {
        ...picture("stream-a", multi, 0, 150000, 600000, 750000),
        localFile: multi,
        streamId: multiProbe.data.streams[0].id,
      },
      {
        ...picture("stream-b", multi, 0, 150000, 750000, 900000),
        localFile: multi,
        streamId: multiProbe.data.streams[1].id,
      },
    ],
    range: { startUs: 0, endUs: 900000 },
  },
  expected: {
    frameIDsOnFullProjectGrid: repeated(
      ["A0", 3],
      ["black", 3],
      ["A0", 3],
      ["B0", 3],
      ["A0", 3],
      ["B0", 3],
    ),
  },
});
const distant = join(out, "distant-source.mov");
ff([
  "-stream_loop",
  "299",
  "-i",
  join(frozen, "tagged-a.mov"),
  "-map",
  "0:v:0",
  "-c",
  "copy",
  "-t",
  "600",
  distant,
]);
scenarios.push({
  name: "sparse-forward-cuts",
  original: {
    pictures: [
      { ...picture("start", distant, 0, 250000, 0, 250000), localFile: distant },
      { ...picture("end", distant, 599000000, 599250000, 250000, 500000), localFile: distant },
    ],
    range: { startUs: 0, endUs: 500000 },
  },
  expected: { frameIDsOnFullProjectGrid: repeated(["A0", 5], ["A4", 5]) },
});
scenarios.push({
  name: "sparse-forward-retime",
  original: {
    pictures: [{ ...picture("fast", distant, 0, 600000000, 0, 500000), localFile: distant }],
    range: { startUs: 0, endUs: 500000 },
  },
  expected: { frameIDsOnFullProjectGrid: repeated(["A0", 10]) },
});
const acquisitionSource = await asset(join(frozen, "tagged-a.mov"));
const acquisitionContexts = [
  {
    id: "masked",
    bindings: [
      {
        assetId: acquisitionSource.asset.id,
        streamId: acquisitionSource.binding.streamId,
        available: [
          { startUs: 0, endUs: 250000 },
          { startUs: 500000, endUs: 2000000 },
        ],
      },
    ],
  },
  {
    id: "complete",
    bindings: [
      {
        assetId: acquisitionSource.asset.id,
        streamId: acquisitionSource.binding.streamId,
        available: [{ startUs: 0, endUs: 2000000 }],
      },
    ],
  },
];
const acquiredPictures = [
  {
    ...picture("masked-occurrence", "tagged-a.mov", 0, 1000000, 0, 1000000),
    acquisitionId: "masked",
  },
  {
    ...picture("complete-occurrence", "tagged-a.mov", 0, 1000000, 1000000, 2000000),
    acquisitionId: "complete",
  },
  picture("physical-occurrence", "tagged-a.mov", 0, 1000000, 2000000, 3000000),
];
const acquisitionIDs = repeated(
  ["A0", 5],
  ["black", 5],
  ["A2", 5],
  ["A3", 5],
  ["A0", 5],
  ["A1", 5],
  ["A2", 5],
  ["A3", 5],
  ["A0", 5],
  ["A1", 5],
  ["A2", 5],
  ["A3", 5],
);
for (const [name, range] of [
  ["acquisition-occurrences", { startUs: 0, endUs: 3000000 }],
  ["acquisition-boundary-window", { startUs: 249999, endUs: 500001 }],
])
  scenarios.push({
    name,
    acquisitions: acquisitionContexts,
    original: { pictures: acquiredPictures, range },
    expected: { frameIDsOnFullProjectGrid: acquisitionIDs },
  });
scenarios.push({
  name: "acquisition-held-pictures",
  acquisitions: acquisitionContexts,
  original: {
    pictures: [
      ["masked", 300000],
      ["complete", 300000],
      [undefined, 300000],
      ["masked", 249999],
      ["masked", 250000],
      ["masked", 500000],
    ].map(([acquisitionId, holdUs], index) => ({
      ...picture(`held-${index}`, "tagged-a.mov", 0, 1000000, index * 250000, (index + 1) * 250000),
      acquisitionId,
      holdUs,
    })),
    range: { startUs: 0, endUs: 1500000 },
  },
  expected: {
    frameIDsOnFullProjectGrid: repeated(
      ["black", 5],
      ["A1", 5],
      ["A1", 5],
      ["A0", 5],
      ["black", 5],
      ["A2", 5],
    ),
  },
});
for (const { name, original, expected, fps, acquisitions } of scenarios) {
  const directory = join(out, name);
  await mkdir(directory);
  const { request, frames } = await compile(
    original.pictures,
    original.range,
    directory,
    fps,
    acquisitions,
  );
  await save(join(directory, "request.json"), request);
  const response = call("media.renderCompositionVideo", request);
  assert.equal(response.ok, true, `${name}: ${JSON.stringify(response)}`);
  if (name === "raster-reuse-transitions") assert.equal(response.data.rasterizedFrames, 6);
  if (name.startsWith("sparse-forward"))
    assert.ok(
      response.data.decodedSamples < 100,
      `${name}: decoded discarded middle footage (${response.data.decodedSamples} samples)`,
    );

  const metadata = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_frames",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      request.output,
    ]),
  );
  const raw = ff([
    "-i",
    request.output,
    "-map",
    "0:v:0",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const observed = metadata.frames.filter((f) => f.media_type === "video");
  assert.equal(raw.length, frames.length * bytes);
  const ids = [];
  for (let i = 0; i < frames.length; i++) {
    const actual = classify(raw.subarray(i * bytes, (i + 1) * bytes), refs);
    assert.equal(
      actual.id,
      expected.frameIDsOnFullProjectGrid[frames[i].index],
      `${name} frame ${i}`,
    );
    assert.equal(
      Math.round(Number(observed[i].best_effort_timestamp_time) * 1e6),
      frames[i].visibleRange.startUs - request.range.startUs,
    );
    assert.equal(
      Math.round(Number(observed[i].duration_time) * 1e6),
      frames[i].visibleRange.endUs - frames[i].visibleRange.startUs,
    );
    ids.push(actual.id);
  }
  assert.equal(
    Math.round(Number(metadata.format.duration) * 1e6),
    request.range.endUs - request.range.startUs,
  );
  assert.equal(metadata.streams[0].color_space, "bt709");
  assert.equal(metadata.streams[0].color_transfer, "bt709");
  assert.equal(metadata.streams[0].color_primaries, "bt709");
  await mkdir(join(directory, "shots"));
  ff(["-i", request.output, "-fps_mode", "passthrough", join(directory, "shots/%03d.png")]);
  results.push({ name, ids, receipt: response.data });
}

const negatives = [];
const base = await json(join(out, "av-replacement/request.json"));
async function rejected(name, change, code) {
  const directory = join(out, name);
  await mkdir(directory);
  const request = { ...base, ...change, output: join(directory, "video.mp4") };
  const response = call("media.renderCompositionVideo", request);
  assert.equal(response.ok, false, name);
  assert.equal(response.error.code, code, JSON.stringify(response));
  assert.deepEqual(await readdir(directory), [], `${name} leaked staging/output`);
  negatives.push({ name, error: response.error });
}
await rejected("odd-canvas", { canvas: { ...base.canvas, width: 159 } }, "INVALID_REQUEST");
await rejected(
  "transparent-canvas",
  { canvas: { ...base.canvas, background: "#00000000" } },
  "NOT_READY",
);
await rejected(
  "unknown-profile",
  { settings: { ...base.settings, video: { ...base.settings.video, profile: "mystery" } } },
  "UNSUPPORTED_FORMAT",
);
await rejected(
  "missing-stream",
  { assets: base.assets.map((a) => ({ ...a, streamId: "track:999" })) },
  "INVALID_REQUEST",
);
const first = JSON.parse((await readFile(base.frames, "utf8")).split("\n")[0]);
for (const [name, frame, code] of [
  [
    "unknown-availability",
    { ...first, layers: first.layers.map((l) => ({ ...l, availability: "mystery" })) },
    "INVALID_REQUEST",
  ],
  ...["available", "source-unavailable", "anchor-unavailable"].map((availability) => [
    `outside-physical-support-${availability}`,
    {
      ...first,
      layers: first.layers.map((layer) => ({ ...layer, sourceUs: 2000000, availability })),
    },
    "UNAVAILABLE",
  ]),
  ["unknown-frame-field", { ...first, guess: 1 }, "INVALID_REQUEST"],
  ["duplicate-layer", { ...first, layers: [first.layers[0], first.layers[0]] }, "INVALID_REQUEST"],
  [
    "unknown-picture-primitive",
    {
      ...first,
      visual: first.visual.map((node, index) =>
        index ? node : { ...node, operations: [{ kind: "unknown" }] },
      ),
    },
    "NOT_READY",
  ],
]) {
  const path = join(out, name + ".jsonl");
  await writeFile(path, JSON.stringify(frame) + "\n");
  await rejected(name, { frames: path }, code);
}
const gap = await json(join(out, "empty-edit-preview/request.json"));
const gapFrame = JSON.parse((await readFile(gap.frames, "utf8")).split("\n")[0]);
assert.equal(gapFrame.layers[0].availability, "source-unavailable");
const anchorPath = join(out, "anchor-unavailable.jsonl");
await writeFile(
  anchorPath,
  JSON.stringify({
    ...gapFrame,
    layers: gapFrame.layers.map((l) => ({ ...l, availability: "anchor-unavailable" })),
  }) + "\n",
);
const anchorRequest = {
  ...gap,
  range: gapFrame.visibleRange,
  frames: anchorPath,
  output: join(out, "anchor-unavailable.mp4"),
};
const anchorResponse = call("media.renderCompositionVideo", anchorRequest);
assert.equal(anchorResponse.ok, true, JSON.stringify(anchorResponse));
const anchorPixels = ff([
  "-i",
  anchorRequest.output,
  "-map",
  "0:v:0",
  "-fps_mode",
  "passthrough",
  "-pix_fmt",
  "rgb24",
  "-f",
  "rawvideo",
  "pipe:1",
]);
assert.equal(anchorPixels.length, bytes);
// Decoded H.264 black can differ by two channel levels from the lossless canvas.
assert.ok(
  anchorPixels.every((value) => value <= 2),
  "Excluded ancestor must leave the black canvas intact within the decoded codec budget",
);
const ancestorExclusion = {
  request: anchorRequest,
  response: anchorResponse,
  maximumDecodedChannel: Math.max(...anchorPixels),
};

const resources = [];
let cancellation = null;
if (!args.includes("--temporal-only")) {
  for (const seconds of [3, 600]) {
    const directory = join(out, `held-${seconds}s`);
    await mkdir(directory);
    const { request } = await compile(
      [
        {
          ...picture("held", "tagged-a.mov", 375000, 375001, 0, seconds * 1000000),
          holdUs: 375000,
        },
      ],
      { startUs: 0, endUs: seconds * 1000000 },
      directory,
    );
    await save(join(directory, "request.json"), request);
    const measured = spawnSync("/usr/bin/time", ["-l", native], {
      input:
        JSON.stringify({
          id: "resources",
          operation: "media.renderCompositionVideo",
          params: request,
        }) + "\n",
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.ifError(measured.error);
    assert.equal(measured.status, 0, measured.stderr.toString());
    const response = JSON.parse(measured.stdout);
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.data.readerOpens, 1);
    assert.equal(response.data.decodedSamples, 1);
    assert.equal(response.data.rasterizedFrames, 1);
    assert.equal(response.data.frames, seconds * 20);
    const counted = JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-of",
        "json",
        request.output,
      ]),
    );
    assert.equal(Number(counted.streams[0].nb_read_frames), seconds * 20);
    const peakRSSBytes = Number(
      measured.stderr.toString().match(/(\d+)\s+maximum resident set size/)?.[1],
    );
    assert.ok(Number.isFinite(peakRSSBytes));
    resources.push({ seconds, peakRSSBytes, receipt: response.data });
  }
  assert.ok(
    resources[1].peakRSSBytes <= resources[0].peakRSSBytes + 128 * 1024 * 1024,
    "Memory grows with retained frame count",
  );
  const cancellationDirectory = join(out, "cancellation");
  await mkdir(cancellationDirectory);
  const cancelRequest = await json(join(out, "held-600s/request.json"));
  cancelRequest.output = join(cancellationDirectory, "video.mp4");
  await save(join(cancellationDirectory, "request.json"), cancelRequest);
  cancellation = run(
    process.env.YAP_COMPOSITION_VIDEO_TESTS ??
      join(root, "helpers/mac/.build/debug/YapCompositionVideoTests"),
    [join(cancellationDirectory, "request.json")],
  )
    .toString()
    .trim();
  assert.deepEqual((await readdir(cancellationDirectory)).sort(), ["request.json"]);
  const firstRecord = JSON.parse((await readFile(cancelRequest.frames, "utf8")).split("\n")[0]);
  const retryFrames = join(cancellationDirectory, "retry.jsonl");
  await writeFile(retryFrames, JSON.stringify(firstRecord) + "\n");
  const retry = call("media.renderCompositionVideo", {
    ...cancelRequest,
    frames: retryFrames,
    range: firstRecord.visibleRange,
  });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  const restartedPixels = ff([
    "-i",
    cancelRequest.output,
    "-map",
    "0:v:0",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  assert.equal(restartedPixels.length, bytes);
  assert.equal(classify(restartedPixels, refs).id, "A1");
  cancellation += "; same-path worker restart renders the expected A1 frame";
}
await save(join(out, "report.json"), {
  productionNativeEntry: true,
  livePublicJourney: false,
  resourceChecksRun: !args.includes("--temporal-only"),
  sourceProfiles,
  ancestorExclusion,
  results,
  negatives,
  resources,
  cancellation,
});
console.log(
  JSON.stringify({ out, cases: results.length, refusals: negatives.length, passed: true }),
);
