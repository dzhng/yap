import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { routingTopology, longRoutingPlacements } from "./routing-topology.mjs";
import { writeSourceWave, sourcePeriod, waveHeader, digest } from "./audio-project-fixture.mjs";
import { createDenoiseReference } from "./denoise-reference.mjs";
import { authoredDryBlocks } from "./denoise-routing.mjs";
import { writeDryReference, compareWavePCM, referenceLanes } from "./denoise-pcm.mjs";

const priorUnavailableOperations = process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    reference: { type: "string" },
    case: { type: "string", default: "short" },
    source: { type: "string" },
  },
});
assert(values.out && values.reference && process.env.YAP_NATIVE);
const cohorts = { short: [8, 512], "five-minute": [300, 500], "two-hour": [7200, 10000] };
assert(Object.hasOwn(cohorts, values.case));
const [seconds, occurrences] = cohorts[values.case],
  long = values.case !== "short";
assert(!long || values.source, "Long routing reuses a retained source WAV");
const frames = seconds * 48000,
  deadline = performance.now() + 3600000;
let phase = "setup";
const out = resolve(values.out),
  home = await realpath(await mkdtemp("/tmp/sr-learned-topology-"));
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  checks: {},
  observations: {},
  home,
  scope: long
    ? "Long connected learned state with original deep/wide authored routing; no listening/disk-I/O claim"
    : "Eight-second deep/wide learned traversal; no two-hour or listening claim",
  fixture: { seconds, occurrences, depth: 128, width: 32, rootGainSteps: 128 },
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  referenceSha256: hash(await readFile(resolve(values.reference))),
};
const reference = createDenoiseReference(resolve(values.reference), out);
const service = new JourneyService(home, report, long ? join(out, "native") : undefined);
const call = (op, params, options = {}) =>
  service.call(op, params, { transport: "mcp", ...options });
let observing = false,
  peakRSS = 0;
const observer = setInterval(async () => {
  if (observing || !service.child?.pid) return;
  observing = true;
  try {
    const value = await run("ps", ["-o", "rss=", "-p", String(service.child.pid)]);
    peakRSS = Math.max(peakRSS, Number(value.stdout.trim()) * 1024);
  } catch {
  } finally {
    observing = false;
  }
}, 200);
async function learnedWait(read, done, label) {
  if (!long) return poll(read, done, label);
  phase = label;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert(!["failed", "canceled"].includes(value.state), JSON.stringify(value));
    assert(performance.now() < deadline, "One-hour whole-case research stop");
    await new Promise((r) => setTimeout(r, 250));
  }
}
const progress = long
  ? setInterval(
      () =>
        console.log(
          JSON.stringify({
            phase,
            elapsedSeconds: (3600000 - (deadline - performance.now())) / 1000,
            peakRSS,
          }),
        ),
      5000,
    )
  : undefined;
