import assert from "node:assert/strict";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControllerJourneyService } from "./controller-journey-service.mjs";
import { poll } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "executable", "native", "video"].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of ["out", "executable", "native", "video"]) assert.ok(values[name], name);
const out = resolve(values.out),
  home = join(out, "home");
await mkdir(out);
const fixture = Object.fromEntries(
  ["executable", "native", "video"].map((name) => [name, resolve(values[name])]),
);
const report = { passed: false, trace: [], exchanges: [], fixture: [] };
let service = new ControllerJourneyService(home, report, {
  ...fixture,
  evidence: join(out, "live-native"),
});
try {
  await service.start();
  await service.fixtureCall("configure", { holdPreparation: true, productionCamera: true });
  const request = {
    requestId: "empty-selected",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "fixture-camera",
    microphone: false,
  };
  const starting = service
    .call("capture.start", request)
    .catch((error) => ({ failure: error.message }));
  report.inspection = await poll(
    () => service.fixtureCall("inspect.open"),
    (value) => value.requests.length === 1,
    "preparation held",
  );
  assert.equal(report.inspection.cameraStarts, 0);
  assert.equal(report.inspection.stops, 0);
  assert.equal(report.inspection.closures, 0);
  report.take = await service.call("recording.get", {});
  assert.equal(report.take.state, "preparing");
  await service.crashController();
  report.startAnswer = await starting;
  service = undefined;
  await cp(home, join(out, "before-recovery"), { recursive: true });
  report.directories = {};
  for (const name of ["source", "camera"]) {
    const path = join(home, "library/recordings", report.take.recordingId, name);
    report.directories[name] = await readdir(path).then(
      async (entries) => ({ entries, mode: (await stat(path)).mode & 0o777 }),
      (error) => ({ error: error.code }),
    );
  }
  service = new ControllerJourneyService(home, report, {
    ...fixture,
    evidence: join(out, "recovery-native"),
  });
  await service.start();
  report.recovered = await poll(
    () => service.call("recording.get", { recordingId: report.take.recordingId }),
    (value) => value.state === "interrupted" || value.publication?.camera?.state === "pending",
    "empty recovery outcome",
  );
  assert.equal(report.recovered.state, "interrupted", JSON.stringify(report.recovered));
  assert.equal(report.recovered.publication.inputsClosed, true);
  assert.equal(report.recovered.sourceDurationUs, null);
  for (const source of report.recovered.sourceAdmissions) {
    assert.equal(source.publication.state, "unavailable");
    assert.equal(source.acquisitionId, null);
    assert.equal(source.job, null);
  }
  assert.equal(report.recovered.sourceAdmissions.length, 2);
  assert.deepEqual(report.directories, {
    source: { entries: [], mode: 0o700 },
    camera: { entries: [], mode: 0o700 },
  });
  assert.deepEqual((await service.call("asset.list", {})).assets, []);
  assert.deepEqual((await service.call("project.list", {})).projects, []);
  const replay = await service.call("capture.start", request);
  assert.deepEqual(replay, report.recovered);
  assert.equal((await service.fixtureCall("inspect.open")).requests.length, 0);
  report.passed = true;
} finally {
  if (service) {
    report.logs = service.logs;
    await service.stop();
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, out }));
