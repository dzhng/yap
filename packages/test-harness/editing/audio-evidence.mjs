import { verifyAcousticRetiming } from "./acoustic-retiming.mjs";
import { verifyAcousticRateAxes } from "./acoustic-rate-axes.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { JourneyService, acquisitionDonor, hash, poll, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" }, fixture: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Use a frozen native worker");
assert.ok(!values.fixture || ["tones-and-clicks", "retimed-tones"].includes(values.fixture));
// Analytically authored tones/clicks: no speech model or subjective listening claim.
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "acoustic-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-acoustic-"));
const report = { passed: false, trace: [], artifacts: [], checks: {} };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const rate = 48000,
  frames = rate,
  impulse = 30000;
const sample = (frame, channel) =>
  Math.fround(
    frame === impulse && channel === 1
      ? 0.75
      : ((channel ? 0.0625 : 0.125) / 1024) *
          Math.cos((2 * Math.PI * (channel ? 3000 : 750) * frame) / rate),
  );
const wave = Buffer.alloc(44 + frames * 8);
wave.write("RIFF");
wave.writeUInt32LE(wave.length - 8, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(3, 20);
wave.writeUInt16LE(2, 22);
wave.writeUInt32LE(rate, 24);
wave.writeUInt32LE(rate * 8, 28);
wave.writeUInt16LE(8, 32);
wave.writeUInt16LE(32, 34);
wave.write("data", 36);
wave.writeUInt32LE(frames * 8, 40);
for (let i = 0; i < frames; i++)
  for (let c = 0; c < 2; c++) wave.writeFloatLE(sample(i, c), 44 + i * 8 + c * 4);
let ordinal = 0;
async function delivered(operation, params, expectedRate = rate) {
  const ready = await poll(
    () => call(operation, params, { transport: "mcp" }),
    (v) => v.state === "ready",
    operation,
  );
  const image = operation === "spectrogram.get" || params.format === "image";
  const name = `${String(ordinal++).padStart(2, "0")}-${operation.split(".")[0]}.${image ? "png" : "json"}`;
  const receipt = await call(operation, params, { output: join(out, name) });
  const bytes = await readFile(join(out, name));
  const mcp = await service.mcp.callTool({ name: operation, arguments: params });
  assert.equal(mcp.structuredContent.ok, true, JSON.stringify(mcp.structuredContent));
  const contents = mcp.content.filter((v) => v.type === (image ? "image" : "text"));
  if (image) {
    assert.equal(contents.length, 1);
    assert.equal(contents[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(contents[0].data, "base64"), bytes);
  } else {
    assert.equal(contents.length, 2);
    assert.equal(contents[1].text, bytes.toString());
  }
  const metadata = receipt.published.output;
  assert.equal(metadata.bytes, bytes.length);
  assert.deepEqual(metadata.sampleRange, ready.published.output.sampleRange);
  assert.equal(metadata.channels, 2);
  assert.equal(metadata.sampleRate, expectedRate);
  report.artifacts.push({ name, sha256: hash(bytes), metadata, jobId: receipt.jobId });
  return {
    metadata,
    bytes,
    name,
    jobId: receipt.jobId,
    ...(image ? {} : { document: JSON.parse(bytes) }),
  };
}
function verifyBuckets(document, gain = 1, range = { startUs: 0, endUs: 1000000 }) {
  const start = Math.floor((range.startUs * rate) / 1000000),
    end = Math.floor((range.endUs * rate) / 1000000);
  assert.deepEqual(document.sampleRange, { start, end });
  let next = start;
  for (const b of document.buckets) {
    assert.equal(b.sampleRange.start, next);
    assert.equal(b.gridStart, Math.floor(next / document.bucketFrames) * document.bucketFrames);
    const right = Math.min(end, b.gridStart + document.bucketFrames);
    assert.equal(b.sampleRange.end, right);
    assert.equal(b.partial, right - next !== document.bucketFrames);
    next = right;
  }
  assert.equal(next, end);
  for (const b of document.buckets)
    for (let c = 0; c < 2; c++) {
      const v = Array.from({ length: b.sampleRange.end - b.sampleRange.start }, (_, i) =>
        Math.fround(sample(i + b.sampleRange.start, c) * gain),
      );
      assert.deepEqual(b.channels[c], {
        min: Math.min(...v),
        max: Math.max(...v),
        rms: Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length),
      });
    }
}
async function pixels(artifact) {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", join(out, artifact.name), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const m = artifact.metadata;
  assert.equal(stdout.length, m.width * m.height * 3);
  return (x, y) => [
    ...stdout.subarray(
      (Math.floor(y) * m.width + Math.floor(x)) * 3,
      (Math.floor(y) * m.width + Math.floor(x)) * 3 + 3,
    ),
  ];
}
async function verifyImages(waveform, spectrum, gain) {
  const m = waveform.metadata,
    p = await pixels(waveform),
    limit = Math.max(1, 0.75 * gain * 1.05);
  assert.equal(m.amplitudeLimit, limit);
  const x =
    m.plotLeft +
    ((impulse - m.sampleRange.start) / (m.sampleRange.end - m.sampleRange.start)) * m.plotWidth;
  const peakY =
    m.plotTop + m.panelStride + m.panelHeight / 2 - (((0.75 * gain) / limit) * m.panelHeight) / 2;
  assert.ok(
    p(x + 1, peakY + 2)[2] < 230,
    "project waveform peak pixels disagree with selected tap",
  );
  assert.ok(p(x + 1, peakY - 3)[0] > 240, "project waveform exceeds independently expected peak");
  const q = await pixels(spectrum),
    a = spectrum.metadata;
  for (let channel = 0; channel < 2; channel++) {
    const bin = channel ? 32 : 8;
    let re = 0,
      im = 0,
      power = 0;
    for (let j = 0; j < 512; j++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / 512),
        v = Math.fround(sample(19456 + j, channel) * gain) * w;
      re += v * Math.cos((2 * Math.PI * bin * j) / 512);
      im -= v * Math.sin((2 * Math.PI * bin * j) / 512);
      power += w * w;
    }
    const density = (2 * (re * re + im * im)) / (rate * power),
      db = 10 * Math.log10(density);
    const expected = Math.round(
      255 *
        Math.max(0, Math.min(1, (db - a.densityFloorDb) / (a.densityCeilingDb - a.densityFloorDb))),
    );
    assert.ok(
      expected > 10 && expected < 245,
      "spectral oracle must remain unsaturated and distinguishable",
    );
    const px =
      a.plotLeft +
      ((0.41 * rate - a.sampleRange.start) / (a.sampleRange.end - a.sampleRange.start)) *
        a.plotWidth;
    const py =
      a.plotTop +
      channel * a.panelStride +
      a.panelHeight * (1 - (channel ? 3000 : 750) / (rate / 2));
    assert.ok(
      Math.abs(q(px, py)[0] - expected) <= 3,
      `project spectral power mismatch gain=${gain} channel=${channel}: ${q(px, py)[0]} expected ${expected}`,
    );
  }
}

