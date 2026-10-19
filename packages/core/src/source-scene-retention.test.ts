import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { selectSource } from "./source-selection.js";
import {
  SceneEvidenceStore,
  assetSceneOwner,
  type SceneEvidenceIdentity,
} from "./scene-evidence.js";
import {
  SelectedSourceSceneAnalysis,
  sourceScenePolicy,
  type SourceVisualPoint,
} from "./source-scenes.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(durationUs = 1000000, originUs = 0) {
  const home = await mkdtemp("/tmp/source-scene-retention-");
  const path = join(home, "catalog.sqlite");
  let catalog = new Catalog(path);
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  let assets = new AssetStore(catalog, home);
  await assets.recover();
  let acquisitions = new AcquisitionStore(catalog);
  const file = join(home, "video.mov");
  await writeFile(file, "retained-scene-source");
  const asset = await assets.import(file, { kind: "import" }, async () => ({
    originUs,
    streams: [
      {
        id: "v1",
        kind: "video",
        codec: "fixture",
        decodable: true,
        startUs: 0,
        endUs: durationUs,
        segments: [{ startUs: 0, endUs: durationUs, empty: false }],
        width: 64,
        height: 48,
        orientedWidth: 64,
        orientedHeight: 48,
      },
    ],
  }));
  const selected = selectSource(assets, acquisitions, { assetId: asset.id, streamId: "v1" });
  const source = {
    kind: "asset" as const,
    streamId: "v1",
    originUs,
    durationUs,
    supportDigest: selected.supportDigest,
  };
  const identity: SceneEvidenceIdentity = {
    owner: { kind: "asset", id: asset.id },
    sourceId: asset.id,
    generation: "attempt",
    policy: sourceScenePolicy,
  };
  let evidence = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
  return {
    source,
    identity,
    get catalog() {
      return catalog;
    },
    get evidence() {
      return evidence;
    },
    reopen() {
      catalog.close();
      catalog = new Catalog(path);
      assets = new AssetStore(catalog, home);
      acquisitions = new AcquisitionStore(catalog);
      evidence = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
    },
    analysis(point?: (at: number, index: number) => SourceVisualPoint) {
      return new SelectedSourceSceneAnalysis(
        {
          asset: { assetId: asset.id, streamId: "v1", path: file, originUs },
          available: selected.track.available,
        },
        durationUs,
        async (request) => ({
          assetId: asset.id,
          streamId: "v1",
          originUs,
          sourceWidth: 64,
          sourceHeight: 48,
          readerOpens: 1,
          decodedSamples: request.atSourceUs.length,
          samples: request.atSourceUs.map(
            point ??
              ((at, i) => ({
                requestedSourceUs: at,
                status: "available",
                actualSourceUs: at,
                sample: {
                  value: String(at + originUs),
                  timescale: 1000000,
                  endValue: String(at + originUs + 1),
                  endTimescale: 1000000,
                },
                width: 1,
                height: 1,
                rgbBase64: Buffer.alloc(3, Math.floor(at / 200000) % 2 ? 255 : 0).toString(
                  "base64",
                ),
                continuousFromPrevious: i > 0,
              })),
          ),
        }),
      );
    },
  };
}
const signal = () => new AbortController().signal;
test("asset gaps and exact sample clocks survive chunk paging and reopening", async () => {
  const f = await fixture(1000000, -250000);
  const analysis = f.analysis((at, index) =>
    at === 200000
      ? {
          requestedSourceUs: at,
          status: "unavailable",
          reason: "empty_edit",
          continuousFromPrevious: false,
        }
      : {
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
          rgbBase64: Buffer.alloc(3, at >= 600000 ? 255 : 0).toString("base64"),
          continuousFromPrevious: index > 0 && at !== 400000,
        },
  );
  const first = await analysis.analyze({ startUs: 0, endUs: 400000 }, signal());
  f.evidence.append(f.identity, f.source, first);
  expect(() => f.evidence.boundaryPage({ identity: f.identity })).toThrow("complete");
  const tail = await analysis.analyze({ startUs: 400000, endUs: 1000000 }, signal());
  f.evidence.append(f.identity, f.source, tail);
  const metadata = f.evidence.finish(f.identity);
  expect(metadata).toMatchObject({ boundaryCount: 1, comparisonCount: 3, source: f.source });
  f.reopen();
  const page = f.evidence.sourcePage({ identity: f.identity, limit: 1 });
  expect(page.chunks).toEqual([first]);
  expect(
    f.evidence.sourcePage({ identity: f.identity, afterStartUs: page.nextStartUs!, limit: 1 })
      .chunks,
  ).toEqual([tail]);
  expect(f.evidence.boundaryPage({ identity: f.identity }).boundaries).toEqual([
    {
      ordinal: 0,
      actualSourceUs: 600000,
      sample: { ...tail.comparisons[0]!.current, originUs: -250000 },
    },
  ]);
  const window = f.evidence.sourceWindowPage({
    identity: f.identity,
    range: { startUs: 600001, endUs: 800000 },
    limit: 1,
  });
  expect(window.chunks).toEqual([tail]);
  expect(window.chunks[0]!.coverage[0]).toMatchObject({
    requestedSourceUs: 400000,
    stillnessRunStartUs: 400000,
  });
  expect(() => f.evidence.page({ identity: f.identity })).toThrow("recording source");
});

