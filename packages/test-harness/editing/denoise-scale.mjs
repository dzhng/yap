import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { JourneyService, hash, run } from "./source-evidence-fixture.mjs";
import { referenceLanes, compareWavePCM } from "./denoise-pcm.mjs";
import { writeSourceWave, sourcePeriod, waveHeader } from "./audio-project-fixture.mjs";

const priorUnavailableOperations = process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    reference: { type: "string" },
    seconds: { type: "string" },
    occurrences: { type: "string" },
  },
});
const seconds = Number(values.seconds),
  occurrences = Number(values.occurrences);
assert(
  values.out &&
    values.reference &&
    process.env.YAP_NATIVE &&
    Number.isSafeInteger(seconds) &&
    seconds > 0,
);
assert(Number.isSafeInteger(occurrences) && occurrences > 0 && (seconds * 1e6) % occurrences === 0);
const span = (seconds * 1e6) / occurrences;
assert(span <= 1e6, "Repeated source fixture has one second of support");
const out = resolve(values.out),
  home = await mkdtemp("/tmp/sr-denoise-scale-");
await mkdir(out);
const native = process.env.YAP_NATIVE;
const reference = resolve(values.reference);
const referenceSha256 = hash(await readFile(reference));
assert.equal(referenceSha256, "697657e249b178c415d379511ba4041687055c7cf5d347af80a2d3a08cb6c5ee");
const report = {
  passed: false,
  seconds,
  occurrences,
  nativeSha256: hash(await readFile(native)),
  referenceSha256,
  trace: [],
  receipts: [],
  observations: {},
  checks: {},
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
let peakNodeRSS = 0,
  peakServiceRSS = 0,
  peakWorkspaceBytes = 0,
  sampling = false;
const observer = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  try {
    peakNodeRSS = Math.max(peakNodeRSS, process.memoryUsage().rss);
    if (service.child?.pid) {
      const measured = await run("ps", ["-o", "rss=", "-p", String(service.child.pid)]).catch(
        () => undefined,
      );
      if (measured)
        peakServiceRSS = Math.max(peakServiceRSS, Number(measured.stdout.trim()) * 1024);
    }
    let size = 0;
    for (const file of await readdir(join(home, "library/render"), { recursive: true }).catch(
      () => [],
    )) {
      const s = await stat(join(home, "library/render", file)).catch(() => undefined);
      if (s?.isFile()) size += s.size;
    }
    peakWorkspaceBytes = Math.max(peakWorkspaceBytes, size);
  } finally {
    sampling = false;
  }
}, 200);
async function wait(read, done, label) {
  const start = performance.now();
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    assert(!["failed", "canceled"].includes(v.state), `${label}: ${JSON.stringify(v)}`);
    assert(performance.now() - start < 3600000, `${label}: one-hour research guard`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function digest(path) {
  const h = createHash("sha256");
  for await (const bytes of createReadStream(path)) h.update(bytes);
  return h.digest("hex");
}
// A shutdown failure is rethrown only after the run itself succeeded, so it never masks the run's error.
let shutdownFailure;
try {
  await service.start();
  const source = join(out, "source.wav");
  await writeSourceWave(source, { source: 0, seconds: 1 });
  const importing = await call("asset.import", { path: source, requestId: "source" });
  const job = await wait(
    () => call("job.get", { jobId: importing.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  const made = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  let revision = made.revision;
  const setupAt = performance.now();
  for (let first = 0; first < occurrences; first += 500) {
    const operations = [];
    if (!first)
      operations.push({
        operation: "track.add",
        label: "audio",
        track: { kind: "audio", order: 0 },
      });
    const trackId = !first ? { label: "audio" } : revision.document.tracks[0].id;
    for (let i = first; i < Math.min(first + 500, occurrences); i++)
      operations.push({
        operation: "place",
        clip: {
          trackId,
          assetId: asset.id,
          streamId: asset.streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: span } },
          placement: { kind: "project", range: { startUs: i * span, endUs: (i + 1) * span } },
        },
      });
    if (first + 500 >= occurrences)
      operations.push({
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "rnnoise" } }],
      });
    revision = (
      await call(
        "edit.apply",
        {
          projectId,
          expectedRevisionId: revision.revisionId,
          requestId: `place-${first}`,
          operations,
        },
        { transport: "mcp" },
      )
    ).revision;
  }
  report.observations.setupMs = performance.now() - setupAt;
  const selection = { projectId, revisionId: revision.revisionId },
    preparingAt = performance.now();
  const submitted = await call("audio.prepare", selection);
  report.receipts.push(
    await wait(
      () => call("job.get", { jobId: submitted.jobId }),
      (value) => value.state === "ready",
      "prepare job",
    ),
  );
  const prepared = await call("audio.prepare", selection);
  assert.equal(prepared.state, "ready");
  report.observations.prepareMs = performance.now() - preparingAt;
  report.receipts.push(prepared);
  report.observations.nativePeakResidentBytes = prepared.published.output.peakResidentBytes;
  assert.deepEqual(prepared.published.output.sampleRange, { start: 0, end: seconds * 48000 });
  assert.deepEqual(await call("audio.prepare", selection), prepared);
  const resultAsset = await call("asset.get", { assetId: prepared.published.output.assetId });
  const full = join(home, "library/assets", resultAsset.id + ".wav"),
    f = await open(full, "r");
  let expected;
  try {
    const headerBytes = Buffer.alloc(4096);
    await f.read(headerBytes, 0, headerBytes.length, 0);
    const header = waveHeader(headerBytes, (await f.stat()).size);
    assert.equal(header.frames, seconds * 48000);
    expected = Buffer.alloc(48000 * 8);
    assert.equal(
      (await f.read(expected, 0, expected.length, header.offset + (seconds - 1) * 48000 * 8))
        .bytesRead,
      expected.length,
    );
  } finally {
    await f.close();
  }
  // The authored source mapping repeats this exact selected period, independently of the compiler.
  const periodFrames = (span * 48000) / 1e6;
  assert(
    Number.isSafeInteger(periodFrames),
    "Scale oracle requires integral selected sample bounds",
  );
  const period = sourcePeriod(0).subarray(0, periodFrames * 8);
  const referenceAt = performance.now();
  const referenceInputs = [];
  for (let channel = 0; channel < 2; channel++) {
    const lane = Buffer.alloc(periodFrames * 4);
    for (let frame = 0; frame < periodFrames; frame++)
      period.copy(lane, frame * 4, frame * 8 + channel * 4, frame * 8 + channel * 4 + 4);
    const input = join(out, `reference-${channel}-input.f32`);
    const writer = await open(input, "w");
    try {
      for (let i = 0; i < occurrences; i++)
        assert.equal((await writer.write(lane)).bytesWritten, lane.length);
    } finally {
      await writer.close();
    }
    referenceInputs.push(input);
  }
  const referencePaths = await referenceLanes(reference, referenceInputs, seconds * 48000, out);
  report.observations.fullPCMHash = await compareWavePCM(full, seconds * 48000, referencePaths);
  report.observations.independentReferenceMs = performance.now() - referenceAt;
  report.observations.fullSha256 = await digest(full);
  report.observations.fullBytes = (await stat(full)).size;
  await copyFile(full, join(out, "prepared.wav"));
  assert.deepEqual(await readdir(join(home, "library/render"), { recursive: true }), []);
  await service.stop();
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
    "media.audioCapabilities",
    "media.mixCompositionAudio",
  ]);
  await service.start();
  const range = {
    assetId: resultAsset.id,
    streamId: resultAsset.streams[0].streamId,
    range: { startUs: (seconds - 1) * 1e6, endUs: seconds * 1e6 },
  };
  const lateAt = performance.now();
  const late = await wait(
    () => call("audio.get", range),
    (v) => v.state === "ready",
    "late retained read",
  );
  report.observations.lateColdMs = performance.now() - lateAt;
  report.receipts.push(late);
  const excerpt = join(out, "late.wav");
  const warmAt = performance.now();
  await call("audio.get", range, { output: excerpt });
  report.observations.lateWarmDeliveryMs = performance.now() - warmAt;
  const b = await readFile(excerpt),
    h = waveHeader(b, b.length);
  assert.deepEqual(b.subarray(h.offset), expected);
  report.observations.latePCMHash = hash(expected);
  assert.deepEqual(await readdir(join(home, "library/render"), { recursive: true }), []);
  report.checks = {
    successfulPreparation: true,
    exactIndependentFullPCM: true,
    exactDeclaredFullCount: true,
    exactLateVersusFull: true,
    repeatIdentity: true,
    retainedReadWithoutProcessing: true,
    workspaceClean: true,
  };
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  if (priorUnavailableOperations === undefined) delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  else process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = priorUnavailableOperations;
  clearInterval(observer);
  while (sampling) await new Promise((resolve) => setImmediate(resolve));
  try {
    await service.stop();
  } catch (error) {
    shutdownFailure = error;
    report.shutdownFailure = { message: error.message, stack: error.stack };
    report.passed = false;
  }
  report.observations.sampledHarnessPeakRSS = peakNodeRSS;
  report.observations.sampledServicePeakRSS = peakServiceRSS;
  report.observations.sampledPeakWorkspaceBytes = peakWorkspaceBytes;

  try {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
if (shutdownFailure) throw shutdownFailure;
console.log(JSON.stringify(report.observations, null, 2));
