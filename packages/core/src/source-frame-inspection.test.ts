import { add, fromTime, omit } from "@yap/composition";
import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import {
  MediaFrameInspection,
  retainedSourceFrameSchema,
  type SourceFrameRenderer,
  type SourceImageRenderer,
} from "./frame-inspection.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const renderer: SourceFrameRenderer = {
  implementationId: "fixture-source-picture",
  async render({ asset, atUs, output }, signal) {
    signal.throwIfAborted();
    const bytes = Buffer.from(`selected ${asset.streamId}`);
    await writeFile(output, bytes, { flag: "wx" });
    const actualSourceUs = Math.floor(atUs / 100000) * 100000;
    const sampleStart = add(fromTime(actualSourceUs), fromTime(asset.originUs));
    const timescale = Number(sampleStart.denominator) * 1000000;
    return {
      file: output,
      mediaType: "image/png",
      assetId: asset.assetId,
      streamId: asset.streamId,
      requestedSourceUs: atUs,
      actualSourceUs,
      sample: {
        value: String(sampleStart.numerator),
        timescale,
        endValue: String(sampleStart.numerator + 100000n * sampleStart.denominator),
        endTimescale: timescale,
        originUs: asset.originUs,
      },
      width: 64,
      height: 48,
      sourceWidth: 64,
      sourceHeight: 48,
      decodedSamples: 1,
      readerOpens: 1,
      bytes: bytes.length,
    };
  },
};
async function fixture(
  render = renderer,
  imageRenderer?: SourceImageRenderer,
  deferExecution = false,
) {
  const home = await mkdtemp("/tmp/source-frame-core-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const source = join(home, "source.mov");
  await writeFile(source, "immutable multi-stream source");
  const asset = await assets.import(source, { kind: "import" }, async () => ({
    originUs: 1250000,
    streams: ["track:1", "track:2"].map((id) => ({
      id,
      kind: "video",
      codec: "fixture",
      decodable: true,
      width: 64,
      height: 48,
      orientedWidth: 64,
      orientedHeight: 48,
      startUs: 0,
      endUs: 1000000,
      segments: [
        { startUs: 0, endUs: 400000, empty: false },
        { startUs: 400000, endUs: 600000, empty: true },
        { startUs: 600000, endUs: 1000000, empty: false },
      ],
    })),
  }));
  catalog.catalog.prepare("INSERT INTO acquisitions VALUES(?,?,?,?)").run(
    "mask",
    "capture",
    JSON.stringify({ kind: "import", path: home, files: {} }),
    JSON.stringify({
      id: "mask",
      bindings: [
        {
          assetId: asset.id,
          streamId: "track:2",
          available: [{ startUs: 100000, endUs: 300000 }],
        },
      ],
    }),
  );
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "asset") throw new Error("Expected source owner");
    assets.get(owner.id);
  });
  await cache.reconcile();
  let frames!: MediaFrameInspection;
  const jobs = new JobQueue({
    store: catalog,
    deferExecution,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind !== "asset") throw new Error("Expected asset");
        assets.get(target.id);
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (execution) => frames.execute(execution),
  });
  const calls: Parameters<SourceFrameRenderer["render"]>[0][] = [];
  frames = new MediaFrameInspection({
    assets,
    acquisitions,
    jobs,
    cache,
    ...(imageRenderer ? { imageRenderer } : {}),
    sourceRenderer: {
      ...render,
      async render(request, signal) {
        calls.push(request);
        return render.render(request, signal);
      },
    },
  });
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    assets,
    acquisitions,
    jobs,
    cache,
    frames,
    calls,
    asset,
    source,
    catalog,
    request: { assetId: asset.id, streamId: "track:2", acquisitionId: "mask", atUs: 150000 },
  };
}
test("selected source frames retain context and sample provenance through eviction", async () => {
  const f = await fixture();
  const pending = f.frames.request(f.request);
  expect(f.assets.references(f.asset.id)).toContainEqual({ kind: "job", id: pending.jobId });
  expect(f.acquisitions.references("mask")).toEqual([{ kind: "job", id: pending.jobId }]);
  await f.jobs.idle();
  const ready = f.frames.request(f.request),
    image = ready.published!.frame;
  expect(image).toMatchObject({
    assetId: f.asset.id,
    streamId: "track:2",
    acquisitionId: "mask",
    atUs: 150000,
    actualSourceUs: 100000,
    sample: { value: "1350000", timescale: 1000000, endValue: "1450000", originUs: 1250000 },
  });
  expect(f.calls[0]).toMatchObject({
    asset: { path: f.assets.path(f.asset.id), streamId: "track:2", originUs: 1250000 },
    available: [{ startUs: 100000, endUs: 300000 }],
  });
  expect(await readFile(image.file, "utf8")).toBe("selected track:2");
  f.cache.remove(image.cacheId);
  expect(f.frames.request(f.request).published).toBeNull();
  await f.jobs.idle();
  const regenerated = f.frames.request(f.request);
  expect(regenerated.published!.generation).not.toBe(ready.published!.generation);
  expect(await readFile(regenerated.published!.frame.file, "utf8")).toBe("selected track:2");
  expect(await readFile(f.source, "utf8")).toBe("immutable multi-stream source");
  expect(
    f.catalog.catalog
      .prepare("SELECT name FROM sqlite_master WHERE name='recordings' OR name='projects'")
      .all(),
  ).toEqual([]);
});