test("boundary seeks filter exact clocks and continue through rounded-key collisions", async () => {
  const f = await fixture(1003);
  const analysis = f.analysis((at, index) => {
    const value = at < 1000 ? 0 : at < 1001 ? 9996 : 10004;
    const endValue = at < 1000 ? 9996 : at < 1001 ? 10004 : 10030;
    return {
      requestedSourceUs: at,
      status: "available",
      actualSourceUs: Math.round(value / 10),
      sample: {
        value: String(value),
        timescale: 10000000,
        endValue: String(endValue),
        endTimescale: 10000000,
      },
      width: 1,
      height: 1,
      rgbBase64: Buffer.alloc(3, at === 1000 ? 255 : 0).toString("base64"),
      continuousFromPrevious: index > 0,
    };
  });
  for (const range of [
    { startUs: 0, endUs: 1000 },
    { startUs: 1000, endUs: 1001 },
    { startUs: 1001, endUs: 1003 },
  ])
    f.evidence.append(f.identity, f.source, await analysis.analyze(range, signal()));
  f.evidence.finish(f.identity);
  const first = f.evidence.boundaryPage({
    identity: f.identity,
    range: { startUs: 1000, endUs: 1001 },
    limit: 1,
  });
  expect(first.boundaries).toEqual([]);
  expect(first.scanned).toBe(1);
  expect(first.next).toEqual({ actualSourceUs: 1000, ordinal: 0 });
  const second = f.evidence.boundaryPage({
    identity: f.identity,
    range: { startUs: 1000, endUs: 1001 },
    after: first.next!,
    limit: 1,
  });
  expect(second.boundaries).toMatchObject([
    {
      ordinal: 1,
      actualSourceUs: 1000,
      sample: { value: "10004", timescale: 10000000, originUs: 0 },
    },
  ]);
  expect(second.next).toBeNull();
  expect(
    f.evidence.boundaryPage({ identity: f.identity, range: { startUs: 999, endUs: 1000 } })
      .boundaries,
  ).toMatchObject([{ ordinal: 0, sample: { value: "9996" } }]);
});

test("malformed overlaps and comparisons cannot partially publish retained rows", async () => {
  const f = await fixture();
  const analysis = f.analysis();
  const first = await analysis.analyze({ startUs: 0, endUs: 400000 }, signal());
  const wrong = structuredClone(first);
  wrong.comparisons[0]!.current = { ...wrong.comparisons[0]!.current, value: "1" };
  expect(() => f.evidence.append(f.identity, f.source, wrong)).toThrow("retained observations");
  f.evidence.append(f.identity, f.source, first);
  const tail = await analysis.analyze({ startUs: 400000, endUs: 1000000 }, signal());
  const changed = structuredClone(tail);
  if (changed.coverage[0]!.status === "available") changed.coverage[0]!.stillnessRunStartUs = 1;
  expect(() => f.evidence.append(f.identity, f.source, changed)).toThrow("Overlapping");
  const replay = structuredClone(tail);
  replay.comparisons.unshift(first.comparisons[0]!);
  expect(() => f.evidence.append(f.identity, f.source, replay)).toThrow("retained observations");
  f.evidence.append(f.identity, f.source, tail);
  const metadata = f.evidence.finish(f.identity);
  expect(metadata.comparisonCount).toBe(first.comparisons.length + tail.comparisons.length);
  expect(
    f.evidence.boundaryPage({ identity: f.identity }).boundaries.map((b) => b.actualSourceUs),
  ).toEqual([200000, 400000, 600000, 800000]);
});

