import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { compositionAsset } from "../../core/dist/assets.js";
import { classify, corpusReferences } from "./render-membership.mjs";

// Consume the independently asserted every-frame movie corpus, including physical empty edits,
// repeated/reordered clips, global picture phase, holds, retiming and acquisition masks.
const root = fileURLToPath(new URL("../../../", import.meta.url));
// Historical movie parity is a separate experiment against a retired executor.
const historicalParity = process.argv.includes("--historical-parity");
const [flag, input, outFlag, output, caseFlag, caseName] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--historical-parity");
assert.ok(caseFlag === undefined || (caseFlag === "--case" && caseName));
assert.equal(flag, "--rendered");
assert.equal(outFlag, "--out");
const rendered = resolve(input),
  out = resolve(output);
const native = process.env.YAP_NATIVE;
const baseline = process.env.YAP_BASELINE_NATIVE;
const cancellationWorker = process.env.YAP_COMPOSITION_CANCEL_TEST;
assert.ok(cancellationWorker, "The production NativeWire cancellation test executable is required");
assert.ok(native, "The current native binary is required");
if (historicalParity) assert.ok(baseline, "Historical parity requires YAP_BASELINE_NATIVE");
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), []);
const run = (binary, args, input) => {
  const result = spawnSync(binary, args, { input, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const call = (binary, operation, params) =>
  JSON.parse(run(binary, [], JSON.stringify({ id: "picture", operation, params }) + "\n"));
const raw = (path) =>
  run("ffmpeg", [
    "-v",
    "error",
    "-i",
    path,
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
const json = async (path) => JSON.parse(await readFile(path));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const refs = corpusReferences((id) =>
  raw(join(root, "specs/done/agent-editing/assets/00-corpus", id + ".mov")),
);
const results = [],
  movieMismatches = [],
  correctedMovies = [];
const corrections = historicalParity
  ? await json(
      join(root, "specs/done/agent-editing/assets/15-layer-geometry/corrected-movie-pixels.json"),
    )
  : [];
const report = await json(join(rendered, "report.json"));
const scenarios = caseName
  ? report.results.filter((scenario) => scenario.name === caseName)
  : report.results;
assert.ok(scenarios.length > 0, "No matching picture case");
for (const scenario of scenarios) {
  const directory = join(out, scenario.name);
  await mkdir(directory);
  const request = await json(join(rendered, scenario.name, "request.json"));
  const frames = (await readFile(request.frames, "utf8")).trim().split("\n").map(JSON.parse);
  const currentPixels = raw(request.output);
  if (historicalParity) {
    // The immutable baseline executable predates compiled visual instructions.
    const frozenFrames = join(directory, "frozen-frames.jsonl");
    await writeFile(
      frozenFrames,
      frames
        .map((frame) => {
          const old = structuredClone(frame);
          delete old.visual;
          old.layers.forEach((layer) => {
            delete layer.width;
            delete layer.height;
            layer.placement = "contain";
          });
          return JSON.stringify(old) + "\n";
        })
        .join(""),
    );
    const frozen = call(baseline, "media.renderCompositionVideo", {
      ...request,
      frames: frozenFrames,
      output: join(directory, "frozen.mp4"),
    });
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    const oldPixels = raw(frozen.data.file);
    if (hash(currentPixels) !== hash(oldPixels)) {
      const observed = { case: scenario.name, before: hash(oldPixels), after: hash(currentPixels) };
      if (
        corrections.some(
          (c) =>
            c.case === observed.case && c.before === observed.before && c.after === observed.after,
        )
      )
        correctedMovies.push(observed);
      else movieMismatches.push(observed);
    }
  }
  const receipts = [];
  for (const [index, frame] of frames.entries()) {
    const still = {
      output: join(directory, `${String(index).padStart(3, "0")}.png`),
      frame,
      canvas: request.canvas,
      profile: request.profile,
      processing: request.processing,
      assets: request.assets,
    };
    const response = call(native, "media.renderCompositionFrame", still);
    assert.equal(response.ok, true, JSON.stringify(response));
    const receipt = response.data;
    assert.deepEqual(receipt.frame, frame);
    assert.equal(
      classify(raw(receipt.file), refs).id,
      scenario.ids[index],
      `${scenario.name} still ${index}`,
    );
    const layer = frame.layers[0];
    if (!layer) assert.deepEqual(receipt.pictures, []);
    else {
      assert.equal(receipt.pictures[0].clipId, layer.clipId);
      assert.equal(receipt.pictures[0].assetId, layer.assetId);
      assert.equal(receipt.pictures[0].streamId, layer.streamId);
      assert.deepEqual(receipt.pictures[0].requestedSourceUs, layer.sourceUs);
      if (layer.availability === "source-unavailable") {
        assert.equal(receipt.pictures[0].status, "unavailable");
        assert.equal(receipt.pictures[0].reason, "source-unavailable");
      } else if (scenario.ids[index] === "black") {
        assert.equal(receipt.pictures[0].status, "unavailable");
        assert.equal(receipt.pictures[0].reason, "physical-empty");
      } else {
        assert.equal(receipt.pictures[0].status, "available");
        const sample = receipt.pictures[0].sample;
        const binding = request.assets.find(
          (a) => a.assetId === layer.assetId && a.streamId === layer.streamId,
        );
        assert.equal(sample.originUs, binding.originUs);
        assert.equal(
          receipt.pictures[0].actualSourceUs,
          Math.round((Number(sample.value) * 1e6) / sample.timescale) - sample.originUs,
        );
        const requested =
          typeof layer.sourceUs === "number"
            ? { numerator: layer.sourceUs, denominator: 1 }
            : layer.sourceUs;
        assert.ok(
          (BigInt(sample.value) * 1000000n - BigInt(sample.originUs) * BigInt(sample.timescale)) *
            BigInt(requested.denominator) <=
            BigInt(requested.numerator) * BigInt(sample.timescale),
          "Selected physical sample starts after the exact requested source time",
        );
      }
    }
    receipts.push(receipt);
  }
  await writeFile(join(directory, "receipts.json"), JSON.stringify(receipts, null, 2));
  results.push({
    name: scenario.name,
    pictures: frames.length,
    moviePixelSHA256: hash(currentPixels),
    ids: scenario.ids,
  });
}
await writeFile(
  join(out, "movie-parity.json"),
  JSON.stringify({ historicalParity, results, movieMismatches, correctedMovies }, null, 2),
);
const base = await json(join(rendered, "av-replacement/request.json"));
const frame = JSON.parse((await readFile(base.frames, "utf8")).split("\n")[0]);
const still = {
  frame,
  canvas: base.canvas,
  assets: base.assets,
  profile: base.profile,
  processing: base.processing,
};
const negatives = [];
for (const [name, change, code] of [
  ["encoded-limit", { maxEncodedBytes: 1 }, "LIMIT_EXCEEDED"],
  ["oversize-limit", { maxEncodedBytes: 33554433 }, "INVALID_REQUEST"],
  ["invalid-size", { maxLongEdge: 8193 }, "INVALID_REQUEST"],
  ["unknown-crop", { crop: { x: 0, y: 0, width: 20, height: 20 } }, "INVALID_REQUEST"],
  [
    "duplicate-layer",
    { frame: { ...frame, layers: [frame.layers[0], frame.layers[0]] } },
    "INVALID_REQUEST",
  ],
]) {
  const directory = join(out, name);
  await mkdir(directory);
  const response = call(native, "media.renderCompositionFrame", {
    ...still,
    ...change,
    output: join(directory, "frame.png"),
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, code, JSON.stringify(response));
  assert.deepEqual(await readdir(directory), [], `${name} leaked native staging`);
  negatives.push({ name, code });
}
const bounded = call(native, "media.renderCompositionFrame", {
  ...still,
  maxLongEdge: 80,
  output: join(out, "bounded.png"),
});
assert.equal(bounded.ok, true, JSON.stringify(bounded));
assert.deepEqual(
  [bounded.data.width, bounded.data.height, bounded.data.sourceWidth, bounded.data.sourceHeight],
  [80, 64, 160, 128],
);
const physicalRequest = await json(join(rendered, "empty-edit/request.json"));
const physicalFrame = (await readFile(physicalRequest.frames, "utf8"))
  .trim()
  .split("\n")
  .map(JSON.parse)
  .find((item) => item.layers[0]?.availability === "source-unavailable");
assert.ok(physicalFrame);
const physical = call(native, "media.renderCompositionFrame", {
  ...still,
  assets: physicalRequest.assets,
  frame: {
    ...physicalFrame,
    layers: physicalFrame.layers.map((layer) => ({ ...layer, availability: "available" })),
  },
  output: join(out, "physical-empty.png"),
});
assert.equal(physical.ok, true, JSON.stringify(physical));
assert.equal(physical.data.pictures[0].status, "unavailable");
assert.equal(physical.data.pictures[0].reason, "physical-empty");
assert.equal(classify(raw(physical.data.file), refs).id, "black");
const fractionalFile = join(out, "fractional.mov");
run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=160x128:rate=30000/1001",
  "-frames:v",
  "3",
  "-c:v",
  "libx264",
  "-bf",
  "0",
  "-video_track_timescale",
  "90000",
  fractionalFile,
]);
const probed = call(native, "media.probe", { path: fractionalFile });
assert.equal(probed.ok, true, JSON.stringify(probed));
const fractionalStream = probed.data.streams.find((stream) => stream.kind === "video").id;
const fractionalDocument = {
  canvas: still.canvas,
  tracks: [{ id: "fractional-track", kind: "video", order: 0 }],
  groups: [],
  clips: [
    {
      id: "fractional-picture",
      trackId: "fractional-track",
      assetId: "fractional",
      streamId: fractionalStream,
      source: { kind: "range", range: { startUs: 33367, endUs: 33368 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1 } },
    },
  ],
  processing: [],
  syncGroups: [],
};
const fractionalWindow = createCompiler(
  validateComposition(fractionalDocument, [compositionAsset({ id: "fractional", ...probed.data })]),
  "fractional-probe",
).videoWindow({
  range: { startUs: 0, endUs: 1 },
  rendition: { sampleRate: 48000, channels: 2 },
  tap: { target: { kind: "output" }, point: { kind: "processed" } },
});
const fractional = call(native, "media.renderCompositionFrame", {
  ...still,
  assets: [
    {
      assetId: "fractional",
      streamId: fractionalStream,
      path: fractionalFile,
      originUs: probed.data.originUs,
    },
  ],
  frame: [...fractionalWindow.frames()][0],
  processing: fractionalWindow.processing(),
  output: join(out, "fractional.png"),
});
assert.equal(fractional.ok, true, JSON.stringify(fractional));
assert.equal(fractional.data.pictures[0].actualSourceUs, 33367);
const sample = fractional.data.pictures[0].sample;
assert.equal(BigInt(sample.value) * 30000n, 1001n * BigInt(sample.timescale));
assert.notEqual((BigInt(sample.value) * 1000000n) % BigInt(sample.timescale), 0n);
const defaultBound = call(native, "media.renderCompositionFrame", {
  ...still,
  frame: {
    ...frame,
    layers: [],
    visual: [{ target: { kind: "output" }, inputs: [], operations: [] }],
  },
  canvas: { ...still.canvas, width: 3200, height: 1800 },
  output: join(out, "default-bound.png"),
});
assert.equal(defaultBound.ok, true, JSON.stringify(defaultBound));
assert.deepEqual(
  [
    defaultBound.data.width,
    defaultBound.data.height,
    defaultBound.data.sourceWidth,
    defaultBound.data.sourceHeight,
  ],
  [1600, 900, 3200, 1800],
);
const cancelDirectory = join(out, "cancellation");
await mkdir(cancelDirectory);
const cancelRequest = join(cancelDirectory, "request.json");
await writeFile(
  cancelRequest,
  JSON.stringify({
    ...still,
    frame: {
      ...frame,
      layers: [],
      visual: [{ target: { kind: "output" }, inputs: [], operations: [] }],
    },
    canvas: { ...still.canvas, width: 4096, height: 4096 },
    output: join(cancelDirectory, "frame.png"),
  }),
);
const cancellation = run(cancellationWorker, [cancelRequest, "media.renderCompositionFrame"])
  .toString()
  .trim();
assert.deepEqual(await readdir(cancelDirectory), ["request.json"]);
await writeFile(
  join(out, "report.json"),
  JSON.stringify(
    {
      results,
      historicalParity,
      movieMismatches,
      correctedMovies,
      negatives,
      bounded: bounded.data,
      physical: physical.data,
      fractional: fractional.data,
      defaultBound: defaultBound.data,
      cancellation,
      passed: movieMismatches.length === 0,
    },
    null,
    2,
  ),
);
assert.deepEqual(
  movieMismatches,
  [],
  "Frozen movie pixels changed; all mismatches retained in report.json",
);
console.log(
  JSON.stringify({
    out,
    cases: results.length,
    pictures: results.reduce((sum, r) => sum + r.pictures, 0),
    passed: true,
  }),
);
