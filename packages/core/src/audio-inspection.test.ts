import { fromTime, sampleAt, compare, type TimeValue } from "@yap/composition";
import {
  AcousticInspection,
  type AcousticRenderer,
  type LoudnessAnalyzer,
} from "./acoustic-inspection.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { MediaAudioInspection, type SourceAudioRenderer } from "./audio-inspection.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const renderer: SourceAudioRenderer = {
  implementationId: "fixture-wav",
  async render({ source, range, output }, signal) {
    signal.throwIfAborted();
    const sampleRate = 48000,
      channels = 2;
    const start = sampleAt(fromTime(range.startUs), sampleRate),
      end = sampleAt(fromTime(range.endUs), sampleRate);
    const bytes = Buffer.alloc(44 + (end - start) * channels * 4);
    bytes.write("RIFF");
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(3, 20);
    bytes.writeUInt16LE(channels, 22);
    bytes.writeUInt32LE(sampleRate, 24);
    bytes.writeUInt32LE(sampleRate * channels * 4, 28);
    bytes.writeUInt16LE(channels * 4, 32);
    bytes.writeUInt16LE(32, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const unavailable = [];
    let at = range.startUs;
    for (const part of source.available) {
      if (compare(fromTime(part.endUs), fromTime(at)) <= 0) continue;
      if (compare(fromTime(part.startUs), fromTime(range.endUs)) >= 0) break;
      if (compare(fromTime(part.startUs), fromTime(at)) > 0)
        unavailable.push({ startUs: at, endUs: part.startUs });
      at = compare(fromTime(range.endUs), fromTime(part.endUs)) < 0 ? range.endUs : part.endUs;
    }
    if (compare(fromTime(at), fromTime(range.endUs)) < 0)
      unavailable.push({ startUs: at, endUs: range.endUs });
    await writeFile(output, bytes, { flag: "wx" });
    return {
      file: output,
      mediaType: "audio/wav",
      bytes: bytes.length,
      sampleRate,
      channels,
      layout: "stereo",
      range,
      sampleRange: { start, end },
      frames: end - start,
      decodedFrames: end - start,
      unavailable,
    };
  },
};
async function fixture(
  render = renderer,
  budget?: number,
  durationUs: TimeValue = 1000000,
  sampleRate = 48000,
  raster?: AcousticRenderer,
  loudness?: LoudnessAnalyzer,
) {
  const home = await mkdtemp("/tmp/source-audio-inspection-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const original = join(home, "external.mov");
  await writeFile(original, "immutable source bytes");
  const asset = await assets.import(original, { kind: "import" }, async () => ({
    originUs: 250000,
    streams: ["a", "b"].map((id) => ({
      id,
      kind: "audio" as const,
      codec: "pcm",
      decodable: true,
      startUs: 100000,
      endUs: durationUs,
      segments: [{ startUs: 100000, endUs: durationUs, empty: false }],
      sampleRate,
      channels: 2,
    })),
  }));
  // Seed completed import-boundary metadata; actual journal adoption has its own acquisition tests.
  catalog.catalog.prepare("INSERT INTO acquisitions VALUES(?,?,?,?)").run(
    "mask",
    "import-mask",
    JSON.stringify({ kind: "import", path: home, files: {} }),
    JSON.stringify({
      id: "mask",
      bindings: [
        { assetId: asset.id, streamId: "a", available: [{ startUs: 200000, endUs: 800000 }] },
      ],
    }),
  );
  const cache = new DerivedCache(
    catalog,
    home,
    (owner) => {
      if (owner.kind !== "asset") throw new Error("Expected asset");
      assets.get(owner.id);
    },
    budget,
  );
  await cache.reconcile();
  let inspection!: MediaAudioInspection;
  let waveform!: AcousticInspection;
  let pinHook = () => {};
  const makeJobs = () =>
    new JobQueue({
      store: catalog,
      providers: { newId: randomUUID },
      targets: {
        pin(target) {
          if (target.kind !== "asset") throw new Error("Expected asset");
          assets.get(target.id);
          pinHook();
          return target;
        },
        isAvailable: () => true,
        isDeleting: () => false,
        isCapturing: () => false,
      },
      execute: (execution) =>
        ["waveform", "spectrum", "acoustic-image", "loudness", "pause"].includes(
          execution.job.artifact,
        )
          ? waveform.execute(execution)
          : inspection.execute(execution),
    });
  let jobs = makeJobs();
  const makeInspection = () =>
    new MediaAudioInspection({
      assets,
      acquisitions,
      jobs,
      cache,
      sourceRenderer: render,
    });
  inspection = makeInspection();
  waveform = new AcousticInspection({
    audio: inspection,
    jobs,
    cache,
    ...(raster ? { renderer: raster } : {}),
    ...(loudness ? { loudness } : {}),
  });
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    catalog,
    assets,
    acquisitions,
    cache,
    jobs,
    inspection,
    waveform,
    asset,
    original,
    selection: { assetId: asset.id, streamId: "a" },
    async restart() {
      await jobs.close();
      jobs = makeJobs();
      inspection = makeInspection();
      waveform = new AcousticInspection({
        audio: inspection,
        jobs,
        cache,
        ...(raster ? { renderer: raster } : {}),
        ...(loudness ? { loudness } : {}),
      });
      return { jobs, inspection, waveform };
    },
    onPin(hook: () => void) {
      pinHook = hook;
    },
  };
}

test("source WAV jobs pin selection/support, retain actual job references and regenerate evicted delivery", async () => {
  const requests: Parameters<SourceAudioRenderer["render"]>[0][] = [];
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      requests.push(request);
      return renderer.render(request, signal);
    },
  });
  const selection = { ...f.selection, acquisitionId: "mask" };
  const first = await f.inspection.request(selection);
  expect(first.range).toEqual({ startUs: 100000, endUs: 1000000 });
  expect((await f.inspection.request(selection)).jobId).toBe(first.jobId);
  expect(f.assets.references(f.asset.id)).toEqual([{ kind: "job", id: first.jobId }]);
  expect(f.acquisitions.references("mask")).toEqual([{ kind: "job", id: first.jobId }]);
  await f.jobs.idle();
  const ready = await f.inspection.request(selection),
    audio = ready.published!.audio;
  expect(ready.state, JSON.stringify(ready)).toBe("ready");
  expect(audio.unavailable).toEqual([
    { startUs: 100000, endUs: 200000 },
    { startUs: 800000, endUs: 1000000 },
  ]);
  expect(requests[0]!.source).toEqual({
    source: f.assets.path(f.asset.id),
    streamId: "a",
    sourceOffsetUs: -250000,
    available: [{ startUs: 200000, endUs: 800000 }],
  });
  const original = await readFile(audio.file);
  const read = f.cache.acquire(audio.cacheId)!;
  const buffer = Buffer.alloc(read.bytes);
  expect(read.read(buffer, 0)).toBe(buffer.length);
  read.release();
  expect(buffer).toEqual(original);
  f.cache.remove(audio.cacheId);
  expect((await f.inspection.request(selection)).published).toBeNull();
  await f.jobs.idle();
  const again = await f.inspection.request(selection);
  expect(again.jobId).toBe(first.jobId);
  expect(again.published!.generation).toBeGreaterThan(ready.published!.generation);
  expect(await readFile(again.published!.audio.file)).toEqual(original);
  expect(await readFile(f.original, "utf8")).toBe("immutable source bytes");
  expect((await f.inspection.request(f.selection)).jobId).not.toBe(first.jobId);
  expect((await f.inspection.request({ ...f.selection, streamId: "b" })).jobId).not.toBe(
    first.jobId,
  );
});

