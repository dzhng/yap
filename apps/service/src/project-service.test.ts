import {
  projectServiceFixture,
  projectServiceControlFixture,
  probeFileFixture,
} from "./project-service.fixture.js";
import { JobQueue } from "@yap/core/jobs";
import { Models } from "@yap/core/models";
import { VoiceGenerationJobs } from "@yap/core/voice-generation";
import { voiceProfile } from "@yap/core/voice-profile";
import { createHash, randomUUID } from "node:crypto";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { ProjectStore } from "@yap/core/projects";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { ResourceReferences } from "@yap/core/references";
import {
  mkdtemp,
  writeFile,
  rm,
  readdir,
  readFile,
  mkdir,
  stat,
  realpath,
  chmod,
  appendFile,
} from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { fstatSync } from "node:fs";
import { AssetStore } from "@yap/core/assets";
import { Catalog } from "@yap/core/catalog";
import { callLocal } from "@yap/client";
import { startProjectService } from "./project-service.js";
import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  CONTROL_FRAME_BYTES,
  appOperations,
  modelStatusSchema,
  updatePreparationSchema,
} from "@yap/protocol";
import { controlledSpeech, modelMetadata } from "./transcript.fixture.js";
import { sourceWorker, captureFixture } from "./project-capture.fixture.js";
import { mediaWorker, type MediaWorker } from "./worker.js";
const { writeNativeCaptureFixture } = await import(
  new URL("../../../packages/core/src/capture-native.fixture.ts", import.meta.url).href
);
const it = test.runIf(Boolean(process.env.YAP_NATIVE));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("recording.get without an id resolves the latest take and removed recording.latest is unknown", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }));
  expect(await f.call("recording.get", {})).toMatchObject({
    ok: false,
    error: { code: "NOT_READY", retryable: true, retryAfterMs: 15000 },
  });
  const older = f.service.captures.allocate({ requestId: "older", arguments: "{}" }).recording;
  const latest = f.service.captures.allocate({ requestId: "latest", arguments: "{}" }).recording;
  expect(await f.call("recording.latest", {})).toMatchObject({
    ok: false,
    error: { code: "UNKNOWN_OPERATION" },
  });
  expect(await f.call("recording.get", {})).toMatchObject({
    ok: true,
    data: { id: latest.id },
  });
  expect(latest.id).not.toBe(older.id);
});

test("recording.prompt hands off projects and imports by their own ID", async () => {
  const f = await projectServiceFixture(cleanups, async (operation) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              { id: "image", kind: "image", codec: "png", decodable: true, width: 1, height: 1 },
            ],
          },
        }
      : { ok: true, data: {} },
  );
  const created = await f.call("project.create", {
    requestId: "prompt-project",
    title: "Prompt project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  expect(await f.call("recording.prompt", { projectId })).toMatchObject({
    ok: true,
    data: {
      text: `I want you to use this project with this ID with the Yap CLI: ${projectId}`,
      facts: { projectId },
    },
  });
  const imported = await f.call("asset.import", { requestId: "prompt-import", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const assetId = ready.published!.output.assetId;
  expect(await f.call("recording.prompt", { assetId })).toMatchObject({
    ok: true,
    data: {
      text: `I want you to use this imported video with this asset ID with the Yap CLI: ${assetId}`,
      facts: { assetId },
    },
  });
  expect(await f.call("recording.prompt", { projectId: assetId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("recording.prompt describes the latest unpublished take without waiting", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }));
  expect(await f.call("recording.prompt", {})).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  f.service.captures.allocate({ requestId: "prompt-older", arguments: "{}" });
  const latest = f.service.captures.allocate({
    requestId: "prompt-latest",
    arguments: "{}",
  }).recording;
  for (const params of [{}, { recordingId: latest.id }])
    expect(await f.call("recording.prompt", params)).toMatchObject({
      ok: true,
      data: { facts: { recordingId: latest.id, live: true } },
    });
});

it("finished-take reads return a timed NOT_READY while the acquisition is importing", async () => {
  const f = await captureFixture(cleanups, undefined, mediaWorker());
  const take = f.service.captures.allocate().recording;
  const directory = join(f.home, "source");
  const publication = writeNativeCaptureFixture(directory, {
    kind: "display",
    recordingId: take.id,
    sourceId: take.sourceId,
  });
  f.service.captures.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    state: "finalizing",
    sequence: 1,
    publication,
  });
  const acquisitions = new AcquisitionStore(f.service.captures);
  const { acquisitionId } = acquisitions.admitCapture(f.service.captures, take.id, directory);
  const imported = await f.call("asset.import", {
    path: join(directory, "video.mov"),
    requestId: "pending-selector",
  });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  let assetId: string;
  await expect
    .poll(async () => {
      const result = await f.call("job.get", {
        jobId: (imported.data as { jobId: string }).jobId,
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const job = result.data as {
        state: string;
        published: { output: { assetId: string } } | null;
      };
      if (job.published) assetId = job.published.output.assetId;
      return job.state;
    })
    .toBe("ready");
  const asset = f.service.assets.get(assetId!);
  const streamId = asset.streams.find((stream) => stream.kind === "video")!.id;
  for (const request of [
    { operation: "acquisition.get", params: { acquisitionId } },
    { operation: "timeline.events", params: { acquisitionId, assetId: asset.id, streamId } },
  ]) {
    expect(await f.call(request.operation, request.params)).toMatchObject({
      ok: false,
      error: {
        code: "NOT_READY",
        retryable: true,
        retryAfterMs: 15000,
        message: expect.stringMatching(/importing.*Retry in 15 seconds\./),
        details: { retry: request },
      },
    });
  }
});

it.each([false, true])(
  "recording.prompt succeeds during import and after a failed import without retrying it (mic=%s)",
  async (microphone) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = mediaWorker();
    const f = await captureFixture(
      cleanups,
      undefined,
      async (operation, params, options) => {
        if (operation === "media.sourceEvidence") await held;
        return native(operation, params, options);
      },
      undefined,
      undefined,
      true,
    );
    cleanups.push(async () => {
      release();
    });
    const started = await f.call("capture.start", {
      requestId: "prompt-import-fails",
      source: { kind: "display", id: 1 },
      microphone,
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const { id: recordingId, sourceId } = started.data as { id: string; sourceId: string };
    const directory = join(f.home, "library", "recordings", recordingId, "source");
    const publication = writeNativeCaptureFixture(directory, {
      kind: "display",
      mic: microphone,
      recordingId,
      sourceId,
    });
    await f.call("capture.stop", { recordingId });
    const reported = await f.report(
      {
        recordingId,
        sourceId,
        sequence: 3,
        state: "complete",
        sourceDurationUs: 190_000_000,
        publication,
      },
      true,
    );
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const admission = reported.data as { sourceAdmissions: { job: { id: string } }[] };
    const take = { recordingId, job: { id: admission.sourceAdmissions[0]!.job.id } };
    const expected = [
      microphone
        ? "I recorded my screen to show you something. Watch it with Yap and act on what I asked for."
        : "I recorded my screen without narration. Watch what happens with Yap.",
      `Recording: ${take.recordingId} (3:10, screen, ${microphone ? "microphone, no camera" : "no camera, no microphone"}, no system audio).`,
      "Use the yap skill to work with this recording (or run `yap --help`).",
    ].join("\n");
    expect(await f.call("recording.prompt", { recordingId: take.recordingId })).toMatchObject({
      ok: true,
      data: {
        text: microphone
          ? expected.replace(
              "Use the yap skill",
              "The transcript is being prepared automatically.\nUse the yap skill",
            )
          : expected,
      },
    });
    await appendFile(join(directory, "video.mov"), "changed after publication");
    release();
    await expect
      .poll(async () => {
        const result = await f.call("job.get", { jobId: take.job.id });
        return result.ok ? (result.data as { state: string }).state : null;
      })
      .toBe("failed");
    expect(await f.call("recording.prompt")).toMatchObject({ ok: true, data: { text: expected } });
    expect(await f.call("job.get", { jobId: take.job.id })).toMatchObject({
      ok: true,
      data: { state: "failed", attemptGeneration: 1 },
    });
  },
);

test("project.duplicate copies a revision, replays, and survives source deletion", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }));
  const canvas = {
    width: 16,
    height: 16,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const created = await f.call("project.create", {
    requestId: "duplicate-source",
    title: "Source",
    canvas,
  });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const source = created.data as {
    project: { id: string };
    revision: { id: string; document: unknown };
  };
  const duplicated = await f.call("project.duplicate", {
    requestId: "duplicate-project",
    projectId: source.project.id,
  });
  expect(duplicated).toMatchObject({
    ok: true,
    data: { project: { title: "Source copy" }, revision: { document: source.revision.document } },
  });
  if (!duplicated.ok) throw new Error(JSON.stringify(duplicated));
  const copy = duplicated.data as {
    project: { id: string };
    revision: { id: string };
  };
  expect(
    await f.call("project.duplicate", {
      requestId: "duplicate-project",
      projectId: source.project.id,
    }),
  ).toEqual(duplicated);
  expect(
    await f.call("project.duplicate", {
      requestId: "duplicate-project",
      projectId: source.project.id,
      title: "Different",
    }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  expect(await f.call("revision.history", { projectId: copy.project.id })).toMatchObject({
    ok: true,
    data: { revisions: [{ id: copy.revision.id, ordinal: 0 }], nextCursor: null },
  });
  expect(
    await f.call("project.delete", {
      requestId: "delete-duplicate-source",
      projectId: source.project.id,
    }),
  ).toMatchObject({ ok: true, data: { id: source.project.id, deleted: true } });
  expect(await f.call("revision.get", { projectId: copy.project.id })).toMatchObject({
    ok: true,
    data: { projectId: copy.project.id, revision: { id: copy.revision.id } },
  });
  expect(await f.call("inspect.open", { projectId: copy.project.id })).toMatchObject({
    ok: true,
    data: { projectId: copy.project.id, revision: { id: copy.revision.id } },
  });
  expect(f.service.libraryUsers!.usersOf({ kind: "project", id: copy.project.id })).toMatchObject({
    usedBy: [],
  });
});

test("asset.list rows name themselves id and carry sizeBytes, not bytes", async () => {
  const f = await projectServiceFixture(cleanups, async (operation) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              { id: "image", kind: "image", codec: "png", decodable: true, width: 1, height: 1 },
            ],
          },
        }
      : { ok: true, data: {} },
  );
  const imported = await f.call("asset.import", { requestId: "asset-list-contract", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  await f.job((imported.data as { jobId: string }).jobId, "ready");
  const listed = await f.call("asset.list", {});
  expect(listed).toMatchObject({ ok: true, data: { assets: expect.any(Array) } });
  if (listed.ok) {
    const row = (listed.data as { assets: Record<string, unknown>[] }).assets[0]!;
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("sizeBytes");
    expect(row).not.toHaveProperty("bytes");
  }
});

test("media.list exposes imported titles and measured fields", async () => {
  const f = await projectServiceFixture(cleanups, async (operation) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              { id: "image", kind: "image", codec: "png", decodable: true, width: 1, height: 1 },
            ],
          },
        }
      : { ok: true, data: {} },
  );
  const imported = await f.call("asset.import", { requestId: "media-list-import", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  await f.job((imported.data as { jobId: string }).jobId, "ready");
  const listed = await f.call("media.list", { limit: 10 });
  expect(listed).toMatchObject({ ok: true, data: { media: expect.any(Array), nextCursor: null } });
  if (!listed.ok) return;
  const media = (listed.data as { media: Record<string, unknown>[] }).media;
  expect(media).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "asset",
        title: "source.png",
        durationUs: 0,
        sizeBytes: 11,
      }),
    ]),
  );
  expect(media.every((row) => typeof row.id === "string" && !("bytes" in row))).toBe(true);
});

