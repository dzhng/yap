import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fixture } from "./fixtures/project-export.mjs";
import { crashFixture, killExportOwner, receiptCrash } from "./fixtures/project-export-crash.mjs";

test("actual owner death after staging allocation retries the same intent", async (t) => {
  const { f, reopened, exportId } = await crashFixture(t, "allocate");
  assert.equal(
    reopened.catalog.catalog
      .prepare("SELECT staging FROM export_intents WHERE exportId=?")
      .get(exportId).staging,
    null,
  );
  assert.deepEqual(await readdir(join(f.output, ".yap-export-" + exportId)), []);
  await reopened.exports.retry(exportId);
  await reopened.jobs.idle();
  assert.equal(reopened.exports.status(exportId).state, "committed");
});

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("actual owner death between external commit and catalog acknowledgement reconciles without republishing", async (t) => {
  const { f, reopened, exportId } = await crashFixture(t, "commit");
  const before = await readFile(join(f.output, "recovered.mp4"));
  try {
    assert.equal(
      reopened.catalog.catalog
        .prepare("SELECT receipt FROM export_intents WHERE exportId=?")
        .get(exportId).receipt,
      null,
    );
    const metadataBytes = (await stat(join(f.output, ".yap-export-" + exportId, "prepared.json")))
      .size;
    assert.equal((await reopened.storage.usage()).otherBytes, metadataBytes);
    await reopened.exports.recover(exportId);
    await reopened.jobs.idle();
    const status = await reopened.exports.status(exportId);
    assert.equal(status.state, "committed");
    assert.equal(reopened.jobs.job(status.jobId).state, "failed");
    assert.equal(sha(await readFile(join(f.output, "recovered.mp4"))), sha(before));
    assert.deepEqual(await readdir(f.output), ["recovered.mp4"]);
    await reopened.deletion.delete({ kind: "project", id: f.projectId });
    assert.deepEqual(await readdir(f.output), ["recovered.mp4"]);
  } finally {
    await reopened.close();
  }
});

test("actual owner death after catalog commit finishes private acknowledgement on recovery", async (t) => {
  const { f, reopened, exportId } = await crashFixture(t, "ack");
  try {
    const committed = await reopened.exports.status(exportId);
    assert.equal(committed.state, "committed");
    assert.deepEqual((await readdir(join(f.output, ".yap-export-" + exportId))).sort(), [
      "payload",
      "prepared.json",
    ]);
    await reopened.exports.recover(exportId);
    await reopened.jobs.idle();
    assert.deepEqual(await readdir(f.output), ["recovered.mp4"]);
    assert.deepEqual((await reopened.exports.status(exportId)).receipt, committed.receipt);
  } finally {
    await reopened.close();
  }
});

test("explicit recovery refreshes a negative observation when the same committed file returns", async (t) => {
  const { reopened: f, exportId } = await crashFixture(t, "commit");
  const destination = join(f.output, "recovered.mp4"),
    moved = join(f.output, "moved.mp4");
  const before = await stat(destination, { bigint: true });
  await rename(destination, moved);
  f.exports.resumeRecovery();
  await f.jobs.idle();
  const missing = f.exports.status(exportId);
  assert.equal(missing.receipt, null);
  assert.equal(JSON.parse(missing.recovery.published.result).observation, "missing");
  const attempt = f.jobs.job(missing.recovery.jobId).attemptId;
  await rename(moved, destination);
  f.exports.resumeRecovery();
  assert.equal(f.jobs.job(missing.recovery.jobId).attemptId, attempt);
  f.exports.recover(exportId);
  await f.jobs.idle();
  const restored = f.exports.status(exportId);
  assert.equal(restored.state, "committed");
  assert.notEqual(f.jobs.job(restored.recovery.jobId).attemptId, attempt);
  assert.equal((await stat(destination, { bigint: true })).ino, before.ino);
});

