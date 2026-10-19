import { omit } from "@yap/composition";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { portableProjectIndexMetadataSchema } from "./project-index.js";
import { expect, test } from "vitest";
import { fixture, gate, png } from "./index-processing.fixture.js";
import { CatalogError } from "./catalog.js";
import { ResourceReferences } from "./references.js";
import { sceneGenerationResource } from "./scene-evidence.js";

function silence(f: Awaited<ReturnType<typeof fixture>>, endUs = 1200000) {
  return f.projects.apply(f.projectId, {
    requestId: "silence",
    expectedRevisionId: f.projects.get(f.projectId).currentRevisionId,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs } },
        },
      },
    ],
  });
}
function videos(f: Awaited<ReturnType<typeof fixture>>) {
  return f.projects.apply(f.projectId, {
    requestId: "video",
    expectedRevisionId: f.projects.get(f.projectId).currentRevisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
      ...["v", "w"].map((streamId, i) => ({
        operation: "place" as const,
        clip: {
          trackId: { label: "video" },
          assetId: f.selection.assetId,
          streamId,
          source: { kind: "range" as const, range: { startUs: 0, endUs: 1200000 } },
          placement: {
            kind: "project" as const,
            range: { startUs: i * 1200000, endUs: (i + 1) * 1200000 },
          },
        },
      })),
    ],
  });
}

test("empty and audio-only projects execute through the shared queue without source analysis", async () => {
  const f = await fixture({
    beforeScene: () => {
      throw new Error("no source analysis needed");
    },
  });
  const empty = f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  expect(f.jobs.job(empty.jobId!).state).toBe("ready");
  expect(f.index.requestProject({ projectId: f.projectId }).published!.evidence).toMatchObject({
    candidateCount: 0,
    coverageCount: 0,
    durationUs: 0,
  });
  expect(f.calls).toBe(0);
  silence(f, 1123456);
  const requested = f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  expect(f.jobs.job(requested.jobId!)).toMatchObject({ state: "ready", lane: "heavy" });
  const metadata = f.index.requestProject({ projectId: f.projectId }).published!.evidence;
  const page = f.projectRetained.page({ identity: metadata });
  expect(page.entries.map((entry) => entry.candidate.sampleAtUs)).toEqual([0, 1000000]);
  expect(
    page.entries.every((entry) => !entry.frame.frame.layers.length && !entry.frame.pictures.length),
  ).toBe(true);
  expect(
    f.projectRetained
      .coveragePage({ identity: metadata })
      .coverage.map((row) => omit(row, "sequence")),
  ).toEqual([
    { ordinal: 0, equality: "sampled", project: { startUs: 0, endUs: 200000 } },
    { ordinal: null, equality: "unproven", project: { startUs: 200000, endUs: 1000000 } },
    { ordinal: 1, equality: "sampled", project: { startUs: 1000000, endUs: 1123456 } },
  ]);
});

test("face observation requests reach project index frame materialization", async () => {
  const f = await fixture();
  videos(f);
  const faceObservations = { recipe: "vision-face-rectangles-v1" as const };
  f.index.requestProject({ projectId: f.projectId, faceObservations });
  await f.jobs.idle();
  f.index.requestProject({ projectId: f.projectId, faceObservations });
  await f.jobs.idle();
  const result = f.index.requestProject({ projectId: f.projectId, faceObservations });
  expect(result.state).toBe("ready");
  expect(result.published!.evidence.faceObservationRequest).toEqual(faceObservations);
  expect(
    f.projectRetained.page({ identity: result.published!.evidence }).entries[0]!.frame
      .faceObservations,
  ).toMatchObject({ status: "available", faces: [{ id: "face-0" }] });
});

