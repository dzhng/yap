import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const out = resolve(values.out);
await mkdir(out);
const fixture = Object.fromEntries(
  ["executable", "native", "video"].map((name) => [name, resolve(values[name])]),
);
const report = { passed: false, trace: [], exchanges: [], fixture: [], cases: {} };
let service;
try {
  for (const name of ["camera.mapping.jsonl", "retained-unknown.bin"]) {
    const home = join(out, name);
    service = new ControllerJourneyService(home, report, fixture);
    await service.start();
    await service.fixtureCall("configure", { holdPreparation: true, productionCamera: true });
    const starting = service.call(
      "capture.start",
      {
        requestId: "retained-destination",
        source: { kind: "display", displayId: 1 },
        cameraDeviceId: "fixture-camera",
        microphone: false,
      },
      { error: true },
    );
    await poll(
      () => service.fixtureCall("inspect.open"),
      (value) => value.requests.length === 1,
      "input preparation held",
    );
    const take = await service.call("recording.get", {});
    const directory = join(home, "library/recordings", take.recordingId, "camera");
    const retained = Buffer.from("retained bytes must never be truncated");
    await writeFile(join(directory, name), retained);
    await service.fixtureCall("release");
    const refusal = await starting;
    assert.equal(refusal.code, "OUTPUT_EXISTS");
    assert.deepEqual(await readFile(join(directory, name)), retained);
    assert.deepEqual(await readdir(directory), [name]);
    assert.equal((await service.fixtureCall("inspect.open")).cameraStarts, 0);
    assert.deepEqual((await service.call("asset.list", {})).assets, []);
    report.cases[name] = { take, refusal, retainedBytes: retained.length };
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
