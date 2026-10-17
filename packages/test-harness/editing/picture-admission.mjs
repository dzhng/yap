import { resolveOutputSettings } from "../../composition/dist/index.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
const out = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && process.env.YAP_NATIVE);
await mkdir(out);
let sequence = 0;
const checks = [];
const run = (program, args, input) => {
  const p = spawnSync(program, args, { input, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr.toString());
  return p.stdout;
};
const call = (operation, params) =>
  JSON.parse(
    run(
      process.env.YAP_NATIVE,
      [],
      JSON.stringify({ id: String(++sequence), operation, params }) + "\n",
    ),
  );
const canvas = {
  width: 64,
  height: 48,
  fps: { numerator: 10, denominator: 1 },
  background: "#000000ff",
};
const asset = {
  id: "source",
  streams: [
    {
      id: "track:1",
      kind: "video",
      width: 64,
      height: 48,
      bounds: { startUs: 0, endUs: 1000000 },
      available: [{ startUs: 0, endUs: 1000000 }],
    },
  ],
};
const document = {
  canvas,
  tracks: [{ id: "video", kind: "video", order: 0 }],
  groups: [],
  clips: [
    {
      id: "later",
      trackId: "video",
      assetId: "source",
      streamId: "track:1",
      source: { kind: "range", range: { startUs: 0, endUs: 600000 } },
      placement: { kind: "project", range: { startUs: 200000, endUs: 800000 } },
    },
  ],
  processing: [],
  syncGroups: [],
};
const compiler = createCompiler(validateComposition(document, [asset]), "inactive-clip");
for (const point of [{ kind: "dry" }, { kind: "processed" }]) {
  const window = compiler.videoWindow({
    range: { startUs: 0, endUs: 1 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "clip", id: "later" }, point },
  });
  const frame = [...window.frames()][0],
    output = join(out, `inactive-${point.kind}.png`);
  assert.deepEqual(frame.layers, []);
  const response = call("media.renderCompositionFrame", {
    canvas,
    frame,
    processing: window.processing(),
    assets: [],
    profile: "h264-rec709",
    output,
  });
  await writeFile(join(out, `inactive-${point.kind}.json`), JSON.stringify(response, null, 2));
  assert.ok(response.ok, JSON.stringify(response));
  assert.deepEqual(response.data.pictures, []);
  assert.equal(response.data.readerOpens, 0);
  assert.equal(response.data.decodedSamples, 0);
  const rgba = run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-i",
    output,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  for (let at = 3; at < rgba.length; at += 4) assert.equal(rgba[at], 0);
  checks.push({ inactive: point.kind, readerOpens: 0, transparent: true });
}
const encoded = join(out, "encoded.mov");
const source = join(out, "large.mov");
run("ffmpeg", [
  "-v",
  "error",
  "-nostdin",
  "-f",
  "lavfi",
  "-i",
  "color=black:size=4000x4000:rate=1",
  "-frames:v",
  "1",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p",
  encoded,
]);
const author = join(out, "orientation");
run("xcrun", [
  "swiftc",
  "-parse-as-library",
  "packages/test-harness/editing/layers-orientation.swift",
  "-o",
  author,
]);
run(author, [encoded, source, "0", "0.01"]);
const probe = call("media.probe", { path: source });
assert.ok(probe.ok, JSON.stringify(probe));
const stream = probe.data.streams.find((s) => s.kind === "video");
assert.equal(stream.width, 4000);
assert.equal(stream.orientedWidth, 40);
const large = {
  id: "large",
  streams: [
    {
      id: stream.id,
      kind: "video",
      width: stream.orientedWidth,
      height: stream.orientedHeight,
      pixelBounds: stream.orientedPixelBounds,
      bounds: { startUs: 0, endUs: 1000000 },
      available: [{ startUs: 0, endUs: 1000000 }],
    },
  ],
};
function sourceFrame(count, disabledPointer = false, range = { startUs: 0, endUs: 1 }) {
  const tracks = Array.from({ length: count }, (_, i) => ({
    id: `v${i}`,
    kind: "video",
    order: i,
  }));
  const clips = tracks.map((t) => ({
    id: t.id,
    trackId: t.id,
    assetId: "large",
    ...(disabledPointer ? { acquisitionId: "wire-fixture" } : {}),
    streamId: stream.id,
    source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
    placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
  }));
  const c = createCompiler(
    validateComposition(
      {
        ...document,
        tracks,
        clips,
        processing: disabledPointer
          ? [
              {
                target: { kind: "clip", id: "v0" },
                steps: [
                  {
                    id: "bypassed-pointer",
                    enabled: false,
                    processor: { type: "pointer", trailUs: 2_000_000 },
                  },
                ],
              },
            ]
          : [],
      },
      [large],
      disabledPointer
        ? [
            {
              id: "wire-fixture",
              bindings: [
                {
                  assetId: "large",
                  streamId: stream.id,
                  available: [{ startUs: 0, endUs: 1_000_000 }],
                },
              ],
            },
          ]
        : [],
    ),
    "source-budget",
  );
  const window = c.videoWindow({
    range,
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  return {
    canvas,
    frame: [...window.frames()][0],
    processing: window.processing(),
    assets: [
      { assetId: "large", streamId: stream.id, path: source, originUs: probe.data.originUs },
    ],
    profile: "h264-rec709",
  };
}
const largeCanvas = { ...canvas, width: 1024, height: 1024 };
const empty = {
  index: 0,
  sampleAtUs: 0,
  visibleRange: { startUs: 0, endUs: 1 },
  layers: [],
  visual: [{ target: { kind: "output" }, inputs: [], operations: [] }],
};
const rasterFrame = {
  ...empty,
  visual: [
    {
      ...empty.visual[0],
      operations: Array.from({ length: 65 }, () => ({
        kind: "rasterize",
        width: 1024,
        height: 1024,
      })),
    },
  ],
};
const masks = Array.from({ length: 65 }, (_, i) => ({
  target: { kind: "group", id: `g${i}` },
  inputs: [],
  operations: [
    {
      kind: "coverage",
      width: 1024,
      height: 1024,
      points: [
        { x: i / 4, y: 0 },
        { x: 1024, y: 0 },
        { x: 1024, y: 1024 },
        { x: i / 4, y: 1024 },
      ],
    },
  ],
}));
const maskFrame = {
  ...empty,
  visual: [
    ...masks,
    { target: { kind: "output" }, inputs: masks.map((m) => m.target), operations: [] },
  ],
};
for (const [name, params] of [
  ["decoded-source-pixels", sourceFrame(5)],
  [
    "intermediate-pixels",
    { canvas: largeCanvas, frame: rasterFrame, processing: [], assets: [], profile: "h264-rec709" },
  ],
  [
    "coverage-mask-bytes",
    { canvas: largeCanvas, frame: maskFrame, processing: [], assets: [], profile: "h264-rec709" },
  ],
]) {
  await writeFile(join(out, name + "-request.json"), JSON.stringify(params));
  const dir = join(out, name);
  await mkdir(dir);
  const response = call("media.renderCompositionFrame", {
    ...params,
    output: join(dir, "frame.png"),
  });
  await writeFile(join(out, name + ".json"), JSON.stringify(response, null, 2));
  assert.equal(response.error?.code, "NOT_READY", JSON.stringify(response));
  assert.match(response.error.message, new RegExp(name));
  assert.match(response.error.message, /67108864/);
  assert.equal(response.error.retryable, false);
  assert.deepEqual(await readdir(dir), []);
  checks.push({ limit: name, response: response.error });
}
const recovered = call("media.renderCompositionFrame", {
  ...sourceFrame(1),
  output: join(out, "recovered.png"),
});
assert.ok(recovered.ok, JSON.stringify(recovered));
assert.equal(recovered.data.readerOpens, 1);
checks.push({ recovery: true, readerOpens: 1 });
const bypass = call("media.renderCompositionFrame", {
  ...sourceFrame(1, true),
  output: join(out, "disabled-pointer.png"),
});
assert.ok(bypass.ok, JSON.stringify(bypass));
assert.deepEqual(bypass.data.pictures, recovered.data.pictures);
assert.deepEqual(await readFile(bypass.data.file), await readFile(recovered.data.file));
const moviePixels = [];
for (const disabledPointer of [false, true]) {
  const range = { startUs: 0, endUs: 100000 };
  const { frame, canvas: movieCanvas, processing, assets } = sourceFrame(1, disabledPointer, range);
  const frames = join(out, `pointer-${disabledPointer}.jsonl`);
  await writeFile(frames, JSON.stringify(frame) + "\n");
  const rendered = call("media.renderCompositionVideo", {
    canvas: movieCanvas,
    processing,
    assets,
    settings: resolveOutputSettings(),
    frames,
    range,
    output: join(out, `pointer-${disabledPointer}.mp4`),
  });
  assert.ok(rendered.ok, JSON.stringify(rendered));
  assert.equal(rendered.data.durationUs, 100000);
  moviePixels.push(
    run("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-i",
      rendered.data.file,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-fps_mode",
      "passthrough",
      "pipe:1",
    ]),
  );
}
assert.ok(moviePixels[0].length > 0);
assert.deepEqual(moviePixels[0], moviePixels[1]);
checks.push({
  disabledPointer: { frameBytesExact: true, picturesExact: true, decodedMoviePixelsExact: true },
});
await writeFile(join(out, "report.json"), JSON.stringify({ checks }, null, 2));
console.log(JSON.stringify({ out, passed: true, checks: checks.length }));
