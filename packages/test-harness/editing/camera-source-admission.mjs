import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";

// Native fixtures come from CameraWriter/CameraMedia; no physical input or model operation.
// <source> is YAP_CAMERA_SOURCE_ADMISSION_OUTPUT, <availability> YAP_CAMERA_AVAILABILITY_OUTPUT.
const [sourceArg, outputArg, availabilityArg] = process.argv.slice(2);
assert.ok(sourceArg && outputArg && availabilityArg && process.env.YAP_NATIVE);
const source = resolve(sourceArg),
  out = resolve(outputArg),
  availability = resolve(availabilityArg);
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/yap-camera-admission-");
const destination = await mkdtemp("/tmp/yap-camera-relocation-");
const report = {
  scope:
    "Current-source independent camera acquisition, immutable proof and portable relocation; supplied identity, no service capture allocation or physical acceptance",
  passed: false,
  trace: [],
  checks: {},
};
let service = new JourneyService(home, report);
const ready = async (jobId) =>
  poll(
    () => service.call("job.get", { jobId }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "camera import",
  );
const terminal = async (jobId) =>
  poll(
    () => service.call("job.get", { jobId }),
    (value) => ["failed", "unavailable", "canceled"].includes(value.state),
    "camera refusal",
  );
const importSource = async (path, requestId) => {
  const pending = await service.call("acquisition.import", { path, requestId });
  const job = await ready(pending.jobId);
  return {
    pending,
    job,
    acquisition: await service.call(
      "acquisition.get",
      { acquisitionId: job.target.acquisitionId },
      { transport: "mcp" },
    ),
  };
};
try {
  await service.start();
  const donor = join(home, "donor");
  await cp(join(source, "normal", "camera"), donor, { recursive: true });
  const members = [
    "video.mov",
    "capture.journal.jsonl",
    "camera.publication.json",
    "camera.mapping.jsonl",
  ];
  const identities = Object.fromEntries(
    await Promise.all(members.map(async (name) => [name, hash(await readFile(join(donor, name)))])),
  );
  const adopted = await importSource(donor, "camera-normal");
  const camera = adopted.acquisition;
  assert.equal(camera.bindings.length, 1);
  const binding = camera.bindings[0],
    proof = camera.evidence.receipt.publications.video;
  assert.deepEqual(binding.sourceRoles, ["video"]);
  assert.equal(binding.assetId, identities["video.mov"]);
  assert.equal(proof.mapping.sha256, identities["camera.mapping.jsonl"]);
  assert.equal(proof.receipt.sha256, identities["camera.publication.json"]);
  assert.equal(camera.sourceId, "fixture-camera-source");
  assert.deepEqual(camera.evidence.receipt.header.cameraBinding, {
    recordingId: "fixture-take",
    sourceId: "fixture-camera-source",
    deviceId: "fixture-selected-device",
  });
  const asset = await service.call("asset.get", { assetId: binding.assetId });
  assert.equal(binding.sourceToAssetOffsetUs, -asset.originUs || 0);
  const physical = await service.call("asset.import", {
    requestId: "plain-camera-asset",
    path: join(donor, "video.mov"),
  });
  await ready(physical.jobId);
  report.checks.normal = {
    sourceHashes: identities,
    acquisition: camera,
    ordinaryAssetImport: true,
  };

  // Gapped takes: the probe of each canonical movie, rounded to microseconds by the service,
  // must give exactly the receipt's intervals (support minus gaps) from the asset origin.
  report.checks.gapped = {};
  for (const name of (await readdir(availability)).sort()) {
    const directory = join(availability, name);
    const published = await access(join(directory, "camera.publication.json")).then(
      () => true,
      () => false,
    );
    if (!published) continue;
    const receipt = JSON.parse(await readFile(join(directory, "camera.publication.json"), "utf8"));
    const copy = join(home, `available-${name}`);
    await cp(directory, copy, { recursive: true });
    const { acquisition } = await importSource(copy, `available-${name}`);
    const [video] = acquisition.bindings;
    const proof = acquisition.evidence.receipt.publications.video;
    const bounds = [receipt.support.startUs];
    for (const gap of receipt.gaps ?? []) bounds.push(gap.startUs, gap.endUs);
    bounds.push(receipt.support.endUs);
    const intervals = [];
    for (let index = 0; index < bounds.length; index += 2)
      intervals.push({
        startUs: bounds[index] - receipt.support.startUs,
        endUs: bounds[index + 1] - receipt.support.startUs,
      });
    assert.deepEqual(video.available, intervals, name);
    assert.deepEqual(proof.gaps, receipt.gaps, name);
    report.checks.gapped[name] = { support: receipt.support, gaps: receipt.gaps?.length ?? 0 };
    if (name === "on-off-on")
      assert.deepEqual(video.available, [
        { startUs: 0, endUs: 150000 },
        { startUs: 500000, endUs: 600000 },
      ]);
    if (name === "many-gaps") {
      // The largest receipt a take can make: 500 turn-ons (CAMERA_TOGGLE_LIMIT), 499 gaps.
      assert.equal(receipt.gaps.length, 499);
      const receiptBytes = (await stat(join(directory, "camera.publication.json"))).size;
      const normalizedBytes = Buffer.byteLength(JSON.stringify(acquisition.evidence.receipt));
      assert.ok(receiptBytes <= 65536, `camera.publication.json is ${receiptBytes} bytes`);
      assert.ok(normalizedBytes <= 32768, `normalized receipt is ${normalizedBytes} bytes`);
      report.checks.gapped[name].bytes = {
        receipt: receiptBytes,
        receiptLimit: 65536,
        normalized: normalizedBytes,
        normalizedLimit: 32768,
      };
    }
  }
  assert.ok(report.checks.gapped["on-off-on"] && report.checks.gapped["many-gaps"]);

  for (const mode of [
    "missing-receipt",
    "missing-mapping",
    "changed-mapping",
    "wrong-binding",
    "wrong-receipt-binding",
    "absent-bound-prefix",
    "absent-bound-timescale",
    "wrong-origin",
    "wrong-support",
    "wrong-pause",
    "changed-canonical",
  ]) {
    const path = join(home, mode);
    await cp(donor, path, { recursive: true });
    if (mode.startsWith("missing-"))
      await rm(
        join(path, mode === "missing-receipt" ? "camera.publication.json" : "camera.mapping.jsonl"),
      );
    else if (mode === "changed-mapping")
      await writeFile(
        join(path, "camera.mapping.jsonl"),
        (await readFile(join(path, "camera.mapping.jsonl"))) + "\n",
      );
    else if (
      [
        "wrong-support",
        "wrong-receipt-binding",
        "absent-bound-prefix",
        "absent-bound-timescale",
      ].includes(mode)
    ) {
      const file = join(path, "camera.publication.json"),
        receipt = JSON.parse(await readFile(file, "utf8"));
      if (mode === "wrong-support") receipt.support.endUs = 1;
      if (mode === "wrong-receipt-binding") receipt.binding.deviceId = "another-device";
      if (mode === "absent-bound-prefix") delete receipt.journal;
      if (mode === "absent-bound-timescale") delete receipt.pictureTimeScale;
      await writeFile(file, JSON.stringify(receipt));
    } else if (mode === "changed-canonical")
      await writeFile(join(path, "video.mov"), "changed canonical bytes");
    else {
      const file = join(path, "capture.journal.jsonl");
      const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map(JSON.parse);
      if (mode === "wrong-binding") rows[0].data.cameraBinding.deviceId = "another-device";
      if (mode === "wrong-origin") rows.find((row) => row.event === "origin").data.hostUs += 1;
      if (mode === "wrong-pause")
        rows.find((row) => row.event === "pauseEnded").data.pause.elapsedPauseUs += 1;
      await writeFile(file, rows.map(JSON.stringify).join("\n") + "\n");
    }
    const pending = await service.call("acquisition.import", { path, requestId: mode });
    const refused = await terminal(pending.jobId);
    assert.equal(refused.state, "failed", JSON.stringify(refused));
    assert.equal(refused.retryable, false, JSON.stringify(refused));
    report.checks[mode] = {
      code: refused.errorCode,
      reason: refused.reason,
      retryable: refused.retryable,
    };
  }

  const fractional = await importSource(join(source, "fractional"), "fractional-camera");
  assert.deepEqual(fractional.acquisition.evidence.receipt.publications.video.support, {
    startUs: 0,
    endUs: { numerator: 200000, denominator: 3 },
  });
  assert.deepEqual(fractional.acquisition.bindings[0].available, [
    { startUs: 0, endUs: { numerator: 200000, denominator: 3 } },
  ]);
  report.checks.fractional = fractional.acquisition;

  const hit = await service.arm("media.sourceEvidence");
  const interrupted = await service.call("acquisition.import", {
    path: donor,
    requestId: "camera-restart",
  });
  await hit();
  await service.stop(true);
  service = new JourneyService(home, report);
  await service.start();
  const replay = await service.call(
    "acquisition.import",
    { path: donor, requestId: "camera-restart" },
    { transport: "mcp" },
  );
  assert.equal(replay.jobId, interrupted.jobId);
  const failed = await terminal(replay.jobId);
  const retry = await service.call("job.retry", { jobId: failed.jobId });
  assert.notEqual(retry.attemptId, interrupted.attemptId);
  const resumed = await ready(retry.jobId);
  assert.equal(resumed.target.acquisitionId, interrupted.target.acquisitionId);
  report.checks.restart = { original: interrupted, replay, retry, ready: resumed };

  const deniedHit = await service.arm("media.sourceEvidence");
  const denied = await service.call("acquisition.import", {
    path: donor,
    requestId: "camera-access-retry",
  });
  await deniedHit();
  await service.call("job.cancel", { jobId: denied.jobId });
  await terminal(denied.jobId);
  // Deny directory traversal after admission; the original file identities remain untouched.
  await chmod(donor, 0o000);
  let inaccessible;
  try {
    await service.call("job.retry", { jobId: denied.jobId });
    inaccessible = await terminal(denied.jobId);
    assert.equal(inaccessible.retryable, true, JSON.stringify(inaccessible));
  } finally {
    await chmod(donor, 0o700);
  }
  const repaired = await service.call("job.retry", { jobId: denied.jobId });
  const repairedReady = await ready(repaired.jobId);
  assert.equal(repairedReady.target.acquisitionId, denied.target.acquisitionId);
  report.checks.operationalRetry = { inaccessible, repaired: repairedReady };

  // The fixture caller explicitly authors a single video; acquisition never creates a project.
  const created = await service.call("project.create", {
    requestId: "camera-project",
    title: "Camera proof fixture",
    canvas: {
      width: 32,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  await service.call("edit.apply", {
    projectId,
    requestId: "camera-placement",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "camera",
        clip: {
          trackId: { label: "video" },
          assetId: binding.assetId,
          streamId: binding.streamId,
          acquisitionId: camera.id,
          source: { kind: "range", range: binding.available[0] },
          placement: { kind: "project", range: { startUs: 0, endUs: 200000 } },
        },
      },
    ],
  });
  await rm(donor, { recursive: true });
  assert.equal(
    (await service.call("acquisition.import", { path: donor, requestId: "camera-normal" })).jobId,
    adopted.pending.jobId,
  );
  const exportId = randomUUID();
  await service.call("export.create", {
    projectId,
    exportId,
    directory: out,
    leaf: "camera.zip",
    kind: "processed-package",
  });
  const exported = await poll(
    () => service.call("export.status", { exportId }),
    (value) => value.state === "ready",
    "camera package",
  );
  await service.stop();
  await rm(home, { recursive: true });
  service = new JourneyService(destination, report);
  await service.start();
  const opened = await service.call("package.open", { path: exported.output });
  const packageReady = await poll(
    () => service.call("package.status", { admissionId: opened.id }),
    (value) => value.state === "ready",
    "relocated package",
  );
  const portable = await poll(
    () =>
      service.call("package.adopt", {
        packageHandle: packageReady.packageHandle,
        requestId: "relocated-camera",
      }),
    (value) => value.state === "ready",
    "relocated adoption",
  );
  const relocated = await service.call(
    "acquisition.get",
    { acquisitionId: camera.id },
    { transport: "mcp" },
  );
  assert.deepEqual(relocated.bindings, camera.bindings);
  const { file: originalLocation, ...originalReceipt } = camera.evidence.receipt;
  const { file: relocatedLocation, ...relocatedReceipt } = relocated.evidence.receipt;
  assert.deepEqual(relocatedReceipt, originalReceipt);
  assert.notEqual(relocatedLocation, originalLocation);
  assert.ok(relocatedLocation.startsWith(join(destination, "library", "acquisitions") + "/"));
  assert.equal(
    hash(await readFile(relocatedLocation)),
    hash(await readFile(join(source, "normal-evidence.jsonl"))),
  );
  await service.call("package.close", { admissionId: opened.id });
  await rm(exported.output);
  assert.deepEqual(
    (await service.call("acquisition.get", { acquisitionId: camera.id })).bindings,
    camera.bindings,
  );
  report.checks.portable = {
    projectId: portable.published.output.projectId,
    proofPreserved: true,
    donorAndOriginalLibraryRemoved: true,
    archiveRemoved: true,
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await service.stop().catch((error) => {
    report.passed = false;
    report.shutdownError = error.message;
  });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
}
assert.equal(report.passed, true);
console.log(JSON.stringify({ passed: true, out }));