test("canceling recovery keeps its lane until close and preserves an actually observed commit", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { reopened: f, exportId } = await crashFixture(
    t,
    "commit",
    (run) =>
      async (operation, ...args) => {
        const result = await run(operation, ...args);
        if (operation === "publication.reconcile") {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
  );
  f.exports.resumeRecovery();
  await entered.promise;
  const recovery = f.exports.status(exportId).recovery;
  f.exports.cancel(exportId);
  assert.equal(f.jobs.job(recovery.jobId).state, "canceled");
  assert.equal(f.jobs.isAttemptActive(f.jobs.job(recovery.jobId).attemptId), true);
  release.resolve();
  await f.jobs.idle();
  const committed = f.exports.status(exportId);
  assert.equal(committed.state, "committed");
  assert.equal(f.jobs.job(recovery.jobId).state, "canceled");
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT stagingCleared FROM export_intents WHERE exportId=?")
      .get(exportId).stagingCleared,
    0,
  );
  assert.deepEqual(f.exports.resumeRecovery(), []);
  assert.equal(f.jobs.job(recovery.jobId).state, "canceled");
  f.exports.recover(exportId);
  await f.jobs.idle();
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT stagingCleared FROM export_intents WHERE exportId=?")
      .get(exportId).stagingCleared,
    1,
  );
});

test("abandonment drains and forgets recovery identities without touching neighboring intents", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  let intercept = false;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        const result = await run(operation, ...args);
        if (operation === "publication.reconcile" && intercept) {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
  });
  const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
  for (const exportId of ids) {
    await writeFile(join(f.output, exportId + ".mp4"), "foreign");
    await f.exports.create({
      exportId,
      projectId: f.projectId,
      kind: "video",
      directory: f.output,
      leaf: exportId + ".mp4",
    });
    await f.jobs.idle();
  }
  intercept = true;
  f.exports.resumeRecovery();
  await entered.promise;
  const firstRecovery = f.exports.status(ids[0]).recovery.jobId;
  const siblingRecovery = f.exports.status(ids[1]).recovery.jobId;
  let finished = false;
  const removing = f.exports.abandon(ids[0]).then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  release.resolve();
  await removing;
  await f.jobs.idle();
  assert.throws(() => f.jobs.job(firstRecovery), { code: "NOT_FOUND" });
  assert.equal(f.jobs.job(siblingRecovery).state, "ready");
  assert.equal(f.exports.status(ids[1]).state, "failed");
  assert.equal(f.projects.get(f.projectId).projectId, f.projectId);
  for (const exportId of ids)
    assert.equal(await readFile(join(f.output, exportId + ".mp4"), "utf8"), "foreign");
});

test("recovery failures are isolated and explicit retry observes absence without publishing", async (t) => {
  let failOnce = false,
    calls = 0;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation === "publication.reconcile") {
          calls++;
          if (failOnce) {
            failOnce = false;
            throw new Error("generated recovery failure");
          }
        }
        return run(operation, ...args);
      },
  });
  const ids = [randomUUID(), randomUUID()];
  for (const exportId of ids) {
    await writeFile(join(f.output, exportId + ".mp4"), "foreign");
    await f.exports.create({
      exportId,
      projectId: f.projectId,
      kind: "video",
      directory: f.output,
      leaf: exportId + ".mp4",
    });
    await f.jobs.idle();
    assert.equal(f.exports.status(exportId).state, "failed");
  }
  failOnce = true;
  assert.deepEqual(f.exports.resumeRecovery(), []);
  await f.jobs.idle();
  const states = ids.map((id) => f.exports.status(id));
  assert.deepEqual(states.map((s) => s.recovery.state).sort(), ["failed", "ready"]);
  const failed = states.find((s) => s.recovery.state === "failed");
  const attempt = f.jobs.job(failed.recovery.jobId).attemptId,
    before = calls;
  for (let n = 0; n < 10; n++) {
    assert.deepEqual(f.exports.resumeRecovery(), []);
    f.exports.status(failed.exportId);
  }
  assert.equal(calls, before);
  assert.equal(f.jobs.job(failed.recovery.jobId).attemptId, attempt);
  await rm(join(f.output, failed.exportId + ".mp4"));
  f.exports.recover(failed.exportId);
  await f.jobs.idle();
  const recovered = f.exports.status(failed.exportId);
  assert.equal(recovered.receipt, null);
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.recovery.state, "ready");
  assert.equal(JSON.parse(recovered.recovery.published.result).observation, "missing");
  await assert.rejects(stat(join(f.output, failed.exportId + ".mp4")), { code: "ENOENT" });
  assert.notEqual(f.jobs.job(recovered.recovery.jobId).attemptId, attempt);
});

