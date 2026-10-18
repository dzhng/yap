import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backup } from "node:sqlite";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Catalog } from "../../core/dist/catalog.js";
import { AssetStore } from "../../core/dist/assets.js";
import { AcquisitionStore } from "../../core/dist/acquisitions.js";
import { ProjectStore } from "../../core/dist/projects.js";
import { TranscriptStore } from "../../core/dist/transcript.js";
import { assetTranscriptOwner } from "../../core/dist/transcript-processing.js";
import { JourneyService, hash, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = values.out ? resolve(values.out) : await mkdtemp("/tmp/yap-history-scale-");
await mkdir(out, { recursive: true });
const report = {
  passed: false,
  scope:
    "Fixed-size public managed-project history queries; sampled service RSS, not render memory",
  nodeVersion: process.version,
  controls: { histories: [5000, 10000], pageSize: 250, repeats: 100, trialsPerSize: 3 },
  cases: [],
};
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const expected = [];
const seedHome = await mkdtemp("/tmp/sr-history-seed-");
let projectId;
try {
  const catalog = new Catalog(":memory:");
  try {
    const assets = new AssetStore(catalog, seedHome);
    await assets.recover();
    const acquisitions = new AcquisitionStore(catalog);
    const projects = new ProjectStore(
      catalog,
      assets,
      new TranscriptStore(catalog, seedHome, assetTranscriptOwner(assets, acquisitions)),
      acquisitions,
    );
    const made = projects.create({
      requestId: "project",
      canvas: {
        width: 320,
        height: 240,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    projectId = made.project.projectId;
    expected.push(made.revision);
    for (let ordinal = 1; ordinal < 10000; ordinal++) {
      expected.push(
        projects.apply(projectId, {
          requestId: `edit-${ordinal}`,
          expectedRevisionId: expected.at(-1).id,
          operations: [{ operation: "canvas.set", canvas: { width: 320 + (ordinal % 2) } }],
        }).revision,
      );
      if (ordinal === 4999 || ordinal === 9999)
        await backup(catalog.catalog, join(out, `history-${ordinal + 1}.sqlite`));
    }
  } finally {
    catalog.close();
  }
  report.projectId = projectId;
  report.expectedSha256 = hash(Buffer.from(JSON.stringify(expected)));
  await writeFile(join(out, "expected.json"), JSON.stringify(expected));
  for (const size of [5000, 10000, 10000, 5000, 5000, 10000]) {
    const home = await mkdtemp("/tmp/sr-history-scale-");
    const trial = { size, home, trace: [], samples: [], queryMs: [] };
    report.cases.push(trial);
    const service = new JourneyService(home, trial);
    const call = (operation, params, transport = "mcp") =>
      service.call(operation, params, { transport });
    let sampling,
      sampleError,
      stopped = false;
    try {
      await mkdir(join(home, "library"), { mode: 0o700 });
      await copyFile(join(out, `history-${size}.sqlite`), join(home, "library/catalog.sqlite"));
      await service.start();
      const cursors = new Map([[0, null]]);
      let cursor = null,
        count = 0,
        appended;
      do {
        const page = await call(
          "revision.history",
          { projectId, cursor, limit: 250 },
          count === 0 ? "cli" : "mcp",
        );
        assert.deepEqual(page.revisions, expected.slice(count, count + 250));
        count += page.revisions.length;
        assert.ok(count <= size, "Pinned history must exclude the appended revision");
        if (!appended) {
          appended = await call("edit.apply", {
            projectId,
            requestId: "append-during-page",
            expectedRevisionId: expected[size - 1].id,
            operations: [{ operation: "canvas.set", canvas: { width: 640 } }],
          });
          assert.equal(appended.revision.ordinal, size);
        }
        cursor = page.nextCursor;
        if (cursor) cursors.set(count, cursor);
      } while (cursor);
      assert.equal(count, size);
      const fresh = await call("revision.history", { projectId, limit: 250 });
      assert.equal(fresh.nextCursor.throughOrdinal, size);
      const newest = await call(
        "revision.history",
        {
          projectId,
          cursor: { ...fresh.nextCursor, afterOrdinal: size - 1 },
          limit: 250,
        },
        "cli",
      );
      assert.deepEqual(newest.revisions, [appended.revision]);
      assert.equal(newest.nextCursor, null);
      trial.pinnedRevisionCount = count;
      trial.appendedRevisionId = appended.revision.revisionId;
      await service.stop();
      await service.start();
      trial.queryPid = service.child.pid;
      const rss = async () => {
        const bytes =
          Number((await run("ps", ["-o", "rss=", "-p", String(trial.queryPid)])).stdout.trim()) *
          1024;
        assert.ok(Number.isFinite(bytes) && bytes > 0);
        return bytes;
      };
      trial.baselineBytes = await rss();
      sampling = (async () => {
        while (!stopped) {
          trial.samples.push({ atMs: performance.now(), bytes: await rss() });
          await delay(20);
        }
      })().catch((error) => {
        sampleError = error;
        stopped = true;
      });
      const offsets = [0, size / 2, size - 250];
      trial.maximumPageBytes = 0;
      for (let repeat = 0; repeat <= report.controls.repeats; repeat++) {
        for (const offset of offsets) {
          assert.ok(cursors.has(offset));
          const at = performance.now();
          const page = await call("revision.history", {
            projectId,
            cursor: cursors.get(offset),
            limit: 250,
          });
          const elapsed = performance.now() - at;
          if (repeat > 0) trial.queryMs.push(elapsed);
          assert.deepEqual(page.revisions, expected.slice(offset, offset + 250));
          trial.maximumPageBytes = Math.max(
            trial.maximumPageBytes,
            Buffer.byteLength(JSON.stringify(page)),
          );
        }
      }
      stopped = true;
      await sampling;
      if (sampleError) throw sampleError;
      trial.sampledPeakBytes = Math.max(trial.baselineBytes, ...trial.samples.map((s) => s.bytes));
      trial.sampledGrowthBytes = trial.sampledPeakBytes - trial.baselineBytes;
      trial.p95Ms = [...trial.queryMs].sort((a, b) => a - b)[
        Math.ceil(trial.queryMs.length * 0.95) - 1
      ];
      assert.ok(
        trial.samples.length >= 10 && trial.sampledGrowthBytes > 0,
        "Memory growth was not observable",
      );
      assert.ok(trial.p95Ms <= 250, "Cached history page exceeded250ms p95");
    } finally {
      stopped = true;
      if (sampling) await sampling;
      try {
        await service.stop();
      } finally {
        await save();
        await rm(home, { recursive: true });
      }
    }
  }
  const cohort = (size, field) =>
    median(report.cases.filter((c) => c.size === size).map((c) => c[field]));
  report.comparison = {
    peakRatio: cohort(10000, "sampledPeakBytes") / cohort(5000, "sampledPeakBytes"),
    growthRatio: cohort(10000, "sampledGrowthBytes") / cohort(5000, "sampledGrowthBytes"),
    maximumPageBytes: Math.max(...report.cases.map((c) => c.maximumPageBytes)),
  };
  report.passed = report.comparison.peakRatio < 2 && report.comparison.growthRatio < 2;
  assert.ok(report.passed, "Doubling history doubled observed fixed-page memory");
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await save();
  await rm(seedHome, { recursive: true });
}
console.log(out);
