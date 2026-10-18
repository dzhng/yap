import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { encodeJsonLine, REQUEST_FRAME_BYTES } from "@yap/protocol";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";
import { ControllerJourneyService } from "./controller-journey-service.mjs";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    primary: { type: "string" },
    camera: { type: "string" },
    pixels: { type: "string" },
    out: { type: "string" },
    controller: { type: "string" },
  },
});
assert.equal(values.case, "capture-to-project");
assert.equal(process.env.YAP_TEST_PROBE_OVERRIDES, undefined);
assert.equal(process.env.YAP_TEST_UNAVAILABLE_OPERATIONS, undefined);
assert.ok(
  (values.primary || values.controller) &&
    values.camera &&
    values.pixels &&
    values.out &&
    process.env.YAP_NATIVE,
);
const controllerFixture = values.controller
  ? JSON.parse(await readFile(resolve(values.controller), "utf8"))
  : null;
await mkdir(resolve(values.out));
const out = await realpath(resolve(values.out));
const home = await mkdtemp("/tmp/yap-webcam-project-");
const receiver = await mkdtemp("/tmp/yap-webcam-receiver-");
const report = {
  scope: controllerFixture
    ? "Public camera selection through actual controller/native prerecorded input and allocated source admission, explicit caller project, edits, delivery and relocation; no physical capture claim"
    : "Caller-authored project from supplied prerecorded captured sources; real admission, edits, delivery and relocation, no physical capture or allocation claim",
  passed: false,
  trace: [],
  exchanges: [],
  checks: {},
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  harnessSha256: hash(await readFile(import.meta.filename)),
  imagePixelsSha256: hash(await readFile(resolve(values.pixels))),
};
let serviceOrdinal = 0;
const startAt = (directory) =>
  controllerFixture && directory === home
    ? new ControllerJourneyService(directory, report, controllerFixture)
    : new JourneyService(directory, report, join(out, `native-${serviceOrdinal++}`));
let service = startAt(home);
const logs = [];
const call = (operation, params, options = {}) =>
  service.call(operation, params, { transport: "mcp", ...options });
const ready = (jobId) =>
  poll(
    () => call("job.get", { jobId }),
    (value) => value.state === "ready",
    "fixture admission",
  );
const range = (startUs, endUs) => ({ startUs, endUs });
const canvas = {
  width: 320,
  height: 120,
  fps: { numerator: 10, denominator: 1 },
  background: "#000000ff",
};
async function stop(crash = false) {
  try {
    await service.stop(crash);
  } finally {
    logs.push(...service.logs);
  }
}
async function restart() {
  await stop(true);
  service = startAt(home);
  await service.start();
}

// Discard the first reply bytes before decoding a receipt. Recovery must use the saved request.
async function loseReply(operation, params) {
  const request = { id: randomUUID(), operation, params };
  await new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Lost-reply fixture deadline"));
    }, 10000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    socket.once("data", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.connect(service.socketPath, () =>
      socket.write(encodeJsonLine(request, REQUEST_FRAME_BYTES)),
    );
  });
  report.exchanges.push({ request, response: "discarded before decoding" });
}
async function hashes(directory, members) {
  return Object.fromEntries(
    await Promise.all(
      members.map(async (name) => [name, hash(await readFile(join(directory, name)))]),
    ),
  );
}
async function admit(directory, requestId) {
  const params = { path: directory, requestId };
  const pending = await call("acquisition.import", params);
  const job = await ready(pending.jobId);
  const acquisition = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
  return { params, pending, acquisition };
}

