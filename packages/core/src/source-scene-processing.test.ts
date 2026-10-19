import { fromTime, compare, type TimeValue } from "@yap/composition";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { ResourceReferences } from "./references.js";
import { JobQueue } from "./jobs.js";
import { SceneProcessing } from "./scene-processing.js";
import { SceneEvidenceStore, assetSceneOwner, sceneGenerationResource } from "./scene-evidence.js";
import type { SourceVisualSampler } from "./source-scenes.js";
import type { SourceSceneChunk } from "./source-scene-chunks.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(durationUs: TimeValue = 1000000) {
  const home = await mkdtemp("/tmp/source-scene-processing-");
  const path = join(home, "catalog.sqlite");
  let catalog = new Catalog(path),
    assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const original = join(home, "external.mov");
  await writeFile(original, "two video streams");
  const asset = await assets.import(original, { kind: "import" }, async () => ({
    originUs: -250000,
    streams: ["v1", "v2", "a1"].map((id) => ({
      id,
      kind: id === "a1" ? "audio" : "video",
      codec: "fixture",
      decodable: true,
      startUs: 0,
      endUs: durationUs,
      segments: [{ startUs: 0, endUs: durationUs, empty: false }],
      width: 64,
      height: 48,
    })),
  }));
  const requests: Parameters<SourceVisualSampler>[0][] = [];
  const control = {
    failAt: 0,
    hold: false,
    deleting: false,
    implementationId: "presentation-native-v1",
    release: () => {},
  };
  const sample: SourceVisualSampler = async (request) => {
    requests.push(request);
    if (control.hold)
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
    if (control.failAt === requests.length) throw new Error("sampler failed");
    return {
      assetId: asset.id,
      streamId: request.asset.streamId,
      originUs: -250000,
      sourceWidth: 64,
      sourceHeight: 48,
      readerOpens: 1,
      decodedSamples: request.atSourceUs.length,
      samples: request.atSourceUs.map((at, i) => {
        if (
          !request.available.some(
            (r) =>
              compare(fromTime(r.startUs), fromTime(at)) <= 0 &&
              compare(fromTime(at), fromTime(r.endUs)) < 0,
          )
        )
          return {
            requestedSourceUs: at,
            status: "unavailable",
            reason: "outside_support",
            continuousFromPrevious: false,
          };
        const prior = request.atSourceUs[i - 1];
        return {
          requestedSourceUs: at,
          status: "available",
          actualSourceUs: at,
          sample: {
            value: String(at - 250000),
            timescale: 1000000,
            endValue: String(at - 250000 + 1),
            endTimescale: 1000000,
          },
          width: 1,
          height: 1,
          rgbBase64: Buffer.alloc(3, Math.floor(at / 200000) % 2 ? 255 : 0).toString("base64"),
          continuousFromPrevious:
            prior !== undefined &&
            request.available.some(
              (r) =>
                compare(fromTime(r.startUs), fromTime(prior)) <= 0 &&
                compare(fromTime(r.endUs), fromTime(at)) > 0,
            ),
        };
      }),
    };
  };
  let evidence: SceneEvidenceStore, jobs: JobQueue, processing: SceneProcessing;
  function start() {
    evidence = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
    jobs = new JobQueue({
      store: catalog,
      providers: { newId: randomUUID },
      targets: {
        pin(target) {
          if (target.kind !== "asset") throw new Error("expected asset");
          assets.get(target.id);
          return target;
        },
        isAvailable: () => !control.deleting,
        isDeleting: () => control.deleting,
        isCapturing: () => false,
      },
      execute: (execution) => processing.execute(execution),
    });
    processing = new SceneProcessing({
      jobs,
      evidence,
      asset: {
        assets,
        acquisitions,
        sample,
        get implementationId() {
          return control.implementationId;
        },
      },
    });
  }
  start();
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    control.release();
    await jobs.close();
    catalog.close();
    disposed = true;
    await rm(home, { recursive: true, force: true });
  };
  cleanup.push(dispose);
  return {
    home,
    dispose,
    asset,
    selection: { assetId: asset.id, streamId: "v1" },
    requests,
    control,
    get catalog() {
      return catalog;
    },
    get assets() {
      return assets;
    },
    get acquisitions() {
      return acquisitions;
    },
    get evidence() {
      return evidence;
    },
    get jobs() {
      return jobs;
    },
    get processing() {
      return processing;
    },
    async reopen() {
      await jobs.close();
      catalog.close();
      catalog = new Catalog(path);
      assets = new AssetStore(catalog, home);
      acquisitions = new AcquisitionStore(catalog);
      start();
    },
    context(id: string, available: { startUs: number; endUs: number }[]) {
      catalog.catalog
        .prepare("INSERT INTO acquisitions VALUES(?,?,?,?)")
        .run(
          id,
          id,
          JSON.stringify({ kind: "import", path: "fixture", files: {} }),
          JSON.stringify({ id, bindings: [{ assetId: asset.id, streamId: "v1", available }] }),
        );
      return { assetId: asset.id, streamId: "v1", acquisitionId: id };
    },
  };
}
test("selected scene jobs retain exact source identity and survive restart without resampling", async () => {
  const f = await fixture();
  expect(f.processing.sourceStatus(f.selection).state).toBe("not_requested");
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const status = f.processing.sourceStatus(f.selection),
    metadata = status.published!.evidence;
  expect(f.assets.references(f.asset.id)).toEqual([{ kind: "job", id: status.jobId }]);
  expect(f.requests[0]!.asset).toEqual({
    assetId: f.asset.id,
    streamId: "v1",
    path: f.assets.path(f.asset.id),
    originUs: -250000,
  });
  expect(
    f.evidence.boundaryPage({ identity: metadata }).boundaries.map((b) => b.actualSourceUs),
  ).toEqual([200000, 400000, 600000, 800000]);
  await f.reopen();
  expect(f.processing.publishedSource(f.selection)).toEqual(status);
  expect(f.requests).toHaveLength(1);
  expect(f.evidence.sourcePage({ identity: metadata }).chunks[0]!.coverage[0]).toMatchObject({
    sample: { value: "-250000" },
  });
  expect(
    f.catalog.catalog.prepare("SELECT name FROM sqlite_master WHERE name='recordings'").all(),
  ).toEqual([]);
  expect(() => f.processing.prepareSource({ ...f.selection, streamId: "a1" })).toThrow(
    "video stream",
  );
});
test("acquisition support selects independent work, empty support stays unavailable, and admission references are atomic", async () => {
  const f = await fixture();
  const selected = f.context("masked", [
    { startUs: 200000, endUs: 400000 },
    { startUs: 600000, endUs: 1000000 },
  ]);
  const empty = f.context("empty", []);
  expect(f.processing.publishedSource(empty)).toMatchObject({
    state: "unavailable",
    reason: "no_video",
    jobId: null,
  });
  const retain = vi.spyOn(f.acquisitions, "retain").mockImplementationOnce(() => {
    throw new Error("reference refused");
  });
  expect(() => f.processing.prepareSource(selected)).toThrow("reference refused");
  expect(f.assets.references(f.asset.id)).toEqual([]);
  expect(f.catalog.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
  retain.mockRestore();
  f.processing.prepareSource(selected);
  await expect.poll(() => f.processing.sourceStatus(selected).state).toBe("ready");
  const status = f.processing.sourceStatus(selected);
  expect(f.acquisitions.references("masked")).toEqual([{ kind: "job", id: status.jobId }]);
  expect(f.requests[0]!.available).toEqual([
    { startUs: 200000, endUs: 400000 },
    { startUs: 600000, endUs: 1000000 },
  ]);
  expect(
    f.evidence
      .boundaryPage({ identity: status.published!.evidence })
      .boundaries.map((b) => b.actualSourceUs),
  ).toEqual([800000]);
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  expect(f.processing.sourceStatus(f.selection).jobId).not.toBe(status.jobId);
});
test("partial failures are reclaimed, ordinary reads never retry, explicit retry publishes a new generation", async () => {
  const f = await fixture(12000000);
  f.control.failAt = 2;
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("failed");
  const failed = f.processing.sourceStatus(f.selection),
    old = f.jobs.job(failed.jobId!).attemptId;
  expect(f.catalog.catalog.prepare("SELECT * FROM scene_evidence_chunks").all()).toEqual([]);
  f.processing.publishedSource(f.selection);
  expect(f.requests).toHaveLength(2);
  f.control.failAt = 0;
  f.processing.retrySource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  expect(f.processing.sourceStatus(f.selection).published!.evidence.generation).not.toBe(old);
  expect(f.requests.map((r) => r.atSourceUs.length)).toEqual([51, 11, 51, 11]);
});
test("deletion waits for retained worker lifetime and canceled late results cannot publish", async () => {
  const f = await fixture();
  f.control.hold = true;
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.requests.length).toBe(1);
  const jobId = f.processing.sourceStatus(f.selection).jobId!;
  f.control.deleting = true;
  let settled = false;
  const drain = f.jobs.drainOwner({ kind: "asset", id: f.asset.id }).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(f.assets.references(f.asset.id)).toEqual([{ kind: "job", id: jobId }]);
  f.control.release();
  await drain;
  expect(f.jobs.job(jobId).state).toBe("canceled");
  expect(f.processing.sourceStatus(f.selection).published).toBeNull();
  expect(f.catalog.catalog.prepare("SELECT * FROM scene_evidence_generations").all()).toEqual([]);
  f.control.deleting = false;
  f.control.hold = false;
  f.processing.publishedSource(f.selection);
  expect(f.requests).toHaveLength(1);
  expect(() => f.processing.retrySource(f.selection)).toThrow("cannot be retried");
});
test("ordinary cancellation remains explicit and retry starts fresh work", async () => {
  const f = await fixture();
  f.control.hold = true;
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.requests.length).toBe(1);
  const id = f.processing.sourceStatus(f.selection).jobId!;
  const drain = f.jobs.drainJob(id);
  f.control.release();
  await drain;
  f.processing.publishedSource(f.selection);
  expect(f.requests).toHaveLength(1);
  f.control.hold = false;
  f.processing.retrySource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  expect(f.requests).toHaveLength(2);
});
test("sampler execution identity separates work and cleanup preserves all published streams", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const first = f.processing.sourceStatus(f.selection);
  f.control.implementationId = "presentation-native-v2";
  expect(f.processing.sourceStatus(f.selection).state).toBe("not_requested");
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const second = f.processing.sourceStatus(f.selection);
  expect(second.jobId).not.toBe(first.jobId);
  const other = { ...f.selection, streamId: "v2" };
  f.processing.prepareSource(other);
  await expect.poll(() => f.processing.sourceStatus(other).state).toBe("ready");
  const metadata = first.published!.evidence;
  const chunk = f.evidence.sourcePage({ identity: metadata }).chunks[0]!;
  const abandoned = { ...metadata, generation: "abandoned-attempt" };
  f.evidence.append(abandoned, metadata.source, chunk);
  await f.processing.cleanup(new AbortController().signal);
  expect(() => f.evidence.sourcePage({ identity: abandoned })).toThrow("not complete");
  const generations: string[] = [];
  await f.evidence.reclaim(metadata.owner, (generation) => {
    generations.push(generation);
    return true;
  });
  expect(generations.sort()).toEqual(
    [
      metadata.generation,
      second.published!.evidence.generation,
      f.processing.sourceStatus(other).published!.evidence.generation,
    ].sort(),
  );
  expect(f.evidence.sourcePage({ identity: first.published!.evidence }).chunks).toHaveLength(1);
  expect(f.evidence.sourcePage({ identity: second.published!.evidence }).chunks).toHaveLength(1);
  expect(f.requests).toHaveLength(3);
});