test("a project face index retained before the noun-ID cutover is refused by generation and regenerates on request", async () => {
  const f = await fixture();
  videos(f);
  const faceObservations = { recipe: "vision-face-rectangles-v1" as const };
  f.index.requestProject({ projectId: f.projectId, faceObservations });
  await f.jobs.idle();
  f.index.requestProject({ projectId: f.projectId, faceObservations });
  await f.jobs.idle();
  const before = f.index.getProject({ projectId: f.projectId, faceObservations, limit: 1 });
  const reference = before.page!.entries[0]!.reference;
  // 0.1.61 retained faces named `faceId` under its own renderer pin.
  const rows = f.catalog.catalog
    .prepare("SELECT rowid,frame FROM screenshot_index_entries")
    .all() as { rowid: number; frame: string }[];
  for (const row of rows)
    f.catalog.catalog
      .prepare("UPDATE screenshot_index_entries SET frame=? WHERE rowid=?")
      .run(row.frame.replaceAll('"id":"face-', '"faceId":"face-'), row.rowid);
  expect(rows.some((row) => row.frame.includes('"id":"face-'))).toBe(true);
  await f.restart("renderer-after-cutover");

  const stale = (read: () => unknown) => {
    try {
      read();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect(error).toMatchObject({ code: "ARTIFACT_CHANGED" });
      return;
    }
    throw new Error("Pre-cutover evidence was projected under the current names");
  };
  stale(() => f.index.frameProject(reference));
  stale(() =>
    f.index.getProject({ projectId: f.projectId, cursor: before.page!.nextCursor!, limit: 1 }),
  );
  const fresh = f.index.requestProject({ projectId: f.projectId, faceObservations });
  expect(fresh.published).toBeNull();
  await f.jobs.idle();
  const ready = f.index.getProject({ projectId: f.projectId, faceObservations, limit: 1 });
  expect(ready.page!.metadata.generation).not.toBe(reference.generation);
  expect(ready.page!.entries[0]!.frame.faceObservations).toMatchObject({
    faces: [{ id: "face-0" }],
  });
});

test("a project index over text that fell back to another face publishes the frames' font issues", async () => {
  const f = await fixture({ textFallback: { face: "AppleColorEmoji", codePoint: 0x1f600 } });
  videos(f);
  const fontPath = join(f.home, "pinned.ttf");
  await writeFile(fontPath, "pinned font bytes");
  const font = await f.assets.import(fontPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    fontFaces: [{ postScriptName: "Pinned", familyName: "Pinned" }],
  }));
  const placed = f.projects.apply(f.projectId, {
    requestId: "caption",
    expectedRevisionId: f.projects.get(f.projectId).currentRevisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "captions" },
      {
        operation: "place",
        label: "caption",
        clip: {
          trackId: { label: "captions" },
          source: {
            kind: "text",
            text: "A\u{1F600}",
            font: { assetId: font.id, postScriptName: "Pinned" },
            width: 1,
            height: 1,
            size: 1,
            color: "#ffffffff",
            alignment: "left",
            wrap: true,
          },
          placement: { kind: "project", range: { startUs: 0, endUs: 2400000 } },
        },
      },
    ],
  });
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  const result = f.index.requestProject({ projectId: f.projectId });
  expect(result.state).toBe("ready");
  // Every candidate frame draws the same caption; the index reports its fallback once.
  expect(result.published!.issues).toEqual([
    {
      code: "font-substituted",
      message: expect.any(String),
      evidence: {
        clipId: placed.edit.labels["caption"],
        requested: { assetId: font.id, postScriptName: "Pinned" },
        used: "AppleColorEmoji",
        codePoints: [0x1f600],
      },
    },
  ]);

  // Adopting the retained index (as a package import does) keeps its issues: they follow from
  // the retained frames, not from a default.
  const metadata = result.published!.evidence;
  const publication = f.index.portableProject(metadata);
  f.jobs.forgetJob(result.jobId!);
  f.catalog.transaction(() => f.index.adoptProjectPublication(metadata, metadata, publication));
  const adopted = f.index.requestProject({ projectId: f.projectId });
  expect(adopted).toMatchObject({ state: "ready", published: { evidence: metadata } });
  expect(adopted.published!.issues).toEqual(result.published!.issues);
});

