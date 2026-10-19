import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { SpeakerEvidenceStore } from "./speaker-evidence.js";
import { ResourceReferences } from "./references.js";
import { speakerGenerationResource } from "./speaker-evidence.js";
import { nativeOutput, speakerSource } from "./speaker-evidence.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const home = await mkdtemp("/tmp/speaker-evidence-");
  const path = join(home, "catalog.sqlite");
  const catalog = new Catalog(path);
  cleanups.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const store = new SpeakerEvidenceStore(catalog, () => {});
  const identity = {
    owner: { kind: "asset" as const, id: "a".repeat(64) },
    sourceId: "a".repeat(64),
    generation: "g1",
    policy: "speaker-v1" as const,
  };
  return { path, catalog, store, identity };
}

test("publishes complete anonymous native observations only inside the caller transaction and survives restart", async () => {
  const f = await fixture(),
    raw = nativeOutput();
  const staged = f.store.stage(f.identity, speakerSource, raw);
  expect(() => f.store.metadata(f.identity)).toThrow("not ready");
  f.catalog.transaction(() => staged.publish());
  await staged.close();
  const page = f.store.intervalPage({ identity: f.identity });
  expect(page.intervals).toEqual([
    {
      ordinal: 0,
      slot: 0,
      identity: "unknown",
      sourceRange: {
        startUs: { numerator: 125, denominator: 2 },
        endUs: { numerator: 2000125, denominator: 2 },
      },
    },
    {
      ordinal: 1,
      slot: 1,
      identity: "unknown",
      sourceRange: {
        startUs: { numerator: 1000125, denominator: 2 },
        endUs: { numerator: 4000125, denominator: 2 },
      },
    },
  ]);
  expect(f.store.scorePage({ identity: f.identity, afterFrame: 373 }).scores).toEqual([
    {
      frameIndex: 374,
      sourceRange: {
        startUs: { numerator: 59840125, denominator: 2 },
        endUs: { numerator: 60000125, denominator: 2 },
      },
      scores: [0.25, 0.375, 0.5, 0.625],
      meaning: "uncalibrated",
    },
  ]);
  f.catalog.close();
  const reopened = new Catalog(f.path);
  try {
    const next = new SpeakerEvidenceStore(reopened, () => {});
    expect(next.intervalPage({ identity: f.identity })).toEqual(page);
    expect(next.operands(f.identity)).toEqual(raw);
  } finally {
    reopened.close();
  }
});

test("publishes all below-threshold score cells without inventing intervals, and narrowed pages retain native cells", async () => {
  const f = await fixture(),
    staged = f.store.stage(f.identity, speakerSource, nativeOutput([]));
  f.catalog.transaction(() => staged.publish());
  await staged.close();
  expect(f.store.intervalPage({ identity: f.identity }).intervals).toEqual([]);
  const page = f.store.scorePage({
    identity: f.identity,
    limit: 1,
    range: { startUs: 80000, endUs: 90000 },
  });
  expect(page.scores).toEqual([
    {
      frameIndex: 0,
      sourceRange: {
        startUs: { numerator: 125, denominator: 2 },
        endUs: { numerator: 160125, denominator: 2 },
      },
      scores: [0, 0.125, 0.25, 0.375],
      meaning: "uncalibrated",
    },
  ]);
  expect(page.nextFrame).toBe(0);
  const empty = f.store.scorePage({
    identity: f.identity,
    limit: 1,
    range: { startUs: 200000, endUs: 210000 },
  });
  expect(empty.scores).toEqual([]);
  expect(empty.nextFrame).toBe(0);
});

