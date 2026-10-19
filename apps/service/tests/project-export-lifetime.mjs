import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  stat,
  chmod,
  realpath,
} from "node:fs/promises";
import { ResourceReferences } from "@yap/core/references";
import { fixture, gate } from "./fixtures/project-export.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("project deletion needs no removed, moved or replaced export destination", async (t) => {
  const f = await fixture(t);
  const directories = [f.output, f.output + "-failed", f.output + "-replaced"];
  t.after(() =>
    Promise.all(directories.slice(1).map((path) => rm(path, { recursive: true, force: true }))),
  );
  for (const directory of directories.slice(1)) await mkdir(directory);
  await writeFile(join(directories[1], "taken.mp4"), "foreign");
  await writeFile(join(directories[2], "taken.mp4"), "foreign");
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, directory] of directories.entries()) {
    await f.exports.create({
      exportId: ids[i],
      projectId: f.projectId,
      kind: "video",
      directory,
      leaf: i === 0 ? "committed.mp4" : "taken.mp4",
    });
    await f.jobs.idle();
  }
  assert.deepEqual(
    ids.map((id) => [f.exports.status(id).state, f.exports.status(id).cleanupPending]),
    [
      ["committed", false],
      ["failed", true],
      ["failed", true],
    ],
  );
  await rm(directories[0], { recursive: true });
  await rm(directories[1], { recursive: true });
  const foreign = join(directories[2], ".yap-export-" + ids[2]);
  await rename(directories[2], directories[2] + "-original");
  directories.push(directories[2] + "-original");
  await mkdir(foreign, { recursive: true, mode: 0o700 });
  await writeFile(join(foreign, "payload"), "not this export's");
  assert.equal((await f.storage.usage()).otherBytes, 0);
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual(f.projects.deletionsPage().projectIds, []);
  assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 0);
  assert.equal(await readFile(join(foreign, "payload"), "utf8"), "not this export's");
});

test("abandonment fences retries and project deletion joins its drain after external commit", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        const result = await run(operation, ...args);
        if (operation === "publication.commit") {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
  });
  const exportId = randomUUID(),
    request = {
      exportId,
      projectId: f.projectId,
      kind: "video",
      directory: f.output,
      leaf: "late.mp4",
    };
  const status = await f.exports.create(request);
  await entered.promise;
  const published = await readFile(join(f.output, "late.mp4"));
  const removing = f.exports.abandon(exportId);
  assert.equal(f.exports.abandon(exportId), removing);
  assert.equal(f.exports.status(exportId).abandoning, true);
  await assert.rejects(f.exports.retry(exportId), { code: "EXPORT_ABANDONING" });
  await assert.rejects(f.exports.create(request), { code: "EXPORT_ABANDONING" });
  let abandoned = false,
    deleted = false;
  removing.then(() => {
    abandoned = true;
  });
  const deleting = f.deletion.delete({ kind: "project", id: f.projectId }).then(() => {
    deleted = true;
  });
  let cleanupClosed = false;
  const closing = f.exports.close().then(() => {
    cleanupClosed = true;
  });
  try {
    assert.throws(() => f.exports.abandon(exportId), { code: "SERVICE_STOPPED" });
    await new Promise(setImmediate);
    assert.equal(cleanupClosed, false);
    assert.equal(abandoned, false);
    assert.equal(deleted, false);
    assert.equal(f.jobs.isAttemptActive(f.jobs.job(status.jobId).attemptId), true);
    release.resolve();
    await Promise.all([removing, deleting, closing]);
    assert.deepEqual(f.projects.deletionsPage().projectIds, []);
    assert.deepEqual(await readdir(f.output), ["late.mp4"]);
    assert.deepEqual(await readFile(join(f.output, "late.mp4")), published);
  } finally {
    release.resolve();
    await Promise.allSettled([removing, deleting, closing]);
  }
});

test("a committed export remains authoritative when cancellation discards its late job result", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (op, ...args) => {
        const result = await run(op, ...args);
        if (op === "publication.commit") {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
  });
  const exportId = randomUUID();
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "late.mp4",
  });
  await entered.promise;
  f.exports.cancel(exportId);
  release.resolve();
  await f.jobs.idle();
  const status = await f.exports.status(exportId);
  assert.equal(status.state, "committed");
  assert.equal(f.jobs.job(status.jobId).state, "canceled");
  assert.equal(
    f.jobs.status({
      target: { kind: "project", id: f.projectId, revisionId: f.placed.revision.id },
      artifact: "export-media",
      input: exportId,
    }).published,
    null,
  );
  assert.equal(sha(await readFile(join(f.output, "late.mp4"))), status.receipt.sha256);
});