test("startup admission is bounded and capacity events discover the remaining recovery backlog", async (t) => {
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation === "publication.acknowledge")
          throw new Error("generated lost acknowledgment");
        return run(operation, ...args);
      },
  });
  for (let n = 0; n < 33; n++) {
    await f.exports.create({
      exportId: randomUUID(),
      projectId: f.projectId,
      kind: "video",
      directory: f.output,
      leaf: `${n}.mp4`,
    });
    await f.jobs.idle();
  }
  const hold = f.jobs.createContext(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve("closed"), { once: true }),
      ),
  );
  f.jobs.submitContext(hold, { artifact: "hold", input: "recovery-capacity", lane: "heavy" });
  await new Promise(setImmediate);
  assert.deepEqual(f.startRecovery(), []);
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='export-recovery'")
      .get().count,
    32,
  );
  assert.deepEqual(f.exports.resumeRecovery(), []);
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='export-recovery'")
      .get().count,
    32,
  );
  await f.jobs.closeContext(hold);
  await f.jobs.idle();
  assert.deepEqual(f.recoveryErrors, []);
  assert.equal(
    f.catalog.catalog
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE artifact='export-recovery' AND state='ready'",
      )
      .get().count,
    33,
  );
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT COUNT(*) AS count FROM export_intents WHERE stagingCleared=0")
      .get().count,
    0,
  );
  assert.deepEqual(
    (await readdir(f.output)).sort(),
    Array.from({ length: 33 }, (_, n) => `${n}.mp4`).sort(),
  );
});

test("interrupted allocation refuses nonempty substituted staging and keeps deletion pending", async (t) => {
  const { f, reopened, exportId } = await crashFixture(t, "allocate");
  try {
    const sentinel = join(f.output, ".yap-export-" + exportId, "sentinel");
    await writeFile(sentinel, "external sentinel");
    await reopened.exports.retry(exportId);
    await reopened.jobs.idle();
    assert.equal(reopened.exports.status(exportId).state, "failed");
    await assert.rejects(
      reopened.deletion.delete({ kind: "project", id: f.projectId }),
      (e) => e.code === "DELETE_FAILED" && /requires empty private staging/i.test(e.message),
    );
    assert.deepEqual(reopened.projects.deletionsPage().projectIds, [f.projectId]);
    assert.equal(await readFile(sentinel, "utf8"), "external sentinel");
    await assert.rejects(readFile(join(f.output, "recovered.mp4")), { code: "ENOENT" });
  } finally {
    await reopened.close();
  }
});

test("abandonment resumes after actual process death following private retirement", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID();
  await writeFile(join(f.output, "survives.mp4"), "foreign");
  const requested = await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "survives.mp4",
  });
  await f.jobs.idle();
  assert.equal(f.exports.status(exportId).cleanupPending, true);
  const bytes = await readFile(join(f.output, "survives.mp4"));
  await f.close();
  await killExportOwner(f, "abandon", { exportId });
  const reopened = await fixture(t, { existing: f });
  assert.equal(reopened.exports.status(exportId).abandoning, true);
  await assert.rejects(reopened.exports.retry(exportId), { code: "EXPORT_ABANDONING" });
  await reopened.exports.abandon(exportId);
  assert.throws(() => reopened.exports.status(exportId), { code: "NOT_FOUND" });
  assert.throws(() => reopened.jobs.job(requested.jobId), { code: "NOT_FOUND" });
  assert.equal(reopened.projects.get(f.projectId).projectId, f.projectId);
  assert.deepEqual(await readdir(f.output), ["survives.mp4"]);
  assert.deepEqual(await readFile(join(f.output, "survives.mp4")), bytes);
});