test("media.list sizeBytes uses the same measured bytes as deletion", async () => {
  const f = await projectServiceFixture(cleanups, async (operation, _params, options) => {
    if (operation === "storage.recordingDirectory") {
      const info = fstatSync(options!.descriptors![0]!, { bigint: true });
      return { ok: true, data: { dev: String(info.dev), ino: String(info.ino) } };
    }
    if (operation === "storage.removeRecordingDirectory")
      return { ok: true, data: { removed: true } };
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [
            { id: "image", kind: "image", codec: "png", decodable: true, width: 1, height: 1 },
          ],
        },
      };
    return { ok: true, data: {} };
  });
  const imported = await f.call("asset.import", { requestId: "media-size-import", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const assetId = ready.published!.output.assetId;
  await chmod(f.service.assets.path(assetId), 0o600);
  await writeFile(f.service.assets.path(assetId), "asset bytes changed on disk");

  const recording = f.service.captures.allocate({
    requestId: "media-size-recording",
    arguments: "{}",
  }).recording;
  f.service.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "recording",
  });
  f.service.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 2,
    state: "finalizing",
  });
  f.service.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 3,
    state: "complete",
    sourceDurationUs: 1,
  });
  const recordingPath = join(f.home, "library", "recordings", recording.id, "source");
  await mkdir(recordingPath, { recursive: true, mode: 0o700 });
  await writeFile(join(recordingPath, "measured.bin"), "recording bytes on disk");

  const assetMeasured = f.service.libraryUsers!.usersOf({ kind: "asset", id: assetId }).freesBytes;
  const recordingMeasured = f.service.libraryUsers!.usersOf({
    kind: "recording",
    id: recording.id,
  }).freesBytes;
  const listed = await f.call("media.list", { limit: 100 });
  if (!listed.ok) throw new Error(JSON.stringify(listed));
  const media = (
    listed.data as {
      media: { kind: string; id: string; sizeBytes: number }[];
    }
  ).media;
  expect(media.find((row) => row.id === assetId)?.sizeBytes).toBe(assetMeasured);
  expect(media.find((row) => row.id === recording.id)?.sizeBytes).toBe(recordingMeasured);

  const assetDeleted = await f.call("asset.delete", {
    requestId: "media-size-delete-asset",
    assetId,
  });
  expect(assetDeleted).toMatchObject({ ok: true, data: { freedBytes: assetMeasured } });
  const recordingDeleted = await f.call("recording.delete", {
    requestId: "media-size-delete-recording",
    recordingId: recording.id,
  });
  if (!recordingDeleted.ok) throw new Error(JSON.stringify(recordingDeleted));
  expect(recordingDeleted).toMatchObject({ ok: true, data: { freedBytes: recordingMeasured } });
});

test("export.create replays by requestId and refuses a conflicting request", async () => {
  const f = await projectServiceFixture(cleanups, async (operation, _params, options) => {
    if (operation === "storage.externalDirectory") {
      const info = (await import("node:fs")).fstatSync(options!.descriptors![0]!, { bigint: true });
      return { ok: true, data: { dev: String(info.dev), ino: String(info.ino) } };
    }
    if (operation === "publication.inspect") return { ok: true, data: { file: null } };
    return { ok: true, data: {} };
  });
  const created = await f.call("project.create", {
    requestId: "export-replay-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  const request = {
    requestId: "export-replay",
    projectId,
    kind: "processed-package",
    directory: f.home,
    leaf: "replay.zip",
  };
  const first = await f.call("export.create", request);
  if (!first.ok) throw new Error(JSON.stringify(first));
  expect(first).toMatchObject({ ok: true });
  const replay = await f.call("export.create", request);
  expect(replay).toMatchObject({
    ok: true,
    data: { id: (first.data as { id: string }).id },
  });
  expect(await f.call("export.create", { ...request, leaf: "different.zip" })).toMatchObject({
    ok: false,
    error: { code: "REQUEST_CONFLICT" },
  });
});

test("export.recover replays by requestId and refuses a different export", async () => {
  const f = await projectServiceFixture(cleanups, async (operation, _params, options) => {
    if (operation === "storage.externalDirectory") {
      const info = (await import("node:fs")).fstatSync(options!.descriptors![0]!, { bigint: true });
      return { ok: true, data: { dev: String(info.dev), ino: String(info.ino) } };
    }
    if (operation === "publication.inspect") return { ok: true, data: { file: null } };
    return { ok: true, data: {} };
  });
  const created = await f.call("project.create", {
    requestId: "recover-replay-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  const exported = await f.call("export.create", {
    requestId: "recover-replay-export",
    projectId,
    kind: "processed-package",
    directory: f.home,
    leaf: "recover-replay.zip",
  });
  if (!exported.ok) throw new Error(JSON.stringify(exported));
  const exportId = (exported.data as { id: string }).id;
  const request = { requestId: "recover-replay", exportId };
  const first = await f.call("export.recover", request);
  expect(first).toMatchObject({ ok: true, data: { id: exportId } });
  expect(await f.call("export.recover", request)).toEqual(first);
  expect(await f.call("export.recover", { ...request, exportId: "other-export" })).toMatchObject({
    ok: false,
    error: { code: "REQUEST_CONFLICT" },
  });
});
const metadata = {
  originUs: 0,
  streams: [
    {
      id: "image:0",
      kind: "image",
      codec: "public.png",
      decodable: true,
      width: 2,
      height: 1,
      orientedWidth: 2,
      orientedHeight: 1,
      orientation: 1,
    },
  ],
};
const setup = projectServiceFixture.bind(undefined, cleanups);

test("wired LibraryUsers reports the project bytes that real project deletion removes", async () => {
  let home = "";
  const f = await setup(async (operation, params) => {
    if (operation === "storage.clearRenderWorkspace") return { ok: true, data: { removed: true } };
    if (operation === "storage.removeCacheFiles") {
      for (const id of params.ids as string[])
        await rm(join(home, "library/cache/derived", `${id}.cache`), { force: true });
      return { ok: true, data: { removed: true } };
    }
    return { ok: true, data: {} };
  });
  home = f.home;
  const created = await f.call("project.create", {
    requestId: "users-project",
    canvas: {
      width: 64,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const catalog = new Catalog(join(home, "library/catalog.sqlite"));
  const cacheId = randomUUID();
  try {
    catalog.catalog
      .prepare("INSERT INTO acquisitions(id,requestId,admission,metadata) VALUES(?,?,?,?)")
      .run(
        "acquisition-capture",
        "capture-request",
        JSON.stringify({ kind: "capture", recordingId: "recording-1" }),
        "{}",
      );
    catalog.catalog
      .prepare("INSERT INTO resource_references VALUES(?,?,?,?)")
      .run("acquisition", "acquisition-capture", "revision", revision.id);
    catalog.catalog
      .prepare(
        "INSERT INTO derived_cache(id,ownerKind,ownerId,touched,bytes) VALUES (?,'project',?,1,?)",
      )
      .run(cacheId, project.id, 1);
  } finally {
    catalog.close();
  }
  const cachePath = join(home, "library/cache/derived", `${cacheId}.cache`);
  await writeFile(cachePath, "cached render");
  const before = Number((await stat(cachePath)).size);
  const details = f.service.libraryUsers!.usersOf({ kind: "recording", id: "recording-1" });
  expect(details.usedBy).toEqual([
    { kind: "project", id: project.id, title: "Untitled", revisions: 1 },
  ]);
  expect(details.cascadeFreesBytes).toBe(before);
  const totalBefore = Number((await stat(cachePath)).size);
  const deleted = await f.call("project.delete", {
    requestId: "test-delete",
    projectId: project.id,
  });
  expect(deleted).toMatchObject({
    ok: true,
    data: { id: project.id, deleted: true },
  });
  if (deleted.ok) expect((deleted.data as { freedBytes: number }).freedBytes).toBe(totalBefore);
  expect(
    await f.call("project.delete", { requestId: "test-delete", projectId: project.id }),
  ).toEqual(deleted);
  expect(
    await f.call("project.delete", { requestId: "test-delete", projectId: "different-project" }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  await expect(stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(totalBefore).toBe(before);
});

test("correspondence receipts are admitted and paged without declaring an edit", async () => {
  const f = await setup(async () => ({ ok: true, data: {} }));
  const endpoint = (assetId: string) => ({
    kind: "source",
    assetId,
    streamId: "audio-1",
    channel: 0,
    sourceRange: { startUs: 0, endUs: 4_000_000 },
  });
  const measurement = {
    verdict: "accepted",
    reason: "known delay control",
    anchors: [
      {
        leftRange: { startUs: 0, endUs: 1_000_000 },
        rightRange: { startUs: 120_000, endUs: 1_120_000 },
        candidates: [
          {
            offsetUs: 120_000,
            residualUs: 1000,
            coverage: 1,
            driftPpm: 0,
            score: 0.9,
            selected: true,
          },
        ],
        selected: 0,
      },
    ],
    candidates: [
      { offsetUs: 120_000, residualUs: 1000, coverage: 1, driftPpm: 0, score: 0.9, selected: true },
    ],
    offsetUs: 120_000,
    residualUs: 1000,
    coverage: 1,
    driftPpm: 0,
    policy: {
      minimumCoverage: 0.8,
      maximumResidualUs: 10_000,
      maximumDriftPpm: 20,
      minimumAnchors: 1,
    },
  };
  const prepared = await f.call("correspondence.prepare", {
    evidenceId: "e1",
    generation: "g1",
    left: endpoint("a"),
    right: endpoint("b"),
    measurement,
  });
  expect(prepared).toMatchObject({
    ok: true,
    data: { state: "ready", published: { output: { id: "e1" } } },
  });
  expect(
    await f.call("correspondence.get", { evidenceId: "e1", generation: "g1", limit: 1 }),
  ).toMatchObject({
    ok: true,
    data: { verdict: "accepted", measurement: { anchors: [{ selected: 0 }] } },
  });
});

test("the service leaves the app's own operations to the app", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  const forwarded: string[] = [];
  f.events.on("call", ({ request }) => forwarded.push(request.operation));
  for (const operation of appOperations) {
    const params = operation.endsWith("setEnabled") ? { enabled: true } : {};
    const answer = await f.call(operation, params);
    expect(answer).toMatchObject({ ok: false, error: { code: "UNKNOWN_OPERATION" } });
    expect(answer.ok === false && answer.error.message).toContain("answered by the app");
  }
  expect(forwarded).toEqual([]);
});

test("prepared admission fences product work until the permit is released", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  f.events.on("call", ({ request }) => {
    f.input.write(
      JSON.stringify({
        event: "result",
        response: { id: request.id, ok: true, data: { enabled: false } },
      }) + "\n",
    );
  });
  let permitId: string | undefined;
  await expect
    .poll(async () => {
      const result = await f.control("update.prepare");
      if (result.ok) {
        const parsed = updatePreparationSchema.parse(result.data);
        if (parsed.kind === "prepared") permitId = parsed.permitId;
      }
      return permitId;
    })
    .toBeDefined();
  expect(await f.call("capture.sources", {})).toMatchObject({
    ok: false,
    error: { code: "UPDATING" },
  });
  expect(await f.control("update.release", { permitId })).toMatchObject({ ok: true });
});

test("health projects strict native update reports without exposing private coordination on the socket", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  expect(
    await f.control("update.report", {
      update: {
        state: "queued",
        availableVersion: "2.0.0",
        availability: "available",
        blockers: ["native.preview"],
        error: null,
        extra: true,
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  const update = {
    state: "queued",
    jobId: null,
    availability: "available",
    availableVersion: "2.0.0",
    blockers: ["native.preview"],
    error: null,
  };
  expect(await f.control("update.report", { update })).toMatchObject({ ok: true });
  expect(await f.control("service.health")).toMatchObject({
    ok: true,
    data: { version: null, update },
  });
  expect(await f.call("update.report", { update })).toMatchObject({
    ok: false,
    error: { code: "UNKNOWN_OPERATION" },
  });
  expect(await f.control("update.prepare", { force: true })).toMatchObject({
    ok: false,
    error: { code: "INVALID_PARAMS" },
  });
});

test("health identifies the running release only when its runtime owner supplies a version", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }), undefined, {
    version: "2.0.0-fixture",
  });
  expect(await f.call("service.health", {})).toMatchObject({
    ok: true,
    data: {
      version: "2.0.0-fixture",
      update: { state: "unavailable", availableVersion: null, blockers: [], error: null },
    },
  });
});

test("lifetime progress coalesces in one event turn and stops when the candidate is discarded", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  let notifications = 0;
  f.events.on("update.progress", () => {
    notifications += 1;
  });
  await f.control("update.report", {
    update: {
      state: "queued",
      jobId: null,
      availability: "available",
      availableVersion: "2.0.0",
      blockers: ["native.preview"],
      error: null,
    },
  });
  const progress = once(f.events, "update.progress");
  await Promise.all([
    f.control("project.list"),
    f.control("recording.list"),
    f.control("service.health"),
  ]);
  await progress;
  await new Promise((resolve) => setImmediate(resolve));
  expect(notifications).toBe(1);
  await f.control("update.report", {
    update: {
      state: "unavailable",
      jobId: null,
      availability: "unavailable",
      availableVersion: null,
      blockers: [],
      error: null,
    },
  });
  await Promise.all([f.control("project.list"), f.control("service.health")]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(notifications).toBe(1);
});

test.each(["correlated", "uncorrelated"])(
  "the %s control reply remains owned until the output write completes",
  async (kind) => {
    const input = new PassThrough(),
      events = new EventEmitter();
    let release = () => {};
    const output = new Writable({
      write(bytes, _encoding, done) {
        const message = JSON.parse(bytes.toString());
        if (
          message.event === "result" &&
          message.response.id === (kind === "correlated" ? "held" : null)
        ) {
          release = () => {
            release = () => {};
            done();
          };
          events.emit("held");
        } else {
          if (message.event === "result") events.emit(message.response.id, message.response);
          done();
        }
      },
    });
    const f = await projectServiceFixture(
      cleanups,
      async () => ({ ok: true, data: {} }),
      undefined,
      {
        control: { input, output },
      },
    );
    cleanups.push(async () => release());
    const held = once(events, "held");
    const request = {
      event: "request",
      request: { id: "held", operation: "service.health", params: {} },
    };
    if (kind === "uncorrelated") {
      request.request.id = "";
      request.request.id = "i".repeat(
        CONTROL_FRAME_BYTES - Buffer.byteLength(JSON.stringify(request) + "\n"),
      );
    }
    input.write(JSON.stringify(request) + "\n");
    await held;
    const answered = once(events, "prepare");
    input.write(
      JSON.stringify({
        event: "request",
        request: { id: "prepare", operation: "update.prepare", params: {} },
      }) + "\n",
    );
    await new Promise((resolve) => setImmediate(resolve));
    // The private reply is buffered behind the product reply, but waiting has already reopened admission.
    expect(await f.call("project.list", {})).toMatchObject({ ok: true });
    release();
    expect((await answered)[0]).toMatchObject({
      ok: true,
      data: { kind: "blocked", blockers: ["transport"] },
    });
  },
);

test("a synchronous control write failure releases its transport obligation", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    events = new EventEmitter();
  const write = output.write.bind(output);
  vi.spyOn(output, "write").mockImplementation((...args) => {
    const message = JSON.parse(String(args[0]));
    if (message.event === "result" && message.response.id === "lost") {
      events.emit("lost");
      throw Error("Fixture output refused synchronously");
    }
    return write(...args);
  });
  output.on("data", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.event === "result") events.emit(message.response.id, message.response);
  });
  await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }), undefined, {
    control: { input, output },
  });
  const lost = once(events, "lost");
  input.write(
    JSON.stringify({
      event: "request",
      request: { id: "lost", operation: "project.list", params: {} },
    }) + "\n",
  );
  await lost;
  await new Promise((resolve) => setImmediate(resolve));
  const prepared = once(events, "prepare");
  input.write(
    JSON.stringify({
      event: "request",
      request: { id: "prepare", operation: "update.prepare", params: {} },
    }) + "\n",
  );
  expect((await prepared)[0]).toMatchObject({ ok: true, data: { kind: "prepared" } });
});

