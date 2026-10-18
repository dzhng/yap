import { omit } from "@yap/composition";
import { createHash, randomUUID } from "node:crypto";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { MediaFrameInspection } from "./frame-inspection.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { projectIndexDomain, projectIndexPlan } from "./project-index.js";
import { projectComposition } from "./project-window.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { SceneEvidenceStore, assetSceneOwner, sourceSceneDescriptor } from "./scene-evidence.js";
import { SelectedSourceSceneAnalysis, sourceScenePolicy } from "./source-scenes.js";
import { selectSource } from "./source-selection.js";
import { ScreenshotIndexStore, type PortableIndexRecord } from "./screenshot-index.js";
import {
  sourceIndexDomain,
  type SourceIndexIdentity,
  type SourceIndexRecords,
} from "./source-index.js";
const namespaceEntropy = vi.hoisted<{ id: string | null }>(() => ({ id: null }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => namespaceEntropy.id ?? actual.randomUUID() };
});
const noFrameRequests = {
  sourceUnavailable(): never {
    throw new Error("No demanded frames in this fixture");
  },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
async function fixture(emptyAt?: number, allEmpty = false) {
  const home = await mkdtemp("/tmp/source-index-"),
    path = join(home, "catalog.sqlite");
  let catalog = new Catalog(path),
    assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const input = join(home, "video.mov");
  await writeFile(input, "original source");
  const asset = await assets.import(input, { kind: "import" }, async () => ({
    originUs: 1250000,
    streams: [
      {
        id: "v",
        kind: "video",
        codec: "fixture",
        decodable: true,
        startUs: 200000,
        endUs: 1000000,
        segments: [{ startUs: 200000, endUs: 1000000, empty: allEmpty }],
        width: 1,
        height: 1,
        orientedWidth: 1,
        orientedHeight: 1,
      },
    ],
  }));
  const selected = selectSource(assets, acquisitions, { assetId: asset.id, streamId: "v" });
  let scenes = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
  const sceneId = {
    owner: { kind: "asset" as const, assetId: asset.id },
    sourceId: asset.id,
    generation: "scene",
    policy: sourceScenePolicy,
  };
  const analysis = new SelectedSourceSceneAnalysis(
    {
      asset: { assetId: asset.id, streamId: "v", path: assets.path(asset.id), originUs: 1250000 },
      available: selected.track.available,
    },
    1000000,
    async (r) => ({
      assetId: asset.id,
      streamId: "v",
      originUs: 1250000,
      sourceWidth: 1,
      sourceHeight: 1,
      decodedSamples: 1,
      readerOpens: 1,
      samples: r.atSourceUs.map((at, i) =>
        allEmpty || at < 200000 || at === emptyAt
          ? {
              requestedSourceUs: at,
              status: "unavailable",
              reason: at === emptyAt ? "empty_edit" : "outside_support",
              continuousFromPrevious: false,
            }
          : {
              requestedSourceUs: at,
              status: "available",
              actualSourceUs: 200000,
              sample: {
                value: "1450000",
                timescale: 1000000,
                endValue: "2250000",
                endTimescale: 1000000,
              },
              width: 1,
              height: 1,
              rgbBase64: Buffer.alloc(3).toString("base64"),
              continuousFromPrevious: i > 1 && r.atSourceUs[i - 1] !== emptyAt,
            },
      ),
    }),
  );
  scenes.append(
    sceneId,
    sourceSceneDescriptor(selected),
    await analysis.analyze({ startUs: 0, endUs: 1000000 }, new AbortController().signal),
  );
  const identity: SourceIndexIdentity = {
    assetId: asset.id,
    streamId: "v",
    generation: "index",
    scenes: scenes.finish(sceneId),
    selectionPolicy: "source-selection",
    implementationId: "source-frame",
    maxLongEdge: 1600,
  };
  let index = new ScreenshotIndexStore(
    catalog,
    home,
    sourceIndexDomain(
      (selection) => selectSource(assets, acquisitions, selection),
      scenes,
      noFrameRequests,
    ),
  );
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const candidate = {
    ordinal: 0,
    requestedSourceUs: 200000,
    support: { startUs: 200000, endUs: 1000000 },
    reasons: [],
  };
  async function append() {
    const output = index.outputPath(identity, 0);
    await writeFile(output, png);
    const frame: SourceIndexRecords["frame"] = {
      file: output,
      sizeBytes: png.length,
      mediaType: "image/png",
      width: 1,
      height: 1,
      sourceWidth: 1,
      sourceHeight: 1,
      decodedSamples: 1,
      readerOpens: 1,
      assetId: asset.id,
      streamId: "v",
      atUs: 200000,
      requestedSourceUs: 200000,
      actualSourceUs: 200000,
      sample: {
        value: "1450000",
        timescale: 1000000,
        endValue: "2250000",
        endTimescale: 1000000,
        originUs: 1250000,
      },
      maxLongEdge: 1600,
      supportDigest: selected.supportDigest,
      implementationId: "source-frame",
    };
    index.appendCandidate(identity, candidate, frame);
    return frame;
  }
  return {
    home,
    input,
    identity,
    get assets() {
      return assets;
    },
    get acquisitions() {
      return acquisitions;
    },
    get scenes() {
      return scenes;
    },
    candidate,
    append,
    get index() {
      return index;
    },
    get catalog() {
      return catalog;
    },
    reopen() {
      catalog.close();
      catalog = new Catalog(path);
      assets = new AssetStore(catalog, home);
      acquisitions = new AcquisitionStore(catalog);
      scenes = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
      index = new ScreenshotIndexStore(
        catalog,
        home,
        sourceIndexDomain(
          (selection) => selectSource(assets, acquisitions, selection),
          scenes,
          noFrameRequests,
        ),
      );
    },
  };
}
test("real source indexes retain images and explicit unsupported coverage without recording metadata", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const frame = await f.append();
  f.index.appendCoverage(f.identity, {
    ordinal: null,
    state: "unavailable",
    basis: "support",
    source: { startUs: 0, endUs: 200000 },
  });
  f.index.appendCoverage(f.identity, {
    ordinal: 0,
    state: "available",
    equality: "sampled",
    source: { startUs: 200000, endUs: 1000000 },
  });
  const metadata = await f.index.finish(f.identity);
  expect(metadata).toMatchObject({
    assetId: f.identity.assetId,
    candidateCount: 1,
    coverageCount: 2,
  });
  expect(metadata).not.toHaveProperty("recordingId");
  expect(metadata).not.toHaveProperty("revisionId");
  f.reopen();
  expect(f.index.page({ identity: f.identity }).entries).toEqual([
    { candidate: f.candidate, frame, coverageCount: 1 },
  ]);
  const first = f.index.coveragePage({ identity: f.identity, limit: 1 });
  expect(first.coverage).toEqual([
    {
      sequence: 0,
      ordinal: null,
      state: "unavailable",
      basis: "support",
      source: { startUs: 0, endUs: 200000 },
    },
  ]);
  expect(
    f.index.coveragePage({ identity: f.identity, afterSequence: first.nextSequence!, limit: 1 })
      .coverage[0],
  ).toMatchObject({ ordinal: 0, state: "available" });
  const opened = f.index.openRead(f.identity, 0);
  await f.index.remove(f.identity);
  const bytes = Buffer.alloc(png.length);
  expect(opened.read(bytes, 0)).toBe(png.length);
  expect(bytes).toEqual(png);
  opened.release();
  expect(await readFile(f.input, "utf8")).toBe("original source");
  expect(
    f.catalog.catalog.prepare("SELECT name FROM sqlite_master WHERE name='recordings'").all(),
  ).toEqual([]);
});
test("source support cannot be mislabeled unavailable and incomplete generations cannot become readable", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  await f.append();
  expect(() =>
    f.index.appendCoverage(f.identity, {
      ordinal: null,
      state: "unavailable",
      basis: "support",
      source: { startUs: 0, endUs: 300000 },
    }),
  ).toThrow("overlaps");
  await expect(f.index.finish(f.identity)).rejects.toThrow("incomplete");
  expect(() => f.index.page({ identity: f.identity })).toThrow("complete");
  await f.index.reclaim({ kind: "asset", assetId: f.identity.assetId }, () => false);
  expect(f.catalog.catalog.prepare("SELECT * FROM screenshot_index_generations").all()).toEqual([]);
});