test("publishes a bounded selected range with its matching score extent", async () => {
  const f = await fixture();
  const source = {
    ...speakerSource,
    observationRange: { startUs: 0, endUs: 10_000_000 },
    pcm: { ...speakerSource.pcm, frameCount: 160_000 },
  };
  const raw = nativeOutput(["0.000 1.000 speaker_0"], speakerSource.engine.modelSha256, 160_000);
  const staged = f.store.stage(f.identity, source, raw);
  f.catalog.transaction(() => staged.publish());
  expect(f.store.metadata(f.identity)).toMatchObject({
    source: { observationRange: source.observationRange, pcm: { frameCount: 160_000 } },
    scoreCount: 125,
    axes: [1, 125, 4],
  });
  expect(f.store.scorePage({ identity: f.identity, afterFrame: 123 }).scores).toHaveLength(1);
});

test("closing an unpublished stage fences its late publication", async () => {
  const f = await fixture(),
    staged = f.store.stage(f.identity, speakerSource, nativeOutput());
  await staged.close();
  expect(() => f.catalog.transaction(() => staged.publish())).toThrow("no longer retained");
  expect(() => f.store.metadata(f.identity)).toThrow("not ready");
});

test("reclamation preserves typed retained generations and drops unretained observations", async () => {
  const f = await fixture(),
    references = new ResourceReferences(f.catalog);
  const retained = f.store.stage(f.identity, speakerSource, nativeOutput());
  f.catalog.transaction(() => {
    retained.publish();
    references.retain("speaker-generation", { kind: "revision", id: "r1" }, [
      speakerGenerationResource(f.identity),
    ]);
  });
  const abandonedIdentity = { ...f.identity, generation: "g2" };
  f.store.stage(abandonedIdentity, speakerSource, nativeOutput([]));
  await f.store.reclaim(f.identity.owner.id, () => false);
  expect(f.store.intervalPage({ identity: f.identity }).intervals[0]?.slot).toBe(0);
  expect(() => f.store.metadata(abandonedIdentity)).toThrow("not ready");
  references.release("speaker-generation", { kind: "revision", id: "r1" });
  await f.store.reclaim(f.identity.owner.id, () => false);
  expect(() => f.store.metadata(f.identity)).toThrow("not ready");
});

test("malformed complete operands refuse before exposing a generation", async () => {
  const f = await fixture();
  const outside = nativeOutput(["0.000 30.001 speaker_0"]);
  expect(() => f.store.stage(f.identity, speakerSource, outside)).toThrow("outside observation");
  expect(f.store.capturedOperands(f.identity)).toEqual(outside);
  const mismatch = nativeOutput();
  const report = JSON.parse(mismatch.report);
  report.nativeProbabilities[374][3] = 0.75;
  expect(() =>
    f.store.stage({ ...f.identity, generation: "g2" }, speakerSource, {
      ...mismatch,
      report: JSON.stringify(report),
    }),
  ).toThrow("retained Float32");
  expect(() => f.store.metadata(f.identity)).toThrow("not ready");
});

test("chronological interval pages retain original native ordinals across simultaneous boundaries", async () => {
  const f = await fixture();
  const raw = nativeOutput([
    "2.000 3.000 speaker_0",
    "1.000 2.000 speaker_1",
    "0.000 2.000 speaker_2",
    "0.000 1.000 speaker_3",
  ]);
  const staged = f.store.stage(f.identity, speakerSource, raw);
  f.catalog.transaction(() => staged.publish());
  const first = f.store.intervalPage({ identity: f.identity, limit: 2 });
  const second = f.store.intervalPage({
    identity: f.identity,
    limit: 2,
    afterSequence: first.nextSequence!,
  });
  await writeFile(
    f.path + ".comparison.json",
    JSON.stringify({ raw, first, second, expectedOrdinals: [2, 3, 1, 0] }),
  );
  expect(first.intervals.map((v) => [v.ordinal, v.slot])).toEqual([
    [2, 2],
    [3, 3],
  ]);
  expect(second.intervals.map((v) => [v.ordinal, v.slot])).toEqual([
    [1, 1],
    [0, 0],
  ]);
  expect(second.nextSequence).toBeNull();
  expect(f.store.operands(f.identity)).toEqual(raw);
});
