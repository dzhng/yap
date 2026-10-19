import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControllerJourneyService } from "./controller-journey-service.mjs";
import { hash, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "executable", "native", "video", "audio"].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of ["out", "executable", "native", "video"]) assert.ok(values[name], name);
await mkdir(resolve(values.out));
const out = await realpath(resolve(values.out));
const fixture = Object.fromEntries(
  ["executable", "native", "video", "audio"]
    .filter((name) => values[name])
    .map((name) => [name, resolve(values[name])]),
);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  fixture: [],
  checks: {},
  inputs: Object.fromEntries(
    await Promise.all(
      Object.entries(fixture).map(async ([name, path]) => [
        name,
        { path, sha256: hash(await readFile(path)) },
      ]),
    ),
  ),
};
let service;
try {
  for (const pending of ["primary", "camera"]) {
    service = new ControllerJourneyService(join(out, pending), report, fixture);
    await service.start();
    await service.fixtureCall("configure", { pending, holdStop: true });
    const request = {
      requestId: `selected-${pending}`,
      source: { kind: "display", displayId: 1 },
      cameraDeviceId: "fixture-camera",
      microphone: true,
    };
    const take = await service.call("capture.start", request, { transport: "mcp" });
    assert.equal(take.camera.deviceId, request.cameraDeviceId);
    assert.notEqual(take.sourceId, take.camera.sourceId);
    assert.equal(Object.hasOwn(take, "currentRevisionId"), false);
    const params = { recordingId: take.recordingId };
    const stopped = await service.call("capture.stop", params);
    assert.equal(stopped.publication.inputsClosed, false);
    await poll(
      () => service.fixtureCall("inspect"),
      (value) => value.stops === 1,
      "physical stop entered",
    );
    const held = await service.call("recording.get", params);
    assert.equal(held.publication.inputsClosed, false);
    assert.deepEqual(held.sourceAdmissions, []);
    // Release the physical stop gate. Publication will then encounter the held destination.
    await service.fixtureCall("release");
    const companion = pending === "primary" ? "camera" : "primary";
    const independent = await poll(
      () => service.call("recording.get", params),
      (value) =>
        value.publication.inputsClosed &&
        value.publication[pending]?.state === "pending" &&
        value.sourceAdmissions.find((source) => source.kind === companion)?.job?.state === "ready",
      `${companion} ready independently`,
    );
    assert.equal(Object.hasOwn(independent, "currentRevisionId"), false);
    assert.equal(
      independent.sourceAdmissions.find((source) => source.kind === pending).acquisitionId,
      null,
    );
    const acquisition = independent.sourceAdmissions.find(
      (source) => source.kind === companion,
    ).acquisitionId;
    await service.fixtureCall("release");
    await service.call("capture.stop", params, { transport: "mcp" });
    const complete = await poll(
      () => service.call("recording.get", params),
      (value) =>
        value.sourceAdmissions.length === 2 &&
        value.sourceAdmissions.every((source) => source.job?.state === "ready"),
      "both sources ready after restoration",
    );
    assert.equal(
      complete.sourceAdmissions.find((source) => source.kind === companion).acquisitionId,
      acquisition,
    );
    assert.deepEqual((await service.call("project.list", {})).projects, []);
    const inspections = await service.fixtureCall("inspect");
    assert.equal(inspections.stops, 1);
    assert.equal(inspections.closures, 1);
    assert.equal(inspections.requests.length, 1);
    assert.deepEqual(inspections.requests[0].camera.binding, {
      recordingId: take.recordingId,
      sourceId: take.camera.sourceId,
      deviceId: "fixture-camera",
    });
    report.checks[pending] = { take, stopped, held, independent, complete, inspections };
    await service.stop();
    service = undefined;
  }
  service = new ControllerJourneyService(join(out, "camera-only"), report, fixture);
  await service.start();
  await service.fixtureCall("configure", { primaryFrames: false });
  const cameraOnly = await service.call("capture.start", {
    requestId: "camera-without-primary",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "fixture-camera",
    microphone: false,
  });
  await service.call("capture.stop", { recordingId: cameraOnly.recordingId });
  const survived = await poll(
    () => service.call("recording.get", { recordingId: cameraOnly.recordingId }),
    (value) =>
      value.publication.primary?.state === "unavailable" &&
      value.sourceAdmissions.find((source) => source.kind === "camera")?.job?.state === "ready",
    "camera survives primary NO_VIDEO",
  );
  assert.equal(survived.publication.primary.error.code, "NO_VIDEO");
  assert.equal(
    survived.sourceAdmissions.find((source) => source.kind === "primary").acquisitionId,
    null,
  );
  assert.equal(Object.hasOwn(survived, "currentRevisionId"), false);
  report.checks.cameraOnly = survived;
  await service.stop();
  service = undefined;
  for (const selection of ["omitted", "absent", "denied"]) {
    service = new ControllerJourneyService(join(out, selection), report, fixture);
    await service.start();
    await service.fixtureCall("configure", { cameraDenied: selection === "denied" });
    const request = {
      requestId: selection,
      source: { kind: "display", displayId: 1 },
      microphone: false,
      ...(selection === "omitted"
        ? {}
        : { cameraDeviceId: selection === "absent" ? "missing-camera" : "fixture-camera" }),
    };
    const started = await service.call("capture.start", request, {
      error: selection !== "omitted",
    });
    if (selection === "omitted") {
      assert.equal(started.camera, null);
      await service.call("capture.stop", { recordingId: started.recordingId });
      const complete = await poll(
        () => service.call("recording.get", { recordingId: started.recordingId }),
        (value) => value.sourceAdmissions[0]?.job?.state === "ready",
        "omitted camera primary ready",
      );
      assert.equal(complete.publication.camera, null);
      assert.equal(complete.sourceAdmissions.length, 1);
      assert.equal((await service.fixtureCall("inspect")).requests[0].camera, undefined);
      report.checks[selection] = complete;
    } else {
      assert.equal(
        started.code,
        selection === "absent" ? "CAMERA_UNAVAILABLE" : "CAMERA_PERMISSION_REQUIRED",
      );
      const refused = await service.call("recording.get", {
        recordingId: started.details.recordingId,
      });
      assert.equal(refused.camera.deviceId, request.cameraDeviceId);
      assert.deepEqual(refused.sourceAdmissions, []);
      const inspected = await service.fixtureCall("inspect");
      assert.equal(inspected.requests.length, 1);
      assert.equal(inspected.requests[0].camera.binding.deviceId, request.cameraDeviceId);
      assert.equal(inspected.stops, 0);
      report.checks[selection] = { error: started, refused, inspected };
    }
    await service.stop();
    service = undefined;
  }
  report.passed = true;
} finally {
  if (service) {
    report.logs = service.logs;
    await service.stop();
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, out }));