test("deletion drains the exporter and its validated cache descriptor before removing private bytes", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (op, ...args) => {
        const result = await run(op, ...args);
        if (op === "publication.prepare") {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
  });
  const exportId = randomUUID();
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "never.mp4",
  });
  await entered.promise;
  const preview = (await f.preview.request({ projectId: f.projectId })).published.preview;
  assert.throws(
    () => f.cache.remove(preview.cacheId),
    (e) => e.code === "CACHE_BUSY",
  );
  let deleted = false;
  const done = f.deletion.delete({ kind: "project", id: f.projectId }).then(() => {
    deleted = true;
  });
  await new Promise(setImmediate);
  assert.equal(deleted, false);
  release.resolve();
  await done;
  assert.deepEqual(await readdir(f.output), []);
  assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 0);
});

test("committed history survives external removal or replacement without silently exporting again", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID(),
    file = join(f.output, "external.mp4");
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "external.mp4",
  });
  await f.jobs.idle();
  const committed = await f.exports.status(exportId);
  await rm(file);
  const missing = await f.exports.retry(exportId);
  assert.equal(missing.state, "committed");
  assert.deepEqual(missing.receipt, committed.receipt);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await writeFile(file, "user replacement");
  const replaced = await f.exports.retry(exportId);
  assert.deepEqual(replaced.receipt, committed.receipt);
  assert.equal(await readFile(file, "utf8"), "user replacement");
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.equal(await readFile(file, "utf8"), "user replacement");
});

test("one unsafe export staging entry does not prevent retiring independent intents of the same project", async (t) => {
  const f = await fixture(t),
    ids = [randomUUID(), randomUUID()].sort();
  for (const [i, exportId] of ids.entries()) {
    await writeFile(join(f.output, `saved-${i}.mp4`), "foreign");
    await f.exports.create({
      exportId,
      projectId: f.projectId,
      kind: "video",
      directory: f.output,
      leaf: `saved-${i}.mp4`,
    });
    await f.jobs.idle();
  }
  const stage = join(f.output, ".yap-export-" + ids[0]);
  await rename(stage, stage + "-original");
  await mkdir(stage, { mode: 0o700 });
  await writeFile(join(stage, "sentinel"), "keep");
  await assert.rejects(
    f.deletion.delete({ kind: "project", id: f.projectId }),
    (e) => e.code === "DELETE_FAILED",
  );
  const discovery = f.exports.list({}).exports;
  assert.deepEqual(
    discovery.map((row) => row.id),
    [ids[0]],
  );
  const [discovered] = discovery;
  const detailed = f.exports.status(ids[0]);
  assert.deepEqual(
    [detailed.state, detailed.abandoning, detailed.cleanupPending],
    [discovered.state, discovered.abandoning, discovered.cleanupPending],
  );
  assert.equal(await readFile(join(stage, "sentinel"), "utf8"), "keep");
  await assert.rejects(readdir(join(f.output, ".yap-export-" + ids[1])), {
    code: "ENOENT",
  });
});

test("an unreadable unrelated destination never prevents deleting owned private export data", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID(),
    destination = join(f.output, "unreadable.mp4");
  await writeFile(destination, "unreadable foreign bytes", { mode: 0 });
  const before = await stat(destination, { bigint: true });
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "unreadable.mp4",
  });
  await f.jobs.idle();
  assert.equal(f.exports.status(exportId).state, "failed");
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual(await readdir(f.output), ["unreadable.mp4"]);
  const after = await stat(destination, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mode, before.mode);
  await chmod(destination, 0o600);
  assert.equal(await readFile(destination, "utf8"), "unreadable foreign bytes");
  assert.deepEqual(f.projects.deletionsPage().projectIds, []);
});

test("lost retirement acknowledgement resumes real project deletion after the staging directory is gone", async (t) => {
  let lost = true;
  const f = await fixture(t, {
      wrap:
        (run) =>
        async (op, ...args) => {
          const result = await run(op, ...args);
          if (op === "publication.retire" && lost) {
            lost = false;
            return {
              ok: false,
              error: {
                code: "MEDIA_WORKER_FAILED",
                message: "lost retirement response",
                retryable: true,
                details: {},
              },
            };
          }
          return result;
        },
    }),
    exportId = randomUUID();
  await writeFile(join(f.output, "retained.mp4"), "foreign");
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "retained.mp4",
  });
  await f.jobs.idle();
  assert.equal(f.exports.status(exportId).cleanupPending, true);
  await assert.rejects(
    f.deletion.delete({ kind: "project", id: f.projectId }),
    (e) => e.code === "DELETE_FAILED" && /lost retirement response/.test(e.message),
  );
  assert.deepEqual(f.projects.deletionsPage().projectIds, [f.projectId]);
  assert.deepEqual(await readdir(f.output), ["retained.mp4"]);
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual(f.projects.deletionsPage().projectIds, []);
  assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 0);
});