test("native death during receipt writing leaves unprepared evidence that the same intent can retry", async (t) => {
  const { f, exportId, stage } = await receiptCrash(t);
  assert.equal(f.exports.status(exportId).state, "failed");
  await assert.rejects(readFile(join(stage, "prepared.json")), { code: "ENOENT" });
  assert.equal((await readFile(join(stage, "receipt.pending"))).length, 1);
  await f.exports.retry(exportId);
  await f.jobs.idle();
  assert.equal(
    f.exports.status(exportId).state,
    "committed",
    JSON.stringify(f.exports.status(exportId)),
  );
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual(await readdir(f.output), ["retry.mp4"]);
});

test("native death after canonical receipt publication retains that exact payload for retry", async (t) => {
  const { f, exportId, stage } = await receiptCrash(t, "after-link");
  assert.equal(f.exports.status(exportId).state, "failed");
  const inode = (await stat(join(stage, "payload"), { bigint: true })).ino.toString();
  assert.deepEqual(
    JSON.parse(await readFile(join(stage, "prepared.json"))),
    JSON.parse(await readFile(join(stage, "receipt.pending"))),
  );
  await f.exports.retry(exportId);
  await f.jobs.idle();
  const result = f.exports.status(exportId);
  assert.equal(result.state, "committed");
  assert.equal(result.receipt.file.ino, inode);
  await assert.rejects(readdir(stage), { code: "ENOENT" });
});

test("project deletion removes a receipt interrupted before its canonical publication", async (t) => {
  const { f, exportId, stage } = await receiptCrash(t);
  assert.equal(f.exports.status(exportId).state, "failed");
  assert.equal((await readFile(join(stage, "receipt.pending"))).length, 1);
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual(await readdir(f.output), []);
});

test("startup recovery waits for the shared heavy lane and ignores failed preview dependencies", async (t) => {
  const { reopened: f, exportId } = await crashFixture(t, "commit");
  const preview = await f.preview.request({ projectId: f.projectId });
  f.cache.remove(preview.published.preview.cacheId);
  f.binding.render = async () => {
    throw new Error("generated dependency failure");
  };
  f.jobs.regenerate(preview.jobId, preview.published.generation);
  await f.jobs.idle();
  assert.equal((await f.preview.request({ projectId: f.projectId })).state, "failed");
  const failedAttempt = f.jobs.job(preview.jobId).attemptId;
  const hold = f.jobs.createContext(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve("closed"), { once: true }),
      ),
  );
  f.jobs.submitContext(hold, { artifact: "hold", input: "startup-recovery", lane: "heavy" });
  await new Promise(setImmediate);
  assert.deepEqual(f.exports.resumeRecovery(), []);
  await new Promise(setImmediate);
  const before = f.exports.status(exportId);
  assert.equal(before.receipt, null);
  assert.equal(before.recovery.state, "queued");
  for (let n = 0; n < 20; n++) {
    f.exports.status(exportId);
    assert.deepEqual(f.exports.resumeRecovery(), []);
  }
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='export-recovery'")
      .get().count,
    1,
  );
  await f.jobs.closeContext(hold);
  await f.jobs.idle();
  const after = f.exports.status(exportId);
  assert.equal(after.state, "committed");
  assert.equal(after.recovery.state, "ready");
  assert.equal(f.jobs.job(preview.jobId).attemptId, failedAttempt);
  assert.equal((await f.preview.request({ projectId: f.projectId })).state, "failed");
});