test("project recipes pin both selected scene generations while queued and retain independent PNGs", async () => {
  const barrier = gate(),
    f = await fixture({ barrier });
  videos(f);
  const pending = f.index.requestProject({ projectId: f.projectId });
  expect(pending.jobId).toBeNull();
  expect(pending.dependencies.map((d) => d.streamId)).toEqual(["v", "w"]);
  await f.jobs.idle();
  f.jobs.submit({
    target: { kind: "asset", id: f.selection.assetId },
    artifact: "barrier",
    lane: "heavy",
    input: "hold",
  });
  const request = f.index.requestProject({ projectId: f.projectId });
  const recipe = JSON.parse(f.jobs.job(request.jobId!).input);
  expect(
    recipe.scenes.map((scene: { source: { streamId: string } }) => scene.source.streamId),
  ).toEqual(["v", "w"]);
  for (const scene of recipe.scenes) {
    expect(f.index.retainsSourceScenes(f.selection.assetId, scene.generation)).toBe(true);
    expect(f.index.retainsSourceScenes("another-asset", scene.generation)).toBe(false);
    await f.records.reclaim(scene.owner, (generation) =>
      f.index.retainsSourceScenes(f.selection.assetId, generation),
    );
    expect(f.records.sourcePage({ identity: scene }).metadata.generation).toBe(scene.generation);
  }
  barrier.resolve();
  await f.jobs.idle();
  const status = f.index.requestProject({ projectId: f.projectId });
  expect(status.state).toBe("ready");
  const metadata = status.published!.evidence;
  const page = f.projectRetained.page({ identity: metadata });
  expect(page.entries.map((e) => e.frame.atUs)).toContain(1200000);
  const missingSource = page.entries.find((entry) =>
    entry.frame.pictures.some((picture) => picture.status === "unavailable"),
  )!;
  expect(missingSource).toBeDefined();
  expect(
    f.projectRetained
      .coveragePage({ identity: metadata })
      .coverage.find((row) => row.ordinal === missingSource.candidate.ordinal),
  ).toMatchObject({ equality: "sampled", project: missingSource.candidate.visibleRange });
  const refs = new ResourceReferences(f.catalog);
  for (const scene of recipe.scenes) {
    expect(refs.owners("scene-generation", sceneGenerationResource(scene))).toEqual([]);
    await f.records.remove(scene);
  }
  for (const row of f.catalog.catalog.prepare("SELECT id FROM derived_cache").all())
    f.cache.remove(row.id as string);
  const reader = f.projectRetained.openRead(metadata, 0);
  const bytes = Buffer.alloc(reader.bytes);
  reader.read(bytes, 0);
  reader.release();
  expect(bytes).toEqual(png);
  expect(f.projectRetained.page({ identity: metadata }).metadata).toEqual(metadata);
});

test("failed project frames keep both scene inputs until an explicit retry succeeds", async () => {
  const f = await fixture({
    beforeFrame: async (call) => {
      if (call === 1) throw new CatalogError("MEDIA_WORKER_FAILED", "fixture decoder failed", {});
    },
  });
  videos(f);
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  const pending = f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  expect(f.jobs.job(pending.jobId!)).toMatchObject({ state: "failed", retryable: true });
  const recipe = JSON.parse(f.jobs.job(pending.jobId!).input);
  for (const scene of recipe.scenes)
    expect(f.index.retainsSourceScenes(f.selection.assetId, scene.generation)).toBe(true);
  expect(f.index.requestProject({ projectId: f.projectId }).state).toBe("failed");
  expect(f.calls).toBe(1);
  const retry = f.index.retryProject({ projectId: f.projectId });
  expect(retry.jobId).toBe(pending.jobId);
  await f.jobs.idle();
  expect(f.index.requestProject({ projectId: f.projectId }).state).toBe("ready");
  for (const scene of recipe.scenes)
    expect(f.index.retainsSourceScenes(f.selection.assetId, scene.generation)).toBe(false);
});