async function image(params, name) {
  const file = join(out, name + ".png");
  const delivered = await poll(
    () => call("frame.get", params, { transport: "cli", output: file }),
    (value) => value.state === "ready",
    name,
  );
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: params });
  assert.equal(mcp.structuredContent.ok, true);
  const images = mcp.content.filter((item) => item.type === "image");
  assert.equal(images.length, 1);
  const bytes = await readFile(file);
  assert.deepEqual(Buffer.from(images[0].data, "base64"), bytes);
  const pixelFile = join(out, name + ".rgba");
  const { stdout } = await run(resolve(values.pixels), [file, pixelFile], { timeout: 30000 });
  const profile = JSON.parse(stdout);
  assert.equal(profile.opaque, true);
  const pixels = await readFile(pixelFile);
  const receipt = delivered.published.output;
  assert.equal(pixels.length, receipt.width * receipt.height * 4);
  const record = { name, sha256: hash(bytes), pixelsSha256: hash(pixels), profile, receipt };
  (report.pictures ??= []).push(record);
  return { pixels, receipt, record };
}
function half(pixels, side) {
  assert.equal(pixels.length, 320 * 120 * 4);
  const result = Buffer.alloc(160 * 120 * 4);
  for (let row = 0; row < 120; row++)
    pixels.copy(
      result,
      row * 160 * 4,
      (row * 320 + side * 160) * 4,
      (row * 320 + (side + 1) * 160) * 4,
    );
  return result;
}
function sameSourcePicture(actual, expected) {
  assert.equal(actual.length, expected.length);
  let maximum = 0,
    total = 0;
  for (let offset = 0; offset < actual.length; offset++) {
    const difference = Math.abs(actual[offset] - expected[offset]);
    maximum = Math.max(maximum, difference);
    total += difference;
  }
  // Source and composition contexts round independently to 8-bit sRGB. Same-path checks stay exact.
  assert.ok(maximum <= 1, `Source/composition raster difference exceeds one code: ${maximum}`);
  return { maximumChannelError: maximum, meanChannelError: total / actual.length };
}
async function audioOutput(projectId, revisionId, name) {
  const file = join(out, name + ".wav");
  await poll(
    () => call("audio.get", { projectId, revisionId }, { transport: "cli", output: file }),
    (value) => value.state === "ready",
    name,
  );
  const bytes = await readFile(file),
    header = waveHeader(bytes, bytes.length);
  const pcm = bytes.subarray(header.offset);
  (report.audio ??= []).push({
    name,
    sha256: hash(bytes),
    pcmSha256: hash(pcm),
    frames: header.frames,
  });
  return pcm;
}

