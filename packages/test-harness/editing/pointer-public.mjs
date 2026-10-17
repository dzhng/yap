import { pointerFixture } from "./pointer-fixture.mjs";
import { pointerCases } from "./pointer-cases.mjs";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE);
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "pointer-public-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-pointer-public-"));
const report = { passed: false, trace: [], checks: {} };
const service = new JourneyService(home, report, join(out, "native")),
  call = service.call.bind(service);
const canvas = {
  width: 256,
  height: 160,
  fps: { numerator: 10, denominator: 1 },
  background: "#000000ff",
};
try {
  const { donor, records } = await pointerFixture(home);
  await service.start();
  const pending = await call("acquisition.import", { requestId: "authored-pointer", path: donor });
  const imported = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
    "pointer source adoption",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: imported.target.acquisitionId,
  });
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  const source = {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
  };
  const created = await call("project.create", { requestId: "pointer", canvas });
  const projectId = created.project.projectId;
  const edited = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: created.revision.id,
      requestId: "pointer",
      operations: [
        { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "clip",
          clip: {
            ...source,
            trackId: { label: "video" },
            source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "clip" } },
          steps: [{ label: "pointer", processor: { type: "pointer", trailUs: 600000 } }],
        },
      ],
    },
    { transport: "mcp" },
  );
  const selection = { projectId, revisionId: edited.revision.id };
  const pictureRequest = { ...selection, atUs: 1000000, maxLongEdge: 256 };
  const coldExportId = randomUUID();
  const coldHit = await service.arm("media.presentationEvidence");
  const cold = await call("export.create", {
    ...selection,
    kind: "video",
    exportId: coldExportId,
    directory: out,
    leaf: "cold-export.mp4",
  });
  // Await the real native child without another request/schedule waking the queue.
  await coldHit();
  const coldParent = await call("job.get", { jobId: cold.jobId });
  const coldPreview = await call("job.get", { jobId: coldParent.reason });
  const coldHistory = await call("job.get", { jobId: coldPreview.reason });
  assert.equal(coldParent.state, "queued");
  assert.equal(coldPreview.state, "queued");
  assert.equal(coldHistory.artifact, "pointer-presentation");
  await call("job.cancel", { jobId: coldHistory.jobId });
  const coldFailed = await poll(
    () => call("export.status", { exportId: coldExportId }),
    (v) => v.state === "failed",
    "cold export canceled prerequisite",
  );
  assert.equal(coldFailed.retryable, true);
  for (let i = 0; i < 3; i++) {
    assert.equal((await call("export.status", { exportId: coldExportId })).state, "failed");
    assert.equal(
      (await call("job.get", { jobId: coldHistory.jobId })).attemptId,
      coldHistory.attemptId,
    );
  }
  await call("job.retry", { jobId: coldFailed.jobId }, { transport: "mcp" });
  const coldReady = await poll(
    () => call("export.status", { exportId: coldExportId }),
    (v) => v.state === "ready",
    "cold export explicit prerequisite retry",
  );
  report.checks.coldExport = {
    coldParent,
    coldPreview,
    coldHistory,
    coldFailed,
    coldReady,
    startedWithoutClientWake: true,
    ordinaryReadsDidNotRetry: true,
  };
  await evictHistory();
  const hit = await service.arm("media.presentationEvidence");
  const firstFrame = await call("frame.get", pictureRequest);
  await hit();
  const waitingFrame = await call("job.get", { jobId: firstFrame.jobId });
  assert.equal(waitingFrame.state, "queued");
  const historyJob = await call("job.get", { jobId: waitingFrame.reason });
  assert.equal(historyJob.artifact, "pointer-presentation");
  await call("job.cancel", { jobId: historyJob.jobId });
  const failedFrame = await poll(
    () => call("frame.get", pictureRequest),
    (v) => v.state === "failed",
    "canceled prerequisite failure",
  );
  assert.equal(failedFrame.retryable, true);
  for (let i = 0; i < 3; i++) {
    assert.equal((await call("frame.get", pictureRequest)).state, "failed");
    assert.equal(
      (await call("job.get", { jobId: historyJob.jobId })).attemptId,
      historyJob.attemptId,
    );
  }
  await call("job.retry", { jobId: failedFrame.jobId }, { transport: "mcp" });
  report.checks.canceledHistory = {
    waitingFrame,
    historyJob,
    failedFrame,
    ordinaryReadsDidNotRetry: true,
  };
  function history() {
    const db = new DatabaseSync(join(home, "library", "catalog.sqlite"), { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT result FROM artifacts WHERE targetKind='acquisition' AND targetId=? AND artifact='pointer-presentation'",
        )
        .get(source.acquisitionId);
      const job = db
        .prepare(
          "SELECT jobId,generation,attemptId,state FROM jobs WHERE targetKind='acquisition' AND targetId=? AND artifact='pointer-presentation'",
        )
        .get(source.acquisitionId);
      return { ...JSON.parse(row.result), job };
    } finally {
      db.close();
    }
  }
  async function evictHistory() {
    const value = history();
    await rm(join(home, "library", "cache", "derived", value.cacheId + ".cache"));
    return value;
  }
  const file = join(out, "identity.png");
  const ready = await poll(
    () => call("frame.get", { ...selection, atUs: 1000000, maxLongEdge: 256 }, { output: file }),
    (v) => v.state === "ready",
    "prepared public frame",
  );
  assert.ok(
    (await readFile(file)).equals(
      await readFile(
        new URL(
          "../../../specs/done/agent-editing/assets/15-pointer-execution/images/identity.png",
          import.meta.url,
        ),
      ),
    ),
    "Public pointer differs from frozen prepared native picture",
  );
  const mcp = await service.mcp.callTool({
    name: "frame.get",
    arguments: { ...selection, atUs: 1000000, maxLongEdge: 256 },
  });
  assert.equal(mcp.structuredContent.ok, true);
  assert.ok(
    (await readFile(file)).equals(
      Buffer.from(mcp.content.find((v) => v.type === "image").data, "base64"),
    ),
  );
  report.checks.frame = { hash: hash(await readFile(file)), receipt: ready.published.output };
  const movie = join(out, "preview.mp4");
  const preview = await poll(
    () => call("preview.get", selection, { output: movie }),
    (v) => v.state === "ready",
    "prepared public preview",
  );
  report.checks.preview = preview;
  const selectedRange = { startUs: 1050001, endUs: 1350001 };
  const rangePreview = await poll(
    () =>
      call(
        "preview.get",
        { ...selection, range: selectedRange },
        { output: join(out, "range-preview.mp4") },
      ),
    (v) => v.state === "ready",
    "clipped pointer preview",
  );
  const movieRequests = [];
  for (const name of await readdir(join(out, "native"))) {
    if (!name.endsWith(".json")) continue;
    const path = join(out, "native", name),
      request = JSON.parse(await readFile(path, "utf8"));
    if (request.operation === "media.renderCompositionMovie")
      movieRequests.push({
        ...request,
        rows: (await readFile(path.replace(/\.json$/, "-pointers.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse),
      });
  }
  const fullRows = movieRequests.find((v) => v.request.range.startUs === 0).rows;
  const rangeRows = movieRequests.find(
    (v) => v.request.range.startUs === selectedRange.startUs,
  ).rows;
  assert.equal(rangeRows[0].sampleAtUs, 1000000);
  assert.deepEqual(
    rangeRows,
    fullRows.filter((row) => rangeRows.some((r) => r.frameIndex === row.frameIndex)),
  );
  report.checks.range = {
    request: selectedRange,
    preview: rangePreview,
    preparedRows: rangeRows,
    firstFloorSelectedSample: 1000000,
    exactFullRangePreparation: true,
    scope:
      "Prepared source/pointer rows only; thin encoded colored-trail acceptance remains open under slice06",
  };

  const exportId = randomUUID();
  await call("export.create", {
    ...selection,
    kind: "video",
    exportId,
    directory: out,
    leaf: "export.mp4",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "pointer export",
  );
  report.checks.export = exported;
  const beforeEviction = await evictHistory();
  assert.equal((await call("frame.get", pictureRequest)).state, "ready");
  assert.equal((await call("preview.get", selection)).state, "ready");
  assert.equal(
    history().job.generation,
    beforeEviction.job.generation,
    "Ready output reads must not reprepare source history",
  );
  const index = await poll(
    () => call("index.get", { ...selection, maxLongEdge: 256, limit: 10 }),
    (v) => v.state === "ready",
    "pointer retained index without lane deadlock",
  );
  report.checks.index = index;
  assert.equal(history().job.generation, beforeEviction.job.generation + 1);
  report.checks.eviction = {
    fixtureFault: "Removed only the scratch history cache file; retained its published metadata",
    before: beforeEviction.job,
    after: history().job,
    completedReadyReadsWithoutHistory: true,
    indexRepreparedBeforeHeavyProducer: true,
  };
  async function picture(selected, atUs, name, tap) {
    const file = join(out, name + ".png");
    const receipt = await poll(
      () =>
        call(
          "frame.get",
          { ...selected, atUs, maxLongEdge: 256, ...(tap ? { tap } : {}) },
          { output: file },
        ),
      (v) => v.state === "ready",
      name,
    );
    return { receipt: receipt.published.output, sha256: hash(await readFile(file)), file };
  }
  let revisionId = selection.revisionId;
  const clipId = edited.edit.labels.clip;
  const matrices = [];
  for (const [name, steps] of pointerCases()) {
    const changed = await call(
      "edit.apply",
      {
        projectId,
        expectedRevisionId: revisionId,
        requestId: "stack-" + name,
        operations: [
          {
            operation: "processing.set",
            target: { kind: "clip", id: clipId },
            steps: steps.map(({ id, ...step }) => ({ label: id, ...step })),
          },
        ],
      },
      { transport: "mcp" },
    );
    revisionId = changed.revision.id;
    const rendered = await picture({ projectId, revisionId }, 1000000, "stack-" + name);
    const reference = await readFile(
      new URL(
        "../../../specs/done/agent-editing/assets/15-pointer-execution/images/" + name + ".png",
        import.meta.url,
      ),
    );
    assert.equal(
      rendered.sha256,
      hash(reference),
      "Public stack changed reviewed native pixels: " + name,
    );
    matrices.push({ name, ...rendered });
  }
  report.checks.stackMatrix = matrices;
  // Restore identity and compare edit mappings through real public operations.
  const restored = await call("edit.apply", {
    projectId,
    expectedRevisionId: revisionId,
    requestId: "restore-pointer",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [{ label: "pointer", processor: { type: "pointer", trailUs: 600000 } }],
      },
    ],
  });
  const identitySelection = { projectId, revisionId: restored.revision.id };
  const dry = await picture(identitySelection, 1000000, "tap-dry", {
    target: { kind: "clip", id: clipId },
    point: { kind: "dry" },
  });
  const afterPointer = await picture(identitySelection, 1000000, "tap-after-pointer", {
    target: { kind: "clip", id: clipId },
    point: { kind: "after-step", stepId: restored.edit.labels.pointer },
  });
  assert.equal(dry.sha256, matrices.find((v) => v.name === "disabled").sha256);
  assert.equal(afterPointer.sha256, matrices.find((v) => v.name === "identity").sha256);
  report.checks.taps = { dry, afterPointer };
  const split = await call("edit.apply", {
    projectId,
    expectedRevisionId: restored.revision.id,
    requestId: "split-pointer",
    operations: [
      {
        operation: "split",
        clipIds: [clipId],
        atUs: 950001,
        rightLabels: [{ clipId, label: "right" }],
      },
    ],
  });
  const splitSelection = { projectId, revisionId: split.revision.id };
  const splitChecks = [];
  for (const atUs of [900000, 950001, 1000000, 1100000, 1500000]) {
    const original = await picture(identitySelection, atUs, "split-original-" + atUs);
    const divided = await picture(splitSelection, atUs, "split-divided-" + atUs);
    assert.equal(divided.sha256, original.sha256, "Pure split reset source history");
    splitChecks.push({ atUs, original, divided });
  }
  report.checks.splitHistory = splitChecks;
  const rightId = split.edit.labels.right;
  const held = await call("edit.apply", {
    projectId,
    expectedRevisionId: split.revision.id,
    requestId: "hold-pointer",
    operations: [
      {
        operation: "replace",
        clipId: rightId,
        kind: "video",
        media: { ...source, source: { kind: "hold", atUs: 900000 } },
        fit: "exact",
      },
    ],
  });
  const heldReference = await picture(identitySelection, 900000, "held-reference");
  const heldChecks = [];
  for (const atUs of [1000000, 1300000, 1900000]) {
    const rendered = await picture(
      { projectId, revisionId: held.revision.id },
      atUs,
      "held-" + atUs,
    );
    assert.equal(rendered.sha256, heldReference.sha256, "Held clip advanced source-clock trail");
    heldChecks.push(rendered);
  }
  report.checks.held = heldChecks;
  const retimed = await call("edit.apply", {
    projectId,
    expectedRevisionId: held.revision.id,
    requestId: "retime-pointer",
    operations: [
      {
        operation: "replace",
        clipId: rightId,
        kind: "video",
        media: { ...source, source: { kind: "range", range: { startUs: 0, endUs: 2000000 } } },
        fit: "stretch",
      },
      { operation: "move", clipIds: [rightId], atUs: 1000000, ripple: "none" },
      { operation: "retime", clipIds: [rightId], durationUs: 4000000, ripple: "none" },
    ],
  });
  const retimedChecks = [];
  for (const [atUs, sourceUs] of [
    [2000000, 500000],
    [3000000, 1000000],
  ]) {
    const original = await picture(identitySelection, sourceUs, "retime-source-" + sourceUs);
    const rendered = await picture(
      { projectId, revisionId: retimed.revision.id },
      atUs,
      "retimed-" + atUs,
    );
    assert.equal(rendered.sha256, original.sha256, "Retime changed source-clock history");
    retimedChecks.push({ atUs, sourceUs, original, rendered });
  }
  report.checks.retimed = retimedChecks;
  const historyBeforeRepeat = history().job;
  const repeated = await call("edit.apply", {
    projectId,
    expectedRevisionId: retimed.revision.id,
    requestId: "repeat-pointer",
    operations: [
      {
        operation: "duplicate",
        clipIds: [rightId],
        atUs: 5000000,
        copyLabels: [{ clipId: rightId, label: "repeat" }],
      },
    ],
  });
  const replay = await picture(
    { projectId, revisionId: repeated.revision.id },
    7000000,
    "repeated",
  );
  assert.equal(
    replay.sha256,
    retimedChecks[1].rendered.sha256,
    "Repeated source reused project-clock trail",
  );
  assert.equal(
    history().job.generation,
    historyBeforeRepeat.generation,
    "Clip edits should not duplicate source preparation",
  );
  report.checks.repeated = { replay, historyGeneration: historyBeforeRepeat.generation };
  const repeatedPreview = await poll(
    () =>
      call(
        "preview.get",
        { projectId, revisionId: repeated.revision.id },
        { output: join(out, "repeated-preview.mp4") },
      ),
    (v) => v.state === "ready",
    "repeated source preview",
  );
  let repeatedRows;
  for (const name of await readdir(join(out, "native"))) {
    if (!name.endsWith(".json")) continue;
    const path = join(out, "native", name),
      observed = JSON.parse(await readFile(path, "utf8"));
    if (
      observed.operation === "media.renderCompositionMovie" &&
      observed.request.range.endUs === 9000000
    )
      repeatedRows = (await readFile(path.replace(/\.json$/, "-pointers.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
  }
  const firstUse = repeatedRows.find((r) => r.sampleAtUs === 3000000 && r.status === "picture");
  const repeatedUse = repeatedRows.find((r) => r.sampleAtUs === 7000000 && r.status === "picture");
  assert.equal(firstUse.requestedSourceUs, 1000000);
  assert.equal(repeatedUse.requestedSourceUs, firstUse.requestedSourceUs);
  assert.deepEqual(repeatedUse.overlay, firstUse.overlay);
  report.checks.repeated.preview = {
    status: repeatedPreview,
    firstUse,
    repeatedUse,
    sourceHistorySurvivesBackwardReplay: true,
  };

  const beforeRestart = await evictHistory();
  await service.stop();
  await service.start();
  const afterRestart = await call("frame.get", pictureRequest);
  assert.equal(afterRestart.state, "ready");
  assert.equal((await call("preview.get", selection)).state, "ready");
  assert.equal(
    (await call("index.get", { ...selection, maxLongEdge: 256, limit: 10 })).state,
    "ready",
  );
  assert.equal(history().job.generation, beforeRestart.job.generation);
  report.checks.restart = {
    completedOutputsReadableWithoutHistory: true,
    generation: history().job.generation,
  };
  async function anotherProject(id, media) {
    const p = await call("project.create", { requestId: id, canvas });
    const changed = await call("edit.apply", {
      projectId: p.project.projectId,
      expectedRevisionId: p.revision.id,
      requestId: id,
      operations: [
        { operation: "track.add", label: "track", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "clip",
          clip: {
            ...media,
            trackId: { label: "track" },
            source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "clip" } },
          steps: [{ label: "pointer", processor: { type: "pointer", trailUs: 600000 } }],
        },
      ],
    });
    return {
      projectId: p.project.projectId,
      revisionId: changed.revision.id,
      clipId: changed.edit.labels.clip,
    };
  }
  const doomed = await anotherProject("delete-waiting", source);
  const deletionHit = await service.arm("media.presentationEvidence");
  const pendingDelete = await call("frame.get", {
    projectId: doomed.projectId,
    revisionId: doomed.revisionId,
    atUs: 1000000,
  });
  await deletionHit();
  const deletedParent = await call("job.get", { jobId: pendingDelete.jobId });
  assert.equal(deletedParent.state, "queued");
  await call("project.delete", { projectId: doomed.projectId });
  assert.equal(
    (
      await call(
        "frame.get",
        { projectId: doomed.projectId, revisionId: doomed.revisionId, atUs: 1000000 },
        { error: true },
      )
    ).code,
    "NOT_FOUND",
  );
  // Source preparation belongs to the acquisition, so removing one project does not cancel it.
  const retainedSourceJob = await call("job.get", { jobId: deletedParent.reason });
  assert.equal(retainedSourceJob.state, "running");
  await call("job.cancel", { jobId: retainedSourceJob.jobId });
  report.checks.waitingDeletion = { deletedParent, retainedSourceJob };
  const emptyDonor = join(home, "no-observations");
  await mkdir(emptyDonor);
  await copyFile(join(donor, "video.mov"), join(emptyDonor, "video.mov"));
  await writeFile(
    join(emptyDonor, "capture.journal.jsonl"),
    records
      .filter((r) => r.event !== "cursorSamples")
      .map((r, i) => JSON.stringify({ ...r, sequence: i + 1 }) + "\n")
      .join(""),
  );
  const emptyImport = await call("acquisition.import", {
    requestId: "no-observations",
    path: emptyDonor,
  });
  const emptyJob = await poll(
    () => call("job.get", { jobId: emptyImport.jobId }),
    (v) => v.state === "ready",
    "no-observation import",
  );
  const emptyAcquisition = await call("acquisition.get", {
    acquisitionId: emptyJob.target.acquisitionId,
  });
  const emptyBinding = emptyAcquisition.bindings.find((v) => v.sourceRoles.includes("video"));
  const emptyProject = await anotherProject("no-observations", {
    assetId: emptyBinding.assetId,
    streamId: emptyBinding.streamId,
    acquisitionId: emptyAcquisition.id,
  });
  const emptySelection = { projectId: emptyProject.projectId, revisionId: emptyProject.revisionId };
  const unavailableExportId = randomUUID();
  await call("export.create", {
    ...emptySelection,
    kind: "video",
    exportId: unavailableExportId,
    directory: out,
    leaf: "unavailable.mp4",
  });
  const unavailableExport = await poll(
    () => call("export.status", { exportId: unavailableExportId }),
    (v) => v.state === "unavailable",
    "cold export unavailable prerequisite",
  );
  assert.equal(unavailableExport.retryable, false);
  const unavailable = await poll(
    () => call("frame.get", { ...emptySelection, atUs: 1000000 }),
    (v) => v.state === "unavailable",
    "missing pointer observations",
  );
  assert.equal(unavailable.retryable, false);
  const emptyDry = await picture(emptySelection, 1000000, "missing-observations-dry", {
    target: { kind: "clip", id: emptyProject.clipId },
    point: { kind: "dry" },
  });
  assert.equal(emptyDry.sha256, dry.sha256);
  report.checks.missingObservations = { unavailableExport, unavailable, dry: emptyDry };
  const shiftedEmpty = await call("edit.apply", {
    projectId: emptyProject.projectId,
    expectedRevisionId: emptyProject.revisionId,
    requestId: "inactive-missing-observations",
    operations: [
      { operation: "move", clipIds: [emptyProject.clipId], atUs: 1000000, ripple: "none" },
    ],
  });
  const inactiveEmpty = await picture(
    { projectId: emptyProject.projectId, revisionId: shiftedEmpty.revision.id },
    0,
    "missing-observations-inactive",
    { target: { kind: "clip", id: emptyProject.clipId }, point: { kind: "processed" } },
  );
  assert.equal(
    inactiveEmpty.sha256,
    hash(
      await readFile(
        new URL(
          "../../../specs/done/agent-editing/assets/15-pointer-execution/images/inactive.png",
          import.meta.url,
        ),
      ),
    ),
  );
  report.checks.missingObservations.inactive = inactiveEmpty;
  await call("project.delete", { projectId: emptyProject.projectId });
  const externalHash = hash(await readFile(exported.output));
  await call("project.delete", { projectId });
  await call("project.delete", { projectId });
  const gone = await call("frame.get", pictureRequest, { error: true });
  assert.equal(gone.code, "NOT_FOUND");
  const revoked = await call(
    "artifact.read",
    { token: afterRestart.delivery.token, offset: 0, maxBytes: 1024 },
    { error: true, transport: "mcp" },
  );
  assert.equal(revoked.code, "ARTIFACT_EXPIRED");
  assert.equal(hash(await readFile(exported.output)), externalHash);
  report.checks.deletion = { revoked, externalExportPreserved: true };
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
      await writeFile(join(out, "service.log"), service.logs.join(""));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
