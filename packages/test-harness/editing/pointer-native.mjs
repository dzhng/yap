import { resolveOutputSettings } from "../../composition/dist/index.js";
import { pointerCases } from "./pointer-cases.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { Catalog, CatalogError } from "../../core/dist/catalog.js";
import { AssetStore, compositionAsset } from "../../core/dist/assets.js";
import { AcquisitionStore, AcquisitionImporter } from "../../core/dist/acquisitions.js";
import { SourceEvidenceStore } from "../../core/dist/evidence.js";
import { JobQueue } from "../../core/dist/jobs.js";
import { DerivedCache } from "../../core/dist/cache.js";
import { PointerPreparation } from "../../core/dist/pointer-preparation.js";
import {
  prepareCompositionPointers,
  pointerPreparationLimits,
} from "../../core/dist/composition-pointer.js";
import { renderPlan } from "../../core/dist/presentation-time.js";

const out = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && process.env.YAP_NATIVE);
await mkdir(out);
const run = (program, args, input) => {
  const result = spawnSync(program, args, {
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const rawCall = (operation, params) =>
  JSON.parse(
    run(process.env.YAP_NATIVE, [], JSON.stringify({ id: "pointer", operation, params }) + "\n"),
  );
const call = (operation, params) => {
  const result = rawCall(operation, params);
  if (!result.ok)
    throw new CatalogError(
      result.error.code,
      result.error.message,
      result.error.details,
      result.error.retryable,
    );
  return result.data;
};
const donor = join(out, "authored-capture");
await mkdir(donor);
run("ffmpeg", [
  "-v",
  "error",
  "-nostdin",
  "-f",
  "lavfi",
  "-i",
  "color=gray:s=256x160:r=10:d=2",
  "-c:v",
  "libx264",
  "-qp",
  "1",
  join(donor, "video.mov"),
]);
const records = [
  {
    event: "geometry",
    data: {
      sourceUs: 0,
      epoch: 1,
      hostUs: 1,
      geometry: {
        outputWidth: 256,
        outputHeight: 160,
        contentScale: 1,
        scaleFactor: 1,
        contentRect: { x: 0, y: 0, width: 256, height: 160 },
      },
    },
  },
  ...[100000, 300000, 500000, 700000, 900000, 1100000, 1300000, 1500000, 1700000, 1900000].map(
    (sourceUs, i) => ({
      event: "cursorSample",
      data: {
        sourceUs,
        x: 24 + i * 20,
        y: 48 + i * 4,
        globalX: 24 + i * 20,
        globalY: 48 + i * 4,
        buttons: 0,
        eligibility: "inside",
        geometryEpoch: 1,
      },
    }),
  ),
];
await writeFile(
  join(donor, "capture.journal.jsonl"),
  JSON.stringify({ fixture: "authored pointer observations; no capture" }),
);
const home = join(out, "library");
await mkdir(home, { mode: 0o700 });
const catalog = new Catalog(join(home, "catalog.sqlite"));
const assets = new AssetStore(catalog, home);
await assets.recover();
const acquisitions = new AcquisitionStore(catalog);
const evidence = new SourceEvidenceStore(catalog, (identity) => {
  assert.equal(identity.owner.kind, "acquisition");
  acquisitions.intent(identity.owner.acquisitionId);
});
const importer = new AcquisitionImporter(catalog, acquisitions, assets, evidence, home);
await importer.recover(new AbortController().signal);
const prepared = await importer.prepareImport("fixture", donor);
const intent = catalog.transaction(() => acquisitions.admitImport(prepared));
const acquisition = await importer.executeImport(
  intent.acquisitionId,
  "fixture",
  {
    probe: async (path) => call("media.probe", { path }),
    exportSource: async (_directory, file) => {
      const body = records.map((row) => JSON.stringify(row) + "\n").join("");
      await writeFile(file, body);
      return {
        file,
        journal: "capture.journal.jsonl",
        header: { sessionID: "authored-pointer-fixture" },
        cursorSamples: records.length - 1,
        geometryRecords: 1,
        displaySpaces: 0,
        pauseEvents: 0,
        audioIntervals: 0,
        lastSequence: records.length,
        incompleteTail: false,
        finished: true,
        firstCursorSourceUs: 100000,
        lastCursorSourceUs: 1900000,
        bytes: Buffer.byteLength(body),
      };
    },
  },
  new AbortController().signal,
);
const binding = acquisition.bindings.find((b) => b.sourceRoles.includes("video"));
const selection = {
  assetId: binding.assetId,
  streamId: binding.streamId,
  acquisitionId: acquisition.id,
};
let preparation;
const jobs = new JobQueue({
  store: catalog,
  providers: { newId: randomUUID, createHash },
  targets: {
    pin: (target) => {
      assert.equal(target.kind, "acquisition");
      acquisitions.get(target.acquisitionId);
      return target;
    },
    isAvailable: () => true,
    isDeleting: () => false,
    isCapturing: () => false,
  },
  execute: (execution) => preparation.execute(execution),
});
const cache = new DerivedCache(catalog, home, (owner) => {
  assert.equal(owner.kind, "acquisition");
  acquisitions.get(owner.acquisitionId);
});
await cache.reconcile();
let calls = 0;
preparation = new PointerPreparation({
  assets,
  acquisitions,
  evidence,
  jobs,
  cache,
  renderer: {
    implementationId: "fixture-native-presentation",
    render: async (request, signal) => {
      signal.throwIfAborted();
      calls++;
      return call("media.presentationEvidence", {
        source: request.source,
        streamId: request.streamId,
        clockOffsetUs: request.clockOffsetUs,
        plan: renderPlan({ spans: request.spans }),
        output: request.output,
        ...request.limits,
      });
    },
  },
});
try {
  const queued = preparation.request(selection);
  assert.equal(jobs.retainsInput("asset", selection.assetId), true);
  await jobs.idle();
  const ready = preparation.request(selection);
  assert.equal(ready.state, "ready", JSON.stringify(jobs.job(queued.jobId)));
  assert.equal(calls, 1);
  assert.equal(jobs.retainsInput("asset", selection.assetId), false);
  await preparation.withHistory(
    selection,
    new AbortController().signal,
    async ({ presentation }) => {
      assert.equal(presentation.receipt.sourceWidth, 256);
      assert.throws(
        () => cache.remove(ready.published.value.cacheId),
        (error) => error.code === "CACHE_BUSY",
      );
    },
  );
  cache.remove(ready.published.value.cacheId);
  preparation.request(selection);
  assert.equal(jobs.retainsInput("asset", selection.assetId), true);
  await jobs.idle();
  assert.equal(preparation.request(selection).state, "ready");
  assert.equal(calls, 2);
  const canvas = {
    width: 256,
    height: 160,
    fps: { numerator: 10, denominator: 1 },
    background: "#000000ff",
  };
  const base = {
    canvas,
    tracks: [{ id: "video", kind: "video", order: 0 }],
    groups: [],
    syncGroups: [],
    clips: [
      {
        id: "clip",
        trackId: "video",
        ...selection,
        source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
      },
    ],
    processing: [],
  };
  const scenarios = pointerCases();
  const pointer = scenarios[0][1][0];
  const results = [],
    requests = new Map(),
    rendered = new Map();
  const pixelTool = join(out, "frame-pixels");
  run("swiftc", [
    "-parse-as-library",
    new URL("./FrameImagePixels.swift", import.meta.url).pathname,
    "-o",
    pixelTool,
  ]);
  for (const [name, steps] of scenarios) {
    const document = { ...base, processing: [{ target: { kind: "clip", id: "clip" }, steps }] };
    const model = validateComposition(
      document,
      [compositionAsset(assets.get(selection.assetId))],
      [acquisitions.context(selection.acquisitionId)],
    );
    const compiler = createCompiler(model, "authored-pointer");
    const window = compiler.videoWindow({
      range: { startUs: 1000000, endUs: 1000001 },
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const output = join(out, name + ".pointers.jsonl");
    const pointers = await prepareCompositionPointers(
      { model, frames: () => window.frames(), output, preparation, evidence },
      new AbortController().signal,
    );
    const frame = window.frames().next().value;
    const request = {
      output: join(out, name + ".png"),
      frame,
      canvas,
      profile: "h264-rec709",
      processing: window.processing(),
      assets: [
        {
          assetId: selection.assetId,
          streamId: selection.streamId,
          path: assets.path(selection.assetId),
          originUs: assets.get(selection.assetId).originUs,
        },
      ],
      maxLongEdge: 256,
      pointers,
    };
    requests.set(name, request);
    const result = call("media.renderCompositionFrame", request);
    const raw = join(out, name + ".rgba");
    run(pixelTool, [result.file, raw]);
    rendered.set(name, await readFile(raw));
    assert.deepEqual(result.frame, frame);
    assert.equal(result.pictures[0].status, "available");
    results.push({ name, pointers, result });
  }
  const identity = rendered.get("identity"),
    translated = rendered.get("translate");
  for (let y = 16; y < 160; y++)
    for (let x = 32; x < 256; x++)
      assert.deepEqual(
        translated.subarray((y * 256 + x) * 4, (y * 256 + x + 1) * 4),
        identity.subarray(((y - 16) * 256 + x - 32) * 4, ((y - 16) * 256 + x - 31) * 4),
        "Source-local overlay translation must happen exactly once",
      );
  assert.deepEqual(rendered.get("crop-before-pointer"), rendered.get("pointer-before-crop"));
  assert.deepEqual(rendered.get("rotate-before-pointer"), rendered.get("pointer-before-rotate"));
  const magenta = (raw, i) => raw[i] > raw[i + 1] + 20 && raw[i + 2] > raw[i + 1] + 10;
  const rotated = rendered.get("rotate-before-pointer");
  let trailPixels = 0,
    whitePixels = 0;
  for (let y = 0; y < 160; y++)
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      if (magenta(identity, i)) {
        trailPixels++;
        const tx = 207 - y,
          ty = x - 48;
        if (tx >= 0 && tx < 256 && ty >= 0 && ty < 160)
          assert.ok(
            magenta(rotated, (ty * 256 + tx) * 4),
            "Clockwise source overlay membership moved incorrectly",
          );
      }
      if (identity[i] > 248 && identity[i + 1] > 248 && identity[i + 2] > 248) {
        whitePixels++;
        assert.ok(rendered.get("before-opacity")[i] > 248);
        assert.ok(rendered.get("after-opacity")[i] < 180);
      }
    }
  assert.ok(trailPixels > 20 && whitePixels > 2);
  const sourceRow = JSON.parse(
    (await readFile(requests.get("identity").pointers.file, "utf8")).trim(),
  );
  // Retain the original independent legacy operand without executing its retired worker.
  const legacyFile = new URL(
    "../../../specs/done/agent-editing/assets/15-pointer-execution/images/legacy-matched.png",
    import.meta.url,
  ).pathname;
  const legacyRaw = join(out, "legacy-matched.rgba");
  run(pixelTool, [legacyFile, legacyRaw]);
  const legacyPixels = await readFile(legacyRaw);
  let legacyMaximum = 0,
    legacyChanged = 0;
  for (let i = 0; i < identity.length; i++) {
    const delta = Math.abs(identity[i] - legacyPixels[i]);
    legacyMaximum = Math.max(legacyMaximum, delta);
    if (delta) legacyChanged++;
  }
  const background = rendered.get("disabled");
  let legacySupportPixels = 0;
  for (let i = 0; i < identity.length; i += 4) {
    const support = (pixels) =>
      [0, 1, 2].some((channel) => Math.abs(pixels[i + channel] - background[i + channel]) > 4);
    assert.equal(support(identity), support(legacyPixels), "Matched legacy overlay support moved");
    if (support(identity)) legacySupportPixels++;
  }
  await writeFile(
    join(out, "legacy-matched-difference.json"),
    JSON.stringify({ maximum: legacyMaximum, changedChannels: legacyChanged, legacySupportPixels }),
  );

  const negatives = [];
  const original = JSON.parse(
    (await readFile(requests.get("identity").pointers.file, "utf8")).trim(),
  );
  for (const [name, mutate] of [
    ["wrong-source", (row) => (row.assetId = "wrong")],
    ["wrong-sample", (row) => (row.sampleTime = { value: "0", timescale: 1000000 })],
    ["wrong-request-clock", (row) => row.captureUs--],
    ["wrong-step", (row) => (row.stepId = "wrong")],
    ["extra-row", () => {}],
    ["missing-row", () => {}],
  ]) {
    const directory = join(out, name);
    await mkdir(directory);
    const row = structuredClone(original);
    mutate(row);
    const records = name === "missing-row" ? [] : name === "extra-row" ? [row, row] : [row];
    const body = records.map((r) => JSON.stringify(r) + "\n").join("");
    const file = join(directory, "pointers.jsonl");
    await writeFile(file, body);
    const request = {
      ...requests.get("identity"),
      output: join(directory, "result.png"),
      pointers: {
        file,
        bytes: Buffer.byteLength(body),
        records: records.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    };
    const result = rawCall("media.renderCompositionFrame", request);
    assert.equal(result.ok, false, name);
    assert.equal(result.error.code, "INVALID_REQUEST", JSON.stringify(result));
    assert.deepEqual(await readdir(directory), ["pointers.jsonl"]);
    negatives.push({ name, error: result.error });
  }
  for (const name of ["missing-preparation", "wrong-prefix"]) {
    const directory = join(out, name);
    await mkdir(directory);
    const request = structuredClone(requests.get("translate"));
    request.output = join(directory, "result.png");
    if (name === "missing-preparation") delete request.pointers;
    else request.frame.visual[0].operations.find((op) => op.kind === "pointer").geometryPrefix = [];
    const result = rawCall("media.renderCompositionFrame", request);
    assert.equal(result.ok, false, name);
    assert.equal(result.error.code, "INVALID_REQUEST");
    assert.deepEqual(await readdir(directory), []);
    negatives.push({ name, error: result.error });
  }
  const model = validateComposition(
    { ...base, processing: [{ target: { kind: "clip", id: "clip" }, steps: [pointer] }] },
    [compositionAsset(assets.get(selection.assetId))],
    [acquisitions.context(selection.acquisitionId)],
  );
  const compiler = createCompiler(model, "authored-pointer");
  for (const [name, limits] of [
    ["byte-budget", { ...pointerPreparationLimits, maxBytes: 1 }],
    ["occurrence-budget", { ...pointerPreparationLimits, maxRows: 1 }],
    ["frame-budget", { ...pointerPreparationLimits, maxFrames: 1 }],
  ]) {
    const directory = join(out, name);
    await mkdir(directory);
    await assert.rejects(
      prepareCompositionPointers(
        {
          model,
          frames: () => compiler.frames({ startUs: 0, endUs: 2000000 }),
          output: join(directory, "pointers.jsonl"),
          preparation,
          evidence,
        },
        new AbortController().signal,
        limits,
      ),
      (error) => error.code === "LIMIT_EXCEEDED",
    );
    assert.deepEqual(await readdir(directory), []);
    negatives.push({ name, unpublished: true });
  }
  const canceledDirectory = join(out, "canceled-preparation");
  await mkdir(canceledDirectory);
  const canceled = new AbortController();
  let passes = 0;
  const cancelFrames = () => {
    const pass = ++passes;
    return (function* () {
      let count = 0;
      for (const frame of compiler.frames({ startUs: 0, endUs: 2000000 })) {
        yield frame;
        if (pass === 2 && ++count === 1) canceled.abort();
      }
    })();
  };
  await assert.rejects(
    prepareCompositionPointers(
      {
        model,
        frames: cancelFrames,
        output: join(canceledDirectory, "pointers.jsonl"),
        preparation,
        evidence,
      },
      canceled.signal,
    ),
    (error) => error.name === "AbortError",
  );
  assert.deepEqual(await readdir(canceledDirectory), []);
  negatives.push({ name: "canceled-after-first-frame", unpublished: true });
  const referenceTool = join(out, "frame-reference");
  run("swiftc", [
    "-parse-as-library",
    new URL("./FrameColorReference.swift", import.meta.url).pathname,
    "-o",
    referenceTool,
  ]);
  const movies = [];
  for (const range of [
    { startUs: 0, endUs: 2000000 },
    { startUs: 1050001, endUs: 1250001 },
  ]) {
    const prefix = join(out, `movie-${range.startUs}`);
    const window = compiler.videoWindow({
      range,
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const compiled = [...window.frames()];
    const frames = prefix + ".frames.jsonl";
    await writeFile(frames, compiled.map((f) => JSON.stringify(f) + "\n").join(""));
    const pointers = await prepareCompositionPointers(
      {
        model,
        frames: () => window.frames(),
        output: prefix + ".pointers.jsonl",
        preparation,
        evidence,
      },
      new AbortController().signal,
    );
    const sourcePointers = (await readFile(pointers.file, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const matched = sourcePointers.find((row) => row.frameIndex === 10);
    assert.deepEqual(matched, sourceRow);
    const receipt = call("media.renderCompositionVideo", {
      output: prefix + ".mp4",
      frames,
      range,
      canvas,
      settings: resolveOutputSettings(),
      processing: window.processing(),
      assets: requests.get("identity").assets,
      pointers,
    });
    if (range.startUs === 0) {
      const changing = join(out, "pointer-mutation");
      await mkdir(changing);
      const file = join(changing, "pointers.jsonl");
      await writeFile(file, await readFile(pointers.file));
      const requestFile = join(changing, "request.json");
      await writeFile(
        requestFile,
        JSON.stringify({
          output: join(changing, "unpublished.mp4"),
          frames,
          range,
          canvas,
          settings: resolveOutputSettings(),
          processing: window.processing(),
          assets: requests.get("identity").assets,
          pointers: { ...pointers, file },
          audio: { range: { start: 0, end: 96000 }, clips: [] },
        }),
      );
      const result = run(
        process.env.YAP_COMPOSITION_VIDEO_TESTS ??
          join(dirname(process.env.YAP_NATIVE), "YapCompositionVideoTests"),
        [requestFile, "media.renderCompositionMovie", "mutate-pointers"],
      );
      await writeFile(join(changing, "observer.log"), result);
      assert.ok(result.startsWith("PASS"));
      negatives.push({ name: "prepared-pointers-changed-after-preflight", unpublished: true });
    }
    assert.equal(receipt.durationUs, range.endUs - range.startUs);
    assert.equal(receipt.frames, compiled.length);
    const references = prefix + "-references";
    await mkdir(references);
    const request = prefix + "-reference.json";
    const selected = compiled.filter((f) => f.index === 10 || f.index === 11 || f.index === 12);
    await writeFile(
      request,
      JSON.stringify({
        movie: receipt.file,
        output: references,
        timesUs: selected.map((f) => f.visibleRange.startUs - range.startUs),
      }),
    );
    const decoded = JSON.parse(run(referenceTool, [request]));
    const samples = [];
    for (let i = 0; i < decoded.length; i++) {
      assert.equal(decoded[i].status, "available", decoded[i].error);
      const raw = decoded[i].file + ".rgba";
      run(pixelTool, [decoded[i].file, raw]);
      const pixels = await readFile(raw);
      let count = 0,
        sumX = 0,
        sumY = 0;
      for (let y = 0; y < 160; y++)
        for (let x = 0; x < 256; x++)
          if (magenta(pixels, (y * 256 + x) * 4)) {
            count++;
            sumX += x;
            sumY += y;
          }
      assert.ok(count > 20, "Encoded movie lost pointer trail");
      let whiteCount = 0,
        whiteX = 0,
        whiteY = 0;
      const whiteBounds = [256, 160, -1, -1];
      for (let y = 0; y < 160; y++)
        for (let x = 0; x < 256; x++) {
          const p = (y * 256 + x) * 4;
          if (pixels[p] > 220 && pixels[p + 1] > 220 && pixels[p + 2] > 220) {
            whiteCount++;
            whiteX += x;
            whiteY += y;
            whiteBounds[0] = Math.min(whiteBounds[0], x);
            whiteBounds[1] = Math.min(whiteBounds[1], y);
            whiteBounds[2] = Math.max(whiteBounds[2], x);
            whiteBounds[3] = Math.max(whiteBounds[3], y);
          }
        }
      assert.ok(whiteCount > 5, "Movie lost white pointer core");
      const singlePointers = await prepareCompositionPointers(
        {
          model,
          frames: () => [selected[i]],
          output: prefix + `-single-${i}.pointers.jsonl`,
          preparation,
          evidence,
        },
        new AbortController().signal,
      );
      const single = call("media.renderCompositionFrame", {
        ...requests.get("identity"),
        frame: selected[i],
        pointers: singlePointers,
        output: prefix + `-single-${i}.png`,
      });
      if (selected[i].index === 10)
        assert.deepEqual(
          await readFile(single.file),
          await readFile(requests.get("identity").output),
        );
      samples.push({
        frameIndex: selected[i].index,
        file: decoded[i].file,
        rgba: raw,
        trailPixels: count,
        centroid: { x: sumX / count, y: sumY / count },
        whiteCore: {
          count: whiteCount,
          bounds: whiteBounds,
          centroid: { x: whiteX / whiteCount, y: whiteY / whiteCount },
        },
        single: single.file,
      });
    }
    movies.push({ range, receipt, samples });
  }
  const movieDiagnostics = [];
  for (const sample of movies[1].samples) {
    const full = movies[0].samples.find((x) => x.frameIndex === sample.frameIndex);
    assert.deepEqual(
      await readFile(sample.single),
      await readFile(full.single),
      "Unencoded full/range frame phase differs",
    );
    assert.deepEqual(
      sample.whiteCore.bounds,
      full.whiteCore.bounds,
      "Encoded pointer bounds differ",
    );
    assert.ok(
      Math.abs(sample.whiteCore.centroid.x - full.whiteCore.centroid.x) < 1 &&
        Math.abs(sample.whiteCore.centroid.y - full.whiteCore.centroid.y) < 1,
      "Encoded pointer core phase differs",
    );
    movieDiagnostics.push({
      frameIndex: sample.frameIndex,
      trailCentroidDelta: {
        x: sample.centroid.x - full.centroid.x,
        y: sample.centroid.y - full.centroid.y,
      },
      trailPixelCounts: [full.trailPixels, sample.trailPixels],
    });
  }
  const exactTrailPhase = movieDiagnostics.every(
    (d) => Math.abs(d.trailCentroidDelta.x) < 1 && Math.abs(d.trailCentroidDelta.y) < 1,
  );
  const holdDocument = {
    ...base,
    clips: [{ ...base.clips[0], source: { kind: "hold", atUs: 900000 } }],
    processing: [{ target: { kind: "clip", id: "clip" }, steps: [pointer] }],
  };
  const holdModel = validateComposition(
    holdDocument,
    [compositionAsset(assets.get(selection.assetId))],
    [acquisitions.context(selection.acquisitionId)],
  );
  const holdCompiler = createCompiler(holdModel, "held-pointer");
  const holdWindow = holdCompiler.videoWindow({
    range: { startUs: 0, endUs: 2000000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const holdFrames = join(out, "hold.frames.jsonl");
  await writeFile(
    holdFrames,
    [...holdWindow.frames()].map((frame) => JSON.stringify(frame) + "\n").join(""),
  );
  const holdPointers = await prepareCompositionPointers(
    {
      model: holdModel,
      frames: () => holdWindow.frames(),
      output: join(out, "hold.pointers.jsonl"),
      preparation,
      evidence,
    },
    new AbortController().signal,
  );
  const holdRows = (await readFile(holdPointers.file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(
    holdRows.every(
      (row) =>
        row.captureUs === 900000 &&
        JSON.stringify(row.overlay) === JSON.stringify(holdRows[0].overlay),
    ),
  );
  const hold = call("media.renderCompositionVideo", {
    output: join(out, "hold.mp4"),
    frames: holdFrames,
    range: { startUs: 0, endUs: 2000000 },
    canvas,
    settings: resolveOutputSettings(),
    processing: holdWindow.processing(),
    assets: requests.get("identity").assets,
    pointers: holdPointers,
  });
  assert.equal(
    hold.rasterizedFrames,
    1,
    "Held source-time pointer/trail must reuse identical pixels",
  );
  assert.equal(
    hold.pointerRasterizations,
    1,
    "Held source must avoid repeated glyph rasterization",
  );
  const heldMismatchDirectory = join(out, "held-row-mismatch");
  await mkdir(heldMismatchDirectory);
  const heldMismatchRows = structuredClone(holdRows);
  heldMismatchRows[1].requestedSourceUs++;
  const heldMismatchBody = heldMismatchRows.map((row) => JSON.stringify(row) + "\n").join("");
  const heldMismatchFile = join(heldMismatchDirectory, "pointers.jsonl");
  await writeFile(heldMismatchFile, heldMismatchBody);
  const heldMismatch = rawCall("media.renderCompositionVideo", {
    output: join(heldMismatchDirectory, "result.mp4"),
    frames: holdFrames,
    range: { startUs: 0, endUs: 2000000 },
    canvas,
    settings: resolveOutputSettings(),
    processing: holdWindow.processing(),
    assets: requests.get("identity").assets,
    pointers: {
      file: heldMismatchFile,
      bytes: Buffer.byteLength(heldMismatchBody),
      records: heldMismatchRows.length,
      sha256: createHash("sha256").update(heldMismatchBody).digest("hex"),
    },
  });
  assert.equal(heldMismatch.ok, false, "Held output reuse must still validate every evidence row");
  assert.equal(heldMismatch.error.code, "INVALID_REQUEST");
  assert.deepEqual(await readdir(heldMismatchDirectory), ["pointers.jsonl"]);
  negatives.push({ name: "held-row-mismatch", error: heldMismatch.error });
  await writeFile(
    join(donor, "capture.journal.jsonl"),
    JSON.stringify({ fixture: "capture with no pointer observations" }),
  );
  const emptyPrepared = await importer.prepareImport("empty-observations", donor);
  const emptyIntent = catalog.transaction(() => acquisitions.admitImport(emptyPrepared));
  const emptyAcquisition = await importer.executeImport(
    emptyIntent.acquisitionId,
    "empty",
    {
      probe: async (path) => call("media.probe", { path }),
      exportSource: async (_directory, file) => {
        await writeFile(file, "");
        return {
          file,
          journal: "capture.journal.jsonl",
          header: { sessionID: "no-pointer-observations" },
          cursorSamples: 0,
          geometryRecords: 0,
          displaySpaces: 0,
          pauseEvents: 0,
          audioIntervals: 0,
          lastSequence: 0,
          incompleteTail: false,
          finished: true,
          bytes: 0,
        };
      },
    },
    new AbortController().signal,
  );
  const emptySelection = { ...selection, acquisitionId: emptyAcquisition.id };
  assert.throws(
    () => preparation.request(emptySelection),
    (error) => error.code === "UNAVAILABLE",
  );
  const inactiveDocument = {
    ...base,
    tracks: [...base.tracks, { id: "timer-track", kind: "video", order: 1 }],
    clips: [
      {
        ...base.clips[0],
        ...emptySelection,
        source: { kind: "range", range: { startUs: 0, endUs: 500000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
      },
      { ...base.clips[0], id: "timer", trackId: "timer-track" },
    ],
    processing: [{ target: { kind: "clip", id: "clip" }, steps: [pointer] }],
  };
  const inactiveModel = validateComposition(
    inactiveDocument,
    [compositionAsset(assets.get(selection.assetId))],
    [acquisitions.context(selection.acquisitionId), acquisitions.context(emptyAcquisition.id)],
  );
  const inactiveWindow = createCompiler(inactiveModel, "inactive-pointer").videoWindow({
    range: { startUs: 1000000, endUs: 1000001 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "clip", id: "clip" }, point: { kind: "processed" } },
  });
  const inactivePointers = await prepareCompositionPointers(
    {
      model: inactiveModel,
      frames: () => inactiveWindow.frames(),
      output: join(out, "inactive.pointers.jsonl"),
      preparation,
      evidence,
    },
    new AbortController().signal,
  );
  const inactiveRow = JSON.parse((await readFile(inactivePointers.file, "utf8")).trim());
  assert.equal(inactiveRow.status, "inactive");
  const inactive = call("media.renderCompositionFrame", {
    ...requests.get("identity"),
    output: join(out, "inactive.png"),
    frame: inactiveWindow.frames().next().value,
    processing: inactiveWindow.processing(),
    pointers: inactivePointers,
  });
  assert.deepEqual(inactive.pictures, []);
  const inactiveRaw = join(out, "inactive.rgba");
  run(pixelTool, [inactive.file, inactiveRaw]);
  assert.ok((await readFile(inactiveRaw)).every((value) => value === 0));
  cache.remove(preparation.request(selection).published.value.cacheId);
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      {
        status: "prepared-execution-geometry-only; full visual acceptance open",
        colorDiagnostics: {
          legacyExact: { limit: 0, passed: legacyMaximum === 0 },
          encodedMagenta: { centroidLimit: 1, passed: exactTrailPhase },
        },
        historyCalls: calls,
        cacheRegenerationRetainedInputs: true,
        trailPixels,
        whitePixels,
        legacyMaximum,
        legacyChanged,
        movies,
        hold,
        inactive,
        movieDiagnostics,
        exactTrailPhase,
        negatives,
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({ out, rendered: results.length, trailPixels, whitePixels }) + "\n",
  );
  // Slice15 retains its existing two-code-value PNG gate. The stricter measurements
  // above remain explicitly red diagnostics for the open slice06 color contract.
  assert.ok(legacyMaximum <= 2, "Lossless composition PNG exceeded the established color bound");
} finally {
  await jobs.close();
  catalog.close();
}
