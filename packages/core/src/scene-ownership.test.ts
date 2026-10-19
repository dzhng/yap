import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore, AcquisitionImporter } from "./acquisitions.js";
import { SourceEvidenceStore } from "./evidence.js";
import { SourceSceneAnalysis, scenePolicy } from "./scenes.js";
import { SelectedSourceSceneAnalysis, sourceScenePolicy } from "./source-scenes.js";
import { selectSource } from "./source-selection.js";
import {
  SceneEvidenceStore,
  assetSceneOwner,
  recordingSceneOwner,
  type SceneEvidenceIdentity,
  type SceneSource,
} from "./scene-evidence.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function analysisFor(recordingId: string, source: string) {
  return new SourceSceneAnalysis(recordingId, source, 1000000, async (request) => ({
    sourceWidth: 32,
    sourceHeight: 16,
    samples: request.atSourceUs.map((requestedSourceUs) => ({
      requestedSourceUs,
      actualSourceUs: requestedSourceUs,
      distanceUs: 0,
      width: 1,
      height: 1,
      rgbBase64: Buffer.alloc(3, requestedSourceUs >= 400000 ? 255 : 0).toString("base64"),
    })),
  }));
}
function assetAnalysisFor(assetId: string, originUs = -250000) {
  return new SelectedSourceSceneAnalysis(
    {
      asset: { assetId, streamId: "v1", path: "/unused", originUs },
      available: [{ startUs: 0, endUs: 1000000 }],
    },
    1000000,
    async (request) => ({
      assetId,
      streamId: "v1",
      originUs,
      sourceWidth: 32,
      sourceHeight: 16,
      decodedSamples: request.atSourceUs.length,
      readerOpens: 1,
      samples: request.atSourceUs.map((at, index) => ({
        requestedSourceUs: at,
        status: "available" as const,
        actualSourceUs: at,
        sample: {
          value: String(at + originUs),
          timescale: 1000000,
          endValue: String(at + originUs + 1),
          endTimescale: 1000000,
        },
        width: 1,
        height: 1,
        rgbBase64: Buffer.alloc(3, at >= 400000 ? 255 : 0).toString("base64"),
        continuousFromPrevious: index > 0,
      })),
    }),
  );
}
async function fixture() {
  const home = await mkdtemp("/tmp/scene-ownership-");
  let id = "initial";
  const catalog = new CaptureStore(join(home, "catalog.sqlite"), {
    now: () => "fixture",
    newId: () => id,
  });
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const file = join(home, "media.mov");
  await writeFile(file, "scene source fixture");
  const probe = async () => ({
    originUs: -250000,
    streams: ["v1", "v2", "a1"].map((streamId) => ({
      id: streamId,
      kind: streamId === "a1" ? "audio" : "video",
      codec: "fixture",
      decodable: true,
      startUs: 0,
      endUs: 1000000,
      segments: [{ startUs: 0, endUs: 1000000, empty: false }],
      width: 32,
      height: 16,
    })),
  });
  const asset = await assets.import(file, { kind: "import" }, probe);
  id = asset.id;
  const recording = catalog.allocate().recording;
  catalog.registerSource(recording.id, 1000000);
  const recordingCheck = recordingSceneOwner(catalog),
    assetCheck = assetSceneOwner(assets, acquisitions);
  const evidence = new SceneEvidenceStore(catalog, (identity, source) =>
    identity.owner.kind === "recording"
      ? recordingCheck(identity, source)
      : assetCheck(identity, source),
  );
  const identity: SceneEvidenceIdentity = {
    owner: { kind: "asset", id: asset.id },
    sourceId: asset.id,
    generation: "same-attempt",
    policy: sourceScenePolicy,
  };
  const descriptor = (streamId = "v1"): SceneSource => {
    const selected = selectSource(assets, acquisitions, { assetId: asset.id, streamId });
    return {
      kind: "asset",
      streamId,
      originUs: -selected.track.sourceOffsetUs,
      supportDigest: selected.supportDigest,
      durationUs: selected.durationUs,
    };
  };
  const recordingChunk = await analysisFor(recording.id, file).analyze(
    { startUs: 0, endUs: 1000000 },
    new AbortController().signal,
  );
  const analysis = assetAnalysisFor(asset.id);
  const chunk = await analysis.analyze(
    { startUs: 0, endUs: 1000000 },
    new AbortController().signal,
  );
  return {
    home,
    catalog,
    assets,
    acquisitions,
    evidence,
    asset,
    recording,
    identity,
    descriptor,
    chunk,
    recordingChunk,
  };
}
test("real recording and asset owners with identical IDs and attempts retain their distinct scene policies", async () => {
  const f = await fixture();
  expect(f.recording.id).toBe(f.asset.id);
  expect(f.recording.sourceId).toBe(f.asset.id);
  const recording: SceneEvidenceIdentity = {
    ...f.identity,
    owner: { kind: "recording", id: f.asset.id },
    policy: scenePolicy.id,
  };
  f.evidence.append(f.identity, f.descriptor(), f.chunk);
  f.evidence.append(recording, { kind: "recording", durationUs: 1000000 }, f.recordingChunk);
  const asset = f.evidence.finish(f.identity),
    captured = f.evidence.finish(recording);
  expect(asset.source).toEqual(f.descriptor());
  expect(captured).toMatchObject({
    owner: { kind: "recording", id: f.asset.id },
    source: { kind: "recording", durationUs: 1000000 },
    boundaryCount: 1,
  });
  async function* capturedChunks() {
    yield f.recordingChunk;
  }
  await expect(
    f.evidence.stagePortable(captured, capturedChunks(), new AbortController().signal),
  ).rejects.toMatchObject({ name: "ZodError" });
  expect(f.evidence.sourcePage({ identity: f.identity }).chunks).toEqual([f.chunk]);
  await f.evidence.remove(f.identity);
  expect(() => f.evidence.sourcePage({ identity: f.identity })).toThrow("complete");
  expect(f.evidence.page({ identity: recording }).chunks).toEqual([f.recordingChunk]);
});
test("stream, support, duration and source owner mismatches cannot append or rebind a generation", async () => {
  const f = await fixture();
  expect(() =>
    f.evidence.append({ ...f.identity, sourceId: "another" }, f.descriptor(), f.chunk),
  ).toThrow("asset source");
  expect(() =>
    f.evidence.append(f.identity, { ...f.descriptor(), durationUs: 999 }, f.chunk),
  ).toThrow("support changed");
  expect(() =>
    f.evidence.append(
      f.identity,
      { ...f.descriptor(), supportDigest: "wrong" } as SceneSource,
      f.chunk,
    ),
  ).toThrow("support changed");
  expect(() => f.evidence.append(f.identity, f.descriptor("a1"), f.chunk)).toThrow("video stream");
  const first = { ...f.chunk, range: { startUs: 0, endUs: 200000 } };
  // Use an actual canonical short chunk; the first generation descriptor must stay pinned.
  const analysis = assetAnalysisFor(f.asset.id);
  const short = await analysis.analyze(first.range, new AbortController().signal);
  f.evidence.append(f.identity, f.descriptor(), short);
  const later = await analysis.analyze(
    { startUs: 200000, endUs: 1000000 },
    new AbortController().signal,
  );
  expect(() => f.evidence.append(f.identity, f.descriptor("v2"), later)).toThrow(
    "dimensions changed",
  );
  f.evidence.append(f.identity, f.descriptor(), later);
  f.evidence.finish(f.identity);
});
test("bounded reclamation preserves pinned asset generations and cancellation makes forward progress", async () => {
  const f = await fixture();
  for (let n = 0; n < 205; n++) {
    const identity = { ...f.identity, generation: `g${n}` };
    f.evidence.append(identity, f.descriptor(), f.chunk);
    f.evidence.finish(identity);
  }
  const controller = new AbortController();
  let seen = 0;
  await expect(
    f.evidence.reclaim(
      f.identity.owner,
      (generation) => {
        if (++seen === 102) controller.abort();
        return generation === "g0";
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(f.evidence.sourcePage({ identity: { ...f.identity, generation: "g0" } }).chunks).toEqual([
    f.chunk,
  ]);
  expect(() => f.evidence.sourcePage({ identity: { ...f.identity, generation: "g1" } })).toThrow(
    "complete",
  );
  await f.evidence.reclaim(f.identity.owner, (generation) => generation === "g0");
  expect(() => f.evidence.sourcePage({ identity: { ...f.identity, generation: "g204" } })).toThrow(
    "complete",
  );
  expect(f.evidence.sourcePage({ identity: { ...f.identity, generation: "g0" } }).chunks).toEqual([
    f.chunk,
  ]);
});
test("adopted acquisition contexts are authoritative and a generation cannot switch its context", async () => {
  const f = await fixture();
  const raw = new SourceEvidenceStore(f.catalog, ({ owner }) => {
    if (owner.kind !== "acquisition") throw new Error("unexpected owner");
    f.acquisitions.intent(owner.id);
  });
  const importer = new AcquisitionImporter(f.catalog, f.acquisitions, f.assets, raw, f.home);
  const signal = new AbortController().signal;
  await importer.recover(signal);
  async function adopt(name: string) {
    const donor = join(f.home, name);
    await mkdir(donor);
    await writeFile(join(donor, "capture.journal.jsonl"), name);
    await writeFile(join(donor, "video.mov"), "single video for acquisition");
    const prepared = await importer.prepareImport(name, donor);
    const intent = f.catalog.transaction(() => f.acquisitions.admitImport(prepared));
    return importer.executeImport(
      intent.acquisitionId,
      name,
      {
        probe: async () => ({
          originUs: -250000,
          streams: [
            {
              id: "v1",
              kind: "video",
              codec: "fixture",
              decodable: true,
              startUs: 0,
              endUs: 1000000,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
              width: 32,
              height: 16,
              orientedWidth: 32,
              orientedHeight: 16,
            },
          ],
        }),
        exportSource: async (_directory, output) => {
          await writeFile(output, "");
          return {
            file: output,
            journal: "capture.journal.jsonl",
            header: { sessionID: name },
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
      signal,
    );
  }
  const a = await adopt("first"),
    b = await adopt("second");
  expect(a.bindings[0]!.assetId).toBe(b.bindings[0]!.assetId);
  const assetId = a.bindings[0]!.assetId;
  const identity: SceneEvidenceIdentity = {
    ...f.identity,
    owner: { kind: "asset", id: assetId },
    sourceId: assetId,
  };
  const selected = selectSource(f.assets, f.acquisitions, {
    assetId,
    streamId: "v1",
    acquisitionId: a.id,
  });
  const source: SceneSource = {
    kind: "asset",
    streamId: "v1",
    acquisitionId: a.id,
    durationUs: selected.durationUs,
    originUs: -selected.track.sourceOffsetUs,
    supportDigest: selected.supportDigest,
  };
  const analysis = assetAnalysisFor(assetId);
  f.evidence.append(
    identity,
    source,
    await analysis.analyze({ startUs: 0, endUs: 200000 }, signal),
  );
  const tail = await analysis.analyze({ startUs: 200000, endUs: 1000000 }, signal);
  expect(() => f.evidence.append(identity, { ...source, acquisitionId: b.id }, tail)).toThrow(
    "dimensions changed",
  );
  expect(() => f.evidence.append(f.identity, source, f.chunk)).toThrow("does not bind");
  f.evidence.append(identity, source, tail);
  expect(f.evidence.finish(identity).source).toEqual(source);
});