const pcm = (bytes) => {
  const header = waveHeader(bytes, bytes.length);
  return bytes.subarray(header.offset, header.offset + header.frames * 8);
};
function exactPCM(actual, expected, label) {
  if (actual.equals(expected)) return;
  let byte = 0;
  while (byte < Math.min(actual.length, expected.length) && actual[byte] === expected[byte]) byte++;
  assert.fail(
    JSON.stringify({
      label,
      actualBytes: actual.length,
      expectedBytes: expected.length,
      firstDifferentFrame: Math.floor(byte / 8),
      channel: Math.floor(byte / 4) % 2,
      actualSha256: hash(actual),
      expectedSha256: hash(expected),
    }),
  );
}
async function audio(params, name) {
  const at = performance.now();
  const ready = await learnedWait(
    () => call("audio.get", params),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, `${name}.wav`);
  await call("audio.get", params, { transport: "cli", output: path });
  if (long) {
    report.checks[name] = {
      receipt: ready,
      sha256: await digest(path),
      ms: performance.now() - at,
    };
    return path;
  }
  const bytes = await readFile(path);
  report.checks[name] = { receipt: ready, sha256: hash(bytes), ms: performance.now() - at };
  return pcm(bytes);
}
// A shutdown failure is rethrown only after the run itself succeeded, so it never masks the run's error.
let shutdownFailure;
try {
  await service.start();
  const assets = [];
  for (let i = 0; i < (long ? 1 : 2); i++) {
    const path = long ? resolve(values.source) : join(out, `source-${i}.wav`);
    if (!long) await writeSourceWave(path, { source: i, seconds: 1 });
    if (long) {
      report.source = { path, before: await digest(path) };
      assert.equal(
        report.source.before,
        "7216ee4f02580d52c2ae3ce5a59588b68d4e874a8cf2053e4b61b63f782281d4",
      );
    }
    const submitted = await call("asset.import", { path, requestId: `source-${i}` });
    const ready = await poll(
      () => call("job.get", { jobId: submitted.jobId }),
      (v) => v.state === "ready",
      "source import",
    );
    assets.push(await call("asset.get", { assetId: ready.published.output.assetId }));
  }
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
  async function apply(operations, name) {
    const params = {
      projectId,
      expectedRevisionId: revision.revisionId,
      requestId: name,
      operations,
    };
    await writeFile(join(out, `${name}-request.json`), JSON.stringify(params));
    const at = performance.now(),
      result = await call("edit.apply", params);
    report.observations[name + "Ms"] = performance.now() - at;
    revision = result.revision;
    return result;
  }
  const topology = await apply(routingTopology(128, 32), "topology");
  const placement = [];
  const authored = long ? longRoutingPlacements(seconds, occurrences, 32) : undefined;
  if (long)
    for (const clip of authored)
      placement.push({
        operation: "place",
        clip: {
          trackId: topology.edit.labels[`t${clip.lane}`],
          assetId: assets[0].id,
          streamId: assets[0].streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: clip.endUs - clip.startUs } },
          placement: { kind: "project", range: { startUs: clip.startUs, endUs: clip.endUs } },
        },
      });
  else
    for (let slot = 0; slot < 16; slot++)
      for (let lane = 0; lane < 32; lane++) {
        const asset = assets[lane % 2],
          sourceStartUs = lane % 4 >= 2 ? 250000 : 0;
        placement.push({
          operation: "place",
          clip: {
            trackId: topology.edit.labels[`t${lane}`],
            assetId: asset.id,
            streamId: asset.streams[0].streamId,
            source: {
              kind: "range",
              range: { startUs: sourceStartUs, endUs: sourceStartUs + 500000 },
            },
            placement: {
              kind: "project",
              range: { startUs: slot * 500000, endUs: (slot + 1) * 500000 },
            },
          },
        });
      }
  for (let first = 0; first < placement.length; first += 500)
    await apply(
      placement.slice(first, first + 500),
      first === 0 ? "place-first" : first === 500 && !long ? "place-last" : `place-${first}`,
    );
  const drySelection = { projectId, revisionId: revision.revisionId };
  let independent, expected;
  if (long) {
    phase = "independent dry";
    independent = await writeDryReference(
      authoredDryBlocks(sourcePeriod(0), authored, 32, frames),
      out,
    );
    assert.equal(independent.frames, frames);
    const dry = await audio(
      { ...drySelection, range: { startUs: 0, endUs: seconds * 1e6 } },
      "dry",
    );
    const sha256 = await compareWavePCM(dry, frames, [independent.dry]);
    assert.equal(sha256, independent.sha256);
    report.checks.independentDry = { ...independent, exact: true };
  } else {
    const periods = [sourcePeriod(0), sourcePeriod(1)];
    expected = Buffer.alloc(8 * 48000 * 8);
    const missingLane = Buffer.alloc(expected.length);
    // Dyadic source/gain values make each authored sum exact in Float32; reciprocal
    // gain pairs preserve it through every ancestor and the long root stack.
    for (let frame = 0; frame < 8 * 48000; frame++)
      for (let channel = 0; channel < 2; channel++) {
        let sum = 0,
          missing = 0;
        for (let lane = 0; lane < 32; lane++) {
          const sourceFrame = (frame % 24000) + (lane % 4 >= 2 ? 12000 : 0);
          const contribution = Math.fround(
            periods[lane % 2].readFloatLE(sourceFrame * 8 + channel * 4) / 32,
          );
          sum = Math.fround(sum + contribution);
          if (lane) missing = Math.fround(missing + contribution);
        }
        expected.writeFloatLE(sum, frame * 8 + channel * 4);
        missingLane.writeFloatLE(missing, frame * 8 + channel * 4);
      }
    await writeFile(join(out, "independent-dry.f32"), expected);
    const dry = await audio({ ...drySelection, range: { startUs: 0, endUs: 8000000 } }, "dry");
    exactPCM(dry, expected, "independent dry");
    assert.throws(() => exactPCM(dry, missingLane, "missing lane control"), /missing lane control/);
    report.checks.independentDry = {
      sha256: hash(expected),
      exact: true,
      missingLaneOracleRejected: true,
    };
  }
  const target = { kind: "group", id: topology.edit.labels.g0 };
  const stack = await call("processing.get", { ...drySelection, target });
  await apply(
    [
      {
        operation: "processing.set",
        target,
        steps: [...stack.steps, { processor: { type: "rnnoise" } }],
      },
    ],
    "learned",
  );
  const selection = { projectId, revisionId: revision.revisionId };
  report.selection = selection;
  const query = { ...selection, range: { startUs: 0, endUs: seconds * 1e6 }, limit: 250 };
  async function rows250() {
    const rows = [];
    let cursor,
      count = 0;
    do {
      const result = await poll(
        () =>
          call("timeline.events", {
            ...query,
            limit: 250 - rows.length,
            ...(cursor ? { cursor } : {}),
          }),
        (v) => v.state === "ready",
        "inspection",
      );
      rows.push(...result.page.rows);
      cursor = result.page.nextCursor;
      assert(++count <= 100, "bounded paging must advance");
    } while (rows.length < 250 && cursor);
    assert.equal(rows.length, 250);
    return rows;
  }
  const firstRows = await rows250(),
    samples = [];
  for (let i = 0; i < 20; i++) {
    const at = performance.now();
    assert.deepEqual(await rows250(), firstRows);
    samples.push(performance.now() - at);
  }
  const p95 = [...samples].sort((a, b) => a - b)[18];
  report.checks.inspection = { samples, p95Ms: p95, rows: 250 };
  assert(p95 <= 250, "existing cached250-row p95 budget");
  const start = performance.now();
  const prepared = await learnedWait(
    () => call("audio.prepare", selection),
    (v) => v.state === "ready",
    "learned preparation",
  );
  report.observations.prepareMs = performance.now() - start;
  report.prepared = prepared;
  assert.deepEqual(await call("audio.prepare", selection), prepared);
  const retained = await call("asset.get", { assetId: prepared.published.output.assetId });
  const fullPath = join(home, "library/assets", retained.id + ".wav");
  let wet;
  const referenceAt = performance.now();
  if (long) {
    phase = "independent C";
    independent.outputs = await referenceLanes(
      resolve(values.reference),
      independent.inputs,
      frames,
      out,
    );
    phase = "complete learned comparison";
    const sha256 = await compareWavePCM(fullPath, frames, independent.outputs);
    report.checks.independentLearned = {
      sha256,
      exact: true,
      frames,
      file: fullPath,
      fileSha256: await digest(fullPath),
    };
    assert.deepEqual(prepared.published.output.sampleRange, { start: 0, end: frames });
    assert(prepared.published.output.peakResidentBytes <= 4 * 1024 ** 3);
    report.checks.nativePreparationPeakRSS = prepared.published.output.peakResidentBytes;
  } else {
    const full = await readFile(fullPath);
    await writeFile(join(out, "prepared.wav"), full);
    wet = reference("combined", expected, 2);
    exactPCM(pcm(full), wet, "independent learned");
    report.checks.independentLearned = { sha256: hash(wet), exact: true, frames: wet.length / 8 };
  }
  report.observations.referenceMs = performance.now() - referenceAt;
  assert.deepEqual(await readdir(join(home, "library/render"), { recursive: true }), []);
  await service.stop();
  if (long) service.evidence = join(out, "native-restart");
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
    "media.audioCapabilities",
    ...(!long ? ["media.mixCompositionAudio"] : []),
  ]);
  await service.start();
  const lateStartUs = long ? (seconds - 1) * 1e6 : 7750000;
  const late = {
    ...(long ? selection : { assetId: retained.id, streamId: retained.streams[0].streamId }),
    range: { startUs: lateStartUs, endUs: seconds * 1e6 },
  };
  const lateResult = await audio(late, "retained-late");
  if (long) {
    await compareWavePCM(lateResult, 48000, independent.outputs, (seconds - 1) * 48000);
    const requests = [];
    for (const name of await readdir(join(out, "native")))
      if (name.startsWith("mix-"))
        requests.push(JSON.parse(await readFile(join(out, "native", name), "utf8")));
    const state = requests.find((v) => v.request.state)?.request.state;
    assert(state, "Actual learned request must retain its complete state domain");
    assert.deepEqual(
      state.domains.map((d) => d.sampleRange),
      [{ start: 0, end: frames }],
    );
    const replay = JSON.parse(await readFile(join(out, "native-restart/mix-0.json"), "utf8"));
    assert(replay.request.retained, "Project replay must use inherited prepared PCM");
    assert.equal(replay.request.state, undefined, "Prepared replay must not prepare fresh state");
    report.checks.state = {
      sampleRanges: state.domains.map((d) => d.sampleRange),
      clips: state.clips.length,
      retainedReplay: replay.request.retained,
      sourceWork: requests.find((v) => v.request.state).response.data?.sourceWork,
    };
    report.source.after = await digest(report.source.path);
    assert.equal(report.source.after, report.source.before);
  } else exactPCM(lateResult, wet.subarray(((lateStartUs * 48000) / 1e6) * 8), "retained late");
  assert.deepEqual(await readdir(join(home, "library/render"), { recursive: true }), []);
  report.checks.restart = {
    learnedCapabilitiesUnavailable: true,
    mixingUnavailable: !long,
    selector: long ? "matching-project-output" : "retained-asset",
    lateExact: true,
    renderScratchEmpty: true,
  };
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  if (priorUnavailableOperations === undefined) delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  else process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = priorUnavailableOperations;
  clearInterval(observer);
  while (observing) await new Promise((resolve) => setImmediate(resolve));
  if (progress) clearInterval(progress);
  try {
    await service.stop();
  } catch (error) {
    report.passed = false;
    report.shutdownFailure = error.message;
    shutdownFailure = error;
  }
  report.observations.sampledServicePeakRSS = peakRSS;
  report.observations.controllerPeakRSS = process.resourceUsage().maxRSS * 1024;
  report.serviceLogs = service.logs;
  try {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
if (shutdownFailure) throw shutdownFailure;
