import assert from "node:assert/strict";
import { verifyMixedMedia } from "./exact-mixed-media.mjs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";

assert(process.argv[2] && process.env.YAP_NATIVE);
const out = resolve(process.argv[2]);
await mkdir(out);
const home = await realpath(await mkdtemp("/tmp/yap-exact-admission-"));
const report = {
  passed: false,
  scope:
    "Exact public media admission, raw/project selection and portable metadata; no listening claim",
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  harnessSha256: hash(await readFile(import.meta.filename)),
  trace: [],
  exchanges: [],
  checks: {},
  assets: [],
};
let service = new JourneyService(home, report, join(out, "native"));
let receiver;
const call = (...args) => service.call(...args);
async function pcm(path) {
  const info = readAudioWaveFile(path),
    bytes = await readFile(path);
  return { ...info, pcm: bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes) };
}
function exact(numerator, denominator) {
  let a = numerator,
    b = denominator;
  while (b) [a, b] = [b, a % b];
  return denominator / a === 1
    ? numerator / a
    : { numerator: numerator / a, denominator: denominator / a };
}
async function audio(params, name, expected, format = { sampleRate: 48000, channels: 2 }) {
  const ready = await poll(
    () => call("audio.get", params),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, name + ".wav");
  await call("audio.get", params, { output: path });
  const result = await pcm(path);
  assert.equal(result.sampleRate, format.sampleRate, `${name}: sample rate`);
  assert.equal(result.channels, format.channels, `${name}: channel count`);
  if (expected) {
    assert.equal(result.frames, expected.length / (4 * format.channels), `${name}: frame count`);
    assert.deepEqual(result.pcm, expected, `${name}: complete PCM differs`);
  }
  const mcp = await service.mcp.callTool({ name: "audio.get", arguments: params });
  assert.equal(mcp.structuredContent.ok, true);
  assert.deepEqual(
    Buffer.from(mcp.content.find((v) => v.type === "audio").data, "base64"),
    await readFile(path),
  );
  report.checks[name] = {
    frames: result.frames,
    channels: result.channels,
    sampleRate: result.sampleRate,
    pcmSha256: hash(result.pcm),
    ready,
    mcpMatchesCLI: true,
    completePCMCompared: !!expected,
  };
  return result;
}
try {
  await service.start();
  await verifyMixedMedia({ service, report, out, audio });
  const authority = JSON.parse(
    await readFile(
      join(root, "specs/done/agent-editing/assets/03d-physical-authority/authority.json"),
      "utf8",
    ),
  );
  let accepted;
  for (const [name, frames, rate, expectedEnd] of [
    ["accepted-a", 246478, 48000, { numerator: 15404875, denominator: 3 }],
    ["44100-round-down", 44117, 44100, { numerator: 441170000, denominator: 441 }],
    ["44100-round-up", 44116, 44100, { numerator: 441160000, denominator: 441 }],
  ]) {
    const bytes =
      name === "accepted-a"
        ? await readFile(
            join(
              root,
              "specs/done/agent-editing/assets/13a-corrected-selections/internal-slower-0.8x.wav",
            ),
          )
        : gunzipSync(
            await readFile(
              join(root, `specs/done/agent-editing/assets/03d-physical-authority/${name}.wav.gz`),
            ),
          );
    assert.equal(hash(bytes), authority.cases.find((v) => v.name === name).sourceSha256);
    const path = join(out, name + ".wav");
    await writeFile(path, bytes);
    const original = await pcm(path);
    assert.equal(original.frames, frames);
    assert.equal(original.sampleRate, rate);
    assert.equal(original.channels, 1);
    assert.notEqual(original.pcm.readFloatLE(original.pcm.length - 4), 0);
    const pending = await call("asset.import", { path, requestId: randomUUID() });
    const job = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "ready",
      name + " import",
    );
    const asset = await call(
      "asset.get",
      { assetId: job.published.output.assetId },
      { transport: "mcp" },
    );
    assert.deepEqual(
      asset.streams[0].endUs,
      expectedEnd,
      `${name}: discovery rounded physical endpoint`,
    );
    const selection = { assetId: asset.id, streamId: asset.streams[0].id };
    const segments = await call("asset.segments", { ...selection, limit: 1 });
    assert.deepEqual(segments.segments[0].endUs, expectedEnd);
    report.assets.push({ name, sha256: hash(bytes), asset, segments });
    const format = { sampleRate: rate, channels: 1 };
    const tail = { startUs: exact((frames - 16) * 1000000, rate), endUs: expectedEnd };
    await audio(
      { ...selection, range: tail },
      name + "-late-before-full",
      original.pcm.subarray((frames - 16) * 4),
      format,
    );
    await audio(selection, name + "-default-full", original.pcm, format);
    await audio(
      { ...selection, range: { startUs: 0, endUs: expectedEnd } },
      name + "-exact-full",
      original.pcm,
      format,
    );
    const floorEnd = Math.floor((frames * 1000000) / rate);
    await audio(
      { ...selection, range: { startUs: 0, endUs: floorEnd } },
      name + "-explicit-floor",
      original.pcm.subarray(0, -4),
      format,
    );
    const refused = await call(
      "audio.get",
      { ...selection, range: { startUs: 0, endUs: floorEnd + 1 } },
      { error: true, transport: "mcp" },
    );
    assert.equal(refused.code, "INVALID_RANGE");
    const extracted = await poll(
      () => call("audio.extract", { ...selection, rendition: { sampleRate: rate, channels: 1 } }),
      (v) => v.state === "ready",
      name + " whole extraction",
    );
    assert.equal(
      extracted.published.output.assetId,
      asset.id,
      "Whole-source extraction must retain the byte-copy identity",
    );
    assert.deepEqual(extracted.published.output.durationUs, expectedEnd);
    const extractedAsset = await call("asset.get", {
      assetId: extracted.published.output.assetId,
    });
    const extractedPCM = await pcm(join(service.home, "library/assets", extractedAsset.fileName));
    assert.deepEqual(extractedPCM.pcm, original.pcm);
    assert.equal(extractedPCM.frames, frames);
    report.checks[name + "-extraction"] = {
      receipt: extracted,
      frames,
      pcmSha256: hash(extractedPCM.pcm),
      completePCMCompared: true,
      sameAssetIdentity: true,
    };
    if (name === "accepted-a") accepted = { asset, original, selection, expectedEnd, floorEnd };
  }
  const { asset, original, selection: source, expectedEnd, floorEnd } = accepted;
  const made = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  let revision = made.revision;
  async function edit(operations, transport = "cli") {
    const result = await call(
      "edit.apply",
      { projectId, expectedRevisionId: revision.id, requestId: randomUUID(), operations },
      { transport },
    );
    revision = result.revision;
    return result;
  }
  const projectEnd = { numerator: expectedEnd.numerator + 30000, denominator: 3 };
  const placed = await edit(
    [
      { operation: "track.add", label: "sound", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        label: "voice",
        clip: {
          trackId: { label: "sound" },
          assetId: asset.id,
          streamId: source.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: expectedEnd } },
          placement: { kind: "project", range: { startUs: 0, endUs: expectedEnd } },
          pitch: "preserve",
        },
      },
      {
        operation: "place",
        label: "tail",
        clip: {
          source: { kind: "silence" },
          trackId: { label: "sound" },
          placement: { kind: "project", range: { startUs: expectedEnd, endUs: projectEnd } },
        },
      },
    ],
    "mcp",
  );
  const stereo = Buffer.alloc((original.frames + 480) * 8);
  for (let f = 0; f < original.frames; f++)
    for (let c = 0; c < 2; c++) original.pcm.copy(stereo, f * 8 + c * 4, f * 4, f * 4 + 4);
  const selected = () => ({ projectId, revisionId: revision.id });
  const late = { startUs: 5000000, endUs: Math.ceil(projectEnd.numerator / 3) };
  await audio(
    { ...selected(), range: late },
    "project-late-before-full",
    stereo.subarray(240000 * 8),
  );
  await audio(selected(), "project-full", stereo);
  const originalDocument = structuredClone(revision.document);
  await edit([
    { operation: "split", clipIds: [placed.edit.labels.voice], atUs: 1000000, scope: "selected" },
  ]);
  await audio(selected(), "project-split", stereo);
  revision = await call("edit.undo", {
    projectId,
    expectedRevisionId: revision.id,
    requestId: randomUUID(),
  });
  assert.deepEqual(revision.document, originalDocument);
  const replace = (endUs) => ({
    operation: "replace",
    clipId: placed.edit.labels.voice,
    kind: "audio",
    media: {
      assetId: asset.id,
      streamId: source.streamId,
      source: { kind: "range", range: { startUs: 0, endUs } },
    },
    fit: "ripple",
    ripple: { trackIds: [placed.edit.labels.sound] },
  });
  await edit([replace(floorEnd)]);
  assert.equal(
    revision.document.clips.find((c) => c.id === placed.edit.labels.tail).placement.range.startUs,
    floorEnd,
  );
  await edit([replace(expectedEnd)], "mcp");
  assert.deepEqual(
    revision.document.clips.find((c) => c.id === placed.edit.labels.tail).placement.range.startUs,
    expectedEnd,
  );
  await audio(selected(), "project-replaced", stereo);
  const revisionBeforeFailure = revision.id;
  const bad = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: revision.id,
      requestId: randomUUID(),
      operations: [replace(floorEnd + 1)],
    },
    { error: true },
  );
  assert.equal(bad.code, "INVALID_EDIT");
  assert.equal((await call("project.get", { projectId })).currentRevisionId, revisionBeforeFailure);
  await poll(
    () => call("audio.prepare", selected()),
    (v) => v.state === "ready",
    "prepare exact project",
  );
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "exact-project.zip",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "export exact project",
  );
  await service.stop();
  await writeFile(join(out, "donor-service.log"), service.logs.join(""));
  receiver = await realpath(await mkdtemp("/tmp/yap-exact-receiver-"));
  service = new JourneyService(receiver, report, join(out, "receiver-native"));
  await service.start();
  const opened = await call("package.open", { path: exported.output });
  const openedReady = await poll(
    () => call("package.status", { admissionId: opened.id }),
    (v) => v.state === "ready",
    "open exact package",
  );
  const adoptionRequestId = randomUUID();
  const adopted = await poll(
    () =>
      call("package.adopt", {
        packageHandle: openedReady.packageHandle,
        requestId: adoptionRequestId,
      }),
    (v) => v.state === "ready",
    "adopt exact package",
  );
  const portableAsset = await call("asset.get", { assetId: asset.id });
  assert.deepEqual(portableAsset, asset);
  const portableSegments = await call("asset.segments", { ...source, limit: 1 });
  assert.deepEqual(portableSegments, report.assets[0].segments);
  const portableRevision = await call("revision.get", {
    projectId: adopted.published.output.projectId,
    revisionId: adopted.published.output.revisionId,
  });
  assert.deepEqual(portableRevision.revision.document, revision.document);
  report.portableExactMetadata = true;
  await call("package.close", { admissionId: opened.id });
  await audio(
    {
      projectId: adopted.published.output.projectId,
      revisionId: adopted.published.output.revisionId,
    },
    "portable-exact-full",
    stereo,
  );
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
      await writeFile(join(out, "service.log"), service.logs.join(""));
    } finally {
      await rm(home, { recursive: true, force: true });
      if (receiver) await rm(receiver, { recursive: true, force: true });
    }
  }
}