test("portable scene publication restores real selectors and survives restart without sampling", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  donor.processing.prepareSource(donor.selection);
  await expect.poll(() => donor.processing.sourceStatus(donor.selection).state).toBe("ready");
  const original = donor.processing.sourceStatus(donor.selection).published!.evidence;
  const page = donor.evidence.sourcePage({ identity: original });
  expect(page.nextStartUs).toBeNull();
  async function* chunks() {
    yield* page.chunks;
  }
  const stage = await receiver.evidence.stagePortable(
    original,
    chunks(),
    new AbortController().signal,
  );
  expect(() => receiver.evidence.sourcePage({ identity: original })).toThrow(/not complete/);
  expect(receiver.processing.sourceStatus(receiver.selection).state).toBe("not_requested");
  const publication = donor.processing.portablePublication(original)!;
  receiver.catalog.transaction(() => {
    stage.publish();
    receiver.processing.adoptPublication(original, publication);
  });
  await stage.close();
  expect(receiver.processing.publishedSource(receiver.selection)).toMatchObject({
    state: "ready",
    jobId: null,
    published: { evidence: original },
  });
  expect(receiver.evidence.sourcePage({ identity: original })).toEqual(page);
  expect(receiver.requests).toEqual([]);
  donor.control.implementationId = "historical-producer-v2";
  donor.processing.prepareSource(donor.selection);
  await expect.poll(() => donor.processing.sourceStatus(donor.selection).state).toBe("ready");
  const historical = donor.processing.sourceStatus(donor.selection).published!.evidence;
  const historicalPage = donor.evidence.sourcePage({ identity: historical });
  async function* historicalChunks() {
    yield* historicalPage.chunks;
  }
  const historicalStage = await receiver.evidence.stagePortable(
    historical,
    historicalChunks(),
    new AbortController().signal,
  );
  receiver.catalog.transaction(() => {
    historicalStage.publish();
    receiver.processing.adoptPublication(
      historical,
      donor.processing.portablePublication(historical)!,
    );
  });
  await historicalStage.close();
  await receiver.reopen();
  await receiver.processing.cleanup(new AbortController().signal);
  expect(receiver.processing.publishedSource(receiver.selection)).toMatchObject({
    state: "ready",
    jobId: null,
    published: { evidence: original },
  });
  expect(receiver.evidence.sourcePage({ identity: original })).toEqual(page);
  expect(receiver.evidence.sourcePage({ identity: historical })).toEqual(historicalPage);
  receiver.control.implementationId = "historical-producer-v2";
  expect(receiver.processing.publishedSource(receiver.selection).published!.evidence).toEqual(
    historical,
  );
  expect(receiver.requests).toEqual([]);
});

