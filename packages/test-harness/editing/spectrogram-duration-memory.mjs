import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const { values } = parseArgs({
  options: {
    "completed-four-hour": { type: "string" },
    "move-reference": { type: "string" },
    out: { type: "string" },
    "source-home": { type: "string" },
    "runtime-root": { type: "string" },
  },
});
assert.ok(values.out && values["source-home"] && process.env.YAP_NATIVE);
const runtime = resolve(values["runtime-root"] ?? new URL("../../../", import.meta.url).pathname);
const { JourneyService, poll, run, hash } = await import(
  pathToFileURL(join(runtime, "packages/test-harness/editing/source-evidence-fixture.mjs"))
);
const sourceHome = await realpath(values["source-home"]),
  out = resolve(values.out);
await mkdir(out, { recursive: false });
const report = {
  passed: false,
  sourceHome,
  controllerRuntime: runtime,
  cases: [],
  scope:
    "Frozen-runtime matched2h/4h public spectrogram reproduction; sampled service RSS only, no current-build regression or universal/load claim",
};
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
function inspect(home) {
  const db = new DatabaseSync(join(home, "library/catalog.sqlite"), { readOnly: true });
  try {
    const jobs = db.prepare("SELECT jobId,state,artifact,deferred FROM jobs").all();
    assert.ok(
      jobs.every((j) => ["ready", "failed", "canceled"].includes(j.state) && !j.deferred),
      "Retained work must not resume on clone startup",
    );
    const revision = JSON.parse(
      db.prepare("SELECT content FROM project_revisions ORDER BY ordinal DESC LIMIT 1").get()
        .content,
    );
    return { jobs, revision };
  } finally {
    db.close();
  }
}
function withoutPlacement(clip) {
  const copy = { ...clip };
  delete copy.placement;
  return copy;
}
function support(document, seconds) {
  assert.equal(document.clips.length, 10000);
  assert.equal(document.tracks.length, 1);
  assert.equal(document.groups.length, 0);
  assert.deepEqual(document.processing, []);
  const startUs = seconds * 1e6 - 250000;
  const contextStart = startUs - (40 / 48000) * 1e6,
    contextEnd = seconds * 1e6 + (40 / 48000) * 1e6;
  const contributors = document.clips.filter(
    (c) => c.placement.range.endUs > contextStart && c.placement.range.startUs < contextEnd,
  );
  assert.equal(contributors.length, 1);
  const clip = contributors[0];
  assert.equal(clip.placement.range.startUs, seconds * 1e6 - 100000);
  assert.equal(clip.placement.range.endUs, seconds * 1e6);
  assert.deepEqual(clip.source, { kind: "range", range: { startUs: 0, endUs: 100000 } });
  return {
    assetId: clip.assetId,
    streamId: clip.streamId,
    source: clip.source,
    relativePlacement: { startUs: 150000, endUs: 250000 },
    contextFrames: { start: -40, end: 12040 },
    activeContributors: 1,
    beforeClipFrames: 7240,
    sourceFrames: 4800,
    afterProjectPaddingFrames: 40,
  };
}
try {
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  assert.equal(
    report.nativeSha256,
    "8a0c7732f3c1f99e074048f2ac3b8b29beb613462fb5ce769a134b1cbfdea186",
  );
  report.originalCatalogSha256 = hash(await readFile(join(sourceHome, "library/catalog.sqlite")));
  const original = inspect(sourceHome);
  report.originalJobs = original.jobs;
  report.projectId = original.revision.projectId;
  report.originalRevisionId = original.revision.revisionId;
  report.support = support(original.revision.document, 14400);
  report.sourceSha256 = hash(
    await readFile(join(sourceHome, "library/assets", report.support.assetId + ".wav")),
  );
  assert.equal(report.sourceSha256, report.support.assetId);
  await writeFile(join(out, "original-revision.json"), JSON.stringify(original.revision));
  if (values["completed-four-hour"]) {
    const priorPath = resolve(values["completed-four-hour"]);
    const bytes = await readFile(join(priorPath, "report.json"));
    const prior = JSON.parse(bytes),
      four = prior.cases.find((c) => c.seconds === 14400);
    assert.equal(prior.originalCatalogSha256, report.originalCatalogSha256);
    assert.equal(prior.nativeSha256, report.nativeSha256);
    assert.equal(prior.sourceSha256, report.sourceSha256);
    assert.deepEqual(prior.support, report.support);
    assert.equal(four.queryMs.length, 20);
    assert.ok(four.plotSha256);
    assert.equal(four.revisionId, original.revision.revisionId);
    assert.deepEqual(four.request, {
      projectId: report.projectId,
      revisionId: original.revision.revisionId,
      range: { startUs: 14400 * 1e6 - 250000, endUs: 14400 * 1e6 },
      fftFrames: 128,
      hopFrames: 48,
    });
    const png = await readFile(join(priorPath, "spectrogram-14400.png"));
    assert.equal(hash(png), four.imageSha256);
    await writeFile(join(out, "spectrogram-14400.png"), png);
    report.retainedFourHour = {
      path: priorPath,
      reportSha256: hash(bytes),
      runtime: prior.runtime,
    };
    four.runtime = prior.runtime ?? prior.controllerRuntime;
    report.cases.push(four);
  }
  for (const seconds of report.retainedFourHour ? [7200] : [14400, 7200]) {
    const home = join(out, `home-${seconds}`);
    await cp(sourceHome, home, { recursive: true, errorOnExist: true, force: false });
    const trial = {
      seconds,
      runtime,
      home: await realpath(home),
      trace: [],
      samples: [],
      queryMs: [],
      setupMs: [],
    };
    report.cases.push(trial);
    assert.equal(inspect(trial.home).revision.revisionId, original.revision.revisionId);
    await save();
    let revisionId = original.revision.revisionId;
    const service = new JourneyService(trial.home, trial, join(out, `native-${seconds}`));
    let stopping = false,
      sampling,
      sampleError;
    try {
      if (seconds === 7200) {
        await service.start();
        const clips = original.revision.document.clips;
        for (let first = 0; first < clips.length; first += 500) {
          const setupAt = performance.now();
          const result = await service.call(
            "edit.apply",
            {
              projectId: report.projectId,
              expectedRevisionId: revisionId,
              requestId: `spectrogram-move-${first}`,
              operations: clips.slice(first, first + 500).map((clip, n) => {
                const startUs = Math.floor(((first + n) * (seconds * 1e6 - 100000)) / 9999);
                return {
                  operation: "move",
                  clipIds: [clip.id],
                  atUs: startUs,
                  scope: "selected",
                  ripple: "none",
                };
              }),
            },
            { transport: "mcp" },
          );
          trial.setupMs.push(performance.now() - setupAt);
          revisionId = result.revision.revisionId;
          if (first === 0 && values["move-reference"]) {
            const expected = JSON.parse(await readFile(resolve(values["move-reference"]), "utf8"));
            const db = new DatabaseSync(join(home, "library/catalog.sqlite"), { readOnly: true });
            try {
              const row = db
                .prepare(
                  "SELECT arguments,result FROM project_requests WHERE projectId=? AND requestId=?",
                )
                .get(report.projectId, "spectrogram-move-0");
              const committed = JSON.parse(row.result);
              assert.deepEqual(committed.revision.document, expected.revision.document);
              assert.deepEqual(committed.edit, expected.edit);
              assert.equal(committed.revision.ordinal, expected.revision.ordinal);
              trial.originalMoveComparison = {
                elapsedMs: trial.setupMs[0],
                completeDocumentEqual: true,
                completeEditReceiptEqual: true,
                receiptSha256: hash(Buffer.from(JSON.stringify(committed.edit))),
              };
              await writeFile(join(out, "fixed-move-result.json"), row.result);
              await writeFile(join(out, "fixed-move-arguments.json"), row.arguments);
            } finally {
              db.close();
            }
          }
        }
        await service.stop();
      }
      const authored = inspect(trial.home).revision;
      assert.equal(authored.id, revisionId);
      assert.deepEqual(support(authored.document, seconds), report.support);
      assert.deepEqual(
        authored.document.clips.map(withoutPlacement),
        original.revision.document.clips.map(withoutPlacement),
      );
      await writeFile(join(out, `revision-${seconds}.json`), JSON.stringify(authored));
      trial.revisionId = revisionId;
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
        while (!stopping) {
          trial.samples.push({ atMs: performance.now(), bytes: await rss() });
          await delay(20);
        }
      })().catch((e) => {
        sampleError = e;
        stopping = true;
      });
      const params = {
        projectId: report.projectId,
        revisionId,
        range: { startUs: seconds * 1e6 - 250000, endUs: seconds * 1e6 },
        fftFrames: 128,
        hopFrames: 48,
      };
      trial.request = params;
      const read = async () => {
        let delivery;
        const ready = await poll(
          async () => {
            delivery = await service.mcp.callTool({ name: "spectrogram.get", arguments: params });
            assert.equal(
              delivery.structuredContent?.ok,
              true,
              JSON.stringify(delivery.structuredContent),
            );
            return delivery.structuredContent.data;
          },
          (v) => v.state === "ready",
          "spectrogram delivery",
        );
        const images = delivery.content.filter((c) => c.type === "image");
        assert.equal(images.length, 1);
        assert.equal(images[0].mimeType, "image/png");
        const bytes = Buffer.from(images[0].data, "base64"),
          m = ready.published.output;
        assert.equal(m.bytes, bytes.length);
        assert.equal(m.projectId, report.projectId);
        assert.equal(m.revisionId, revisionId);
        assert.equal(m.sampleRate, 48000);
        assert.equal(m.channels, 2);
        assert.deepEqual(m.range, params.range);
        assert.deepEqual(m.sampleRange, { start: seconds * 48000 - 12000, end: seconds * 48000 });
        assert.deepEqual(m.analysis, {
          kind: "spectrum",
          fftFrames: 128,
          hopFrames: 48,
          columnCount: 250,
        });
        assert.equal(bytes.readUInt32BE(16), m.width);
        assert.equal(bytes.readUInt32BE(20), m.height);
        if (!trial.metadata) {
          trial.metadata = m;
          trial.imageSha256 = hash(bytes);
          await writeFile(join(out, `spectrogram-${seconds}.png`), bytes);
        }
        assert.equal(hash(bytes), trial.imageSha256);
        return ready;
      };
      let at = performance.now();
      await read();
      trial.coldMs = performance.now() - at;
      for (let repeat = 0; repeat < 20; repeat++) {
        at = performance.now();
        await read();
        trial.queryMs.push(performance.now() - at);
      }
      stopping = true;
      await sampling;
      if (sampleError) throw sampleError;
      assert.ok(trial.samples.length >= 10);
      trial.sampledPeakBytes = Math.max(...trial.samples.map((s) => s.bytes));
      trial.sampledGrowthBytes = trial.sampledPeakBytes - trial.baselineBytes;
      assert.ok(trial.sampledGrowthBytes > 0);
      trial.queryP95Ms = [...trial.queryMs].sort((a, b) => a - b)[18];
    } finally {
      stopping = true;
      if (sampling) await sampling;
      try {
        await service.stop();
      } finally {
        trial.serviceLog = service.logs;
        await save();
      }
    }
    // Compare decoded plot pixels after measurement; provenance/time-axis labels legitimately differ.
    const m = trial.metadata;
    const decoded = (
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          join(out, `spectrogram-${seconds}.png`),
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout;
    assert.equal(decoded.length, m.width * m.height * 3);
    const rows = [];
    for (let c = 0; c < 2; c++)
      for (
        let y = m.plotTop + c * m.panelStride;
        y < m.plotTop + c * m.panelStride + m.panelHeight;
        y++
      ) {
        const start = (y * m.width + m.plotLeft) * 3;
        rows.push(decoded.subarray(start, start + m.plotWidth * 3));
      }
    trial.plotSha256 = hash(Buffer.concat(rows));
    await save();
  }
  const [four, two] = report.cases;
  assert.equal(four.plotSha256, two.plotSha256, "Matched source/context spectral plot differs");
  report.comparison = {
    peakRatio: four.sampledPeakBytes / two.sampledPeakBytes,
    growthRatio: four.sampledGrowthBytes / two.sampledGrowthBytes,
  };
  assert.ok(
    report.comparison.peakRatio < 2 && report.comparison.growthRatio < 2,
    "Doubling duration doubled bounded spectrogram service memory",
  );
  assert.equal(
    hash(await readFile(join(sourceHome, "library/catalog.sqlite"))),
    report.originalCatalogSha256,
  );
  report.passed = true;
} catch (e) {
  report.error = { message: e.message, stack: e.stack };
  throw e;
} finally {
  await save();
}
console.log(out);
