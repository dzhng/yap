import { omit } from "@yap/composition";
import type { SourceSelection } from "./source-selection.js";
import { portableSourceIndexMetadataSchema } from "./source-index.js";
import { expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { sourceIndexPolicy } from "./source-index-selection.js";
import { encodeIndexRecord } from "./screenshot-index.js";
import { readFile, unlink } from "node:fs/promises";
import { CatalogError } from "./catalog.js";
import { fixture, gate, png } from "./index-processing.fixture.js";
import { expectPageTraversal } from "./page-traversal.fixture.js";
function acquiredSelection(f: Awaited<ReturnType<typeof fixture>>) {
  const selection = { ...f.selection, acquisitionId: "selection" };
  f.catalog.catalog.prepare("INSERT OR REPLACE INTO acquisitions VALUES(?,?,?,?)").run(
    selection.acquisitionId,
    "fixture",
    JSON.stringify({ kind: "import", path: f.home, files: {} }),
    JSON.stringify({
      id: selection.acquisitionId,
      bindings: [
        {
          ...f.selection,
          available: [
            { startUs: 200000, endUs: 400000 },
            { startUs: 600000, endUs: 1000000 },
          ],
        },
      ],
    }),
  );
  return selection;
}
function observeSourceMetadata(f: Awaited<ReturnType<typeof fixture>>) {
  const work = { headers: 0, segments: 0, acquisitions: 0 };
  const prepare = f.catalog.catalog.prepare.bind(f.catalog.catalog);
  f.catalog.catalog.prepare = (sql, ...options) => {
    const statement = prepare(sql, ...options);
    const key = sql.startsWith("SELECT metadata FROM assets")
      ? "headers"
      : sql.includes(" FROM asset_segments ")
        ? "segments"
        : sql.startsWith("SELECT metadata FROM acquisitions")
          ? "acquisitions"
          : null;
    if (key === "segments") {
      const read = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        work.segments++;
        return read(...args);
      });
    } else if (key) {
      const read = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...args) => {
        work[key]++;
        return read(...args);
      });
    }
    return statement;
  };
  return {
    work,
    restore: () => {
      f.catalog.catalog.prepare = prepare;
      vi.restoreAllMocks();
    },
  };
}
async function assertSourceIndex(
  f: Awaited<ReturnType<typeof fixture>>,
  selection: SourceSelection,
) {
  const result = f.index.getSource(selection);
  expect(result.state).toBe("ready");
  const metadata = result.page!.metadata;
  const scenes = f.scenes.sourceStatus(selection).published!.evidence;
  expect(scenes.source).toEqual({
    kind: "asset",
    streamId: "v",
    ...(selection.acquisitionId === undefined ? {} : { acquisitionId: selection.acquisitionId }),
    originUs: 1250000,
    durationUs: 1200000,
    supportDigest: createHash("sha256")
      .update(
        JSON.stringify([
          { startUs: 200000, endUs: 400000 },
          { startUs: 600000, endUs: 1000000 },
        ]),
      )
      .digest("hex"),
  });
  const recipe = {
    ...selection,
    scenes,
    selectionPolicy: sourceIndexPolicy.id,
    implementationId: "fixture-frame",
    maxLongEdge: 1600,
  };
  const publication = f.index.portableSource(metadata)!;
  expect(publication.input).toBe(encodeIndexRecord(recipe));
  expect(metadata).toEqual({
    ...recipe,
    generation: publication.attemptId,
    durationUs: 1200000,
    candidateCount: 4,
    coverageCount: 7,
    sizeBytes: 4 * png.length,
  });
  expect(
    result.page!.entries.map(({ candidate, frame }) => [
      candidate.requestedSourceUs,
      frame.actualSourceUs,
    ]),
  ).toEqual([
    [200000, 200000],
    [399999, 200000],
    [600000, 600000],
    [999999, 800000],
  ]);
  const reference = { ...selection, generation: metadata.generation };
  const coverage = f.index.coverageSource({ ...reference, limit: 100 }).coverage;
  expect(coverage).toEqual(
    (
      [
        [null, 0, 200000, "support"],
        [0, 200000, 399999, "sampled"],
        [1, 399999, 400000, "unproven"],
        [null, 400000, 600000, "support"],
        [2, 600000, 999999, "sampled"],
        [3, 999999, 1000000, "unproven"],
        [null, 1000000, 1200000, "support"],
      ] as const
    ).map(([ordinal, startUs, endUs, evidence], sequence) => ({
      sequence,
      ordinal,
      source: { startUs, endUs },
      ...(ordinal === null
        ? { state: "unavailable", basis: evidence }
        : { state: "available", equality: evidence }),
    })),
  );
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const read = f.index.openReadSource({ ...reference, ordinal });
    try {
      const bytes = Buffer.alloc(read.bytes);
      read.read(bytes, 0);
      expect(bytes).toEqual(png);
    } finally {
      read.release();
    }
  }
  expect(await readFile(f.path, "utf8")).toBe("immutable fixture media");
  return { result, publication, coverage };
}
test("ready source index requests resolve complete frame plans with bounded reads", async () => {
  const f = await fixture();
  const selection = acquiredSelection(f);
  f.index.requestSource(selection);
  await f.jobs.idle();
  f.index.requestSource(selection);
  await f.jobs.idle();
  const delivered = await assertSourceIndex(f, selection);
  const before = f.index.requestSource(selection);
  const calls = f.calls;
  const { work, restore } = observeSourceMetadata(f);
  let result;
  try {
    result = f.index.requestSource(selection);
  } finally {
    restore();
  }
  expect(result).toEqual(before);
  expect(result.published!.evidence).toEqual(delivered.result.page!.metadata);
  expect(f.calls).toBe(calls);
  for (const [key, maximum] of Object.entries({ headers: 6, segments: 3, acquisitions: 3 })) {
    expect(work[key as keyof typeof work]).toBeGreaterThan(0);
    expect(work[key as keyof typeof work]).toBeLessThanOrEqual(maximum);
  }
});