test("a failed owner observation releases its tentative fence before answering", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    // A temporarily unavailable fixture table makes the real owner snapshot fail at its SQL boundary.
    catalog.catalog.exec("ALTER TABLE jobs RENAME TO unavailable_jobs");
    try {
      expect(await f.control("update.prepare")).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      });
      expect(await f.control("service.health")).toMatchObject({ ok: true });
    } finally {
      catalog.catalog.exec("ALTER TABLE unavailable_jobs RENAME TO jobs");
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(await f.control("update.prepare")).toMatchObject({
      ok: true,
      data: { kind: "prepared" },
    });
  } finally {
    catalog.close();
  }
});

test("complete socket frames racing a private fence either commit owned work or receive UPDATING", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  const [permit, creation] = await Promise.all([
    f.control("update.prepare"),
    callLocal(f.service.socketPath, {
      id: "racing-creation",
      operation: "project.create",
      params: {
        requestId: "racing",
        canvas: {
          width: 64,
          height: 32,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
      },
      resultDelivery: { inlineBytes: 64 * 1024 },
    }),
  ]);
  if (!permit.ok) throw new Error(JSON.stringify(permit));
  const admission = permit.data as { kind: string; permitId?: string; blockers?: string[] };
  if (admission.kind === "prepared") {
    expect(creation).toMatchObject({
      id: "racing-creation",
      ok: false,
      error: { code: "UPDATING", retryable: true },
    });
    await f.control("update.release", { permitId: admission.permitId });
    expect(await f.control("project.list")).toMatchObject({ ok: true, data: { projects: [] } });
  } else {
    expect(admission).toMatchObject({
      kind: "blocked",
      blockers: expect.arrayContaining(["transport"]),
    });
    expect(creation).toMatchObject({
      id: "racing-creation",
      ok: true,
      data: { project: { id: expect.any(String) } },
    });
  }
});

it("a ready package handle blocks until retained files and asynchronous cleanup close", async () => {
  const events = new EventEmitter();
  const cleanupHeld = once(events, "cleanup"),
    release = once(events, "release");
  const native = mediaWorker();
  let holdCleanup = false;
  const f = await projectServiceControlFixture(cleanups, async (operation, params, options) => {
    if (operation === "archive.cleanup" && holdCleanup) {
      events.emit("cleanup");
      await release;
    }
    return native(operation, params, options);
  });
  cleanups.push(async () => {
    events.emit("release");
  });
  const created = await f.control("project.create", {
    requestId: "empty-project",
    canvas: {
      width: 64,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  const home = await realpath(f.home);
  const archive = join(home, "package.zip");
  const exported = await f.control("export.create", {
    requestId: "empty-package",
    projectId,
    kind: "processed-package",
    directory: home,
    leaf: "package.zip",
  });
  if (!exported.ok) throw new Error(JSON.stringify(exported));
  await expect
    .poll(() => f.control("export.status", { exportId: "empty-package" }), { timeout: 5_000 })
    .toMatchObject({ ok: true, data: { state: "ready", cleanupPending: false } });
  holdCleanup = true;
  const opened = await f.control("package.open", { path: archive });
  if (!opened.ok) throw new Error(JSON.stringify(opened));
  const id = (opened.data as { id: string }).id;
  await expect
    .poll(() => f.control("package.status", { admissionId: id }))
    .toMatchObject({ ok: true, data: { state: "ready", packageHandle: expect.any(String) } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: ["packages"] },
  });
  const closing = f.control("package.close", { admissionId: id });
  await cleanupHeld;
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["packages"]) },
  });
  const progress = once(f.events, "update.progress");
  events.emit("release");
  expect(await closing).toMatchObject({ ok: true, data: { state: "idle" } });
  await progress;
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "prepared" },
  });
});

test("observing export admission never cancels its held publication owner", async () => {
  const events = new EventEmitter(),
    entered = once(events, "entered"),
    release = once(events, "release");
  let signal: AbortSignal | undefined;
  const f = await projectServiceControlFixture(cleanups, async (operation, _params, options) => {
    if (operation !== "storage.externalDirectory") throw new Error(`Unexpected ${operation}`);
    signal = options?.signal;
    events.emit("entered");
    await release;
    return {
      ok: false,
      error: {
        code: "FIXTURE_REFUSED",
        message: "Fixture destination refused",
        retryable: false,
        details: {},
      },
    };
  });
  cleanups.push(async () => {
    events.emit("release");
  });
  const created = await f.control("project.create", {
    requestId: "empty",
    canvas: {
      width: 64,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  const exporting = f.control("export.create", {
    projectId,
    requestId: randomUUID(),
    kind: "processed-package",
    directory: f.home,
    leaf: "package.zip",
  });
  await entered;
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["publication"]) },
  });
  expect(signal?.aborted).toBe(false);
  const progress = once(f.events, "update.progress");
  events.emit("release");
  expect(await exporting).toMatchObject({ ok: false, error: { code: "FIXTURE_REFUSED" } });
  await progress;
  expect(await f.control("update.prepare")).toMatchObject({ ok: true, data: { kind: "prepared" } });
});

test("deletion cleanup remains owned through disconnect until its storage worker settles", async () => {
  const events = new EventEmitter(),
    entered = once(events, "entered"),
    released = once(events, "release");
  const f = await projectServiceControlFixture(cleanups, async (operation, params) => {
    if (operation !== "storage.removeCacheFiles") throw new Error(`Unexpected ${operation}`);
    events.emit("entered");
    await released;
    for (const id of params.ids as string[]) await rm(join(f.home, "library/cache", id + ".cache"));
    return { ok: true, data: { removed: true } };
  });
  cleanups.push(async () => {
    events.emit("release");
  });
  const created = await f.control("project.create", {
    requestId: "deletable",
    canvas: {
      width: 64,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  const cacheId = randomUUID();
  catalog.catalog
    .prepare(
      "INSERT INTO derived_cache(id,ownerKind,ownerId,touched,bytes) VALUES (?,'project',?,1,1)",
    )
    .run(cacheId, projectId);
  catalog.close();
  await writeFile(join(f.home, "library/cache", cacheId + ".cache"), "x");
  const cancel = new AbortController();
  const deleting = callLocal(
    f.service.socketPath,
    {
      id: "delete",
      operation: "project.delete",
      params: { projectId, requestId: "disconnect-delete" },
    },
    { signal: cancel.signal },
  ).catch((error) => error);
  await entered;
  cancel.abort();
  expect(await deleting).toMatchObject({ code: "ABORTED" });
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["deletion"]) },
  });
  const progress = once(f.events, "update.progress");
  events.emit("release");
  await progress;
  await new Promise((resolve) => setImmediate(resolve));
  expect(await f.control("update.prepare")).toMatchObject({ ok: true, data: { kind: "prepared" } });
});

test("canceled background work blocks replacement until its worker and cleanup settle", async () => {
  const events = new (await import("node:events")).EventEmitter();
  const entered = once(events, "entered"),
    released = once(events, "release");
  const f = await projectServiceControlFixture(cleanups, async (operation, _params, options) => {
    if (operation !== "media.probe") throw new Error(`Unexpected operation ${operation}`);
    options!.signal!.addEventListener("abort", () => events.emit("aborted"), { once: true });
    events.emit("entered");
    await released;
    return { ok: true, data: metadata };
  });
  cleanups.push(async () => {
    events.emit("release");
  });
  const imported = await f.call("asset.import", { path: f.path, requestId: "import-owned" });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const jobId = (imported.data as { jobId: string }).jobId;
  await entered;
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["jobs"]) },
  });
  const aborted = once(events, "aborted");
  const canceled = f.control("job.cancel", { jobId });
  await aborted;
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["jobs"]) },
  });
  const progress = once(f.events, "update.progress");
  events.emit("release");
  expect(await canceled).toMatchObject({ ok: true, data: { state: "canceled" } });
  await progress;
  await new Promise((resolve) => setImmediate(resolve));
  const ready = await f.control("update.prepare");
  expect(ready).toMatchObject({ ok: true, data: { kind: "prepared" } });
});

test("reply-created result leases block replacement and autonomous expiry wakes a recheck", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const reply = await callLocal(f.service.socketPath, {
      id: "leased-result",
      operation: "project.list",
      params: {},
      resultDelivery: { inlineBytes: 1 },
    });
    expect(reply).toHaveProperty("resultDelivery.token", expect.any(String));
    const socketSettled = once(f.events, "update.progress");
    const blocked = await f.control("update.prepare");
    expect(blocked).toMatchObject({
      ok: true,
      data: {
        kind: "blocked",
        blockers: expect.arrayContaining(["delivery"]),
      },
    });
    if (blocked.ok && (blocked.data as { blockers: string[] }).blockers.includes("transport"))
      await socketSettled;
    expect(await f.control("update.prepare")).toMatchObject({
      ok: true,
      data: { kind: "blocked", blockers: ["delivery"] },
    });
    const progress = once(f.events, "update.progress");
    await vi.advanceTimersByTimeAsync(30_001);
    await progress;
    expect(await f.control("update.prepare")).toMatchObject({
      ok: true,
      data: { kind: "prepared" },
    });
  } finally {
    vi.useRealTimers();
  }
});