test("cancellation fences late renderer output and only explicit retry admits another attempt", async () => {
  const entered = gate(),
    release = gate();
  let calls = 0;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      calls++;
      entered.resolve();
      await release.promise;
      return renderer.render(request, calls === 1 ? new AbortController().signal : signal);
    },
  });
  cleanup.push(async () => release.resolve());
  const input = { ...f.selection, range: { startUs: 71, endUs: 199991 } };
  const first = await f.inspection.request(input);
  await entered.promise;
  f.jobs.cancel(first.jobId!);
  release.resolve();
  await f.jobs.idle();
  expect(await f.inspection.request(input)).toMatchObject({
    state: "not_requested",
    published: null,
  });
  expect(calls).toBe(1);
  expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
  await f.inspection.retry(input);
  await f.jobs.idle();
  const ready = await f.inspection.request(input);
  expect(ready.state, JSON.stringify(ready)).toBe("ready");
  expect(calls).toBe(2);
  expect(ready.published!.audio.sampleRange).toEqual({ startSamples: 3, endSamples: 9599 });
  expect(ready.published!.audio.unavailable).toEqual([{ startUs: 71, endUs: 100000 }]);
});

test("malformed native receipts and WAV files cannot publish and repeated reads do not loop", async () => {
  const defects = [
    "path",
    "rate",
    "range",
    "frames",
    "layout",
    "bytes",
    "unavailable",
    "header",
    "format",
    "payload",
  ];
  for (const defect of defects) {
    let calls = 0;
    const f = await fixture({
      ...renderer,
      async render(request, signal) {
        calls++;
        const value = (await renderer.render(request, signal)) as Record<string, unknown>;
        if (defect === "header")
          await writeFile(request.output, Buffer.alloc(value.bytes as number));
        else if (defect === "format" || defect === "payload") {
          const bytes = await readFile(request.output);
          if (defect === "format") bytes.writeUInt16LE(1, 22);
          else bytes.writeUInt32LE(bytes.length - 48, 40);
          await writeFile(request.output, bytes);
        } else
          value[defect === "path" ? "file" : defect === "rate" ? "sampleRate" : defect] = {
            path: "/tmp/unrelated.wav",
            rate: 44100,
            range: { startUs: 0, endUs: 1000000 },
            frames: 1,
            layout: "mono",
            bytes: 4,
            unavailable: [],
          }[defect];
        return value;
      },
    });
    const input = { ...f.selection, range: { startUs: 0, endUs: 200000 } };
    await f.inspection.request(input);
    await f.jobs.idle();
    expect(await f.inspection.request(input), defect).toMatchObject({
      state: "failed",
      published: null,
    });
    expect(f.jobs.job((await f.inspection.request(input)).jobId!).errorCode).toBe(
      "INVALID_RESPONSE",
    );
    expect((await f.inspection.request(input)).state).toBe("failed");
    expect(calls).toBe(1);
    expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
  }
});