test("face observation requests reach source index frame materialization", async () => {
  const f = await fixture();
  const selection = acquiredSelection(f);
  const faceObservations = { recipe: "vision-face-rectangles-v1" as const };
  f.index.requestSource({ ...selection, faceObservations });
  await f.jobs.idle();
  f.index.requestSource({ ...selection, faceObservations });
  await f.jobs.idle();
  const result = f.index.requestSource({ ...selection, faceObservations });
  expect(result.state).toBe("ready");
  expect(result.published!.evidence.faceObservationRequest).toEqual(faceObservations);
  expect(result.published!.evidence.candidateCount).toBeGreaterThan(0);
  expect(
    f.retained.page({ identity: result.published!.evidence }).entries[0]!.frame.faceObservations,
  ).toMatchObject({ status: "available", faces: [{ id: "face-0" }] });
  const first = f.index.getSource({ ...selection, faceObservations, limit: 1 });
  expect(first.page?.nextCursor).toBeDefined();
  expect(
    f.index.getSource({
      ...selection,
      faceObservations,
      cursor: first.page!.nextCursor!,
      limit: 1,
    }).page?.entries,
  ).toHaveLength(1);
});
test("a source face index retained before the noun-ID cutover is refused, not projected, by generation", async () => {
  const f = await fixture();
  const selection = acquiredSelection(f);
  const faceObservations = { recipe: "vision-face-rectangles-v1" as const };
  f.index.requestSource({ ...selection, faceObservations });
  await f.jobs.idle();
  f.index.requestSource({ ...selection, faceObservations });
  await f.jobs.idle();
  const { generation } = f.index.requestSource({ ...selection, faceObservations }).published!
    .evidence;
  const rows = f.catalog.catalog
    .prepare("SELECT rowid,frame FROM screenshot_index_entries")
    .all() as { rowid: number; frame: string }[];
  expect(rows.some((row) => row.frame.includes('"id":"face-'))).toBe(true);
  for (const row of rows)
    f.catalog.catalog
      .prepare("UPDATE screenshot_index_entries SET frame=? WHERE rowid=?")
      .run(row.frame.replaceAll('"id":"face-', '"faceId":"face-'), row.rowid);
  await f.restart();
  // face.trajectory.get and index.get/index.frame read a named generation through these paths.
  for (const read of [
    () => f.index.getSource({ ...selection, faceObservations, generation }),
    () => f.index.frameSource({ ...selection, generation, ordinal: 0 }),
  ])
    expect(read).toThrow(
      expect.objectContaining({ code: "ARTIFACT_CHANGED" }) as unknown as CatalogError,
    );
});
test("source index execution rechecks current authority before cancellation", async () => {
  const barrier = gate();
  const f = await fixture({ barrier });
  const selection = acquiredSelection(f);
  f.scenes.prepareSource(selection);
  await f.jobs.idle();
  f.jobs.submit({
    target: { kind: "asset", id: selection.assetId },
    artifact: "barrier",
    input: "hold",
    lane: "heavy",
  });
  const queued = f.index.requestSource(selection);
  const job = f.jobs.job(queued.jobId!);
  expect(job.state).toBe("queued");
  const canceled = Error("stop after synchronous source-index validation");
  const { work, restore } = observeSourceMetadata(f);
  try {
    await expect(f.index.execute({ job, signal: AbortSignal.abort(canceled) })).rejects.toBe(
      canceled,
    );
    f.catalog.catalog.prepare("DELETE FROM acquisitions WHERE id=?").run(selection.acquisitionId);
    await expect(
      f.index.execute({ job, signal: AbortSignal.abort(canceled) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    restore();
    acquiredSelection(f);
    barrier.resolve();
  }
  await f.jobs.idle();
  const delivered = await assertSourceIndex(f, selection);
  expect(delivered.publication.input).toBe(job.input);
  expect(delivered.publication.attemptId).toBe(job.attemptId);
  expect(f.jobs.job(job.jobId).state).toBe("ready");
  for (const [key, maximum] of Object.entries({ headers: 4, segments: 2, acquisitions: 2 })) {
    expect(work[key as keyof typeof work]).toBeGreaterThan(0);
    expect(work[key as keyof typeof work]).toBeLessThanOrEqual(maximum);
  }
});
test("source index target mismatch refuses before metadata lookup and cancellation", async () => {
  const barrier = gate();
  const f = await fixture({ barrier });
  const selection = acquiredSelection(f);
  f.scenes.prepareSource(selection);
  await f.jobs.idle();
  f.jobs.submit({
    target: { kind: "asset", id: selection.assetId },
    artifact: "barrier",
    input: "hold",
    lane: "heavy",
  });
  const queued = f.index.requestSource(selection);
  const original = f.jobs.job(queued.jobId!);
  const job = {
    ...original,
    target: { kind: "asset" as const, id: "missing-target" },
    input: encodeIndexRecord({ ...JSON.parse(original.input), assetId: "missing-input" }),
  };
  const { work, restore } = observeSourceMetadata(f);
  try {
    await expect(
      f.index.execute({ job, signal: AbortSignal.abort(Error("canceled")) }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_CHANGED",
      message: "Source index recipe changed",
      details: {},
      retryable: false,
    });
    expect(work).toEqual({ headers: 0, segments: 0, acquisitions: 0 });
  } finally {
    restore();
    barrier.resolve();
  }
});
test("shared jobs publish source PNGs and exact gap coverage with bounded canonical pages", async () => {
  const f = await fixture();
  const { waiting, pending } = await f.prepare();
  expect(waiting.jobId).toBeNull();
  expect(pending.jobId).toBeTruthy();
  expect(f.jobs.job(pending.jobId!).lane).toBe("heavy");
  await f.jobs.idle();
  const delivered = await assertSourceIndex(f, f.selection);
  const result = f.index.getSource({ ...f.selection, limit: 1 });
  const first = result.page!;
  const publication = delivered.publication;
  expect(() =>
    f.index.adoptSourcePublication(
      portableSourceIndexMetadataSchema.parse(first.metadata),
      publication,
    ),
  ).not.toThrow();
  expect(() =>
    f.index.adoptSourcePublication(first.metadata, {
      ...publication,
      input: JSON.stringify(JSON.parse(publication.input), null, 2),
    }),
  ).toThrow("recipe differs");

  expect(first.entries).toEqual([delivered.result.page!.entries[0]]);
  const continuation = f.index.getSource({ ...f.selection, cursor: first.nextCursor!, limit: 1 });
  expect(continuation.page!.entries).toEqual([delivered.result.page!.entries[1]]);
  const ref = { ...f.selection, generation: first.metadata.generation };
  const frame = f.index.frameSource({ ...ref, ordinal: 0 });
  expect(frame.published.frame.assetId).toBe(f.selection.assetId);
  for (const row of f.catalog.catalog.prepare("SELECT id FROM derived_cache").all())
    f.cache.remove(row.id as string);
  const read = f.index.openReadSource({ ...ref, ordinal: 0 });
  try {
    const bytes = Buffer.alloc(read.bytes);
    read.read(bytes, 0);
    expect(bytes).toEqual(png);
  } finally {
    read.release();
  }
  expect(() =>
    f.index.getSource({ ...f.selection, streamId: "w", cursor: first.nextCursor! }),
  ).toThrow("another selection");
});
test("terminal child failure settles the parent and only explicit retry attempts the child again", async () => {
  const f = await fixture({
    beforeFrame: async (n) => {
      if (n === 1) throw new CatalogError("DECODE_FAILED", "decoder failed", {});
    },
  });
  const { pending } = await f.prepare();
  await f.jobs.idle();
  expect(f.jobs.job(pending.jobId!).state).toBe("failed");
  expect(f.jobs.job(pending.jobId!).errorDetails).toMatchObject({
    dependency: { ...f.selection, atUs: 200000, artifact: "frame" },
  });
  expect(f.index.requestSource(f.selection).retryable).toBe(true);
  expect(f.calls).toBe(1);
  f.index.getSource(f.selection);
  expect(f.calls).toBe(1);
  f.index.retrySource(f.selection);
  await f.jobs.idle();
  expect(f.index.getSource(f.selection).state).toBe("ready");
  expect(f.calls).toBe(5);
});
test("all no-picture observations publish coverage without invented images", async () => {
  const f = await fixture({ empty: true, continuousSupport: true });
  await f.prepare();
  await f.jobs.idle();
  const result = f.index.getSource(f.selection);
  expect(result.state).toBe("ready");
  expect(result.page!.metadata.candidateCount).toBe(0);
  expect(result.page!.entries).toEqual([]);
  const page = f.index.coverageSource({
    ...f.selection,
    generation: result.page!.metadata.generation,
  });
  const coverage = page.coverage;
  expect(coverage.length).toBeGreaterThan(0);
  expect(coverage.length).toBe(result.page!.metadata.coverageCount);
  expect(page.nextCursor).toBeNull();
  let through = 0;
  for (const row of coverage) {
    expect(row.source.startUs).toBe(through);
    expect(row.source.endUs).toBeGreaterThan(through);
    through = row.source.endUs;
  }
  expect(through).toBe(1200000);
  expect(
    coverage.every(
      (r) => r.state === "unavailable" && r.basis === "observation" && r.equality === "unproven",
    ),
  ).toBe(true);
});
test("cancellation stops retention while the shared child keeps its own worker lifetime", async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture({
    beforeFrame: async (n) => {
      if (n === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    const { pending } = await f.prepare();
    await entered.promise;
    f.jobs.cancel(pending.jobId!);
    release.resolve();
    await f.jobs.idle();
    expect(f.jobs.job(pending.jobId!).state).toBe("canceled");
    expect(f.index.requestSource(f.selection).published).toBeNull();
    f.index.retrySource(f.selection);
    await f.jobs.idle();
    expect(f.index.getSource(f.selection).state).toBe("ready");
  } finally {
    release.resolve();
  }
});
test("queued index pins its exact old scene generation across regeneration then stands alone", async () => {
  const barrier = gate();
  const f = await fixture({ barrier });
  f.scenes.prepareSource(f.selection);
  await f.jobs.idle();
  const old = f.scenes.sourceStatus(f.selection);
  const oldScene = old.published!.evidence;
  const other = { ...f.selection, streamId: "w" };
  f.scenes.prepareSource(other);
  await f.jobs.idle();
  const otherScene = f.scenes.sourceStatus(other).published!.evidence;
  f.jobs.submit({
    target: { kind: "asset", id: f.selection.assetId },
    artifact: "barrier",
    input: "barrier",
    lane: "heavy",
  });
  const queued = f.index.requestSource(f.selection);
  expect(f.jobs.job(queued.jobId!).state).toBe("queued");
  f.jobs.regenerate(old.jobId!, old.published!.generation);
  expect(f.index.requestSource(f.selection).jobId).toBeNull();
  expect(f.index.retainsSourceScenes(f.selection.assetId, oldScene.generation)).toBe(true);
  expect(f.index.retainsSourceScenes(f.selection.assetId, otherScene.generation)).toBe(false);
  await f.scenes.cleanup(new AbortController().signal);
  expect(f.records.sourcePage({ identity: oldScene }).metadata.generation).toBe(
    oldScene.generation,
  );
  barrier.resolve();
  await f.jobs.idle();
  const published = f.jobs.job(queued.jobId!);
  expect(published.state).toBe("ready");
  const ref = { ...f.selection, generation: published.attemptId };
  expect(f.index.publishedSource(ref).scenes.generation).toBe(oldScene.generation);
  await f.scenes.cleanup(new AbortController().signal);
  expect(() => f.records.sourcePage({ identity: oldScene })).toThrow();
  expect(f.index.frameSource({ ...ref, ordinal: 0 }).state).toBe("ready");
});

test("two source parents share the heavy lane and leave frame capacity for their children", async () => {
  const f = await fixture();
  const other = { ...f.selection, streamId: "w" };
  f.index.requestSource(f.selection);
  f.index.requestSource(other);
  await f.jobs.idle();
  f.index.requestSource(f.selection);
  f.index.requestSource(other);
  await f.jobs.idle();
  expect(f.index.getSource(f.selection).state).toBe("ready");
  expect(f.index.getSource(other).state).toBe("ready");
  expect(f.calls).toBe(8);
});

test("narrow acquisition support remains visible when every prepared scene grid point misses it", async () => {
  const f = await fixture();
  f.catalog.catalog.prepare("INSERT INTO acquisitions VALUES(?,?,?,?)").run(
    "mask",
    "fixture",
    JSON.stringify({ kind: "import", path: f.home, files: {} }),
    JSON.stringify({
      id: "mask",
      bindings: [
        {
          assetId: f.selection.assetId,
          streamId: "v",
          available: [{ startUs: 300000, endUs: 350000 }],
        },
      ],
    }),
  );
  const selection = { ...f.selection, acquisitionId: "mask" };
  f.index.requestSource(selection);
  await f.jobs.idle();
  const pending = f.index.requestSource(selection);
  await f.jobs.idle();
  const result = f.index.getSource(selection);
  expect(result.state).toBe("ready");
  expect(
    result.page!.entries.map((e) => [e.candidate.requestedSourceUs, e.frame.actualSourceUs]),
  ).toEqual([
    [300000, 200000],
    [349999, 200000],
  ]);
  expect(f.assets.references(f.selection.assetId)).toContainEqual({
    kind: "job",
    id: pending.jobId,
  });
  expect(f.acquisitions.references("mask")).toContainEqual({ kind: "job", id: pending.jobId });
  expect(() =>
    f.index.frameSource({
      ...f.selection,
      generation: result.page!.metadata.generation,
      ordinal: 0,
    }),
  ).toThrow("another selection");
});

test("retrying an index with a failed scene dependency retries that dependency explicitly", async () => {
  let calls = 0;
  const f = await fixture({
    beforeScene: () => {
      if (++calls === 1) throw new CatalogError("DECODE_FAILED", "scene decoder failed", {});
    },
  });
  f.index.requestSource(f.selection);
  await f.jobs.idle();
  expect(f.index.requestSource(f.selection).state).toBe("failed");
  expect(calls).toBe(1);
  f.index.retrySource(f.selection);
  await f.jobs.idle();
  f.index.requestSource(f.selection);
  await f.jobs.idle();
  expect(f.index.getSource(f.selection).state).toBe("ready");
  expect(calls).toBe(2);
});

test("explicit index retry recovers a canceled scene prerequisite without read-triggered retries", async () => {
  const barrier = gate();
  let sceneCalls = 0;
  const f = await fixture({
    barrier,
    beforeScene: () => {
      sceneCalls++;
    },
  });
  f.jobs.submit({
    target: { kind: "asset", id: f.selection.assetId },
    artifact: "barrier",
    input: "hold",
    lane: "heavy",
  });
  f.index.requestSource(f.selection);
  const scene = f.scenes.sourceStatus(f.selection);
  f.jobs.cancel(scene.jobId!);
  expect(f.index.requestSource(f.selection)).toMatchObject({
    state: "not_requested",
    reason: "canceled",
    retryable: true,
    jobId: null,
  });
  expect(sceneCalls).toBe(0);
  f.index.retrySource(f.selection);
  barrier.resolve();
  await f.jobs.idle();
  expect(sceneCalls).toBe(1);
  f.index.requestSource(f.selection);
  await f.jobs.idle();
  expect(f.index.getSource(f.selection).state).toBe("ready");
});

test("explicit index retry recovers its canceled frame child instead of repeating terminal failure", async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture({
    beforeFrame: async (n) => {
      if (n === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    const { pending } = await f.prepare();
    await entered.promise;
    const child = f.frames.request({ ...f.selection, atUs: 200000 });
    f.jobs.cancel(child.jobId!);
    release.resolve();
    await f.jobs.idle();
    expect(f.jobs.job(pending.jobId!).state).toBe("failed");
    expect(f.calls).toBe(1);
    f.index.getSource(f.selection);
    expect(f.calls).toBe(1);
    f.index.retrySource(f.selection);
    await f.jobs.idle();
    expect(f.index.getSource(f.selection).state).toBe("ready");
    expect(f.calls).toBe(5);
  } finally {
    release.resolve();
  }
});

test("reading an adopted source index preserves its generation without a donor job", async () => {
  const f = await fixture();
  const { pending } = await f.prepare();
  await f.jobs.idle();
  const original = f.index.getSource(f.selection).page!.metadata;
  const publication = f.index.portableSource(original)!;
  f.jobs.forgetJob(pending.jobId!);
  f.index.adoptSourcePublication(original, publication);
  expect(f.index.getSource(f.selection).page!.metadata.generation).toBe(original.generation);
  await f.jobs.idle();
  expect(f.index.getSource(f.selection).page!.metadata.generation).toBe(original.generation);
  expect(
    f.index.frameSource({ ...f.selection, generation: original.generation, ordinal: 0 }).state,
  ).toBe("ready");
  const reference = { ...f.selection, generation: original.generation, ordinal: 0 };
  f.index.openReadSource(reference).release();
  await unlink(f.retained.readEntry(original, 0).frame.file);
  expect(() => f.index.openReadSource(reference)).toThrow();
  await f.jobs.idle();
  expect(f.index.getSource(f.selection).page!.metadata.generation).toBe(original.generation);
});

test("partial source index pictures stay private until explicit retry publishes complete coverage", async () => {
  const f = await fixture({
    beforeFrame: async (n) => {
      if (n === 2) throw new CatalogError("DECODE_FAILED", "second decoder interrupted", {});
    },
  });
  const { pending } = await f.prepare();
  const attempt = f.jobs.job(pending.jobId!).attemptId;
  await f.jobs.idle();
  expect(f.index.requestSource(f.selection)).toMatchObject({
    state: "failed",
    published: null,
    retryable: true,
  });
  expect(f.calls).toBe(2);
  expect(
    f.catalog.catalog
      .prepare("SELECT generation FROM screenshot_index_generations WHERE generation=?")
      .get(attempt),
  ).toBeUndefined();
  f.index.getSource(f.selection);
  await f.jobs.idle();
  expect(f.calls).toBe(2);
  f.index.retrySource(f.selection);
  await f.jobs.idle();
  const delivered = await assertSourceIndex(f, f.selection);
  expect(delivered.publication.attemptId).not.toBe(attempt);
  expect(f.calls).toBe(5);
});

test("complete source index files require a published matching generation", async () => {
  const f = await fixture();
  await f.prepare();
  await f.jobs.idle();
  const result = await assertSourceIndex(f, f.selection);
  const metadata = result.result.page!.metadata;
  const reference = { ...f.selection, generation: metadata.generation };
  expect(f.index.publishedSource(reference)).toEqual(metadata);
  expect(() => f.index.publishedSource({ ...reference, streamId: "w" })).toThrow(
    "another selection",
  );
  expect(() => f.index.publishedSource({ ...reference, generation: "unknown" })).toThrow(
    "not published",
  );
  const first = f.index.coverageSource({ ...reference, limit: 1 });
  expect(first.nextCursor).not.toBeNull();
  expect(() =>
    f.index.coverageSource({ ...reference, candidateOrdinal: 0, cursor: first.nextCursor! }),
  ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  const next = f.index.coverageSource({ ...reference, cursor: first.nextCursor!, limit: 1 });
  expect(next.coverage[0]!.source.startUs).toBe(first.coverage[0]!.source.endUs);
  expect(() => f.index.frameSource({ ...reference, ordinal: metadata.candidateCount })).toThrow(
    "does not exist",
  );
  f.catalog.catalog
    .prepare(
      "DELETE FROM artifacts WHERE targetKind='asset' AND targetId=? AND artifact='screenshot-index'",
    )
    .run(f.selection.assetId);
  expect(f.retained.page({ identity: metadata }).entries).toEqual(
    result.result.page!.entries.map((entry) => omit(entry, "reference")),
  );
  expect(() => f.index.publishedSource(reference)).toThrow("not published");
});

test("a plain source-index cursor cannot be relabeled as face evidence", async () => {
  const f = await fixture();
  const selection = acquiredSelection(f);
  f.index.requestSource(selection);
  await f.jobs.idle();
  f.index.requestSource(selection);
  await f.jobs.idle();
  const first = f.index.getSource({ ...selection, limit: 1 });
  expect(() =>
    f.index.getSource({
      ...selection,
      faceObservations: { recipe: "vision-face-rectangles-v1" },
      cursor: first.page!.nextCursor!,
    }),
  ).toThrow(expect.objectContaining({ code: "ARTIFACT_CHANGED" }));
});

test("source index, coverage and face-trajectory pages conform to the paging contract", async () => {
  const f = await fixture();
  const selection = acquiredSelection(f);
  const faceObservations = { recipe: "vision-face-rectangles-v1" as const };
  for (let pass = 0; pass < 2; pass++) {
    f.index.requestSource({ ...selection, faceObservations });
    await f.jobs.idle();
  }
  const generation = f.index.requestSource({ ...selection, faceObservations }).published!.evidence
    .generation;
  type EntryCursor = NonNullable<Parameters<typeof f.index.getSource>[0]["cursor"]>;
  type CoverageCursor = NonNullable<Parameters<typeof f.index.coverageSource>[0]["cursor"]>;
  const ordinal = (entry: unknown) =>
    String((entry as { candidate: { ordinal: number } }).candidate.ordinal);
  // index.get: the request's selection is bound into its continuation.
  const entries = expectPageTraversal<EntryCursor>((limit, cursor) => {
    const page = f.index.getSource({ ...selection, faceObservations, limit, cursor }).page!;
    return { items: page.entries, nextCursor: page.nextCursor };
  }, ordinal);
  // face.trajectory.get: the same entries, read through an explicit retained generation.
  const trajectory = expectPageTraversal<EntryCursor>((limit, cursor) => {
    const page = f.index.getSource({ ...selection, generation, limit, cursor }).page!;
    return { items: page.entries, nextCursor: page.nextCursor };
  }, ordinal);
  expect(trajectory.expected).toEqual(entries.expected);
  for (const changed of [
    { streamId: "w" },
    { acquisitionId: "other" },
    { generation: "other-generation" },
  ])
    expect(() =>
      f.index.getSource({ ...selection, ...changed, cursor: trajectory.firstCursor, limit: 1 }),
    ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  expect(() =>
    f.index.getSource({
      ...selection,
      cursor: { ...trajectory.firstCursor, afterOrdinal: 99 },
      limit: 1,
    }),
  ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  // index.coverage: the candidate filter and the generation are bound into the continuation.
  const reference = { ...selection, generation };
  const coverage = expectPageTraversal<CoverageCursor>((limit, cursor) => {
    const page = f.index.coverageSource({ ...reference, limit, cursor });
    return { items: page.coverage, nextCursor: page.nextCursor };
  });
  expect(coverage.expected.length).toBeGreaterThanOrEqual(3);
  expect(() =>
    f.index.coverageSource({
      ...reference,
      candidateOrdinal: 0,
      cursor: coverage.firstCursor,
      limit: 1,
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  // Another selection cannot even resolve this index, so it refuses before reading the cursor.
  for (const changed of [{ streamId: "w" }, { acquisitionId: "other" }])
    expect(() =>
      f.index.coverageSource({ ...reference, ...changed, cursor: coverage.firstCursor, limit: 1 }),
    ).toThrow(CatalogError);
});
