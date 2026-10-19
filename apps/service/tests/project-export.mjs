import { operationSchema } from "@yap/protocol";
import { outputPresets } from "@yap/composition";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CatalogError } from "@yap/core/catalog";
import { mediaWorker } from "../dist/worker.js";
import { fixture, gate, until, nativeBinary } from "./fixtures/project-export.mjs";
test("project export pins an omitted revision, replays it after edits and atomically publishes exact cached bytes", async (t) => {
  const started = gate(),
    release = gate();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    render: async (req, signal, ordinary) => {
      started.resolve();
      await release.promise;
      return ordinary(req, signal);
    },
  });
  const request = f.request(),
    first = await f.exports.create(request);
  await started.promise;
  f.projects.apply(f.projectId, {
    requestId: "resize",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  assert.equal((await f.exports.create(request)).snapshot.revisionId, first.snapshot.revisionId);
  await assert.rejects(
    f.exports.create({ ...request, leaf: "other.mp4" }),
    (error) => error.code === "REQUEST_CONFLICT",
  );
  assert.deepEqual(await readdir(f.output), []);
  release.resolve();
  const ready = await until(() => {
    const s = f.exports.status(request.exportId);
    if (s.state === "failed") throw new Error(JSON.stringify(s));
    return s.state === "committed" && !s.cleanupPending && s;
  });
  const bytes = await readFile(ready.output);
  const cached = (
    await f.preview.request({ projectId: f.projectId, revisionId: f.placed.revision.revisionId })
  ).published.preview;
  assert.deepEqual(bytes, await readFile(cached.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ready.receipt.sha256);
  const data = JSON.parse(bytes.toString());
  assert.equal(data.manifest.revisionId, f.placed.revision.revisionId);
  assert.equal(data.manifest.canvas.width, 160);
  assert.deepEqual(await readdir(f.output), [request.leaf]);
  assert.equal(f.exports.list({ projectId: f.projectId }).exports[0].projectId, f.projectId);
  await f.exports.retry(request.exportId);
  assert.equal(f.exports.status(request.exportId).receipt.sha256, ready.receipt.sha256);
});
for (const evict of [false, true])
  test(`canceled export ${evict ? "refuses missing old implementation after eviction" : "publishes retained ready bytes despite implementation replacement"}`, async (t) => {
    const started = gate(),
      release = gate();
    let held = false,
      renders = 0;
    t.after(() => release.resolve());
    const f = await fixture(t, {
      render: async (req, signal, ordinary) => {
        renders++;
        return ordinary(req, signal);
      },
      wrap: (worker) => async (op, params, options) => {
        if (op === "publication.allocate" && !held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return worker(op, params, options);
      },
    });
    const request = f.request();
    await f.exports.create(request);
    await started.promise;
    const preview = (await f.preview.request({ projectId: f.projectId })).published.preview;
    f.exports.cancel(request.exportId);
    release.resolve();
    await f.jobs.idle();
    assert.equal(f.exports.status(request.exportId).state, "canceled");
    assert.equal(await readFile(preview.file, "utf8").then(() => true), true);
    if (evict) f.cache.remove(preview.cacheId);
    f.replaceRenderer("project-owner-fixture-v2");
    await f.exports.retry(request.exportId);
    const state = await until(() => {
      const s = f.exports.status(request.exportId);
      return ["failed", "committed"].includes(s.state) && s;
    });
    await f.jobs.idle();
    if (evict) {
      assert.equal(state.state, "failed");
      assert.equal(f.jobs.job(state.jobId).errorCode, "NOT_READY");
      await assert.rejects(readFile(join(f.output, request.leaf)));
      f.replaceRenderer("project-owner-fixture-v1");
      await f.exports.retry(request.exportId);
      await until(() => {
        const value = f.exports.status(request.exportId);
        return value.state === "committed" && !value.cleanupPending;
      });
      assert.equal(
        JSON.parse(await readFile(join(f.output, request.leaf), "utf8")).manifest.requirements[0]
          .implementationId,
        "project-owner-fixture-v1",
      );
    } else {
      assert.equal(state.state, "committed");
      assert.equal(
        JSON.parse(await readFile(state.output, "utf8")).manifest.requirements[0].implementationId,
        "project-owner-fixture-v1",
      );
    }
    assert.equal(renders, evict ? 2 : 1);
    await f.exports.abandon(request.exportId);
    assert.throws(
      () => f.exports.status(request.exportId),
      (error) => error.code === "NOT_FOUND",
    );
    assert.deepEqual(await readdir(f.output), [request.leaf]);
  });

test("an evicted admitted preview regenerates through the same dependency job before publishing", async (t) => {
  const started = gate(),
    release = gate();
  let held = false,
    renders = 0;
  t.after(() => release.resolve());
  const f = await fixture(t, {
    render: async (req, signal, ordinary) => {
      renders++;
      return ordinary(req, signal);
    },
    wrap: (worker) => async (op, params, options) => {
      if (op === "publication.allocate" && !held) {
        held = true;
        started.resolve();
        await release.promise;
      }
      return worker(op, params, options);
    },
  });
  const request = f.request();
  await f.exports.create(request);
  await started.promise;
  const firstAttempt = f.jobs.job(f.exports.status(request.exportId).jobId);
  const old = (await f.preview.request({ projectId: f.projectId })).published;
  f.projects.apply(f.projectId, {
    requestId: "advance-before-regeneration",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  f.cache.remove(old.preview.cacheId);
  release.resolve();
  const ready = await until(() => {
    const s = f.exports.status(request.exportId);
    if (s.state === "failed") throw new Error(JSON.stringify(s));
    return s.state === "committed" && !s.cleanupPending && s;
  });
  const lastAttempt = f.jobs.job(ready.jobId);
  assert.notEqual(lastAttempt.attemptId, firstAttempt.attemptId);
  assert.equal(lastAttempt.generation, firstAttempt.generation + 1);
  assert.equal(renders, 2);
  assert.equal(
    JSON.parse(await readFile(ready.output, "utf8")).manifest.revisionId,
    f.placed.revision.revisionId,
  );
  assert.ok(
    (
      await f.preview.request({
        projectId: f.projectId,
        revisionId: f.placed.revision.revisionId,
      })
    ).published.generation > old.generation,
  );
});

test("publication holds its cached read lease until the native copy finishes", async (t) => {
  const started = gate(),
    release = gate();
  let held = false;
  t.after(() => release.resolve());
  const f = await fixture(t, {
    wrap: (worker) => async (op, params, options) => {
      if (op === "publication.prepare" && !held) {
        held = true;
        started.resolve();
        await release.promise;
      }
      return worker(op, params, options);
    },
  });
  const request = f.request();
  await f.exports.create(request);
  await started.promise;
  const cacheId = (await f.preview.request({ projectId: f.projectId })).published.preview.cacheId;
  assert.throws(
    () => f.cache.remove(cacheId),
    (error) => error.code === "CACHE_BUSY",
  );
  release.resolve();
  await until(() => {
    const s = f.exports.status(request.exportId);
    return s.state === "committed" && !s.cleanupPending;
  });
  await f.jobs.idle();
  f.cache.remove(cacheId);
  assert.equal(
    JSON.parse(await readFile(join(f.output, request.leaf), "utf8")).manifest.revisionId,
    f.placed.revision.revisionId,
  );
});

test("restart recovery observes an unacknowledged project commit without republishing", async (t) => {
  let committed = false;
  const f = await fixture(t, {
    wrap: (worker) => async (op, params, options) => {
      if (op === "publication.reconcile" && committed) throw new Error("lost observation");
      const result = await worker(op, params, options);
      if (op === "publication.commit") committed = true;
      return result;
    },
  });
  const request = f.request();
  await f.exports.create(request);
  await until(() => f.exports.status(request.exportId).state === "failed");
  await f.jobs.idle();
  const before = await stat(join(f.output, request.leaf));
  await f.close();
  const reopened = await fixture(t, { existing: f });
  assert.deepEqual(reopened.exports.resumeRecovery(), []);
  const recovered = await until(() => {
    const s = reopened.exports.status(request.exportId);
    return s.state === "committed" && !s.cleanupPending && s;
  });
  assert.equal((await stat(recovered.output)).ino, before.ino);
  assert.equal(
    (await reopened.exports.create(request)).snapshot.revisionId,
    f.placed.revision.revisionId,
  );
  assert.deepEqual(await readdir(f.output), [request.leaf]);
});

test("project retirement drains a late publication, removes only private state and preserves source bytes", async (t) => {
  const started = gate(),
    release = gate();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    wrap: (worker) => async (op, params, options) => {
      if (op === "publication.commit") {
        started.resolve();
        await release.promise;
        return worker(op, params, { ...options, signal: undefined });
      }
      return worker(op, params, options);
    },
  });
  const request = f.request();
  await f.exports.create(request);
  await started.promise;
  f.projects.markDeleting(f.projectId);
  const owner = { kind: "project", projectId: f.projectId };
  const retiring = Promise.all([f.jobs.drainOwner(owner), f.exports.retireOwner(owner)]);
  assert.ok(f.assets.references(f.asset.id).length > 0);
  await assert.rejects(
    f.exports.create({ ...f.request(), leaf: "forbidden.mp4" }),
    (error) => error.code === "NOT_FOUND",
  );
  release.resolve();
  await retiring;
  assert.throws(
    () => f.exports.status(request.exportId),
    (error) => error.code === "NOT_FOUND",
  );
  await f.jobs.forgetOwner(owner);
  while (!f.projects.finishDeletionPage(f.projectId)) {}
  assert.deepEqual(f.assets.references(f.asset.id), []);
  assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
  assert.deepEqual(await readdir(f.output), [request.leaf]);
  assert.equal(
    JSON.parse(await readFile(join(f.output, request.leaf), "utf8")).manifest.revisionId,
    f.placed.revision.revisionId,
  );
});

test("explicit export retry recovers a queued preview after its pinned renderer returns", async (t) => {
  const started = gate(),
    release = gate();
  t.after(() => release.resolve());
  const f = await fixture(t);
  const context = f.jobs.createContext(async () => {
    started.resolve();
    await release.promise;
    return "released";
  });
  f.jobs.submitContext(context, {
    artifact: "hold",
    input: "renderer-switch",
    lane: "heavy",
  });
  await started.promise;
  const request = f.request();
  await f.exports.create(request);
  await until(async () => (await f.preview.request({ projectId: f.projectId })).state === "queued");
  f.replaceRenderer("project-owner-fixture-v2");
  release.resolve();
  await until(() => f.exports.status(request.exportId).state === "failed");
  await f.jobs.idle();
  f.replaceRenderer("project-owner-fixture-v1");
  assert.equal((await f.preview.request({ projectId: f.projectId })).state, "failed");
  await f.exports.retry(request.exportId);
  const result = await until(() => {
    const value = f.exports.status(request.exportId);
    if (value.state === "failed") throw new Error(JSON.stringify(value));
    return value.state === "committed" && !value.cleanupPending && value;
  });
  assert.equal(
    JSON.parse(await readFile(result.output, "utf8")).manifest.requirements[0].implementationId,
    "project-owner-fixture-v1",
  );
});

test("polling and export retry leave unrelated failed preview dependencies alone", async (t) => {
  let fail = true,
    renders = 0;
  const f = await fixture(t, {
    render: async (request, signal, ordinary) => {
      renders++;
      if (fail) throw new CatalogError("DECODE_FAILED", "fixture dependency");
      return ordinary(request, signal);
    },
  });
  const request = f.request();
  await f.exports.create(request);
  await until(() => f.exports.status(request.exportId).state === "failed");
  fail = false;
  const failedPreview = await f.preview.request({ projectId: f.projectId });
  const failedAttempt = f.jobs.job(failedPreview.jobId).attemptId;
  for (let n = 0; n < 10; n++) {
    await f.exports.create(request);
    f.exports.status(request.exportId);
  }
  await f.jobs.idle();
  assert.equal(f.jobs.job(failedPreview.jobId).attemptId, failedAttempt);
  assert.equal(renders, 1);
  f.exports.status(request.exportId);
  await f.preview.request({ projectId: f.projectId });
  await f.exports.retry(request.exportId);
  await until(() => f.exports.status(request.exportId).state === "failed");
  assert.equal(renders, 1);
  await f.preview.retry({ projectId: f.projectId });
  await f.jobs.idle();
  await f.exports.retry(request.exportId);
  await until(() => {
    const value = f.exports.status(request.exportId);
    return value.state === "committed" && !value.cleanupPending;
  });
  assert.equal(renders, 2);
});

test("stale export implementation absence does not retry a newer decode failure", async (t) => {
  let fail = false,
    renders = 0;
  const f = await fixture(t, {
    admission: false,
    render: async (request, signal, ordinary) => {
      renders++;
      if (fail) throw new CatalogError("DECODE_FAILED", "newer failure");
      return ordinary(request, signal);
    },
  });
  const started = gate(),
    release = gate();
  t.after(() => release.resolve());
  const context = f.jobs.createContext(async () => {
    started.resolve();
    await release.promise;
    return "released";
  });
  f.jobs.submitContext(context, { artifact: "hold", input: "renderer-switch", lane: "heavy" });
  await started.promise;
  const request = f.request();
  await f.exports.create(request);
  f.replaceRenderer("project-owner-fixture-v2");
  f.jobs.startAdmission((job) => f.exports.admit(job));
  await until(() => f.exports.status(request.exportId).state === "failed");
  assert.equal(f.jobs.job(f.exports.status(request.exportId).jobId).errorCode, "NOT_READY");
  release.resolve();
  await f.jobs.idle();
  f.replaceRenderer("project-owner-fixture-v1");
  fail = true;
  await f.preview.retry({ projectId: f.projectId });
  await until(async () => (await f.preview.request({ projectId: f.projectId })).state === "failed");
  fail = false;
  await f.exports.retry(request.exportId);
  await until(() => ["failed", "committed"].includes(f.exports.status(request.exportId).state));
  await f.jobs.idle();
  assert.equal(f.exports.status(request.exportId).state, "failed");
  assert.equal(renders, 1);
});

test("staged project bytes retry after renderer replacement without rendering again", async (t) => {
  let rejectCommit = true,
    renders = 0;
  const f = await fixture(t, {
    render: async (request, signal, ordinary) => {
      renders++;
      return ordinary(request, signal);
    },
    wrap: (worker) => async (operation, params, options) => {
      if (operation === "publication.commit" && rejectCommit)
        throw new CatalogError("STORAGE_BUSY", "Staged before commit");
      return worker(operation, params, options);
    },
  });
  const request = f.request();
  await f.exports.create(request);
  await until(() => f.exports.status(request.exportId).state === "failed");
  await f.jobs.idle();
  const preview = (await f.preview.request({ projectId: f.projectId })).published.preview;
  f.cache.remove(preview.cacheId);
  f.replaceRenderer("project-owner-fixture-v2");
  rejectCommit = false;
  await f.exports.retry(request.exportId);
  const result = await until(() => {
    const status = f.exports.status(request.exportId);
    if (status.state === "failed") throw Error(JSON.stringify(status));
    return status.state === "committed" && !status.cleanupPending && status;
  });
  assert.equal(renders, 1);
  assert.equal(
    JSON.parse(await readFile(result.output, "utf8")).manifest.requirements[0].implementationId,
    "project-owner-fixture-v1",
  );
});

test("retained authored export replay does not expand a changed preset", async (t) => {
  const f = await fixture(t, { admission: false });
  const request = {
    ...f.request(),
    settings: { preset: "balanced", video: { keyframeInterval: 42 } },
  };
  const first = await f.exports.create(request);
  const before = outputPresets.balanced.video.rateControl;
  try {
    outputPresets.balanced.video.rateControl = { mode: "average", bitrate: 1234567 };
    const replay = await f.exports.create(request);
    assert.deepEqual(replay.snapshot.settings, first.snapshot.settings);
    await assert.rejects(
      f.exports.create({ ...request, settings: { preset: "sharp" } }),
      (error) => error.code === "REQUEST_CONFLICT",
    );
  } finally {
    outputPresets.balanced.video.rateControl = before;
  }
});

test("settings-free export replay retains its original request identity", async (t) => {
  const f = await fixture(t, { admission: false });
  const request = f.request();
  const first = await f.exports.create(request);
  const stored = f.catalog.catalog
    .prepare("SELECT request FROM export_intents WHERE exportId=?")
    .get(request.exportId);
  assert.equal(
    stored.request,
    JSON.stringify([
      request.kind,
      "project",
      request.projectId,
      null,
      request.directory,
      request.leaf,
      false,
    ]),
  );
  const replay = await f.exports.create({ ...request, settings: {} });
  assert.deepEqual(replay.snapshot, first.snapshot);
});

test("abandonment during preview retry cannot resurrect an export job", async (t) => {
  const started = gate(),
    release = gate();
  t.after(() => release.resolve());
  const f = await fixture(t);
  const context = f.jobs.createContext(async () => {
    started.resolve();
    await release.promise;
    return "released";
  });
  f.jobs.submitContext(context, { artifact: "hold", input: "renderer-switch", lane: "heavy" });
  await started.promise;
  const request = f.request();
  await f.exports.create(request);
  f.replaceRenderer("project-owner-fixture-v2");
  release.resolve();
  await until(() => f.exports.status(request.exportId).state === "failed");
  await f.jobs.idle();
  f.replaceRenderer("project-owner-fixture-v1");
  const retry = f.exports.retry(request.exportId);
  await Promise.resolve();
  const abandoning = f.exports.abandon(request.exportId);
  await assert.rejects(retry, (error) => ["EXPORT_ABANDONING", "NOT_FOUND"].includes(error.code));
  await abandoning;
  await f.jobs.idle();
  assert.deepEqual(
    f.catalog.catalog
      .prepare("SELECT artifact,input FROM jobs WHERE input=?")
      .all(request.exportId),
    [],
  );
});

test("export discovery pages pinned summaries without admitting work and binds cursor filters", async (t) => {
  const f = await fixture(t, { admission: false });
  const ids = [1, 2, 3].map((value) => `${value}0000000-0000-4000-8000-000000000000`);
  for (const exportId of ids)
    await f.exports.create({
      kind: "video",
      exportId,
      projectId: f.projectId,
      directory: f.output,
      leaf: exportId + ".mp4",
    });
  const page = f.exports.list({ limit: 2, unfinishedOnly: true });
  assert.equal(typeof page.nextCursor, "string");
  assert.deepEqual(
    page.exports.map((row) => row.exportId),
    ids.slice(1).reverse(),
  );
  // A summary carries the owner's work mark, which never reaches a caller's JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(page.exports[0])), {
    exportId: ids[2],
    projectId: f.projectId,
    kind: "video",
    revisionId: f.placed.revision.revisionId,
    jobId: page.exports[0].jobId,
    state: "queued",
    abandoning: false,
    cleanupPending: false,
  });
  assert.throws(
    () => f.exports.list({ cursor: page.nextCursor }),
    (error) => error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => f.exports.list({ unfinishedOnly: true, projectId: f.projectId, cursor: page.nextCursor }),
    (error) => error.code === "INVALID_PARAMS",
  );
  assert.deepEqual(
    f.exports
      .list({ unfinishedOnly: true, cursor: page.nextCursor })
      .exports.map((row) => row.exportId),
    [ids[0]],
  );
  const continuation = { unfinishedOnly: true, cursor: page.nextCursor, limit: 100 };
  assert.deepEqual(
    operationSchema.parse({ operation: "export.list", params: continuation }).params,
    continuation,
  );
  assert.equal(
    operationSchema.parse({ operation: "export.list", params: { limit: 1000 } }).params.limit,
    1000,
  );
  const arrival = "00000000-0000-4000-8000-000000000000";
  await f.exports.create({
    kind: "video",
    exportId: arrival,
    projectId: f.projectId,
    directory: f.output,
    leaf: "new.mp4",
  });
  assert.deepEqual(
    f.exports
      .list({ unfinishedOnly: true, cursor: page.nextCursor })
      .exports.map((row) => row.exportId),
    [ids[0]],
  );
  assert.equal(f.exports.list({ unfinishedOnly: true }).exports[0].exportId, arrival);
  assert.deepEqual(f.exports.list({ projectId: randomUUID() }).exports, []);
  await f.exports.abandon(arrival);
  await f.exports.abandon(ids[1]);
  assert.deepEqual(
    f.exports.list({}).exports.map((row) => row.exportId),
    [ids[2], ids[0]],
  );
  assert.deepEqual(await readdir(f.output), []);
  assert.equal(f.exports.status(ids[0]).state, "queued");
});