test("asset and project indexes with equal fixture IDs and attempts reclaim independently", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const projects = projectStoreFixture(f.catalog, f.assets, f.home, f.acquisitions);
  // Controlled entropy keeps the generic owner-kind collision oracle; this is not a public ID-format claim.
  namespaceEntropy.id = f.identity.assetId;
  let projectId: string;
  try {
    projectId = projects.create({
      requestId: "namespace-project",
      canvas: {
        width: 1,
        height: 1,
        fps: { numerator: 1, denominator: 1 },
        background: "#000000ff",
      },
    }).project.projectId;
  } finally {
    namespaceEntropy.id = null;
  }
  expect(projectId).toBe(f.identity.assetId);
  const composition = projectComposition(projects, f.assets, { projectId });
  const identity = {
    ...projectIndexPlan(composition, {}, { implementationId: "project-frame" }).identity,
    generation: f.identity.generation,
    scenes: [],
  };
  const retained = new ScreenshotIndexStore(
    f.catalog,
    f.home,
    projectIndexDomain(
      {
        composition: (input) => projectComposition(projects, f.assets, input),
        source: (selection) => selectSource(f.assets, f.acquisitions, selection),
        scenes: f.scenes,
        isDeleting: (input) => projects.isDeleting(input),
      },
      { implementationId: "project-frame" },
    ),
  );
  retained.begin(identity);
  const path = retained.outputPath(identity, 0);
  await writeFile(path, png);
  await f.index.reclaim({ kind: "asset", assetId: f.identity.assetId }, () => false);
  expect(await readFile(retained.outputPath(identity, 0))).toEqual(png);
  expect(
    f.catalog.catalog
      .prepare("SELECT ownerKind,ownerId,generation FROM screenshot_index_generations")
      .all(),
  ).toEqual([
    { ownerKind: "project", ownerId: f.identity.assetId, generation: f.identity.generation },
  ]);
  await retained.remove(identity);
});