test("canceled intents keep exact-retry pins within a bounded uncommitted allowance", async (t) => {
  const f = await fixture(t);
  const hold = f.jobs.createContext(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve("closed"), { once: true }),
      ),
  );
  f.jobs.submitContext(hold, { artifact: "held", input: "pin-limit", lane: "heavy" });
  const ids = [];
  for (let n = 0; n < 32; n++) {
    const exportId = randomUUID();
    ids.push(exportId);
    await f.exports.create({
      exportId,
      projectId: f.projectId,
      kind: "video",
      directory: f.output,
      leaf: `bounded-${n}.mp4`,
    });
    f.exports.cancel(exportId);
  }
  const overflow = {
    exportId: randomUUID(),
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "overflow.mp4",
  };
  await assert.rejects(f.exports.create(overflow), { code: "CAPACITY_EXCEEDED" });
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT COUNT(*) AS count FROM export_intents WHERE receipt IS NULL")
      .get().count,
    32,
  );
  assert.deepEqual(await readdir(f.output), []);
  await f.exports.abandon(ids[1]);
  await f.exports.create(overflow);
  f.exports.cancel(overflow.exportId);
  await assert.rejects(f.exports.create({ ...overflow, exportId: randomUUID() }), {
    code: "CAPACITY_EXCEEDED",
  });
  await f.jobs.closeContext(hold);
  await f.exports.retry(ids[0]);
  await f.jobs.idle();
  assert.equal(f.exports.status(ids[0]).state, "committed");
  await f.exports.retry(overflow.exportId);
  await f.jobs.idle();
  assert.equal(f.exports.status(overflow.exportId).state, "committed");
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual((await readdir(f.output)).sort(), ["bounded-0.mp4", "overflow.mp4"]);
});

test("managed source directories cannot be selected as allegedly external exports", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID();
  await assert.rejects(
    f.exports.create({
      exportId,
      projectId: f.projectId,
      kind: "video",
      directory: join(f.home, "assets"),
      leaf: "wrong.mp4",
    }),
    (e) => e.code === "INVALID_STORAGE",
  );
  assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 0);
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.deepEqual(f.projects.deletionsPage().projectIds, []);
  assert.deepEqual(await readdir(f.output), []);
});

test(
  "shutdown fences and drains export destination admission before catalog closure",
  { timeout: 10000 },
  async (t) => {
    let release, entered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const atDestination = new Promise((resolve) => {
      entered = resolve;
    });
    const f = await fixture(t, {
      wrap: (native) => async (operation, params, options) => {
        if (operation === "storage.externalDirectory") {
          entered();
          await held;
        }
        return native(operation, params, options);
      },
    });
    const exportId = randomUUID();
    const pending = f.exports.create({
      exportId,
      kind: "video",
      projectId: f.projectId,
      directory: f.output,
      leaf: "shutdown.mp4",
    });
    const outcome = pending.then(
      () => "created",
      () => "closed",
    );
    await atDestination;
    let closed = false;
    const closing = f.exports.close().then(() => {
      closed = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        closed,
        false,
        "close must retain the catalog until destination admission drains",
      );
    } finally {
      release();
      await closing;
      await outcome;
    }
    assert.equal(await outcome, "closed");
    assert.equal(
      f.catalog.catalog
        .prepare("SELECT count(*) AS n FROM export_intents WHERE exportId=?")
        .get(exportId).n,
      0,
    );
    assert.deepEqual(await readdir(f.output), []);
  },
);

