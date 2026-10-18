import { floor, fromTime, add } from "@yap/composition";
import { projectStoreFixture } from "./project-store.fixture.js";
import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { MediaFrameInspection, type ProjectFrameRenderer } from "./frame-inspection.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const renderer: ProjectFrameRenderer = {
  implementationId: "fixture-picture",
  async render({ window, assets, output }, signal) {
    signal.throwIfAborted();
    const bytes = Buffer.from("test frame payload");
    await writeFile(output, bytes, { flag: "wx" });
    const frame = [...window.frames()][0]!;
    return {
      file: output,
      mediaType: "image/png",
      profile: "h264-rec709",
      frame,
      width: window.manifest.canvas.width,
      height: window.manifest.canvas.height,
      sourceWidth: window.manifest.canvas.width,
      sourceHeight: window.manifest.canvas.height,
      decodedImages: 0,
      decodedSamples: 1,
      readerOpens: 1,
      bytes: bytes.length,
      pictures: frame.layers.map((layer) => {
        if (layer.kind !== "video") throw new Error("Fixture requires timed video");
        return {
          kind: "video",
          status: "available",
          clipId: layer.clipId,
          assetId: layer.assetId,
          streamId: layer.streamId,
          requestedSourceUs: layer.sourceUs,
          actualSourceUs: floor(fromTime(layer.sourceUs)),
          sample: {
            value: String(
              floor(
                add(
                  fromTime(floor(fromTime(layer.sourceUs))),
                  fromTime(
                    assets.find(
                      (asset) =>
                        asset.assetId === layer.assetId && asset.streamId === layer.streamId,
                    )!.originUs,
                  ),
                ),
              ),
            ),
            timescale: 1000000,
            originUs: assets.find(
              (asset) => asset.assetId === layer.assetId && asset.streamId === layer.streamId,
            )!.originUs,
          },
        };
      }),
    };
  },
};
async function fixture(render = renderer) {
  const home = await mkdtemp("/tmp/yap-project-frames-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const projects = projectStoreFixture(catalog, assets, home);
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "project") throw new CatalogError("INVALID_TARGET", "Expected project");
    projects.get(owner.projectId);
  });
  await cache.reconcile();
  let frames!: MediaFrameInspection;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind !== "project") throw new Error("Expected project");
        return {
          ...target,
          revisionId: projects.revision(target.projectId, target.revisionId).revisionId,
        };
      },
      isAvailable: (target) => target.kind === "project" && !projects.isDeleting(target.projectId),
      isDeleting: (target) => target.kind === "project" && projects.isDeleting(target.projectId),
      isCapturing: () => false,
    },
    execute: (execution) => frames.execute(execution),
  });
  frames = new MediaFrameInspection({
    assets,
    acquisitions: new AcquisitionStore(catalog),
    jobs,
    cache,
    sourceRenderer: {
      implementationId: "unused-source",
      render: async () => {
        throw new Error("Unused source renderer");
      },
    },
    project: { projects, renderer: render },
  });
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const input = join(home, "source.mov");
  await writeFile(input, "source identity");
  const asset = await assets.import(input, { kind: "import" }, async () => ({
    originUs: 9000,
    streams: [
      {
        id: "track:7",
        kind: "video",
        codec: "h264",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
        width: 160,
        height: 96,
        orientedWidth: 160,
        orientedHeight: 96,
      },
    ],
  }));
  const created = projects.create({
    requestId: "create",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 20, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  projects.apply(projectId, {
    requestId: "place",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "track" },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "track:7",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  return { projects, assets, cache, jobs, frames, projectId, assetId: asset.id };
}
test("demanded still pins global picture timing across head changes and cache regeneration", async () => {
  const f = await fixture();
  const first = f.frames.request({ projectId: f.projectId, atUs: 75001 });
  f.projects.apply(f.projectId, {
    requestId: "resize",
    expectedRevisionId: first.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  await f.jobs.idle();
  const request = { projectId: f.projectId, revisionId: first.revisionId, atUs: 75001 };
  const ready = f.frames.request(request);
  expect(ready.state).toBe("ready");
  const image = ready.published!.frame;
  expect(image.frame).not.toHaveProperty("visual");
  expect(image).toMatchObject({
    revisionId: first.revisionId,
    atUs: 75001,
    width: 160,
    height: 96,
    frame: { sampleAtUs: 50000, visibleRange: { startUs: 50000, endUs: 100000 } },
    pictures: [{ status: "available", requestedSourceUs: 50000, actualSourceUs: 50000 }],
  });
  expect(await readFile(image.file, "utf8")).toBe("test frame payload");
  f.cache.remove(image.cacheId);
  expect(f.frames.request(request).published).toBeNull();
  await f.jobs.idle();
  expect(f.frames.request(request).published!.frame.frame).toEqual(image.frame);
  expect(() => f.frames.request({ ...request, atUs: 1000000 })).toThrow();
});

test("a changed picture renderer regenerates demand without replacing the prior cached frame", async () => {
  const calls: string[] = [];
  const implementation: ProjectFrameRenderer = {
    ...renderer,
    implementationId: "before",
    async render(request, signal) {
      calls.push(this.implementationId);
      return renderer.render(request, signal);
    },
  };
  const f = await fixture(implementation);
  const request = { projectId: f.projectId, atUs: 75001 };
  f.frames.request(request);
  await f.jobs.idle();
  const before = f.frames.request(request).published!.frame;
  expect(f.frames.request(request).published!.frame.cacheId).toBe(before.cacheId);

  implementation.implementationId = "after";
  expect(f.frames.request(request).published).toBeNull();
  await f.jobs.idle();
  const after = f.frames.request(request).published!.frame;
  expect(after.implementationId).toBe("after");
  expect(after.cacheId).not.toBe(before.cacheId);
  expect(after.frame).toEqual(before.frame);
  expect(await readFile(before.file, "utf8")).toBe("test frame payload");

  implementation.implementationId = "before";
  expect(f.frames.request(request).published!.frame.cacheId).toBe(before.cacheId);
  expect(calls).toEqual(["before", "after"]);
});

test("a renderer cannot publish the wrong globally phased picture", async () => {
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const value = (await renderer.render(request, signal)) as { frame: { sampleAtUs: number } };
      value.frame.sampleAtUs++;
      return value;
    },
  });
  const request = { projectId: f.projectId, atUs: 75001 };
  f.frames.request(request);
  await f.jobs.idle();
  expect(f.frames.request(request)).toMatchObject({ state: "failed", published: null });
  expect(f.cache.bytes).toBe(0);
});

test("canceled late picture output is discarded and the same revision can retry", async () => {
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
  const request = { projectId: f.projectId, atUs: 75001 };
  const pending = f.frames.request(request);
  await started;
  f.jobs.cancel(pending.jobId!);
  release();
  await f.jobs.idle();
  expect(f.cache.bytes).toBe(0);
  expect(f.frames.request(request).published).toBeNull();
  f.frames.retry({ ...request, revisionId: pending.revisionId });
  await f.jobs.idle();
  expect(f.frames.request(request)).toMatchObject({
    state: "ready",
    published: { frame: { revisionId: pending.revisionId, atUs: 75001 } },
  });
});

test.each(["complete", "missing", "reordered", "wrong-source"] as const)(
  "physical provenance for repeated layers must be complete and ordered: %s",
  async (mode) => {
    const f = await fixture({
      ...renderer,
      async render(request, signal) {
        const receipt = (await renderer.render(request, signal)) as {
          pictures: { actualSourceUs: number }[];
        };
        if (mode === "missing") receipt.pictures.pop();
        if (mode === "reordered") receipt.pictures.reverse();
        if (mode === "wrong-source") receipt.pictures[1]!.actualSourceUs++;
        return receipt;
      },
    });
    f.projects.apply(f.projectId, {
      requestId: "second-layer",
      expectedRevisionId: f.projects.revision(f.projectId).revisionId,
      operations: [
        { operation: "track.add", track: { kind: "video", order: 1 }, label: "second" },
        {
          operation: "place",
          clip: {
            trackId: { label: "second" },
            assetId: f.assetId,
            streamId: "track:7",
            source: { kind: "range", range: { startUs: 100000, endUs: 900000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 800000 } },
          },
        },
      ],
    });
    const request = { projectId: f.projectId, atUs: 75001 };
    f.frames.request(request);
    await f.jobs.idle();
    const result = f.frames.request(request);
    if (mode === "complete")
      expect(result.published!.frame.pictures).toMatchObject([
        { requestedSourceUs: 50000, actualSourceUs: 50000 },
        { requestedSourceUs: 150000, actualSourceUs: 150000 },
      ]);
    else {
      expect(result).toMatchObject({ state: "failed", published: null });
      expect(f.cache.bytes).toBe(0);
    }
  },
);

test("native visual instructions are verified before the public frame receipt omits them", async () => {
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const receipt = (await renderer.render(request, signal)) as { frame: { visual: unknown[] } };
      receipt.frame.visual = [];
      return receipt;
    },
  });
  const request = { projectId: f.projectId, atUs: 75001 };
  f.frames.request(request);
  await f.jobs.idle();
  expect(f.frames.request(request)).toMatchObject({ state: "failed", published: null });
  expect(f.cache.bytes).toBe(0);
});