test("an acknowledged export leaves only its file and never needs the destination again", async (t) => {
  let nativeCalls = 0;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (...args) => {
        nativeCalls++;
        return run(...args);
      },
  });
  const exportId = randomUUID();
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "moved.mp4",
  });
  await f.jobs.idle();
  assert.deepEqual(await readdir(f.output), ["moved.mp4"]);
  const moved = f.output + "-moved";
  t.after(() => rm(moved, { recursive: true, force: true }));
  await rename(f.output, moved);
  const before = nativeCalls;
  assert.equal((await f.exports.retry(exportId)).state, "committed");
  assert.equal(
    f.exports.status(exportId).state,
    "committed",
    JSON.stringify(f.exports.status(exportId)),
  );
  await f.exports.abandon(exportId);
  assert.equal(nativeCalls, before);
  assert.throws(() => f.exports.status(exportId), { code: "NOT_FOUND" });
  assert.deepEqual(await readdir(moved), ["moved.mp4"]);
});

test("a lost staging retirement after commit is confirmed absent by explicit recovery", async (t) => {
  let lose = true;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (op, ...args) => {
        const result = await run(op, ...args);
        if (op === "publication.retire" && lose) {
          lose = false;
          throw new Error("lost retirement response");
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
    leaf: "retired.mp4",
  });
  await f.jobs.idle();
  assert.deepEqual(await readdir(f.output), ["retired.mp4"]);
  const pending = f.exports.status(exportId);
  assert.deepEqual([pending.state, pending.cleanupPending], ["committed", true]);
  const recovered = await f.exports.retry(exportId);
  await f.jobs.idle();
  assert.ok(recovered.recovery.jobId);
  assert.equal(f.exports.status(exportId).cleanupPending, false);
  assert.deepEqual(f.exports.list({ unfinishedOnly: true }).exports, []);
});