test("a pinned unavailable observation is retained without claiming neighboring pixels are absent", async () => {
  const f = await fixture(400000);
  f.index.begin(f.identity);
  await f.append();
  f.index.appendCoverage(f.identity, {
    ordinal: null,
    state: "unavailable",
    basis: "support",
    source: { startUs: 0, endUs: 200000 },
  });
  f.index.appendCoverage(f.identity, {
    ordinal: 0,
    state: "available",
    equality: "unproven",
    source: { startUs: 200000, endUs: 400000 },
  });
  const coverage = {
    ordinal: null,
    state: "unavailable" as const,
    basis: "observation" as const,
    equality: "unproven" as const,
    source: { startUs: 400000, endUs: 600000 },
    observation: {
      kind: "scene" as const,
      point: {
        requestedSourceUs: 400000,
        status: "unavailable" as const,
        reason: "empty_edit" as const,
        continuousFromPrevious: false as const,
      },
    },
  };
  expect(() =>
    f.index.appendCoverage(f.identity, {
      ...coverage,
      observation: {
        ...coverage.observation,
        point: { ...coverage.observation.point, requestedSourceUs: 500000 },
      },
    }),
  ).toThrow("pinned scene");
  f.index.appendCoverage(f.identity, coverage);
  f.index.appendCoverage(f.identity, {
    ordinal: 0,
    state: "available",
    equality: "unproven",
    source: { startUs: 600000, endUs: 1000000 },
  });
  await f.index.finish(f.identity);
  expect(f.index.coveragePage({ identity: f.identity }).coverage[2]).toEqual({
    ...coverage,
    sequence: 2,
  });
});

test("complete source coverage with no available pictures remains readable without inventing an image", async () => {
  const f = await fixture(undefined, true);
  f.index.begin(f.identity);
  const coverage = {
    ordinal: null,
    state: "unavailable" as const,
    basis: "support" as const,
    source: { startUs: 0, endUs: 1000000 },
  };
  f.index.appendCoverage(f.identity, coverage);
  const metadata = await f.index.finish(f.identity);
  expect(metadata).toMatchObject({
    candidateCount: 0,
    coverageCount: 1,
    sizeBytes: 0,
    durationUs: 1000000,
  });
  f.reopen();
  expect(f.index.page({ identity: f.identity }).entries).toEqual([]);
  expect(f.index.coveragePage({ identity: f.identity }).coverage).toEqual([
    { ...coverage, sequence: 0 },
  ]);
  expect(() => f.index.openRead(f.identity, 0)).toThrow("does not exist");
});

