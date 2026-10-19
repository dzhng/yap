import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import { projectServiceFixture } from "./project-service.fixture.js";
import { FaultingDeletionPlans } from "./deletion-faults.fixture.js";
import type { Catalog } from "@yap/core/catalog";
import { DeletionPlans } from "@yap/core/deletion-plans";

async function fileCount(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isFile()) return 1;
    if (!info.isDirectory()) return 0;
    return (await readdir(path)).reduce(
      async (total, name) => (await total) + (await fileCount(join(path, name))),
      Promise.resolve(0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

const assetOwnedRowQueries = [
  ["assets", "id=?"],
  ["asset_segments", "assetId=?"],
  ["asset_origins", "assetId=?"],
  ["transcript_generations", "ownerKind='asset' AND ownerId=?"],
  ["transcript_segments", "ownerKind='asset' AND ownerId=?"],
  ["transcript_words", "ownerKind='asset' AND ownerId=?"],
  ["transcript_gaps", "ownerKind='asset' AND ownerId=?"],
  ["imported_transcripts", "json_extract(source,'$.assetId')=?"],
  [
    "imported_transcript_cues",
    "generation IN (SELECT generation FROM imported_transcripts WHERE json_extract(source,'$.assetId')=?)",
  ],
  ["scene_evidence_generations", "ownerKind='asset' AND ownerId=?"],
  ["scene_evidence_chunks", "ownerKind='asset' AND ownerId=?"],
  ["scene_evidence_boundaries", "ownerKind='asset' AND ownerId=?"],
  ["screenshot_index_generations", "ownerKind='asset' AND ownerId=?"],
  ["screenshot_index_entries", "ownerKind='asset' AND ownerId=?"],
  ["screenshot_index_coverage", "ownerKind='asset' AND ownerId=?"],
  ["alignment_evidence_generations", "ownerId=?"],
  ["alignment_evidence_records", "ownerId=?"],
  ["speaker_evidence_generations", "ownerId=?"],
  ["speaker_evidence_records", "ownerId=?"],
  ["derived_cache", "ownerKind='asset' AND ownerId=?"],
  ["jobs", "targetKind='asset' AND targetId=?"],
  [
    "resource_references",
    "(resourceKind='asset' AND resourceId=?) OR (ownerKind='asset' AND ownerId=?)",
  ],
] as const;

function ownedAssetRows(
  catalog: Catalog["catalog"],
  assetId: string,
): readonly (readonly [string, number])[] {
  return assetOwnedRowQueries.map(([table, where]) => {
    const args = (where.match(/\?/g) ?? []).length === 2 ? [assetId, assetId] : [assetId];
    return [
      table,
      Number(
        (
          catalog.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...args) as {
            count: number;
          }
        ).count,
      ),
    ] as const;
  });
}

function assetOwnedFileRoots(
  home: string,
  assetId: string,
  assetPath: string,
  cacheIds: readonly string[] = [],
) {
  return [
    assetPath,
    join(home, "library", "transcripts", "assets", assetId),
    join(home, "library", "transcripts", "imported", assetId),
    join(home, "library", "evidence", "index", "asset", assetId),
    ...cacheIds.map((id) => join(home, "library", "cache", "derived", `${id}.cache`)),
  ];
}

async function seedOwnedState(home: string, catalog: Catalog, assetId: string) {
  const transcriptGeneration = "transcript-seed";
  await mkdir(join(home, "library", "transcripts", "assets", assetId, transcriptGeneration), {
    recursive: true,
  });
  await writeFile(
    join(home, "library", "transcripts", "assets", assetId, transcriptGeneration, "raw.jsonl"),
    "raw transcript",
  );
  const importedGeneration = "imported-seed";
  await mkdir(join(home, "library", "transcripts", "imported", assetId, importedGeneration), {
    recursive: true,
  });
  await writeFile(
    join(home, "library", "transcripts", "imported", assetId, importedGeneration, "source.srt"),
    "1\n00:00:00,000 --> 00:00:00,001\nseed\n",
  );
  const indexGeneration = "index-seed";
  const indexDirectory = join(
    home,
    "library",
    "evidence",
    "index",
    "asset",
    assetId,
    createHash("sha256").update(indexGeneration).digest("hex"),
  );
  await mkdir(indexDirectory, { recursive: true });
  await writeFile(join(indexDirectory, "0.png"), "seed frame");
  const indexStat = await stat(indexDirectory);
  const cacheId = randomUUID();
  const cachePath = join(home, "library", "cache", "derived", `${cacheId}.cache`);
  await writeFile(cachePath, "seed cache");
  const cacheStat = await stat(cachePath);
  const jobId = randomUUID();
  catalog.catalog.exec("BEGIN");
  try {
    catalog.catalog
      .prepare(
        "INSERT INTO transcript_generations(ownerKind,ownerId,sourceId,generation,source,engine,execution,available,track,segmentCount,wordCount,gapCount,maxWordUs,rawSha256,bytes,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "asset",
        assetId,
        "image",
        transcriptGeneration,
        "{}",
        "{}",
        "{}",
        "{}",
        "{}",
        1,
        1,
        1,
        1,
        null,
        13,
        "complete",
      );
    catalog.catalog
      .prepare("INSERT INTO transcript_segments VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("asset", assetId, transcriptGeneration, 0, 0, 1, "{}", "{}", "complete", null);
    catalog.catalog
      .prepare("INSERT INTO transcript_words VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("asset", assetId, transcriptGeneration, 0, 0, 1, 0, "seed", "word", 1, 0, 0);
    catalog.catalog
      .prepare("INSERT INTO transcript_gaps VALUES(?,?,?,?,?,?)")
      .run("asset", assetId, transcriptGeneration, 1, 2, "seed");
    catalog.catalog
      .prepare(
        "INSERT INTO imported_transcripts(requestId,source,generation,format,parser,timingBasis,timingPolicy,alignmentModelId,alignmentChannel,rawSha256,rawBytes,metadata,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "seed-import",
        JSON.stringify({ assetId, streamId: "image" }),
        importedGeneration,
        "srt",
        "{}",
        "cue",
        "supplied",
        null,
        null,
        "seed",
        13,
        "{}",
        "complete",
      );
    catalog.catalog
      .prepare("INSERT INTO imported_transcript_cues VALUES(?,?,?,?,?,?,?,?,?)")
      .run(importedGeneration, 0, "cue-0", 0, 1, "seed", null, null, "[]");
    catalog.catalog
      .prepare("INSERT INTO scene_evidence_generations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "asset",
        assetId,
        "image",
        "scene-seed",
        "scene-v1",
        "{}",
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        null,
        null,
        1,
      );
    catalog.catalog
      .prepare("INSERT INTO scene_evidence_chunks VALUES(?,?,?,?,?,?,?)")
      .run("asset", assetId, "image", "scene-seed", "scene-v1", 0, "{}");
    catalog.catalog
      .prepare("INSERT INTO scene_evidence_boundaries VALUES(?,?,?,?,?,?,?,?)")
      .run("asset", assetId, "image", "scene-seed", "scene-v1", 0, 0, "{}");
    const indexIdentity = JSON.stringify({
      assetId,
      streamId: "image",
      generation: indexGeneration,
    });
    catalog.catalog
      .prepare("INSERT INTO screenshot_index_generations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "asset",
        assetId,
        indexGeneration,
        indexIdentity,
        "complete",
        1,
        1,
        1,
        9,
        1,
        indexStat.dev,
        indexStat.ino,
      );
    catalog.catalog
      .prepare("INSERT INTO screenshot_index_entries VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "asset",
        assetId,
        indexGeneration,
        0,
        "{}",
        "{}",
        10,
        indexStat.dev,
        indexStat.ino,
        indexStat.mtimeMs,
        1,
      );
    catalog.catalog
      .prepare("INSERT INTO screenshot_index_coverage VALUES(?,?,?,?,?,?)")
      .run("asset", assetId, indexGeneration, 0, 0, "{}");
    catalog.catalog
      .prepare("INSERT INTO alignment_evidence_generations VALUES(?,?,?,?,?,?,?,?)")
      .run(assetId, "alignment-seed", "alignment-v1", "{}", "seed", "seed", "seed", 1);
    catalog.catalog
      .prepare("INSERT INTO alignment_evidence_records VALUES(?,?,?,?,?,?)")
      .run(assetId, "alignment-seed", "alignment-v1", "word", 0, "{}");
    catalog.catalog
      .prepare("INSERT INTO speaker_evidence_generations VALUES(?,?,?,?,?,?,?,?)")
      .run(assetId, "image", "speaker-seed", "speaker-v1", "{}", "seed", "seed", 1);
    catalog.catalog
      .prepare("INSERT INTO speaker_evidence_records VALUES(?,?,?,?,?,?,?)")
      .run(assetId, "image", "speaker-seed", "speaker-v1", "turn", 0, "{}");
    catalog.catalog
      .prepare("INSERT INTO derived_cache VALUES(?,?,?,?,?,?,?)")
      .run(cacheId, "asset", assetId, 1, Number(cacheStat.size), cacheStat.dev, cacheStat.ino);
    catalog.catalog
      .prepare("INSERT INTO resource_references VALUES(?,?,?,?)")
      .run("asset", assetId, "asset", assetId);
    catalog.catalog
      .prepare(
        "INSERT INTO jobs(jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,state,reason,errorCode,errorDetails,retryable,generation,queuedSequence,deferred,readmitted,inputSha256,input) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        jobId,
        randomUUID(),
        "asset",
        assetId,
        "",
        "seed",
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
        "seed-hash",
        "seed",
      );
  } finally {
    catalog.catalog.exec("COMMIT");
  }
}

test("asset.delete removes the asset file and every owned catalog row", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = await projectServiceFixture(cleanups, async (operation, params) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              {
                id: "image",
                kind: "image",
                codec: "png",
                decodable: true,
                width: 1,
                height: 1,
                orientedWidth: 1,
                orientedHeight: 1,
                orientation: 1,
                segments: [{ startUs: 0, endUs: 1, empty: false }],
              },
            ],
          },
        }
      : operation === "storage.removeCacheFiles"
        ? await Promise.all(
            (params.ids as string[]).map((id) =>
              rm(join(String(params.home), "cache", "derived", `${id}.cache`), {
                force: true,
              }),
            ),
          ).then(() => ({ ok: true, data: { removed: true } }))
        : { ok: true, data: {} },
  );
  try {
    const imported = await fixture.call("asset.import", {
      requestId: "asset-delete-import",
      path: fixture.path,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const jobId = (imported.data as { jobId: string }).jobId;
    const ready = await fixture.job(jobId, "ready");
    const assetId = (ready.published as { output: { assetId: string } }).output.assetId;
    const assetPath = fixture.service.assets.path(assetId);
    await expect(access(assetPath)).resolves.toBeUndefined();
    const ownedFileRoots = assetOwnedFileRoots(fixture.home, assetId, assetPath);
    const catalog = fixture.service.captures.catalog;
    await seedOwnedState(fixture.home, fixture.service.captures, assetId);
    const cacheId = (
      catalog.prepare("SELECT id FROM derived_cache WHERE ownerId=?").get(assetId) as { id: string }
    ).id;
    ownedFileRoots.push(join(fixture.home, "library", "cache", "derived", `${cacheId}.cache`));
    const filesBefore = await Promise.all(ownedFileRoots.map(fileCount));
    expect(filesBefore[0]).toBe(1);
    const before = catalog
      .prepare(
        "SELECT (SELECT COUNT(*) FROM assets) assets, (SELECT COUNT(*) FROM asset_segments) segments, (SELECT COUNT(*) FROM asset_origins) origins FROM assets WHERE id=?",
      )
      .get(assetId) as { assets: number; segments: number; origins: number };
    expect(before.assets).toBe(1);
    expect(before.origins).toBeGreaterThan(0);
    const ownedRows = () => ownedAssetRows(catalog, assetId);
    const ownedRowsBefore = ownedRows();
    expect(ownedRowsBefore[0]?.[1]).toBe(1);
    expect(ownedRowsBefore.every(([, count]) => count > 0)).toBe(true);
    catalog.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
    const usageBefore = await fixture.call("storage.usage", {});
    if (!usageBefore.ok) throw new Error(JSON.stringify(usageBefore));

    const deleted = await fixture.call("asset.delete", {
      requestId: "asset-delete",
      assetId,
    });
    expect(deleted).toMatchObject({
      ok: true,
      data: { assetId, deleted: true, freedBytes: expect.any(Number) },
    });
    if (!deleted.ok) throw new Error(JSON.stringify(deleted));
    catalog.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
    const usageAfter = await fixture.call("storage.usage", {});
    if (!usageAfter.ok) throw new Error(JSON.stringify(usageAfter));
    expect(
      (usageBefore.data as { totalBytes: number }).totalBytes -
        (usageAfter.data as { totalBytes: number }).totalBytes,
    ).toBe((deleted.data as { freedBytes: number }).freedBytes);
    await expect(access(assetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Promise.all(ownedFileRoots.map(fileCount))).toEqual(filesBefore.map(() => 0));
    expect(ownedRows().filter(([, count]) => count !== 0)).toEqual([]);
    expect(
      (
        catalog
          .prepare("SELECT COUNT(*) AS count FROM asset_imports WHERE assetId=?")
          .get(assetId) as {
          count: number;
        }
      ).count,
    ).toBe(1);

    await expect(
      fixture.call("asset.import", { requestId: "asset-delete-import", path: fixture.path }),
    ).resolves.toMatchObject({ ok: false, error: { code: "ASSET_DELETED", retryable: false } });
    const reimported = await fixture.call("asset.import", {
      requestId: "asset-delete-import-again",
      path: fixture.path,
    });
    expect(reimported).toMatchObject({ ok: true });
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
});

test("asset.delete refuses a live project user with structured IN_USE details", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = await projectServiceFixture(cleanups, async (operation) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              {
                id: "image",
                kind: "image",
                codec: "png",
                decodable: true,
                width: 1,
                height: 1,
                orientedWidth: 1,
                orientedHeight: 1,
                orientation: 1,
              },
            ],
          },
        }
      : { ok: true, data: {} },
  );
  try {
    const imported = await fixture.call("asset.import", {
      requestId: "asset-in-use-import",
      path: fixture.path,
    });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const assetId = (await fixture.job((imported.data as { jobId: string }).jobId, "ready"))
      .published!.output.assetId;
    const created = await fixture.call("project.create", {
      requestId: "asset-in-use-project",
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const revisionId = (created.data as { revision: { revisionId: string } }).revision.revisionId;
    const projectId = (created.data as { project: { projectId: string } }).project.projectId;
    const catalog = fixture.service.captures.catalog;
    catalog
      .prepare(
        "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
      )
      .run("asset", assetId, "revision", revisionId);
    const refused = await fixture.call("asset.delete", {
      requestId: "asset-in-use-delete",
      assetId,
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "IN_USE",
        retryable: false,
        details: {
          assetId,
          usedBy: [{ kind: "project", projectId, revisions: 1 }],
          acquisitions: [],
          derivedAssets: [],
          freesBytes: expect.any(Number),
          cascadeFreesBytes: expect.any(Number),
        },
      },
    });
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
});

test("asset.delete cascade retires the recorded project and resumes from its plan", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = await projectServiceFixture(cleanups, async (operation) =>
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
  try {
    const imported = await fixture.call("asset.import", {
      requestId: "asset-cascade-import",
      path: fixture.path,
    });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const assetId = (await fixture.job((imported.data as { jobId: string }).jobId, "ready"))
      .published!.output.assetId;
    const created = await fixture.call("project.create", {
      requestId: "asset-cascade-project",
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const { project, revision } = created.data as {
      project: { projectId: string };
      revision: { revisionId: string };
    };
    fixture.service.captures.catalog
      .prepare(
        "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
      )
      .run("asset", assetId, "revision", revision.revisionId);
    const deleted = await fixture.call("asset.delete", {
      requestId: "asset-cascade-delete",
      assetId,
      cascade: true,
    });
    expect(deleted).toMatchObject({ ok: true, data: { assetId, deleted: true } });
    expect(await fixture.call("project.get", { projectId: project.projectId })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
});

test("asset.delete cascade follows a derived asset chain and removes its creating job", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = await projectServiceFixture(cleanups, async (operation) =>
    operation === "media.probe"
      ? {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              {
                id: "image",
                kind: "image",
                codec: "png",
                decodable: true,
                width: 1,
                height: 1,
                orientedWidth: 1,
                orientedHeight: 1,
                orientation: 1,
                segments: [{ startUs: 0, endUs: 1, empty: false }],
              },
            ],
          },
        }
      : { ok: true, data: {} },
  );
  try {
    const source = await fixture.call("asset.import", {
      requestId: "derived-chain-source",
      path: fixture.path,
    });
    if (!source.ok) throw new Error(JSON.stringify(source));
    const sourceId = (await fixture.job((source.data as { jobId: string }).jobId, "ready"))
      .published!.output.assetId;
    const derivedPath = join(fixture.home, "derived.png");
    await writeFile(derivedPath, "derived bytes");
    const derived = await fixture.call("asset.import", {
      requestId: "derived-chain-output",
      path: derivedPath,
    });
    if (!derived.ok) throw new Error(JSON.stringify(derived));
    const derivedId = (await fixture.job((derived.data as { jobId: string }).jobId, "ready"))
      .published!.output.assetId;
    const catalog = fixture.service.captures.catalog;
    catalog
      .prepare(
        "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
      )
      .run("asset", sourceId, "asset", derivedId);
    const created = await fixture.call("project.create", {
      requestId: "derived-chain-project",
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const { project, revision } = created.data as {
      project: { projectId: string };
      revision: { revisionId: string };
    };
    const placed = await fixture.call("edit.apply", {
      projectId: project.projectId,
      expectedRevisionId: revision.revisionId,
      requestId: "derived-chain-place",
      operations: [
        { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          clip: {
            trackId: { label: "video" },
            assetId: derivedId,
            streamId: "image",
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 1_000_000 } },
          },
        },
      ],
    });
    if (!placed.ok) throw new Error(JSON.stringify(placed));
    const creatingJobId = randomUUID();
    catalog
      .prepare(
        "INSERT INTO jobs(jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,state,reason,errorCode,errorDetails,retryable,generation,queuedSequence,deferred,readmitted,inputSha256,input) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        creatingJobId,
        randomUUID(),
        "asset",
        derivedId,
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
        "derived-job",
        "derived-job",
      );
    const refused = await fixture.call("asset.delete", {
      requestId: "derived-chain-refusal",
      assetId: sourceId,
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "IN_USE",
        details: {
          derivedAssets: [{ kind: "asset", assetId: derivedId }],
          usedBy: [{ kind: "project", projectId: project.projectId, revisions: 2 }],
        },
      },
    });
    if (refused.ok) throw new Error(JSON.stringify(refused));
    const details = refused.error.details as { cascadeFreesBytes: number };
    const deleted = await fixture.call("asset.delete", {
      requestId: "derived-chain-delete",
      assetId: sourceId,
      cascade: true,
    });
    expect(deleted).toMatchObject({
      ok: true,
      data: { assetId: sourceId, deleted: true, freedBytes: details.cascadeFreesBytes },
    });
    expect(catalog.prepare("SELECT COUNT(*) AS count FROM assets").get()).toEqual({ count: 0 });
    expect(
      catalog.prepare("SELECT COUNT(*) AS count FROM jobs WHERE targetId=?").get(derivedId),
    ).toEqual({ count: 0 });
    expect(catalog.prepare("SELECT COUNT(*) AS count FROM resource_references").get()).toEqual({
      count: 0,
    });
    expect(await fixture.call("project.get", { projectId: project.projectId })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
});

test("asset.delete cascade retires an acquisition and its managed evidence", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = await projectServiceFixture(cleanups, async (operation) =>
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
  try {
    const imported = await fixture.call("asset.import", {
      requestId: "acquisition-chain-source",
      path: fixture.path,
    });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const assetId = (await fixture.job((imported.data as { jobId: string }).jobId, "ready"))
      .published!.output.assetId;
    const acquisitionId = randomUUID();
    const generation = "acquisition-seed";
    const acquisitionRoot = join(fixture.home, "library", "acquisitions", acquisitionId);
    await mkdir(join(acquisitionRoot, generation, "source"), { recursive: true });
    await writeFile(
      join(acquisitionRoot, generation, "source", "capture.journal.jsonl"),
      "journal",
    );
    const catalog = fixture.service.captures.catalog;
    catalog
      .prepare("INSERT INTO acquisitions(id,requestId,admission,metadata) VALUES(?,?,?,?)")
      .run(
        acquisitionId,
        "acquisition-seed-request",
        JSON.stringify({ kind: "import", path: fixture.path, files: {} }),
        "{}",
      );
    catalog
      .prepare("INSERT INTO source_evidence_generations VALUES(?,?,?,?,?)")
      .run("acquisition", acquisitionId, "source", generation, "{}");
    catalog
      .prepare("INSERT INTO source_evidence_records VALUES(?,?,?,?,?,?,?,?)")
      .run("acquisition", acquisitionId, "source", generation, 0, "sample", 0, "{}");
    catalog
      .prepare(
        "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
      )
      .run("asset", assetId, "acquisition", acquisitionId);
    const refused = await fixture.call("asset.delete", {
      requestId: "acquisition-chain-refusal",
      assetId,
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "IN_USE",
        details: { acquisitions: [{ kind: "acquisition", acquisitionId }] },
      },
    });
    const deleted = await fixture.call("asset.delete", {
      requestId: "acquisition-chain-delete",
      assetId,
      cascade: true,
    });
    expect(deleted).toMatchObject({ ok: true, data: { assetId, deleted: true } });
    expect(
      catalog.prepare("SELECT COUNT(*) AS count FROM acquisitions WHERE id=?").get(acquisitionId),
    ).toEqual({ count: 0 });
    expect(
      catalog
        .prepare("SELECT COUNT(*) AS count FROM source_evidence_generations WHERE ownerId=?")
        .get(acquisitionId),
    ).toEqual({ count: 0 });
    expect(catalog.prepare("SELECT COUNT(*) AS count FROM resource_references").get()).toEqual({
      count: 0,
    });
    await expect(access(acquisitionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
});

test("asset.delete resumes a cascaded plan after every coordinator boundary", async () => {
  const boundaries = ["plan", "tombstone", "drain", "files", "rows", "clear"] as const;
  const timings = ["before", "after"] as const;
  for (const boundary of boundaries)
    for (const timing of timings) {
      const cleanups: (() => Promise<void>)[] = [];
      let fired = false;
      const fixture = await projectServiceFixture(
        cleanups,
        async (operation, params) =>
          operation === "media.probe"
            ? {
                ok: true,
                data: {
                  originUs: 0,
                  streams: [
                    {
                      id: "image",
                      kind: "image",
                      codec: "png",
                      decodable: true,
                      width: 1,
                      height: 1,
                      orientedWidth: 1,
                      orientedHeight: 1,
                      orientation: 1,
                      segments: [{ startUs: 0, endUs: 1, empty: false }],
                    },
                  ],
                },
              }
            : operation === "storage.removeCacheFiles"
              ? await Promise.all(
                  (params.ids as string[]).map((id) =>
                    rm(join(String(params.home), "cache", "derived", `${id}.cache`), {
                      force: true,
                    }),
                  ),
                ).then(() => ({ ok: true, data: { removed: true } }))
              : { ok: true, data: {} },
        undefined,
        {
          deletionPlans: (catalog) =>
            new FaultingDeletionPlans(catalog, (phase, _subject, when) => {
              if (!fired && phase === boundary && when === timing) {
                fired = true;
                throw new Error(`fault:${phase}:${when}`);
              }
            }),
        },
      );
      const imported = await fixture.call("asset.import", {
        requestId: `boundary-import-${boundary}-${timing}`,
        path: fixture.path,
      });
      if (!imported.ok) throw new Error(JSON.stringify(imported));
      const assetId = (await fixture.job((imported.data as { jobId: string }).jobId, "ready"))
        .published!.output.assetId;
      const derivedPath = join(fixture.home, `boundary-derived-${boundary}-${timing}.png`);
      await writeFile(derivedPath, "derived bytes");
      const derived = await fixture.call("asset.import", {
        requestId: `boundary-derived-import-${boundary}-${timing}`,
        path: derivedPath,
      });
      if (!derived.ok) throw new Error(JSON.stringify(derived));
      const derivedId = (await fixture.job((derived.data as { jobId: string }).jobId, "ready"))
        .published!.output.assetId;
      const catalog = fixture.service.captures.catalog;
      catalog
        .prepare(
          "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
        )
        .run("asset", assetId, "asset", derivedId);
      const project = await fixture.call("project.create", {
        requestId: `boundary-project-${boundary}-${timing}`,
        canvas: {
          width: 16,
          height: 16,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
      });
      if (!project.ok) throw new Error(JSON.stringify(project));
      const { project: projectData, revision } = project.data as {
        project: { projectId: string };
        revision: { revisionId: string };
      };
      const placed = await fixture.call("edit.apply", {
        projectId: projectData.projectId,
        expectedRevisionId: revision.revisionId,
        requestId: `boundary-place-${boundary}-${timing}`,
        operations: [
          { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
          {
            operation: "place",
            clip: {
              trackId: { label: "video" },
              assetId: derivedId,
              streamId: "image",
              source: { kind: "hold", atUs: 0 },
              placement: { kind: "project", range: { startUs: 0, endUs: 1_000_000 } },
            },
          },
        ],
      });
      if (!placed.ok) throw new Error(JSON.stringify(placed));
      const acquisitionId = randomUUID();
      const acquisitionRoot = join(fixture.home, "library", "acquisitions", acquisitionId);
      await mkdir(join(acquisitionRoot, "boundary", "source"), { recursive: true });
      await writeFile(
        join(acquisitionRoot, "boundary", "source", "capture.journal.jsonl"),
        "journal",
      );
      catalog
        .prepare("INSERT INTO acquisitions(id,requestId,admission,metadata) VALUES(?,?,?,?)")
        .run(
          acquisitionId,
          `boundary-acquisition-${boundary}-${timing}`,
          JSON.stringify({ kind: "import", path: fixture.path, files: {} }),
          JSON.stringify({
            id: acquisitionId,
            sourceId: assetId,
            evidence: { generation: "boundary" },
            journal: { fileName: "capture.journal.jsonl", bytes: 7, sha256: "seed" },
            bindings: [],
          }),
        );
      catalog
        .prepare("INSERT INTO source_evidence_generations VALUES(?,?,?,?,?)")
        .run("acquisition", acquisitionId, "source", "boundary", "{}");
      catalog
        .prepare("INSERT INTO source_evidence_records VALUES(?,?,?,?,?,?,?,?)")
        .run("acquisition", acquisitionId, "source", "boundary", 0, "sample", 0, "{}");
      catalog
        .prepare(
          "INSERT INTO resource_references(resourceKind,resourceId,ownerKind,ownerId) VALUES(?,?,?,?)",
        )
        .run("asset", assetId, "acquisition", acquisitionId);
      const assetPath = fixture.service.assets.path(assetId);
      const sourceCacheIds = catalog
        .prepare("SELECT id FROM derived_cache WHERE ownerKind='asset' AND ownerId=?")
        .all(assetId)
        .map((row) => (row as { id: string }).id);
      const derivedCacheIds = catalog
        .prepare("SELECT id FROM derived_cache WHERE ownerKind='asset' AND ownerId=?")
        .all(derivedId)
        .map((row) => (row as { id: string }).id);
      const sourceFiles = assetOwnedFileRoots(fixture.home, assetId, assetPath, sourceCacheIds);
      const derivedFiles = assetOwnedFileRoots(
        fixture.home,
        derivedId,
        fixture.service.assets.path(derivedId),
        derivedCacheIds,
      );
      const projectFiles = [
        join(fixture.home, "library", "evidence", "index", "project", projectData.projectId),
        ...catalog
          .prepare("SELECT id FROM derived_cache WHERE ownerKind='project' AND ownerId=?")
          .all(projectData.projectId)
          .map((row) =>
            join(
              fixture.home,
              "library",
              "cache",
              "derived",
              `${(row as { id: string }).id}.cache`,
            ),
          ),
      ];
      const acquisitionFiles = [acquisitionRoot];
      let countCatalog = catalog;
      const projectRows = () => [
        Number(
          (
            countCatalog
              .prepare("SELECT COUNT(*) AS count FROM project_revisions WHERE projectId=?")
              .get(projectData.projectId) as { count: number }
          ).count,
        ),
        Number(
          (
            countCatalog
              .prepare(
                "SELECT COUNT(*) AS count FROM resource_references WHERE ownerKind='revision' AND ownerId IN (SELECT id FROM project_revisions WHERE projectId=?)",
              )
              .get(projectData.projectId) as { count: number }
          ).count,
        ),
      ];
      const acquisitionRows = () => [
        Number(
          (
            countCatalog
              .prepare("SELECT COUNT(*) AS count FROM acquisitions WHERE id=?")
              .get(acquisitionId) as { count: number }
          ).count,
        ),
        Number(
          (
            countCatalog
              .prepare("SELECT COUNT(*) AS count FROM source_evidence_generations WHERE ownerId=?")
              .get(acquisitionId) as { count: number }
          ).count,
        ),
        Number(
          (
            countCatalog
              .prepare("SELECT COUNT(*) AS count FROM source_evidence_records WHERE ownerId=?")
              .get(acquisitionId) as { count: number }
          ).count,
        ),
        Number(
          (
            countCatalog
              .prepare(
                "SELECT COUNT(*) AS count FROM resource_references WHERE ownerKind='acquisition' AND ownerId=?",
              )
              .get(acquisitionId) as { count: number }
          ).count,
        ),
      ];
      expect(ownedAssetRows(catalog, assetId).some(([, count]) => count > 0)).toBe(true);
      expect(ownedAssetRows(catalog, derivedId).some(([, count]) => count > 0)).toBe(true);
      expect(projectRows().every((count) => count > 0)).toBe(true);
      expect(acquisitionRows().every((count) => count > 0)).toBe(true);
      expect(
        (
          await Promise.all(
            [...sourceFiles, ...derivedFiles, ...projectFiles, ...acquisitionFiles].map(fileCount),
          )
        ).some((count) => count > 0),
      ).toBe(true);
      const expectedFreedBytes = fixture.service.libraryUsers!.usersOf({
        kind: "asset",
        id: assetId,
      }).cascadeFreesBytes;
      const deletion = await fixture.call("asset.delete", {
        requestId: `boundary-delete-${boundary}-${timing}`,
        assetId,
        cascade: true,
      });
      expect(deletion).toMatchObject({ ok: false, error: { code: "DELETE_FAILED" } });
      if (boundary === "tombstone" && timing === "after")
        expect(() =>
          fixture.service.assets.retain({ kind: "job", id: "late-user" }, [assetId]),
        ).toThrow(expect.objectContaining({ code: "DELETE_IN_PROGRESS" }));
      await fixture.service.close();
      const reopened = await projectServiceFixture(
        cleanups,
        async (operation) =>
          operation === "media.probe"
            ? {
                ok: true,
                data: {
                  originUs: 0,
                  streams: [
                    {
                      id: "image",
                      kind: "image",
                      codec: "png",
                      decodable: true,
                      width: 1,
                      height: 1,
                      orientedWidth: 1,
                      orientedHeight: 1,
                      orientation: 1,
                      segments: [{ startUs: 0, endUs: 1, empty: false }],
                    },
                  ],
                },
              }
            : { ok: true, data: {} },
        fixture.home,
      );
      const resumed = await reopened.call("asset.delete", {
        requestId: `boundary-delete-${boundary}-${timing}`,
        assetId,
        cascade: true,
      });
      expect(resumed).toMatchObject({
        ok: true,
        data: { assetId, deleted: true, freedBytes: expectedFreedBytes },
      });
      expect(
        await reopened.call("asset.delete", {
          requestId: `boundary-delete-different-${boundary}-${timing}`,
          assetId,
          cascade: true,
        }),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      countCatalog = reopened.service.captures.catalog;
      expect(
        reopened.service.captures.catalog.prepare("SELECT COUNT(*) AS count FROM assets").get(),
      ).toEqual({ count: 0 });
      await expect(access(assetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        ownedAssetRows(reopened.service.captures.catalog, assetId).every(
          ([, count]) => count === 0,
        ),
      ).toBe(true);
      expect(
        ownedAssetRows(reopened.service.captures.catalog, derivedId).every(
          ([, count]) => count === 0,
        ),
      ).toBe(true);
      expect(projectRows().every((count) => count === 0)).toBe(true);
      expect(acquisitionRows().every((count) => count === 0)).toBe(true);
      expect(
        await Promise.all(
          [...sourceFiles, ...derivedFiles, ...projectFiles, ...acquisitionFiles].map(fileCount),
        ),
      ).toEqual(
        [...sourceFiles, ...derivedFiles, ...projectFiles, ...acquisitionFiles].map(() => 0),
      );
      await Promise.all(
        cleanups
          .splice(0)
          .reverse()
          .map((cleanup) => cleanup()),
      );
    }
});

test("asset deletion resumes imported transcript cleanup from a drained plan", async () => {
  const cleanups: (() => Promise<void>)[] = [];
  const fixture = await projectServiceFixture(cleanups, async (operation) =>
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
  try {
    const imported = await fixture.call("asset.import", {
      requestId: "imported-recovery-source",
      path: fixture.path,
    });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const assetId = (await fixture.job((imported.data as { jobId: string }).jobId, "ready"))
      .published!.output.assetId;
    const generation = "recovery-imported";
    const importedRoot = join(
      fixture.home,
      "library",
      "transcripts",
      "imported",
      assetId,
      generation,
    );
    await mkdir(importedRoot, { recursive: true });
    await writeFile(
      join(importedRoot, "source.srt"),
      "1\n00:00:00,000 --> 00:00:00,001\nrecovery\n",
    );
    const catalog = fixture.service.captures.catalog;
    catalog
      .prepare(
        "INSERT INTO imported_transcripts(requestId,source,generation,format,parser,timingBasis,timingPolicy,alignmentModelId,alignmentChannel,rawSha256,rawBytes,metadata,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "recovery-import",
        JSON.stringify({ assetId, streamId: "image" }),
        generation,
        "srt",
        "{}",
        "cue",
        "supplied",
        null,
        null,
        "seed",
        10,
        "{}",
        "complete",
      );
    catalog
      .prepare("INSERT INTO imported_transcript_cues VALUES(?,?,?,?,?,?,?,?,?)")
      .run(generation, 0, "recovery-cue", 0, 1, "recovery", null, null, "[]");
    await rm(fixture.service.assets.path(assetId));
    const plans = new DeletionPlans(fixture.service.captures);
    plans.create("asset", assetId, false, []);
    plans.setPhase("asset", assetId, "drained");
    await fixture.service.close();
    const reopened = await projectServiceFixture(
      cleanups,
      async () => ({ ok: true, data: {} }),
      fixture.home,
    );
    await reopened.call("asset.delete", { requestId: "imported-recovery-replay", assetId });
    await expect(access(importedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      reopened.service.captures.catalog.prepare("SELECT COUNT(*) AS count FROM assets").get(),
    ).toEqual({ count: 0 });
    expect(
      reopened.service.captures.catalog
        .prepare("SELECT COUNT(*) AS count FROM imported_transcripts WHERE generation=?")
        .get(generation),
    ).toEqual({ count: 0 });
  } finally {
    await Promise.all(
      cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => cleanup()),
    );
  }
});