test("canceling a materializer removes partial coverage and preserves its pinned retry recipe", async () => {
  const held = gate(),
    entered = gate();
  const f = await fixture({
    beforeFrame: async (call) => {
      if (call === 2) {
        entered.resolve();
        await held.promise;
      }
    },
  });
  try {
    videos(f);
    f.index.requestProject({ projectId: f.projectId });
    await f.jobs.idle();
    const pending = f.index.requestProject({ projectId: f.projectId });
    await entered.promise;
    const original = f.jobs.job(pending.jobId!);
    f.jobs.cancel(original.jobId);
    held.resolve();
    await f.jobs.idle();
    const identity = { ...JSON.parse(original.input), generation: original.attemptId };
    expect(() => f.projectRetained.page({ identity })).toThrow();
    for (const scene of identity.scenes)
      expect(f.index.retainsSourceScenes(f.selection.assetId, scene.generation)).toBe(true);
    f.index.retryProject({ projectId: f.projectId });
    await f.jobs.idle();
    const completed = f.index.requestProject({ projectId: f.projectId }).published!.evidence;
    expect(completed.generation).not.toBe(original.attemptId);
    expect(completed.scenes).toEqual(identity.scenes);
    expect(f.projectRetained.page({ identity: completed }).entries[0]!.candidate.ordinal).toBe(0);
  } finally {
    held.resolve();
  }
});

test("an overloaded single-frame reason row refuses before any project picture work", async () => {
  const f = await fixture({ continuousSupport: true, changingScenes: true });
  f.projects.apply(f.projectId, {
    requestId: "layers",
    expectedRevisionId: f.projects.get(f.projectId).currentRevisionId,
    operations: Array.from({ length: 200 }, (_, index) => {
      const order = index,
        label = `track-${order}`;
      return [
        { operation: "track.add" as const, track: { kind: "video" as const, order }, label },
        {
          operation: "place" as const,
          clip: {
            trackId: { label },
            assetId: f.selection.assetId,
            streamId: "v",
            source: { kind: "range" as const, range: { startUs: 0, endUs: 1200000 } },
            placement: { kind: "project" as const, range: { startUs: 0, endUs: 120000 } },
          },
        },
      ];
    }).flat(),
  });
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  const pending = f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  expect(f.jobs.job(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "LIMIT_EXCEEDED",
    errorDetails: { limitKind: "index-record-bytes", maximum: 262144 },
    retryable: false,
  });
  expect(f.calls).toBe(0);
  expect(
    f.catalog.catalog.prepare("SELECT 1 FROM jobs WHERE artifact='frame'").get(),
  ).toBeUndefined();
  const recipe = JSON.parse(f.jobs.job(pending.jobId!).input);
  expect(
    new ResourceReferences(f.catalog).owners(
      "scene-generation",
      sceneGenerationResource(recipe.scenes[0]),
    ),
  ).toEqual([]);
});

