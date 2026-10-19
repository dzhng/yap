import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ControllerJourneyService } from "./controller-journey-service.mjs";
import { poll } from "./source-evidence-fixture.mjs";

/**
 * capture.setCamera through the app's real capture controller, host channel and service, from the
 * CLI and MCP, then the toggled camera through admission, composition, frame delivery and crash
 * recovery. Only the camera device and the screen are prerecorded.
 */
const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "executable", "native", "video"].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of ["out", "executable", "native", "video"]) assert.ok(values[name], name);
const out = resolve(values.out);
await mkdir(out);
const fixture = Object.fromEntries(
  ["executable", "native", "video"].map((name) => [name, resolve(values[name])]),
);
const home = join(out, "home");
const report = { passed: false, trace: [], exchanges: [], fixture: [], cases: {} };
let service = new ControllerJourneyService(home, report, fixture);

// The fixture camera replays the prerecorded clip from its first picture on every turn-on:
// pictures at 0, 0.1, 0.2, 0.5 and 0.7 s, the last ending at 733,333 us (input.mov).
const clipUs = 733_333;
// Long enough for a whole clip stamped at turn-on to lie in the past, as a live camera's does.
const clipSettles = () => delay(1_500);
const range = (startUs, endUs) => ({ startUs, endUs });
const on = (state) => ({ deviceId: "fixture-camera", state });
const recordingDirectory = (recordingId) => join(home, "library/recordings", recordingId);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const lines = async (path) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const finishedEvent = async (path) =>
  (await lines(path)).find((row) => row.event === "finished").data;
const hostUs = ({ value, timescale }) => Number((BigInt(value) * 1_000_000n) / BigInt(timescale));
const start = (requestId, extra = {}) =>
  service.call("capture.start", {
    requestId,
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "fixture-camera",
    cameraAtStart: "off",
    microphone: false,
    ...extra,
  });
const cameraNow = async () => (await service.call("capture.status", {})).device.camera;
const setCamera = async (recordingId, value, transport = "cli") => {
  const reply = await service.call("capture.setCamera", { recordingId, on: value }, { transport });
  assert.deepEqual(reply.device.camera, on(value ? "on" : "off"));
  assert.equal(reply.recording.recordingId, recordingId);
  assert.deepEqual(await cameraNow(), on(value ? "on" : "off"));
  return reply;
};
const devices = async () => {
  const inspection = await service.fixtureCall("inspect");
  return [inspection.cameraOpens, inspection.cameraStarts, inspection.cameraStops];
};
const stopped = async (recordingId) => {
  await service.call("capture.stop", { recordingId });
  return poll(
    () => service.call("recording.get", { recordingId }),
    (value) => value.state === "complete" && value.publication?.inputsClosed,
    "take complete",
  );
};
const admitted = (recordingId) =>
  poll(
    () => service.call("recording.get", { recordingId }),
    (value) =>
      value.sourceAdmissions.length > 0 &&
      value.sourceAdmissions.every(
        (source) => source.publication.state !== "published" || source.job?.state === "ready",
      ),
    "published sources admitted",
  );
const admission = (recording, kind) =>
  recording.sourceAdmissions.find((source) => source.kind === kind);
async function videoBinding(acquisitionId) {
  const acquisition = await service.call("acquisition.get", { acquisitionId });
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  assert.ok(binding, JSON.stringify(acquisition.bindings));
  return { acquisition, binding };
}
const settled = (read, label) =>
  poll(read, (value) => !["queued", "running"].includes(value.state), label);

/** Source time of a host instant: host time after the origin with paused time removed. */
function sourceUs(host, finished) {
  let value = host - finished.hostOriginUs;
  for (const pause of finished.pauses) if (value > pause.atSourceUs) value -= pause.elapsedPauseUs;
  return value;
}
/** Host time of each run's first picture, as the fixture camera stamped it. */
async function runStarts(directory) {
  const starts = new Map();
  for (const row of await lines(join(directory, "camera.mapping.jsonl"))) {
    if (row.role !== "camera" || row.disposition !== "accepted") continue;
    const run = row.cameraFrame.run ?? 0;
    if (!starts.has(run)) starts.set(run, hostUs(row.convertedHostPTS));
  }
  return [...starts.values()];
}