test("portable scene admission refuses semantic changes even when the JSON inventory hash matches", async () => {
  const donor = await fixture(24_000_000),
    receiver = await fixture(24_000_000);
  donor.processing.prepareSource(donor.selection);
  await donor.jobs.idle();
  const metadata = donor.processing.sourceStatus(donor.selection).published!.evidence,
    original = donor.evidence.sourcePage({ identity: metadata }).chunks;
  expect(original.map((chunk) => chunk.range)).toEqual([
    { startUs: 0, endUs: 10_000_000 },
    { startUs: 10_000_000, endUs: 20_000_000 },
    { startUs: 20_000_000, endUs: 24_000_000 },
  ]);
  for (const mutate of [
    (chunk: SourceSceneChunk) => {
      chunk.coverage[1]!.requestedSourceUs++;
    },
    (chunk: SourceSceneChunk) => {
      const point = chunk.coverage[1]!;
      if (point.status !== "available") throw new Error("available fixture point required");
      point.actualSourceUs++;
    },
    (chunk: SourceSceneChunk) => {
      const point = chunk.coverage[2]!;
      if (point.status !== "available") throw new Error("available fixture point required");
      point.sample = { ...point.sample, value: "-250000", endValue: "-249999" };
      point.actualSourceUs = 0;
    },
    (chunk: SourceSceneChunk) => {
      chunk.comparisons[0]!.current = chunk.comparisons[0]!.previous;
    },
  ]) {
    const rows = structuredClone(original);
    mutate(rows[0]!);
    const bytes = Buffer.from(JSON.stringify(rows)),
      descriptor = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    await writeFile(join(receiver.home, "scene-member.json"), bytes);
    const retained = await (
      await import("node:fs/promises")
    ).readFile(join(receiver.home, "scene-member.json"));
    expect(retained.length).toBe(descriptor.bytes);
    expect(createHash("sha256").update(retained).digest("hex")).toBe(descriptor.sha256);
    async function* chunks() {
      yield* JSON.parse(retained.toString()) as SourceSceneChunk[];
    }
    await expect(
      receiver.evidence.stagePortable(metadata, chunks(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
    expect(receiver.evidence.portableGenerations(receiver.asset.id)).toEqual([]);
  }
  async function* chunks() {
    yield* original;
  }
  const stage = await receiver.evidence.stagePortable(
    metadata,
    chunks(),
    new AbortController().signal,
  );
  receiver.catalog.transaction(() => stage.publish());
  await stage.close();
  await donor.dispose();
  await receiver.reopen();
  expect(receiver.evidence.sourcePage({ identity: metadata }).chunks).toEqual(original);
  expect(receiver.requests).toEqual([]);
});

test("portable scene chunks must continue their predecessor and cover the complete selected source", async () => {
  const donor = await fixture(24_000_000),
    receiver = await fixture(24_000_000);
  donor.processing.prepareSource(donor.selection);
  await donor.jobs.idle();
  const metadata = donor.processing.sourceStatus(donor.selection).published!.evidence,
    original = donor.evidence.sourcePage({ identity: metadata }).chunks,
    repeated = structuredClone(original);
  repeated[1]!.comparisons.unshift(repeated[0]!.comparisons.at(-1)!);
  for (const rows of [repeated, [original[0]!, original[2]!], original.slice(0, 2)]) {
    async function* chunks() {
      yield* rows;
    }
    const inventory = {
      ...metadata,
      chunkCount: rows.length,
      comparisonCount: rows.reduce((count, chunk) => count + chunk.comparisons.length, 0),
      boundaryCount: rows.reduce(
        (count, chunk) => count + chunk.comparisons.filter((pair) => pair.boundary).length,
        0,
      ),
    };
    await expect(
      receiver.evidence.stagePortable(inventory, chunks(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
    expect(receiver.evidence.portableGenerations(receiver.asset.id)).toEqual([]);
  }
  async function* chunks() {
    yield* original;
  }
  await expect(
    receiver.evidence.stagePortable(
      { ...metadata, policy: "future-scene" },
      chunks(),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ name: "ZodError" });
  await expect(
    receiver.evidence.stagePortable(
      { ...metadata, source: { ...metadata.source, streamId: "v2" } },
      chunks(),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  const stage = await receiver.evidence.stagePortable(
    metadata,
    chunks(),
    new AbortController().signal,
  );
  receiver.catalog.transaction(() => stage.publish());
  await stage.close();
  expect(receiver.evidence.sourcePage({ identity: metadata }).chunks).toEqual(original);
});

test("portable scene cancellation and rollback clean pending rows while retained references protect completed rows", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  donor.processing.prepareSource(donor.selection);
  await expect.poll(() => donor.processing.sourceStatus(donor.selection).state).toBe("ready");
  const original = donor.processing.sourceStatus(donor.selection).published!.evidence;
  const page = donor.evidence.sourcePage({ identity: original });
  const orphanHome = await mkdtemp("/tmp/portable-orphan-scenes-");
  const orphanCatalog = new Catalog(join(orphanHome, "catalog.sqlite"));
  cleanup.push(async () => {
    orphanCatalog.close();
    await rm(orphanHome, { recursive: true, force: true });
  });
  const orphan = new SceneEvidenceStore(orphanCatalog, () => {
    throw new Error("Asset is unpublished");
  });
  async function* orphanChunks() {
    yield* page.chunks;
  }
  await orphan.stagePortable(original, orphanChunks(), new AbortController().signal);
  await orphan.recoverPending("asset", new AbortController().signal);
  expect(orphan.portableGenerations(donor.asset.id)).toEqual([]);
  const recovered = await orphan.stagePortable(
    original,
    orphanChunks(),
    new AbortController().signal,
  );
  await recovered.close();
  const controller = new AbortController();
  async function* interrupted() {
    yield* page.chunks;
  }
  setImmediate(() => controller.abort(new Error("canceled scene adoption")));
  await expect(
    receiver.evidence.stagePortable(original, interrupted(), controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(receiver.evidence.portableGenerations(receiver.asset.id)).toEqual([]);
  async function* chunks() {
    yield* page.chunks;
  }
  const stage = await receiver.evidence.stagePortable(
    original,
    chunks(),
    new AbortController().signal,
  );
  expect(() =>
    receiver.catalog.transaction(() => {
      stage.publish();
      throw new Error("project rollback");
    }),
  ).toThrow("project rollback");
  await stage.close();
  expect(receiver.evidence.portableGenerations(receiver.asset.id)).toEqual([]);
  const retry = await receiver.evidence.stagePortable(
    original,
    chunks(),
    new AbortController().signal,
  );
  const references = new ResourceReferences(receiver.catalog),
    owner = { kind: "export" as const, id: "pinned-export" };
  receiver.catalog.transaction(() => {
    retry.publish();
    references.retain("scene-generation", owner, [sceneGenerationResource(original)]);
  });
  await retry.close();
  await receiver.processing.cleanup(new AbortController().signal);
  expect(receiver.evidence.sourcePage({ identity: original })).toEqual(page);
  references.release("scene-generation", owner);
  await receiver.processing.cleanup(new AbortController().signal);
  expect(receiver.evidence.portableGenerations(receiver.asset.id)).toEqual([]);
});

test("scene query completion does not replace the retained fractional physical duration", async () => {
  const durationUs = { numerator: 400001, denominator: 2 };
  const f = await fixture(durationUs);
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const status = f.processing.sourceStatus(f.selection),
    metadata = status.published!.evidence;
  expect(metadata.source.durationUs).toEqual(durationUs);
  expect(f.requests[0]!.atSourceUs).toEqual([0, 200000]);
  expect(f.evidence.sourcePage({ identity: metadata }).chunks[0]).toMatchObject({
    durationUs,
    range: { startUs: 0, endUs: 200001 },
  });
  await f.reopen();
  expect(f.processing.publishedSource(f.selection)).toEqual(status);
  expect(f.requests).toHaveLength(1);
});

test("a thirty-minute selected-source scan retains contiguous bounded chunks", async () => {
  const durationUs = 1_800_000_000;
  const f = await fixture(durationUs);
  f.processing.prepareSource(f.selection);
  await f.jobs.idle();
  const status = f.processing.sourceStatus(f.selection);
  expect(status.state).toBe("ready");
  const metadata = status.published!.evidence;
  let afterStartUs: number | undefined,
    total = 0,
    lastEnd = 0;
  for (;;) {
    const page = f.evidence.sourcePage({
      identity: metadata,
      limit: 3,
      ...(afterStartUs === undefined ? {} : { afterStartUs }),
    });
    expect(page.chunks.length).toBeLessThanOrEqual(3);
    for (const chunk of page.chunks) {
      expect(chunk.range.startUs).toBe(lastEnd);
      lastEnd = chunk.range.endUs;
      total++;
    }
    if (page.nextStartUs === null) break;
    afterStartUs = page.nextStartUs;
  }
  expect(total).toBe(180);
  expect(lastEnd).toBe(durationUs);
  expect(f.requests).toHaveLength(180);
  expect(f.requests.every((r) => r.atSourceUs.length <= 52)).toBe(true);
});
