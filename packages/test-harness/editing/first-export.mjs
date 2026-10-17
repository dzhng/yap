import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function external(file) {
  const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
  return { sha256: digest(bytes), bytes: bytes.length, dev: info.dev, ino: info.ino };
}

/** The public export journey shares the preview's real transports and media oracle. */
export async function exportJourney({
  out,
  projectId,
  revisionId,
  previewFile,
  call,
  poll,
  advance,
  armFault,
  crashService,
  evidence,
  kind = "video",
}) {
  await mkdir(join(out, "exports"), { recursive: true });
  const directory = await realpath(join(out, "exports"));
  const extension = kind === "audio" ? "wav" : "mp4";
  const request = {
    projectId,
    kind,
    exportId: randomUUID(),
    directory,
    leaf: `pinned.${extension}`,
  };
  const created = await call("export.create", request);
  assert.equal(created.snapshot.revisionId, revisionId);
  await advance();
  const replay = await call("export.create", request, { transport: "mcp" });
  assert.equal(
    replay.snapshot.revisionId,
    revisionId,
    "Omitted revision replay moved to edited head",
  );
  assert.equal(
    (
      await call(
        "export.create",
        { ...request, leaf: `changed.${extension}` },
        { transport: "mcp", error: true },
      )
    ).code,
    "REQUEST_CONFLICT",
  );
  const committed = await poll(
    () => call("export.status", { exportId: request.exportId }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "full project export",
  );
  assert.equal(committed.output, join(directory, request.leaf));
  const file = await external(committed.output);
  assert.equal(file.sha256, committed.receipt.sha256);
  assert.equal(file.bytes, committed.receipt.bytes);
  // The shared cache derivative is copied by the one publication owner. Exact
  // byte equality also preserves every decoded frame, stereo sample and impulse
  // already checked independently in the full preview.
  assert.equal(file.sha256, digest(await readFile(previewFile)));
  const listed = await call("export.list", { projectId }, { transport: "mcp" });
  assert.ok(
    listed.exports.some(
      (item) =>
        item.exportId === request.exportId &&
        item.revisionId === revisionId &&
        item.state === "ready",
    ),
  );
  const retried = await call("job.retry", { jobId: committed.jobId });
  assert.equal(retried.state, "ready");
  const afterRetry = await call(
    "export.status",
    { exportId: request.exportId },
    { transport: "mcp" },
  );
  assert.deepEqual(afterRetry.receipt, committed.receipt);
  assert.deepEqual(await external(committed.output), file, "Retry republished a committed export");
  Object.assign(evidence, {
    request,
    pinnedRevisionId: revisionId,
    receipt: committed.receipt,
    file,
    exactPreviewBytes: true,
  });
  const kept = [{ path: committed.output, file }];
  const waitCommit = (exportId) =>
    poll(
      () => call("export.status", { exportId }, { transport: "mcp" }),
      (value) => value.state === "ready",
      "commit after explicit retry",
    );
  const canceledRequest = {
    ...request,
    revisionId,
    exportId: randomUUID(),
    leaf: `cancel-retry.${extension}`,
  };
  const hit = await armFault("before-commit");
  const canceledCreated = await call("export.create", canceledRequest, { transport: "mcp" });
  const observer = await hit();
  const canceledPath = join(directory, canceledRequest.leaf);
  await assert.rejects(stat(canceledPath), { code: "ENOENT" });
  await call("export.cancel", { exportId: canceledRequest.exportId });
  const canceledJob = await poll(
    () => call("job.get", { jobId: canceledCreated.jobId }),
    (value) => value.state === "canceled",
    "cancel held publication",
  );
  assert.equal(canceledJob.published, null);
  const recovering = await call("export.recover", { exportId: canceledRequest.exportId });
  assert.ok(recovering.recovery?.jobId, "Prepared publication must have a recovery job");
  await poll(
    () => call("job.get", { jobId: recovering.recovery.jobId }),
    (value) => value.state === "ready",
    "drain canceled publication and reconcile",
  );
  const canceled = await call("export.status", { exportId: canceledRequest.exportId });
  assert.equal(canceled.receipt, null);
  assert.equal(canceled.output, null);
  await assert.rejects(stat(canceledPath), { code: "ENOENT" });
  await call("job.retry", { jobId: canceledJob.jobId }, { transport: "mcp" });
  const resumed = await waitCommit(canceledRequest.exportId);
  const resumedFile = await external(canceledPath);
  assert.equal(resumedFile.sha256, file.sha256);
  assert.equal(resumedFile.sha256, resumed.receipt.sha256);
  assert.equal(resumedFile.bytes, resumed.receipt.bytes);
  kept.push({ path: canceledPath, file: resumedFile });
  evidence.cancellation = {
    observer,
    request: canceledRequest,
    canceledState: canceledJob.state,
    absentBeforeCommitAndAfterDrain: true,
    retryReceipt: resumed.receipt,
    file: resumedFile,
  };
  const faultRequests = [];
  for (const outcome of ["crash", "cancel"]) {
    const heldRequest = {
      ...request,
      revisionId,
      exportId: randomUUID(),
      leaf: `${outcome}-after-commit.${extension}`,
    };
    faultRequests.push(heldRequest);
    const observe = await armFault("after-commit");
    const accepted = await call("export.create", heldRequest, { transport: "mcp" });
    const commitObserver = await observe();
    const path = join(directory, heldRequest.leaf);
    const preparedReceipt = JSON.parse(
      await readFile(
        join(directory, `.yap-export-${heldRequest.exportId}`, "prepared.json"),
        "utf8",
      ),
    );
    const committedFile = await external(path);
    assert.equal(committedFile.sha256, preparedReceipt.sha256);
    assert.equal(committedFile.bytes, preparedReceipt.bytes);
    assert.equal(committedFile.sha256, file.sha256);
    const unacknowledged = await call("export.status", { exportId: heldRequest.exportId });
    assert.equal(
      unacknowledged.receipt,
      null,
      "Fixture failed to withhold the actual commit reply",
    );
    assert.equal(unacknowledged.output, null);
    assert.equal(unacknowledged.state, "running");
    const faultEvidence = {
      request: heldRequest,
      observer: commitObserver,
      unacknowledged: true,
      preparedReceipt,
      file: committedFile,
    };
    evidence[`${outcome}AfterCommit`] = faultEvidence;
    let exit;
    if (outcome === "crash") {
      exit = await crashService();
      const interrupted = await call("job.get", { jobId: accepted.jobId });
      assert.equal(interrupted.state, "failed");
      assert.equal(interrupted.errorCode, "JOB_INTERRUPTED");
    } else await call("export.cancel", { exportId: heldRequest.exportId });
    const recovery = await call(
      "export.recover",
      { exportId: heldRequest.exportId },
      { transport: "mcp" },
    );
    if (recovery.recovery?.jobId)
      await poll(
        () => call("job.get", { jobId: recovery.recovery.jobId }),
        (value) => value.state === "ready",
        "reconcile real commit after interrupted reply",
      );
    const recovered = await waitCommit(heldRequest.exportId);
    assert.equal(recovered.snapshot.revisionId, revisionId);
    assert.deepEqual(recovered.receipt, preparedReceipt);
    assert.deepEqual(
      await external(path),
      committedFile,
      "Recovery replaced committed external bytes",
    );
    kept.push({ path, file: committedFile });
    Object.assign(faultEvidence, {
      ...(exit ? { exit } : {}),
      recoveredReceipt: recovered.receipt,
    });
  }
  const discovered = [];
  let cursor;
  do {
    const page = await call(
      "export.list",
      { projectId, limit: 1, ...(cursor ? { cursor } : {}) },
      { transport: discovered.length % 2 ? "mcp" : "cli" },
    );
    assert.equal(page.exports.length, 1, "Each bounded page must expose the next known intent");
    discovered.push(...page.exports.map((item) => item.exportId));
    assert.ok(discovered.length <= 4, "Export pagination did not make bounded progress");
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    discovered,
    [
      request.exportId,
      canceledRequest.exportId,
      ...faultRequests.map((value) => value.exportId),
    ].sort(),
  );
  evidence.pagination = discovered;
  const abandoned = await call("export.abandon", { exportId: request.exportId });
  assert.equal(abandoned.abandoned, true);
  assert.equal(
    (await call("export.status", { exportId: request.exportId }, { transport: "mcp", error: true }))
      .code,
    "NOT_FOUND",
  );
  const remaining = await call("export.list", { projectId }, { transport: "mcp" });
  assert.deepEqual(
    remaining.exports.map((value) => value.exportId),
    discovered.filter((id) => id !== request.exportId),
  );
  assert.deepEqual(
    await external(committed.output),
    file,
    "Abandonment changed committed external bytes",
  );
  evidence.abandonment = {
    exportId: request.exportId,
    statusCode: "NOT_FOUND",
    remainingIds: remaining.exports.map((value) => value.exportId),
    preservedFile: { path: committed.output, ...file },
  };
  return {
    async afterDeletion() {
      for (const item of kept)
        assert.deepEqual(
          await external(item.path),
          item.file,
          "Project deletion changed external export",
        );
      return kept;
    },
  };
}
