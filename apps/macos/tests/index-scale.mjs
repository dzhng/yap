import { indexScaleMetrics } from "./fixtures/index-scale-metrics.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { arch, cpus, platform, release } from "node:os";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import { until } from "./fixtures/public-service.mjs";
import { app, launchReady, socketPath, temporary } from "./harness.mjs";

// Explicit long-running lab, excluded from the default native test glob. Build first.
// YAP_INDEX_SCALE_EVIDENCE: empty absolute output directory (default: fresh /tmp directory).
// YAP_INDEX_SCALE_VIDEO: optional absolute path to the preserved generated fixture;
// copied read-only into this run's disposable source fixture. Its hash identifies comparable runs.
const durationUs = 1_800_000_000;
// This bounds the measurement run; the fixture duration is not a processing-time SLA.
const timeoutMs = 45 * 60_000;
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

async function fixture(home) {
  const video = join(home, "video.mov");
  const input = process.env.YAP_INDEX_SCALE_VIDEO;
  if (input) {
    assert.ok(isAbsolute(input), "Fixture input must be an absolute path");
    await copyFile(input, video);
  } else {
    run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=1800",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-g",
        "30",
        "-bf",
        "0",
        video,
      ],
      120_000,
    );
  }
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", video]));
  assert.equal(probe.streams.length, 1, "The scale fixture must contain video only");
  const stream = probe.streams[0];
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.width, 320);
  assert.equal(stream.height, 180);
  assert.equal(stream.avg_frame_rate, "30/1");
  assert.equal(Number(stream.duration), durationUs / 1_000_000);
  return { video, input: input ?? "generated:testsrc2" };
}

function sampleMemory(servicePid, report) {
  const processes = run("/bin/ps", ["-axo", "pid=,ppid=,rss="])
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/).map(Number));
  const serviceRSSKiB = processes.find((row) => row[0] === servicePid)?.[2] ?? null;
  report.servicePeakKiB = Math.max(report.servicePeakKiB, serviceRSSKiB ?? 0);
  const owned = new Set([servicePid]);
  for (let previousSize = 0; previousSize !== owned.size;) {
    previousSize = owned.size;
    for (const [pid, ppid] of processes) if (owned.has(ppid)) owned.add(pid);
  }
  let workerTotalRSSKiB = 0,
    workerCount = 0,
    maxWorkerRSSKiB = 0;
  for (const [pid, , rss] of processes)
    if (pid !== servicePid && owned.has(pid)) {
      workerTotalRSSKiB += rss;
      workerCount++;
      maxWorkerRSSKiB = Math.max(maxWorkerRSSKiB, rss);
      report.workerPeakKiB = Math.max(report.workerPeakKiB, rss);
      report.workerObservations++;
    }
  report.memorySamples++;
  return { serviceRSSKiB, workerTotalRSSKiB, workerCount, maxWorkerRSSKiB };
}