async function unitRateJourney() {
  const source = join(out, "reference.wav");
  await writeFile(source, wave);
  const imported = await call("asset.import", { requestId: "acoustic-source", path: source });
  await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: hash(wave) }),
    stream = asset.streams.find((v) => v.kind === "audio");
  assert.ok(stream);
  const selection = { assetId: asset.id, streamId: stream.id };
  const full = await delivered("waveform.get", { ...selection, bucketFrames: 48 });
  verifyBuckets(full.document);
  const range = { startUs: 333333, endUs: 799999 };
  const detail = await delivered("waveform.get", { ...selection, range, bucketFrames: 48 });
  verifyBuckets(detail.document, 1, range);
  for (const b of detail.document.buckets.filter((v) => !v.partial))
    assert.deepEqual(
      b,
      full.document.buckets.find((v) => v.gridStart === b.gridStart),
    );
  const picture = await delivered("waveform.get", {
    ...selection,
    range,
    bucketFrames: 48,
    format: "image",
  });
  assert.deepEqual(picture.metadata.sampleRange, detail.document.sampleRange);
  assert.equal(picture.metadata.measurements.jobId, detail.jobId);
  const wp = await pixels(picture),
    wm = picture.metadata;
  const x =
    wm.plotLeft +
    ((impulse - wm.sampleRange.start) / (wm.sampleRange.end - wm.sampleRange.start)) * wm.plotWidth;
  assert.ok(
    wp(x + 1, wm.plotTop + wm.panelStride + wm.panelHeight * 0.25)[2] < 230,
    "known right-channel click missing",
  );
  assert.ok(wp(x + 1, wm.plotTop + wm.panelHeight * 0.25)[0] > 240, "click moved to wrong channel");
  const spectrum = await delivered("spectrogram.get", {
    ...selection,
    fftFrames: 512,
    hopFrames: 512,
  });
  const sp = await pixels(spectrum),
    sm = spectrum.metadata;
  const y = (c, hz) => sm.plotTop + c * sm.panelStride + sm.panelHeight * (1 - hz / (rate / 2));
  assert.ok(sp(300, y(0, 750))[0] > sp(300, y(0, 3000))[0] + 10, "left tone misplaced");
  assert.ok(sp(300, y(1, 3000))[0] > sp(300, y(1, 750))[0] + 10, "right tone misplaced");
  const spectralDetail = await delivered("spectrogram.get", {
    ...selection,
    range,
    fftFrames: 512,
    hopFrames: 512,
  });
  assert.deepEqual(spectralDetail.metadata.sampleRange, detail.document.sampleRange);
  report.checks.source = {
    absoluteImpulseSample: impulse,
    absoluteImpulseSeconds: impulse / rate,
    fullRangeBucketAgreement: true,
    independentTonePixels: true,
    imageAndJsonClockAgreement: true,
  };
  const donor = join(home, "context-donor");
  const journalHash = await acquisitionDonor(donor, source, [
    { startUs: 0, endUs: 496000 },
    { startUs: 500000, endUs: 1000000 },
  ]);
  const importing = await call("acquisition.import", {
    requestId: "spectral-context",
    path: donor,
  });
  const importedContext = await poll(
    () => call("job.get", { jobId: importing.jobId }),
    (v) => v.state === "ready",
    "context import",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: importedContext.target.acquisitionId,
  });
  assert.equal(acquisition.journal.sha256, journalHash);
  const binding = acquisition.bindings.find((v) => v.sourceRoles.includes("narration"));
  assert.ok(binding);
  await rm(donor, { recursive: true, force: true });
  const contextRange = { startUs: 500000, endUs: 600000 };
  const cleanContext = await delivered("spectrogram.get", {
    ...selection,
    range: contextRange,
    fftFrames: 1024,
    hopFrames: 512,
  });
  const maskedContext = await delivered("spectrogram.get", {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
    range: contextRange,
    fftFrames: 1024,
    hopFrames: 512,
  });
  assert.deepEqual(maskedContext.metadata.unavailable, []);
  assert.ok(
    maskedContext.metadata.context.unavailable.some(
      (v) => v.startUs === 496000 && v.endUs === 500000,
    ),
  );
  const clearPixels = await pixels(cleanContext),
    missingPixels = await pixels(maskedContext),
    m = maskedContext.metadata;
  for (let c = 0; c < 2; c++) {
    const x = m.plotLeft + 2,
      y = m.plotTop + c * m.panelStride + 1;
    assert.ok(
      missingPixels(x, y)[0] > 180 && missingPixels(x, y)[1] > 80,
      "missing FFT context has no orange warning",
    );
    assert.ok(clearPixels(x, y)[0] < 100, "fully supported context incorrectly marked incomplete");
  }
  report.checks.maskedFftContext = {
    displayUnavailable: [],
    contextUnavailable: maskedContext.metadata.context.unavailable,
    maskedImage: maskedContext.name,
    cleanImage: cleanContext.name,
  };
  const created = await call("project.create", {
    requestId: "acoustic-project",
    title: "Acoustic evidence",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId,
    ref = (label) => ({ label });
  const scopes = [
    ["clip", "voice-clip", 4],
    ["track", "voice", 8],
    ["group", "inner", 16],
    ["group", "outer", 32],
    ["output", "output", 64],
  ];
  const placed = await call("edit.apply", {
    projectId,
    requestId: "route",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "group.add", label: "outer", group: { kind: "audio", order: 0 } },
      {
        operation: "group.add",
        label: "inner",
        group: { kind: "audio", order: 0, parentId: ref("outer") },
      },
      {
        operation: "track.add",
        label: "voice",
        track: { kind: "audio", order: 0, parentId: ref("inner") },
      },
      {
        operation: "place",
        label: "voice-clip",
        clip: {
          trackId: ref("voice"),
          assetId: asset.id,
          streamId: stream.id,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      ...scopes.map(([kind, label, gain]) => ({
        operation: "processing.set",
        target: kind === "output" ? { kind } : { kind, id: ref(label) },
        steps: [
          { label: `gain-${label}`, processor: { type: "gain", gain } },
          { label: `bypass-${label}`, enabled: false, processor: { type: "gain", gain: 99 } },
          { label: `half-${label}`, processor: { type: "gain", gain: 0.5 } },
        ],
      })),
    ],
  });
  const revisionId = placed.revision.id;
  report.project = { projectId, revisionId };
  report.checks.taps = [];
  for (const [index, [kind, label, factor]] of scopes.entries())
    for (const mode of ["dry", "after-step", "processed"]) {
      const tap = {
        target: kind === "output" ? { kind } : { kind, id: placed.edit.labels[label] },
        point:
          mode === "after-step"
            ? { kind: mode, stepId: placed.edit.labels[`gain-${label}`] }
            : { kind: mode },
      };
      const params = { projectId, revisionId, range, tap };
      const json = await delivered("waveform.get", { ...params, bucketFrames: 48 });
      const gain =
        scopes.slice(0, index).reduce((v, row) => v * row[2] * 0.5, 1) *
        (mode === "dry" ? 1 : factor * (mode === "processed" ? 0.5 : 1));
      verifyBuckets(json.document, gain, range);
      const png = await delivered("waveform.get", { ...params, bucketFrames: 48, format: "image" });
      const spec = await delivered("spectrogram.get", {
        ...params,
        fftFrames: 512,
        hopFrames: 512,
      });
      for (const a of [png, spec]) {
        assert.equal(a.metadata.revisionId, revisionId);
        assert.deepEqual(a.metadata.tap, tap);
        assert.deepEqual(a.metadata.sampleRange, json.document.sampleRange);
        assert.ok(a.metadata.provenance.some((v) => v.includes(revisionId)));
      }
      assert.equal(png.metadata.measurements.jobId, json.jobId);
      await verifyImages(png, spec, gain);
      report.checks.taps.push({ label, mode, waveform: png.name, spectrum: spec.name });
    }
  const retryParams = { ...selection, range, bucketFrames: 49 };
  await delivered("waveform.get", retryParams);
  const held = await service.arm("media.acousticImage");
  const pending = await call("waveform.get", { ...retryParams, format: "image" });
  await held();
  await call("job.cancel", { jobId: pending.jobId });
  const canceledJob = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "canceled",
    "image cancellation",
  );
  const terminal = await call("waveform.get", { ...retryParams, format: "image" });
  assert.equal(terminal.state, "idle");
  assert.equal(terminal.reason, "canceled");
  assert.equal(terminal.jobId, pending.jobId);
  assert.equal(terminal.retryable, true);
  const repeated = await call("waveform.get", { ...retryParams, format: "image" });
  assert.equal(repeated.state, "idle");
  assert.equal(repeated.reason, "canceled");
  const stillCanceled = await call("job.get", { jobId: pending.jobId });
  assert.equal(stillCanceled.state, "canceled");
  assert.equal(stillCanceled.generation, canceledJob.generation);
  assert.deepEqual(
    await readdir(join(home, "library/render")),
    [],
    "canceled image attempt leaked",
  );
  await call("job.retry", { jobId: pending.jobId });
  const retried = await delivered("waveform.get", { ...retryParams, format: "image" });
  assert.equal(retried.jobId, pending.jobId);
  assert.deepEqual(await readdir(join(home, "library/render")), [], "retried image attempt leaked");
  report.checks.realImageCancelRetry = true;
  const pinnedParams = { projectId, revisionId, range, fftFrames: 512, hopFrames: 512 };
  const pinned = await delivered("spectrogram.get", pinnedParams);
  const changed = await call("edit.apply", {
    projectId,
    requestId: "head-change",
    expectedRevisionId: revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.25 } }],
      },
    ],
  });
  const headJson = await delivered("waveform.get", { projectId, range, bucketFrames: 48 });
  assert.equal(headJson.metadata.revisionId, changed.revision.id);
  verifyBuckets(headJson.document, 256, range);
  const headPng = await delivered("waveform.get", {
    projectId,
    range,
    bucketFrames: 48,
    format: "image",
  });
  const headSpec = await delivered("spectrogram.get", {
    projectId,
    range,
    fftFrames: 512,
    hopFrames: 512,
  });
  await verifyImages(headPng, headSpec, 256);
  const historical = await delivered("spectrogram.get", pinnedParams);
  assert.deepEqual(historical.bytes, pinned.bytes);
  report.checks.historyAfterHeadChange = true;
  await service.stop();
  await service.start();
  const restarted = await delivered("spectrogram.get", {
    ...selection,
    range,
    fftFrames: 512,
    hopFrames: 512,
  });
  assert.deepEqual(restarted.bytes, spectralDetail.bytes);
  const restartedProject = await delivered("spectrogram.get", pinnedParams);
  assert.deepEqual(restartedProject.bytes, pinned.bytes);
  assert.deepEqual(await readFile(source), wave);
  report.checks.restartPinnedBytes = true;
  assert.deepEqual(
    await readdir(join(home, "library/render")),
    [],
    "render attempt or sidecar leaked",
  );
  report.checks.renderWorkspaceClean = true;
  if (process.env.YAP_ACOUSTIC_RATES)
    report.checks.rateAxes = await verifyAcousticRateAxes({ out, call, delivered });
}

try {
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  await service.start();
  if (values.fixture === "retimed-tones") {
    report.checks.retiming = await verifyAcousticRetiming({ out, call, delivered, pixels });
  } else {
    await unitRateJourney();
  }
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
      await writeFile(join(out, "service.log"), service.logs.join(""));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ out, passed: report.passed }));
