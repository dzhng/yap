import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControllerJourneyService } from "./controller-journey-service.mjs";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "executable", "native", "video"].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of ["out", "executable", "native", "video"]) assert.ok(values[name], name);
await mkdir(resolve(values.out));
const out = await realpath(resolve(values.out));
const fixture = Object.fromEntries(
  ["executable", "native", "video"].map((name) => [name, resolve(values[name])]),
);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  fixture: [],
  cases: {},
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
let releaseFile;
try {
  for (const heldKind of ["primary", "camera"]) {
    const caseRoot = join(out, heldKind),
      home = join(caseRoot, "home");
    await mkdir(caseRoot);
    service = new ControllerJourneyService(home, report, {
      ...fixture,
      evidence: join(caseRoot, "live-worker"),
    });
    await service.start();
    await service.fixtureCall("configure", { productionCamera: true });
    const request = {
      requestId: `crash-${heldKind}`,
      source: { kind: "display", displayId: 1 },
      cameraDeviceId: "fixture-camera",
      microphone: false,
    };
    const take = await service.call("capture.start", request, { transport: "mcp" });
    const inspection = await service.fixtureCall("inspect");
    assert.equal(inspection.inputBoundary, "CameraCaptureInput");
    assert.equal(inspection.cameraStarts, 1);
    assert.equal(inspection.stops, 0);
    assert.equal(inspection.cameraStops, 0);
    assert.equal(inspection.closures, 0);
    assert.equal(take.publication.inputsClosed, false);
    await service.crashController();
    service = undefined;
    const recordingRoot = join(home, "library/recordings", take.recordingId);
    await cp(home, join(caseRoot, "before-recovery"), { recursive: true });
    const journals = {};
    for (const kind of ["primary", "camera"]) {
      const file = join(
        recordingRoot,
        kind === "primary" ? "source" : "camera",
        "capture.journal.jsonl",
      );
      const bytes = await readFile(file);
      assert.equal(bytes.toString().includes('"event":"finished"'), false);
      journals[kind] = { path: file, bytes: bytes.length, sha256: hash(bytes) };
    }
    const barrier = join(caseRoot, "barrier");
    await mkdir(barrier);
    releaseFile = join(barrier, "release");
    const holdConfig = join(barrier, "hold.json");
    await writeFile(holdConfig, JSON.stringify({ kind: heldKind, directory: barrier }));
    service = new ControllerJourneyService(home, report, {
      ...fixture,
      evidence: join(caseRoot, "recovery-worker"),
      recoveryHold: holdConfig,
    });
    await service.start();
    const committed = await poll(
      async () =>
        JSON.parse(await readFile(join(barrier, "entered.json"), "utf8").catch(() => "{}")),
      (value) => value.response !== undefined,
      "actual native recovery reply held",
    );
    assert.equal(committed.response.ok, true);
    assert.equal(committed.response.data.sourcePublication.state, "published");
    const other = heldKind === "primary" ? "camera" : "primary";
    const params = { recordingId: take.recordingId };
    const independent = await poll(
      () => service.call("recording.get", params),
      (value) =>
        value.sourceAdmissions.find((source) => source.kind === other)?.job?.state === "ready",
      "independent recovered source READY",
    );
    assert.equal(independent.state, "finalizing");
    assert.equal(independent.publication.inputsClosed, true);
    assert.equal(independent.publication.generation, take.publication.generation);
    assert.equal(
      independent.sourceAdmissions.find((source) => source.kind === heldKind).acquisitionId,
      null,
    );
    assert.equal(Object.hasOwn(independent, "currentRevisionId"), false);
    const replay = await service.call("capture.start", request);
    assert.equal(replay.recordingId, take.recordingId);
    assert.equal((await service.fixtureCall("inspect")).requests.length, 0);
    await writeFile(releaseFile, "");
    const complete = await poll(
      () => service.call("recording.get", params),
      (value) =>
        value.state === "interrupted" &&
        value.sourceAdmissions.length === 2 &&
        value.sourceAdmissions.every((source) => source.job?.state === "ready"),
      "recovered pair READY",
    );
    const acquisitions = {};
    for (const admission of complete.sourceAdmissions) {
      const acquired = await service.call("acquisition.get", {
        acquisitionId: admission.acquisitionId,
      });
      assert.equal(acquired.sourceId, admission.sourceId);
      assert.equal(acquired.evidence.receipt.finished, false);
      assert.equal(acquired.evidence.receipt.completion ?? null, null);
      assert.equal(acquired.evidence.receipt.verifiedSourceAuthority, undefined);
      assert.equal(admission.publication.source.diagnostic.code, "CAPTURE_RECOVERED");
      assert.equal(
        hash(await readFile(journals[admission.kind].path)),
        journals[admission.kind].sha256,
      );
      const directory = join(recordingRoot, admission.kind === "primary" ? "source" : "camera");
      const receipt = JSON.parse(
        await readFile(join(directory, "source.publication.json"), "utf8"),
      );
      assert.ok(receipt.recovery);
      assert.equal(receipt.journal.sha256, journals[admission.kind].sha256);
      if (admission.kind === "camera")
        assert.deepEqual(acquired.evidence.receipt.header.cameraBinding, {
          recordingId: take.recordingId,
          ...take.camera,
        });
      acquisitions[admission.kind] = acquired;
    }
    await cp(recordingRoot, join(caseRoot, "recovered-sources"), { recursive: true });
    assert.deepEqual((await service.call("project.list", {})).projects, []);
    await service.call("recording.delete", params);
    await service.stop();
    service = new ControllerJourneyService(home, report, {
      ...fixture,
      evidence: join(caseRoot, "reopened-worker"),
    });
    await service.start();
    for (const acquired of Object.values(acquisitions))
      assert.deepEqual(
        await service.call("acquisition.get", { acquisitionId: acquired.id }),
        acquired,
      );
    const created = await service.call("project.create", {
      requestId: "explicit-recovered-project",
      title: "Recovered source portability",
      canvas: {
        width: 320,
        height: 120,
        fps: { numerator: 10, denominator: 1 },
        background: "#000000ff",
      },
    });
    const operations = [];
    for (const [index, kind] of ["primary", "camera"].entries()) {
      const acquired = acquisitions[kind],
        binding = acquired.bindings.find((value) => value.sourceRoles.includes("video"));
      assert.equal(binding.available[0].startUs, 0);
      assert.ok(binding.available[0].endUs >= 100000);
      const at = -binding.sourceToAssetOffsetUs;
      operations.push(
        { operation: "track.add", label: kind + "-track", track: { kind: "video", order: index } },
        {
          operation: "place",
          label: kind,
          clip: {
            trackId: { label: kind + "-track" },
            assetId: binding.assetId,
            streamId: binding.streamId,
            acquisitionId: acquired.id,
            source: { kind: "range", range: { startUs: 0, endUs: 100000 } },
            placement: { kind: "project", range: { startUs: at, endUs: at + 100000 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: kind } },
          steps: [
            {
              processor: {
                type: "geometry",
                rect: { x: index * 160, y: 0, width: 160, height: 120 },
                fit: "stretch",
              },
            },
          ],
        },
      );
    }
    const authored = await service.call("edit.apply", {
      projectId: created.project.projectId,
      requestId: "explicit-recovered-layout",
      expectedRevisionId: created.revision.id,
      operations,
    });
    const exportId = randomUUID();
    await service.call("export.create", {
      projectId: created.project.projectId,
      exportId,
      directory: caseRoot,
      leaf: "recovered.zip",
      kind: "processed-package",
    });
    const exported = await poll(
      () => service.call("export.status", { exportId }),
      (value) => value.state === "ready",
      "recovered project package",
    );
    await service.stop();
    await rm(home, { recursive: true });
    service = new JourneyService(
      join(caseRoot, "receiver"),
      report,
      join(caseRoot, "portable-worker"),
    );
    await service.start();
    const opened = await service.call("package.open", { path: exported.output });
    const openedReady = await poll(
      () => service.call("package.status", { admissionId: opened.id }),
      (value) => value.state === "ready",
      "recovered package verified",
    );
    const adopted = await poll(
      () =>
        service.call("package.adopt", {
          packageHandle: openedReady.packageHandle,
          requestId: "adopt-recovered",
        }),
      (value) => value.state === "ready",
      "recovered sources adopted",
    );
    await service.call("package.close", { admissionId: opened.id });
    await rm(exported.output);
    for (const acquired of Object.values(acquisitions)) {
      const retained = await service.call("acquisition.get", { acquisitionId: acquired.id });
      const { file: beforeFile, ...before } = acquired.evidence.receipt;
      const { file: afterFile, ...after } = retained.evidence.receipt;
      assert.notEqual(afterFile, beforeFile);
      assert.deepEqual(after, before);
      assert.deepEqual(retained.bindings, acquired.bindings);
    }
    report.cases[heldKind] = {
      take,
      inspection,
      journals,
      independent,
      complete,
      acquisitions,
      portable: { authored, exported, adopted },
    };
    await service.stop();
    service = undefined;
    releaseFile = undefined;
  }
  report.passed = true;
} finally {
  if (releaseFile) await writeFile(releaseFile, "");
  if (service) {
    report.logs = service.logs;
    await service.stop();
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, out }));