test("concurrent request replay shares one intent and conflicting reuse is rejected", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID();
  const request = {
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "once.mp4",
  };
  const results = await Promise.all([f.exports.create(request), f.exports.create(request)]);
  assert.equal(results[0].jobId, results[1].jobId);
  await f.jobs.idle();
  await assert.rejects(
    f.exports.create({ ...request, leaf: "different.mp4" }),
    (e) => e.code === "REQUEST_CONFLICT",
  );
  assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 1);
  assert.equal(
    f.exports.status(exportId).state,
    "committed",
    JSON.stringify(f.exports.status(exportId)),
  );
});

test("publication uses its known-byte budget instead of the worker's unrelated short default", async (t) => {
  let delayed;
  const f = await fixture(t, {
    wrap:
      (run) =>
      (operation, ...args) =>
        operation === "publication.prepare" ? delayed(operation, ...args) : run(operation, ...args),
  });
  const executable = join(f.home, "delayed-publication");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(executable, `#!/bin/sh\nsleep 0.05\nexec ${quote(nativeBinary)}\n`, {
    mode: 0o700,
  });
  delayed = mediaWorker({ YAP_NATIVE: executable }, 1);
  const exportId = randomUUID();
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "budget.mp4",
  });
  await f.jobs.idle();
  assert.equal(
    f.exports.status(exportId).state,
    "committed",
    JSON.stringify(f.exports.status(exportId)),
  );
  assert.deepEqual(
    await readFile(join(f.output, "budget.mp4")),
    await readFile((await f.preview.request({ projectId: f.projectId })).published.preview.file),
  );
});

