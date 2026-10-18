import { projectStoreFixture } from "./project-store.fixture.js";
import { projectComposition } from "./project-window.js";
import { selectSource } from "./source-selection.js";
import { floor, fromTime, add, compare, type CompiledFrame } from "@yap/composition";
import { afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { MediaFrameInspection } from "./frame-inspection.js";
import { SceneEvidenceStore, assetSceneOwner } from "./scene-evidence.js";
import { SceneProcessing } from "./scene-processing.js";
import { ScreenshotIndexStore } from "./screenshot-index.js";
import { sourceIndexDomain } from "./source-index.js";
import { projectIndexDomain } from "./project-index.js";
import { IndexProcessing } from "./index-processing.js";
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=",
  "base64",
);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
export async function fixture(
  options: {
    beforeFrame?: (call: number, signal: AbortSignal) => Promise<void>;
    beforeScene?: () => void;
    empty?: boolean;
    continuousSupport?: boolean;
    changingScenes?: boolean;
    projectImplementationId?: string;
    barrier?: ReturnType<typeof gate>;
    /** Text layers render as native does when one code point fell back to another face. */
    textFallback?: { face: string; codePoint: number };
  } = {},
) {
  const home = await mkdtemp("/tmp/source-index-processing-");
  const catalog = new Catalog(join(home, "catalog.sqlite")),
    assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const path = join(home, "source.mov");
  await writeFile(path, "immutable fixture media");
  const asset = await assets.import(path, { kind: "import" }, async () => ({
    originUs: 1250000,
    streams: ["v", "w"].map((id) => ({
      id,
      kind: "video",
      codec: "fixture",
      decodable: true,
      width: 1,
      height: 1,
      orientedWidth: 1,
      orientedHeight: 1,
      startUs: 0,
      endUs: 1200000,
      segments: options.continuousSupport
        ? [{ startUs: 0, endUs: 1200000, empty: false }]
        : [
            { startUs: 0, endUs: 200000, empty: true },
            { startUs: 200000, endUs: 400000, empty: false },
            { startUs: 400000, endUs: 600000, empty: true },
            { startUs: 600000, endUs: 1000000, empty: false },
            { startUs: 1000000, endUs: 1200000, empty: true },
          ],
    })),
  }));
  const projects = projectStoreFixture(catalog, assets, home, acquisitions);
  const projectId = projects.create({
    requestId: "project",
    canvas: {
      width: 1,
      height: 1,
      fps: { numerator: 5, denominator: 1 },
      background: "#000000ff",
    },
  }).project.projectId;
  let frames!: MediaFrameInspection,
    scenes!: SceneProcessing,
    index!: IndexProcessing,
    calls = 0;
  let projectRendererId = options.projectImplementationId ?? "fixture-project";
  let jobs!: JobQueue,
    cache!: DerivedCache,
    records!: SceneEvidenceStore,
    retained!: ScreenshotIndexStore<import("./source-index.js").SourceIndexRecords>,
    projectRetained!: ScreenshotIndexStore<import("./project-index.js").ProjectIndexRecords>;
  function install() {
    jobs = new JobQueue({
      store: catalog,
      providers: { newId: randomUUID },
      targets: {
        pin: (t) => {
          if (t.kind === "project")
            return { ...t, revisionId: projects.revision(t.projectId, t.revisionId).revisionId };
          if (t.kind !== "asset") throw new Error("asset only");
          assets.get(t.assetId);
          return t;
        },
        isAvailable: (t) => t.kind !== "project" || !projects.isDeleting(t.projectId),
        isDeleting: (t) => t.kind === "project" && projects.isDeleting(t.projectId),
        isCapturing: () => false,
      },
      execute: (e) =>
        e.job.artifact === "barrier"
          ? options.barrier!.promise.then(() => "done")
          : e.job.artifact === "source-scenes"
            ? scenes.execute(e)
            : e.job.artifact === "frame"
              ? frames.execute(e)
              : index.execute(e),
    });
    cache = new DerivedCache(catalog, home, (owner) => {
      if (owner.kind === "project") {
        projects.get(owner.projectId);
        return;
      }
      if (owner.kind !== "asset") throw new Error("asset only");
      assets.get(owner.assetId);
    });
    frames = new MediaFrameInspection({
      assets,
      acquisitions,
      jobs,
      cache,
      // Synthetic native receipts exercise the real queue/store consumer, not renderer pixel quality.
      project: {
        projects,
        renderer: {
          implementationId: projectRendererId,
          async render({ window, assets: bindings, output, faceObservations }, signal) {
            calls++;
            await options.beforeFrame?.(calls, signal);
            signal.throwIfAborted();
            await writeFile(output, png);
            const frame: CompiledFrame = window.frames().next().value!;
            return {
              file: output,
              bytes: png.length,
              mediaType: "image/png",
              profile: "h264-rec709",
              width: 1,
              height: 1,
              sourceWidth: window.manifest.canvas.width,
              sourceHeight: window.manifest.canvas.height,
              decodedImages: 0,
              decodedSamples: frame.layers.length,
              readerOpens: frame.layers.length,
              frame,
              ...(options.textFallback && frame.layers.some((layer) => layer.kind === "text")
                ? {
                    textFallbacks: frame.layers.flatMap((layer) =>
                      layer.kind === "text"
                        ? [
                            {
                              clipId: layer.clipId,
                              face: options.textFallback!.face,
                              substituted: [options.textFallback!.codePoint],
                              missing: [],
                            },
                          ]
                        : [],
                    ),
                  }
                : {}),
              pictures: frame.layers.map((layer) => {
                if (layer.kind === "text" && options.textFallback) {
                  const { text, font } = layer.text;
                  return {
                    kind: "text",
                    clipId: layer.clipId,
                    status: "available",
                    layout: {
                      font,
                      text,
                      visibleRange: [0, text.length],
                      lines: [
                        {
                          range: [0, text.length],
                          text,
                          origin: [0, 1],
                          width: 1,
                          fonts: [font.postScriptName, options.textFallback.face],
                        },
                      ],
                      inkBounds: [0, 0, 1, 1],
                      visibleBounds: [0, 0, 1, 1],
                      decorationBounds: [0, 0, 1, 1],
                      verticalOffset: 0,
                    },
                  };
                }
                if (layer.kind !== "video") throw new Error("Fixture requires timed video");
                const picture = {
                  kind: "video",
                  clipId: layer.clipId,
                  assetId: layer.assetId,
                  streamId: layer.streamId,
                  requestedSourceUs: layer.sourceUs,
                };
                if (layer.availability !== "available" || options.empty)
                  return { ...picture, status: "unavailable", reason: "source-unavailable" };
                const originUs = bindings.find(
                  (b) => b.assetId === layer.assetId && b.streamId === layer.streamId,
                )!.originUs;
                const actualSourceUs =
                  Math.floor(floor(fromTime(layer.sourceUs)) / 200000) * 200000;
                return {
                  ...picture,
                  status: "available",
                  actualSourceUs,
                  sample: {
                    value: String(floor(add(fromTime(actualSourceUs), fromTime(originUs)))),
                    timescale: 1000000,
                    originUs,
                  },
                };
              }),
              ...(faceObservations === undefined
                ? {}
                : {
                    faceObservations: {
                      recipe: "vision-face-rectangles-v1",
                      implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
                      coordinateSpace: "delivered-top-left-pixels",
                      width: 1,
                      height: 1,
                      status: "available",
                      faces: [
                        {
                          faceId: "face-0",
                          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
                          confidence: 0.9,
                        },
                      ],
                    },
                  }),
            };
          },
        },
      },
      sourceRenderer: {
        implementationId: "fixture-frame",
        async render({ asset, atUs, output, faceObservations }, signal) {
          calls++;
          await options.beforeFrame?.(calls, signal);
          signal.throwIfAborted();
          if (options.empty)
            throw new CatalogError("SOURCE_PICTURE_UNAVAILABLE", "No physical picture");
          await writeFile(output, png);
          const start = Math.floor(atUs / 200000) * 200000;
          return {
            file: output,
            mediaType: "image/png",
            assetId: asset.assetId,
            streamId: asset.streamId,
            requestedSourceUs: atUs,
            actualSourceUs: start,
            sample: {
              value: String(floor(add(fromTime(start), fromTime(asset.originUs)))),
              timescale: 1000000,
              endValue: String(floor(add(fromTime(start + 200000), fromTime(asset.originUs)))),
              endTimescale: 1000000,
              originUs: asset.originUs,
            },
            width: 1,
            height: 1,
            sourceWidth: 1,
            sourceHeight: 1,
            decodedSamples: 1,
            readerOpens: 1,
            bytes: png.length,
            ...(faceObservations === undefined
              ? {}
              : {
                  faceObservations: {
                    recipe: "vision-face-rectangles-v1",
                    implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
                    coordinateSpace: "delivered-top-left-pixels",
                    width: 1,
                    height: 1,
                    status: "available",
                    faces: [
                      {
                        faceId: "face-0",
                        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
                        confidence: 0.9,
                      },
                    ],
                  },
                }),
          };
        },
      },
    });
    records = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
    scenes = new SceneProcessing({
      jobs,
      evidence: records,
      asset: {
        assets,
        acquisitions,
        implementationId: "fixture-scene",
        retained: (assetId, generation) => index.retainsSourceScenes(assetId, generation),
        async sample(request) {
          options.beforeScene?.();
          return {
            assetId: request.asset.assetId,
            streamId: request.asset.streamId,
            originUs: request.asset.originUs,
            sourceWidth: 1,
            sourceHeight: 1,
            decodedSamples: 1,
            readerOpens: 1,
            samples: request.atSourceUs.map((at, i) => {
              const range = request.available.find(
                (r) =>
                  compare(fromTime(r.startUs), fromTime(at)) <= 0 &&
                  compare(fromTime(at), fromTime(r.endUs)) < 0,
              );
              if (!range || options.empty)
                return {
                  requestedSourceUs: at,
                  status: "unavailable",
                  reason: range ? "empty_edit" : "outside_support",
                  continuousFromPrevious: false,
                };
              const start = Math.floor(at / 200000) * 200000;
              return {
                requestedSourceUs: at,
                status: "available",
                actualSourceUs: start,
                sample: {
                  value: String(start + 1250000),
                  timescale: 1000000,
                  endValue: String(start + 200000 + 1250000),
                  endTimescale: 1000000,
                },
                width: 1,
                height: 1,
                rgbBase64: Buffer.alloc(
                  3,
                  options.changingScenes && (start / 200000) % 2 ? 255 : 0,
                ).toString("base64"),
                continuousFromPrevious:
                  i > 0 &&
                  compare(fromTime(request.atSourceUs[i - 1]!), fromTime(range.startUs)) >= 0,
              };
            }),
          };
        },
      },
    });
    retained = new ScreenshotIndexStore(
      catalog,
      home,
      sourceIndexDomain(
        (selection) => selectSource(assets, acquisitions, selection),
        records,
        frames,
      ),
    );
    projectRetained = new ScreenshotIndexStore(
      catalog,
      home,
      projectIndexDomain(
        {
          composition: (identity) => projectComposition(projects, assets, identity),
          source: (selection) => selectSource(assets, acquisitions, selection),
          scenes: records,
          isDeleting: (id) => projects.isDeleting(id),
        },
        {
          implementationId: projectRendererId,
        },
      ),
    );
    index = new IndexProcessing({
      jobs,
      asset: { catalog, assets, acquisitions, index: retained, scenes, records, frames, cache },
      project: {
        catalog,
        assets,
        acquisitions,
        projects,
        index: projectRetained,
        scenes,
        records,
        frames,
        cache,
      },
    });
  }
  install();
  await cache.reconcile();
  cleanup.push(async () => {
    options.barrier?.resolve();
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const selection = { assetId: asset.id, streamId: "v" };
  return {
    home,
    path,
    projects,
    projectId,
    get projectRetained() {
      return projectRetained;
    },
    assets,
    acquisitions,
    catalog,
    get scenes() {
      return scenes;
    },
    get frames() {
      return frames;
    },
    get records() {
      return records;
    },
    get index() {
      return index;
    },
    get jobs() {
      return jobs;
    },
    get cache() {
      return cache;
    },
    get retained() {
      return retained;
    },
    selection,
    get calls() {
      return calls;
    },
    async restart(implementationId = projectRendererId) {
      await jobs.close();
      projectRendererId = implementationId;
      install();
      await cache.reconcile();
    },
    async prepare() {
      const waiting = index.requestSource(selection);
      await jobs.idle();
      const pending = index.requestSource(selection);
      return { waiting, pending };
    },
  };
}