test(
  "abandonment drains in-flight destination admissions before confirming absence",
  { timeout: 10000 },
  async (t) => {
    let release,
      entered,
      count = 0;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const atDestination = new Promise((resolve) => {
      entered = resolve;
    });
    const f = await fixture(t, {
      admission: false,
      wrap: (native) => async (operation, params, options) => {
        if (operation === "storage.externalDirectory" && ++count <= 2) {
          if (count === 2) entered();
          await held;
        }
        return native(operation, params, options);
      },
    });
    const request = {
      exportId: randomUUID(),
      kind: "video",
      projectId: f.projectId,
      directory: f.output,
      leaf: "abandoned-before-admission.mp4",
    };
    const pending = [f.exports.create(request), f.exports.create(request)];
    const outcomes = Promise.allSettled(pending);
    await atDestination;
    assert.throws(() => f.exports.status(request.exportId), { code: "NOT_FOUND" });
    const removing = f.exports.abandon(request.exportId);
    let removed = false;
    void removing.then(() => {
      removed = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        removed,
        false,
        "absence is not final while matching create calls remain active",
      );
      assert.equal(f.exports.abandon(request.exportId), removing);
      await assert.rejects(f.exports.create(request), { code: "EXPORT_ABANDONING" });
      const other = await f.exports.create({
        ...request,
        exportId: randomUUID(),
        leaf: "other.mp4",
      });
      assert.equal(other.state, "queued", "an unrelated admission must remain independent");
      await f.exports.abandon(other.id);
    } finally {
      release();
      await removing;
      await outcomes;
    }
    for (const result of await outcomes) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "EXPORT_ABANDONING");
    }
    assert.throws(() => f.exports.status(request.exportId), { code: "NOT_FOUND" });
    assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 0);
    assert.deepEqual(await readdir(f.output), []);
  },
);

test("late package commit releases resource pins while failed abandonment keeps admission capacity", async (t) => {
  const entered = gate(),
    release = gate();
  t.after(() => release.resolve());
  let failRetirement = true;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation === "publication.retire" && failRetirement) {
          failRetirement = false;
          throw new Error("generated retirement interruption");
        }
        const result = await run(operation, ...args);
        if (operation === "publication.commit") {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
  });
  const request = { ...f.request(), kind: "processed-package", leaf: "late-retire.zip" };
  const references = new ResourceReferences(f.catalog);
  const pins = () =>
    references
      .dependencies({ kind: "export", id: request.exportId })
      .map(({ kind, id }) => [kind, id]);
  const admitted = () =>
    f.catalog.catalog
      .prepare(
        "SELECT COUNT(*) AS n FROM export_intents WHERE receipt IS NULL OR abandoning=1 OR assembly IS NOT NULL",
      )
      .get().n;
  await f.exports.create(request);
  await entered.promise;
  assert.deepEqual(pins(), [["asset", f.asset.id]]);
  const failed = assert.rejects(
    f.exports.abandon(request.exportId),
    /generated retirement interruption/,
  );
  release.resolve();
  await failed;
  const status = f.exports.status(request.exportId);
  assert.equal(status.state, "committed");
  assert.equal(status.abandoning, true);
  assert.deepEqual(pins(), []);
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT assembly FROM export_intents WHERE exportId=?")
      .get(request.exportId).assembly,
    null,
  );
  assert.equal(admitted(), 1);
  const output = await readFile(join(f.output, request.leaf));
  assert.equal(sha(output), status.receipt.sha256);
  await f.exports.abandon(request.exportId);
  assert.equal(admitted(), 0);
  assert.deepEqual(await readdir(f.output), [request.leaf]);
  assert.deepEqual(await readFile(join(f.output, request.leaf)), output);
  assert.equal(f.projects.get(f.projectId).id, f.projectId);
  assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
});

test("unsafe package staging keeps abandonment fence resource pins and capacity until verified retirement", async (t) => {
  const f = await fixture(t);
  const request = { ...f.request(), kind: "processed-package", leaf: "occupied.zip" };
  const references = new ResourceReferences(f.catalog);
  const pins = () =>
    references
      .dependencies({ kind: "export", id: request.exportId })
      .map(({ kind, id }) => [kind, id]);
  const admitted = () =>
    f.catalog.catalog
      .prepare(
        "SELECT COUNT(*) AS n FROM export_intents WHERE receipt IS NULL OR abandoning=1 OR assembly IS NOT NULL",
      )
      .get().n;
  await writeFile(join(f.output, request.leaf), "foreign output");
  await f.exports.create(request);
  await f.jobs.idle();
  assert.equal(f.exports.status(request.exportId).state, "failed");
  const stage = join(f.output, ".yap-export-" + request.exportId),
    saved = stage + "-saved",
    substitute = stage + "-substitute";
  await rename(stage, saved);
  await mkdir(stage, { mode: 0o700 });
  await writeFile(join(stage, "foreign"), "preserve substitute");
  await assert.rejects(f.exports.abandon(request.exportId), { code: "PUBLICATION_CHANGED" });
  assert.deepEqual(
    f.exports
      .list({ unfinishedOnly: true })
      .exports.map((row) => [row.id, row.abandoning, row.cleanupPending]),
    [[request.exportId, true, true]],
  );
  const unfinished = f.exports.status(request.exportId);
  assert.equal(unfinished.abandoning, true);
  assert.equal(unfinished.cleanupPending, true);
  assert.equal(unfinished.output, null);
  assert.deepEqual(unfinished.destination, {
    directory: await realpath(f.output),
    leaf: request.leaf,
  });
  assert.deepEqual(pins(), [["asset", f.asset.id]]);
  assert.equal(admitted(), 1);
  assert.equal(await readFile(join(stage, "foreign"), "utf8"), "preserve substitute");
  await assert.rejects(f.exports.retry(request.exportId), { code: "EXPORT_ABANDONING" });
  await rename(stage, substitute);
  await rename(saved, stage);
  await f.exports.abandon(request.exportId);
  assert.deepEqual(pins(), []);
  assert.equal(admitted(), 0);
  assert.equal(await readFile(join(substitute, "foreign"), "utf8"), "preserve substitute");
  assert.equal(await readFile(join(f.output, request.leaf), "utf8"), "foreign output");
  assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
  assert.equal(f.projects.get(f.projectId).id, f.projectId);
});

