import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { Catalog } from "../../core/dist/catalog.js";
import { JobQueue } from "../../core/dist/jobs.js";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE, "Pass --out and YAP_NATIVE");
const out = resolve(values.out),
  home = join(out, "home");
await mkdir(out);
const source = join(root, "specs/done/agent-editing/assets/00-corpus/a-audio.wav");
const original = await readFile(source),
  assetId = hash(original);
const report = {
  passed: false,
  trace: [],
  checks: [],
  history: [],
  timings: {},
  sourceSha256: assetId,
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const catalogPath = join(home, "library/catalog.sqlite");
function inspect() {
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  try {
    return {
      references: db
        .prepare(
          "SELECT ownerKind AS kind,ownerId AS id FROM resource_references WHERE resourceKind='asset' AND resourceId=? ORDER BY ownerKind,ownerId",
        )
        .all(assetId)
        .map((r) => ({ ...r })),
      orphanOwners: db
        .prepare(
          "SELECT ref.ownerKind,ref.ownerId FROM resource_references ref LEFT JOIN jobs j ON j.jobId=ref.ownerId WHERE ref.ownerKind IN ('job','job-input') AND j.jobId IS NULL",
        )
        .all()
        .map((r) => ({ ...r })),
      jobs: db
        .prepare("SELECT jobId,state FROM jobs ORDER BY jobId")
        .all()
        .map((r) => ({ ...r })),
    };
  } finally {
    db.close();
  }
}
function assertReferences(ids) {
  const actual = inspect();
  assert.deepEqual(
    actual.references,
    [...ids].sort().map((id) => ({ kind: "job", id })),
  );
  assert.deepEqual(actual.orphanOwners, []);
  return actual;
}
async function ready(params) {
  return poll(
    () => call("audio.get", params, { transport: "mcp" }),
    (v) => v.state === "ready",
    "selected source audio",
  );
}
// The public service intentionally exposes no asset/job retirement operation.
// Reopen only after it closes; the existing queue owns all retirement writes.
async function retire(ids, survivors) {
  const catalog = new Catalog(catalogPath);
  const unexpected = () => {
    throw new Error("Drained retirement must not admit or execute work");
  };
  const queue = new JobQueue({
    store: catalog,
    targets: {
      pin: unexpected,
      isAvailable: unexpected,
      isDeleting: unexpected,
      isCapturing: () => false,
    },
    execute: unexpected,
    providers: { newId: randomUUID },
  });
  const started = performance.now();
  try {
    for (const id of ids) queue.forgetJob(id);
    assertReferences(survivors);
    for (const id of ids) assert.throws(() => queue.inspect(id), { code: "NOT_FOUND" });
  } finally {
    await queue.close();
    catalog.close();
  }
  return performance.now() - started;
}
try {
  await service.start();
  const imported = await call("asset.import", { requestId: "retirement-source", path: source });
  await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "real source import",
  );
  const asset = await call("asset.get", { assetId });
  const stream = asset.streams.find((v) => v.kind === "audio" && v.decodable);
  assert.ok(stream && stream.endUs >= 1000000);
  const selection = { assetId, streamId: stream.id };
  const survivor = { ...selection, range: { startUs: 900000, endUs: 910000 } };
  const sibling = await ready(survivor);
  const before = await call("audio.get", survivor, { output: join(out, "survivor-before.wav") });
  const siblingBytes = await readFile(before.output);
  report.survivor = { jobId: sibling.jobId, sha256: hash(siblingBytes) };
  const started = performance.now();
  for (let base = 0; base < 513; base += 4) {
    const results = await Promise.all(
      Array.from({ length: Math.min(4, 513 - base) }, async (_, i) => {
        const range = { startUs: (base + i) * 1000, endUs: (base + i) * 1000 + 500 };
        const done = await ready({ ...selection, range });
        return { jobId: done.jobId, range };
      }),
    );
    report.history.push(...results);
    if (base % 64 === 0) console.log(JSON.stringify({ ready: report.history.length }));
  }
  report.timings.publicSetupMs = performance.now() - started;
  const history = report.history.map((v) => v.jobId);
  assert.equal(new Set(history).size, 513);
  const canceledSelection = { ...selection, range: { startUs: 800000, endUs: 810000 } };
  let held = await service.arm("media.sourceAudio");
  const canceled = await call("audio.get", canceledSelection, { transport: "mcp" });
  await held();
  await call("job.cancel", { jobId: canceled.jobId });
  await poll(
    () => call("job.get", { jobId: canceled.jobId }),
    (v) => v.state === "canceled",
    "canceled sibling",
  );
  const interruptedSelection = { ...selection, range: { startUs: 850000, endUs: 860000 } };
  held = await service.arm("media.sourceAudio");
  const interrupted = await call("audio.get", interruptedSelection, { transport: "mcp" });
  await held();
  const retained = [imported.jobId, sibling.jobId, canceled.jobId, interrupted.jobId];
  report.beforeRestart = assertReferences([...history, ...retained]);
  await service.stop(true);
  await service.start();
  const failed = await call("job.get", { jobId: interrupted.jobId });
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorCode, "JOB_INTERRUPTED");
  assert.equal(failed.retryable, true);
  assert.equal((await call("job.get", { jobId: canceled.jobId })).state, "canceled");
  report.retainedStates = { canceledJobId: canceled.jobId, interruptedJobId: interrupted.jobId };
  assertReferences([...history, ...retained]);
  await service.stop();
  assert.throws(() => assertReferences([...history.slice(257), ...retained]), /Expected values/);
  report.checks.push("reference checker rejects the unretired source history");
  report.timings.firstRetirementMs = await retire(history.slice(0, 257), [
    ...history.slice(257),
    ...retained,
  ]);
  await service.start();
  assertReferences([...history.slice(257), ...retained]);
  assert.equal((await call("job.get", { jobId: history[0] }, { error: true })).code, "NOT_FOUND");
  assert.equal((await call("job.get", { jobId: history[257] })).state, "ready");
  assert.equal((await call("audio.get", survivor, { transport: "mcp" })).jobId, sibling.jobId);
  await service.stop();
  report.timings.finalRetirementMs = await retire(history.slice(257), retained);
  await service.start();
  report.afterRetirement = assertReferences(retained);
  for (const [params, id] of [
    [canceledSelection, canceled.jobId],
    [interruptedSelection, interrupted.jobId],
  ]) {
    const status = await call("audio.get", params, { transport: "mcp" });
    assert.equal(status.jobId, id);
    assert.notEqual(status.state, "ready");
    await call("job.retry", { jobId: status.jobId }, { transport: "mcp" });
    assert.equal((await ready(params)).jobId, id);
  }
  const after = await call("audio.get", survivor, { output: join(out, "survivor-after.wav") });
  assert.equal(after.jobId, sibling.jobId);
  assert.deepEqual(await readFile(after.output), siblingBytes);
  assertReferences(retained);
  assert.deepEqual(await readFile(source), original);
  const finalAsset = await call("asset.get", { assetId });
  assert.deepEqual(finalAsset, asset);
  report.checks.push(
    "513 distinct real native source jobs retired in two drained phases",
    "ordinary asset job references exact; zero job/job-input orphan owners",
    "public partial-reopen and final restart preserve sibling identities",
    "canceled and interrupted siblings retain sources and explicitly retry same identities",
    "surviving ready audio is byte exact",
    "original asset/source unchanged; no GC claim",
  );
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
}
console.log(JSON.stringify({ out, passed: report.passed, timings: report.timings }));
