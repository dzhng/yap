import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { SpeakerEvidenceStore } from "./speaker-evidence.js";
import { SourceSpeakerRead } from "./speaker-read.js";
import { nativeOutput, speakerSource } from "./speaker-evidence.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp("/tmp/speaker-read-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const records = new SpeakerEvidenceStore(catalog, () => {});
  const identity = {
    owner: { kind: "asset" as const, assetId: "a".repeat(64) },
    sourceId: "a".repeat(64),
    generation: "g1",
    policy: "speaker-v1" as const,
  };
  const staged = records.stage(identity, speakerSource, nativeOutput());
  catalog.transaction(() => staged.publish());
  return { home, catalog, records, metadata: staged.metadata, identity };
}

test("source query pages advance through empty intersections and retain complete native intervals", async () => {
  const f = await fixture();
  const read = new SourceSpeakerRead(f.records, f.metadata);
  const query = { sourceRange: { startUs: 1500000, endUs: 1750000 }, limit: 1 };
  const first = read.page(query);
  const second = read.page({ ...query, cursor: first.nextCursor! });
  await writeFile(join(f.home, "pages.json"), JSON.stringify({ first, second }));
  expect(first.rows).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  expect(second.rows).toEqual([
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
  expect(second.nextCursor).toBeNull();
  expect(second.coverage).toEqual([
    { sourceRange: speakerSource.observationRange, state: "observed" },
  ]);
});

test("continuations pin generation, native decoder, display query and score view", async () => {
  const f = await fixture();
  const read = new SourceSpeakerRead(f.records, f.metadata);
  const first = read.page({ view: "scores", limit: 1 });
  const next = read.page({ view: "scores", limit: 1, cursor: first.nextCursor! });
  const replacement = f.records.stage(
    { ...f.identity, generation: "g2" },
    f.metadata.source,
    nativeOutput(),
  );
  f.catalog.transaction(() => replacement.publish());
  await writeFile(
    join(f.home, "score-comparison.json"),
    JSON.stringify({ first, next, replacement: replacement.metadata }),
  );
  expect(next.rows).toEqual([
    {
      frameIndex: 1,
      sourceRange: {
        startUs: { numerator: 160125, denominator: 2 },
        endUs: { numerator: 320125, denominator: 2 },
      },
      scores: [0.125, 0.25, 0.375, 0.5],
      meaning: "uncalibrated",
    },
  ]);
  // Another view or display range is another filter set; a republished generation is a stale pin.
  expect(() => read.page({ view: "intervals", cursor: first.nextCursor! })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
  expect(() =>
    read.page({
      view: "scores",
      sourceRange: { startUs: 100000, endUs: 200000 },
      cursor: first.nextCursor!,
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  expect(() =>
    new SourceSpeakerRead(f.records, replacement.metadata).page({
      view: "scores",
      cursor: first.nextCursor!,
    }),
  ).toThrow(expect.objectContaining({ code: "ARTIFACT_CHANGED" }));
  expect(read.page({ view: "scores", limit: 1, cursor: first.nextCursor! })).toEqual(next);
});

test("query support outside the observed window is unavailable rather than measured silence", async () => {
  const f = await fixture();
  const page = new SourceSpeakerRead(f.records, f.metadata).page({
    sourceRange: { startUs: 29000000, endUs: 31000000 },
  });
  await writeFile(
    join(f.home, "unobserved-query.json"),
    JSON.stringify({ metadata: f.metadata, page }),
  );
  expect(page.rows).toEqual([]);
  expect(page.coverage).toEqual([
    { sourceRange: speakerSource.observationRange, state: "observed" },
    {
      sourceRange: { startUs: speakerSource.observationRange.endUs, endUs: 31000000 },
      state: "unavailable",
      reason: "unobserved",
    },
  ]);
});