test("capture preparation, reports and finalization block without interrupting the take", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  const nativeCall = once(f.events, "call");
  const start = f.control("capture.start", {
    requestId: "take",
    source: { kind: "display", id: 1 },
  });
  const [native] = await nativeCall;
  expect(native.request.operation).toBe("capture.start");
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: {
      kind: "blocked",
      blockers: expect.arrayContaining(["capture", "transport"]),
    },
  });
  const report = {
    recordingId: native.request.params.recordingId,
    sourceId: native.request.params.sourceId,
    sequence: 1,
    state: "recording",
  };
  f.input.write(
    JSON.stringify({
      event: "result",
      response: { id: native.request.id, ok: true, data: report },
    }) + "\n",
  );
  expect(await start).toMatchObject({ ok: true, data: { state: "recording" } });
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["capture"]) },
  });
  expect(
    await f.control("capture.report", { ...report, sequence: 2, state: "finalizing" }),
  ).toMatchObject({ ok: true, data: { state: "finalizing" } });
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["capture"]) },
  });
  const progress = once(f.events, "update.progress");
  expect(
    await f.control("capture.report", {
      ...report,
      sequence: 3,
      state: "interrupted",
      reason: "FIXTURE_ENDED",
    }),
  ).toMatchObject({ ok: true, data: { state: "interrupted" } });
  await progress;
  expect(await f.control("update.prepare")).toMatchObject({ ok: true, data: { kind: "prepared" } });
});

test("a lost preparation acknowledgement expires while committed ownership keeps admission fenced", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }), undefined, {
    // Chaos-marginal: the fenced call must land inside this deadline even on a loaded machine;
    // 30 ms let the permit expire first during a full parallel run. The waits are twice it.
    control: { input, output, timeoutMs: 300 },
  });
  const responses: { id: string; ok: boolean; data: { kind?: string; permitId?: string } }[] = [];
  output.on("data", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.event === "result") responses.push(message.response);
  });
  const ask = async (id: string, operation: string, params: Record<string, unknown> = {}) => {
    const received = once(output, "data");
    input.write(JSON.stringify({ event: "request", request: { id, operation, params } }) + "\n");
    await received;
    return responses.find((response) => response.id === id)!;
  };
  const lost = await ask("lost", "update.prepare");
  expect(lost).toMatchObject({ ok: true, data: { kind: "prepared" } });
  expect(await f.call("project.list", {})).toMatchObject({
    ok: false,
    error: { code: "UPDATING" },
  });
  await delay(600);
  expect(await ask("reopened", "project.list")).toMatchObject({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  const next = await ask("next", "update.prepare");
  expect(await ask("commit", "update.commit", { permitId: next.data.permitId })).toMatchObject({
    ok: true,
  });
  await delay(600);
  expect(
    await ask("old-release", "update.release", { permitId: lost.data.permitId }),
  ).toMatchObject({ ok: true, data: { released: true } });
  expect(await f.call("project.list", {})).toMatchObject({
    ok: false,
    error: { code: "UPDATING" },
  });
  await ask("release", "update.release", { permitId: next.data.permitId });
  expect(
    await ask("release-again", "update.release", { permitId: next.data.permitId }),
  ).toMatchObject({ ok: true, data: { released: true } });
  expect(await f.call("project.list", {})).toMatchObject({ ok: true });
});
test("project service delivers complete operation results through its shared artifact owner", async () => {
  const f = await setup(async (operation) => {
    expect(operation).toBe("storage.clearRenderWorkspace");
    return { ok: true, data: { removed: true } };
  });
  const params = {
    requestId: "delivered-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  };
  const answer = await callLocal(f.service.socketPath, {
    id: "delivered",
    operation: "project.create",
    params,
    resultDelivery: { inlineBytes: 100 },
  });
  if (!("resultDelivery" in answer)) throw Error("Missing project result delivery");
  const read = await f.call("artifact.read", {
    token: answer.resultDelivery.token,
    offsetBytes: 0,
  });
  if (!read.ok) throw Error(read.error.message);
  const chunk = read.data as { data: string };
  const bytes = Buffer.from(chunk.data, "base64");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(answer.resultDelivery.sha256);
  const ordinary = await f.call("project.create", params);
  expect(JSON.parse(bytes.toString())).toEqual({ ...ordinary, id: "delivered" });
  expect(await f.call("artifact.close", { token: answer.resultDelivery.token })).toMatchObject({
    ok: true,
    data: { closed: true },
  });
});
test("fresh service owns capture facts without enabling capture or creating span editing state", async () => {
  const f = await setup(async (operation) => {
    expect(operation).toBe("storage.clearRenderWorkspace");
    return { ok: true, data: { removed: true } };
  });
  const start = {
    requestId: "not-wired",
    source: { kind: "display", id: 1 },
    microphone: false,
    systemAudio: false,
  };
  expect(await f.call("capture.start", start)).toMatchObject({
    ok: false,
    error: { code: "PREREQUISITE_MISSING" },
  });
  expect(
    await f.call("capture.start", { ...start, cameraDeviceId: "selected-camera" }),
  ).toMatchObject({
    ok: false,
    error: { code: "PREREQUISITE_MISSING" },
  });
  await f.service.close();
  const database = new DatabaseSync(join(f.home, "library/catalog.sqlite"), { readOnly: true });
  try {
    expect(database.prepare("SELECT recordingId FROM recordings").all()).toEqual([]);
    expect(database.prepare("SELECT recordingId FROM recording_deletions").all()).toEqual([]);
    expect(database.prepare("SELECT projectId FROM projects").all()).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('revisions','edit_requests','undo_stack')",
        )
        .all(),
    ).toEqual([]);
  } finally {
    database.close();
  }
});
test("audio preparation pins its revision and reuses failed work until explicit retry", async () => {
  let attempts = 0;
  const f = await setup(async (operation) => {
    if (operation === "storage.clearRenderWorkspace") return { ok: true, data: { removed: true } };
    expect(operation).toBe("media.mixCompositionAudio");
    attempts++;
    return {
      ok: false,
      error: { code: "MEDIA_WORKER_UNAVAILABLE", message: "offline", retryable: true, details: {} },
    };
  });
  const created = await f.call("project.create", {
    requestId: "prepare",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const initial = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const edited = await f.call("edit.apply", {
    projectId: initial.project.id,
    expectedRevisionId: initial.revision.id,
    requestId: "silence",
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
        },
      },
    ],
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited));
  const selection = {
    projectId: initial.project.id,
    revisionId: (edited.data as { revision: { id: string } }).revision.id,
  };
  const pending = await f.call("audio.prepare", selection);
  expect(pending.ok).toBe(true);
  if (!pending.ok) return;
  expect(pending.data).toMatchObject(selection);
  const { jobId } = pending.data as { jobId: string };
  await f.job(jobId, "failed");
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    const input = catalog.catalog.prepare("SELECT input FROM jobs WHERE jobId=?").get(jobId)!
      .input as string;
    expect(await f.call("job.get", { jobId })).toMatchObject({
      ok: true,
      data: { inputSha256: createHash("sha256").update(input).digest("hex") },
    });
  } finally {
    catalog.close();
  }
  const failed = await f.call("audio.prepare", selection);
  expect(failed).toMatchObject({
    ok: true,
    data: { ...selection, state: "failed", jobId, retryable: true, published: null },
  });
  expect(attempts).toBe(1);
  expect(await f.call("job.retry", { jobId })).toMatchObject({ ok: true, data: { id: jobId } });
  await f.job(jobId, "failed");
  expect(attempts).toBe(2);
  expect(await f.call("revision.get", selection)).toMatchObject({
    ok: true,
    data: { revision: { id: selection.revisionId } },
  });
  expect(await f.call("audio.prepare", { projectId: selection.projectId })).toMatchObject({
    ok: false,
    error: { code: "INVALID_PARAMS" },
  });
});
test("failed probe retries through the shared job and publishes immutable media once", async () => {
  let attempts = 0;
  const f = await setup(async () =>
    ++attempts === 1
      ? {
          ok: false,
          error: {
            code: "MEDIA_WORKER_UNAVAILABLE",
            message: "worker stopped",
            retryable: true,
            details: {},
          },
        }
      : { ok: true, data: metadata },
  );
  const accepted = await f.call("asset.import", { requestId: "import", path: f.path });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const { jobId } = accepted.data as { jobId: string };
  expect((await f.job(jobId, "failed")).errorCode).toBe("MEDIA_WORKER_UNAVAILABLE");
  expect(await f.call("asset.list", {})).toMatchObject({ ok: true, data: { assets: [] } });
  expect(await f.call("job.retry", { jobId })).toMatchObject({ ok: true, data: { id: jobId } });
  const ready = await f.job(jobId, "ready");
  expect(ready.published?.output.assetId).toMatch(/^[a-f0-9]{64}$/);
  expect(attempts).toBe(2);
  await rm(f.path);
  expect(await f.call("asset.import", { requestId: "import", path: f.path })).toMatchObject({
    ok: true,
    data: { jobId, published: ready.published },
  });
});
test("cancel drains probing and refuses changed frozen inputs on retry", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let aborted!: () => void;
  const stopped = new Promise<void>((resolve) => (aborted = resolve));
  const f = await setup(async (_operation, _params, options) => {
    entered();
    await new Promise<void>((resolve) =>
      options!.signal!.addEventListener(
        "abort",
        () => {
          aborted();
          resolve();
        },
        { once: true },
      ),
    );
    return {
      ok: false,
      error: { code: "CANCELED", message: "canceled", retryable: true, details: {} },
    };
  });
  const result = await f.call("asset.import", { requestId: "cancel", path: f.path });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { jobId } = result.data as { jobId: string };
  await started;
  expect(await f.call("job.cancel", { jobId })).toMatchObject({
    ok: true,
    data: { state: "canceled" },
  });
  await stopped;
  expect(await f.call("asset.list", {})).toMatchObject({ ok: true, data: { assets: [] } });
  await writeFile(f.path, "changed image bytes");
  expect(await f.call("job.retry", { jobId })).toMatchObject({ ok: true });
  expect((await f.job(jobId, "failed")).errorCode).toBe("SOURCE_CHANGED");
});

