import type { Acquisition } from "@yap/core/acquisitions";
import type { OperationResult } from "@yap/protocol";
import { openDirectoryLease } from "@yap/core/files";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CaptureStore } from "@yap/core/capture-store";
import {
  captureFixture,
  settleCapture,
  sourceWorker,
  filesWorker,
} from "./project-capture.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = captureFixture.bind(undefined, cleanup);

test("fresh public deletion joins capture quiescence and removes only its donor", async () => {
  const f = await fixture(undefined, filesWorker);
  const started = await f.call("capture.start", {
    requestId: "delete-active",
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId } = started.data as { recordingId: string };
  const directory = join(f.home, "library", "recordings", recordingId);
  const sibling = join(f.home, "library", "recordings", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(sibling, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "partial"), "unfinished donor bytes");
  await writeFile(join(sibling, "retained"), "unrelated bytes");
  const removedBytes = (await stat(join(directory, "partial"))).size;
  const deleted = await f.call("recording.delete", { requestId: "test-delete", recordingId });
  expect(deleted).toMatchObject({
    ok: true,
    data: { recordingId, deleted: true },
  });
  if (deleted.ok) expect((deleted.data as { freedBytes: number }).freedBytes).toBe(removedBytes);
  expect(f.nativeCalls.slice(-2)).toEqual(["capture.cancel", "capture.status"]);
  await expect(readFile(join(directory, "partial"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(sibling, "retained"), "utf8")).toBe("unrelated bytes");
  expect(await f.call("recording.get", { recordingId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("recording.delete", { requestId: "test-delete", recordingId })).toMatchObject(
    {
      ok: true,
      data: { recordingId, deleted: true },
    },
  );
  expect(
    await f.call("recording.delete", { requestId: "test-delete", recordingId: randomUUID() }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("deletion fences retries and joins an acquisition borrowing the donor before removal", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const firstRetirement = deferred<string>();
  let reading = false;
  const f = await fixture(undefined, async (operation, params, options) => {
    if (operation === "media.sourceEvidence") {
      reading = true;
      options!.signal!.addEventListener("abort", () => firstRetirement.resolve("abort"), {
        once: true,
      });
      entered.resolve();
      await release.promise;
      reading = false;
    }
    if (operation.startsWith("storage.")) {
      if (reading) firstRetirement.resolve("files-before-borrower-exit");
      return filesWorker(operation, params, options);
    }
    return sourceWorker(operation, params, options);
  });
  // Release a held worker before service teardown even when the assertion fails.
  cleanup.push(async () => release.resolve());
  const { recordingId, directory, acquisitionId, job } = await settleCapture(f, "held-source");
  await entered.promise;
  let finished = false;
  const deletion = f
    .call("recording.delete", { requestId: "test-delete", recordingId })
    .finally(() => {
      finished = true;
    });
  cleanup.push(async () => {
    release.resolve();
    await deletion.catch(() => {});
  });
  expect(
    await Promise.race([
      firstRetirement.promise,
      deletion.then(() => "deletion-settled-before-borrower"),
    ]),
  ).toBe("abort");
  expect(finished).toBe(false);
  expect(await readFile(join(directory, "video.mov"), "utf8")).toBe("borrowed source bytes");
  expect(await f.call("recording.get", { recordingId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("job.retry", { jobId: job.jobId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  release.resolve();
  expect(await deletion).toMatchObject({ ok: true, data: { recordingId, deleted: true } });
  expect(await f.call("acquisition.get", { acquisitionId })).toMatchObject({ ok: false });
  await expect(readFile(join(directory, "video.mov"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("acquisition reads inherit the shared donor-directory lease as well as the workspace lease", async () => {
  const entered = deferred<readonly number[]>(),
    release = deferred<void>();
  const f = await fixture(undefined, async (operation, params, options) => {
    if (operation === "media.sourceEvidence") {
      entered.resolve(options!.descriptors!);
      await release.promise;
    }
    return sourceWorker(operation, params, options);
  });
  cleanup.push(async () => release.resolve());
  const { directory } = await settleCapture(f, "leased-donor");
  const descriptors = await entered.promise;
  const donor = join(directory, "..");
  const donorInfo = await stat(donor, { bigint: true });
  let exclusive: Awaited<ReturnType<typeof openDirectoryLease>> | undefined;
  let refusal: unknown;
  try {
    exclusive = await openDirectoryLease(donor, "exclusive");
  } catch (error) {
    refusal = error;
  } finally {
    await exclusive?.close();
  }
  expect(refusal).toMatchObject({ code: expect.stringMatching(/^E(AGAIN|WOULDBLOCK)$/) });
  expect(
    descriptors.some((fd) => {
      const info = fstatSync(fd, { bigint: true });
      return info.dev === donorInfo.dev && info.ino === donorInfo.ino;
    }),
  ).toBe(true);
  release.resolve();
});

test.each([
  ["direct", false],
  ["symlink", true],
] as const)(
  "a completed import from the donor folder survives through its %s path",
  async (_pathKind, alias) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    let sourceReads = 0;
    const f = await fixture(undefined, async (operation, params, options) => {
      if (operation === "media.sourceEvidence" && ++sourceReads === 2) {
        entered.resolve();
        await release.promise;
      }
      if (operation.startsWith("storage.")) return filesWorker(operation, params, options);
      return sourceWorker(operation, params, options);
    });
    cleanup.push(async () => release.resolve());
    const take = await settleCapture(f, `explicit-donor-${alias}`);
    await expect
      .poll(() => f.call("job.get", { jobId: take.job.jobId }))
      .toMatchObject({ ok: true, data: { state: "ready" } });
    const selectedPath = alias ? join(f.home, "source-alias") : take.directory;
    if (alias) await symlink(take.directory, selectedPath);
    const imported = await f.call("acquisition.import", {
      requestId: "explicit-managed-source",
      path: selectedPath,
    });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const importedJob = imported.data as { jobId: string; target: { id: string } };
    await entered.promise;
    release.resolve();
    await expect
      .poll(() => f.call("job.get", { jobId: importedJob.jobId }))
      .toMatchObject({ ok: true, data: { state: "ready" } });
    const deleting = f.call("recording.delete", {
      requestId: "test-delete",
      recordingId: take.recordingId,
    });
    cleanup.push(async () => {
      await deleting.catch(() => {});
    });
    expect(await deleting).toMatchObject({ ok: true, data: { deleted: true } });
    expect(await f.call("acquisition.get", { acquisitionId: take.acquisitionId })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await f.call("acquisition.get", { acquisitionId: importedJob.target.id })).toMatchObject(
      {
        ok: true,
      },
    );
  },
);

test("a retained donor lease refuses deletion without hiding independent ready acquisition data", async () => {
  const f = await fixture(undefined, async (operation, params, options) =>
    operation.startsWith("storage.")
      ? filesWorker(operation, params, options)
      : sourceWorker(operation, params, options),
  );
  const take = await settleCapture(f, "lease-refusal");
  await expect
    .poll(() => f.call("job.get", { jobId: take.job.jobId }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  const acquired = await f.call("acquisition.get", { acquisitionId: take.acquisitionId });
  if (!acquired.ok) throw new Error(JSON.stringify(acquired));
  const acquiredValue = acquired.data as Acquisition;
  const acquiredAssetId = acquiredValue.bindings[0]!.assetId;
  const held = await openDirectoryLease(join(take.directory, ".."), "shared");
  cleanup.push(() => held.close());
  expect(
    await f.call("recording.delete", {
      requestId: "test-delete-first",
      recordingId: take.recordingId,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "RECORDING_BUSY", retryable: true },
  });
  expect(await f.call("recording.list")).toMatchObject({ ok: true, data: { recordings: [] } });
  expect(await f.call("recording.get", { recordingId: take.recordingId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("acquisition.get", { acquisitionId: take.acquisitionId })).toMatchObject({
    ok: true,
    data: acquired.data,
  });
  expect(await readFile(join(take.directory, "video.mov"), "utf8")).toBe("borrowed source bytes");
  await held.close();
  expect(
    await f.call("recording.delete", {
      requestId: "test-delete-second",
      recordingId: take.recordingId,
    }),
  ).toMatchObject({
    ok: true,
    data: { deleted: true },
  });
  expect(await f.call("acquisition.get", { acquisitionId: take.acquisitionId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("asset.get", { assetId: acquiredAssetId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("job.retry", { jobId: take.job.jobId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("failed public donor removal resumes its durable fence on reopen", async () => {
  let refused = false;
  const f = await fixture(undefined, async (operation, params, options) => {
    if (operation === "storage.removeRecordingDirectory" && !refused) {
      refused = true;
      return {
        ok: false,
        error: {
          code: "MEDIA_UNAVAILABLE",
          message: "scratch refusal",
          details: {},
          retryable: true,
        },
      };
    }
    return operation.startsWith("storage.")
      ? filesWorker(operation, params, options)
      : sourceWorker(operation, params, options);
  });
  const take = await settleCapture(f, "resume-deletion");
  await expect
    .poll(() => f.call("job.get", { jobId: take.job.jobId }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  expect(
    await f.call("recording.delete", { requestId: "test-delete", recordingId: take.recordingId }),
  ).toMatchObject({
    ok: false,
    error: { code: "MEDIA_UNAVAILABLE", retryable: true },
  });
  expect(await f.call("recording.list")).toMatchObject({ ok: true, data: { recordings: [] } });
  expect(await readFile(join(take.directory, "video.mov"), "utf8")).toBe("borrowed source bytes");
  await f.service.close();
  const reopened = await fixture(f.home, filesWorker);
  await expect
    .poll(async () =>
      readFile(join(take.directory, "video.mov")).then(
        () => false,
        (error) => error.code === "ENOENT",
      ),
    )
    .toBe(true);
  expect(
    await reopened.call("recording.delete", {
      requestId: "test-delete",
      recordingId: take.recordingId,
    }),
  ).toMatchObject({
    ok: true,
    data: { deleted: true },
  });
  expect(await reopened.call("job.retry", { jobId: take.job.jobId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(
    await reopened.call("acquisition.get", { acquisitionId: take.acquisitionId }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("a legacy recording marker resumes old semantics without taking its acquisition", async () => {
  const home = await mkdtemp("/tmp/yap-legacy-recording-delete-");
  const f = await fixture(home, sourceWorker);
  const take = await settleCapture(f, "legacy-marker");
  await expect
    .poll(() => f.call("job.get", { jobId: take.job.jobId }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  await f.service.close();
  const legacy = new CaptureStore(join(home, "library", "catalog.sqlite"), {
    now: () => "legacy",
    newId: randomUUID,
  });
  legacy.markDeleting(take.recordingId);
  legacy.close();

  const reopened = await fixture(home, sourceWorker);
  await expect
    .poll(() => reopened.call("recording.get", { recordingId: take.recordingId }))
    .toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(
    await reopened.call("acquisition.get", { acquisitionId: take.acquisitionId }),
  ).toMatchObject({
    ok: true,
  });
  await reopened.service.close();
  await rm(home, { recursive: true, force: true });
});

test("cancel losing to completed capture releases admission without discarding the source", async () => {
  const f = await fixture(undefined, sourceWorker, "capture.cancel");
  const started = await f.call("capture.start", {
    requestId: "cancel-completed",
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  const directory = join(f.home, "library", "recordings", recordingId, "source");
  await writeFile(
    join(directory, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: sourceId }),
  );
  await writeFile(join(directory, "video.mov"), "completion won");
  await f.call("capture.stop", { recordingId });
  const canceling = f.call("capture.cancel", { recordingId });
  cleanup.push(async () => {
    f.input.end();
    await canceling.catch(() => {});
  });
  await expect.poll(() => f.nativeCalls.at(-1)).toBe("capture.cancel");
  f.reply("capture.cancel", {
    recordingId,
    sourceId,
    sequence: 3,
    state: "complete",
    sourceDurationUs: 100,
  });
  expect(await canceling).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  await expect
    .poll(() => f.call("recording.get", { recordingId }))
    .toMatchObject({
      ok: true,
      data: { state: "complete", sourceAdmissions: [{ job: { state: "ready" } }] },
    });
  expect(await readFile(join(directory, "video.mov"), "utf8")).toBe("completion won");
});

function data<T = unknown>(result: OperationResult): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data as T;
}

test("a recording used by a project refuses until cascade retires its copies and project", async () => {
  const f = await fixture(undefined, sourceWorker);
  const take = await settleCapture(f, "independent-source");
  await expect
    .poll(() => f.call("job.get", { jobId: take.job.jobId }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  const acquisition = data<Acquisition>(
    await f.call("acquisition.get", { acquisitionId: take.acquisitionId }),
  );
  const binding = acquisition.bindings[0]!;
  const created = data<{ project: { projectId: string }; revision: { revisionId: string } }>(
    await f.call("project.create", {
      requestId: "authored-project",
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    }),
  );
  const projectId = created.project.projectId;
  data<{ revision: { revisionId: string } }>(
    await f.call("edit.apply", {
      projectId,
      requestId: "authored-placement",
      expectedRevisionId: created.revision.revisionId,
      operations: [
        { operation: "track.add", label: "picture", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          clip: {
            trackId: { label: "picture" },
            assetId: binding.assetId,
            streamId: binding.streamId,
            acquisitionId: acquisition.id,
            source: { kind: "range", range: { startUs: 0, endUs: 100 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 100 } },
          },
        },
      ],
    }),
  );
  await expect
    .poll(() => f.call("cursor.raw", { projectId }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  const refused = await f.call("recording.delete", {
    requestId: "test-delete",
    recordingId: take.recordingId,
  });
  expect(refused).toMatchObject({
    ok: false,
    error: {
      code: "IN_USE",
      retryable: false,
      details: {
        recordingId: take.recordingId,
        usedBy: [{ kind: "project", id: projectId, revisions: 2 }],
        acquisitions: [{ kind: "acquisition", id: acquisition.id }],
        derivedAssets: [],
        freesBytes: expect.any(Number),
        cascadeFreesBytes: expect.any(Number),
      },
    },
  });
  if (refused.ok) throw new Error(JSON.stringify(refused));
  const details = refused.error.details as { cascadeFreesBytes: number };
  f.service.captures.catalog.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
  const usageBefore = await f.call("storage.usage", {});
  if (!usageBefore.ok) throw new Error(JSON.stringify(usageBefore));
  const deleted = await f.call("recording.delete", {
    requestId: "test-delete-cascade",
    recordingId: take.recordingId,
    cascade: true,
  });
  expect(deleted).toMatchObject({
    ok: true,
    data: { recordingId: take.recordingId, deleted: true, freedBytes: details.cascadeFreesBytes },
  });
  await expect(readFile(join(take.directory, "video.mov"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.call("project.get", { projectId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  await expect(f.call("acquisition.get", { acquisitionId: acquisition.id })).resolves.toMatchObject(
    {
      ok: false,
      error: { code: "NOT_FOUND" },
    },
  );
  expect(await f.call("job.retry", { jobId: take.job.jobId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  f.service.captures.catalog.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
  const usageAfter = await f.call("storage.usage", {});
  if (!usageAfter.ok) throw new Error(JSON.stringify(usageAfter));
  expect((usageBefore.data as { cacheBytes: number }).cacheBytes).toBeGreaterThan(
    (usageAfter.data as { cacheBytes: number }).cacheBytes,
  );
});

test("a recording refuses when a copy asset has a derived asset user", async () => {
  const f = await fixture(undefined, sourceWorker);
  const take = await settleCapture(f, "derived-recording-user");
  await expect
    .poll(() => f.call("job.get", { jobId: take.job.jobId }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  const acquisition = data<Acquisition>(
    await f.call("acquisition.get", { acquisitionId: take.acquisitionId }),
  );
  const sourceAssetId = acquisition.bindings[0]!.assetId;
  const derivedPath = join(f.home, "derived-recording-user.png");
  await writeFile(derivedPath, "derived bytes");
  const imported = await f.call("asset.import", {
    requestId: "derived-recording-user-import",
    path: derivedPath,
  });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const importedJobId = (imported.data as { jobId: string }).jobId;
  await expect
    .poll(() => f.call("job.get", { jobId: importedJobId }))
    .toMatchObject({
      ok: true,
      data: { state: "ready" },
    });
  const ready = await f.call("job.get", { jobId: importedJobId });
  if (!ready.ok) throw new Error(JSON.stringify(ready));
  const derivedAssetId = (ready.data as { published: { output: { assetId: string } } }).published
    .output.assetId;
  const catalog = f.service.captures.catalog;
  catalog
    .prepare(
      "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
    )
    .run("asset", sourceAssetId, "asset", derivedAssetId);
  const creatingJobId = randomUUID();
  catalog
    .prepare(
      "INSERT INTO jobs(jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,state,reason,errorCode,errorDetails,retryable,generation,queuedSequence,deferred,readmitted,inputSha256,input) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      creatingJobId,
      randomUUID(),
      "asset",
      derivedAssetId,
      "",
      "asset-conversion",
      "heavy",
      "failed",
      null,
      null,
      null,
      0,
      1,
      1,
      0,
      0,
      "derived-recording-job",
      "derived-recording-job",
    );

  const refused = await f.call("recording.delete", {
    requestId: "derived-recording-refusal",
    recordingId: take.recordingId,
  });
  expect(refused).toMatchObject({
    ok: false,
    error: {
      code: "IN_USE",
      details: {
        recordingId: take.recordingId,
        usedBy: [],
        acquisitions: [{ kind: "acquisition", id: take.acquisitionId }],
        derivedAssets: expect.arrayContaining([{ kind: "asset", id: derivedAssetId }]),
        freesBytes: expect.any(Number),
        cascadeFreesBytes: expect.any(Number),
      },
    },
  });
  if (refused.ok) throw new Error(JSON.stringify(refused));
  const details = refused.error.details as { cascadeFreesBytes: number };
  expect(await f.call("recording.get", { recordingId: take.recordingId })).toMatchObject({
    ok: true,
  });
  expect(await f.call("asset.get", { assetId: derivedAssetId })).toMatchObject({ ok: true });

  const deleted = await f.call("recording.delete", {
    requestId: "derived-recording-cascade",
    recordingId: take.recordingId,
    cascade: true,
  });
  expect(deleted).toMatchObject({
    ok: true,
    data: { recordingId: take.recordingId, deleted: true, freedBytes: details.cascadeFreesBytes },
  });
  expect(await f.call("acquisition.get", { acquisitionId: take.acquisitionId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("asset.get", { assetId: derivedAssetId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(
    catalog.prepare("SELECT COUNT(*) AS count FROM jobs WHERE targetId=?").get(derivedAssetId),
  ).toEqual({
    count: 0,
  });
  expect(catalog.prepare("SELECT COUNT(*) AS count FROM resource_references").get()).toEqual({
    count: 0,
  });
});

test("public discard fences and drains queued managed imports before native cancellation", async () => {
  const f = await fixture(undefined, sourceWorker, "capture.cancel");
  const { recordingId, sourceId } = data<{ recordingId: string; sourceId: string }>(
    await f.call("capture.start", {
      requestId: "discard-borrower",
      source: { kind: "display", displayId: 1 },
    }),
  );
  const directory = join(f.home, "library", "recordings", recordingId, "source");
  await writeFile(
    join(directory, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: sourceId }),
  );
  await writeFile(join(directory, "video.mov"), "not yet discarded");
  const request = { requestId: "queued-managed-import", path: directory };
  const imported = data<{ jobId: string; target: { id: string } }>(
    await f.call("acquisition.import", request),
  );
  expect(await f.call("job.get", { jobId: imported.jobId })).toMatchObject({
    ok: true,
    data: { state: "queued" },
  });
  const canceling = f.call("capture.cancel", { recordingId });
  cleanup.push(async () => {
    f.input.end();
    await canceling.catch(() => {});
  });
  await expect.poll(() => f.nativeCalls.at(-1)).toBe("capture.cancel");
  expect(await f.call("job.get", { jobId: imported.jobId })).toMatchObject({
    ok: true,
    data: { state: "canceled", retryable: true },
  });
  expect(await f.call("job.retry", { jobId: imported.jobId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("acquisition.import", request)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await readFile(join(directory, "video.mov"), "utf8")).toBe("not yet discarded");
  f.reply("capture.cancel", { recordingId, sourceId, sequence: 2, state: "finalizing" });
  expect(await canceling).toMatchObject({ ok: true, data: { state: "canceled" } });
  await expect(readFile(join(directory, "video.mov"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.call("job.get", { jobId: imported.jobId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await f.call("acquisition.get", { acquisitionId: imported.target.id })).toMatchObject({
    ok: false,
    error: { code: "PREREQUISITE_MISSING" },
  });
  expect(await f.call("capture.cancel", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "canceled" },
  });
});
