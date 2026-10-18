import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JourneyService, poll, root, run } from "./source-evidence-fixture.mjs";
import {
  writeSourceWave,
  decodedHash,
  sourcePeriod,
  projectPeriod,
  periodicHash,
  periodicBytes,
  digest,
  waveHeader,
} from "./audio-project-fixture.mjs";
import { maskedProject } from "./audio-project-mask.mjs";
const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Explicit frozen native required");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "large-project-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-project-large-"));
const report = {
  passed: false,
  trace: [],
  checks: {},
  memory: {
    samples: 0,
    nativePeakRssBytes: 0,
    serviceCliPeakRssBytes: 0,
    harnessTreePeakRssBytes: 0,
    mcpPeakRssBytes: 0,
    productionTreePeakRssBytes: 0,
  },
  boundary:
    "Real ALAC/native/shared service/public CLI and MCP; independent authored PCM oracle. Sampled RSS, not instantaneous peak or broad stress acceptance.",
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
let monitor, sampling, monitorError, deliveryPid;
async function sampleMemory() {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,command="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, rss, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return { pid: +pid, parent: +parent, rss: +rss * 1024, command };
    });
  function descendants(seeds) {
    const pids = new Set(seeds);
    for (let before = -1; before !== pids.size;) {
      before = pids.size;
      for (const row of rows) if (pids.has(row.parent)) pids.add(row.pid);
    }
    return rows.filter((r) => pids.has(r.pid));
  }
  const selected = descendants([service.child.pid, ...(deliveryPid ? [deliveryPid] : [])]);
  const adapters = rows.filter(
    (row) =>
      row.parent === process.pid &&
      row.command.includes("/apps/cli/dist/main.js mcp --socket " + service.socketPath),
  );
  assert.equal(adapters.length, 1, "Sample the live MCP adapter");
  report.memory.mcpPeakRssBytes = Math.max(report.memory.mcpPeakRssBytes, adapters[0].rss);
  report.memory.productionTreePeakRssBytes = Math.max(
    report.memory.productionTreePeakRssBytes,
    selected.reduce((n, row) => n + row.rss, 0) + adapters[0].rss,
  );
  report.memory.samples++;
  report.memory.serviceCliPeakRssBytes = Math.max(
    report.memory.serviceCliPeakRssBytes,
    selected.reduce((n, r) => n + r.rss, 0),
  );
  report.memory.harnessTreePeakRssBytes = Math.max(
    report.memory.harnessTreePeakRssBytes,
    descendants([process.pid]).reduce((n, r) => n + r.rss, 0),
  );
  for (const row of selected)
    if (row.command === process.env.YAP_NATIVE)
      report.memory.nativePeakRssBytes = Math.max(report.memory.nativePeakRssBytes, row.rss);
}
async function ready(params) {
  const deadline = performance.now() + 600000;
  for (;;) {
    const value = await call("audio.get", params, { transport: "mcp" });
    if (value.state === "ready") return value;
    assert.ok(!["failed", "canceled"].includes(value.state), JSON.stringify(value));
    assert.ok(performance.now() < deadline, "Large project audio: ten-minute harness deadline");
    await delay(250);
  }
}
async function readBytes(token, offset, length) {
  const blocks = [];
  for (let at = 0; at < length;) {
    const reply = await call(
      "artifact.read",
      { token, offset: offset + at, maxBytes: Math.min(65536, length - at) },
      { transport: "mcp" },
    );
    const block = Buffer.from(reply.data, "base64");
    assert.equal(reply.offset, offset + at);
    assert.ok(block.length > 0 && block.length <= 65536);
    assert.equal(reply.nextOffset, offset + at + block.length);
    blocks.push(block);
    at += block.length;
  }
  return Buffer.concat(blocks);
}
try {
  report.nativeSha256 = await digest(process.env.YAP_NATIVE);
  report.runtime = {};
  for (const directory of [
    "packages/composition",
    "packages/core",
    "packages/protocol",
    "packages/client",
    "apps/service",
    "apps/cli",
  ]) {
    const { stdout } = await run("rg", [
      "--files",
      "--hidden",
      "--no-ignore",
      join(root, directory, "dist"),
    ]);
    for (const path of [...stdout.trim().split("\n"), join(root, directory, "package.json")])
      report.runtime[path.slice(root.length)] = await digest(path);
  }
  await service.start();
  report.maskedProject = await maskedProject({ home, out, call });
  const assets = [];
  report.originals = [];
  for (let source = 0; source < 2; source++) {
    const wav = join(home, `source-${source}.wav`),
      path = join(out, `source-${source}.mov`);
    await writeSourceWave(wav, { source });
    await run("ffmpeg", ["-v", "error", "-nostdin", "-i", wav, "-c:a", "alac", path], {
      timeout: 30000,
    });
    const decoded = await decodedHash(path);
    assert.equal(decoded.frames, 61 * 48000);
    assert.equal(decoded.sha256, periodicHash(sourcePeriod(source), 61));
    const sha256 = await digest(path);
    report.originals.push({ path, sha256, decoded });
    const job = await call("asset.import", { path, requestId: `source-${source}` });
    await poll(
      () => call("job.get", { jobId: job.jobId }),
      (v) => v.state === "ready",
      "admission",
    );
    const asset = await call("asset.get", { assetId: sha256 });
    assets.push({
      assetId: asset.id,
      streamId: asset.streams.find((s) => s.kind === "audio").streamId,
    });
  }
  const created = await call("project.create", {
    requestId: "large-project",
    title: "Two-source 50-minute exact PCM",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const operations = [];
  for (let source = 0; source < 2; source++) {
    const label = `track-${source}`;
    operations.push({ operation: "track.add", label, track: { kind: "audio", order: source } });
    for (let occurrence = 0; occurrence < 50; occurrence++)
      operations.push({
        operation: "place",
        clip: {
          trackId: { label },
          ...assets[source],
          source: {
            kind: "range",
            range: { startUs: source * 250000, endUs: 60000000 + source * 250000 },
          },
          placement: {
            kind: "project",
            range: { startUs: occurrence * 60000000, endUs: (occurrence + 1) * 60000000 },
          },
        },
      });
    operations.push({
      operation: "processing.set",
      target: { kind: "track", id: { label } },
      steps: [{ processor: { type: "gain", gain: source === 0 ? 0.5 : 0.25 } }],
    });
  }
  operations.push({
    operation: "processing.set",
    target: { kind: "output" },
    steps: [{ processor: { type: "gain", gain: 2 } }],
  });
  const edited = await call("edit.apply", {
    projectId: created.project.projectId,
    requestId: "100-clips",
    expectedRevisionId: created.revision.revisionId,
    operations,
  });
  const selection = {
    projectId: created.project.projectId,
    revisionId: edited.revision.revisionId,
  };
  report.selection = selection;
  report.authored = {
    clips: 100,
    tracks: 2,
    seconds: 3000,
    sourcePhaseUs: [0, 250000],
    trackGain: [0.5, 0.25],
    outputGain: 2,
  };
  monitor = setInterval(() => {
    if (!sampling)
      sampling = sampleMemory()
        .catch((e) => {
          monitorError = e;
        })
        .finally(() => {
          sampling = undefined;
        });
  }, 100);
  const started = performance.now(),
    large = await ready(selection);
  report.extractionMs = performance.now() - started;
  const audio = large.published.output,
    { token, bytes } = large.delivery;
  assert.ok(bytes > 1024 ** 3);
  assert.equal(audio.frames, 144000000);
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 2);
  const response = await service.mcp.callTool({ name: "audio.get", arguments: selection });
  assert.equal(response.structuredContent.ok, true);
  assert.ok(!response.content.some((v) => v.type === "audio"));
  await call(
    "artifact.close",
    { token: response.structuredContent.data.delivery.token },
    { transport: "mcp" },
  );
  const header = waveHeader(await readBytes(token, 0, 8192), bytes);
  assert.equal(header.frames, 144000000);
  const period = projectPeriod();
  report.excerpts = [];
  for (const start of [0, 2879990, 143995904]) {
    const count = 4096;
    const actual = await readBytes(token, header.offset + start * 8, count * 8);
    assert.deepEqual(actual, periodicBytes(period, start, count));
    report.excerpts.push({ start, frames: count });
  }
  await call("artifact.close", { token }, { transport: "mcp" });
  const range = { startUs: 2998999333, endUs: 2999999777 },
    ranged = await ready({ ...selection, range });
  const start = Math.floor((range.startUs * 48000) / 1000000),
    end = Math.floor((range.endUs * 48000) / 1000000);
  assert.deepEqual(ranged.published.output.sampleRange, { start, end });
  const rangeResponse = await service.mcp.callTool({
    name: "audio.get",
    arguments: { ...selection, range },
  });
  assert.equal(rangeResponse.structuredContent.ok, true);
  const rangeMedia = rangeResponse.content.filter((item) => item.type === "audio");
  assert.equal(rangeMedia.length, 1);
  const rangeBytes = Buffer.from(rangeMedia[0].data, "base64"),
    rangeHeader = waveHeader(rangeBytes, rangeBytes.length);
  assert.deepEqual(
    rangeBytes.subarray(rangeHeader.offset),
    periodicBytes(period, start, end - start),
  );
  await writeFile(join(out, "late-range.wav"), rangeBytes);
  await call("artifact.close", { token: ranged.delivery.token }, { transport: "mcp" });
  const destination = join(home, "delivered.wav"),
    transferStarted = performance.now();
  const transfer = run(
    process.execPath,
    [
      join(root, "apps/cli/dist/main.js"),
      "audio.get",
      "--socket",
      service.socketPath,
      "--params",
      JSON.stringify(selection),
      "--output",
      destination,
    ],
    { timeout: 180000, maxBuffer: 1024 * 1024 },
  );
  deliveryPid = transfer.child?.pid;
  const receipt = JSON.parse((await transfer).stdout);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  report.transferMs = performance.now() - transferStarted;
  assert.equal((await stat(destination)).size, bytes);
  const wavSha256 = await digest(destination);
  assert.equal(wavSha256, await digest(audio.file));
  const pcmSha256 = await digest(destination, { start: header.offset });
  const expectedPcmSha256 = periodicHash(period, 3000);
  assert.equal(pcmSha256, expectedPcmSha256, "Complete multi-source PCM oracle");
  const actualRange = rangeBytes.subarray(rangeHeader.offset);
  assert.throws(() => assert.deepEqual(actualRange, periodicBytes(period, start + 1, end - start)));
  const swapped = Buffer.from(actualRange);
  for (let at = 0; at < swapped.length; at += 8) {
    const left = swapped.readFloatLE(at);
    swapped.writeFloatLE(swapped.readFloatLE(at + 4), at);
    swapped.writeFloatLE(left, at + 4);
  }
  assert.throws(() => assert.deepEqual(actualRange, swapped));
  assert.notEqual(
    pcmSha256,
    periodicHash(sourcePeriod(0), 3000),
    "Omitting second source must fail exact oracle",
  );
  report.checks.negativeControls = [
    "one-frame-shift",
    "channel-swap",
    "second-source-omission",
    "physical-excluded-poison",
  ];
  report.large = {
    nativeReceipt: audio,
    bytes,
    frames: audio.frames,
    wavSha256,
    pcmSha256,
    expectedPcmSha256,
    range,
    start,
    end,
  };
  clearInterval(monitor);
  await sampling;
  assert.equal(monitorError, undefined);
  assert.ok(report.memory.samples > 2);
  assert.ok(
    report.memory.mcpPeakRssBytes > 0 && report.memory.mcpPeakRssBytes < 256 * 1024 ** 2,
    "MCP adapter bounded RSS <256 MiB",
  );
  assert.ok(
    report.memory.nativePeakRssBytes > 0 && report.memory.nativePeakRssBytes < 256 * 1024 ** 2,
    "Native bounded RSS <256 MiB",
  );
  assert.ok(
    report.memory.serviceCliPeakRssBytes < 512 * 1024 ** 2,
    "Service and CLI bounded RSS <512 MiB",
  );
  for (const item of report.originals) assert.equal(await digest(item.path), item.sha256);
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  report.checks.originalsUnchangedNoModels = true;
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  await sampling;
  await service.stop().catch((e) => {
    report.passed = false;
    report.shutdownError = e.message;
    process.exitCode = 1;
  });
  try {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