test("process death after owned copy leaves a retryable job and no visible partial asset", async () => {
  const home = await mkdtemp(join(tmpdir(), "asset-crash-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "source.png");
  await writeFile(path, "crash pixels");
  const child = fork(new URL("../fixtures/project-service-crash.mjs", import.meta.url), [home], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const [started] = (await once(child, "message")) as [{ socketPath: string }];
  const probing = once(child, "message");
  const accepted = await callLocal(started.socketPath, {
    id: "import",
    operation: "asset.import",
    params: { requestId: "crash", path },
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const { jobId } = accepted.data as { jobId: string };
  expect((await probing)[0]).toEqual({ phase: "owned-copy-probing" });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const service = await startProjectService({
    home,
    worker: probeFileFixture(home, async () => ({ ok: true, data: metadata })),
    nativeExecutable: undefined,
  });
  cleanups.push(() => service.close());
  expect(await readdir(join(home, "library", "staging", "assets"))).toEqual([]);
  const interrupted = await callLocal(service.socketPath, {
    id: "status",
    operation: "job.get",
    params: { jobId },
  });
  expect(interrupted).toMatchObject({
    ok: true,
    data: { state: "failed", errorCode: "JOB_INTERRUPTED", retryable: true },
  });
  const retried = await callLocal(service.socketPath, {
    id: "retry",
    operation: "job.retry",
    params: { jobId },
  });
  expect(retried.ok).toBe(true);
  const deadline = performance.now() + 3000;
  for (;;) {
    const status = await callLocal(service.socketPath, {
      id: "poll",
      operation: "job.get",
      params: { jobId },
    });
    if (status.ok && (status.data as { state: string }).state === "ready") break;
    if (performance.now() > deadline) throw new Error(JSON.stringify(status));
    await delay(10);
  }
  expect(service.assets.get(service.assets.list().assets[0]!.id).streams).toEqual(metadata.streams);
});

test("queue capacity refusal leaves no frozen import receipt to poison a later admission", async () => {
  let hold = true;
  const f = await setup(async (_operation, _params, options) => {
    if (hold && !options!.signal!.aborted)
      await new Promise<void>((resolve) =>
        options!.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
    return options!.signal!.aborted
      ? {
          ok: false,
          error: { code: "CANCELED", message: "canceled", retryable: true, details: {} },
        }
      : { ok: true, data: metadata };
  });
  const accepted: string[] = [];
  let refusedRequest: string | undefined;
  for (let index = 0; index < 100; index++) {
    const requestId = `capacity-${index}`;
    const response = await f.call("asset.import", { requestId, path: f.path });
    if (!response.ok) {
      expect(response.error.code).toBe("CAPACITY_EXCEEDED");
      refusedRequest = requestId;
      break;
    }
    accepted.push((response.data as { jobId: string }).jobId);
  }
  expect(refusedRequest).toBeDefined();
  for (const jobId of accepted.slice(1).reverse()) await f.call("job.cancel", { jobId });
  hold = false;
  await f.call("job.cancel", { jobId: accepted[0] });
  await writeFile(f.path, "new bytes after capacity refusal");
  const response = await f.call("asset.import", { requestId: refusedRequest, path: f.path });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const ready = await f.job((response.data as { jobId: string }).jobId, "ready");
  expect(await readFile(f.service.assets.path(ready.published!.output.assetId), "utf8")).toBe(
    "new bytes after capacity refusal",
  );
});

test("large provenance history cannot hide metadata and every origin remains pageable", async () => {
  const f = await setup(async () => ({ ok: true, data: metadata }));
  const accepted = await f.call("asset.import", { requestId: "history", path: f.path });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const ready = await f.job((accepted.data as { jobId: string }).jobId, "ready");
  const assetId = ready.published!.output.assetId;
  await f.service.close();
  // Seed persisted history at scale while no service owns the catalog; public reads are the gate.
  const catalog = new Catalog(join(f.home, "library", "catalog.sqlite"));
  const expected = [{ kind: "import", source: f.path }];
  try {
    const insert = catalog.catalog.prepare("INSERT INTO asset_origins VALUES(?,?)");
    catalog.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        const origin = {
          kind: "import",
          source:
            "/" +
            ("a".repeat(200) + "/").repeat(4) +
            `source-${String(index).padStart(5, "0")}.png`,
        };
        expected.push(origin);
        insert.run(assetId, JSON.stringify(origin));
      }
    });
  } finally {
    catalog.close();
  }
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(8 * 1024 * 1024);
  const service = await startProjectService({
    home: f.home,
    nativeExecutable: undefined,
    worker: probeFileFixture(f.home, async () => ({ ok: true, data: metadata })),
  });
  cleanups.push(() => service.close());
  const get = await callLocal(service.socketPath, {
    id: "metadata",
    operation: "asset.get",
    params: { assetId },
  });
  expect(get).toMatchObject({
    ok: true,
    data: {
      id: assetId,
      streams: metadata.streams,
    },
  });
  expect(Buffer.byteLength(JSON.stringify(get))).toBeLessThan(1024);
  const observed: ReturnType<AssetStore["origins"]>["origins"] = [];
  let cursor: ReturnType<AssetStore["origins"]>["nextCursor"] = null;
  do {
    const response = await callLocal(service.socketPath, {
      id: "page",
      operation: "asset.origins",
      params: { assetId, limit: 37, ...(cursor ? { cursor } : {}) },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(40_000);
    const page = response.data as ReturnType<AssetStore["origins"]>;
    expect(page.origins.length).toBeGreaterThan(0);
    expect(page.origins.length).toBeLessThanOrEqual(37);
    observed.push(...page.origins);
    expect(observed.length).toBeLessThanOrEqual(expected.length);
    cursor = page.nextCursor;
  } while (cursor);
  expect(observed.map((origin) => JSON.stringify(origin))).toEqual(
    expected.map((origin) => JSON.stringify(origin)).sort(),
  );
});

test("startup resumes a committed project deletion marker before serving requests", async () => {
  const f = await setup(async () => ({ ok: true, data: metadata }));
  const creation = {
    requestId: "resume",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  };
  const created = await f.call("project.create", creation);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const { project } = created.data as { project: { id: string } };
  await f.service.close();
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  const projects = projectStoreFixture(
    catalog,
    new AssetStore(catalog, join(f.home, "library")),
    join(f.home, "library"),
  );
  expect(projects.markDeleting(project.id)).toBe(true);
  catalog.close();
  const restarted = await startProjectService({ home: f.home });
  cleanups.push(() => restarted.close());
  expect(
    await callLocal(restarted.socketPath, {
      id: "get",
      operation: "project.get",
      params: { projectId: project.id },
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  await restarted.close();
  const check = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    const store = projectStoreFixture(
      check,
      new AssetStore(check, join(f.home, "library")),
      join(f.home, "library"),
    );
    expect(store.deletionsPage().projectIds).toEqual([]);
    expect(store.create(creation)).toEqual(created.data);
    expect(store.list().projects).toEqual([]);
  } finally {
    check.close();
  }
});

test("shutdown aborts an in-flight export destination admission before draining requests", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let aborted!: () => void;
  const canceled = new Promise<boolean>((resolve) => (aborted = () => resolve(true)));
  const f = await setup(async (operation, _params, options) => {
    if (operation === "media.probe") return { ok: true, data: metadata };
    if (operation !== "storage.externalDirectory") throw new Error(`Unexpected ${operation}`);
    entered();
    const onAbort = () => {
      aborted();
      release();
    };
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });
    await released;
    return {
      ok: false,
      error: { code: "CANCELED", message: "admission canceled", retryable: true, details: {} },
    };
  });
  const imported = await f.call("asset.import", { requestId: "source", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const created = await f.call("project.create", {
    requestId: "project",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  expect(
    await f.call("edit.apply", {
      projectId: project.id,
      requestId: "place",
      expectedRevisionId: revision.id,
      operations: [
        { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
        {
          operation: "place",
          clip: {
            trackId: { label: "picture" },
            assetId: ready.published!.output.assetId,
            streamId: "image:0",
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ],
    }),
  ).toMatchObject({ ok: true });
  const pending = f
    .call("export.create", {
      projectId: project.id,
      requestId: "67a0c032-a3ee-44b9-81f8-7269f0f3195e",
      kind: "video",
      directory: f.home,
      leaf: "output.mp4",
    })
    .catch(() => null); // Shutdown may close the transport before replying.
  await started;
  const closing = f.service.close();
  try {
    expect(await Promise.race([canceled, delay(1000).then(() => false)])).toBe(true);
  } finally {
    release();
    await pending;
    await closing;
  }
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    expect(catalog.catalog.prepare("SELECT COUNT(*) AS count FROM export_intents").get()).toEqual({
      count: 0,
    });
    expect(await readdir(f.home)).not.toContain("output.mp4");
  } finally {
    catalog.close();
  }
});

test("audio imports persist one pending transcript per audio stream without a model", async () => {
  const requests: import("@yap/core/transcript").SpeechTranscriptionRequest[] = [];
  const f = await projectServiceFixture(cleanups, controlledSpeech(requests), undefined, {
    autoTranscribe: true,
  });
  const imported = await f.call("asset.import", { requestId: "backlog", path: f.path });
  expect(imported).toMatchObject({ ok: true });
  if (!imported.ok) return;
  await f.job((imported.data as { jobId: string }).jobId, "ready");
  const database = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    expect(
      database.catalog.prepare("SELECT COUNT(*) AS count FROM transcript_backlog").get(),
    ).toEqual({ count: 2 });
    expect(
      database.catalog
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='transcript'")
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    database.close();
  }
  expect(requests).toHaveLength(0);
});

test("a ready model submits one background transcript per audio stream and clears backlog rows", async () => {
  const requests: import("@yap/core/transcript").SpeechTranscriptionRequest[] = [];
  const home = await mkdtemp(join(tmpdir(), "transcript-backlog-ready-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const f = await projectServiceFixture(cleanups, controlledSpeech(requests), home, {
    autoTranscribe: true,
  });
  await modelMetadata(await realpath(join(f.home, "library")));
  expect(await f.call("model.status", { modelId: "parakeet" })).toMatchObject({
    ok: true,
    data: { state: "ready" },
  });
  const imported = await f.call("asset.import", { requestId: "ready", path: f.path });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  await f.job((imported.data as { jobId: string }).jobId, "ready");
  await expect
    .poll(() =>
      f.service.captures.catalog
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='transcript'")
        .get(),
    )
    .toEqual({ count: 2 });
  expect(
    f.service.captures.catalog
      .prepare("SELECT priority FROM jobs WHERE artifact='transcript' ORDER BY targetId")
      .all(),
  ).toEqual([{ priority: "background" }, { priority: "background" }]);
  await expect
    .poll(() =>
      f.service.captures.catalog.prepare("SELECT COUNT(*) AS count FROM transcript_backlog").get(),
    )
    .toEqual({ count: 0 });
});

test("model.prepare drains pending transcript rows", async () => {
  const requests: import("@yap/core/transcript").SpeechTranscriptionRequest[] = [];
  const home = await mkdtemp(join(tmpdir(), "transcript-backlog-prepare-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const f = await projectServiceFixture(cleanups, controlledSpeech(requests), home, {
    autoTranscribe: true,
  });
  await modelMetadata(await realpath(join(home, "library")));
  const imported = await f.call("asset.import", { requestId: "prepare-backlog", path: f.path });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  await f.job((imported.data as { jobId: string }).jobId, "ready");
  expect(await f.call("model.prepare", { modelId: "parakeet" })).toMatchObject({ ok: true });
  await expect
    .poll(() =>
      f.service.captures.catalog
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='transcript'")
        .get(),
    )
    .toEqual({ count: 2 });
  expect(
    f.service.captures.catalog
      .prepare("SELECT DISTINCT priority FROM jobs WHERE artifact='transcript'")
      .all(),
  ).toEqual([{ priority: "background" }]);
});

test("service restart drains pending transcript rows when the model is already ready", async () => {
  const requests: import("@yap/core/transcript").SpeechTranscriptionRequest[] = [];
  const home = await mkdtemp(join(tmpdir(), "transcript-backlog-restart-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const first = await projectServiceFixture(cleanups, controlledSpeech(requests), home, {
    autoTranscribe: true,
  });
  const imported = await first.call("asset.import", {
    requestId: "restart-backlog",
    path: first.path,
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  await first.job((imported.data as { jobId: string }).jobId, "ready");
  expect(
    first.service.captures.catalog
      .prepare("SELECT COUNT(*) AS count FROM transcript_backlog")
      .get(),
  ).toEqual({ count: 2 });
  await first.service.close();
  await modelMetadata(await realpath(join(home, "library")));
  const second = await projectServiceFixture(cleanups, controlledSpeech(requests), home, {
    autoTranscribe: true,
  });
  await expect
    .poll(() => second.call("model.status", { modelId: "parakeet" }))
    .toMatchObject({ ok: true, data: { state: "ready" } });
  await expect
    .poll(() =>
      second.service.captures.catalog
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='transcript'")
        .get(),
    )
    .toEqual({ count: 2 });
});

test("explicit transcript transcription joins the queued background job and promotes it", async () => {
  const requests: import("@yap/core/transcript").SpeechTranscriptionRequest[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const controlled = controlledSpeech(requests);
  const worker = async (...args: Parameters<typeof controlled>) => {
    const [operation] = args;
    if (operation === "speech.transcribe") {
      entered();
      await gate;
    }
    return controlled(...args);
  };
  const home = await mkdtemp(join(tmpdir(), "transcript-backlog-join-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const f = await projectServiceFixture(cleanups, worker, home, { autoTranscribe: true });
  await modelMetadata(await realpath(join(home, "library")));
  expect(await f.call("model.status", { modelId: "parakeet" })).toMatchObject({
    ok: true,
    data: { state: "ready" },
  });
  const imported = await f.call("asset.import", { requestId: "join-backlog", path: f.path });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const importedJob = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const assetId = importedJob.published!.output.assetId;
  await f.call("model.prepare", { modelId: "parakeet" });
  await started;
  const explicit = await f.call("transcript.transcribe", { assetId, streamId: "track:1" });
  expect(explicit).toMatchObject({ ok: true, data: { jobId: expect.any(String) } });
  const jobId = (explicit as { data: { jobId: string } }).data.jobId;
  release();
  expect(
    f.service.captures.catalog
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE artifact='transcript'")
      .get(),
  ).toEqual({ count: 2 });
  expect(
    f.service.captures.catalog.prepare("SELECT jobId,priority FROM jobs WHERE jobId=?").get(jobId),
  ).toMatchObject({ jobId, priority: "interactive" });
  await f.job(jobId, "ready");
});

test("asset conversion does not enqueue transcript work for a conversion output", async () => {
  const worker: MediaWorker = async (operation, params, options) => {
    if (operation === "media.probe")
      return {
        ok: true as const,
        data: {
          originUs: 0,
          streams: [
            {
              id: "video",
              kind: "video" as const,
              codec: "fixture",
              decodable: true,
              width: 16,
              height: 16,
              startUs: 0,
              endUs: 1000000,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
            },
            {
              id: "audio",
              kind: "audio" as const,
              codec: "fixture",
              decodable: true,
              startUs: 0,
              endUs: 1000000,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
            },
          ],
        },
      };
    return { ok: true as const, data: {} };
  };
  const f = await projectServiceFixture(cleanups, worker, undefined, { autoTranscribe: true });
  const imported = await f.call("asset.import", { requestId: "convert-source", path: f.path });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const assetId = ready.published!.output.assetId;
  expect(
    await f.call("asset.convert", {
      assetId,
      streamIds: ["video", "audio"],
      recipe: "hdr-to-sdr-hable-1000nit-v1",
    }),
  ).toMatchObject({ ok: false, error: { code: "PREREQUISITE_MISSING" } });
  expect(
    f.service.captures.catalog.prepare("SELECT COUNT(*) AS count FROM transcript_backlog").get(),
  ).toEqual({ count: 1 });
});

test("acquisition publication enqueues audio streams with its acquisition selection", async () => {
  const worker: MediaWorker = async (operation, params, options) => {
    if (operation === "media.probe")
      return {
        ok: true as const,
        data: {
          originUs: 0,
          streams: [
            {
              id: "video",
              kind: "video" as const,
              codec: "fixture",
              decodable: true,
              width: 16,
              height: 16,
              startUs: 0,
              endUs: 1000000,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
            },
            {
              id: "audio",
              kind: "audio" as const,
              codec: "fixture",
              decodable: true,
              startUs: 0,
              endUs: 1000000,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
            },
          ],
        },
      };
    return sourceWorker(operation, params, options);
  };
  const f = await projectServiceFixture(cleanups, worker, undefined, { autoTranscribe: true });
  const path = join(f.home, "acquisition-source");
  await mkdir(path);
  await writeFile(join(path, "capture.journal.jsonl"), JSON.stringify({ sessionID: "acquired" }));
  await writeFile(join(path, "video.mov"), "video");
  await writeFile(join(path, "narration.mov"), "audio");
  const imported = await f.call("acquisition.import", { requestId: "acquisition-audio", path });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const jobId = (imported.data as { jobId: string }).jobId;
  const done = await f.job(jobId, "ready");
  const acquisitionId = (done.published!.output as unknown as { acquisitionId: string })
    .acquisitionId;
  const row = f.service.captures.catalog
    .prepare("SELECT metadata FROM acquisitions WHERE id=?")
    .get(acquisitionId) as { metadata: string };
  const acquisition = JSON.parse(row.metadata) as {
    bindings: { assetId: string; streamId: string; sourceRoles: string[] }[];
  };
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("narration"))!;
  expect(binding).toMatchObject({ sourceRoles: ["narration"] });
  expect(
    f.service.captures.catalog
      .prepare("SELECT assetId,streamId,acquisitionId FROM transcript_backlog")
      .all(),
  ).toEqual([{ assetId: binding.assetId, streamId: binding.streamId, acquisitionId }]);
});

test.each(["INVALID_REQUEST", "MEDIA_WORKER_FAILED"])(
  "%s transcript failure is left for explicit retry",
  async (code) => {
    const requests: import("@yap/core/transcript").SpeechTranscriptionRequest[] = [];
    const base = controlledSpeech(requests);
    let attempts = 0;
    const worker = async (...args: Parameters<typeof base>) => {
      if (args[0] === "speech.transcribe") {
        attempts++;
        return {
          ok: false as const,
          error: {
            code,
            message: "fixture refusal",
            retryable: false,
            details: {},
          },
        };
      }
      return base(...args);
    };
    const home = await mkdtemp(join(tmpdir(), "transcript-backlog-failure-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const f = await projectServiceFixture(cleanups, worker, home, { autoTranscribe: true });
    await modelMetadata(await realpath(join(home, "library")));
    expect(await f.call("model.status", { modelId: "parakeet" })).toMatchObject({
      ok: true,
      data: { state: "ready" },
    });
    const imported = await f.call("asset.import", { requestId: "nonretryable", path: f.path });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    await f.job((imported.data as { jobId: string }).jobId, "ready");
    await f.call("model.prepare", { modelId: "parakeet" });
    await expect
      .poll(() =>
        f.service.captures.catalog
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE artifact='transcript' AND state='failed'",
          )
          .get(),
      )
      .toEqual({ count: 2 });
    const failures = () =>
      f.service.captures.catalog
        .prepare(
          "SELECT jobId,attemptId,generation,state,errorCode FROM jobs WHERE artifact='transcript' ORDER BY jobId",
        )
        .all();
    const before = failures();
    await expect
      .poll(() =>
        f.service.captures.catalog.prepare("SELECT assetId FROM transcript_backlog").all(),
      )
      .toEqual([]);
    await f.call("model.prepare", { modelId: "parakeet" });
    expect(failures()).toEqual(before);
    expect(attempts).toBe(2);
  },
);

test("selected-source transcript reads report unprepared models without downloading or inventing a recording", async () => {
  const requests: string[] = [];
  const f = await setup(async (operation) => {
    requests.push(operation);
    return {
      ok: true,
      data: {
        originUs: 48675,
        streams: [
          {
            id: "track:1",
            kind: "audio",
            codec: "pcm",
            decodable: true,
            startUs: 0,
            endUs: 1000000,
            segments: [{ startUs: 0, endUs: 1000000, empty: false }],
          },
        ],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "speech", path: f.path });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const selection = { assetId: ready.published!.output.assetId, streamId: "track:1" };
  expect(await f.call("model.status", { modelId: "parakeet" })).toMatchObject({
    ok: true,
    data: { state: "unavailable" },
  });
  expect(
    await f.call("model.remove", { modelId: "parakeet", requestId: "remove-before-transcribe" }),
  ).toMatchObject({
    ok: true,
    data: { id: "parakeet", deleted: true, freedBytes: 0 },
  });
  expect(await f.call("transcript.transcribe", selection)).toMatchObject({
    ok: true,
    data: { state: "unavailable", reason: "model_not_prepared", retryable: true },
  });
  expect(await f.call("model.status", { modelId: "parakeet" })).toMatchObject({
    ok: true,
    data: { presence: "absent" },
  });
  expect(requests.filter((operation) => operation === "speech.transcribe")).toEqual([]);
  expect(await f.call("transcript.get", selection)).toMatchObject({
    ok: true,
    data: {
      ...selection,
      state: "unavailable",
      reason: "model_not_prepared",
      retryable: true,
      jobId: null,
    },
  });
  expect(
    await f.call("transcript.review", {
      ...selection,
      sourceRange: { startUs: 0, endUs: 1_000_000 },
    }),
  ).toMatchObject({
    ok: true,
    data: { state: "running", model: { state: "running" } },
  });
  expect(await f.call("transcript.search", { ...selection, text: "hello" })).toMatchObject({
    ok: true,
    data: { reason: "model_not_prepared" },
  });
  expect(await f.call("transcript.get", { ...selection, acquisitionId: "missing" })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  const preparing = await f.call("model.status", { modelId: "parakeet" });
  expect(preparing).toMatchObject({ ok: true, data: { state: "running", presence: "absent" } });
  // Presence reports the installed files, never the lifecycle word.
  expect(modelStatusSchema.safeParse((preparing as { data: unknown }).data).success).toBe(true);
  expect(requests.filter((operation) => operation === "speech.transcribe")).toEqual([]);
});

test("project transcript review reports a failed default model download as failed", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  cleanups.push(async () => {
    vi.unstubAllGlobals();
  });
  const f = await setup(async (operation) => {
    if (operation === "storage.clearRenderWorkspace") return { ok: true, data: { removed: true } };
    return {
      ok: true,
      data: {
        originUs: 0,
        streams: [
          {
            id: "track:1",
            kind: "audio",
            codec: "pcm",
            decodable: true,
            startUs: 0,
            endUs: 1000000,
            segments: [{ startUs: 0, endUs: 1000000, empty: false }],
          },
        ],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "speech", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const created = await f.call("project.create", {
    requestId: "project",
    canvas: {
      width: 64,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const placed = await f.call("edit.apply", {
    projectId: project.id,
    requestId: "place",
    expectedRevisionId: revision.id,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "speech" },
      {
        operation: "place",
        clip: {
          trackId: { label: "speech" },
          assetId: ready.published!.output.assetId,
          streamId: "track:1",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  if (!placed.ok) throw new Error(JSON.stringify(placed));
  const review = {
    projectId: project.id,
    revisionId: (placed.data as { revision: { id: string } }).revision.id,
  };
  // The default model is fetched without asking; here the fetch fails.
  expect(await f.call("transcript.review", review)).toMatchObject({
    ok: true,
    data: { state: "running" },
  });
  await expect
    .poll(
      async () =>
        ((await f.call("model.status", { modelId: "parakeet" })) as { data?: { state?: string } })
          .data?.state,
    )
    .toBe("failed");
  const failed = await f.call("model.status", { modelId: "parakeet" });
  expect(failed).toMatchObject({ ok: true, data: { state: "failed", presence: "absent" } });
  expect(modelStatusSchema.safeParse((failed as { data: unknown }).data).success).toBe(true);
  expect(await f.call("transcript.review", review)).toMatchObject({
    ok: true,
    data: { state: "failed", model: { state: "failed" } },
  });
});

test("project transcript paging uses shared jobs and returns an empty historical revision", async () => {
  const f = await setup(async (operation) => {
    if (operation === "storage.clearRenderWorkspace") return { ok: true, data: { removed: true } };
    throw new Error(`Empty transcript must not invoke native work: ${operation}`);
  });
  const created = await f.call("project.create", {
    requestId: "empty-transcript",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const params = { projectId: project.id, revisionId: revision.id, limit: 1 };
  const pending = await f.call("transcript.get", params);
  if (!pending.ok) throw new Error(JSON.stringify(pending));
  const jobId = (pending.data as { jobId: string }).jobId;
  await f.job(jobId, "ready");
  expect(await f.call("transcript.get", params)).toMatchObject({
    ok: true,
    data: {
      projectId: project.id,
      revisionId: revision.id,
      state: "ready",
      dependencies: [],
      rows: [],
      nextCursor: null,
    },
  });
  const searching = await f.call("transcript.search", { ...params, text: "missing words" });
  if (!searching.ok) throw new Error(JSON.stringify(searching));
  await f.job((searching.data as { jobId: string }).jobId, "ready");
  expect(await f.call("transcript.search", { ...params, text: "missing words" })).toMatchObject({
    ok: true,
    data: {
      projectId: project.id,
      revisionId: revision.id,
      state: "ready",
      entries: [],
      nextCursor: null,
    },
  });
  expect(await f.call("transcript.get", { projectId: "missing" })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("selected-source audio publishes verified WAV bytes through artifact delivery", async () => {
  const wave = Buffer.from(
    "524946462800000057415645666d7420100000000300010080bb000000ee02000400200064617461040000000000803e",
    "hex",
  );
  let renderAttempt: string | undefined;
  const f = await setup(async (operation, params) => {
    if (operation === "storage.clearRenderWorkspace") {
      if (renderAttempt && params.parent) await rm(renderAttempt, { recursive: true, force: true });
      return { ok: true, data: { removed: true } };
    }
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [
            {
              id: "audio:1",
              kind: "audio",
              codec: "pcm",
              decodable: true,
              startUs: 0,
              endUs: 1000000,
              sampleRate: 48000,
              channels: 1,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
            },
          ],
        },
      };
    if (operation !== "media.sourceAudio") throw new Error(operation);
    renderAttempt = dirname(params.output as string);
    expect(params.source).toMatchObject({
      streamId: "audio:1",
      available: [{ startUs: 0, endUs: 1000000 }],
    });
    expect(params.range).toEqual({ startUs: 0, endUs: 21 });
    await writeFile(params.output as string, wave, { flag: "wx" });
    return {
      ok: true,
      data: {
        file: params.output,
        mediaType: "audio/wav",
        bytes: wave.length,
        sampleRate: 48000,
        channels: 1,
        layout: "mono",
        range: params.range,
        sampleRange: { start: 0, end: 1 },
        frames: 1,
        decodedFrames: 1,
        unavailable: [],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "audio", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const admitted = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const selection = {
    assetId: admitted.published!.output.assetId,
    streamId: "audio:1",
    sourceRange: { startUs: 0, endUs: 21 },
  };
  const pending = await f.call("audio.get", selection);
  if (!pending.ok) throw new Error(JSON.stringify(pending));
  await f.job((pending.data as { jobId: string }).jobId, "ready");
  const ready = await f.call("audio.get", selection);
  expect(ready).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      published: {
        output: {
          ...selection,
          frameCount: 1,
          sampleRate: 48000,
          channels: 1,
          unavailable: [],
        },
      },
    },
  });
  if (!ready.ok) throw new Error(JSON.stringify(ready));
  const { token } = (ready.data as { delivery: { token: string } }).delivery;
  const read = await f.call("artifact.read", { token, offsetBytes: 0 });
  expect(read).toMatchObject({
    ok: true,
    data: { data: wave.toString("base64"), eof: true, nextOffsetBytes: wave.length },
  });
  expect(await f.call("artifact.close", { token })).toMatchObject({ ok: true });
});

test("project export refuses a dangling prepared audio reference before native work", async () => {
  const f = await setup(async () => ({ ok: true, data: metadata }));
  const created = await f.call("project.create", {
    requestId: "prepared-project",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  await f.service.close();
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  new ResourceReferences(catalog).retain("prepared-audio", { kind: "revision", id: revision.id }, [
    JSON.stringify([project.id, "prepared-attempt"]),
  ]);
  catalog.close();
  const service = await startProjectService({
    home: f.home,
    nativeExecutable: undefined,
    worker: async () => {
      throw Error("Export must refuse before native work");
    },
  });
  cleanups.push(() => service.close());
  const result = await callLocal(service.socketPath, {
    id: "export",
    operation: "export.create",
    params: {
      requestId: "dangling-prepared-export",
      projectId: project.id,
      kind: "processed-package",
      directory: f.home,
      leaf: "prepared.zip",
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", message: "Prepared audio publication is unavailable" },
  });
});

function projectStoreFixture(catalog: Catalog, assets: AssetStore, home: string) {
  const acquisitions = new AcquisitionStore(catalog);
  return new ProjectStore(
    catalog,
    assets,
    new TranscriptStore(catalog, home, assetTranscriptOwner(assets, acquisitions)),
    acquisitions,
  );
}

test("asset job and cache presence checks preserve source validation without hydrating detail", async () => {
  const available = [
    { startUs: 0, endUs: 10 },
    { startUs: 20, endUs: 30 },
  ];
  const sourceRequests: Record<string, unknown>[] = [];
  const payload = Buffer.from("fixture frame");
  const f = await setup(async (operation, params) => {
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [
            {
              ...metadata.streams[0],
              id: "video:0",
              kind: "video",
              codec: "h264",
              startUs: 0,
              endUs: 30,
              segments: [
                { startUs: 0, endUs: 10, empty: false, mediaStartUs: 0, mediaDurationUs: 10 },
                { startUs: 10, endUs: 20, empty: true },
                { startUs: 20, endUs: 30, empty: false, mediaStartUs: 10, mediaDurationUs: 10 },
              ],
            },
          ],
        },
      };
    if (operation !== "media.sourceFrame") throw new Error(`Unexpected ${operation}`);
    sourceRequests.push(params);
    if (sourceRequests.length === 1)
      return {
        ok: false,
        error: {
          code: "MEDIA_WORKER_UNAVAILABLE",
          message: "offline",
          retryable: true,
          details: {},
        },
      };
    await writeFile(params.output as string, payload);
    const asset = params.asset as { assetId: string; streamId: string };
    return {
      ok: true,
      data: {
        file: params.output,
        mediaType: "image/png",
        width: 2,
        height: 1,
        sourceWidth: 2,
        sourceHeight: 1,
        bytes: payload.length,
        decodedSamples: 1,
        readerOpens: 1,
        ...asset,
        requestedSourceUs: 0,
        actualSourceUs: 0,
        sample: {
          value: "0",
          timescale: 1000000,
          endValue: "10",
          endTimescale: 1000000,
          originUs: 0,
        },
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "tiny-segmented", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const assetId = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output.assetId;
  const selection = { assetId, streamId: "video:0", atUs: 0, maxLongEdge: 2 };
  let reads = vi.spyOn(DatabaseSync.prototype, "prepare");
  let jobId: string;
  try {
    const frame = await f.call("frame.get", selection);
    if (!frame.ok) throw new Error(JSON.stringify(frame));
    jobId = (frame.data as { jobId: string }).jobId;
    expect(await f.job(jobId, "failed")).toMatchObject({
      id: jobId,
      target: { kind: "asset", id: assetId },
      reason: "offline",
      retryable: true,
      errorCode: "MEDIA_WORKER_UNAVAILABLE",
      errorDetails: {},
      published: null,
    });
    // Only admission and execution need the source's complete physical support.
    expect
      .soft(
        reads.mock.calls.filter(([sql]) => sql.startsWith("SELECT value FROM asset_segments"))
          .length,
      )
      .toBeLessThanOrEqual(2);
  } finally {
    reads.mockRestore();
  }
  expect(sourceRequests).toEqual([
    {
      asset: { assetId, streamId: "video:0", path: f.service.assets.path(assetId), originUs: 0 },
      available: [{ startUs: 0, endUs: 10 }],
      atUs: 0,
      maxLongEdge: 2,
      output: expect.any(String),
    },
  ]);
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    expect(
      JSON.parse(
        catalog.catalog.prepare("SELECT input FROM jobs WHERE jobId=?").get(jobId!)!
          .input as string,
      ),
    ).toEqual({
      selection: { assetId, streamId: "video:0" },
      atUs: 0,
      maxLongEdge: 2,
      supportDigest: createHash("sha256").update(JSON.stringify(available)).digest("hex"),
      implementationId: "native-source-picture-v11-trail-policy",
    });
    reads = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      expect(await f.call("job.retry", { jobId: jobId! })).toMatchObject({
        ok: true,
        data: { id: jobId! },
      });
      expect(await f.job(jobId!, "ready")).toMatchObject({
        id: jobId!,
        target: { kind: "asset", id: assetId },
        published: {
          output: {
            assetId,
            streamId: "video:0",
            atUs: 0,
            requestedSourceUs: 0,
            actualSourceUs: 0,
            width: 2,
            height: 1,
            sizeBytes: payload.length,
          },
        },
      });
      // Execution support and receipt geometry remain detailed reads; cache publication is presence-only.
      expect
        .soft(
          reads.mock.calls.filter(([sql]) => sql.startsWith("SELECT value FROM asset_segments"))
            .length,
        )
        .toBeLessThanOrEqual(2);
    } finally {
      reads.mockRestore();
    }
    expect(sourceRequests[1]).toEqual({ ...sourceRequests[0], output: expect.any(String) });
    const ready = await f.call("frame.get", selection);
    if (!ready.ok) throw new Error(JSON.stringify(ready));
    const token = (ready.data as { delivery: { token: string } }).delivery.token;
    expect(
      await f.call("artifact.read", { token, offsetBytes: 0, maxBytes: payload.length }),
    ).toEqual({
      id: "test",
      ok: true,
      data: {
        data: payload.toString("base64"),
        offsetBytes: 0,
        nextOffsetBytes: payload.length,
        eof: true,
      },
    });
    expect(await f.call("artifact.close", { token })).toMatchObject({ ok: true });
    const inventory = () =>
      catalog.catalog.prepare("SELECT * FROM jobs ORDER BY queuedSequence").all();
    const prior = inventory();
    catalog.catalog
      .prepare("UPDATE asset_segments SET value=? WHERE assetId=? AND ordinal=0")
      .run("not parsed", assetId);
    expect
      .soft(await f.call("job.retry", { jobId: jobId! }))
      .toMatchObject({ ok: true, data: { id: jobId!, state: "ready" } });
    expect(await f.call("frame.get", selection)).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(inventory()).toEqual(prior);
    catalog.catalog.prepare("DELETE FROM assets WHERE id=?").run(assetId);
    expect(await f.call("job.retry", { jobId: jobId! })).toEqual({
      id: "test",
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Asset does not exist",
        retryable: false,
        details: { assetId },
      },
    });
    expect(inventory()).toEqual(prior);
  } finally {
    catalog.close();
  }
});

test("asset job diagnostics do not hydrate physical segment metadata", async () => {
  const f = await setup(async (operation) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              {
                ...metadata.streams[0],
                id: "video:0",
                kind: "video",
                codec: "h264",
                startUs: 0,
                endUs: 2000010,
                segments: Array.from({ length: 200001 }, (_, i) => ({
                  startUs: i * 10,
                  endUs: (i + 1) * 10,
                  empty: i % 2 === 0,
                  ...(i % 2 ? { mediaStartUs: Math.floor(i / 2) * 10, mediaDurationUs: 10 } : {}),
                })),
              },
            ],
          },
        }
      : {
          ok: false,
          error: {
            code: "MEDIA_WORKER_UNAVAILABLE",
            message: "offline",
            retryable: true,
            details: {},
          },
        },
  );
  const imported = await f.call("asset.import", { requestId: "segmented", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const assetId = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output.assetId;
  const frame = await f.call("frame.get", { assetId, streamId: "video:0", atUs: 10 });
  if (!frame.ok) throw new Error(JSON.stringify(frame));
  const jobId = (frame.data as { jobId: string }).jobId;
  const failed = await f.job(jobId, "failed");
  expect(failed).toMatchObject({ errorCode: "MEDIA_WORKER_UNAVAILABLE", reason: "offline" });
  // Observe valid segment-rich metadata before the separate damage/isolation control.
  const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    expect(await f.call("job.get", { jobId })).toEqual({ id: "test", ok: true, data: failed });
    const sql = reads.mock.calls.map(([statement]) => statement);
    expect(sql.some((statement) => /FROM assets WHERE id=/.test(statement))).toBe(true);
    expect(
      sql.filter((statement) => /asset_segments|SELECT metadata FROM assets/.test(statement)),
    ).toEqual([]);
  } finally {
    reads.mockRestore();
  }

  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  try {
    // Even damaged source detail must not hide an already recorded job failure.
    catalog.catalog
      .prepare("UPDATE asset_segments SET value=? WHERE assetId=?")
      .run("not parsed", assetId);
    expect(await f.call("job.get", { jobId })).toEqual({ id: "test", ok: true, data: failed });
  } finally {
    catalog.close();
  }
});

test("model discovery crosses the public wire before either model is prepared", async () => {
  const f = await setup(async () => ({ ok: true, data: {} }));
  expect(await f.call("model.list", {})).toMatchObject({
    ok: true,
    data: {
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "parakeet",
          purpose: "transcription",
          descriptorDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          id: "qwen3-tts-icl-v1",
          purpose: "voice",
          preparation: expect.objectContaining({ runtimeSourceRequired: true }),
        }),
      ]),
    },
  });
  expect(await f.call("model.status", { modelId: "qwen3-tts-icl-v1" })).toMatchObject({
    ok: true,
    data: { state: "unavailable" },
  });
});

test("model.remove reports exact model bytes, fences running requests, and rejects unknown models", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }));
  const modelRoot = join(f.home, "library", "models");
  for (const [relative, bytes] of [
    ["parakeet/revision/model.bin", 13],
    [".cache/parakeet/compiler.bin", 17],
    [".staging/parakeet/flight/model.bin", 19],
  ] as const) {
    const path = join(modelRoot, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes));
  }
  const before = await f.call("storage.usage", {});
  if (!before.ok) throw new Error(JSON.stringify(before));
  expect(before.data).toMatchObject({ modelBytes: 49 });
  const catalog = new Catalog(join(f.home, "library/catalog.sqlite"));
  const listed = await f.call("model.list", { limit: 1000 });
  if (!listed.ok) throw new Error(JSON.stringify(listed));
  const { models } = listed.data as { models: { id: string; modelDigest: string }[] };
  const digestOf = (modelId: string) => models.find((model) => model.id === modelId)!.modelDigest;
  // Stored the way transcription stores its job input: the model by content digest and repo pin.
  const input = JSON.stringify({
    selection: { assetId: "asset" },
    modelDigest: digestOf("parakeet"),
    pins: { model: "FluidInference/parakeet-tdt-0.6b-v3" },
  });
  const otherInput = JSON.stringify({ engine: { modelDigest: digestOf("qwen3-tts-icl-v1") } });
  catalog.catalog
    .prepare(
      "INSERT INTO jobs(jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,state,reason,errorCode,errorDetails,retryable,generation,queuedSequence,deferred,readmitted,inputSha256,input) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "running-model",
      "attempt",
      "asset",
      "asset",
      "",
      "fixture",
      "heavy",
      "running",
      null,
      null,
      null,
      1,
      1,
      999,
      0,
      0,
      createHash("sha256").update(input).digest("hex"),
      input,
    );
  expect(
    await f.call("model.remove", { requestId: "remove-in-use", modelId: "parakeet" }),
  ).toMatchObject({
    ok: false,
    error: { code: "MODEL_IN_USE", retryable: true, details: { modelId: "parakeet" } },
  });
  // A running job that uses a different model does not hold this one.
  catalog.catalog
    .prepare("UPDATE jobs SET input=?, inputSha256=? WHERE jobId=?")
    .run(otherInput, createHash("sha256").update(otherInput).digest("hex"), "running-model");
  const removed = await f.call("model.remove", { requestId: "remove-model", modelId: "parakeet" });
  expect(removed).toEqual({
    id: "test",
    ok: true,
    data: { id: "parakeet", deleted: true, freedBytes: 49 },
  });
  catalog.catalog
    .prepare(
      "INSERT INTO jobs(jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,state,reason,errorCode,errorDetails,retryable,generation,queuedSequence,deferred,readmitted,inputSha256,input) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "running-after-removal",
      "attempt",
      "asset",
      "asset",
      "",
      "fixture",
      "heavy",
      "running",
      null,
      null,
      null,
      1,
      1,
      999,
      0,
      0,
      createHash("sha256").update(input).digest("hex"),
      input,
    );
  expect(await f.call("model.remove", { requestId: "remove-model", modelId: "parakeet" })).toEqual(
    removed,
  );
  expect(
    await f.call("model.remove", { requestId: "remove-model", modelId: "qwen3-tts-icl-v1" }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  expect(await f.call("storage.usage", {})).toMatchObject({ ok: true, data: { modelBytes: 0 } });
  expect(await f.call("model.status", { modelId: "parakeet" })).toMatchObject({
    ok: true,
    data: { id: "parakeet", presence: "absent" },
  });
  expect(
    await f.call("model.remove", { requestId: "unknown-model", modelId: "missing" }),
  ).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", details: { kind: "model" } },
  });
  catalog.close();
});

test("preset reads cross the public wire", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }), undefined, {
    presets: { bundled: join(import.meta.dirname, "../../../presets") },
  });
  expect(await f.call("preset.list", {})).toMatchObject({
    ok: true,
    data: {
      presets: expect.arrayContaining([
        expect.objectContaining({ id: "studio-podcast", source: "bundled" }),
        expect.objectContaining({ id: "on-location-conversation", source: "bundled" }),
        expect.objectContaining({ id: "tactile-launch-film", source: "bundled" }),
      ]),
      refresh: { checkedAt: null, commit: null, error: null, available: [] },
      instructions: expect.any(Array),
    },
  });
  expect(await f.call("preset.get", { presetId: "tactile-launch-film" })).toMatchObject({
    ok: true,
    data: {
      id: "tactile-launch-film",
      text: expect.stringContaining("## Shoot"),
      path: expect.stringContaining("tactile-launch-film"),
      kitPath: expect.stringContaining("presets/kit"),
      guidePath: expect.stringContaining("presets/authoring/AUTHORING.md"),
      instructions: expect.arrayContaining([expect.stringContaining("tactile-launch-film")]),
    },
  });
  expect(await f.call("preset.get", { presetId: "missing-preset" })).toMatchObject({
    ok: false,
    error: { code: "PRESET_NOT_FOUND" },
  });
});

test("presets refresh at startup and on preset.update, pinned to one commit, over the public wire", async () => {
  const commit = "b".repeat(40);
  const text =
    "---\nid: wire-demo\nversion: 1\nname: Wire demo\ndescription: A preset served by the test.\n---\n\n## Any footage\n\nAdapt.\n\n## Shoot\n\nAnything.\n\n## Edit\n\nNothing.\n";
  const index = {
    format: 1,
    packages: [
      {
        id: "wire-demo",
        kind: "preset",
        name: "Wire demo",
        description: "A preset served by the test.",
        version: 1,
        files: [
          {
            path: "PRESET.md",
            bytes: Buffer.byteLength(text),
            sha256: createHash("sha256").update(text).digest("hex"),
          },
        ],
      },
    ],
  };
  const replies: Record<string, string> = {
    "https://api.test/repos/dzhng/yap/commits/main": commit,
    [`https://raw.test/dzhng/yap/${commit}/presets/index.json`]: JSON.stringify(index),
    [`https://raw.test/dzhng/yap/${commit}/presets/wire-demo/PRESET.md`]: text,
  };
  const requested: string[] = [];
  const fetch = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    return replies[url] === undefined
      ? new Response("missing", { status: 404 })
      : new Response(replies[url]);
  }) as typeof globalThis.fetch;
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }), undefined, {
    presets: { refresh: { apiBase: "https://api.test", rawBase: "https://raw.test", fetch } },
  });
  const updated = await f.call("preset.update", { requestId: "preset-update-replay" });
  expect(updated).toMatchObject({
    ok: true,
    // The startup refresh may already have installed it; either way the result says what to do.
    data: { refresh: { commit, error: null }, instructions: [expect.any(String)] },
  });
  expect(await f.call("preset.update", { requestId: "preset-update-replay" })).toEqual(updated);
  expect(
    await f.call("preset.update", { requestId: "preset-update-replay", presetId: "other" }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  expect(await f.call("preset.list", {})).toMatchObject({
    ok: true,
    data: { presets: [expect.objectContaining({ id: "wire-demo", source: "downloaded" })] },
  });
  expect(
    requested
      .filter((url) => url.startsWith("https://raw.test"))
      .every((url) => url.includes(commit)),
  ).toBe(true);
});

test("a local preset is created, read and trashed over the public wire", async () => {
  const trashed: string[] = [];
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }), undefined, {
    presets: {
      bundled: join(import.meta.dirname, "../../../presets"),
      trash: async (path) => void trashed.push(path),
    },
  });
  const created = await f.call("preset.create", {
    requestId: "preset-create-replay",
    name: "Vertical explainer",
    references: ["https://example.com/v"],
  });
  expect(created).toMatchObject({
    ok: true,
    data: {
      id: "vertical-explainer",
      path: expect.stringContaining("presets/vertical-explainer"),
      instructions: expect.any(Array),
    },
  });
  expect(
    await f.call("preset.create", {
      requestId: "preset-create-replay",
      name: "Vertical explainer",
      references: ["https://example.com/v"],
    }),
  ).toEqual(created);
  expect(
    await f.call("preset.create", { requestId: "preset-create-replay", name: "Different" }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  expect(await f.call("preset.create", { name: "Vertical explainer" })).toMatchObject({
    ok: true,
    data: { id: "vertical-explainer-2" },
  });
  expect(await f.call("preset.list", {})).toMatchObject({
    ok: true,
    data: {
      presets: expect.arrayContaining([
        expect.objectContaining({ id: "vertical-explainer", source: "local" }),
      ]),
    },
  });
  expect(await f.call("preset.get", { presetId: "vertical-explainer" })).toMatchObject({
    ok: true,
    data: { source: "local", text: expect.stringContaining("https://example.com/v") },
  });
  expect(await f.call("preset.create", { name: "Bad", references: ["notes.txt"] })).toMatchObject({
    ok: false,
    error: { code: "PRESET_REFERENCE_INVALID" },
  });
  expect(await f.call("preset.delete", { presetId: "studio-podcast" })).toMatchObject({
    ok: false,
    error: { code: "PRESET_NOT_LOCAL" },
  });
  const deletedPreset = await f.call("preset.delete", {
    presetId: "vertical-explainer",
    requestId: "preset-delete-replay",
  });
  expect(deletedPreset).toMatchObject({
    ok: true,
    data: { trashedPaths: [expect.stringContaining("vertical-explainer")] },
  });
  expect(
    await f.call("preset.delete", {
      presetId: "vertical-explainer",
      requestId: "preset-delete-replay",
    }),
  ).toEqual(deletedPreset);
  expect(
    await f.call("preset.delete", { presetId: "other", requestId: "preset-delete-replay" }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  expect(trashed).toHaveLength(1);
});

test("a persisted queued voice request reaches its initialized owner after startup recovery", async () => {
  const f = await setup(async () => {
    throw Error("No native media execution expected");
  });
  await f.service.close();
  const library = join(f.home, "library"),
    catalog = new Catalog(join(library, "catalog.sqlite"));
  const assets = new AssetStore(catalog, library),
    registry = new Models(library, globalThis.fetch, undefined, catalog);
  const model = registry.list().find((value) => value.id === voiceProfile.id)!;
  const bytes = Buffer.alloc(44 + 24000 * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(96000, 40);
  const path = join(f.home, "reference.wav");
  await writeFile(path, bytes);
  const probe = async () => ({
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "audio",
        codec: "lpcm",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
        sampleRate: 24000,
        channels: 1,
      },
    ],
  });
  const reference = await assets.import(path, { kind: "import" }, probe);
  const queued = new JobQueue({
    store: catalog,
    deferExecution: true,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw Error("asset");
        assets.get(target.id);
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: async () => {
      throw Error("The seeding owner never executes");
    },
  });
  const owner = new VoiceGenerationJobs({
    assets,
    jobs: queued,
    probe,
    staging: join(library, "staging", "voice-generation"),
    models: {
      list: () => registry.list(),
      runtime: async () => ({
        python: "unused",
        entry: "unused",
        model: "unused",
        cache: "unused",
        descriptorDigest: model.descriptorDigest,
        runtimeDigest: model.runtimeDigest!,
        modelDigest: model.modelDigest,
        runtimeRevision: model.pins.runtimeRevision,
        modelRevision: model.pins.modelRevision,
      }),
    },
    generate: async () => {
      throw Error("The seeding owner never generates");
    },
  });
  const request = await owner.request({
    modelId: model.id,
    reference: { assetId: reference.id, streamId: "track:1" },
    referenceText: "A complete reference sentence.",
    text: "A complete desired sentence.",
  });
  expect(queued.job(request.jobId!).state).toBe("queued");
  await queued.close();
  catalog.close();
  const service = await startProjectService({
    home: f.home,
    nativeExecutable: undefined,
    worker: probeFileFixture(f.home, async () => {
      throw Error("No model execution expected");
    }),
  });
  cleanups.push(() => service.close());
  await expect
    .poll(() =>
      callLocal(service.socketPath, {
        id: "queued",
        operation: "job.get",
        params: { jobId: request.jobId! },
      }),
    )
    .toMatchObject({
      ok: true,
      data: {
        state: "failed",
        errorCode: "MODEL_NOT_PREPARED",
        reason: expect.stringContaining("model.prepare will download/acquire and verify"),
      },
    });
});

test("an agent's inspect.open hands the app the project's name for its preview window", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => ({ ok: true, data: {} }));
  const forwarded: Record<string, unknown>[] = [];
  f.events.on("call", ({ request }) => {
    if (request.operation === "inspect.open") forwarded.push(request.params);
    f.input.write(
      JSON.stringify({
        event: "result",
        response: { id: request.id, ok: true, data: { opened: true } },
      }) + "\n",
    );
  });
  const created = await f.call("project.create", {
    requestId: "named",
    title: "Launch video",
    canvas: {
      width: 64,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const projectId = (created.data as { project: { id: string } }).project.id;
  expect(await f.call("inspect.open", { projectId })).toMatchObject({
    ok: true,
    data: { native: { opened: true } },
  });
  expect(forwarded).toMatchObject([{ projectId, title: "Launch video" }]);
});

test("unsupported service-local correspondence package reads are permanent input refusals", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({ ok: true, data: {} }));
  expect(
    await f.call("correspondence.get", {
      packageHandle: "caller-package",
      evidenceId: "evidence",
      generation: "generation",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", retryable: false } });
});