test("thirty-minute generated native index scale", { timeout: timeoutMs + 150_000 }, async (t) => {
  const output =
    process.env.YAP_INDEX_SCALE_EVIDENCE ?? (await mkdtemp("/tmp/yap-index-scale-evidence-"));
  assert.ok(isAbsolute(output), "Evidence output must be an absolute path");
  await mkdir(output, { recursive: true });
  assert.deepEqual(await readdir(output), [], "Evidence output must be empty");
  const report = {
    state: "preparing",
    generated: true,
    durationUs,
    safetyDeadlineMs: timeoutMs,
    width: 320,
    height: 180,
    fps: 30,
    host: {
      cpu: cpus()[0]?.model,
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
    },
    servicePeakKiB: 0,
    workerPeakKiB: 0,
    workerObservations: 0,
    memorySamples: 0,
    memorySampling: "RSS sampled between polls, nominally every second; not a guaranteed peak",
    checkpoints: [],
    foreground: null,
  };
  // Atomic replacement preserves the last complete checkpoint if the run is interrupted.
  const save = async () => {
    await writeFile(join(output, "report.tmp"), JSON.stringify(report, null, 2) + "\n");
    await rename(join(output, "report.tmp"), join(output, "report.json"));
  };
  console.log(JSON.stringify({ evidence: output }));
  await save();
  const home = temporary("/tmp/scr-index-scale-");
  let instance;
  let started;
  try {
    report.revision = run("git", ["rev-parse", "HEAD"]).trim();
    report.ffmpeg = run("ffmpeg", ["-version"]).split("\n")[0];
    report.nativeExecutableSha256 = await hash(app);
    report.serviceBundleSha256 = await hash(join(dirname(app), "../Resources/service/main.mjs"));
    await save();
    const { video, input } = await fixture(home);
    report.sourceHash = await hash(video);
    report.input = input;
    const launched = await launchReady(home);
    instance = launched.instance;
    const { servicePid } = launched;
    started = Date.now();
    Object.assign(report, {
      state: "running",
      startedAt: new Date(started).toISOString(),
    });
    await save();
    const call = async (operation, params) => {
      t.signal.throwIfAborted();
      assert.ok(
        Date.now() - started < timeoutMs,
        "Index measurement exceeded its 45-minute safety deadline",
      );
      const reply = await callLocal(socketPath(home), { id: randomUUID(), operation, params });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.ok(!["failed", "unavailable"].includes(reply.data.state), JSON.stringify(reply.data));
      return reply.data;
    };
    const admitted = await call("asset.import", { requestId: randomUUID(), path: video });
    const imported = await until(async () => {
      const job = await call("job.get", { jobId: admitted.jobId });
      assert.notEqual(job.state, "canceled");
      return job.state === "ready" && job;
    }, "Scale source import");
    const asset = await call("asset.get", { assetId: imported.published.output.assetId });
    const streams = asset.streams.filter((stream) => stream.kind === "video");
    assert.equal(streams.length, 1);
    const selector = { assetId: asset.id, streamId: streams[0].streamId };
    Object.assign(report, selector);
    let ready,
      nextCheckpoint = 0,
      nextMemory = 0,
      lastMemory,
      indexStarted;
    const observe = async (result) => {
      const now = Date.now();
      if (now >= nextMemory) {
        lastMemory = { elapsedMs: now - started, ...sampleMemory(servicePid, report) };
        nextMemory = now + 1000;
      }
      if (now >= nextCheckpoint || result.state === "ready") {
        const metrics = await indexScaleMetrics(join(home, "library", "catalog.sqlite"));
        const checkpoint = {
          elapsedMs: now - started,
          state: result.state,
          phase: indexStarted === undefined ? "dependencies" : "index",
          memory: lastMemory,
          catalogMetricsState: metrics === null ? "busy" : "ready",
          ...metrics,
        };
        report.checkpoints.push(checkpoint);
        await save();
        console.log(JSON.stringify(checkpoint));
        nextCheckpoint = now + 15_000;
      }
    };
    for (;;) {
      const result = await call("index.get", { ...selector, limit: 1 });
      if (result.jobId && indexStarted === undefined) {
        indexStarted = Date.now();
        report.indexStartedMs = indexStarted - started;
      }
      await observe(result);
      if (indexStarted !== undefined && report.foreground === null) {
        const began = performance.now();
        report.foreground = { state: "running", startedMs: Date.now() - started };
        await save();
        let frame;
        do {
          frame = await call("frame.get", {
            ...selector,
            atUs: 900_000_000,
          });
          await observe(result);
          if (frame.state !== "ready") await delay(25, undefined, { signal: t.signal });
        } while (frame.state !== "ready");
        report.foreground = {
          ...report.foreground,
          state: "ready",
          elapsedMs: performance.now() - began,
          frame: frame.published.output,
        };
        await save();
        await call("artifact.close", { token: frame.delivery.token });
      }
      if (result.state === "ready") {
        ready = result;
        break;
      }
      await delay(1000, undefined, { signal: t.signal });
    }
    report.elapsedMs = Date.now() - started;
    report.indexElapsedMs = indexStarted === undefined ? null : Date.now() - indexStarted;
    let candidates = 0,
      pages = 0,
      cursor;
    for (;;) {
      const page = await call("index.get", {
        ...selector,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.state, "ready");
      pages++;
      candidates += page.entries.length;
      if (!page.nextCursor) break;
      assert.notDeepEqual(page.nextCursor, cursor, "Paging must advance");
      cursor = page.nextCursor;
    }
    assert.equal(candidates, ready.metadata.candidateCount);
    assert.equal(await hash(video), report.sourceHash);
    const metrics = await indexScaleMetrics(join(home, "library", "catalog.sqlite"), 5000);
    assert.notEqual(
      metrics,
      null,
      "Final catalog metrics stayed busy; completion evidence is missing",
    );
    Object.assign(report, {
      state: "complete",
      pages,
      candidates,
      ...metrics,
      retainedPngBytes: ready.metadata.sizeBytes,
      metadata: ready.metadata,
    });
  } catch (error) {
    report.state = "failed";
    report.error = String(error.stack ?? error);
    throw error;
  } finally {
    if (started !== undefined) report.totalElapsedMs = Date.now() - started;
    await save();
    if (instance) {
      report.survivingProcesses = await instance.reap();
      if (report.survivingProcesses.length) report.state = "failed";
      await save();
      assert.deepEqual(report.survivingProcesses, []);
    }
  }
});