test("demanded empty-picture coverage retains verified provenance after the job is forgotten", async () => {
  const f = await fixture();
  const cache = new DerivedCache(f.catalog, f.home, (owner) => {
    if (owner.kind !== "asset") throw new Error("asset only");
    f.assets.get(owner.assetId);
  });
  await cache.reconcile();
  let frames!: MediaFrameInspection;
  const jobs = new JobQueue({
    store: f.catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (t) => {
        if (t.kind !== "asset") throw new Error("asset only");
        return t;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (e) => frames.execute(e),
  });
  let expected: unknown;
  try {
    frames = new MediaFrameInspection({
      assets: f.assets,
      acquisitions: f.acquisitions,
      jobs,
      cache,
      sourceRenderer: {
        implementationId: f.identity.implementationId,
        async render() {
          throw new CatalogError("SOURCE_PICTURE_UNAVAILABLE", "No physical sample");
        },
      },
    });
    const request = { assetId: f.identity.assetId, streamId: f.identity.streamId, atUs: 400000 };
    const pending = frames.request(request);
    await jobs.idle();
    const frame = frames.sourceUnavailable(request);
    const index = new ScreenshotIndexStore(
      f.catalog,
      f.home,
      sourceIndexDomain(
        (selection) => selectSource(f.assets, f.acquisitions, selection),
        f.scenes,
        frames,
      ),
    );
    index.begin(f.identity);
    index.appendCoverage(f.identity, {
      ordinal: null,
      state: "unavailable",
      basis: "support",
      source: { startUs: 0, endUs: 200000 },
    });
    const coverage = {
      ordinal: null,
      state: "unavailable" as const,
      basis: "observation" as const,
      equality: "unproven" as const,
      source: { startUs: 200000, endUs: 1000000 },
      observation: { kind: "frame" as const, frame },
    };
    expect(() =>
      index.appendCoverage(f.identity, {
        ...coverage,
        observation: { kind: "frame", frame: { ...frame, attemptId: "invented" } },
      }),
    ).toThrow("does not match");
    index.appendCoverage(f.identity, coverage);
    await index.finish(f.identity);
    jobs.forgetJob(pending.jobId!);
    const retained = sourceIndexDomain(
      (selection) => selectSource(f.assets, f.acquisitions, selection),
      f.scenes,
      noFrameRequests,
    );
    expect(
      retained.coverage({ identity: f.identity, candidate: null, coverage, admission: "retained" }),
    ).toEqual(coverage.source);
    for (const changed of [
      { attemptId: "invented" },
      { supportDigest: "0".repeat(64) },
      { selection: { ...frame.selection, assetId: "0".repeat(64) } },
      { observation: { ...frame.observation, requestedSourceUs: frame.atUs + 1 } },
      { implementationId: "another-renderer" },
    ]) {
      expect(() =>
        retained.coverage({
          identity: f.identity,
          candidate: null,
          coverage: {
            ...coverage,
            observation: { kind: "frame", frame: { ...frame, ...changed } },
          },
          admission: "retained",
        }),
      ).toThrow("does not match");
    }
    expected = { ...coverage, sequence: 1 };
  } finally {
    await jobs.close();
  }
  f.reopen();
  expect(f.index.coveragePage({ identity: f.identity }).coverage[1]).toEqual(expected);
});

test("portable source index stages real PNGs, publishes atomically, replays, and recovers unpublished generations", async () => {
  const donor = await fixture(400000),
    receiver = await fixture(400000);
  donor.index.begin(donor.identity);
  await donor.append();
  donor.index.appendCoverage(donor.identity, {
    ordinal: null,
    state: "unavailable",
    basis: "support",
    source: { startUs: 0, endUs: 200000 },
  });
  donor.index.appendCoverage(donor.identity, {
    ordinal: 0,
    state: "available",
    equality: "unproven",
    source: { startUs: 200000, endUs: 1000000 },
  });
  const metadata = await donor.index.finish(donor.identity);
  const entry = donor.index.readEntry(donor.identity, 0),
    coverage = donor.index.coveragePage({ identity: donor.identity }).coverage,
    source = donor.index.portableImage(donor.identity, 0),
    sha256 = createHash("sha256")
      .update(await readFile(source.path))
      .digest("hex");
  async function* records(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
    yield {
      kind: "entry",
      candidate: entry.candidate,
      frame: { ...entry.frame, file: "0.png" },
      source,
      sha256,
    };
    for (const value of coverage) yield { kind: "coverage", coverage: omit(value, "sequence") };
  }
  const validation = () =>
    sourceIndexDomain(
      (selection) => selectSource(receiver.assets, receiver.acquisitions, selection),
      receiver.scenes,
      null,
    );
  const signal = new AbortController().signal;
  const staged = await receiver.index.stagePortable(metadata, records(), signal, validation());
  expect(() => receiver.index.page({ identity: donor.identity })).toThrow("not complete");
  expect(() =>
    receiver.catalog.transaction(() => {
      staged.publish();
      throw new Error("publication rollback");
    }),
  ).toThrow("publication rollback");
  expect(() => receiver.index.page({ identity: donor.identity })).toThrow("not complete");
  receiver.catalog.transaction(() => staged.publish());
  await staged.close();
  receiver.reopen();
  const restored = receiver.index.readEntry(donor.identity, 0);
  expect(restored.candidate).toEqual(entry.candidate);
  expect(restored.frame.file).not.toBe(entry.frame.file);
  expect(await readFile(restored.frame.file)).toEqual(await readFile(entry.frame.file));
  expect(receiver.index.coveragePage({ identity: donor.identity }).coverage).toEqual(coverage);
  const replay = await receiver.index.stagePortable(metadata, records(), signal, validation());
  receiver.catalog.transaction(() => replay.publish());
  await replay.close();
  await expect(
    receiver.index.stagePortable(
      { ...metadata, implementationId: "collision" },
      records(),
      signal,
      validation(),
    ),
  ).rejects.toThrow("conflicts");
  const canceled = new AbortController();
  async function* cancelRecords(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
    for await (const value of records()) {
      yield value;
      canceled.abort();
    }
  }
  await expect(
    receiver.index.stagePortable(
      { ...metadata, generation: "canceled" },
      cancelRecords(),
      canceled.signal,
      validation(),
    ),
  ).rejects.toThrow();
  expect(receiver.index.portableGenerations({ kind: "asset", assetId: metadata.assetId })).toEqual([
    metadata,
  ]);
  async function* corruptRecords(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
    for await (const value of records())
      yield value.kind === "entry" ? { ...value, sha256: "0".repeat(64) } : value;
  }
  await expect(
    receiver.index.stagePortable(
      { ...metadata, generation: "corrupt" },
      corruptRecords(),
      signal,
      validation(),
    ),
  ).rejects.toThrow("differs from inventory");
  expect(receiver.index.portableGenerations({ kind: "asset", assetId: metadata.assetId })).toEqual([
    metadata,
  ]);
  async function* wrongGeometry(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
    for await (const value of records())
      yield value.kind === "entry"
        ? { ...value, frame: { ...value.frame, sourceWidth: value.frame.sourceWidth + 1 } }
        : value;
  }
  await expect(
    receiver.index.stagePortable(
      { ...metadata, generation: "geometry" },
      wrongGeometry(),
      signal,
      validation(),
    ),
  ).rejects.toThrow("geometry");
  async function* inventedEquality(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
    for await (const value of records())
      yield value.kind === "coverage" && value.coverage.state === "available"
        ? { ...value, coverage: { ...value.coverage, equality: "sampled" } }
        : value;
  }
  await expect(
    receiver.index.stagePortable(
      { ...metadata, generation: "equality" },
      inventedEquality(),
      signal,
      validation(),
    ),
  ).rejects.toThrow("stillness evidence");
  const pendingIdentity = { ...metadata, generation: "pending" };
  await receiver.index.stagePortable(pendingIdentity, records(), signal, validation());
  receiver.reopen();
  await receiver.index.recoverPending("asset", signal);
  expect(receiver.index.portableGenerations({ kind: "asset", assetId: metadata.assetId })).toEqual([
    metadata,
  ]);
  expect(() => receiver.index.page({ identity: pendingIdentity })).toThrow("does not match");
});

test("retained index validation yields to a real cancellation timer before publication", async () => {
  const f = await fixture(undefined, true),
    controller = new AbortController();
  const domain = sourceIndexDomain(
    (selection) => selectSource(f.assets, f.acquisitions, selection),
    f.scenes,
    null,
  );
  const expected = {
    ...f.identity,
    generation: "timer-canceled",
    durationUs: 1000000,
    candidateCount: 0,
    coverageCount: 200,
    sizeBytes: 0,
  };
  async function* records(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
    for (let index = 0; index < 200; index++)
      yield {
        kind: "coverage",
        coverage: {
          ordinal: null,
          state: "unavailable",
          basis: "support",
          source: { startUs: index * 5000, endUs: (index + 1) * 5000 },
        },
      };
  }
  await expect(
    f.index.stagePortable(expected, records(), controller.signal, {
      ...domain,
      retained(identity, signal) {
        setTimeout(() => controller.abort(), 0);
        return domain.retained!(identity, signal);
      },
    }),
  ).rejects.toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(f.index.portableGenerations({ kind: "asset", assetId: f.identity.assetId })).toEqual([]);
});

test("an index cannot retain a plain frame when its recipe requested picture measurements", async () => {
  const f = await fixture();
  Object.assign(f.identity, {
    observationRequest: {
      darkAtOrBelow: 5,
      brightAtOrAbove: 250,
      edgeDarkFraction: 0.98,
      edgeOpaqueFraction: 1,
      regions: [],
    },
  });
  f.index.begin(f.identity);
  await expect(f.append()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