test("a partly overlapping audio range is clamped to the source with range-clamped", async () => {
  const f = await fixture();
  const clamped = await f.inspection.request({
    ...f.selection,
    range: { startUs: 500000, endUs: 1000001 },
  });
  expect(clamped).toMatchObject({
    range: { startUs: 500000, endUs: 1000000 },
    issues: [
      {
        code: "range-clamped",
        evidence: {
          requested: { startUs: 500000, endUs: 1000001 },
          applied: { startUs: 500000, endUs: 1000000 },
          bounds: { startUs: 0, endUs: 1000000 },
        },
      },
    ],
  });
  await f.jobs.idle();
  // A later read of the same request still reports the clamp beside the published audio.
  expect(
    await f.inspection.request({ ...f.selection, range: { startUs: 500000, endUs: 1000001 } }),
  ).toMatchObject({
    state: "ready",
    published: { audio: { sourceRange: { startUs: 500000, endUs: 1000000 } } },
    issues: [{ code: "range-clamped" }],
  });
  expect(
    (await f.inspection.request({ ...f.selection, range: { startUs: 500000, endUs: 1000000 } }))
      .issues,
  ).toEqual([]);
});

test("invalid ranges and acquisition/stream mismatches refuse before queue admission", async () => {
  const f = await fixture();
  await expect(
    f.inspection.request({ ...f.selection, range: { startUs: 1000000, endUs: 1000001 } }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "INVALID_RANGE",
      details: expect.objectContaining({ bounds: { startUs: 0, endUs: 1000000 } }),
    }),
  );
  await expect(
    f.inspection.request({ ...f.selection, streamId: "b", acquisitionId: "mask" }),
  ).rejects.toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  expect(f.assets.references(f.asset.id)).toEqual([]);
  expect(f.catalog.catalog.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
});

