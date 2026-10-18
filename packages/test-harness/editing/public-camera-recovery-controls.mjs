import assert from "node:assert/strict";
import { cp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControllerJourneyService } from "./controller-journey-service.mjs";
import { poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "source-home", "executable", "native", "video"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
for (const name of ["out", "source-home", "executable", "native", "video"])
  assert.ok(values[name], name);
await mkdir(resolve(values.out));
const out = await realpath(resolve(values.out));
const fixture = Object.fromEntries(
  ["executable", "native", "video"].map((name) => [name, resolve(values[name])]),
);
const report = { passed: false, trace: [], exchanges: [], fixture: [], cases: {} };
let service;
try {
  for (const mode of [
    "omit-receipt",
    "alter-private-proof",
    "alter-journal-tail",
    "substitute-canonical",
  ]) {
    const directory = join(out, mode),
      home = join(directory, "home");
    await mkdir(directory);
    await cp(resolve(values["source-home"]), home, { recursive: true });
    const importFault = join(directory, "fault.json");
    await writeFile(importFault, JSON.stringify({ mode, video: fixture.video }));
    service = new ControllerJourneyService(home, report, {
      ...fixture,
      importFault,
      evidence: join(directory, "native"),
    });
    await service.start();
    const recording = await poll(
      () => service.call("recording.get", {}),
      (value) =>
        value.sourceAdmissions.length === 2 &&
        value.sourceAdmissions.every((source) => source.job?.state === "failed"),
      "changed capture authority refuses before READY",
    );
    assert.equal(recording.state, "interrupted");
    for (const admission of recording.sourceAdmissions) {
      assert.equal(admission.publication.state, "published");
      assert.ok(admission.job.errorCode);
      const refusal = await service.call(
        "acquisition.get",
        { acquisitionId: admission.acquisitionId },
        { error: true },
      );
      assert.equal(refusal.code, "NOT_READY");
    }
    const assets = await service.call("asset.list", {});
    assert.deepEqual(assets.assets, []);
    assert.deepEqual((await service.call("project.list", {})).projects, []);
    report.cases[mode] = recording;
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
