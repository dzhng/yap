import { recordingSceneOwner } from "./scene-evidence.js";
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import { SourceSceneAnalysis, scenePolicy } from "./scenes.js";
import { SceneEvidenceStore, sceneBoundaries } from "./scene-evidence.js";
const stores: CaptureStore[] = [],
  roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function fixture(durationUs = 20_000_000, sparse = false) {
  const root = mkdtempSync(join(tmpdir(), "scene-evidence-"));
  roots.push(root);
  const path = join(root, "catalog.sqlite");
  let id = 0;
  const providers = { now: () => "", newId: () => String(++id) };
  const store = new CaptureStore(path, providers);
  stores.push(store);
  const recording = store.allocate().recording;
  store.registerSource(recording.id, durationUs);
  const identity = {
    owner: { kind: "recording" as const, id: recording.id },
    sourceId: recording.sourceId,
    generation: "attempt-1",
    policy: scenePolicy.id,
  };
  return {
    store,
    source: { kind: "recording" as const, durationUs },
    path,
    providers,
    identity,
    evidence: new SceneEvidenceStore(store, recordingSceneOwner(store)),
    report: sourceAnalysis(durationUs, sparse),
  };
}
function sourceAnalysis(durationUs: number, sparse = false) {
  const analysis = new SourceSceneAnalysis(
    "fixture-recording",
    "unused",
    durationUs,
    async (request) => ({
      sourceWidth: 1920,
      sourceHeight: 1080,
      samples: request.atSourceUs.map((requestedSourceUs) => {
        const actualSourceUs = sparse
          ? requestedSourceUs >= 50_000_000
            ? 100_000_000
            : 0
          : requestedSourceUs;
        return {
          requestedSourceUs,
          actualSourceUs,
          distanceUs: Math.abs(requestedSourceUs - actualSourceUs),
          width: 1,
          height: 1,
          rgbBase64: Buffer.alloc(3, actualSourceUs === 0 ? 0 : 255).toString("base64"),
        };
      }),
    }),
  );
  return (startUs: number, endUs: number) =>
    analysis.analyze({ startUs, endUs }, new AbortController().signal);
}
test("only contiguous complete evidence becomes readable and survives reopening", async () => {
  const f = fixture(),
    first = await f.report(0, 10_000_000),
    second = await f.report(10_000_000, 20_000_000);
  f.evidence.append(f.identity, f.source, first);
  expect(() => f.evidence.page({ identity: f.identity })).toThrow("complete");
  expect(() => f.evidence.finish(f.identity)).toThrow("coverage");
  f.evidence.append(f.identity, f.source, second);
  const metadata = f.evidence.finish(f.identity);
  f.store.close();
  const reopened = new CaptureStore(f.path, f.providers);
  stores.push(reopened);
  const page = new SceneEvidenceStore(reopened, recordingSceneOwner(reopened)).page({
    identity: f.identity,
    limit: 1,
  });
  expect(page.metadata).toEqual(metadata);
  expect(page.chunks).toEqual([first]);
  expect(page.nextStartUs).toBe(0);
  const final = new SceneEvidenceStore(reopened, recordingSceneOwner(reopened)).page({
    identity: f.identity,
    afterStartUs: page.nextStartUs!,
    limit: 1,
  });
  expect(final.chunks[0]?.coverage).toEqual(second.coverage);
  expect(final.nextStartUs).toBeNull();
  expect(final.chunks[0]?.comparisons[0]?.actualSourceUs).toBe(10_200_000);
});

test("sparse future comparisons are retained once while request coverage remains exact", async () => {
  const f = fixture(120_000_000, true),
    expectedCoverage = [];
  for (let start = 0; start < 120_000_000; start += 10_000_000) {
    const chunk = await f.report(start, start + 10_000_000);
    expectedCoverage.push(...chunk.coverage);
    f.evidence.append(f.identity, f.source, chunk);
  }
  const metadata = f.evidence.finish(f.identity);
  expect(metadata.comparisonCount).toBe(1);
  expect(metadata.boundaryCount).toBe(1);
  const chunks = f.evidence.page({ identity: f.identity }).chunks;
  expect(chunks.flatMap((c) => c.coverage)).toEqual(expectedCoverage);
  expect(chunks.flatMap((c) => c.comparisons)).toEqual([
    {
      previousActualSourceUs: 0,
      actualSourceUs: 100_000_000,
      changedPixelFraction: 1,
      changedCellFraction: 1,
      meanAbsoluteChannelDifference: 1,
      boundary: true,
    },
  ]);
  expect(chunks.flatMap(sceneBoundaries)).toEqual([{ kind: "scene", atSourceUs: 100_000_000 }]);
  expect(chunks.find((c) => c.comparisons.length)!.range.endUs).toBe(50_000_000);
  expect(
    f.evidence.boundaryPage({
      identity: f.identity,
      range: { startUs: 100_000_000, endUs: 100_000_001 },
      limit: 1,
    }).boundaries,
  ).toEqual([{ ordinal: 0, actualSourceUs: 100_000_000, sample: null }]);
  expect(
    f.evidence.boundaryPage({
      identity: f.identity,
      range: { startUs: 40_000_000, endUs: 50_000_001 },
    }).boundaries,
  ).toEqual([]);
});