test("a failed dependency retain rolls back the job and earlier asset retain together", async () => {
  const f = await fixture();
  f.onPin(() => {
    f.catalog.catalog.prepare("UPDATE acquisitions SET metadata=NULL WHERE id=?").run("mask");
  });
  await expect(f.inspection.request({ ...f.selection, acquisitionId: "mask" })).rejects.toThrow(
    expect.objectContaining({ code: "PREREQUISITE_MISSING" }),
  );
  expect(f.assets.references(f.asset.id)).toEqual([]);
  expect(f.acquisitions.references("mask")).toEqual([]);
  expect(f.catalog.catalog.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  expect(f.acquisitions.get("mask").bindings[0]!.streamId).toBe("a");
});

test("source WAV capacity is checked before queue admission using absolute floor samples", async () => {
  let calls = 0;
  const f = await fixture(
    {
      ...renderer,
      async render(request, signal) {
        calls++;
        return renderer.render(request, signal);
      },
    },
    52,
  );
  // floor(1042 * .048) - floor(1020 * .048) = 50 - 48 = 2 frames, not floor(22 * .048).
  await expect(
    f.inspection.request({ ...f.selection, range: { startUs: 1020, endUs: 1042 } }),
  ).rejects.toThrow("exceeds cache budget");
  expect(calls).toBe(0);
  expect(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  const status = await f.inspection.request({
    ...f.selection,
    range: { startUs: 1020, endUs: 1041 },
  });
  await f.jobs.idle();
  expect(
    (await f.inspection.request({ ...f.selection, range: { startUs: 1020, endUs: 1041 } })).state,
  ).toBe("ready");
  expect(status.jobId).toBeTruthy();
  expect(calls).toBe(1);
});

test("long source capacity arithmetic rejects before rendering without losing high-clock precision", async () => {
  const f = await fixture(renderer, 44, Number.MAX_SAFE_INTEGER);
  await expect(f.inspection.request(f.selection)).rejects.toThrow("exceeds cache budget");
  // Number multiplication loses this frame; absolute integer sample clocks retain it.
  await expect(
    f.inspection.request({
      ...f.selection,
      range: { startUs: 9007199254740958, endUs: 9007199254740959 },
    }),
  ).rejects.toThrow("exceeds cache budget");
  const small = await f.inspection.request({
    ...f.selection,
    range: { startUs: 9007199254740959, endUs: 9007199254740960 },
  });
  expect(small.jobId).toBeTruthy();
});

test("acoustic images reuse cached measurements and explicit retry rebuilds evicted dependencies", async () => {
  let decodes = 0,
    images = 0;
  const f = await fixture(
    {
      ...renderer,
      async render(request, signal) {
        decodes++;
        return renderer.render(request, signal);
      },
    },
    undefined,
    1000000,
    48000,
    {
      implementationId: "fixture-raster",
      async render(request) {
        images++;
        const bytes = Buffer.from("external raster fixture");
        await writeFile(request.output, bytes, { flag: "wx" });
        return {
          file: request.output,
          mediaType: "image/png",
          bytes: bytes.length,
          width: 1240,
          height: 704,
          provenance: request.provenance,
          plotLeft: 92,
          plotWidth: 1080,
          plotTop: 164,
          panelHeight: 180,
          panelStride: 244,
        };
      },
    },
  );
  const input = {
    ...f.selection,
    range: { startUs: 200000, endUs: 210000 },
    format: "image" as const,
  };
  const prepare = async () => {
    for (let i = 0; i < 4; i++) {
      await f.waveform.request(input);
      await f.jobs.idle();
    }
    const result = await f.waveform.request(input);
    expect(result.state, JSON.stringify(result)).toBe("ready");
    return result;
  };
  const first = await prepare();
  expect(first.published!.artifact.mediaType).toBe("image/png");
  const measurements = await f.waveform.request({ ...input, format: "json" });
  const pcm = (await f.inspection.request({ ...f.selection, range: input.range })).published!.audio;
  f.cache.remove(pcm.cacheId);
  f.cache.remove(first.published!.artifact.cacheId);
  const second = await prepare();
  expect([decodes, images]).toEqual([1, 2]);
  f.cache.remove(measurements.published!.artifact.cacheId);
  expect((await f.waveform.request(input)).published).toEqual(second.published);
  f.cache.remove(second.published!.artifact.cacheId);
  await f.waveform.request(input);
  await f.jobs.idle();
  expect((await f.waveform.request(input)).state).toBe("failed");
  await f.waveform.retry(input);
  await f.jobs.idle();
  await prepare();
  expect([decodes, images]).toEqual([2, 3]);
});

test("cached spectral jobs preserve full versus ranged measurements and survive PCM eviction", async () => {
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const receipt = (await renderer.render(request, signal)) as {
        sampleRange: { start: number; end: number };
      };
      const bytes = await readFile(request.output);
      for (let i = receipt.sampleRange.start; i < receipt.sampleRange.end; i++) {
        bytes.writeFloatLE(Math.sin(i * 0.17) * 0.3, 44 + (i - receipt.sampleRange.start) * 8);
        bytes.writeFloatLE(i === 9841 ? 0.9 : -0.1, 48 + (i - receipt.sampleRange.start) * 8);
      }
      await writeFile(request.output, bytes);
      return receipt;
    },
  });
  const input = {
    ...f.selection,
    acquisitionId: "mask",
    kind: "spectrum" as const,
    fftFrames: 256,
    hopFrames: 128,
  };
  const prepare = async (range: { startUs: number; endUs: number }) => {
    await f.waveform.request({ ...input, range });
    await f.jobs.idle();
    await f.waveform.request({ ...input, range });
    await f.jobs.idle();
    const result = await f.waveform.request({ ...input, range });
    expect(result.state, JSON.stringify(result)).toBe("ready");
    return result;
  };
  const full = await prepare({ startUs: 200000, endUs: 220000 });
  const narrow = await prepare({ startUs: 203333, endUs: 208337 });
  const whole = JSON.parse(await readFile(full.published!.artifact.file, "utf8"));
  const detail = JSON.parse(await readFile(narrow.published!.artifact.file, "utf8"));
  expect(whole.unavailable).toEqual([]);
  expect(detail.sampleRange).toEqual({ start: 9759, end: 10000 });
  expect(detail.range).toEqual({ startUs: 203333, endUs: 208337 });
  for (const [i, column] of detail.columns.entries()) {
    const j = whole.columns.findIndex(
      (other: { gridStart: number }) => other.gridStart === column.gridStart,
    );
    expect(j).toBeGreaterThanOrEqual(0);
    expect(detail.density.slice(i * 258, (i + 1) * 258)).toEqual(
      whole.density.slice(j * 258, (j + 1) * 258),
    );
    expect(column.partial).toBe(false);
  }
  const audio = JSON.parse(f.jobs.status(f.jobs.job(narrow.dependency.jobId!)).published!.result);
  f.cache.remove(audio.cacheId);
  expect((await f.waveform.request({ ...input, range: detail.range })).published).toEqual(
    narrow.published,
  );
});