test("export kind is persisted and incompatible replay cannot change video intent", async (t) => {
  const f = await fixture(t);
  const request = {
    exportId: randomUUID(),
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "pinned.mp4",
  };
  const first = await f.exports.create(request);
  assert.equal(first.kind, "video");
  assert.equal((await f.exports.create(request)).jobId, first.jobId);
  await assert.rejects(f.exports.create({ ...request, kind: "processed-package" }), {
    code: "REQUEST_CONFLICT",
  });
  const row = f.catalog.catalog
    .prepare("SELECT kind,request FROM export_intents WHERE exportId=?")
    .get(request.exportId);
  assert.equal(row.kind, "video");
  assert.equal(JSON.parse(row.request)[0], "video");
  assert.equal(f.exports.status(request.exportId).jobId, first.jobId);
});

test("waiting export pins its revision before a busy heavy lane admits preview work", async (t) => {
  const f = await fixture(t);
  const hold = f.jobs.createContext(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve("closed"), { once: true }),
      ),
  );
  f.jobs.submitContext(hold, { artifact: "hold", input: "preview-delay", lane: "heavy" });
  await new Promise(setImmediate);
  const request = f.request();
  const requested = await f.exports.create(request);
  assert.equal(requested.state, "queued");
  assert.equal(f.jobs.job(requested.jobId).state, "waiting");
  f.projects.apply(f.projectId, {
    requestId: "edit-while-waiting",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  await f.jobs.closeContext(hold);
  await f.jobs.idle();
  const result = f.exports.status(request.exportId);
  assert.equal(result.state, "committed");
  assert.equal(result.snapshot.revisionId, f.placed.revision.revisionId);
  const movie = JSON.parse(await readFile(result.output, "utf8"));
  assert.equal(movie.manifest.revisionId, f.placed.revision.revisionId);
  assert.equal(movie.manifest.canvas.width, 160);
});

test("canceled queued export regenerates its evicted preview at the original revision after editing", async (t) => {
  const f = await fixture(t);
  await f.preview.request({ projectId: f.projectId });
  await f.jobs.idle();
  const preview = (await f.preview.request({ projectId: f.projectId })).published.preview;
  const original = await readFile(preview.file);
  const hold = f.jobs.createContext(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve("closed"), { once: true }),
      ),
  );
  f.jobs.submitContext(hold, { artifact: "hold", input: "canceled-preview", lane: "heavy" });
  await new Promise(setImmediate);
  const request = f.request();
  await f.exports.create(request);
  f.exports.cancel(request.exportId);
  assert.equal(f.exports.status(request.exportId).state, "canceled");
  f.cache.remove(preview.cacheId);
  f.projects.apply(f.projectId, {
    requestId: "edit-after-cancel",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  await f.jobs.closeContext(hold);
  await f.exports.retry(request.exportId);
  await f.jobs.idle();
  const result = f.exports.status(request.exportId);
  assert.equal(result.state, "committed");
  assert.equal(result.snapshot.revisionId, f.placed.revision.revisionId);
  assert.deepEqual(await readFile(result.output), original);
});