test("gaps, changed identities and dimensions cannot advance persisted coverage", async () => {
  const f = fixture(),
    first = await f.report(0, 10_000_000),
    second = await f.report(10_000_000, 20_000_000);
  expect(() => f.evidence.append(f.identity, f.source, second)).toThrow("contiguous");
  expect(() => f.evidence.append({ ...f.identity, sourceId: "wrong" }, f.source, first)).toThrow(
    "identity",
  );
  expect(() => f.evidence.append({ ...f.identity, policy: "wrong" }, f.source, first)).toThrow(
    "identity",
  );
  f.evidence.append(f.identity, f.source, first);
  expect(() => f.evidence.append(f.identity, f.source, first)).toThrow("contiguous");
  expect(() => f.evidence.append(f.identity, f.source, { ...second, sourceWidth: 1280 })).toThrow(
    "dimensions",
  );
  expect(() =>
    f.evidence.append(f.identity, f.source, {
      ...second,
      comparisons: [{ ...first.comparisons[0]! }],
    }),
  ).toThrow("backwards");
  f.evidence.append(f.identity, f.source, second);
  f.evidence.finish(f.identity);
  expect(() => f.evidence.append(f.identity, f.source, second)).toThrow("contiguous");
  const retry = { ...f.identity, generation: "retry" };
  f.evidence.append(retry, f.source, first);
  expect(() => f.evidence.page({ identity: retry })).toThrow("complete");
  expect(() => f.evidence.page({ identity: { ...f.identity, policy: "other" } })).toThrow(
    "complete",
  );
  await f.evidence.reclaim(f.identity.owner, (g) => g === f.identity.generation);
  expect(() => f.evidence.finish(retry)).toThrow("coverage");
  expect(f.evidence.page({ identity: f.identity }).chunks[0]).toEqual(first);
  f.evidence.append(retry, f.source, first); // Removed generations leave no orphan chunks.
  await f.evidence.remove(retry);
});

test("a thirty-minute scan pages exact ranges and cleanup hides evidence before yielding", async () => {
  const duration = 1_800_000_000,
    f = fixture(duration);
  for (let start = 0; start < duration; start += 10_000_000)
    f.evidence.append(f.identity, f.source, await f.report(start, start + 10_000_000));
  f.evidence.finish(f.identity);
  const first = f.evidence.page({ identity: f.identity });
  expect(first.chunks.map((c) => c.range.startUs)).toEqual(
    Array.from({ length: 100 }, (_, i) => i * 10_000_000),
  );
  expect(first.nextStartUs).toBe(990_000_000);
  const second = f.evidence.page({ identity: f.identity, afterStartUs: first.nextStartUs! });
  expect(second.chunks.map((c) => c.range.startUs)).toEqual(
    Array.from({ length: 80 }, (_, i) => (i + 100) * 10_000_000),
  );
  expect(second.nextStartUs).toBeNull();
  expect(() => f.evidence.page({ identity: f.identity, limit: 101 })).toThrow("limit");
  const removing = f.evidence.remove(f.identity);
  expect(() => f.evidence.page({ identity: f.identity })).toThrow("complete");
  expect(() => f.evidence.finish(f.identity)).toThrow("coverage");
  await removing;
  f.evidence.append(f.identity, f.source, await sourceAnalysis(duration)(0, 10_000_000));
});

test("restart leaves partial attempts unreadable and separates source generations", async () => {
  const f = fixture(10_000_000),
    chunk = await f.report(0, 10_000_000);
  f.evidence.append(f.identity, f.source, chunk);
  f.store.close();
  const reopened = new CaptureStore(f.path, f.providers);
  stores.push(reopened);
  const evidence = new SceneEvidenceStore(reopened, recordingSceneOwner(reopened));
  expect(() => evidence.page({ identity: f.identity })).toThrow("complete");
  evidence.finish(f.identity);
  const recording = reopened.allocate().recording;
  reopened.registerSource(recording.id, 10_000_000);
  const sourceIdentity = {
    ...f.identity,
    owner: { kind: "recording" as const, id: recording.id },
    sourceId: recording.sourceId,
  };
  evidence.append(sourceIdentity, f.source, chunk);
  evidence.finish(sourceIdentity);
  await evidence.remove(f.identity);
  expect(evidence.page({ identity: sourceIdentity }).chunks).toEqual([chunk]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    evidence.reclaim({ kind: "recording", id: recording.id }, () => false, controller.signal),
  ).rejects.toThrow();
  expect(evidence.page({ identity: sourceIdentity }).chunks).toEqual([chunk]);
});