test("retained source frames preserve a requested face-observation recipe", async () => {
  const f = await fixture();
  const request = { recipe: "vision-face-rectangles-v1" as const };
  f.frames.request(f.request);
  await f.jobs.idle();
  const frame = omit(f.frames.request(f.request).published!.frame, "cacheId");
  expect(
    retainedSourceFrameSchema.parse({ ...frame, faceObservationRequest: request }),
  ).toMatchObject({ faceObservationRequest: request });
});
test("physical holes and acquisition exclusions remain distinct and schedule no frames", async () => {
  const f = await fixture();
  expect(f.frames.request({ ...f.request, atUs: 450000 })).toMatchObject({
    state: "unavailable",
    reason: "physical_gap",
    jobId: null,
    published: null,
  });
  expect(f.frames.request({ ...f.request, atUs: 350000 })).toMatchObject({
    state: "unavailable",
    reason: "acquisition_excluded",
    jobId: null,
    published: null,
  });
  expect(() => f.frames.request({ ...f.request, streamId: "track:1" })).toThrow("bind");
  expect(() => f.frames.request({ ...f.request, atUs: 1000000 })).toThrow("duration");
  expect(f.calls).toEqual([]);
  f.frames.request({ assetId: f.asset.id, streamId: "track:1", atUs: 350000 });
  await f.jobs.idle();
  expect(f.calls[0]!.asset.streamId).toBe("track:1");
});
test.each(["stream", "clock", "membership", "bytes", "path"])(
  "wrong source receipt %s cannot publish",
  async (fault) => {
    const f = await fixture({
      ...renderer,
      async render(request, signal) {
        const value = (await renderer.render(request, signal)) as Record<string, any>;
        if (fault === "stream") value.streamId = "track:1";
        if (fault === "clock") value.sample.originUs++;
        if (fault === "membership") value.sample.endValue = value.sample.value;
        if (fault === "bytes") value.bytes++;
        if (fault === "path") value.file = request.asset.path;
        return value;
      },
    });
    f.frames.request(f.request);
    await f.jobs.idle();
    expect(f.frames.request(f.request)).toMatchObject({ state: "failed", published: null });
    expect(f.cache.bytes).toBe(0);
    expect(await readFile(f.source, "utf8")).toBe("immutable multi-stream source");
  },
);
test("late source results cannot escape cancellation and explicit retry gets new work", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      if (first) {
        first = false;
        entered();
        await held;
        return renderer.render(request, new AbortController().signal);
      }
      return renderer.render(request, signal);
    },
  });
  cleanup.push(async () => release());
  const pending = f.frames.request(f.request);
  await started;
  f.jobs.cancel(pending.jobId!);
  release();
  await f.jobs.idle();
  expect(f.cache.bytes).toBe(0);
  expect(f.frames.request(f.request)).toMatchObject({
    state: "not_requested",
    reason: "canceled",
    published: null,
  });
  expect(f.calls).toHaveLength(1);
  f.frames.retry(f.request);
  await f.jobs.idle();
  expect(f.frames.request(f.request).state).toBe("ready");
  expect(f.calls).toHaveLength(2);
});