test("package abandonment forgets failed identity and permits clean export-id reuse without stale publication", async (t) => {
  const f = await fixture(t);
  const request = { ...f.request(), kind: "processed-package", leaf: "foreign.zip" };
  const references = new ResourceReferences(f.catalog);
  const pins = () =>
    references
      .dependencies({ kind: "export", id: request.exportId })
      .map(({ kind, id }) => [kind, id]);
  await writeFile(join(f.output, request.leaf), "foreign output");
  await f.exports.create(request);
  await f.jobs.idle();
  const failed = f.exports.status(request.exportId);
  assert.equal(failed.state, "failed");
  const job = f.jobs.job(failed.jobId),
    identity = { target: job.target, artifact: job.artifact, input: job.input };
  assert.deepEqual(pins(), [["asset", f.asset.id]]);
  await f.exports.abandon(request.exportId);
  await f.exports.abandon(request.exportId);
  assert.throws(() => f.exports.status(request.exportId), { code: "NOT_FOUND" });
  assert.throws(() => f.jobs.job(failed.jobId), { code: "NOT_FOUND" });
  assert.equal(f.jobs.status(identity).published, null);
  assert.deepEqual(pins(), []);
  assert.equal(f.projects.get(f.projectId).id, f.projectId);
  assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
  assert.equal(await readFile(join(f.output, request.leaf), "utf8"), "foreign output");
  assert.deepEqual(await readdir(f.output), [request.leaf]);
  const reused = await f.exports.create({ ...request, leaf: "reused.zip" });
  assert.notEqual(reused.jobId, failed.jobId);
  await f.jobs.idle();
  const committed = f.exports.status(request.exportId);
  assert.equal(committed.state, "committed", JSON.stringify(committed));
  const output = await readFile(committed.output);
  assert.equal(sha(output), committed.receipt.sha256);
  await f.exports.abandon(request.exportId);
  assert.equal(f.jobs.status(identity).published, null);
  assert.throws(() => f.jobs.job(reused.jobId), { code: "NOT_FOUND" });
  assert.deepEqual(pins(), []);
  assert.deepEqual((await readdir(f.output)).sort(), [request.leaf, "reused.zip"].sort());
  assert.deepEqual(await readFile(join(f.output, "reused.zip")), output);
  assert.equal(await readFile(join(f.output, request.leaf), "utf8"), "foreign output");
  assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
});

test("exports admitted while another export publishes into the same directory both commit", async (t) => {
  const held = gate(),
    release = gate();
  t.after(() => release.resolve());
  let holding = true;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        const result = await run(operation, ...args);
        // The first publisher keeps its destination lock while this prepare is held.
        if (operation === "publication.prepare" && holding) {
          holding = false;
          held.resolve();
          await release.promise;
        }
        return result;
      },
  });
  const first = f.request(),
    second = f.request();
  await f.exports.create(first);
  await held.promise;
  let failure;
  const admitting = f.exports.create(second).catch((error) => {
    failure = error;
  });
  // Long enough for an unserialized admission to reach the held destination and be refused.
  await new Promise((resolve) => setTimeout(resolve, 250));
  release.resolve();
  await admitting;
  assert.equal(failure, undefined, failure && `${failure.code}: ${failure.message}`);
  await f.jobs.idle();
  for (const request of [first, second]) {
    const status = f.exports.status(request.exportId);
    assert.equal(status.state, "committed", JSON.stringify(status));
    assert.equal(sha(await readFile(join(f.output, request.leaf))), status.receipt.sha256);
  }
  assert.deepEqual((await readdir(f.output)).sort(), [first.leaf, second.leaf].sort());
});