test("audio context keeps source selection and expands to exact sample boundaries within source extent", async () => {
  const f = await fixture();
  const input = {
    ...f.selection,
    acquisitionId: "mask",
    range: { startUs: 333333, endUs: 533337 },
  };
  const context = f.inspection.context(input, { start: 15967, end: 25632 });
  expect(context.selection).toEqual({
    ...input,
    range: { startUs: { numerator: 1995875, denominator: 6 }, endUs: 534000 },
  });
  expect(context.sampleClock).toMatchObject({ sampleRange: { start: 15967, end: 25632 } });
  const pending = await f.inspection.request(context.selection);
  await f.jobs.idle();
  expect((await f.inspection.request(context.selection)).published!.audio).toMatchObject({
    assetId: f.asset.id,
    streamId: "a",
    acquisitionId: "mask",
    sampleRange: { startSamples: 15967, endSamples: 25632 },
    unavailable: [],
  });
  expect(pending.jobId).toBeTruthy();
  const edge = f.inspection.context(
    { ...f.selection, range: { startUs: 0, endUs: 1000000 } },
    { start: -32, end: 48032 },
  );
  expect(edge.selection.range).toEqual({ startUs: 0, endUs: 1000000 });
  expect(() => f.inspection.context(input, { start: 16000, end: 25632 })).toThrow(/contain/);
});