test("late boundary reads use an indexed bounded seek and reclamation removes its rows", async () => {
  const duration = 2000000000,
    f = await fixture(duration),
    analysis = f.analysis();
  for (let startUs = 0; startUs < duration; startUs += 10000000)
    f.evidence.append(
      f.identity,
      f.source,
      await analysis.analyze({ startUs, endUs: Math.min(startUs + 10000000, duration) }, signal()),
    );
  f.evidence.finish(f.identity);
  let readRows = 0;
  const plans: string[] = [];
  const seekKeys: unknown[][] = [];
  const prepare = f.catalog.catalog.prepare.bind(f.catalog.catalog);
  const spy = vi.spyOn(f.catalog.catalog, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT content")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = all(...args);
        readRows += rows.length;
        const program = prepare("EXPLAIN " + sql).all(...args);
        const seek = program.find((row) => row.opcode === "SeekGE" || row.opcode === "SeekGT")!;
        const registers = new Map<number, unknown>();
        for (const instruction of program) {
          if (instruction.addr === seek.addr) break;
          if (instruction.opcode === "Variable")
            registers.set(Number(instruction.p2), args[Number(instruction.p1) - 1]);
        }
        seekKeys.push(
          Array.from({ length: Number(seek.p4) }, (_, i) => registers.get(Number(seek.p3) + i)),
        );
        plans.push(
          prepare("EXPLAIN QUERY PLAN " + sql)
            .all(...args)
            .map((row) => row.detail)
            .join(" "),
        );
        return rows;
      });
    }
    return statement;
  });
  try {
    const page = f.evidence.boundaryPage({
      identity: f.identity,
      range: { startUs: 1999600000, endUs: 1999800000 },
      limit: 1,
    });
    expect(page.boundaries.map((b) => b.actualSourceUs)).toEqual([1999600000]);
    expect(readRows).toBe(2);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toContain("SEARCH");
    expect(plans[0]).toContain("actualSourceUs");
    expect(plans[0]).not.toContain("USE TEMP B-TREE");
    const cursor = { actualSourceUs: 1999600000, ordinal: 9997 };
    const continued = f.evidence.boundaryPage({ identity: f.identity, after: cursor, limit: 1 });
    expect(continued.boundaries.map((b) => b.actualSourceUs)).toEqual([1999800000]);
    expect(seekKeys[1]!.slice(-2)).toEqual([cursor.actualSourceUs, cursor.ordinal]);
    expect(seekKeys[1]).toHaveLength(7);
  } finally {
    spy.mockRestore();
  }
  await f.evidence.reclaim(f.identity.owner, () => false);
  expect(() => f.evidence.boundaryPage({ identity: f.identity })).toThrow("complete");
  expect(
    f.catalog.catalog.prepare("SELECT count(*) AS count FROM scene_evidence_boundaries").get()!
      .count,
  ).toBe(0);
});

test("stored empty visual coverage remains explicit and distinct from missing generations", async () => {
  const f = await fixture();
  const analysis = f.analysis((at) => ({
    requestedSourceUs: at,
    status: "unavailable",
    reason: "empty_edit",
    continuousFromPrevious: false,
  }));
  const chunk = await analysis.analyze({ startUs: 0, endUs: 1000000 }, signal());
  f.evidence.append(f.identity, f.source, chunk);
  const metadata = f.evidence.finish(f.identity);
  expect(metadata).toMatchObject({ comparisonCount: 0, boundaryCount: 0 });
  expect(f.evidence.sourcePage({ identity: f.identity }).chunks[0]!.coverage).toEqual(
    chunk.coverage,
  );
  expect(f.evidence.boundaryPage({ identity: f.identity })).toMatchObject({
    boundaries: [],
    scanned: 0,
    next: null,
  });
  expect(() =>
    f.evidence.boundaryPage({ identity: { ...f.identity, generation: "missing" } }),
  ).toThrow("complete");
});
