import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import { DerivedCache, recordingCacheOwnerCheck } from "./cache.js";
import { VisualObservationCache } from "./visual-cache.js";
import type { VisualSampler } from "./scenes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const request = {
  recordingId: "recording-1",
  source: "/immutable/take/video.mov",
  kept: { startUs: 0, endUs: 10 },
  atSourceUs: [4],
};
const signal = () => new AbortController().signal;
async function fixture(budget = 1024 ** 3) {
  const home = await mkdtemp("/tmp/visual-cache-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => "",
    newId: (() => {
      let id = 0;
      return () => `recording-${++id}`;
    })(),
  });
  store.allocate();
  const cache = new DerivedCache(store, home, recordingCacheOwnerCheck(store), budget);
  await cache.reconcile();
  cleanup.push(async () => {
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  let calls = 0;
  const decode: VisualSampler = async (input) => {
    calls++;
    return {
      sourceWidth: 20,
      sourceHeight: 10,
      samples: input.atSourceUs.map((at) => {
        const actual = input.kept.endUs <= 5 ? 0 : 8;
        return {
          requestedSourceUs: at,
          actualSourceUs: actual,
          distanceUs: Math.abs(actual - at),
          width: 2,
          height: 1,
          rgbBase64: Buffer.alloc(6, actual).toString("base64"),
        };
      }),
    };
  };
  return { home, store, cache, decode, calls: () => calls };
}

test("observation reuse preserves exact native selection bounds across owner restart", async () => {
  const f = await fixture();
  const first = new VisualObservationCache(f.store, f.cache, f.decode);
  const original = await first.sample(request, signal());
  expect(original.samples[0]!.actualSourceUs).toBe(8);
  const reopened = new VisualObservationCache(f.store, f.cache, f.decode);
  expect(await reopened.sample(request, signal())).toEqual(original);
  expect(f.calls()).toBe(1);
  const past = await reopened.sample({ ...request, kept: { startUs: 0, endUs: 5 } }, signal());
  expect(past.samples[0]!.actualSourceUs).toBe(0);
  expect(f.calls()).toBe(2);
});

test("eviction removes lookup metadata and regeneration preserves selected pixels", async () => {
  const f = await fixture();
  const observations = new VisualObservationCache(f.store, f.cache, f.decode);
  const expected = await observations.sample(request, signal());
  const row = f.store.catalog.prepare("SELECT cacheId FROM visual_observation_samples").get() as {
    cacheId: string;
  };
  f.cache.remove(row.cacheId);
  expect(f.store.catalog.prepare("SELECT * FROM visual_observation_samples").all()).toEqual([]);
  expect(await observations.sample(request, signal())).toEqual(expected);
  expect(f.calls()).toBe(2);
});

test("cancellation and invalid native observations never become reusable results", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const canceled = new VisualObservationCache(f.store, f.cache, async (input) => {
    const result = await f.decode(input, signal());
    abort.abort();
    return result;
  });
  await expect(canceled.sample(request, abort.signal)).rejects.toBeDefined();
  const invalid = new VisualObservationCache(f.store, f.cache, async (input) => {
    const result = await f.decode(input, signal());
    result.samples[0]!.rgbBase64 = "bad";
    return result;
  });
  await expect(invalid.sample(request, signal())).rejects.toMatchObject({
    code: "INVALID_EVIDENCE",
  });
  expect(f.store.catalog.prepare("SELECT * FROM visual_observation_samples").all()).toEqual([]);
  expect(f.cache.bytes).toBe(0);
});

test("concurrent misses retain one cache file and every caller receives the native pixels", async () => {
  const f = await fixture();
  const observations = new VisualObservationCache(f.store, f.cache, f.decode);
  const results = await Promise.all([
    observations.sample(request, signal()),
    observations.sample(request, signal()),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]!.samples[0]!.rgbBase64).toBe(Buffer.alloc(6, 8).toString("base64"));
  expect(f.store.catalog.prepare("SELECT * FROM derived_cache").all()).toHaveLength(1);
  expect(await observations.sample(request, signal())).toEqual(results[0]);
  expect(f.calls()).toBe(2);
});

test("different sources never share observations and invalid batches never decode", async () => {
  const f = await fixture();
  const observations = new VisualObservationCache(f.store, f.cache, f.decode);
  await observations.sample(request, signal());
  await observations.sample({ ...request, source: "/another/take/video.mov" }, signal());
  expect(f.calls()).toBe(2);
  for (const times of [[], [4, 4], [4, 3], [10], Array.from({ length: 53 }, (_, i) => i)])
    await expect(
      observations.sample({ ...request, atSourceUs: times }, signal()),
    ).rejects.toMatchObject({ code: "INVALID_RANGE" });
  expect(f.calls()).toBe(2);
});

