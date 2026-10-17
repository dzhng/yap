import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, root, hash, poll, run } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({ options: { out: { type: "string" }, fixture: { type: "string" } } });
assert(values.out && values.fixture && process.env.YAP_NATIVE);
let out = resolve(values.out);
const scratch = await mkdtemp("/tmp/ca-");
await mkdir(out, { recursive: false });
out = await realpath(out);
const report = {
  passed: false,
  trace: [],
  checks: {},
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
async function resourceFile(directory, manifest, kind, id) {
  const reference = manifest.resources.find(
    (row) => row.identity.kind === kind && (id === undefined || row.identity.id === id),
  );
  assert.ok(reference);
  const value = JSON.parse(await readFile(join(directory, reference.metadata.path)));
  return {
    value,
    async save() {
      const body = JSON.stringify(value);
      await writeFile(join(directory, reference.metadata.path), body);
      reference.metadata.bytes = Buffer.byteLength(body);
      reference.metadata.sha256 = hash(Buffer.from(body));
      Object.assign(
        manifest.inventory.find((row) => row.path === reference.metadata.path),
        reference.metadata,
      );
    },
  };
}
let service;
async function start(home) {
  service = new JourneyService(
    home,
    report,
    join(out, "reads.jsonl"),
    new URL("./capture-evidence-service.mjs", import.meta.url),
  );
  await service.start();
}
const call = (...args) => service.call(...args);
async function audio(selection, name) {
  const output = join(out, `${name}.wav`);
  const receipt = await poll(
    () => call("audio.get", selection, { output }),
    (v) => v.state === "ready",
    name,
  );
  await save(`${name}.json`, receipt);
  const decoded = await run(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", output, "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"],
    { encoding: "buffer" },
  );
  return decoded.stdout;
}
try {
  const source = join(scratch, "source");
  await cp(resolve(values.fixture), source, { recursive: true });
  await copyFile(
    join(root, "specs/done/agent-editing/assets/00-corpus/a.mov"),
    join(source, "video.mov"),
  );
  const donor = join(scratch, "donor"),
    receiver = join(scratch, "receiver");
  await start(donor);
  const unproven = join(scratch, "unproven");
  await cp(source, unproven, { recursive: true });
  await rm(join(unproven, "narration.publication.json"));
  const refused = await call("acquisition.import", { requestId: "unproven", path: unproven });
  const refusal = await poll(
    () => call("job.get", { jobId: refused.jobId }),
    (v) => v.state === "failed",
    "missing proof refusal",
  );
  await save("missing-proof.json", refusal);
  assert.deepEqual(
    (await call("asset.list", {})).assets,
    [],
    "Unproven audio must not publish any asset",
  );
  const submitted = await call("acquisition.import", { requestId: "canonical", path: source });
  const job = await poll(
    () => call("job.get", { jobId: submitted.jobId }, { transport: "mcp" }),
    (v) => v.state === "ready",
    "canonical import",
  );
  const acquisition = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
  await save("acquisition.json", acquisition);
  assert.equal(acquisition.evidence.receipt.header.schemaVersion, 2);
  const binding = acquisition.bindings.find((b) => b.sourceRoles.includes("narration"));
  const asset = await call("asset.get", { assetId: binding.assetId });
  await save("asset.json", asset);
  assert.equal(
    binding.assetId,
    acquisition.evidence.receipt.publications.narration.canonical.sha256,
  );
  const selection = {
    acquisitionId: acquisition.id,
    assetId: binding.assetId,
    streamId: binding.streamId,
  };
  const range = { startUs: 0, endUs: asset.streams[0].endUs };
  const full = await audio({ ...selection, range }, "source-full");
  const physical = await audio(
    { assetId: binding.assetId, streamId: binding.streamId, range },
    "physical-full",
  );
  assert.deepEqual(
    full,
    physical,
    "Verified acquisition must preserve every original physical sample",
  );
  const nativeOrigin = asset.originUs;
  const expected = Buffer.alloc(full.length);
  for (let i = 0; i < 96000; i++) {
    const frame =
      Math.floor(((100001 - nativeOrigin) * 48000) / 1e6) + (i < 32768 ? i : 50000 + i - 32768);
    if (frame >= 0 && frame * 4 < expected.length)
      expected.writeFloatLE((((i * 97) % 1009) - 504) / 1024, frame * 4);
  }
  assert.deepEqual(
    full,
    expected,
    "Complete PCM must match independent authored sample identities",
  );
  for (const [name, range] of [
    ["source-late", { startUs: 1200011, endUs: 1299567 }],
    ["source-tail", { startUs: 2300000, endUs: asset.streams[0].endUs }],
  ]) {
    const bytes = await audio({ ...selection, range }, name);
    assert.deepEqual(
      bytes,
      full.subarray(Math.floor(range.startUs * 0.048) * 4, Math.floor(range.endUs * 0.048) * 4),
    );
  }
  // A separate schema1 acquisition expresses a real 1 us external exclusion, deliberately
  // crossing one output sample edge. Exact canonical occupancy must not widen that mask.
  const masked = join(scratch, "masked");
  await mkdir(masked);
  for (const name of ["video.mov", "narration.mov"])
    await copyFile(join(source, name), join(masked, name));
  const maskRecords = [
    {
      event: "header",
      data: { ...acquisition.evidence.receipt.header, schemaVersion: 1, sessionID: "one-us-mask" },
    },
    { event: "origin", data: { hostUs: 0 } },
    ...[
      [100001, 782668],
      [1141668, 1300000],
      [1300001, 2459001],
    ].map(([startUs, endUs]) => ({
      event: "audioSamples",
      data: { role: "narration", startUs, endUs },
    })),
  ];
  await writeFile(
    join(masked, "capture.journal.jsonl"),
    maskRecords.map((row, i) => JSON.stringify({ sequence: i + 1, ...row }) + "\n").join(""),
  );
  const maskAdmission = await call("acquisition.import", { requestId: "mask", path: masked });
  const maskJob = await poll(
    () => call("job.get", { jobId: maskAdmission.jobId }),
    (v) => v.state === "ready",
    "one us mask",
  );
  const maskContext = await call("acquisition.get", {
    acquisitionId: maskJob.target.acquisitionId,
  });
  const maskPCM = await audio(
    { ...selection, acquisitionId: maskContext.id, range },
    "one-us-mask",
  );
  const maskExpected = Buffer.from(full);
  maskExpected.writeFloatLE(0, 57599 * 4);
  assert.notEqual(full.readFloatLE(57599 * 4), 0);
  assert.deepEqual(
    maskPCM,
    full,
    "Schema1's documented rounded-endpoint seam tolerance remains unchanged",
  );
  const exactMaskRequest = {
    source: {
      source: join(source, "narration.mov"),
      streamId: binding.streamId,
      sourceOffsetUs: -asset.originUs,
      available: [
        { startUs: 0, endUs: 682667 },
        { startUs: 1041667, endUs: 1199999 },
        { startUs: 1200000, endUs: 2359000 },
      ],
    },
    range,
    output: join(out, "native-exact-mask.wav"),
  };
  await save("native-exact-mask.request.json", exactMaskRequest);
  const exactMask = nativeResult(await mediaWorker()("media.sourceAudio", exactMaskRequest));
  await save("native-exact-mask.json", exactMask);
  const exactBytes = (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        exactMaskRequest.output,
        "-f",
        "f32le",
        "-c:a",
        "pcm_f32le",
        "pipe:1",
      ],
      { encoding: "buffer" },
    )
  ).stdout;
  assert.deepEqual(
    exactBytes,
    maskExpected,
    "Already-normalized exact external mask must keep its 1 us exclusion",
  );
  await save("mask-comparison.json", {
    schema1RoundedSeamMerged: true,
    nativeExactExternalMask: true,
    publicArbitraryExternalMask:
      "No such public selection input; schema2 gaps are whole native frames",
  });
  const created = await call("project.create", {
    requestId: "create",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const edited = await call("edit.apply", {
    projectId,
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          ...selection,
          source: { kind: "range", range },
          placement: { kind: "project", range },
        },
      },
    ],
  });
  await save("revision.json", edited);
  const projectPCM = await audio({ projectId, range }, "project-full");
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "canonical.zip",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "package export",
  );
  await service.stop();
  await rm(donor, { recursive: true });
  await rm(source, { recursive: true });
  await start(receiver);
  const corruptDirectory = join(scratch, "corrupt-package");
  await mkdir(corruptDirectory);
  await run("unzip", ["-q", exported.output, "-d", corruptDirectory]);
  const manifestPath = join(corruptDirectory, "manifest.json"),
    manifest = JSON.parse(await readFile(manifestPath));
  const resourceMember = await resourceFile(corruptDirectory, manifest, "acquisition");
  const resource = resourceMember.value;
  const proofMember = manifest.inventory.find((row) =>
    row.path.endsWith("narration.publication.json"),
  );
  const proofPath = join(corruptDirectory, proofMember.path),
    proof = JSON.parse(await readFile(proofPath));
  proof.acceptedFrames = "99999";
  const altered = JSON.stringify(proof);
  await writeFile(proofPath, altered);
  proofMember.bytes = Buffer.byteLength(altered);
  proofMember.sha256 = hash(Buffer.from(altered));
  resource.acquisition.receipt.publications.narration.receipt = {
    bytes: String(proofMember.bytes),
    sha256: proofMember.sha256,
  };
  await resourceMember.save();
  await writeFile(manifestPath, JSON.stringify(manifest));
  const corruptArchive = join(out, "invalid-proof.zip");
  await run("zip", ["-qr", corruptArchive, "."], { cwd: corruptDirectory });
  const invalid = await call("package.open", { path: corruptArchive });
  const rejected = await poll(
    () => call("package.status", { admissionId: invalid.id }),
    (v) => v.state === "failed",
    "tampered proof",
  );
  await save("invalid-package.json", rejected);
  assert.match(rejected.error, /represented prefix|publication/i);
  const clockDirectory = join(scratch, "clock-package");
  await mkdir(clockDirectory);
  await run("unzip", ["-q", exported.output, "-d", clockDirectory]);
  const clockManifestPath = join(clockDirectory, "manifest.json");
  const clockManifest = JSON.parse(await readFile(clockManifestPath));
  const clockAcquisition = await resourceFile(clockDirectory, clockManifest, "acquisition");
  const clockContext = clockAcquisition.value.acquisition;
  const clockBinding = clockContext.bindings.find((row) => row.sourceRoles.includes("narration"));
  const clockAssetMember = await resourceFile(
    clockDirectory,
    clockManifest,
    "asset",
    clockBinding.assetId,
  );
  const clockAsset = clockAssetMember.value.asset;
  clockAsset.originUs += 1;
  clockBinding.sourceToAssetOffsetUs -= 1;
  clockBinding.available = clockBinding.available.map(({ startUs, endUs }) => ({
    startUs: Math.max(0, startUs - 1),
    endUs: endUs - 1,
  }));
  await clockAcquisition.save();
  await clockAssetMember.save();
  await writeFile(clockManifestPath, JSON.stringify(clockManifest));
  const clockArchive = join(out, "invalid-clock.zip");
  await run("zip", ["-qr", clockArchive, "."], { cwd: clockDirectory });
  const clockAdmission = await call("package.open", { path: clockArchive });
  const clockResult = await poll(
    () => call("package.status", { admissionId: clockAdmission.id }),
    (v) => ["ready", "failed"].includes(v.state),
    "tampered clock",
  );
  await save("invalid-clock.json", clockResult);
  assert.equal(
    clockResult.state,
    "failed",
    "Canonical metadata cannot change physical clock meaning",
  );
  const downgradeDirectory = join(scratch, "downgrade-package");
  await mkdir(downgradeDirectory);
  await run("unzip", ["-q", exported.output, "-d", downgradeDirectory]);
  const downgradePath = join(downgradeDirectory, "manifest.json"),
    downgrade = JSON.parse(await readFile(downgradePath));
  const downgradeMember = await resourceFile(downgradeDirectory, downgrade, "acquisition");
  const downgraded = downgradeMember.value.acquisition;
  downgraded.receipt.header.schemaVersion = 1;
  delete downgraded.receipt.publications;
  for (const entry of downgrade.inventory.filter((row) => row.path.endsWith(".publication.json")))
    await rm(join(downgradeDirectory, entry.path));
  downgrade.inventory = downgrade.inventory.filter(
    (row) => !row.path.endsWith(".publication.json"),
  );
  await downgradeMember.save();
  await writeFile(downgradePath, JSON.stringify(downgrade));
  const downgradeArchive = join(out, "invalid-layout.zip");
  await run("zip", ["-qr", downgradeArchive, "."], { cwd: downgradeDirectory });
  const downgradeAdmission = await call("package.open", { path: downgradeArchive });
  const downgradeResult = await poll(
    () => call("package.status", { admissionId: downgradeAdmission.id }),
    (v) => ["ready", "failed"].includes(v.state),
    "tampered layout",
  );
  await save("invalid-layout.json", downgradeResult);
  assert.equal(
    downgradeResult.state,
    "failed",
    "Claimed legacy layout cannot bypass actual packed journal verification",
  );
  const admission = await call("package.open", { path: exported.output });
  const opened = await poll(
    () => call("package.status", { admissionId: admission.id }),
    (v) => v.state === "ready",
    "package open",
  );
  const adopted = await poll(
    () => call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt" }),
    (v) => v.state === "ready",
    "package adopt",
  );
  await save("adopted.json", adopted);
  const relocated = await audio(
    { projectId: adopted.published.output.projectId, range },
    "relocated-project",
  );
  assert.deepEqual(relocated, projectPCM);
  await call("package.close", { admissionId: admission.id });
  await service.stop();
  await start(receiver);
  const restarted = await audio({ ...selection, range }, "restarted-source");
  assert.deepEqual(restarted, full);
  report.checks = {
    exactSource: true,
    fullLateTail: true,
    packageRelocation: true,
    restart: true,
    nativeOneMicrosecondMask: true,
    schema1RoundedSeamPreserved: true,
    missingProofRefused: true,
    tamperedPortableProofRefused: true,
    tamperedCanonicalClockRefused: true,
    layoutDowngradeRefused: true,
  };
  report.passed = true;
} finally {
  await service?.stop();
  await save("report.json", report);
  await rm(scratch, { recursive: true, force: true });
}