test("waveform jobs reuse bounded audio recipes, publish source axes and survive eviction of PCM", async () => {
  let renders = 0;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      renders++;
      return renderer.render(request, signal);
    },
  });
  const input = {
    ...f.selection,
    acquisitionId: "mask",
    range: { startUs: 333333, endUs: 533337 },
  };
  const first = await f.waveform.request(input);
  expect(first.published).toBeNull();
  await f.jobs.idle();
  await f.waveform.request(input);
  await f.jobs.idle();
  const ready = await f.waveform.request(input),
    artifact = ready.published!.artifact;
  expect(ready.state, JSON.stringify(ready)).toBe("ready");
  expect(renders).toBe(1);
  const document = JSON.parse(await readFile(artifact.file, "utf8"));
  expect(document).toMatchObject({
    domain: "source",
    assetId: f.asset.id,
    acquisitionId: "mask",
    range: input.range,
    sampleRange: { start: 15999, end: 25600 },
    sampleRate: 48000,
    channels: 2,
    units: {
      range: "microsecond",
      sampleRange: "sample-frame",
      amplitude: "linear",
      rms: "linear",
    },
    audio: { jobId: first.jobId, generation: 1 },
    generation: 1,
  });
  expect(document.buckets.length).toBeGreaterThan(900);
  expect(document.buckets.length).toBeLessThanOrEqual(1025);
  expect(document.buckets[0]).toMatchObject({
    gridStart: 15990,
    sampleRange: { start: 15999, end: 16000 },
    partial: true,
    channels: [
      { min: 0, max: 0, rms: 0 },
      { min: 0, max: 0, rms: 0 },
    ],
  });
  const audio = (await f.inspection.request(input)).published!.audio;
  f.cache.remove(audio.cacheId);
  expect((await f.waveform.request(input)).published).toEqual(ready.published);
  await f.jobs.idle();
  expect(renders).toBe(1);
  f.cache.remove(artifact.cacheId);
  await f.waveform.request(input);
  await f.jobs.idle();
  const failed = await f.waveform.request(input);
  expect(failed.state).toBe("failed");
  expect(f.jobs.job(failed.jobId!).errorCode).toBe("ARTIFACT_EXPIRED");
  await f.waveform.retry(input);
  await f.jobs.idle();
  await f.waveform.request(input);
  await f.jobs.idle();
  const rebuilt = await f.waveform.request(input);
  expect(rebuilt.state).toBe("ready");
  expect(rebuilt.published!.artifact.audio.generation).toBe(2);
  expect(renders).toBe(2);
});

test("explicit waveform detail refuses before preparing PCM instead of silently coarsening", async () => {
  let renders = 0;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      renders++;
      return renderer.render(request, signal);
    },
  });
  await expect(f.waveform.request({ ...f.selection, bucketFrames: 1 })).rejects.toThrow(
    expect.objectContaining({ code: "LIMIT_EXCEEDED", details: { maximumBuckets: 4096 } }),
  );
  await f.jobs.idle();
  expect(renders).toBe(0);
});

test("audio generation changes cannot publish stale waveform work and cancellation requires retry", async () => {
  const f = await fixture();
  await f.inspection.request(f.selection);
  await f.jobs.idle();
  const original = await f.inspection.request(f.selection);
  const acquire = f.cache.acquire.bind(f.cache);
  let changed = false;
  f.cache.acquire = (id) => {
    const lease = acquire(id);
    if (id === original.published!.audio.cacheId && lease && !changed) {
      changed = true;
      f.jobs.regenerate(original.jobId!, original.published!.generation);
    }
    return lease;
  };
  const pending = await f.waveform.request(f.selection);
  await f.jobs.idle();
  expect(f.jobs.job(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "DEPENDENCY_LOST",
  });
  const next = await f.waveform.request(f.selection);
  f.jobs.cancel(next.jobId!);
  await f.jobs.idle();
  expect((await f.waveform.request(f.selection)).published).toBeNull();
  await f.waveform.retry(f.selection);
  await f.jobs.idle();
  const ready = await f.waveform.request(f.selection);
  expect(ready.state).toBe("ready");
  expect(ready.published!.artifact.audio.generation).toBe(2);
});