test("raw still images are refused without inventing a timed source", async () => {
  const f = await fixture();
  const path = join(f.home, "image.png");
  await writeFile(path, "immutable still");
  const image = await f.assets.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      { id: "image:0", kind: "image", codec: "png", decodable: true, width: 64, height: 48 },
    ],
  }));
  expect(() => f.frames.request({ assetId: image.id, streamId: "image:0", atUs: 0 })).toThrow(
    "timed stream",
  );
  expect(f.calls).toEqual([]);
});

test("only structured native no-picture outcomes become immutable unavailable observations", async () => {
  const f = await fixture({
    ...renderer,
    async render() {
      throw new CatalogError("SOURCE_PICTURE_UNAVAILABLE", "No physical sample");
    },
  });
  expect(f.frames.sourcePlan(f.request).options.atUs).toBe(150000);
  expect(f.calls).toHaveLength(0);
  expect(() => f.frames.sourceUnavailable(f.request)).toThrow("No physical no-picture observation");
  const pending = f.frames.request(f.request);
  await f.jobs.idle();
  expect(f.frames.request(f.request).state).toBe("unavailable");
  const observation = f.frames.sourceUnavailable(f.request);
  expect(observation).toMatchObject({
    selection: {
      assetId: f.asset.id,
      streamId: "track:2",
      acquisitionId: "mask",
    },
    atUs: 150000,
    implementationId: renderer.implementationId,
    observation: { requestedSourceUs: 150000, status: "unavailable", reason: "empty_edit" },
  });
  f.jobs.forgetJob(pending.jobId!);
  expect(JSON.parse(JSON.stringify(observation))).toEqual(observation);
  expect(() => f.frames.sourceUnavailable(f.request)).toThrow("No physical no-picture observation");
  expect(f.calls).toHaveLength(1);
});

test.each(["UNAVAILABLE", "NATIVE_DECODE_FAILED", "UNSUPPORTED_MEDIA", "INVALID_RESPONSE"])(
  "%s cannot be retained as a physical no-picture observation",
  async (code) => {
    const f = await fixture({
      ...renderer,
      async render() {
        throw new CatalogError(code, "No physical sample");
      },
    });
    f.frames.request(f.request);
    await f.jobs.idle();
    expect(() => f.frames.sourceUnavailable(f.request)).toThrow(
      "No physical no-picture observation",
    );
    expect(f.calls).toHaveLength(1);
  },
);

// Receipt doubles exercise ownership; actual PNG pixels are covered by the public native journey.
const imageRenderer = {
  implementationId: "fixture-image",
  async render({ asset, output }, signal) {
    signal.throwIfAborted();
    await writeFile(output, "picture", { flag: "wx" });
    return {
      kind: "image",
      file: output,
      mediaType: "image/png",
      ...asset,
      width: 40,
      height: 64,
      sourceWidth: 40,
      sourceHeight: 64,
      orientation: 6,
      hasAlpha: true,
      decodedImages: 1,
      readerOpens: 1,
      bytes: 7,
    };
  },
} satisfies SourceImageRenderer;
async function imageFixture(render: SourceImageRenderer = imageRenderer) {
  const f = await fixture(renderer, render);
  const path = join(f.home, "image.png");
  await writeFile(path, "immutable image");
  const asset = await f.assets.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "image:0",
        kind: "image",
        codec: "public.png",
        decodable: true,
        width: 64,
        height: 40,
        orientedWidth: 40,
        orientedHeight: 64,
        orientation: 6,
        hasAlpha: true,
      },
    ],
  }));
  return { ...f, image: asset, imageRequest: { assetId: asset.id, streamId: "image:0" } };
}
test("timeless images share retained frame jobs, cache reuse and eviction without a video clock", async () => {
  const f = await imageFixture();
  const pending = f.frames.request(f.imageRequest);
  expect(f.assets.references(f.image.id)).toContainEqual({ kind: "job", id: pending.jobId });
  await f.jobs.idle();
  const ready = f.frames.request(f.imageRequest);
  expect(ready.state).toBe("ready");
  expect(ready.published!.frame).toMatchObject({
    kind: "image",
    assetId: f.image.id,
    streamId: "image:0",
    orientation: 6,
    width: 40,
    height: 64,
  });
  for (const value of [ready, ready.published!.frame])
    for (const key of [
      "atUs",
      "sample",
      "originUs",
      "supportDigest",
      "requestedSourceUs",
      "actualSourceUs",
    ])
      expect(value).not.toHaveProperty(key);
  expect(f.frames.request(f.imageRequest).published!.generation).toBe(ready.published!.generation);
  f.cache.remove(ready.published!.frame.cacheId);
  expect(f.frames.request(f.imageRequest).published).toBeNull();
  await f.jobs.idle();
  expect(f.frames.request(f.imageRequest).published!.generation).not.toBe(
    ready.published!.generation,
  );
});