test.each([
  [0, 0, 50000],
  [50000, 50000, 100000],
  [999999, 950000, 1000000],
])(
  "picture requested at %i reports the full displayed frame interval",
  async (atUs, startUs, endUs) => {
    const f = await fixture();
    const request = { projectId: f.projectId, atUs };
    f.frames.request(request);
    await f.jobs.idle();
    expect(f.frames.request(request).published!.frame).toMatchObject({
      atUs,
      frame: { sampleAtUs: startUs, visibleRange: { startUs, endUs } },
    });
  },
);

test("public visibility projection cannot hide a native receipt with the wrong request range", async () => {
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const receipt = (await renderer.render(request, signal)) as {
        frame: { visibleRange: { startUs: number; endUs: number } };
      };
      receipt.frame.visibleRange = { startUs: 50000, endUs: 100000 };
      return receipt;
    },
  });
  const request = { projectId: f.projectId, atUs: 75001 };
  f.frames.request(request);
  await f.jobs.idle();
  expect(f.frames.request(request)).toMatchObject({ state: "failed", published: null });
  expect(f.cache.bytes).toBe(0);
});

test("project frame receipts preserve rational source requests with integer labels", async () => {
  const f = await fixture();
  const revision = f.projects.revision(f.projectId);
  f.projects.apply(f.projectId, {
    requestId: "cfr",
    expectedRevisionId: revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { fps: { numerator: 30, denominator: 1 } } }],
  });
  const request = { projectId: f.projectId, atUs: 999999 };
  f.frames.request(request);
  await f.jobs.idle();
  const ready = f.frames.request(request);
  expect(ready.state).toBe("ready");
  expect(ready.published!.frame).toMatchObject({
    frame: { index: 29, sampleAtUs: 966666, visibleRange: { startUs: 966666, endUs: 1000000 } },
    pictures: [{ requestedSourceUs: { numerator: 2900000, denominator: 3 } }],
  });
});