test("default full-source overview handles longer tracks and persisted waveform survives owner restart", async () => {
  const f = await fixture(renderer, undefined, 120000000);
  await f.waveform.request(f.selection);
  await f.jobs.idle();
  await f.waveform.request(f.selection);
  await f.jobs.idle();
  const ready = await f.waveform.request(f.selection);
  expect(ready.state).toBe("ready");
  expect(ready.published!.artifact.bucketCount).toBeLessThanOrEqual(1025);
  expect((ready.published!.artifact as any).sourceRange.endUs).toBe(120000000);
  const { waveform } = await f.restart();
  expect((await waveform.request(f.selection)).published).toEqual(ready.published);
  const artifact = ready.published!.artifact;
  const before = await readFile(artifact.file);
  const held = f.cache.acquire(artifact.cacheId)!;
  expect(() => f.cache.remove(artifact.cacheId)).toThrow(
    expect.objectContaining({ code: "CACHE_BUSY" }),
  );
  held.release();
  expect(await readFile(artifact.file)).toEqual(before);
});

test.each(["failed", "canceled"] as const)(
  "explicit waveform retry resumes its %s PCM dependency across owner restart",
  async (state) => {
    let calls = 0;
    const blocked = gate(),
      entered = gate();
    const f = await fixture({
      ...renderer,
      async render(request, signal) {
        calls++;
        entered.resolve();
        if (calls === 1) {
          if (state === "failed") throw new Error("deterministic first decode failure");
          await blocked.promise;
        }
        return renderer.render(request, signal);
      },
    });
    const pending = await f.waveform.request(f.selection);
    if (state === "canceled") {
      await entered.promise;
      f.jobs.cancel(pending.jobId!);
      blocked.resolve();
    }
    await f.jobs.idle();
    expect(f.jobs.job(pending.jobId!).state).toBe(state);
    const next = await f.restart();
    await next.waveform.request(f.selection);
    await next.jobs.idle();
    expect(calls).toBe(1);
    await next.waveform.retry(f.selection);
    await next.jobs.idle();
    await next.waveform.request(f.selection);
    await next.jobs.idle();
    const ready = await next.waveform.request(f.selection);
    expect(ready.state).toBe("ready");
    expect(ready.published!.artifact.audio).toEqual({ jobId: pending.jobId, generation: 2 });
    expect(calls).toBe(2);
  },
);

test("nonintegral admitted sample rates remain renderer admission, not an unstructured recipe exception", async () => {
  let renders = 0;
  const f = await fixture(
    {
      ...renderer,
      async render() {
        renders++;
        throw new CatalogError("UNSUPPORTED_MEDIA", "Fractional fixture sample rate");
      },
    },
    undefined,
    1000000,
    44099.5,
  );
  expect(f.inspection.recipe(f.selection).sampleClock).toBeUndefined();
  const pending = await f.inspection.request(f.selection);
  await f.jobs.idle();
  expect(f.jobs.job(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "UNSUPPORTED_MEDIA",
  });
  expect((await f.waveform.request({ ...f.selection, bucketFrames: 1 })).state).toBe("failed");
  expect(renders).toBe(1);
});

test("exact admitted endpoints drive full and late audio while explicit integer floor stays shorter", async () => {
  const endUs = { numerator: 15404875, denominator: 3 };
  const f = await fixture(renderer, undefined, endUs);
  const full = f.inspection.recipe(f.selection);
  expect(full.selection.range).toEqual({ startUs: 100000, endUs });
  expect(full.sampleClock?.sampleRange).toEqual({ start: 4800, end: 246478 });
  const requested = await f.inspection.request(f.selection);
  await f.jobs.idle();
  expect((await f.inspection.request(f.selection)).published?.audio).toMatchObject({
    sourceRange: { startUs: 100000, endUs },
    frameCount: 241678,
    unavailable: [],
  });
  expect(f.jobs.job(requested.jobId!).state).toBe("ready");
  const late = f.inspection.recipe({ ...f.selection, range: { startUs: 5134000, endUs } });
  expect(late.sampleClock?.sampleRange).toEqual({ start: 246432, end: 246478 });
  const floor = f.inspection.recipe({
    ...f.selection,
    range: { startUs: 5134000, endUs: 5134958 },
  });
  expect(floor.sampleClock?.sampleRange).toEqual({ start: 246432, end: 246477 });
  const over = f.inspection.recipe({ ...f.selection, range: { startUs: 5134000, endUs: 5134959 } });
  expect(over.selection.range).toEqual({ startUs: 5134000, endUs });
  expect(over.issues).toMatchObject([{ code: "range-clamped" }]);
  expect(
    f.inspection.context(
      { ...f.selection, range: { startUs: 5134000, endUs } },
      { start: 246430, end: 246480 },
    ).selection.range,
  ).toEqual({
    startUs: { numerator: 15401875, denominator: 3 },
    endUs,
  });
});

