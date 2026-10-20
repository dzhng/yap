import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionImporter, AcquisitionStore } from "./acquisitions.js";
import { SourceEvidenceStore } from "./evidence.js";
import { DerivedCache } from "./cache.js";
import { JobQueue, JobDependencyLost } from "./jobs.js";
import { PointerPreparation } from "./pointer-preparation.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(budget: number) {
  const home = await mkdtemp("/tmp/pointer-admission-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const evidence = new SourceEvidenceStore(catalog, (identity) => {
    if (identity.owner.kind !== "acquisition") throw Error("Wrong evidence owner");
    acquisitions.intent(identity.owner.id);
  });
  const importer = new AcquisitionImporter(catalog, acquisitions, assets, evidence, home);
  await importer.recover(new AbortController().signal);
  const cache = new DerivedCache(
    catalog,
    home,
    (owner) => {
      if (owner.kind !== "acquisition") throw Error("Wrong cache owner");
      acquisitions.get(owner.id);
    },
    budget,
  );
  await cache.reconcile();
  let pointers!: PointerPreparation,
    renders = 0;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "acquisition") throw Error("Wrong job owner");
        acquisitions.get(target.id);
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (request) => pointers.execute(request),
  });
  pointers = new PointerPreparation({
    assets,
    acquisitions,
    evidence,
    jobs,
    cache,
    renderer: {
      implementationId: "fixture-exact-history",
      async render({ output }) {
        renders++;
        const body = [
          { version: 1, sourceWidth: 8, sourceHeight: 8, durationUs: 1000, spanCount: 1 },
          {
            spanIndex: 0,
            start: { value: "0", timescale: 1000000 },
            end: { value: "1000", timescale: 1000000 },
            empty: false,
            sampleTime: { value: "0", timescale: 1000000 },
            actualSourceUs: 0,
            width: 8,
            height: 8,
            rgbBase64: Buffer.alloc(192).toString("base64"),
          },
        ]
          .map((row) => JSON.stringify(row) + "\n")
          .join("");
        await writeFile(output, body);
        return {
          file: output,
          version: 1,
          sourceWidth: 8,
          sourceHeight: 8,
          durationUs: 1000,
          records: 1,
          bytes: Buffer.byteLength(body),
        };
      },
    },
  });
  cleanups.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  async function importSource() {
    const id = randomUUID(),
      donor = join(home, id);
    await mkdir(donor);
    await writeFile(join(donor, "capture.journal.jsonl"), id);
    await writeFile(join(donor, "video.mov"), id);
    const prepared = await importer.prepareImport(id, donor);
    const intent = catalog.transaction(() => acquisitions.admitImport(prepared));
    const acquisition = await importer.executeImport(
      intent.acquisitionId,
      id,
      {
        probe: async () => ({
          originUs: 0,
          streams: [
            {
              id: "v",
              kind: "video",
              codec: "fixture",
              decodable: true,
              width: 8,
              height: 8,
              orientedWidth: 8,
              orientedHeight: 8,
              startUs: 0,
              endUs: 1000,
              segments: [{ startUs: 0, endUs: 1000, empty: false }],
            },
          ],
        }),
        exportSource: async (_input, output) => {
          const body = [
            {
              event: "geometry",
              data: {
                epoch: 1,
                hostUs: 0,
                sourceUs: 0,
                geometry: {
                  outputWidth: 8,
                  outputHeight: 8,
                  contentScale: 1,
                  scaleFactor: 1,
                  contentRect: { x: 0, y: 0, width: 8, height: 8 },
                },
              },
            },
            {
              event: "cursorSample",
              data: {
                sourceUs: 0,
                x: 2,
                y: 2,
                globalX: 2,
                globalY: 2,
                buttons: 0,
                eligibility: "inside",
                geometryEpoch: 1,
              },
            },
          ]
            .map((row) => JSON.stringify(row) + "\n")
            .join("");
          await writeFile(output, body);
          return {
            file: output,
            journal: "capture.journal.jsonl",
            header: { sessionID: id },
            cursorSamples: 1,
            firstCursorSourceUs: 0,
            lastCursorSourceUs: 0,
            geometryRecords: 1,
            displaySpaces: 0,
            pauseEvents: 0,
            audioIntervals: 0,
            lastSequence: 3,
            incompleteTail: false,
            finished: true,
            bytes: Buffer.byteLength(body),
          };
        },
      },
      new AbortController().signal,
    );
    const binding = acquisition.bindings[0]!;
    return { assetId: binding.assetId, streamId: binding.streamId, acquisitionId: acquisition.id };
  }
  return { pointers, jobs, cache, importSource, renders: () => renders };
}

test("retained history sizes terminate an impossible aggregate instead of eviction regeneration", async () => {
  const f = await fixture(900);
  const first = await f.importSource(),
    second = await f.importSource();
  const a = f.pointers.request(first);
  await f.jobs.idle();
  expect(f.jobs.job(a.jobId!).state).toBe("ready");
  const b = f.pointers.request(second);
  await f.jobs.idle();
  expect(f.jobs.job(b.jobId!).state).toBe("ready");
  expect(f.renders()).toBe(2);
  // Each file fits by itself; the second publication evicted the first.
  expect(f.cache.bytes).toBeLessThan(900);
  for (let i = 0; i < 3; i++) {
    expect(() => f.pointers.admit([first, second])).toThrowError(
      expect.objectContaining({ code: "LIMIT_EXCEEDED", retryable: true }),
    );
  }
  await f.jobs.idle();
  expect(f.renders()).toBe(2);
  expect(f.jobs.job(a.jobId!).generation).toBe(1);
  expect(f.jobs.job(b.jobId!).generation).toBe(1);
});

test("admitted history stays leased across a producer and cache loss is a dependency event", async () => {
  const f = await fixture(2000);
  const source = await f.importSource();
  const requested = f.pointers.request(source);
  await f.jobs.idle();
  const status = f.pointers.request(source);
  expect(status.state).toBe("ready");
  const cacheId = status.published!.value.cacheId;
  await f.pointers.withReady([source], async () => {
    expect(() => f.cache.remove(cacheId)).toThrowError(
      expect.objectContaining({ code: "CACHE_BUSY" }),
    );
    await f.pointers.withHistory(source, new AbortController().signal, async ({ presentation }) => {
      const record = await presentation.cursor(new AbortController().signal).at(0, 0);
      expect(record.record.actualSourceUs).toBe(0);
    });
  });
  f.cache.remove(cacheId);
  await expect(
    f.pointers.withReady([source], async () => {
      throw Error("Cannot execute without history");
    }),
  ).rejects.toBeInstanceOf(JobDependencyLost);
  await expect(
    f.pointers.withHistory(source, new AbortController().signal, async () => {
      throw Error("Cannot sample missing history");
    }),
  ).rejects.toBeInstanceOf(JobDependencyLost);
  expect(f.jobs.job(requested.jobId!).generation).toBe(1);
  expect(f.renders()).toBe(1);
  expect(f.pointers.admit([source]).state).toBe("waiting");
  await f.jobs.idle();
  expect(f.pointers.admit([source])).toEqual({ state: "ready" });
  expect(f.renders()).toBe(2);
});
