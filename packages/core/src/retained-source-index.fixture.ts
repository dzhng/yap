import { afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { SceneEvidenceStore, assetSceneOwner, sourceSceneDescriptor } from "./scene-evidence.js";
import { SelectedSourceSceneAnalysis, sourceScenePolicy } from "./source-scenes.js";
import { selectSource } from "./source-selection.js";
import { sourceIndexDomain, type SourceIndexRecords } from "./source-index.js";
import { sourceIndexPolicy } from "./source-index-selection.js";
import { ScreenshotIndexStore } from "./screenshot-index.js";
const stores: Catalog[] = [],
  roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
export async function fixture(durationUs = 10_000_000) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "selected-index-")));
  roots.push(home);
  const path = join(home, "catalog.sqlite");
  const catalog = new Catalog(path);
  stores.push(catalog);
  const assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const source = join(home, "source.mov");
  writeFileSync(source, "immutable source fixture");
  const asset = await assets.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "v",
        kind: "video",
        codec: "fixture",
        decodable: true,
        startUs: 0,
        endUs: durationUs,
        segments: [{ startUs: 0, endUs: durationUs, empty: false }],
        width: 1,
        height: 1,
        orientedWidth: 1,
        orientedHeight: 1,
      },
    ],
  }));
  const selection = { assetId: asset.id, streamId: "v" };
  const selected = selectSource(assets, acquisitions, selection);
  const scenes = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
  const sceneIdentity = {
    owner: { kind: "asset" as const, id: asset.id },
    sourceId: asset.id,
    generation: "scene-1",
    policy: sourceScenePolicy,
  };
  const analysis = new SelectedSourceSceneAnalysis(
    {
      asset: { ...selection, path: assets.path(asset.id), originUs: 0 },
      available: selected.track.available,
    },
    durationUs,
    async (request) => ({
      ...selection,
      originUs: 0,
      sourceWidth: 1,
      sourceHeight: 1,
      decodedSamples: 1,
      readerOpens: 1,
      samples: request.atSourceUs.map((at, i) => ({
        requestedSourceUs: at,
        status: "available" as const,
        actualSourceUs: 0,
        sample: {
          value: "0",
          timescale: 1_000_000,
          endValue: String(durationUs),
          endTimescale: 1_000_000,
        },
        width: 1,
        height: 1,
        rgbBase64: Buffer.alloc(3).toString("base64"),
        continuousFromPrevious: i > 0,
      })),
    }),
  );
  for (let startUs = 0; startUs < durationUs; startUs += 10_000_000)
    scenes.append(
      sceneIdentity,
      sourceSceneDescriptor(selected),
      await analysis.analyze(
        { startUs, endUs: Math.min(startUs + 10_000_000, durationUs) },
        new AbortController().signal,
      ),
    );
  const identity = {
    ...selection,
    generation: "index-1",
    scenes: scenes.finish(sceneIdentity),
    selectionPolicy: sourceIndexPolicy.id,
    implementationId: "source-frame",
    maxLongEdge: 1600,
  };
  const index = new ScreenshotIndexStore(
    catalog,
    home,
    sourceIndexDomain((selection) => selectSource(assets, acquisitions, selection), scenes, null),
  );
  function reopenedIndex(reopened: Catalog) {
    stores.push(reopened);
    const assets = new AssetStore(reopened, home),
      acquisitions = new AcquisitionStore(reopened);
    return new ScreenshotIndexStore(
      reopened,
      home,
      sourceIndexDomain(
        (selection) => selectSource(assets, acquisitions, selection),
        new SceneEvidenceStore(reopened, assetSceneOwner(assets, acquisitions)),
        null,
      ),
    );
  }
  return {
    home,
    path,
    catalog,
    assets,
    acquisitions,
    scenes,
    sceneIdentity,
    identity,
    index,
    selected,
    reopenedIndex,
    durationUs,
  };
}
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
export function add(
  f: Awaited<ReturnType<typeof fixture>>,
  ordinal = 0,
  at = 0,
  mutate: (frame: SourceIndexRecords["frame"]) => void = () => {},
) {
  const candidate: SourceIndexRecords["candidate"] = {
    ordinal,
    requestedSourceUs: at,
    support: { startUs: 0, endUs: f.durationUs },
    reasons: [{ kind: "first", eventSourceUs: at }],
  };
  const file = f.index.outputPath(f.identity, ordinal);
  writeFileSync(file, png);
  // Controlled receipts test retained ownership, not native pixel quality.
  const frame: SourceIndexRecords["frame"] = {
    file,
    mediaType: "image/png",
    requestedSourceUs: at,
    actualSourceUs: 0,
    atUs: at,
    width: 1,
    height: 1,
    sourceWidth: 1,
    sourceHeight: 1,
    sizeBytes: png.length,
    assetId: f.identity.assetId,
    streamId: f.identity.streamId,
    sample: {
      value: "0",
      timescale: 1_000_000,
      endValue: String(f.durationUs),
      endTimescale: 1_000_000,
      originUs: 0,
    },
    implementationId: f.identity.implementationId,
    maxLongEdge: f.identity.maxLongEdge,
    supportDigest: f.selected.supportDigest,
    decodedSamples: 1,
    readerOpens: 1,
  };
  mutate(frame);
  f.index.appendCandidate(f.identity, candidate, frame);
  return { candidate, frame };
}
export function cover(
  f: Awaited<ReturnType<typeof fixture>>,
  ordinal = 0,
  startUs = 0,
  endUs = f.durationUs,
  equality: "sampled" | "unproven" = "sampled",
) {
  f.index.appendCoverage(f.identity, {
    state: "available",
    ordinal,
    source: { startUs, endUs },
    equality,
  });
}