test("images reject timed/acquisition selectors and mismatched native image identity before publication", async () => {
  const f = await imageFixture({
    ...imageRenderer,
    async render(request, signal) {
      return { ...(await imageRenderer.render(request, signal)), orientation: 1 };
    },
  });
  expect(() => f.frames.request({ ...f.imageRequest, atUs: 0 })).toThrow(/timed stream/);
  expect(() => f.frames.request({ ...f.imageRequest, acquisitionId: "mask" })).toThrow(
    /accept assetId/,
  );
  expect(() => f.frames.request({ assetId: f.asset.id, streamId: "track:1" })).toThrow(
    /video requires atUs/,
  );
  expect(() => f.frames.request({ ...f.imageRequest, streamId: "missing" })).toThrow(
    /image stream/,
  );
  expect(f.assets.references(f.image.id)).toEqual([]);
  f.frames.request(f.imageRequest);
  await f.jobs.idle();
  const failed = f.frames.request(f.imageRequest);
  expect(failed.state).toBe("failed");
  expect(failed.published).toBeNull();
  expect(f.jobs.job(failed.jobId!).errorCode).toBe("INVALID_RESPONSE");
  expect(await readdir(join(f.home, "cache/derived"))).toEqual([]);
});

test("image reads do not retry failed work; explicit retry reuses the pinned frame job", async () => {
  let failure = true;
  const f = await imageFixture({
    ...imageRenderer,
    async render(request, signal) {
      if (failure) throw new CatalogError("DECODE_FAILED", "fixture transient decode failure", {});
      return imageRenderer.render(request, signal);
    },
  });
  const initial = f.frames.request(f.imageRequest);
  await f.jobs.idle();
  expect(f.frames.request(f.imageRequest)).toMatchObject({
    state: "failed",
    retryable: true,
    jobId: initial.jobId,
    published: null,
  });
  failure = false;
  expect(f.frames.request(f.imageRequest).state).toBe("failed");
  f.frames.retry(f.imageRequest);
  await f.jobs.idle();
  const ready = f.frames.request(f.imageRequest);
  expect(ready).toMatchObject({ state: "ready", jobId: initial.jobId });
  expect(await readFile(ready.published!.frame.file, "utf8")).toBe("picture");
});

test("support changes outside the demanded interval still refuse queued frames", async () => {
  const f = await fixture(undefined, undefined, true);
  const request = { assetId: f.asset.id, streamId: "track:1", atUs: 150000 };
  const pending = f.frames.request(request);
  const segment = f.catalog.catalog
    .prepare("SELECT value FROM asset_segments WHERE assetId=? AND streamId=? AND ordinal=2")
    .get(f.asset.id, "track:1")!.value as string;
  const changed = { ...JSON.parse(segment), endUs: 900000 };
  f.catalog.catalog
    .prepare("UPDATE asset_segments SET value=? WHERE assetId=? AND streamId=? AND ordinal=2")
    .run(JSON.stringify(changed), f.asset.id, "track:1");
  f.jobs.start();
  await f.jobs.idle();
  expect(f.jobs.job(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "ARTIFACT_CHANGED",
    reason: "Selected source support changed",
  });
  expect(f.calls).toEqual([]);
  expect(f.cache.bytes).toBe(0);
  f.catalog.catalog
    .prepare("UPDATE asset_segments SET value=? WHERE assetId=? AND streamId=? AND ordinal=2")
    .run(segment, f.asset.id, "track:1");
  expect(() => f.jobs.retry(pending.jobId!)).toThrow("This job cannot be retried");
  expect(f.frames.request(request)).toMatchObject({ state: "failed" });
  f.frames.request({ ...request, atUs: 200000 });
  await f.jobs.idle();
  const ready = f.frames.request({ ...request, atUs: 200000 });
  expect(ready).toMatchObject({ state: "ready", supportDigest: pending.supportDigest });
  expect(ready.published!.frame.supportDigest).toBe(pending.supportDigest);
  expect(f.calls[0]!.available).toEqual([{ startUs: 0, endUs: 400000 }]);
  expect(await readFile(ready.published!.frame.file, "utf8")).toBe("selected track:1");
});
