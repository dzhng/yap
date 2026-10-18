import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Publication } from "../dist/publication.js";
import { fixture, native } from "./fixtures/project-export.mjs";

test("storage totals include failed private exports and exclude the committed external movie", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID();
  const before = await f.storage.usage();
  await writeFile(join(f.output, "taken.mp4"), "external sentinel");
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "taken.mp4",
  });
  await f.jobs.idle();
  assert.equal(f.exports.status(exportId).state, "failed");
  const stage = join(f.output, ".yap-export-" + exportId);
  const bytes =
    (await stat(join(stage, "payload"))).size + (await stat(join(stage, "prepared.json"))).size;
  assert.ok(bytes > 0);
  const one = await f.storage.usage();
  assert.equal(one.otherBytes, before.otherBytes + bytes);
  assert.equal(one.totalBytes, one.sharedBytes + one.cacheBytes + one.modelBytes + bytes);
  assert.equal(await readFile(join(f.output, "taken.mp4"), "utf8"), "external sentinel");
  const successful = randomUUID();
  await f.exports.create({
    exportId: successful,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "export.mp4",
  });
  await f.jobs.idle();
  assert.equal(f.exports.status(successful).state, "committed");
  assert.equal((await f.storage.usage()).otherBytes, before.otherBytes + bytes);
  await f.deletion.delete({ kind: "project", id: f.projectId });
  assert.equal((await f.storage.usage()).otherBytes, before.otherBytes);
  assert.ok((await stat(join(f.output, "export.mp4"))).size > 0);
  assert.equal(await readFile(join(f.output, "taken.mp4"), "utf8"), "external sentinel");
});

test("storage reconciles retired staging but rejects a substituted private directory", async (t) => {
  const f = await fixture(t),
    exportId = randomUUID();
  await writeFile(join(f.output, "taken.mp4"), "external sentinel");
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "taken.mp4",
  });
  await f.jobs.idle();
  const name = ".yap-export-" + exportId,
    stage = join(f.output, name);
  const retainedDirectory = await open(stage);
  t.after(() => retainedDirectory.close());
  const owner = await Publication.open(stage, f.output, native);
  try {
    await owner.retire(name);
  } finally {
    await owner.close();
  }
  // Simulate completed private retirement before its catalog acknowledgement.
  assert.equal((await f.storage.usage()).otherBytes, 0);
  await mkdir(stage, { mode: 0o700 });
  await writeFile(join(stage, "payload"), "replacement");
  await assert.rejects(f.storage.usage());
  assert.equal(await readFile(join(stage, "payload"), "utf8"), "replacement");
  assert.equal(await readFile(join(f.output, "taken.mp4"), "utf8"), "external sentinel");
});

test("storage shutdown aborts and drains an export observation before catalog teardown", async (t) => {
  const entered = Promise.withResolvers(),
    aborted = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    wrap: (worker) => async (operation, params, options) => {
      if (operation === "publication.usage") {
        entered.resolve();
        options.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        await release.promise;
      }
      return worker(operation, params, options);
    },
  });
  await writeFile(join(f.output, "taken.mp4"), "sentinel");
  await f.exports.create({
    exportId: randomUUID(),
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "taken.mp4",
  });
  await f.jobs.idle();
  const read = f.storage.usage();
  const rejected = assert.rejects(read, { code: "CANCELED" });
  await entered.promise;
  let closed = false;
  const closing = f.storage.close().then(() => {
    closed = true;
  });
  await aborted.promise;
  await new Promise(setImmediate);
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(closed, true);
});

test("committed storage excludes the movie before acknowledgement and skips cleared destinations", async (t) => {
  let failAcknowledgement = true;
  const f = await fixture(t, {
    wrap: (worker) => async (operation, params, options) => {
      if (operation === "publication.acknowledge" && failAcknowledgement)
        throw new Error("fixture acknowledgement failure");
      return worker(operation, params, options);
    },
  });
  const exportId = randomUUID();
  await f.exports.create({
    exportId,
    projectId: f.projectId,
    kind: "video",
    directory: f.output,
    leaf: "export.mp4",
  });
  await f.jobs.idle();
  assert.equal(
    f.exports.status(exportId).state,
    "committed",
    JSON.stringify(f.exports.status(exportId)),
  );
  const stage = join(f.output, ".yap-export-" + exportId);
  const metadataBytes = (await stat(join(stage, "prepared.json"))).size;
  assert.equal((await f.storage.usage()).otherBytes, metadataBytes);
  failAcknowledgement = false;
  await f.exports.retry(exportId);
  await f.jobs.idle();
  const moved = f.output + "-moved";
  await rename(f.output, moved);
  t.after(() => rm(moved, { recursive: true, force: true }));
  assert.equal((await f.storage.usage()).otherBytes, 0);
  assert.ok((await stat(join(moved, "export.mp4"))).size > 0);
});