test("LRU eviction bounds lookup rows as well as raw bytes", async () => {
  const f = await fixture(200);
  const observations = new VisualObservationCache(f.store, f.cache, f.decode);
  for (let i = 0; i < 20; i++)
    await observations.sample({ ...request, source: `/immutable/take-${i}/video.mov` }, signal());
  expect(f.cache.bytes).toBeLessThanOrEqual(200);
  expect(f.store.catalog.prepare("SELECT * FROM visual_observation_samples").all()).toHaveLength(1);
  expect((await observations.sample(request, signal())).samples[0]!.actualSourceUs).toBe(8);
  expect(f.calls()).toBe(21);
});

test("a new database connection reuses persisted observations after cache reconciliation", async () => {
  const f = await fixture();
  const initial = await new VisualObservationCache(f.store, f.cache, f.decode).sample(
    { ...request, atSourceUs: [0, 2, 4] },
    signal(),
  );
  const reopened = new CaptureStore(join(f.home, "library.sqlite"), {
    now: () => "",
    newId: (() => {
      let id = 0;
      return () => `recording-${++id}`;
    })(),
  });
  try {
    const cache = new DerivedCache(reopened, f.home, recordingCacheOwnerCheck(reopened));
    await cache.reconcile();
    const observations = new VisualObservationCache(reopened, cache, async () => {
      throw new Error("Unexpected decode after restart");
    });
    expect(await observations.sample({ ...request, atSourceUs: [2, 4] }, signal())).toEqual({
      ...initial,
      samples: initial.samples.slice(1),
    });
  } finally {
    reopened.close();
  }
});

test("overlapping trail requests reuse source-grid samples and decode only missing requested times", async () => {
  const f = await fixture();
  const decoded: number[][] = [];
  const observations = new VisualObservationCache(f.store, f.cache, async (input, abort) => {
    decoded.push(input.atSourceUs);
    return f.decode(input, abort);
  });
  const canonical = await observations.sample(
    { ...request, atSourceUs: [0, 2, 4, 6, 8] },
    signal(),
  );
  const overlap = await observations.sample({ ...request, atSourceUs: [2, 4, 5, 6] }, signal());
  expect(overlap.samples).toEqual([
    canonical.samples[1],
    canonical.samples[2],
    { ...canonical.samples[2], requestedSourceUs: 5, distanceUs: 3 },
    canonical.samples[3],
  ]);
  const subset = await observations.sample({ ...request, atSourceUs: [4, 5] }, signal());
  expect(subset.samples).toEqual(overlap.samples.slice(1, 3));
  expect(decoded).toEqual([[0, 2, 4, 6, 8], [5]]);
});

test("partial eviction regenerates only lost requested times while surviving samples remain reusable", async () => {
  const f = await fixture();
  const decoded: number[][] = [];
  const observations = new VisualObservationCache(f.store, f.cache, async (input, abort) => {
    decoded.push(input.atSourceUs);
    return f.decode(input, abort);
  });
  const first = await observations.sample({ ...request, atSourceUs: [0, 2, 4] }, signal());
  const second = await observations.sample({ ...request, atSourceUs: [4, 6, 8] }, signal());
  const row = f.store.catalog
    .prepare("SELECT cacheId FROM visual_observation_samples WHERE requestedUs=0")
    .get() as { cacheId: string };
  f.cache.remove(row.cacheId);
  const restored = await observations.sample({ ...request, atSourceUs: [0, 2, 4, 6, 8] }, signal());
  expect(restored.samples).toEqual([...first.samples, ...second.samples.slice(1)]);
  expect(decoded).toEqual([
    [0, 2, 4],
    [6, 8],
    [0, 2, 4],
  ]);
  expect(
    f.store.catalog
      .prepare("SELECT requestedUs FROM visual_observation_samples ORDER BY requestedUs")
      .all(),
  ).toEqual([0, 2, 4, 6, 8].map((requestedUs) => ({ requestedUs })));
});

test("concurrent overlapping misses share first publications and retain the disjoint suffix", async () => {
  const f = await fixture();
  const decoded: number[][] = [];
  const observations = new VisualObservationCache(f.store, f.cache, async (input, abort) => {
    decoded.push(input.atSourceUs);
    return f.decode(input, abort);
  });
  const [left, right] = await Promise.all([
    observations.sample({ ...request, atSourceUs: [0, 2, 4] }, signal()),
    observations.sample({ ...request, atSourceUs: [2, 4, 6] }, signal()),
  ]);
  const union = await observations.sample({ ...request, atSourceUs: [0, 2, 4, 6] }, signal());
  expect(union.samples).toEqual([...left.samples, right.samples.at(-1)]);
  expect(decoded).toEqual([
    [0, 2, 4],
    [2, 4, 6],
  ]);
  expect(
    f.store.catalog
      .prepare("SELECT requestedUs FROM visual_observation_samples ORDER BY requestedUs")
      .all(),
  ).toEqual([0, 2, 4, 6].map((requestedUs) => ({ requestedUs })));
});