test("face observations measured on another raster cannot publish as the requested picture", async () => {
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const value = await renderer.render(request, signal);
      return {
        ...(value as object),
        faceObservations: {
          recipe: "vision-face-rectangles-v1",
          implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
          coordinateSpace: "delivered-top-left-pixels",
          width: 161,
          height: 96,
          status: "available",
          faces: [
            {
              faceId: "face-0",
              boundingBox: { x: 10, y: 10, width: 20, height: 30 },
              confidence: 0.9,
            },
          ],
        },
      };
    },
  });
  const request = { projectId: f.projectId, atUs: 75001, faceObservations: {} };
  f.frames.request(request);
  await f.jobs.idle();
  expect(f.frames.request(request)).toMatchObject({ state: "failed", published: null });
  expect(f.cache.bytes).toBe(0);
});

/** Places one text clip over the video and renders it as native would after a font fallback. */
async function fallbackFixture(fallbacks: (clipId: string) => unknown[], fonts?: string[]) {
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const frame = [...request.window.frames()][0]!;
      const video = await renderer.render(
        {
          ...request,
          window: {
            ...request.window,
            frames: function* () {
              yield { ...frame, layers: frame.layers.filter((layer) => layer.kind === "video") };
            },
          } as typeof request.window,
        },
        signal,
      );
      const receipt = video as { pictures: unknown[] };
      const text = frame.layers.find((layer) => layer.kind === "text")!;
      if (text.kind !== "text") throw new Error("Expected text");
      const length = text.text.text.length;
      return {
        ...receipt,
        frame,
        pictures: [
          ...receipt.pictures,
          {
            kind: "text",
            clipId: text.clipId,
            status: "available",
            layout: {
              font: text.text.font,
              text: text.text.text,
              visibleRange: [0, length],
              lines: [
                {
                  range: [0, length],
                  text: text.text.text,
                  origin: [0, 10],
                  width: 30,
                  fonts: fonts ?? ["Pinned", "AppleColorEmoji", "LastResort"],
                },
              ],
              inkBounds: [0, 0, 30, 10],
              visibleBounds: [0, 0, 30, 10],
              decorationBounds: [0, 0, 30, 10],
              verticalOffset: 0,
            },
          },
        ],
        textFallbacks: fallbacks(text.clipId),
      };
    },
  });
  const fontPath = join(await mkdtemp("/tmp/yap-font-"), "pinned.ttf");
  cleanup.push(() => rm(join(fontPath, ".."), { recursive: true, force: true }));
  await writeFile(fontPath, "pinned font bytes");
  const font = await f.assets.import(fontPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    fontFaces: [{ postScriptName: "Pinned", familyName: "Pinned" }],
  }));
  const placed = f.projects.apply(f.projectId, {
    requestId: "caption",
    expectedRevisionId: f.projects.revision(f.projectId).revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "captions" },
      {
        operation: "place",
        label: "caption",
        clip: {
          trackId: { label: "captions" },
          source: {
            kind: "text",
            text: "A\u{1F600}￿",
            font: { assetId: font.id, postScriptName: "Pinned" },
            width: 160,
            height: 40,
            size: 20,
            color: "#ffffffff",
            alignment: "left",
            wrap: true,
          },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  return {
    ...f,
    clipId: placed.edit.labels["caption"]!,
    font: { assetId: font.id, postScriptName: "Pinned" },
  };
}

test("a text font fallback publishes the frame with what was requested and what was drawn", async () => {
  const f = await fallbackFixture((clipId) => [
    { clipId, face: "AppleColorEmoji", substituted: [0x1f600], missing: [] },
    { clipId, face: "LastResort", substituted: [], missing: [0xffff] },
  ]);
  const request = { projectId: f.projectId, atUs: 75001 };
  f.frames.request(request);
  await f.jobs.idle();
  const ready = f.frames.request(request);
  expect(ready.state).toBe("ready");
  expect(ready.published!.issues).toEqual([
    {
      code: "font-substituted",
      message: expect.stringContaining("AppleColorEmoji"),
      evidence: {
        clipId: f.clipId,
        requested: f.font,
        used: "AppleColorEmoji",
        codePoints: [0x1f600],
      },
    },
    {
      code: "glyph-missing",
      message: expect.stringContaining("U+FFFF"),
      evidence: { clipId: f.clipId, requested: f.font, used: "LastResort", codePoints: [0xffff] },
    },
  ]);
});

test.each([
  [
    "a drawn face no fallback names",
    (clipId: string) => [{ clipId, face: "AppleColorEmoji", substituted: [0x1f600], missing: [] }],
  ],
  [
    "a fallback for a clip the frame does not draw",
    (clipId: string) => [
      { clipId, face: "AppleColorEmoji", substituted: [0x1f600], missing: [] },
      { clipId, face: "LastResort", substituted: [], missing: [0xffff] },
      { clipId: "elsewhere", face: "LastResort", substituted: [], missing: [0xffff] },
    ],
  ],
  [
    "a fallback that reports nothing",
    (clipId: string) => [
      { clipId, face: "AppleColorEmoji", substituted: [0x1f600], missing: [] },
      { clipId, face: "LastResort", substituted: [], missing: [0xffff] },
      { clipId, face: "Pinned", substituted: [], missing: [] },
    ],
  ],
])("a frame receipt with %s cannot publish", async (_name, fallbacks) => {
  const f = await fallbackFixture(fallbacks);
  const request = { projectId: f.projectId, atUs: 75001 };
  f.frames.request(request);
  await f.jobs.idle();
  expect(f.frames.request(request)).toMatchObject({ state: "failed", published: null });
  expect(f.cache.bytes).toBe(0);
});