test("coordinator restart preserves interrupted index inputs and retries its interrupted frame child", async () => {
  const entered = gate();
  const f = await fixture({
    beforeFrame: async (call, signal) => {
      if (call === 1) {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  });
  videos(f);
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  const pending = f.index.requestProject({ projectId: f.projectId });
  await entered.promise;
  const recipe = JSON.parse(f.jobs.job(pending.jobId!).input);
  await f.restart();
  expect(f.jobs.job(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "JOB_INTERRUPTED",
    retryable: true,
  });
  for (const scene of recipe.scenes)
    expect(f.index.retainsSourceScenes(f.selection.assetId, scene.generation)).toBe(true);
  expect(f.index.requestProject({ projectId: f.projectId }).state).toBe("failed");
  f.index.retryProject({ projectId: f.projectId });
  await f.jobs.idle();
  const result = f.index.requestProject({ projectId: f.projectId });
  expect(result.state).toBe("ready");
  expect(result.published!.evidence.scenes).toEqual(recipe.scenes);
  const read = f.projectRetained.openRead(result.published!.evidence, 0);
  try {
    const bytes = Buffer.alloc(read.bytes);
    read.read(bytes, 0);
    expect(bytes).toEqual(png);
  } finally {
    read.release();
  }
});

test("published project readers keep old tap, renderer, and scene pins across later edits and reclamation", async () => {
  const f = await fixture();
  videos(f);
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  const first = f.index.getProject({ projectId: f.projectId, limit: 1 });
  expect(first.page!.nextCursor).not.toBeNull();
  const metadata = first.page!.metadata,
    reference = first.page!.entries[0]!.reference;
  for (const scene of metadata.scenes) await f.records.remove(scene);
  for (const row of f.catalog.catalog.prepare("SELECT id FROM derived_cache").all())
    f.cache.remove(row.id as string);
  silence(f, 3000000);
  await f.restart("changed-renderer");
  const continued = f.index.getProject({
    projectId: f.projectId,
    cursor: first.page!.nextCursor!,
    limit: 1,
  });
  expect(continued.page!.metadata).toEqual(metadata);
  expect(continued.page!.entries[0]!.candidate.ordinal).toBe(1);
  expect(f.index.frameProject(reference).published.frame.implementationId).toBe("fixture-project");
  expect(f.index.coverageProject(reference).coverage[0]).toMatchObject({
    ordinal: 0,
    equality: "sampled",
  });
  expect(() => f.index.frameProject({ ...reference, maxLongEdge: 800 })).toThrow(
    "another selection",
  );
  expect(() =>
    f.index.getProject({
      projectId: f.projectId,
      cursor: {
        ...first.page!.nextCursor!,
        tap: { target: { kind: "output" }, point: { kind: "dry" } },
      },
    }),
  ).toThrow();
  const reader = f.index.openReadProject(reference);
  f.projects.markDeleting(f.projectId);
  expect(() => f.index.frameProject(reference)).toThrow("does not exist");
  expect(() =>
    f.index.getProject({ projectId: f.projectId, cursor: first.page!.nextCursor! }),
  ).toThrow("does not exist");
  const bytes = Buffer.alloc(reader.bytes);
  reader.read(bytes, 0);
  reader.release();
  expect(bytes).toEqual(png);
});

test("an oversized pinned identity refuses admission without a job or input references", async () => {
  const f = await fixture({ projectImplementationId: "renderer-" + "x".repeat(262144) });
  silence(f);
  expect(() => f.index.requestProject({ projectId: f.projectId })).toThrowError(
    expect.objectContaining({
      code: "LIMIT_EXCEEDED",
      details: expect.objectContaining({ limitKind: "index-record-bytes" }),
    }),
  );
  expect(f.catalog.catalog.prepare("SELECT 1 FROM jobs").get()).toBeUndefined();
  expect(
    f.catalog.catalog
      .prepare("SELECT 1 FROM resource_references WHERE ownerKind='job-input'")
      .get(),
  ).toBeUndefined();
  expect(f.calls).toBe(0);
});

test("portable project publication preserves scene-owned recipe ordering across schema parsing", async () => {
  const f = await fixture();
  videos(f);
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  f.index.requestProject({ projectId: f.projectId });
  await f.jobs.idle();
  const original = f.index.requestProject({ projectId: f.projectId }).published!.evidence;
  const publication = f.index.portableProject(original)!;
  const parsed = portableProjectIndexMetadataSchema.parse(original);
  expect(parsed).toEqual(original);
  f.jobs.forgetJob(f.index.requestProject({ projectId: f.projectId }).jobId!);
  f.index.adoptProjectPublication(parsed, parsed, publication);
  expect(f.index.getProject({ projectId: f.projectId }).page!.metadata.generation).toBe(
    original.generation,
  );
  await f.jobs.idle();
  expect(f.index.getProject({ projectId: f.projectId }).page!.metadata.generation).toBe(
    original.generation,
  );
  expect(() =>
    f.index.adoptProjectPublication(parsed, parsed, {
      ...publication,
      input: JSON.stringify({ ...JSON.parse(publication.input), maxLongEdge: 1 }),
    }),
  ).toThrow("recipe differs");
  const reference = { ...original, ordinal: 0 };
  f.index.openReadProject(reference).release();
  await unlink(f.projectRetained.readEntry(original, 0).frame.file);
  expect(() => f.index.openReadProject(reference)).toThrow();
  await f.jobs.idle();
  expect(f.index.getProject({ projectId: f.projectId }).page!.metadata.generation).toBe(
    original.generation,
  );
});
