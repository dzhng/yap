import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { acquisitionDonor, JourneyService, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    codec: { type: "string", default: "aac" },
    signal: { type: "string", default: "marker" },
  },
});
assert.ok(["aac", "alac"].includes(values.codec));
assert.ok(["marker", "silence"].includes(values.signal));
assert.ok(process.env.YAP_NATIVE, "Freeze YAP_NATIVE before this journey");
assert.ok(process.env.YAP_SOURCE_AUDIO_FIXTURE, "Freeze the real native fixture generator");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "audio-extraction-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "audio-extraction-"));
const media = join(home, "fixtures");
await mkdir(media);
const report = {
  passed: false,
  trace: [],
  checks: {},
  memory: { samples: 0, nativePeakRssBytes: 0, treePeakRssBytes: 0 },
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const digest = async (path) => {
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
};
const originals = new Map();
let monitor;
let sampling;
let monitoringError;
let deliveryPid;
function sameBytes(actual, expected) {
  assert.ok(actual.equals(expected), "Delivered PCM bytes differ from the independent reference");
}
// Lossless PCM is byte exact. AAC's seek-dependent float output also occurs in the
// frozen prior decoder; admit less than one 16-bit quantization step, never a shift.
function comparePcm(actual, expected, codec) {
  assert.equal(actual.length, expected.length, "PCM sample count changed");
  if (codec !== "aac") {
    sameBytes(actual, expected);
    return { rms: 0, maximum: 0 };
  }
  sameBytes(actual.subarray(0, 8), expected.subarray(0, 8));
  sameBytes(actual.subarray(-8), expected.subarray(-8));
  let squared = 0,
    maximum = 0;
  for (let at = 0; at < actual.length; at += 4) {
    const error = actual.readFloatLE(at) - expected.readFloatLE(at);
    assert.ok(Number.isFinite(error));
    squared += error * error;
    maximum = Math.max(maximum, Math.abs(error));
  }
  const rms = Math.sqrt(squared / (actual.length / 4));
  assert.ok(rms < 1 / 32768 && maximum < 1 / 32768, "AAC numerical conformance exceeded");
  return { rms, maximum };
}
function wave(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  let format;
  for (let at = 12; at + 8 <= bytes.length;) {
    const tag = bytes.toString("ascii", at, at + 4),
      size = bytes.readUInt32LE(at + 4);
    at += 8;
    if (tag === "fmt ")
      format = { channels: bytes.readUInt16LE(at + 2), rate: bytes.readUInt32LE(at + 4) };
    if (tag === "data")
      return { ...format, data: bytes.subarray(at, at + size), dataOffset: at, dataBytes: size };
    at += size + (size % 2);
  }
  throw new Error("Missing WAVE data");
}
let outputOrdinal = 0;
async function ready(params, transport = "cli") {
  const output = join(home, `delivered-${outputOrdinal++}.wav`);
  return poll(
    () => call("audio.get", params, { transport, ...(transport === "cli" ? { output } : {}) }),
    (v) => v.state === "ready",
    "source audio",
  );
}
async function delivered(status) {
  assert.ok(
    status.delivery.bytes < 4 * 1024 ** 2,
    "Only small fixtures may be assembled in memory",
  );
  const bytes = await readFile(status.output);
  assert.equal(bytes.length, status.delivery.bytes);
  await rm(status.output);
  return bytes;
}
async function imported(path, name) {
  originals.set(path, await digest(path));
  const pending = await call("asset.import", { requestId: name, path });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  return call("asset.get", { assetId: originals.get(path) });
}
async function context(path, name) {
  const donor = join(home, name);
  const selected = join(media, `${name}.mov`);
  await run(join(home, "select-track"), [path, selected], { timeout: 30000 });
  originals.set(selected, await digest(selected));
  // Journal ranges use the container clock; the imported source origin is 1.25 seconds.
  await acquisitionDonor(donor, selected, [
    { startUs: 1250013, endUs: 1450000 },
    { startUs: 1550000, endUs: 2249987 },
  ]);
  const pending = await call("acquisition.import", { requestId: name, path: donor });
  const job = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "acquisition",
  );
  const acquired = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
  const binding = acquired.bindings.find((v) => v.sourceRoles.includes("narration"));
  assert.ok(binding);
  return { assetId: binding.assetId, streamId: binding.streamId, acquisitionId: acquired.id };
}
async function sampleMemory() {
  if (!service.child?.pid) return;
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, parent, rss, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return { pid: Number(pid), parent: Number(parent), rss: Number(rss) * 1024, command };
    });
  const pids = new Set([service.child.pid, ...(deliveryPid ? [deliveryPid] : [])]);
  for (let previous = -1; previous !== pids.size;) {
    previous = pids.size;
    for (const row of rows) if (pids.has(row.parent)) pids.add(row.pid);
  }
  const selected = rows.filter((r) => pids.has(r.pid));
  report.memory.samples++;
  report.memory.treePeakRssBytes = Math.max(
    report.memory.treePeakRssBytes,
    selected.reduce((n, r) => n + r.rss, 0),
  );
  for (const row of selected)
    if (row.command.includes("yap"))
      report.memory.nativePeakRssBytes = Math.max(report.memory.nativePeakRssBytes, row.rss);
}
try {
  report.nativeSha256 = await digest(process.env.YAP_NATIVE);
  report.fixtureSha256 = await digest(process.env.YAP_SOURCE_AUDIO_FIXTURE);
  await run(process.env.YAP_SOURCE_AUDIO_FIXTURE, [], {
    env: { ...process.env, YAP_SOURCE_AUDIO_EVIDENCE: media },
    timeout: 120000,
  });
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/audio-extraction-selection.swift"),
      "-o",
      join(home, "select-track"),
    ],
    { timeout: 120000 },
  );
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/audio-extraction-reference.swift"),
      "-o",
      join(home, "reference"),
    ],
    { timeout: 120000 },
  );
  await service.start();
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  for (const rate of [44100, 48000]) {
    const path = join(media, `selected-${rate}.mov`);
    const asset = await imported(path, `selected-${rate}`);
    assert.equal(asset.originUs, 1250000);
    const streams = asset.streams.filter((s) => s.kind === "audio");
    assert.deepEqual(
      streams.map((s) => s.channels),
      [2, 1],
    );
    for (const stream of streams) {
      const selection = { assetId: asset.id, streamId: stream.id };
      const full = await ready(selection);
      const fullBytes = await delivered(full);
      const mcp = await service.mcp.callTool({ name: "audio.get", arguments: selection });
      assert.equal(mcp.structuredContent.ok, true);
      assert.equal(mcp.structuredContent.data.published.generation, full.published.generation);
      const content = mcp.content.find((item) => item.type === "audio");
      assert.ok(content);
      sameBytes(Buffer.from(content.data, "base64"), fullBytes);
      const pcm = wave(fullBytes);
      assert.equal(pcm.rate, rate);
      assert.equal(pcm.channels, stream.channels);
      assert.deepEqual(full.published.output.unavailable, [{ startUs: 400000, endUs: 600000 }]);
      assert.equal(pcm.data.length, rate * stream.channels * 4);
      for (let frame = 0; frame < rate; frame++)
        for (let channel = 0; channel < stream.channels; channel++) {
          const actual = pcm.data.readFloatLE((frame * stream.channels + channel) * 4);
          const expected =
            frame >= rate * 0.4 && frame < rate * 0.6
              ? 0
              : Math.fround((((frame * (channel + 3)) % 101) - 50) / 100);
          assert.equal(
            actual,
            expected,
            `independent signal oracle ${rate}/${stream.id}/${frame}/${channel}`,
          );
        }
      for (const range of [
        { startUs: 71, endUs: 199991 },
        { startUs: 399997, endUs: 600013 },
        { startUs: 610013, endUs: 999981 },
      ]) {
        const part = await ready({ ...selection, range });
        const first = Math.floor((range.startUs * rate) / 1e6),
          last = Math.floor((range.endUs * rate) / 1e6);
        assert.deepEqual(part.published.output.sampleRange, { start: first, end: last });
        sameBytes(
          wave(await delivered(part)).data,
          pcm.data.subarray(first * stream.channels * 4, last * stream.channels * 4),
        );
      }
      const target = join(home, `${rate}-${stream.id.replace(":", "-")}.wav`);
      await call("audio.get", selection, { output: target });
      sameBytes(await readFile(target), fullBytes);
    }
    const masked = await context(path, `mask-${rate}`);
    const full = await ready({ ...masked, range: { startUs: 0, endUs: 1000000 } });
    const bytes = await delivered(full);
    sameBytes(wave(bytes).data, wave(await readFile(join(media, `full-${rate}.wav`))).data);
    assert.deepEqual(full.published.output.unavailable, [
      { startUs: 0, endUs: 13 },
      { startUs: 200000, endUs: 300000 },
      { startUs: 400000, endUs: 600000 },
      { startUs: 999987, endUs: 1000000 },
    ]);
    const poisonPath = join(media, `poison-selected-${rate}.mov`);
    originals.set(poisonPath, await digest(poisonPath));
    const poisoned = await context(poisonPath, `poison-mask-${rate}`);
    sameBytes(
      wave(await delivered(await ready({ ...poisoned, range: { startUs: 0, endUs: 1000000 } })))
        .data,
      wave(bytes).data,
    );
    const cancelInput = { ...masked, range: { startUs: 10, endUs: 900000 } };
    const hit = await service.arm("media.sourceAudio");
    const pending = await call("audio.get", cancelInput);
    await hit();
    await call("job.cancel", { jobId: pending.jobId }, { transport: "mcp" });
    const canceledJob = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "canceled",
      "cancel",
    );
    const canceled = await call("audio.get", cancelInput);
    assert.equal(canceled.reason, "canceled");
    assert.equal(canceled.published, null);
    assert.equal(canceled.delivery, null);
    assert.equal((await call("audio.get", cancelInput)).jobId, pending.jobId);
    await call("job.retry", { jobId: canceledJob.jobId }, { transport: "mcp" });
    const retried = await ready(cancelInput);
    assert.ok(retried.published.generation > canceledJob.generation);
    const first = Math.floor((10 * rate) / 1e6),
      last = Math.floor((900000 * rate) / 1e6);
    sameBytes(wave(await delivered(retried)).data, wave(bytes).data.subarray(first * 8, last * 8));
  }
  report.checks.selectionGapsParityPoisonCancelRetry = true;
  const long = join(media, "long-marker.m4a");
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      values.signal === "silence"
        ? "anullsrc=r=48000:cl=stereo"
        : "aevalsrc='if(gte(t,2998),0.25*sin(2*PI*440*t),0)|if(gte(t,2998),0.125*sin(2*PI*660*t),0)':s=48000",
      "-t",
      "3000",
      "-c:a",
      values.codec,
      ...(values.codec === "aac" ? ["-b:a", "32k"] : []),
      long,
    ],
    { timeout: 180000 },
  );
  await copyFile(long, join(out, "source.m4a"));
  const referencePath = join(home, "reference-tail.pcm");
  const reference = JSON.parse(
    (await run(join(home, "reference"), [long, referencePath], { timeout: 180000 })).stdout,
  );
  assert.equal(reference.frames, 144000000);
  const referenceTail = await readFile(referencePath);
  assert.equal(referenceTail.length, 96000 * 8);
  const energy = [0, 0];
  for (let frame = 0; frame < 96000; frame++)
    for (let channel = 0; channel < 2; channel++)
      energy[channel] += referenceTail.readFloatLE((frame * 2 + channel) * 4) ** 2;
  const rms = energy.map((value) => Math.sqrt(value / 96000));
  if (values.signal === "silence") assert.deepEqual(rms, [0, 0]);
  else
    assert.ok(
      rms[0] > 0.1 && rms[0] < 0.3 && rms[1] > 0.04 && rms[1] < 0.15,
      "Independent AAC tail must contain distinguishable nonzero channels",
    );
  const asset = await imported(long, "long-marker");
  const selection = {
    assetId: asset.id,
    streamId: asset.streams.find((s) => s.kind === "audio").streamId,
  };
  monitor = setInterval(() => {
    if (!sampling)
      sampling = sampleMemory()
        .catch((error) => {
          monitoringError = error;
        })
        .finally(() => {
          sampling = undefined;
        });
  }, 100);
  const started = performance.now();
  const large = await ready(selection, "mcp");
  const extractionMs = performance.now() - started;
  const duplicate = await service.mcp.callTool({ name: "audio.get", arguments: selection });
  assert.equal(duplicate.structuredContent.ok, true);
  assert.ok(!duplicate.content.some((item) => item.type === "audio"));
  assert.equal(duplicate.structuredContent.data.published.generation, large.published.generation);
  await call("artifact.close", { token: duplicate.structuredContent.data.delivery.token });
  const audio = large.published.output;
  assert.ok(large.delivery.bytes > 1024 ** 3);
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 2);
  assert.equal(audio.frames, 3000 * 48000);
  const { token, bytes } = large.delivery;
  const first = await call(
    "artifact.read",
    { token, offset: 0, maxBytes: 8192 },
    { transport: "mcp" },
  );
  const header = wave(Buffer.from(first.data, "base64"));
  assert.equal(header.dataBytes, audio.frames * 8);
  const chunks = [];
  for (let at = 0; at < referenceTail.length;) {
    const offset = header.dataOffset + reference.tailStartFrame * 8 + at;
    const tail = await call(
      "artifact.read",
      { token, offset, maxBytes: Math.min(65536, referenceTail.length - at) },
      { transport: "mcp" },
    );
    const block = Buffer.from(tail.data, "base64");
    assert.equal(tail.offset, offset);
    assert.equal(tail.nextOffset, offset + block.length);
    assert.ok(block.length > 0 && block.length <= 65536);
    chunks.push(block);
    at += block.length;
    assert.equal(tail.eof, at === referenceTail.length);
  }
  const nativeTail = Buffer.concat(chunks);
  assert.equal(nativeTail.length, referenceTail.length);
  const referenceComparison = comparePcm(nativeTail, referenceTail, values.codec);
  const late = await ready({ ...selection, range: { startUs: 2998000000, endUs: 3000000000 } });
  assert.equal(late.published.output.frames, 96000);
  assert.deepEqual(late.published.output.sampleRange, { start: 143904000, end: 144000000 });
  assert.equal(late.published.output.sampleRate, 48000);
  assert.equal(late.published.output.channels, 2);
  const lateWave = wave(await delivered(late));
  assert.equal(lateWave.channels, 2);
  assert.equal(lateWave.rate, 48000);
  const rangeComparison = comparePcm(lateWave.data, nativeTail, values.codec);
  // Actual decoded markers prove the codec gate still rejects lost, shifted, or corrupted samples.
  assert.throws(() => comparePcm(nativeTail.subarray(4), nativeTail, values.codec));
  const corrupted = Buffer.from(nativeTail);
  const middle = Math.floor(corrupted.length / 8) * 4;
  corrupted.writeFloatLE(corrupted.readFloatLE(middle) + 2 / 32768, middle);
  assert.throws(() => comparePcm(corrupted, nativeTail, values.codec));
  if (values.signal === "marker") {
    const shifted = Buffer.concat([nativeTail.subarray(4), nativeTail.subarray(-4)]);
    assert.throws(() => comparePcm(shifted, nativeTail, values.codec));
  }
  for (const frames of [1, 2, 1024, 2048, 2049]) {
    const startUs = Number((BigInt(144000000 - frames) * 1000000n + 47999n) / 48000n);
    const terminal = await ready({ ...selection, range: { startUs, endUs: 3000000000 } });
    assert.equal(terminal.published.output.frames, frames);
    assert.ok(terminal.published.output.decodedFrames <= 8192);
    comparePcm(
      wave(await delivered(terminal)).data,
      nativeTail.subarray(nativeTail.length - frames * 8),
      values.codec,
    );
  }
  await call("artifact.close", { token }, { transport: "mcp" });
  const destination = join(home, "large-delivered.wav");
  const transferStarted = performance.now();
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
  const transferred = JSON.parse((await transfer).stdout);
  const transferMs = performance.now() - transferStarted;
  assert.equal(transferred.ok, true, JSON.stringify(transferred));
  assert.equal((await stat(destination)).size, bytes);
  const outputSha256 = await digest(destination);
  assert.equal(outputSha256, await digest(audio.file));
  clearInterval(monitor);
  await sampling;
  await rm(destination);
  assert.equal(monitoringError, undefined);
  assert.ok(report.memory.samples > 2);
  assert.ok(
    report.memory.nativePeakRssBytes > 0 && report.memory.nativePeakRssBytes < 256 * 1024 ** 2,
    "Native extraction must not retain the full PCM output",
  );
  assert.ok(
    report.memory.treePeakRssBytes < 512 * 1024 ** 2,
    "Service extraction must remain bounded",
  );
  report.large = {
    codec: values.codec,
    signal: values.signal,
    outputSha256,
    decodedFrames: audio.decodedFrames,
    referenceComparison,
    rangeComparison,
    assetId: asset.id,
    streamId: selection.streamId,
    extractionMs,
    transferMs,
    inputBytes: (await stat(long)).size,
    outputBytes: bytes,
    frames: audio.frames,
    elapsedMs: performance.now() - started,
    mcpReadBytes: 8192 + referenceTail.length,
    markerRms: rms,
    referenceTailSha256: await digest(referencePath),
    cliStreamedBytes: bytes,
  };
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  for (const [path, before] of originals) assert.equal(await digest(path), before);
  report.originals = [...originals].map(([path, sha256]) => ({ name: basename(path), sha256 }));
  report.checks.originalsUnchangedNoModelDownload = true;
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  await sampling;
  try {
    await service.stop();
  } catch (error) {
    report.shutdownError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    passed: report.passed,
    out,
    error: report.error,
    large: report.large,
    memory: report.memory,
  }),
);