try {
  let donor = join(home, "donor");
  let cameraDirectory;
  let allocated;
  let startRequest;
  if (controllerFixture) {
    await service.start();
    await service.fixtureCall("configure", { pending: "primary", cameraPrologue: false });
    startRequest = {
      requestId: "public-selected-camera",
      source: { kind: "display", displayId: 1 },
      cameraDeviceId: "fixture-camera",
      microphone: true,
    };
    allocated = await call("capture.start", startRequest);
    assert.equal(Object.hasOwn(allocated, "currentRevisionId"), false);
    donor = join(home, "library/recordings", allocated.recordingId, "source");
    cameraDirectory = join(home, "library/recordings", allocated.recordingId, "camera");
    await call("capture.pause", { recordingId: allocated.recordingId });
    await call("capture.stop", { recordingId: allocated.recordingId });
    const independent = await poll(
      () => call("recording.get", { recordingId: allocated.recordingId }),
      (value) =>
        value.publication.primary?.state === "pending" &&
        value.sourceAdmissions.find((source) => source.kind === "camera")?.job?.state === "ready",
      "camera ready before primary publication",
    );
    await service.fixtureCall("release");
    await call("capture.stop", { recordingId: allocated.recordingId });
    allocated = await poll(
      () => call("recording.get", { recordingId: allocated.recordingId }),
      (value) =>
        value.sourceAdmissions.length === 2 &&
        value.sourceAdmissions.every((source) => source.job?.state === "ready"),
      "allocated sources ready",
    );
    report.checks.publicSelection = {
      startRequest,
      independent,
      allocated,
      inspection: await service.fixtureCall("inspect.open"),
    };
  } else {
    await cp(resolve(values.primary), donor, { recursive: true });
    cameraDirectory = join(donor, "camera");
  }
  const replacement = join(home, "replacement-camera");
  await cp(resolve(values.camera), replacement, { recursive: true });
  const cameraMembers = [
    "video.mov",
    "capture.journal.jsonl",
    "camera.publication.json",
    "camera.mapping.jsonl",
  ];
  const primaryMembers = [
    "video.mov",
    "narration.mov",
    "capture.journal.jsonl",
    "narration.publication.json",
  ];
  const originalHashes = {
    primary: await hashes(donor, primaryMembers),
    camera: await hashes(cameraDirectory, cameraMembers),
    replacement: await hashes(replacement, cameraMembers),
  };
  const finished = async (directory, leaf) =>
    (await readFile(join(directory, leaf), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "finished").data;
  const capture = controllerFixture
    ? {
        ...(await finished(donor, "source.journal.jsonl")),
        camera: await finished(cameraDirectory, "capture.journal.jsonl"),
      }
    : JSON.parse(await readFile(join(donor, "native-result.json"), "utf8"));
  const cameraProof = JSON.parse(
    await readFile(join(cameraDirectory, "camera.publication.json"), "utf8"),
  );
  assert.equal(capture.hostOriginUs, capture.camera.hostOriginUs);
  assert.deepEqual(capture.pauses, capture.camera.pauses);
  assert.equal(cameraProof.originHostUs, capture.hostOriginUs);
  assert.equal(cameraProof.pictureTimeScale, 1000000);
  assert.equal(capture.tracks.find((track) => track.role === "video").samples, 5);
  assert.equal(capture.camera.tracks[0].samples, 5);
  assert.deepEqual(cameraProof.support, range(200000, 933333));
  assert.equal(cameraProof.observations.sha256, originalHashes.camera["camera.mapping.jsonl"]);
  assert.ok(cameraProof.journal.bytes && cameraProof.journal.sha256);
  const microphone = capture.tracks.find((track) => track.role === "narration");
  assert.deepEqual(
    [
      microphone.firstSampleUs,
      microphone.lastSampleEndUs,
      microphone.sampleRate,
      microphone.channelCount,
    ],
    [100001, 2100001, 48000, 1],
  );
  report.inputs = { originalHashes, capture, cameraProof };
  if (controllerFixture) {
    await cp(donor, join(out, "native-capture/primary"), { recursive: true });
    await cp(cameraDirectory, join(out, "native-capture/camera"), { recursive: true });
    report.inputs.specimen = {
      cameraPrologueEnabled: false,
      videoDeliveryIntervalMs: 10,
      source: controllerFixture.video,
      narration: controllerFixture.audio,
    };
  }

  if (!controllerFixture) await service.start();
  const admitted = async (kind, directory, requestId) => {
    if (!allocated) return admit(directory, requestId);
    const source = allocated.sourceAdmissions.find((value) => value.kind === kind);
    return {
      pending: { jobId: source.job.jobId },
      acquisition: await call("acquisition.get", { acquisitionId: source.acquisitionId }),
    };
  };
  const sources = {
    primary: await admitted("primary", donor, "primary-source"),
    camera: await admitted("camera", cameraDirectory, "camera-source"),
    replacement: await admit(replacement, "replacement-source"),
  };
  assert.deepEqual((await call("project.list", {})).projects, []);
  // Acquisition settlement is durable before any caller-owned project transaction begins.
  await restart();
  for (const source of Object.values(sources)) {
    if (source.params) {
      const replay = await call("acquisition.import", source.params, { transport: "cli" });
      assert.equal(replay.jobId, source.pending.jobId);
    }
    assert.deepEqual(
      await call("acquisition.get", { acquisitionId: source.acquisition.id }),
      source.acquisition,
    );
  }
  assert.deepEqual((await call("project.list", {})).projects, []);
  const sourceConflict = controllerFixture
    ? await call(
        "capture.start",
        { ...startRequest, cameraDeviceId: "another-camera" },
        { error: true },
      )
    : await call(
        "acquisition.import",
        { ...sources.primary.params, path: replacement },
        { error: true },
      );
  assert.equal(sourceConflict.code, "REQUEST_CONFLICT");
  if (controllerFixture) {
    const replay = await call("capture.start", startRequest);
    assert.equal(replay.recordingId, allocated.recordingId);
    assert.deepEqual(replay.camera, allocated.camera);
    assert.deepEqual(
      replay.sourceAdmissions.map((source) => source.acquisitionId),
      allocated.sourceAdmissions.map((source) => source.acquisitionId),
    );
  }
  report.checks.admissionBeforeProject = sources;

  const binding = (name, role) => {
    const acquisition = sources[name].acquisition;
    const value = acquisition.bindings.find((entry) => entry.sourceRoles.includes(role));
    assert.ok(value);
    return { ...value, acquisitionId: acquisition.id };
  };
  const screen = binding("primary", "video"),
    camera = binding("camera", "video"),
    audio = binding("primary", "narration"),
    alternate = binding("replacement", "video");
  report.checks.sourceColor = [];
  for (const source of [screen, camera]) {
    const asset = await call("asset.get", { assetId: source.assetId });
    const stream = asset.streams.find((value) => value.id === source.streamId);
    assert.deepEqual(
      [stream.colorPrimaries, stream.transferFunction, stream.ycbcrMatrix],
      ["ITU_R_709_2", "ITU_R_709_2", "ITU_R_709_2"],
    );
    report.checks.sourceColor.push(asset);
  }
  assert.equal(screen.sourceToAssetOffsetUs, 0);
  assert.equal(camera.sourceToAssetOffsetUs, -200000);
  assert.equal(audio.sourceToAssetOffsetUs, -100001);
  assert.deepEqual(camera.available, [range(0, 733333)]);
  assert.deepEqual(audio.available, [range(0, 2000000)]);
  assert.equal(sources.primary.acquisition.evidence.receipt.originHostUs, capture.hostOriginUs);
  assert.equal(sources.camera.acquisition.evidence.receipt.originHostUs, capture.hostOriginUs);
  assert.deepEqual(
    sources.camera.acquisition.evidence.receipt.publications.video.support,
    range(200000, 933333),
  );
  assert.deepEqual(sources.replacement.acquisition.evidence.receipt.header.cameraBinding, {
    recordingId: "fixture-take",
    sourceId: "fixture-camera-source",
    deviceId: "fixture-selected-device",
  });
  const create = {
    requestId: "explicit-project",
    title: "Caller-authored captured sources",
    canvas,
  };
  await loseReply("project.create", create);
  await restart();
  const created = await call("project.create", create, { transport: "cli" });
  const projectId = created.project.projectId;
  assert.equal(created.revision.ordinal, 0);
  assert.deepEqual(await call("project.create", create), created);
  assert.equal(
    (await call("project.create", { ...create, title: "conflicting title" }, { error: true })).code,
    "REQUEST_CONFLICT",
  );
  const select = ({ assetId, streamId, acquisitionId }) => ({ assetId, streamId, acquisitionId });
  const place = (label, source, sourceRange, projectRange) => ({
    operation: "place",
    label,
    clip: {
      trackId: { label: label + "-track" },
      ...select(source),
      source: { kind: "range", range: sourceRange },
      placement: { kind: "project", range: projectRange },
    },
  });
  const construct = {
    projectId,
    requestId: "explicit-composition",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "screen-track", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "camera-track", track: { kind: "video", order: 1 } },
      { operation: "track.add", label: "audio-track", track: { kind: "audio", order: 0 } },
      place("screen", screen, range(0, 1000000), range(0, 1000000)),
      place("camera", camera, range(0, 733333), range(200000, 933333)),
      place("audio", audio, range(0, 2000000), range(100001, 2100001)),
      {
        operation: "link",
        clipIds: [{ label: "screen" }, { label: "camera" }, { label: "audio" }],
      },
      ...["screen", "camera"].map((label, index) => ({
        operation: "processing.set",
        target: { kind: "clip", id: { label } },
        steps: [
          {
            processor: {
              type: "geometry",
              rect: { x: index * 160, y: 0, width: 160, height: 120 },
              fit: "stretch",
            },
          },
        ],
      })),
    ],
  };
  const failed = {
    ...construct,
    operations: [
      ...construct.operations,
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: "audio" } },
        steps: [{ id: "foreign-step", processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal((await call("edit.apply", failed, { error: true })).code, "INVALID_EDIT");
  assert.deepEqual((await call("revision.get", { projectId })).revision, created.revision);
  for (const source of Object.values(sources))
    assert.deepEqual(
      await call("acquisition.get", { acquisitionId: source.acquisition.id }),
      source.acquisition,
    );
  await loseReply("edit.apply", construct);
  await restart();
  const authored = await call("edit.apply", construct);
  assert.equal(authored.revision.ordinal, 1);
  assert.deepEqual(await call("edit.apply", construct, { transport: "cli" }), authored);
  assert.equal(
    (await call("edit.apply", { ...construct, operations: [] }, { error: true })).code,
    "REQUEST_CONFLICT",
  );
  assert.equal(
    (await call("edit.apply", { ...construct, requestId: "stale-composition" }, { error: true }))
      .code,
    "STALE_REVISION",
  );
  const ids = authored.edit.labels;
  assert.deepEqual(authored.revision.document.syncGroups[0].clipIds, [
    ids.screen,
    ids.camera,
    ids.audio,
  ]);
  report.checks.authoring = {
    create,
    created,
    construct,
    authored,
    failedConstructionAtomic: true,
  };
  let head = authored.revision.revisionId;
  const references = new Map();
  for (const [role, source, times] of [
    ["screen", screen, [0, 100000, 200000, 500000, 700000]],
    ["camera", camera, [0, 100000, 200000, 500000, 700000]],
  ]) {
    for (const atUs of times) {
      const frame = await image(
        { ...select(source), atUs, maxLongEdge: 160 },
        `source-${role}-${atUs}`,
      );
      assert.equal(frame.receipt.actualSourceUs, atUs);
      assert.equal(frame.receipt.sample.originUs, role === "camera" ? 200000 : 0);
      assert.equal(
        BigInt(frame.receipt.sample.value) * 1000000n,
        BigInt(atUs + (role === "camera" ? 200000 : 0)) * BigInt(frame.receipt.sample.timescale),
      );
      assert.deepEqual([frame.receipt.width, frame.receipt.height], [160, 120]);
      references.set(`${role}-${atUs}`, frame.pixels);
    }
  }
  // Source times are literal fixture landmarks, independent of the composition planner.
  const landmarks = [
    [0, 0, null],
    [100000, 100000, null],
    [200000, 200000, 0],
    [300000, 200000, 100000],
    [500000, 500000, 200000],
    [700000, 700000, 500000],
    [900000, 700000, 700000],
    [1000000, null, null],
    [2100000, null, null],
  ];
  const black = Buffer.alloc(160 * 120 * 4);
  for (let offset = 3; offset < black.length; offset += 4) black[offset] = 255;
  const baselineFrames = new Map();
  for (const [atUs, screenUs, cameraUs] of landmarks) {
    const frame = await image({ projectId, revisionId: head, atUs }, `baseline-${atUs}`);
    assert.equal(frame.receipt.frame.sampleAtUs, atUs);
    assert.deepEqual(
      frame.receipt.frame.visibleRange,
      range(atUs, Math.min(atUs + 100000, 2100001)),
    );
    assert.deepEqual(
      frame.receipt.pictures.map((picture) => [picture.clipId, picture.status]),
      [
        screenUs === null ? null : [ids.screen, "available"],
        cameraUs === null ? null : [ids.camera, "available"],
      ].filter(Boolean),
    );
    frame.record.sourceComparisons = [];
    for (const [side, role, sourceUs] of [
      [0, "screen", screenUs],
      [1, "camera", cameraUs],
    ]) {
      if (sourceUs === null) assert.deepEqual(half(frame.pixels, side), black);
      else
        frame.record.sourceComparisons.push({
          role,
          sourceUs,
          ...sameSourcePicture(half(frame.pixels, side), references.get(`${role}-${sourceUs}`)),
        });
    }
    baselineFrames.set(atUs, frame);
  }
  const expectedPCM = Buffer.alloc(100800 * 8);
  for (let frame = 0; frame < 96000; frame++)
    for (let channel = 0; channel < 2; channel++)
      expectedPCM.writeFloatLE(
        (((frame * 97) % 1009) - 504) / 1024,
        (4800 + frame) * 8 + channel * 4,
      );
  const baselinePCM = await audioOutput(projectId, head, "baseline");
  assert.deepEqual(
    baselinePCM,
    expectedPCM,
    "Common-clock microphone placement must retain all 96,000 authored samples",
  );
  const audioMCP = await service.mcp.callTool({
    name: "audio.get",
    arguments: { projectId, revisionId: head },
  });
  assert.equal(audioMCP.structuredContent.ok, true);
  const inlineAudio = audioMCP.content.filter((part) => part.type === "audio");
  assert.equal(inlineAudio.length, 1);
  assert.deepEqual(
    Buffer.from(inlineAudio[0].data, "base64"),
    await readFile(join(out, "baseline.wav")),
  );
  const shifted = Buffer.concat([Buffer.alloc(8), expectedPCM.subarray(0, -8)]);
  assert.throws(() => assert.deepEqual(baselinePCM, shifted));
  assert.throws(() =>
    sameSourcePicture(half(baselineFrames.get(100000).pixels, 1), references.get("camera-0")),
  );
  assert.throws(() =>
    sameSourcePicture(half(baselineFrames.get(0).pixels, 0), references.get("screen-100000")),
  );
  report.checks.exactBaseline = {
    projectDurationUs: 2100001,
    leadingSilentFrames: 4800,
    microphoneFrames: 96000,
    expectedPCMSha256: hash(expectedPCM),
    negativeControls: [
      "one-sample audio shift",
      "camera independently zeroed",
      "wrong source picture",
    ],
    landmarks,
  };

  const importedAudio = await call("asset.import", {
    requestId: "replacement-audio",
    path: join(root, "specs/done/agent-editing/assets/00-corpus/b-audio.wav"),
  });
  const audioReady = await ready(importedAudio.jobId);
  const alternateAudio = await call("asset.get", { assetId: audioReady.published.output.assetId });
  const { stdout: replacementMono } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      join(root, "specs/done/agent-editing/assets/00-corpus/b-audio.wav"),
      "-map",
      "0:a:0",
      "-c:a",
      "pcm_f32le",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(replacementMono.length, 96000 * 4);
  const replacementPCM = Buffer.alloc(expectedPCM.length);
  for (let frame = 0; frame < 96000; frame++)
    for (let channel = 0; channel < 2; channel++)
      replacementMono.copy(
        replacementPCM,
        (4800 + frame) * 8 + channel * 4,
        frame * 4,
        frame * 4 + 4,
      );
  assert.notDeepEqual(replacementPCM, baselinePCM);
  const historyFrames = [];
  for (const role of ["camera", "screen", "audio"]) {
    const operation = {
      operation: "replace",
      clipId: ids[role],
      kind: role === "audio" ? "audio" : "video",
      ...(role === "audio" ? {} : { fit: "stretch" }),
      media:
        role === "audio"
          ? {
              assetId: alternateAudio.id,
              streamId: alternateAudio.streams.find((stream) => stream.kind === "audio").streamId,
              source: { kind: "range", range: range(0, 2000000) },
            }
          : {
              ...select(alternate),
              source: { kind: "range", range: range(0, 100000) },
            },
    };
    const replaced = await call(
      "edit.apply",
      {
        projectId,
        requestId: `replace-${role}`,
        expectedRevisionId: head,
        operations: [operation],
      },
      { transport: "cli" },
    );
    head = replaced.revision.revisionId;
    for (const clip of authored.revision.document.clips.filter((clip) => clip.id !== ids[role]))
      assert.deepEqual(
        replaced.revision.document.clips.find((value) => value.id === clip.id),
        clip,
      );
    assert.deepEqual(replaced.revision.document.syncGroups, authored.revision.document.syncGroups);
    assert.deepEqual(replaced.revision.document.processing, authored.revision.document.processing);
    const frame = await image({ projectId, revisionId: head, atUs: 200000 }, `replaced-${role}`);
    const baseline = baselineFrames.get(200000).pixels;
    if (role === "audio") assert.deepEqual(frame.pixels, baseline);
    else {
      const side = role === "camera" ? 1 : 0;
      assert.deepEqual(half(frame.pixels, 1 - side), half(baseline, 1 - side));
      assert.notDeepEqual(half(frame.pixels, side), half(baseline, side));
      const picture = frame.receipt.pictures.find((value) => value.clipId === ids[role]);
      assert.equal(picture.assetId, alternate.assetId);
      assert.equal(picture.requestedSourceUs, role === "camera" ? 0 : 20000);
    }
    assert.deepEqual(
      await audioOutput(projectId, head, `replaced-${role}`),
      role === "audio" ? replacementPCM : baselinePCM,
    );
    historyFrames.push({
      role,
      ordinal: replaced.revision.ordinal,
      pixels: frame.pixels,
      revision: replaced.revision,
    });
    const undo = await call("edit.undo", {
      projectId,
      requestId: `undo-${role}`,
      expectedRevisionId: head,
    });
    head = undo.id;
    assert.deepEqual(undo.document, authored.revision.document);
    assert.deepEqual(
      (await image({ projectId, revisionId: head, atUs: 200000 }, `undo-${role}`)).pixels,
      baseline,
    );
    assert.deepEqual(await audioOutput(projectId, head, `undo-${role}`), baselinePCM);
  }
  report.checks.replacements = historyFrames.map(({ pixels, ...value }) => ({
    ...value,
    pixelsSha256: hash(pixels),
  }));
  const history = await call("revision.history", { projectId });
  assert.equal(history.nextCursor, null);
  for (const [name, directory, members] of [
    ["primary", donor, primaryMembers],
    ["camera", cameraDirectory, cameraMembers],
    ["replacement", replacement, cameraMembers],
  ])
    assert.deepEqual(await hashes(directory, members), originalHashes[name]);
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    exportId,
    directory: out,
    leaf: "project.zip",
    kind: "processed-package",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (value) => value.state === "ready",
    "editable project export",
  );
  const packagePath = join(out, "relocated-project.zip");
  await rename(exported.output, packagePath);
  await stop();
  await rm(home, { recursive: true });
  service = startAt(receiver);
  await service.start();
  const opened = await call("package.open", { path: packagePath });
  const packageReady = await poll(
    () => call("package.status", { admissionId: opened.id }),
    (value) => value.state === "ready",
    "relocated project admission",
  );
  const adoption = await poll(
    () =>
      call("package.adopt", {
        packageHandle: packageReady.packageHandle,
        requestId: "adopt-project",
      }),
    (value) => value.state === "ready",
    "relocated project adoption",
  );
  await call("package.close", { admissionId: opened.id });
  const packageSHA256 = hash(await readFile(packagePath));
  await rm(packagePath);
  const relocatedProject = adoption.published.output.projectId;
  const relocatedHistory = await call("revision.history", { projectId: relocatedProject });
  assert.equal(relocatedHistory.nextCursor, null);
  assert.deepEqual(
    relocatedHistory.revisions.map((revision) => revision.document),
    history.revisions.map((revision) => revision.document),
  );
  for (const source of Object.values(sources)) {
    const relocated = await call("acquisition.get", { acquisitionId: source.acquisition.id });
    const { file: donorLocation, ...before } = source.acquisition.evidence.receipt;
    const { file: receiverLocation, ...after } = relocated.evidence.receipt;
    assert.notEqual(receiverLocation, donorLocation);
    assert.deepEqual(after, before);
    assert.deepEqual(relocated.bindings, source.acquisition.bindings);
  }
  const relocatedHead = (await call("project.get", { projectId: relocatedProject }))
    .currentRevisionId;
  assert.deepEqual(
    await audioOutput(relocatedProject, relocatedHead, "relocated-current"),
    baselinePCM,
  );
  for (const { role, ordinal, pixels } of historyFrames) {
    const revision = relocatedHistory.revisions.find((value) => value.ordinal === ordinal);
    assert.deepEqual(
      (
        await image(
          { projectId: relocatedProject, revisionId: revision.revisionId, atUs: 200000 },
          `relocated-${role}`,
        )
      ).pixels,
      pixels,
    );
    assert.deepEqual(
      await audioOutput(relocatedProject, revision.revisionId, `relocated-${role}`),
      role === "audio" ? replacementPCM : baselinePCM,
    );
  }
  const restored = await call("edit.restore", {
    projectId: relocatedProject,
    requestId: "relocated-restore",
    expectedRevisionId: relocatedHead,
    targetRevisionId: relocatedHistory.revisions.find(
      (revision) => revision.ordinal === historyFrames[0].ordinal,
    ).id,
  });
  assert.deepEqual(restored.document, historyFrames[0].revision.document);
  const undone = await call("edit.undo", {
    projectId: relocatedProject,
    requestId: "relocated-undo",
    expectedRevisionId: restored.id,
  });
  assert.deepEqual(undone.document, authored.revision.document);
  assert.deepEqual(await audioOutput(relocatedProject, undone.id, "relocated-undo"), baselinePCM);
  report.checks.portable = {
    packageSHA256,
    projectId: relocatedProject,
    originalHomeRemoved: true,
    archiveRemoved: true,
    completeHistoryDocumentsEqual: true,
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await stop().catch((error) => {
    report.passed = false;
    report.shutdownError = error.message;
  });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), logs.join(""));
  await rm(home, { recursive: true, force: true });
  await rm(receiver, { recursive: true, force: true });
}
assert.equal(report.passed, true);