test("loudness retains selected PCM provenance and refuses integrated unavailable support", async () => {
  const f = await fixture(renderer, undefined, 6000000, 48000, undefined, {
    implementationId: "independent-fixture-meter",
    measure: async () => ({
      integratedLufs: -23,
      loudnessRangeLu: 2,
      samplePeakDbfs: -4,
      truePeakDbtp: -3.5,
      integratedReason: null,
      rangeReason: null,
      algorithm: "BS.1770/R128 fixture",
      version: "1",
    }),
  });
  const input = {
    ...f.selection,
    kind: "loudness" as const,
    range: { startUs: 100000, endUs: 6000000 },
  };
  await f.waveform.request(input);
  await f.jobs.idle();
  await f.waveform.request(input);
  await f.jobs.idle();
  const result = await f.waveform.request(input);
  expect(result.published?.artifact).toMatchObject({
    domain: "source",
    assetId: f.asset.id,
    streamId: "a",
    sourceRange: input.range,
    sampleRange: { startSamples: 4800, endSamples: 288000 },
    unavailable: [],
    analysis: {
      kind: "loudness",
      channelInterpretation: "native",
      truePeak: true,
      measurement: {
        integratedLufs: -23,
        loudnessRangeLu: 2,
        samplePeakDbfs: -4,
        truePeakDbtp: -3.5,
      },
    },
  });
  const gap = { ...input, acquisitionId: "mask" };
  await f.waveform.request(gap);
  await f.jobs.idle();
  await expect(f.waveform.request(gap)).rejects.toMatchObject({
    code: "UNAVAILABLE_SUPPORT",
    details: {
      unavailable: [
        { startUs: 100000, endUs: 200000 },
        { startUs: 800000, endUs: 6000000 },
      ],
      available: [{ startUs: 200000, endUs: 800000 }],
    },
  });
});

test("loudness missing-support refusal preserves rational source endpoints and disallows stereo dual-mono", async () => {
  const f = await fixture(renderer, undefined, 1000000, 48000, undefined, {
    implementationId: "fixture-meter",
    measure: async () => {
      throw new Error("Unavailable support must not reach a meter");
    },
  });
  const startUs = { numerator: 600001, denominator: 3 };
  const acquisition = {
    id: "rational-mask",
    bindings: [{ assetId: f.asset.id, streamId: "a", available: [{ startUs, endUs: 800000 }] }],
  };
  f.catalog.catalog
    .prepare("INSERT INTO acquisitions VALUES(?,?,?,?)")
    .run(
      "rational-mask",
      "rational-mask",
      JSON.stringify({ kind: "import", path: f.home, files: {} }),
      JSON.stringify(acquisition),
    );
  const input = { ...f.selection, acquisitionId: "rational-mask", kind: "loudness" as const };
  await f.waveform.request(input);
  await f.jobs.idle();
  await expect(f.waveform.request(input)).rejects.toMatchObject({
    code: "UNAVAILABLE_SUPPORT",
    details: { available: [{ startUs, endUs: 800000 }] },
  });
  await expect(
    f.waveform.request({ ...f.selection, kind: "loudness", channelInterpretation: "dual-mono" }),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
});

test("pause analysis exposes resolved detector settings and low-energy intervals", async () => {
  const f = await fixture();
  const pending = await f.waveform.request({
    ...f.selection,
    kind: "pause",
    minDurationUs: 100_000,
  });
  await f.jobs.idle();
  await f.waveform.request({ ...f.selection, kind: "pause", minDurationUs: 100_000 });
  await f.jobs.idle();
  const ready = await f.waveform.request({ ...f.selection, kind: "pause", minDurationUs: 100_000 });
  expect(ready.state, JSON.stringify(ready)).toBe("ready");
  expect(ready.published!.artifact.analysis).toMatchObject({
    kind: "pause",
    thresholdRMS: 0.01,
    windowUs: 20_000,
    hopUs: 10_000,
    minDurationUs: 100_000,
    algorithm: "rms-window-v1",
  });
  expect(ready.jobId).toEqual(expect.any(String));
});