try {
  await service.start();
  await service.fixtureCall("configure", { productionCamera: true });

  // 1. Off at start, on, pause, off while paused, resume, on, stop.
  const take = await start("toggled");
  const recordingId = take.recordingId;
  assert.deepEqual(await cameraNow(), on("off"));
  assert.equal((await service.call("capture.status", {})).device.selection.cameraAtStart, "off");
  assert.deepEqual(await devices(), [0, 0, 0], "A camera that starts off opens no device");
  await setCamera(recordingId, true);
  await clipSettles();
  const paused = await service.call("capture.pause", { recordingId });
  assert.equal(paused.state, "paused", JSON.stringify(paused));
  assert.deepEqual(await cameraNow(), on("on"), "Pausing the take leaves the camera on");
  await setCamera(recordingId, false, "mcp");
  assert.deepEqual(await devices(), [1, 1, 1]);
  await service.call("capture.resume", { recordingId });
  assert.deepEqual(await cameraNow(), on("off"), "Resuming the take leaves the camera off");
  await setCamera(recordingId, true);
  await clipSettles();
  const toggled = await stopped(recordingId);
  assert.deepEqual(await devices(), [2, 2, 2]);
  assert.equal(toggled.publication.camera.state, "published");

  const cameraDirectory = join(recordingDirectory(recordingId), "camera");
  const receipt = await json(join(cameraDirectory, "camera.publication.json"));
  const cameraFinished = await finishedEvent(join(cameraDirectory, "capture.journal.jsonl"));
  const primaryFinished = await finishedEvent(
    join(recordingDirectory(recordingId), "source/source.journal.jsonl"),
  );
  // One clock: the camera shares the take's origin and its pause.
  assert.equal(cameraFinished.hostOriginUs, primaryFinished.hostOriginUs);
  assert.deepEqual(cameraFinished.pauses, primaryFinished.pauses);
  assert.equal(primaryFinished.pauses.length, 1);
  const [first, second] = await runStarts(cameraDirectory);
  assert.ok(second !== undefined, "two runs");
  const pauseHostStart = primaryFinished.hostOriginUs + primaryFinished.pauses[0].atSourceUs;
  const pauseHostEnd = pauseHostStart + primaryFinished.pauses[0].elapsedPauseUs;
  assert.ok(
    first + clipUs <= pauseHostStart && pauseHostEnd <= second,
    "The pause falls inside the camera's off time",
  );
  // The schedule in source time: each run is one clip from its first picture; paused time is
  // not source time, so the gap is the off time minus the pause.
  const expectedGap = range(
    sourceUs(first, primaryFinished) + clipUs,
    sourceUs(second, primaryFinished),
  );
  assert.equal(
    expectedGap.endUs - expectedGap.startUs,
    second - (first + clipUs) - primaryFinished.pauses[0].elapsedPauseUs,
  );
  assert.deepEqual(receipt.gaps, [expectedGap]);
  assert.deepEqual(
    receipt.support,
    range(sourceUs(first, primaryFinished), sourceUs(second, primaryFinished) + clipUs),
  );
  const publication = await json(join(cameraDirectory, "source.publication.json"));
  assert.equal(publication.sourceDurationUs, receipt.support.endUs);
  assert.equal(publication.originHostUs, primaryFinished.hostOriginUs);

  const ready = await admitted(recordingId);
  const screen = await videoBinding(admission(ready, "primary").acquisitionId);
  const camera = await videoBinding(admission(ready, "camera").acquisitionId);
  assert.equal(camera.binding.sourceToAssetOffsetUs, -receipt.support.startUs);
  const origin = receipt.support.startUs;
  const intervals = [
    range(0, expectedGap.startUs - origin),
    range(expectedGap.endUs - origin, receipt.support.endUs - origin),
  ];
  assert.deepEqual(camera.binding.available, intervals);
  assert.equal(
    camera.acquisition.evidence.receipt.originHostUs,
    screen.acquisition.evidence.receipt.originHostUs,
  );
  assert.deepEqual(camera.acquisition.evidence.receipt.publications.video.gaps, [expectedGap]);

  // The camera source at a gap time has no picture; either side of it does.
  const select = ({ binding, acquisition }) => ({
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
  });
  const inRun = [intervals[0].startUs + 100_000, intervals[1].startUs + 100_000];
  const inGap = Math.round((intervals[0].endUs + intervals[1].startUs) / 2);
  const sourceFrame = (atUs) =>
    settled(
      () => service.call("frame.get", { ...select(camera), atUs, maxLongEdge: 160 }),
      `camera source frame at ${atUs}`,
    );
  const sourceFrames = {};
  for (const atUs of [...inRun, inGap]) sourceFrames[atUs] = await sourceFrame(atUs);
  for (const atUs of inRun)
    assert.equal(sourceFrames[atUs].state, "ready", JSON.stringify(sourceFrames[atUs]));
  assert.deepEqual(
    [sourceFrames[inGap].state, sourceFrames[inGap].reason, sourceFrames[inGap].published],
    ["unavailable", "physical_gap", null],
  );
  const events = await settled(
    () =>
      service.call("timeline.events", {
        ...select(camera),
        sourceRange: range(0, intervals[1].endUs),
      }),
    "camera timeline events",
  );
  assert.equal(events.state, "ready", JSON.stringify(events));
  assert.deepEqual(events.available, intervals);
  // Every measured picture change, and the picture it observed, lies inside an on interval.
  for (const row of events.rows) {
    const { sample } = row.observation;
    const endUs =
      Number((BigInt(sample.endValue) * 1_000_000n) / BigInt(sample.endTimescale)) -
      sample.originUs;
    assert.ok(
      intervals.some(({ startUs, endUs: end }) => startUs <= row.sourceAtUs && endUs <= end),
      `Timeline event outside the camera's on time: ${JSON.stringify(row)}`,
    );
  }

  // A caller-authored project places the screen and camera on the take's one clock. The camera
  // goes in a second revision, so each frame can be compared with the screen alone.
  const created = await service.call("project.create", {
    requestId: "toggled-project",
    title: "Toggled camera",
    canvas: {
      width: 160,
      height: 120,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const place = (label, trackId, source, sourceRange, projectRange) => ({
    operation: "place",
    label,
    clip: {
      trackId,
      ...select(source),
      source: { kind: "range", range: sourceRange },
      placement: { kind: "project", range: projectRange },
    },
  });
  const screenSpan = screen.binding.available.at(-1).endUs;
  const screenOnly = await service.call("edit.apply", {
    projectId,
    requestId: "toggled-screen",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "screen-track", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "camera-track", track: { kind: "video", order: 1 } },
      place(
        "screen",
        { label: "screen-track" },
        screen,
        range(0, screenSpan),
        range(0, screenSpan),
      ),
    ],
  });
  const screenClip = screenOnly.edit.labels.screen;
  const cameraSpan = intervals[1].endUs;
  const withCamera = await service.call("edit.apply", {
    projectId,
    requestId: "toggled-camera",
    expectedRevisionId: screenOnly.revision.revisionId,
    operations: [
      place(
        "camera",
        screenOnly.edit.labels["camera-track"],
        camera,
        range(0, cameraSpan),
        range(origin, origin + cameraSpan),
      ),
      { operation: "link", clipIds: [screenClip, { label: "camera" }] },
    ],
  });
  const cameraClip = withCamera.edit.labels.camera;
  assert.deepEqual(withCamera.revision.document.syncGroups[0].clipIds, [screenClip, cameraClip]);
  const projectFrame = (revisionId, atUs) =>
    settled(
      () => service.call("frame.get", { projectId, revisionId, atUs, observations: {} }),
      `project frame at ${atUs}`,
    );
  // Project time is source time. Frames sit on the 10 fps grid, inside each run and the gap.
  const grid = (sourceTime) => Math.floor(sourceTime / 100_000) * 100_000;
  const middle = ({ startUs, endUs }) => grid(origin + (startUs + endUs) / 2);
  const projectTimes = {
    firstRun: middle(intervals[0]),
    gap: middle(range(intervals[0].endUs, intervals[1].startUs)),
    secondRun: middle(intervals[1]),
  };
  const projectFrames = {};
  for (const [name, atUs] of Object.entries(projectTimes)) {
    const frames = [];
    for (const revision of [screenOnly.revision, withCamera.revision]) {
      const frame = await projectFrame(revision.revisionId, atUs);
      assert.equal(frame.state, "ready", JSON.stringify(frame));
      assert.equal(frame.published.output.frame.sampleAtUs, atUs);
      frames.push(frame.published.output);
    }
    const [alone, composed] = frames;
    const picture = composed.pictures.find((value) => value.clipId === cameraClip);
    if (name === "gap") {
      // Transparent: the camera adds nothing, not even a held picture.
      assert.deepEqual(
        [picture?.status, picture?.reason],
        ["unavailable", "source-unavailable"],
        JSON.stringify(composed.pictures),
      );
      assert.equal(composed.observations.rgbaSha256, alone.observations.rgbaSha256);
    } else {
      assert.equal(picture?.status, "available", JSON.stringify(picture));
      assert.equal(picture.requestedSourceUs, atUs - origin);
      assert.notEqual(composed.observations.rgbaSha256, alone.observations.rgbaSha256);
    }
    projectFrames[name] = {
      atUs,
      cameraPicture: picture,
      rgbaSha256: [alone, composed].map((frame) => frame.observations.rgbaSha256),
    };
  }
  report.cases.toggled = {
    take: toggled,
    receipt,
    expectedGap,
    runStartsHostUs: [first, second],
    pause: { hostStartUs: pauseHostStart, hostEndUs: pauseHostEnd },
    available: camera.binding.available,
    sourceFrames,
    events,
    projectFrames,
  };

  // 2. A reserved camera that is never turned on leaves the take complete.
  const idle = await start("never-on");
  await delay(2_000);
  const never = await stopped(idle.recordingId);
  assert.equal(never.publication.camera.state, "unavailable");
  assert.equal(never.publication.camera.error.code, "CAMERA_NOT_TURNED_ON");
  const neverReady = await admitted(idle.recordingId);
  assert.equal(admission(neverReady, "primary").job.state, "ready");
  assert.equal(admission(neverReady, "camera").acquisitionId, null);
  assert.deepEqual((await service.fixtureCall("inspect")).cameraOpens, 0);
  // The mapping logs camera callbacks only, so a camera that was never on writes nothing into it
  // while the screen records, however long the take.
  const mappingPath = join(recordingDirectory(idle.recordingId), "camera/camera.mapping.jsonl");
  const mapping = { bytes: (await stat(mappingPath)).size };
  assert.equal(mapping.bytes, 0, "a never-on camera's mapping is empty");
  report.cases.neverOn = { take: never, mapping };

  // 4. A camera-only take has no companion camera to switch.
  await service.fixtureCall("configure", { productionCamera: true, primaryFrames: false });
  const cameraOnly = await service.call("capture.start", {
    requestId: "camera-only",
    source: { kind: "camera", deviceId: "fixture-camera" },
    microphone: false,
  });
  assert.equal((await service.call("capture.status", {})).device.camera, null);
  const refused = await service.call(
    "capture.setCamera",
    { recordingId: cameraOnly.recordingId, on: false },
    { error: true },
  );
  assert.equal(refused.code, "CAMERA_NOT_RESERVED", JSON.stringify(refused));
  await service.call("capture.cancel", { recordingId: cameraOnly.recordingId });
  report.cases.cameraOnly = { refused };

  // 3. The app is killed after on, off, on; the next service recovers the camera with its gap.
  // A crash keeps only what the raw movie's fragments hold. The writer cuts a fragment when a
  // picture arrives a fragment interval after the last cut (1 s, then 5 s of source time), so a
  // third run late in the take pushes the first two runs into a fragment before the kill.
  await service.fixtureCall("configure", { productionCamera: true });
  const crashing = await start("crashed");
  const crashedAt = performance.now();
  await setCamera(crashing.recordingId, true);
  await clipSettles();
  await setCamera(crashing.recordingId, false);
  await setCamera(crashing.recordingId, true);
  await clipSettles();
  await setCamera(crashing.recordingId, false);
  await delay(Math.max(0, 8_000 - (performance.now() - crashedAt)));
  await setCamera(crashing.recordingId, true);
  await clipSettles();
  await service.crashController();
  service = new ControllerJourneyService(home, report, fixture);
  await service.start();
  const recovered = await poll(
    () => service.call("recording.get", { recordingId: crashing.recordingId }),
    (value) =>
      value.state === "interrupted" &&
      value.sourceAdmissions.every(
        (source) => source.publication.state !== "published" || source.job?.state === "ready",
      ),
    "crashed take recovered and admitted",
  );
  assert.equal(admission(recovered, "camera").publication.state, "published");
  assert.equal(
    admission(recovered, "camera").publication.source.diagnostic.code,
    "CAPTURE_RECOVERED",
  );
  const crashedDirectory = join(recordingDirectory(crashing.recordingId), "camera");
  const crashedOrigin = (await lines(join(crashedDirectory, "capture.journal.jsonl"))).find(
    (row) => row.event === "origin",
  ).data.hostUs;
  const crashedRuns = (await runStarts(crashedDirectory)).map((host) => host - crashedOrigin);
  assert.equal(crashedRuns.length, 3);
  const recoveredCamera = await videoBinding(admission(recovered, "camera").acquisitionId);
  const recoveredAvailable = recoveredCamera.binding.available;
  // The first two runs are whole; the third, if any of it survived, starts where it began.
  assert.deepEqual(
    recoveredAvailable.slice(0, 2),
    [
      range(0, clipUs),
      range(crashedRuns[1] - crashedRuns[0], crashedRuns[1] - crashedRuns[0] + clipUs),
    ],
    JSON.stringify(recoveredAvailable),
  );
  assert.ok(recoveredAvailable.length <= 3);
  if (recoveredAvailable[2])
    assert.equal(recoveredAvailable[2].startUs, crashedRuns[2] - crashedRuns[0]);
  report.cases.crashed = {
    recovered,
    runStartsSourceUs: crashedRuns,
    available: recoveredAvailable,
    proof: recoveredCamera.acquisition.evidence.receipt.publications.video,
  };
  report.passed = true;
} finally {
  report.logs = service.logs;
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, out }));
