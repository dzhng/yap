import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backup } from "node:sqlite";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Catalog } from "../../core/dist/catalog.js";
import { AssetStore } from "../../core/dist/assets.js";
import { AcquisitionStore } from "../../core/dist/acquisitions.js";
import { ProjectStore } from "../../core/dist/projects.js";
import { TranscriptStore } from "../../core/dist/transcript.js";
import { assetTranscriptOwner } from "../../core/dist/transcript-processing.js";
import { archiveLimits, projectJsonBytes } from "../../core/dist/package-archive.js";
import { resourceMetadataMember, resourceMembers } from "../../core/dist/project-package.js";
import { mediaWorker } from "../../../apps/service/dist/worker.js";
import { readMediaProbe } from "../../../apps/service/dist/media-probe.js";
import { JourneyService, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out, { mode: 0o700 });
const donor = join(out, "donor"),
  receiver = join(out, "receiver");
await mkdir(join(donor, "library"), { recursive: true, mode: 0o700 });
const report = {
  passed: false,
  scope: "Real retained history times document size; no model/DSP or universal scale SLA",
  controls: { revisions: 1000, clips: 250, operationalStopBytes: 4 * 1024 ** 3 },
  trace: [],
  fixture: {},
  stages: [],
  checks: {},
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const digest = (value) => hash(canonical(value));
const expected = [];
let expectedResourceMembers = [];
let service,
  sampling,
  stopped = true,
  sampleError,
  stage,
  projectId,
  pinnedId;
const operationalGuard = (bytes) =>
  assert(
    bytes <= report.controls.operationalStopBytes,
    "Operational memory stop guard exceeded; not an acceptance SLA",
  );
async function ownedProcesses(rootPid) {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,lstart="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((row) => {
      const [, pid, parent, started] = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return { pid: Number(pid), parent: Number(parent), started };
    });
  const owned = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if ((row.pid === rootPid || owned.has(row.parent)) && !owned.has(row.pid)) {
        owned.set(row.pid, row.started);
        changed = true;
      }
  }
  return owned;
}
async function stopOwnedProcesses(owned) {
  for (const [pid, started] of [...owned].reverse()) {
    const current = await ownedProcesses(pid);
    if (current.get(pid) !== started) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
async function close() {
  stopped = true;
  await sampling;
  sampling = undefined;
  if (service) {
    const owned = await ownedProcesses(service.child?.pid);
    try {
      await service.stop();
    } catch (error) {
      await stopOwnedProcesses(owned);
      throw error;
    }
  }
  service = undefined;
}
async function start(home, name) {
  await close();
  stage = { name, rssSamples: [] };
  report.stages.push(stage);
  service = new JourneyService(home, report);
  await service.start();
  stopped = false;
  sampling = (async () => {
    while (!stopped) {
      const { stdout } = await run("ps", ["-o", "rss=", "-p", String(service.child.pid)]);
      const bytes = Number(stdout.trim()) * 1024;
      stage.rssSamples.push({ atMs: performance.now(), bytes });
      stage.sampledPeakBytes = Math.max(stage.sampledPeakBytes ?? 0, bytes);
      if (bytes > report.controls.operationalStopBytes) {
        sampleError = new Error("Operational memory stop guard exceeded during pending work");
        const owned = await ownedProcesses(service.child.pid);
        report.memoryStop = { stage: stage.name, bytes, ownedPids: [...owned.keys()] };
        await stopOwnedProcesses(owned);
        throw sampleError;
      }
      await delay(25);
    }
  })().catch((error) => {
    sampleError = error;
    stopped = true;
  });
}
async function call(operation, params, options = {}) {
  let result;
  try {
    result = await service.call(operation, params, { transport: "mcp", ...options });
  } catch (error) {
    throw sampleError ?? error;
  }
  if (sampleError) throw sampleError;
  operationalGuard(stage.sampledPeakBytes ?? 0);
  return result;
}
async function audio(selection, label) {
  const request = { ...selection, range: { startUs: 24900000, endUs: 25000000 } };
  await poll(
    () => call("audio.get", request),
    (v) => v.state === "ready",
    label,
  );
  const path = join(out, `${label}.wav`);
  await call("audio.get", request, { output: path, transport: "cli" });
  return readFile(path);
}
async function exported(exportId) {
  return poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "package export",
  );
}
async function inventory(path) {
  const { stdout } = await run("/usr/bin/unzip", ["-p", path, "manifest.json"], {
    maxBuffer: 3 * 1024 ** 2,
  });
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.revisions.length, 1000);
  assert.deepEqual(
    manifest.undo,
    expected.slice(0, -1).map((row) => row.id),
  );
  assert.equal(manifest.references.length, 1000);
  const revisionMembers = manifest.inventory.filter((member) =>
    member.path.startsWith("revisions/"),
  );
  assert.equal(revisionMembers.length, 1000);
  const byPath = new Map(revisionMembers.map((member) => [member.path, member]));
  assert.deepEqual(
    manifest.revisions,
    expected.map((row) => `revisions/${row.ordinal}.json`),
  );
  for (let ordinal = 0; ordinal < 1000; ordinal++) {
    const member = byPath.get(`revisions/${ordinal}.json`);
    assert(member);
    assert.equal(member.sha256, expected[ordinal].serializedSha256);
    assert.equal(member.bytes, expected[ordinal].bytes);
  }
  for (const member of expectedResourceMembers)
    assert.deepEqual(
      manifest.inventory.find((value) => value.path === member.path),
      member,
    );
  return manifest;
}
// A shutdown failure is rethrown only after the run itself succeeded, so it never masks the run's error.
let shutdownFailure;
try {
  const source = join(donor, "source.wav");
  await copyFile(join(root, "specs/done/agent-editing/assets/18-voice/reference.wav"), source);
  const catalog = new Catalog(":memory:");
  const before = performance.now();
  try {
    const assets = new AssetStore(catalog, join(donor, "library"));
    await assets.recover();
    const acquisitions = new AcquisitionStore(catalog);
    const projects = new ProjectStore(
      catalog,
      assets,
      new TranscriptStore(
        catalog,
        join(donor, "library"),
        assetTranscriptOwner(assets, acquisitions),
      ),
      acquisitions,
    );
    const worker = mediaWorker(process.env);
    const asset = await assets.import(source, { kind: "import" }, (path, signal) =>
      readMediaProbe(worker, donor, path, signal, []),
    );
    const made = projects.create({
      requestId: "create",
      canvas: {
        width: 320,
        height: 240,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    projectId = made.project.projectId;
    const retain = (revision) =>
      expected.push({
        id: revision.revisionId,
        ordinal: revision.ordinal,
        bytes: Buffer.byteLength(JSON.stringify(revision)),
        serializedSha256: hash(JSON.stringify(revision)),
        semanticSha256: digest(revision),
        documentSha256: digest(revision.document),
        clips: revision.document.clips.length,
      });
    retain(made.revision);
    const operations = [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    ];
    for (let i = 0; i < 250; i++)
      operations.push({
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          assetId: asset.id,
          streamId: asset.streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 100000 } },
          placement: { kind: "project", range: { startUs: i * 100000, endUs: (i + 1) * 100000 } },
        },
      });
    let revision = projects.apply(projectId, {
      requestId: "place",
      expectedRevisionId: made.revision.revisionId,
      operations,
    }).revision;
    retain(revision);
    report.fixture.memory = [];
    for (let ordinal = 2; ordinal < 1000; ordinal++) {
      revision = projects.apply(projectId, {
        requestId: `edit-${ordinal}`,
        expectedRevisionId: revision.revisionId,
        operations: [
          {
            operation: "canvas.set",
            canvas: { background: `#${ordinal.toString(16).padStart(6, "0")}ff` },
          },
        ],
      }).revision;
      retain(revision);
      if (ordinal % 10 === 0) {
        const memory = process.memoryUsage();
        report.fixture.memory.push({ ordinal, ...memory });
        operationalGuard(process.resourceUsage().maxRSS * 1024);
      }
    }
    pinnedId = revision.revisionId;
    const actual = catalog.catalog
      .prepare(
        "SELECT COUNT(*) AS count,SUM(length(CAST(content AS BLOB))) AS bytes,MAX(length(CAST(content AS BLOB))) AS maximum FROM project_revisions WHERE projectId=?",
      )
      .get(projectId);
    assert.equal(actual.count, 1000);
    assert.equal(
      actual.bytes,
      expected.reduce((sum, row) => sum + row.bytes, 0),
    );
    const metadata = resourceMetadataMember({ kind: "asset", ...assets.portable(asset.id) });
    expectedResourceMembers = [
      ...resourceMembers({ kind: "asset", ...assets.portable(asset.id) }),
      metadata.reference.metadata,
    ];
    assert.equal(hash(await readFile(source)), asset.id);
    report.fixture.expectedResourceMembers = expectedResourceMembers;
    const edges = projects
      .snapshot(projectId)
      .references.reduce((sum, reference) => sum + reference.resources.length, 0);
    assert(actual.bytes + metadata.reference.metadata.bytes <= projectJsonBytes);
    assert(actual.maximum <= archiveLimits.revisionBytes);
    assert(edges <= 25000);
    Object.assign(report.fixture, {
      projectId,
      pinnedId,
      actual,
      metadataBytes: metadata.reference.metadata.bytes,
      aggregateJsonBytes: actual.bytes + metadata.reference.metadata.bytes,
      dependencyEdges: edges,
      assetId: asset.id,
      sourceSha256: hash(await readFile(source)),
      durationMs: performance.now() - before,
      peakRSSBytes: process.resourceUsage().maxRSS * 1024,
    });
  } finally {
    await backup(catalog.catalog, join(donor, "library/catalog.sqlite"));
    catalog.close();
  }
  await writeFile(join(out, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  await start(donor, "donor export");
  const baseline = await audio({ projectId, revisionId: pinnedId }, "donor-late");
  const firstId = randomUUID();
  await call(
    "export.create",
    {
      projectId,
      requestId: firstId,
      kind: "processed-package",
      directory: out,
      leaf: "pinned-before.zip",
    },
    { transport: "cli" },
  );
  const advanced = await call("edit.apply", {
    projectId,
    expectedRevisionId: pinnedId,
    requestId: "revision-1001",
    operations: [{ operation: "canvas.set", canvas: { background: "#abcdef12" } }],
  });
  assert.equal(advanced.revision.ordinal, 1000);
  const refused = await call(
    "export.create",
    {
      projectId,
      requestId: randomUUID(),
      kind: "processed-package",
      directory: out,
      leaf: "refused.zip",
    },
    { error: true },
  );
  assert.equal(refused.code, "LIMIT_EXCEEDED");
  await assert.rejects(stat(join(out, "refused.zip")), { code: "ENOENT" });
  const first = await exported(firstId);
  const firstManifest = await inventory(first.output);
  const secondId = randomUUID();
  await call("export.create", {
    projectId,
    revisionId: pinnedId,
    requestId: secondId,
    kind: "processed-package",
    directory: out,
    leaf: "pinned-after.zip",
  });
  const second = await exported(secondId);
  const secondManifest = await inventory(second.output);
  assert.deepEqual(
    {
      ...secondManifest,
      inventory: [...secondManifest.inventory].sort((a, b) => a.path.localeCompare(b.path)),
    },
    {
      ...firstManifest,
      inventory: [...firstManifest.inventory].sort((a, b) => a.path.localeCompare(b.path)),
    },
  );
  report.checks.pinnedPriorExport = {
    refused,
    manifestSha256: digest(firstManifest),
    manifestBytes: Buffer.byteLength(JSON.stringify(firstManifest)),
    members: firstManifest.inventory.length,
    first,
    second,
  };
  await close();
  await rename(donor, join(out, "donor-unavailable"));
  await assert.rejects(stat(donor), { code: "ENOENT" });
  await start(receiver, "receiver open/adopt/read");
  const admission = await call("package.open", { path: second.output }, { transport: "cli" });
  const opened = await poll(
    () => call("package.status", { admissionId: admission.id }),
    (v) => v.state === "ready",
    "package open",
  );
  const adopted = await poll(
    () => call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt" }),
    (v) => v.state === "ready",
    "package adoption",
  );
  await call("package.close", { admissionId: admission.id });
  const receivingId = adopted.published.output.projectId;
  let cursor = null,
    count = 0;
  const mapped = [];
  do {
    const page = await call("revision.history", { projectId: receivingId, cursor, limit: 10 });
    for (const revision of page.revisions) {
      const original = expected[count];
      assert(original);
      assert.equal(revision.ordinal, count);
      assert.notEqual(revision.revisionId, original.id);
      assert.equal(digest({ ...revision, id: original.id, projectId }), original.semanticSha256);
      mapped.push(revision.revisionId);
      count++;
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(count, 1000);
  const receiverExportId = randomUUID();
  await call("export.create", {
    projectId: receivingId,
    requestId: receiverExportId,
    kind: "processed-package",
    directory: out,
    leaf: "receiver-history.zip",
  });
  const receiverExport = await exported(receiverExportId);
  const { stdout: receiverManifestBody } = await run(
    "/usr/bin/unzip",
    ["-p", receiverExport.output, "manifest.json"],
    { maxBuffer: 3 * 1024 ** 2 },
  );
  const receiverManifest = JSON.parse(receiverManifestBody);
  assert.deepEqual(receiverManifest.undo, mapped.slice(0, -1));
  report.checks.completeAdoptedUndoSha256 = digest(receiverManifest.undo);
  for (const ordinal of [0, 500, 999]) {
    const read = await call(
      "revision.get",
      { projectId: receivingId, revisionId: mapped[ordinal] },
      { transport: "cli" },
    );
    assert.equal(digest(read.revision.document), expected[ordinal].documentSha256);
  }
  assert.deepEqual(
    await audio({ projectId: receivingId, revisionId: mapped[999] }, "receiver-late"),
    baseline,
  );
  const undone = await call("edit.undo", {
    projectId: receivingId,
    expectedRevisionId: mapped[999],
    requestId: "undo-retained",
  });
  assert.equal(digest(undone.document), expected[998].documentSha256);
  assert.deepEqual(
    await audio({ projectId: receivingId, revisionId: undone.id }, "receiver-undone-late"),
    baseline,
  );
  report.checks.adoption = {
    result: adopted.published.output,
    revisions: count,
    fullSemanticHistorySha256: digest(expected.map((row) => row.semanticSha256)),
    audioSha256: hash(baseline),
    undoDocumentSha256: digest(undone.document),
    donorUnavailable: true,
  };
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  try {
    await close();
  } catch (error) {
    report.passed = false;
    report.shutdownError = error.message;
    shutdownFailure = error;
  }
  report.controllerPeakRSSBytes = process.resourceUsage().maxRSS * 1024;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
if (shutdownFailure) throw shutdownFailure;
