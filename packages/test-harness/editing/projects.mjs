import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
if (process.argv.slice(2).join(" ") !== "--transport both")
  throw new Error("Expected --transport both");
const run = promisify(execFile);
const cli = new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname;
const home = await mkdtemp(join(tmpdir(), "sr-p-"));
let service, mcp;
const trace = [];
async function call(operation, params, expected = true) {
  let output;
  try {
    output = (
      await run(
        process.execPath,
        [cli, operation, "--socket", service.socketPath, "--params", JSON.stringify(params)],
        { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout;
  } catch (error) {
    if (!error.stdout) throw error;
    output = error.stdout;
  }
  const result = JSON.parse(output);
  if (
    operation !== "job.get" ||
    !result.ok ||
    ["ready", "failed", "canceled"].includes(result.data.state)
  )
    trace.push({ operation, params, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
  if (expected === null) return result;
  assert.equal(result.ok, expected, JSON.stringify(result));
  return result.ok ? result.data : result.error;
}
async function connectMcp() {
  mcp = new Client({ name: "yap-project-journey", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
}
try {
  service = await startProjectService({ home });
  const created = await call("project.create", {
    requestId: "create",
    title: "Processing journey",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const request = {
    projectId,
    requestId: "stack",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "group.add", group: { kind: "audio", order: 0 }, label: "group" },
      {
        operation: "track.add",
        track: { kind: "audio", order: 0, parentId: { label: "group" } },
        label: "voice",
      },
      {
        operation: "processing.set",
        target: { kind: "track", id: { label: "voice" } },
        steps: [{ label: "gain", processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  };
  const applied = await call("edit.apply", request);
  await connectMcp();
  const replay = await mcp.callTool({ name: "edit.apply", arguments: request });
  assert.equal(replay.structuredContent.ok, true);
  assert.deepEqual(replay.structuredContent.data, applied);
  const target = { kind: "track", id: applied.edit.labels.voice };
  const observed = await call("processing.get", {
    projectId,
    revisionId: applied.revision.revisionId,
    target,
  });
  assert.deepEqual(observed.steps, [
    { id: applied.edit.labels.gain, enabled: true, processor: { type: "gain", gain: 0.5 } },
  ]);
  const stale = await call("edit.apply", { ...request, requestId: "stale" }, false);
  assert.equal(stale.code, "STALE_REVISION");
  const failed = await call(
    "edit.apply",
    {
      projectId,
      requestId: "rollback",
      expectedRevisionId: applied.revision.revisionId,
      operations: [
        { operation: "canvas.set", canvas: { width: 320 } },
        {
          operation: "processing.set",
          target,
          steps: [{ id: "foreign", processor: { type: "gain", gain: 2 } }],
        },
      ],
    },
    false,
  );
  assert.equal(failed.code, "INVALID_EDIT");
  assert.equal(
    (await call("project.get", { projectId })).currentRevisionId,
    applied.revision.revisionId,
  );
  await mcp.close();
  mcp = undefined;
  await service.close();
  service = await startProjectService({ home });
  assert.deepEqual(await call("edit.apply", request), applied);
  const undone = await call("edit.undo", {
    projectId,
    requestId: "undo",
    expectedRevisionId: applied.revision.revisionId,
  });
  assert.deepEqual(undone.document, created.revision.document);
  assert.notEqual(undone.id, created.revision.revisionId);
  const restored = await call("edit.restore", {
    projectId,
    requestId: "restore",
    expectedRevisionId: undone.id,
    targetRevisionId: applied.revision.revisionId,
  });
  assert.deepEqual(restored.document, applied.revision.document);
  let head = restored.id;
  async function edit(requestId, operations) {
    const result = await call("edit.apply", {
      projectId,
      requestId,
      expectedRevisionId: head,
      operations,
    });
    head = result.revision.revisionId;
    return result;
  }
  async function admit(name) {
    const submitted = await call("asset.import", {
      requestId: name,
      path: new URL(`../../../specs/done/agent-editing/assets/00-corpus/${name}`, import.meta.url)
        .pathname,
    });
    const deadline = performance.now() + 30000;
    for (;;) {
      const job = await call("job.get", { jobId: submitted.jobId });
      if (job.state === "ready")
        return call("asset.get", { assetId: job.published.output.assetId });
      assert.ok(["queued", "running"].includes(job.state), JSON.stringify(job));
      assert.ok(performance.now() < deadline, "Asset admission did not finish");
      await delay(20);
    }
  }
  const a = await admit("a-audio.wav"),
    b = await admit("b-audio.wav"),
    video = await admit("a.mov");
  const audioA = a.streams.find((stream) => stream.kind === "audio" && stream.decodable);
  const audioB = b.streams.find((stream) => stream.kind === "audio" && stream.decodable);
  const picture = video.streams.find((stream) => stream.kind === "video" && stream.decodable);
  assert.ok(audioA && audioB && picture);
  const rejectedMedia = await call(
    "edit.apply",
    {
      projectId,
      requestId: "prepared-then-rejected",
      expectedRevisionId: head,
      operations: [
        {
          operation: "place",
          clip: {
            trackId: target.id,
            assetId: a.id,
            streamId: audioA.id,
            source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
        {
          operation: "processing.set",
          target,
          steps: [{ id: "foreign", processor: { type: "gain", gain: 2 } }],
        },
      ],
    },
    false,
  );
  assert.equal(rejectedMedia.code, "INVALID_EDIT");
  assert.equal((await call("project.get", { projectId })).currentRevisionId, head);
  assert.deepEqual(
    (await call("revision.get", { projectId })).revision.document,
    restored.document,
  );
  assert.deepEqual(await call("asset.get", { assetId: a.id }), a);
  const placed = await edit("place", [
    { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
    {
      operation: "place",
      label: "audio",
      clip: {
        trackId: applied.edit.labels.voice,
        assetId: a.id,
        streamId: audioA.id,
        source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
      },
    },
    {
      operation: "place",
      label: "video",
      clip: {
        trackId: { label: "picture" },
        assetId: video.id,
        streamId: picture.id,
        source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
      },
    },
    { operation: "link", clipIds: [{ label: "audio" }, { label: "video" }] },
  ]);
  const audioTarget = { kind: "clip", id: placed.edit.labels.audio };
  assert.deepEqual(
    (await call("processing.get", { projectId, revisionId: head, target: audioTarget })).steps,
    [],
  );
  const configured = await edit("all-scopes", [
    {
      operation: "processing.set",
      target: audioTarget,
      steps: [
        { label: "first", processor: { type: "gain", gain: 0.8 } },
        { label: "second", processor: { type: "gain", gain: 1.2 } },
      ],
    },
    {
      operation: "processing.set",
      target: { kind: "group", id: applied.edit.labels.group },
      steps: [{ processor: { type: "gain", gain: 0.75 } }],
    },
    {
      operation: "processing.set",
      target: { kind: "output" },
      steps: [{ processor: { type: "gain", gain: 1.25 } }],
    },
  ]);
  for (const [scope, gain] of [
    [{ kind: "group", id: applied.edit.labels.group }, 0.75],
    [{ kind: "output" }, 1.25],
  ]) {
    const stack = await call("processing.get", {
      projectId,
      revisionId: configured.revision.revisionId,
      target: scope,
    });
    assert.deepEqual(
      stack.steps.map(({ enabled, processor }) => ({ enabled, processor })),
      [{ enabled: true, processor: { type: "gain", gain } }],
    );
  }
  const reversed = [
    { id: configured.edit.labels.second, enabled: false, processor: { type: "gain", gain: 1.2 } },
    { id: configured.edit.labels.first, enabled: true, processor: { type: "gain", gain: 0.8 } },
  ];
  await edit("reorder-bypass", [
    { operation: "processing.set", target: audioTarget, steps: reversed },
  ]);
  assert.deepEqual(
    (await call("processing.get", { projectId, revisionId: head, target: audioTarget })).steps,
    reversed,
  );
  const split = await edit("split", [
    {
      operation: "split",
      clipIds: [placed.edit.labels.audio],
      atUs: 1000000,
      rightLabels: [
        { clipId: placed.edit.labels.audio, label: "rightAudio" },
        { clipId: placed.edit.labels.video, label: "rightVideo" },
      ],
    },
  ]);
  const right = { kind: "clip", id: split.edit.labels.rightAudio };
  const rightSteps = (await call("processing.get", { projectId, revisionId: head, target: right }))
    .steps;
  assert.deepEqual(
    rightSteps.map(({ enabled, processor }) => ({ enabled, processor })),
    reversed.map(({ enabled, processor }) => ({ enabled, processor })),
  );
  assert.notDeepEqual(
    rightSteps.map((step) => step.id),
    reversed.map((step) => step.id),
  );
  const replaced = await edit("replace-audio", [
    {
      operation: "replace",
      clipId: right.id,
      kind: "audio",
      media: {
        assetId: b.id,
        streamId: audioB.id,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      },
    },
  ]);
  const replacedAudio = replaced.revision.document.clips.find((clip) => clip.id === right.id);
  assert.equal(replacedAudio.assetId, b.id);
  assert.equal(replacedAudio.streamId, audioB.id);
  assert.deepEqual(replacedAudio.source, {
    kind: "range",
    range: { startUs: 0, endUs: 1000000 },
  });
  assert.deepEqual(
    replaced.revision.document.clips.find((clip) => clip.id === split.edit.labels.rightVideo),
    split.revision.document.clips.find((clip) => clip.id === split.edit.labels.rightVideo),
  );
  assert.deepEqual(
    (await call("processing.get", { projectId, revisionId: head, target: right })).steps,
    rightSteps,
  );
  await edit("reset", [
    {
      operation: "replace",
      clipId: right.id,
      kind: "audio",
      processing: "reset",
      media: {
        assetId: b.id,
        streamId: audioB.id,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      },
    },
  ]);
  assert.deepEqual(
    (await call("processing.get", { projectId, revisionId: head, target: right })).steps,
    [],
  );
  assert.deepEqual(
    (await call("processing.get", { projectId, revisionId: applied.revision.revisionId, target }))
      .steps,
    observed.steps,
  );
  const beforeNoop = await call("revision.history", { projectId });
  const noopRequest = {
    projectId,
    requestId: "noop-receipt",
    expectedRevisionId: head,
    operations: [],
  };
  const noop = await call("edit.apply", noopRequest);
  assert.equal(noop.revision.revisionId, head);
  assert.equal(noop.edit.changed, false);
  assert.deepEqual(await call("revision.history", { projectId }), beforeNoop);
  const conflict = await call(
    "edit.apply",
    { ...noopRequest, operations: [{ operation: "canvas.set", canvas: { width: 320 } }] },
    false,
  );
  assert.equal(conflict.code, "REQUEST_CONFLICT");
  assert.equal((await call("project.get", { projectId })).currentRevisionId, head);
  const firstPage = await call("revision.history", { projectId, limit: 1 });
  assert.deepEqual(firstPage.revisions, beforeNoop.revisions.slice(0, 1));
  const candidates = [320, 480];
  const contenders = await Promise.all(
    candidates.map((width) =>
      call(
        "edit.apply",
        {
          projectId,
          requestId: `concurrent-${width}`,
          expectedRevisionId: head,
          operations: [{ operation: "canvas.set", canvas: { width } }],
        },
        null,
      ),
    ),
  );
  const winner = contenders.findIndex((result) => result.ok);
  assert.notEqual(winner, -1);
  assert.equal(contenders[1 - winner].ok, false);
  assert.equal(contenders[1 - winner].error.code, "STALE_REVISION");
  assert.equal(contenders[winner].data.revision.document.canvas.width, candidates[winner]);
  head = contenders[winner].data.revision.revisionId;
  assert.equal((await call("project.get", { projectId })).currentRevisionId, head);
  const rest = await call("revision.history", { projectId, cursor: firstPage.nextCursor });
  assert.deepEqual(rest.revisions, beforeNoop.revisions.slice(1));
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(await call("edit.apply", noopRequest), noop);
  assert.equal((await call("project.get", { projectId })).currentRevisionId, head);
  const capabilities = await call("processing.capabilities", {});
  assert.equal(capabilities.find((c) => c.type === "gain").execution, true);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        transport: "CLI and MCP",
        service: "real isolated service",
        scenarios: [
          "create managed project",
          "nested target stack set/get",
          "cross-transport complete replay",
          "stale edit rejection",
          "late-operation rollback",
          "restart replay",
          "undo/restore",
          "native admission of real fixture media",
          "prepared media survives a rejected edit without project mutation",
          "all four processing scopes",
          "new clip has no inherited settings",
          "ordered repeated steps and bypass",
          "linked split with independent processing IDs",
          "audio replacement preserves video and processing",
          "explicit processing reset",
          "historical stack read",
          "no-op receipt preserves history and changed arguments conflict",
          "concurrent CLI writers admit exactly one edit",
          "history pages remain pinned across new edits",
          "no-op replay returns original receipt after head changes",
        ],
        trace,
        liveStateJourney: true,
        liveMediaJourney: false,
      },
      null,
      2,
    ),
  );
} finally {
  await mcp?.close();
  await service?.close();
  await rm(home, { recursive: true, force: true });
}