test("canceling a partial miss retains earlier samples without publishing the canceled suffix", async () => {
  const f = await fixture();
  const original = new VisualObservationCache(f.store, f.cache, f.decode);
  const before = await original.sample({ ...request, atSourceUs: [0, 2] }, signal());
  const controller = new AbortController();
  const canceled = new VisualObservationCache(f.store, f.cache, async (input, abort) => {
    expect(input.atSourceUs).toEqual([4]);
    const result = await f.decode(input, abort);
    controller.abort();
    return result;
  });
  await expect(
    canceled.sample({ ...request, atSourceUs: [0, 2, 4] }, controller.signal),
  ).rejects.toBeDefined();
  expect(await original.sample({ ...request, atSourceUs: [0, 2] }, signal())).toEqual(before);
  expect(f.calls()).toBe(2);
  const decoded: number[][] = [];
  const retry = new VisualObservationCache(f.store, f.cache, async (input, abort) => {
    decoded.push(input.atSourceUs);
    return f.decode(input, abort);
  });
  expect(
    (await retry.sample({ ...request, atSourceUs: [0, 2, 4] }, signal())).samples.slice(0, 2),
  ).toEqual(before.samples);
  expect(decoded).toEqual([[4]]);
});

test("partial native results with changed source dimensions cannot poison reusable observations", async () => {
  const f = await fixture();
  const original = new VisualObservationCache(f.store, f.cache, f.decode);
  await original.sample({ ...request, atSourceUs: [0, 2] }, signal());
  const inconsistent = new VisualObservationCache(f.store, f.cache, async (input, abort) => ({
    ...(await f.decode(input, abort)),
    sourceWidth: 99,
  }));
  await expect(
    inconsistent.sample({ ...request, atSourceUs: [0, 2, 4] }, signal()),
  ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  expect(
    f.store.catalog
      .prepare("SELECT requestedUs FROM visual_observation_samples ORDER BY requestedUs")
      .all(),
  ).toEqual([{ requestedUs: 0 }, { requestedUs: 2 }]);
  expect((await original.sample({ ...request, atSourceUs: [0, 2, 4] }, signal())).sourceWidth).toBe(
    20,
  );
});

test("partial hits stay usable when publishing missing samples evicts their old batch", async () => {
  const f = await fixture(500);
  const decoded: number[][] = [];
  const observations = new VisualObservationCache(f.store, f.cache, async (input, abort) => {
    decoded.push(input.atSourceUs);
    return f.decode(input, abort);
  });
  const first = await observations.sample({ ...request, atSourceUs: [0, 2, 4] }, signal());
  const combined = await observations.sample({ ...request, atSourceUs: [0, 2, 4, 6, 8] }, signal());
  expect(combined.samples.slice(0, 3)).toEqual(first.samples);
  expect((await observations.sample({ ...request, atSourceUs: [6, 8] }, signal())).samples).toEqual(
    combined.samples.slice(3),
  );
  expect(decoded).toEqual([
    [0, 2, 4],
    [6, 8],
  ]);
  expect(f.cache.bytes).toBeLessThanOrEqual(500);
});

test("same-path visual requests retain independent recording ownership and purge only their own lookup", async () => {
  const f = await fixture();
  const sibling = f.store.allocate().recording.recordingId;
  const observations = new VisualObservationCache(f.store, f.cache, f.decode);
  const expected = await observations.sample(request, signal());
  expect(await observations.sample({ ...request, recordingId: sibling }, signal())).toEqual(
    expected,
  );
  expect(f.calls()).toBe(2);
  await f.cache.purgeOwner({ kind: "recording", id: request.recordingId }, async ({ ids }) => {
    for (const id of ids) {
      if (basename(id) !== id) throw new Error("Fixture refuses a nonlocal cache name");
      await rm(join(f.home, "cache", "derived", `${id}.cache`), { force: true });
    }
  });
  expect(await observations.sample({ ...request, recordingId: sibling }, signal())).toEqual(
    expected,
  );
  expect(f.calls()).toBe(2);
  expect(await observations.sample(request, signal())).toEqual(expected);
  expect(f.calls()).toBe(3);
  await expect(
    observations.sample({ ...request, recordingId: "missing" }, signal()),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(f.calls()).toBe(3);
});
