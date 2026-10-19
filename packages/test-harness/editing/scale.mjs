import { reorderQuery } from "./scale-reorder-query.mjs";
import { routingTopology, longRoutingPlacements } from "./routing-topology.mjs";
import assert from "node:assert/strict";
import { previewScale } from "./preview-scale.mjs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll, hash, run } from "./source-evidence-fixture.mjs";
import { writeSourceWave, sourcePeriod, waveHeader } from "./audio-project-fixture.mjs";

const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } } });
assert.ok(["long-project", "reorder-query"].includes(values.case));
const queryOnly = values.case === "reorder-query";
assert.ok(process.env.YAP_NATIVE);
const out = values.out ? resolve(values.out) : await mkdtemp("/tmp/routing-scale-");
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/sr-routing-scale-");
const report = {
  passed: false,
  trace: [],
  cases: [],
  home,
  observations: {},
  limits: { inspectionP95Ms: 250, warmPreviewMs: 15000, workerRSSBytes: 4 * 1024 ** 3 },
};
const service = new JourneyService(home, report, join(out, "native"));
const call = (operation, params, extra = {}) =>
  service.call(operation, params, { transport: queryOnly ? "cli" : "mcp", ...extra });
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2));
let sampledRSS = 0,
  sampling = false;
const timer = setInterval(async () => {
  if (sampling || !service.child?.pid) return;
  sampling = true;
  try {
    const read = await run("ps", ["-o", "rss=", "-p", String(service.child.pid)]);
    sampledRSS = Math.max(sampledRSS, Number(read.stdout.trim()) * 1024);
  } catch {
  } finally {
    sampling = false;
  }
}, 200);
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
try {
  await service.start();
  const source = join(out, "source.wav");
  await writeSourceWave(source, { source: 0, seconds: 1 });
  const sourceHash = hash(await readFile(source));
  const imported = await call("asset.import", { path: source, requestId: "source" });
  const ready = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: ready.published.output.assetId });
  const period = sourcePeriod(0);
  for (const [seconds, occurrences] of queryOnly
    ? [[7200, 10000]]
    : [
        [300, 500],
        [7200, 10000],
      ]) {
    const depth = 128,
      width = 32,
      durationUs = seconds * 1e6;
    const result = { seconds, occurrences, depth, width, editMs: [], audio: [] };
    report.cases.push(result);
    const made = await call("project.create", {
      requestId: `project-${seconds}`,
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const projectId = made.project.projectId;
    let revisionId = made.revision.revisionId;
    const apply = async (operations, name) => {
      const request = {
        projectId,
        expectedRevisionId: revisionId,
        requestId: `${seconds}-${name}`,
        operations,
      };
      await save(`request-${seconds}-${name}.json`, request);
      const at = performance.now();
      const response = await call("edit.apply", request);
      result.editMs.push({ name, ms: performance.now() - at });
      revisionId = response.revision.revisionId;
      return response;
    };
    const topology = routingTopology(depth, width);
    const topologyResult = await apply(topology, "topology"),
      tracks = Array.from({ length: width }, (_, i) => topologyResult.edit.labels[`t${i}`]);
    const authored = [];
    const endSequential = durationUs - 1e6;
    const placements = longRoutingPlacements(seconds, occurrences, width);
    for (let first = 0; first < occurrences; first += 500) {
      const operations = [];
      for (let i = first; i < Math.min(first + 500, occurrences); i++) {
        const { startUs, endUs, lane } = placements[i];
        operations.push({
          operation: "place",
          ...(queryOnly ? { label: `clip${i}` } : {}),
          clip: {
            trackId: tracks[lane],
            assetId: asset.assetId,
            streamId: asset.streams[0].streamId,
            source: { kind: "range", range: { startUs: 0, endUs: endUs - startUs } },
            placement: { kind: "project", range: { startUs, endUs } },
          },
        });
      }
      const placed = await apply(operations, `place-${first}`);
      if (queryOnly)
        for (const op of operations) {
          authored.push({
            clipId: placed.edit.labels[op.label],
            trackId: op.clip.trackId,
            trackRank: tracks.indexOf(op.clip.trackId),
            ...op.clip.placement.range,
          });
        }
    }
    const selection = { projectId, revisionId };
    result.selection = selection;
    if (queryOnly) {
      await reorderQuery({ service, save, result, apply, selection, authored, asset });
      continue;
    }
    const query = { ...selection, range: { startUs: 0, endUs: endSequential }, limit: 250 };
    const read250 = async () => {
      const rows = [];
      let cursor;
      let calls = 0;
      do {
        const page = await poll(
          () =>
            call("timeline.events", {
              ...query,
              limit: 250 - rows.length,
              ...(cursor ? { cursor } : {}),
            }),
          (v) => v.state === "ready",
          "cut page",
        );
        rows.push(...page.page.rows);
        cursor = page.page.nextCursor;
        calls++;
        assert.ok(calls <= 100, "Bounded source paging must make progress toward 250 rows");
      } while (rows.length < 250 && cursor);
      assert.equal(rows.length, 250);
      return { rows, calls };
    };
    const page = await read250(),
      latencies = [];
    for (let n = 0; n < 20; n++) {
      const at = performance.now();
      const repeated = await read250();
      latencies.push(performance.now() - at);
      assert.deepEqual(repeated.rows, page.rows);
    }
    result.inspection = {
      samples: latencies,
      p95Ms: p95(latencies),
      rows: page.rows.length,
      callsPerSample: page.calls,
      withinBudget: p95(latencies) <= report.limits.inspectionP95Ms,
    };
    for (const [name, from] of [
      ["cold", 900000],
      ["warm", 900000],
    ]) {
      const params = { ...selection, range: { startUs: endSequential + from, endUs: durationUs } };
      const at = performance.now();
      const audio = await poll(
        () => call("audio.get", params),
        (v) => v.state === "ready",
        name,
      );
      const path = join(out, `${seconds}-${name}.wav`);
      await service.call("audio.get", params, { output: path });
      const bytes = await readFile(path),
        header = waveHeader(bytes, bytes.length);
      assert.deepEqual(bytes.subarray(header.offset), period.subarray(((from * 48000) / 1e6) * 8));
      assert.ok(audio.published.output.peakResidentBytes <= report.limits.workerRSSBytes);
      result.audio.push({
        name,
        ms: performance.now() - at,
        receipt: audio,
        sha256: hash(bytes),
        exactPCM: true,
      });
    }
    if (seconds === 7200) {
      const hit = await service.arm("media.mixCompositionAudio");
      const params = (offset) => ({
        ...selection,
        range: { startUs: endSequential + offset, endUs: endSequential + offset + 1000 },
      });
      const running = await call("audio.get", params(100000));
      await hit();
      const queued = [];
      for (let n = 0; n < 32; n++) {
        const response = await call("audio.get", params(200000 + n * 1000));
        assert.equal(response.state, "queued");
        queued.push(response);
      }
      const refusal = await call("audio.get", params(300000), { error: true });
      assert.equal(refusal.code, "LIMIT_EXCEEDED");
      assert.equal(refusal.retryable, true);
      const cancelAt = performance.now();
      await call("job.cancel", { jobId: queued[0].jobId });
      assert.equal((await call("job.get", { jobId: queued[0].jobId })).state, "canceled");
      const admitted = await call("audio.get", params(300000));
      assert.equal(admitted.state, "queued");
      for (const item of queued.slice(1)) await call("job.cancel", { jobId: item.jobId });
      const waitingAt = performance.now();
      await call("job.cancel", { jobId: running.jobId });
      const successor = await poll(
        () => call("job.get", { jobId: admitted.jobId }),
        (v) => v.state === "ready",
        "successor",
      );
      assert.equal((await call("job.get", { jobId: running.jobId })).state, "canceled");
      result.queue = {
        refusal,
        queued: queued.length,
        cancelAndDrainMs: performance.now() - cancelAt,
        successorAfterReleaseMs: performance.now() - waitingAt,
        successor,
      };
      await service.stop();
      await service.start();
      assert.equal((await call("job.get", { jobId: admitted.jobId })).state, "ready");
      assert.equal((await call("asset.get", { assetId: asset.assetId })).assetId, asset.assetId);
    }
  }
  if (!queryOnly)
    report.preview = await previewScale(
      service,
      out,
      report.limits,
      report.cases.at(-1).selection,
      report.cases.at(-1).seconds * 1e6,
    );
  report.observations.sampledServicePeakRSS = sampledRSS;
  const mixes = [];
  for (const name of queryOnly ? [] : await readdir(join(out, "native")))
    if (name.startsWith("mix-")) {
      const value = JSON.parse(await readFile(join(out, "native", name), "utf8"));
      assert.equal(
        value.request.clips.length,
        32,
        "Late compilation must select only overlapping tail clips",
      );
      mixes.push({
        name,
        range: value.request.range,
        clips: value.request.clips.length,
        processing: value.request.processing.length,
        response: value.response,
      });
    }
  report.observations.mixes = mixes;
  assert.equal(hash(await readFile(source)), sourceHash, "Source bytes must remain intact");
  report.observations.sourceSha256 = sourceHash;
  const renders = await readdir(join(home, "library/render"), { recursive: true }).catch(() => []);
  assert.equal(renders.length, 0, "Canceled and completed work must reclaim render staging");
  report.passed =
    report.cases.every((value) => value.inspection.withinBudget) &&
    (queryOnly || report.preview.withinBudget);
  await save("report.json", report);
  assert.ok(
    report.passed,
    "Observed inspection or warm-preview budget failed; retain report and profile owner",
  );
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  clearInterval(timer);
  try {
    await service.stop();
    await save("report.json", report);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(out);
