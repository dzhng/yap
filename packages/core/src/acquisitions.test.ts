import { add, fromTime, toTime } from "@yap/composition";
import { fileIdentity } from "./files.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { CaptureSourceRead } from "./capture-source-read.js";
import { selectSource } from "./source-selection.js";
import { compositionAsset } from "./assets.js";
import { createSourceRangeProjection, validateComposition } from "@yap/composition";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { SourceEvidenceStore } from "./evidence.js";
import { AcquisitionStore, AcquisitionImporter } from "./acquisitions.js";
import type { SourceExporter } from "./source-admission.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acquisition-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const catalog = new Catalog(join(root, "catalog.sqlite"));
  cleanup.push(async () => catalog.close());
  const assets = new AssetStore(catalog, root);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const evidence = new SourceEvidenceStore(catalog, (identity) => {
    if (identity.owner.kind !== "acquisition") throw new CatalogError("NOT_FOUND", "Wrong domain");
    acquisitions.intent(identity.owner.id);
  });
  const importer = new AcquisitionImporter(catalog, acquisitions, assets, evidence, root);
  await importer.recover(signal());
  const donor = join(root, "donor");
  await mkdir(donor);
  const journal = JSON.stringify({
    sessionID: "capture-session",
    intervals: [
      { startUs: 100, endUs: 140 },
      { startUs: 160, endUs: 200 },
    ],
  });
  await writeFile(join(donor, "capture.journal.jsonl"), journal);
  await writeFile(join(donor, "video.mov"), "video");
  await writeFile(join(donor, "narration.mov"), "narration");
  const exportSource: SourceExporter = async (directory, output) => {
    // Native boundary fixture: parsing/capture acceptance belongs to the live native journey.
    const input = JSON.parse(await readFile(join(directory, "capture.journal.jsonl"), "utf8"));
    const body = input.intervals
      .map(
        (interval: { startUs: number; endUs: number }) =>
          JSON.stringify({ event: "audioAcquired", data: { role: "narration", ...interval } }) +
          "\n",
      )
      .join("");
    await writeFile(output, body);
    return {
      file: output,
      journal: "capture.journal.jsonl",
      header: { sessionID: input.sessionID },
      cursorSamples: 0,
      geometryRecords: 0,
      displaySpaces: 0,
      pauseEvents: 0,
      audioIntervals: input.intervals.length,
      lastSequence: input.intervals.length,
      incompleteTail: false,
      finished: true,
      bytes: Buffer.byteLength(body),
    };
  };
  const probe = async (path: string) => {
    const kind = (await readFile(path, "utf8")) === "video" ? "video" : "audio";
    return {
      originUs: 100,
      streams: [
        {
          id: "track:1",
          kind,
          codec: "fixture",
          ...(kind === "video"
            ? { width: 16, height: 16, orientedWidth: 16, orientedHeight: 16 }
            : {}),
          decodable: true,
          startUs: 0,
          endUs: 100,
          segments: [{ startUs: 0, endUs: 100, empty: false }],
        },
      ],
    };
  };
  return {
    root,
    catalog,
    assets,
    evidence,
    acquisitions,
    importer,
    donor,
    journal,
    native: { probe, exportSource },
    admit: async (requestId = "import") => {
      const prepared = await importer.prepareImport(requestId, donor);
      return catalog.transaction(() => acquisitions.admitImport(prepared));
    },
  };
}

test("adoption retains raw clock evidence, normalized masks and owned bytes after donor deletion", async () => {
  const f = await fixture();
  const intent = await f.admit();
  const value = await f.importer.executeImport(
    intent.acquisitionId,
    "attempt-1",
    f.native,
    signal(),
  );
  await rm(f.donor, { recursive: true });
  expect(await readFile(f.importer.journalPath(value.id), "utf8")).toBe(f.journal);
  expect(value.journal.sha256).toBe(createHash("sha256").update(f.journal).digest("hex"));
  expect(
    value.bindings.map(({ sourceRoles, available, sourceToAssetOffsetUs, supportBasis }) => ({
      sourceRoles,
      available,
      sourceToAssetOffsetUs,
      supportBasis,
    })),
  ).toEqual([
    {
      sourceRoles: ["video"],
      available: [{ startUs: 0, endUs: 100 }],
      sourceToAssetOffsetUs: -100,
      supportBasis: "physical",
    },
    {
      sourceRoles: ["narration"],
      available: [
        { startUs: 0, endUs: 40 },
        { startUs: 60, endUs: 100 },
      ],
      sourceToAssetOffsetUs: -100,
      supportBasis: "captured-audio",
    },
  ]);
  expect(f.evidence.audio(value.evidence, "narration", { startUs: 0, endUs: 300 })).toEqual([
    { startUs: 100, endUs: 140 },
    { startUs: 160, endUs: 200 },
  ]);
  for (const binding of value.bindings) {
    expect(await readFile(f.assets.path(binding.assetId), "utf8")).toBe(binding.sourceRoles[0]);
    expect(f.assets.references(binding.assetId)).toEqual([{ kind: "acquisition", id: value.id }]);
  }
  expect(await f.importer.prepareImport("import", f.donor)).toEqual(intent);
  expect(await f.importer.executeImport(value.id, "attempt-2", f.native, signal())).toEqual(value);
  await f.importer.recover(signal());
  expect(f.acquisitions.get(value.id)).toEqual(value);
});

test("same media keeps explicit contexts through project replay, replacement, undo and reopening", async () => {
  const f = await fixture();
  const first = await f.admit();
  const a = await f.importer.executeImport(first.acquisitionId, "a", f.native, signal());
  await writeFile(
    join(f.donor, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: "capture-session", intervals: [{ startUs: 100, endUs: 200 }] }),
  );
  const second = await f.admit("second");
  const b = await f.importer.executeImport(second.acquisitionId, "b", f.native, signal());
  const assetId = a.bindings.find((binding) => binding.sourceRoles.includes("narration"))!.assetId;
  expect(b.bindings.find((binding) => binding.sourceRoles.includes("narration"))!.assetId).toBe(
    assetId,
  );
  const projects = projectStoreFixture(f.catalog, f.assets, f.root, f.acquisitions);
  const created = projects.create({
    requestId: "project",
    canvas: {
      width: 160,
      height: 90,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.id;
  const request = {
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      ...[a.id, b.id, undefined].map((acquisitionId, index) => ({
        operation: "place",
        label: `clip-${index}`,
        clip: {
          assetId,
          streamId: "track:1",
          ...(acquisitionId ? { acquisitionId } : {}),
          trackId: { label: "audio" },
          source: { kind: "range", range: { startUs: 0, endUs: 100 } },
          placement: { kind: "project", range: { startUs: index * 100, endUs: (index + 1) * 100 } },
        },
      })),
    ],
  };
  const placed = projects.apply(projectId, request);
  expect(projects.apply(projectId, request)).toEqual(placed);
  const completeness = (revisionId: string) => {
    const revision = projects.revision(projectId, revisionId);
    return createSourceRangeProjection(
      validateComposition(
        revision.document,
        [compositionAsset(f.assets.get(assetId))],
        projects.contexts(revision.document),
      ),
    )
      .all({ assetId, streamId: "track:1", range: { startUs: 30, endUs: 70 } })
      .map((row) => row.completeness);
  };
  expect(completeness(placed.revision.id)).toEqual(["partial", "whole", "whole"]);
  const replaced = projects.apply(projectId, {
    requestId: "replace",
    expectedRevisionId: placed.revision.id,
    operations: [
      {
        operation: "replace",
        clipId: placed.edit.labels["clip-0"],
        kind: "audio",
        media: {
          assetId,
          streamId: "track:1",
          source: { kind: "range", range: { startUs: 0, endUs: 100 } },
        },
      },
    ],
  });
  expect(completeness(replaced.revision.id)).toEqual(["whole", "whole", "whole"]);
  expect(completeness(placed.revision.id)).toEqual(["partial", "whole", "whole"]);
  const undone = projects.undo(projectId, {
    requestId: "undo",
    expectedRevisionId: replaced.revision.id,
  });
  expect(completeness(undone.id)).toEqual(["partial", "whole", "whole"]);
  expect(f.acquisitions.references(a.id)).toEqual(
    expect.arrayContaining([
      { kind: "revision", id: placed.revision.id },
      { kind: "revision", id: undone.id },
    ]),
  );
  const reopenedCatalog = new Catalog(join(f.root, "catalog.sqlite"));
  cleanup.push(async () => reopenedCatalog.close());
  const reopened = projectStoreFixture(
    reopenedCatalog,
    new AssetStore(reopenedCatalog, f.root),
    f.root,
  );
  expect(reopened.apply(projectId, request)).toEqual(placed);
  expect(reopened.contexts(reopened.revision(projectId).document)).toEqual([
    f.acquisitions.context(a.id),
    f.acquisitions.context(b.id),
  ]);
});

test("changed frozen members refuse publication and canceled adoption releases partial dependencies", async () => {
  const f = await fixture();
  const changed = await f.admit();
  await writeFile(join(f.donor, "capture.journal.jsonl"), f.journal + "\n");
  await expect(
    f.importer.executeImport(changed.acquisitionId, "changed", f.native, signal()),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(() => f.acquisitions.get(changed.acquisitionId)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  const fresh = await f.admit("fresh");
  const controller = new AbortController();
  let probes = 0;
  await expect(
    f.importer.executeImport(
      fresh.acquisitionId,
      "canceled",
      {
        ...f.native,
        probe: async (path, probeSignal) => {
          const value = await f.native.probe(path);
          if (++probes === 2) controller.abort(new Error("cancel import"));
          probeSignal.throwIfAborted();
          return value;
        },
      },
      controller.signal,
    ),
  ).rejects.toThrow("cancel import");
  expect(probes).toBe(2);
  expect(() => f.acquisitions.get(fresh.acquisitionId)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  for (const asset of f.assets.list().assets) expect(f.assets.references(asset.id)).toEqual([]);
  expect(() =>
    f.evidence.audio(
      {
        owner: { kind: "acquisition", id: fresh.acquisitionId },
        sourceId: "capture-session",
        generation: "canceled",
      },
      "narration",
      { startUs: 0, endUs: 300 },
    ),
  ).toThrow(expect.objectContaining({ code: "PREREQUISITE_MISSING" }));
  await f.importer.recover(signal());
  const value = await f.importer.executeImport(fresh.acquisitionId, "retried", f.native, signal());
  expect(value.evidence.generation).toBe("retried");
  expect(value.bindings.map((row) => row.sourceRoles)).toEqual([["video"], ["narration"]]);
});

test("identical captured role files share one usable binding only when their support agrees", async () => {
  const f = await fixture();
  await writeFile(join(f.donor, "system.mov"), "narration");
  for (const conflict of [false, true]) {
    await writeFile(
      join(f.donor, "capture.journal.jsonl"),
      JSON.stringify({
        sessionID: "capture-session",
        intervals: [
          { role: "narration", startUs: 100, endUs: 200 },
          { role: "system", startUs: 100, endUs: conflict ? 190 : 200 },
        ],
      }),
    );
    const intent = await f.admit(conflict ? "conflict" : "equal");
    const result = f.importer.executeImport(
      intent.acquisitionId,
      conflict ? "different" : "same",
      f.native,
      signal(),
    );
    if (conflict) {
      await expect(result).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
      expect(() => f.acquisitions.get(intent.acquisitionId)).toThrow(
        expect.objectContaining({ code: "NOT_READY" }),
      );
    } else {
      const value = await result;
      expect(value.bindings.map((row) => row.sourceRoles)).toEqual([
        ["video"],
        ["narration", "system"],
      ]);
      expect(f.acquisitions.context(value.id).bindings).toHaveLength(2);
      expect(value.bindings[1]!.available).toEqual([{ startUs: 0, endUs: 100 }]);
    }
  }
});

test("unacquired audio remains empty and ambiguous capture streams refuse publication", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: "capture-session", intervals: [] }),
  );
  const empty = await f.admit();
  const value = await f.importer.executeImport(empty.acquisitionId, "empty", f.native, signal());
  expect(value.bindings.find((row) => row.sourceRoles.includes("narration"))!.available).toEqual(
    [],
  );
  const ambiguous = await f.admit("ambiguous");
  // Distinct media bytes force a new native probe rather than immutable-asset deduplication.
  await writeFile(join(f.donor, "narration.mov"), "different audio");
  const fresh = await f.admit("fresh-multiple");
  await expect(
    f.importer.executeImport(
      fresh.acquisitionId,
      "multiple",
      {
        ...f.native,
        probe: async (path) => {
          const result = await f.native.probe(path);
          if (result.streams[0]!.kind === "audio")
            result.streams.push({ ...result.streams[0]!, id: "track:2" });
          return result;
        },
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(() => f.acquisitions.get(fresh.acquisitionId)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  await expect(
    f.importer.executeImport(ambiguous.acquisitionId, "changed", f.native, signal()),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

test("source inspection uses the same physical/context support and asset clock as composition", async () => {
  const f = await fixture();
  const admitted = await f.admit();
  const acquisition = await f.importer.executeImport(
    admitted.acquisitionId,
    "selected",
    f.native,
    signal(),
  );
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("narration"))!;
  const selector = { assetId: binding.assetId, streamId: binding.streamId };
  const physical = selectSource(f.assets, f.acquisitions, selector);
  const captured = selectSource(f.assets, f.acquisitions, {
    ...selector,
    acquisitionId: acquisition.id,
  });
  expect(physical.track).toEqual({
    source: f.assets.path(binding.assetId),
    streamId: binding.streamId,
    sourceOffsetUs: -100,
    available: [{ startUs: 0, endUs: 100 }],
  });
  expect(captured.track).toEqual({
    ...physical.track,
    available: [
      { startUs: 0, endUs: 40 },
      { startUs: 60, endUs: 100 },
    ],
  });
  expect(captured.durationUs).toBe(100);
  expect(captured.supportDigest).not.toBe(physical.supportDigest);
  expect(selectSource(f.assets, f.acquisitions, selector)).toEqual(physical);
  const unrelated = await f.assets.import(
    join(f.donor, "capture.journal.jsonl"),
    { kind: "import" },
    f.native.probe,
  );
  expect(() =>
    selectSource(f.assets, f.acquisitions, {
      ...selector,
      assetId: unrelated.id,
      acquisitionId: acquisition.id,
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  expect(() =>
    selectSource(f.assets, f.acquisitions, { ...selector, streamId: "missing" }),
  ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_MEDIA" }));
});

test("adoption retains explicit completion independently of selected-stream support", async () => {
  const f = await fixture();
  const completion = {
    sequence: 2,
    state: "interrupted" as const,
    durationUs: 700,
    failureCode: "DEVICE_LOST",
  };
  const native = {
    ...f.native,
    exportSource: async (...args: Parameters<SourceExporter>) => ({
      ...(await f.native.exportSource(...args)),
      completion,
      lastLifecycle: { state: "interrupted", reason: "DEVICE_LOST" },
    }),
  };
  const intent = await f.admit();
  const result = await f.importer.executeImport(
    intent.acquisitionId,
    "completion",
    native,
    signal(),
  );
  await rm(f.donor, { recursive: true });
  const reopenedCatalog = new Catalog(join(f.root, "catalog.sqlite"));
  cleanup.push(async () => reopenedCatalog.close());
  const retained = new AcquisitionStore(reopenedCatalog).get(result.id);
  expect(retained.evidence.receipt.completion).toEqual(completion);
  expect(retained.bindings.every((binding) => binding.available.at(-1)!.endUs === 100)).toBe(true);
  expect(f.evidence.audio(retained.evidence, "narration", { startUs: 0, endUs: 1000 })).toEqual([
    { startUs: 100, endUs: 140 },
    { startUs: 160, endUs: 200 },
  ]);
});

test("pointer history derives the capture clock and full selected stream at the acquisition owner", async () => {
  const f = await fixture(),
    intent = await f.admit();
  const acquisition = await f.importer.executeImport(
    intent.acquisitionId,
    "history",
    f.native,
    signal(),
  );
  const capture = new CaptureSourceRead(f.assets, f.acquisitions, f.evidence);
  const video = acquisition.bindings.find((binding) => binding.sourceRoles.includes("video"))!;
  const selection = {
    assetId: video.assetId,
    streamId: video.streamId,
    acquisitionId: acquisition.id,
  };
  expect(capture.presentation(selection)).toEqual({
    source: f.assets.path(video.assetId),
    streamId: "track:1",
    clockOffsetUs: 0,
    spans: [{ startUs: 100, endUs: 200 }],
    evidence: acquisition.evidence,
  });
  expect(() => capture.presentation({ assetId: video.assetId, streamId: video.streamId })).toThrow(
    /captured-video authority/,
  );
  const audio = acquisition.bindings.find((binding) => binding.sourceRoles.includes("narration"))!;
  expect(() =>
    capture.presentation({ ...selection, assetId: audio.assetId, streamId: audio.streamId }),
  ).toThrow(/captured-video authority/);
});

async function portableNative(f: Awaited<ReturnType<typeof fixture>>) {
  const values = f.assets.list().assets.map((value) => f.assets.get(value.id));
  const assetFiles = new Map(
    await Promise.all(
      values.map(async (asset) => {
        const path = f.assets.path(asset.id),
          stat = await lstat(path, { bigint: true });
        return [
          asset.id,
          { path, bytes: Number(stat.size), identity: fileIdentity(stat) },
        ] as const;
      }),
    ),
  );
  return {
    exportSource: f.native.exportSource,
    assetFiles,
    assets: new Map(values.map((asset) => [asset.id, asset])),
  };
}

test("portable acquisition adoption preserves source identities, evidence and bound asset ownership", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  const intent = await donor.admit();
  const original = await donor.importer.executeImport(
    intent.acquisitionId,
    "portable-generation",
    donor.native,
    signal(),
  );
  const pinned = donor.importer.portable(original.id);
  const native = await portableNative(donor);
  const hashed = async (file: typeof pinned.files.journal) => ({
    ...file,
    sha256: createHash("sha256")
      .update(await readFile(file.path))
      .digest("hex"),
  });
  const portableFiles = {
    journal: await hashed(pinned.files.journal),
    normalized: await hashed(pinned.files.normalized),
  };
  await expect(
    receiver.importer.stagePortable(
      { ...pinned.acquisition, id: original.id.toUpperCase() },
      portableFiles,
      signal(),
      native,
    ),
  ).rejects.toThrow(/canonical/);
  const collisionDirectory = join(receiver.root, "acquisitions", original.id);
  await mkdir(collisionDirectory);
  await writeFile(join(collisionDirectory, "retained"), "must survive failed staging");
  await expect(
    receiver.importer.stagePortable(pinned.acquisition, portableFiles, signal(), native),
  ).rejects.toThrow(/EEXIST/);
  expect(await readFile(join(collisionDirectory, "retained"), "utf8")).toBe(
    "must survive failed staging",
  );
  await rm(collisionDirectory, { recursive: true });
  const stagedAssets = await Promise.all(
    [...new Set(original.bindings.map((binding) => binding.assetId))].map((id) =>
      receiver.assets.stagePortable(donor.assets.portable(id), donor.assets.path(id), signal()),
    ),
  );
  const staged = await receiver.importer.stagePortable(
    pinned.acquisition,
    portableFiles,
    signal(),
    native,
  );
  expect(() => receiver.acquisitions.get(original.id)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  expect(receiver.assets.list().assets).toEqual([]);
  receiver.catalog.transaction(() => {
    for (const asset of stagedAssets) asset.publish();
    staged.publish();
  });
  await staged.close();
  for (const asset of stagedAssets) await asset.close();
  const adopted = receiver.acquisitions.get(original.id);
  expect(receiver.importer.portable(original.id).acquisition).toEqual(pinned.acquisition);
  expect(adopted.evidence.receipt.file).not.toBe(original.evidence.receipt.file);
  expect([...receiver.evidence.exportRecords(adopted.evidence, "narration")]).toEqual([
    ...donor.evidence.exportRecords(original.evidence, "narration"),
  ]);
  for (const binding of original.bindings)
    expect(receiver.assets.references(binding.assetId)).toContainEqual({
      kind: "acquisition",
      id: original.id,
    });
  await rm(donor.donor, { recursive: true });
  await rm(donor.importer.journalPath(original.id));
  await rm(original.evidence.receipt.file);
  expect(await readFile(receiver.importer.journalPath(original.id), "utf8")).toBe(donor.journal);
  await expect(
    receiver.importer.stagePortable(
      {
        ...pinned.acquisition,
        receipt: {
          ...pinned.acquisition.receipt,
          header: { ...pinned.acquisition.receipt.header, provenance: "changed" },
        },
      },
      portableFiles,
      signal(),
      native,
    ),
  ).rejects.toThrow(/conflict/);
});

test("unpublished portable acquisitions recover and transactional failures leave no visible owner", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  const intent = await donor.admit();
  const original = await donor.importer.executeImport(
    intent.acquisitionId,
    "portable-rollback",
    donor.native,
    signal(),
  );
  const pinned = donor.importer.portable(original.id);
  const native = await portableNative(donor);
  const files = {
    journal: {
      ...pinned.files.journal,
      sha256: createHash("sha256")
        .update(await readFile(pinned.files.journal.path))
        .digest("hex"),
    },
    normalized: {
      ...pinned.files.normalized,
      sha256: createHash("sha256")
        .update(await readFile(pinned.files.normalized.path))
        .digest("hex"),
    },
  };
  const assets = await Promise.all(
    [...new Set(original.bindings.map((binding) => binding.assetId))].map((id) =>
      receiver.assets.stagePortable(donor.assets.portable(id), donor.assets.path(id), signal()),
    ),
  );
  const stage = await receiver.importer.stagePortable(pinned.acquisition, files, signal(), native);
  expect(() =>
    receiver.catalog.transaction(() => {
      assets.forEach((asset) => asset.publish());
      stage.publish();
      throw new Error("project revision failure");
    }),
  ).toThrow("project revision failure");
  expect(receiver.assets.list().assets).toEqual([]);
  expect(() => receiver.acquisitions.get(original.id)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  await stage.close();
  for (const asset of assets) await asset.close();
  expect(() => receiver.acquisitions.intent(original.id)).toThrow(/does not exist/);
  // Restart recovery also reclaims a staged acquisition whose caller never closed it.
  await receiver.importer.stagePortable(pinned.acquisition, files, signal(), native);
  await receiver.importer.recover(signal());
  expect(() => receiver.acquisitions.intent(original.id)).toThrow(/does not exist/);
  const retry = await receiver.importer.stagePortable(pinned.acquisition, files, signal(), native);
  await retry.close();
});

test("publication receipt absence is frozen before queued capture admission", async () => {
  const f = await fixture();
  const intent = await f.admit();
  await writeFile(join(f.donor, "narration.publication.json"), "new proof after admission");
  await expect(
    f.importer.executeImport(intent.acquisitionId, "changed-proof", f.native, signal()),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(f.assets.list().assets).toEqual([]);
  expect(() => f.acquisitions.get(intent.acquisitionId)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
});

test.each(["layout", "duplicate-role", "support"] as const)(
  "portable readiness independently verifies %s metadata",
  async (change) => {
    const f = await fixture();
    const intent = await f.admit();
    const original = await f.importer.executeImport(
      intent.acquisitionId,
      "proof",
      f.native,
      signal(),
    );
    const pinned = f.importer.portable(original.id);
    const files = Object.fromEntries(
      await Promise.all(
        Object.entries(pinned.files).map(async ([key, file]) => [
          key,
          {
            ...file,
            sha256: createHash("sha256")
              .update(await readFile(file.path))
              .digest("hex"),
          },
        ]),
      ),
    ) as import("./acquisitions.js").PortableAcquisitionFiles;
    const forged = structuredClone(pinned.acquisition);
    const binding = forged.bindings.find((row) => row.sourceRoles.includes("narration"))!;
    if (change === "layout") forged.receipt.header = { ...forged.receipt.header, schemaVersion: 1 };
    if (change === "duplicate-role") forged.bindings.push(structuredClone(binding));
    if (change === "support")
      binding.available[0]!.startUs = toTime(
        add(fromTime(binding.available[0]!.startUs), fromTime(1)),
      );
    await expect(
      f.importer.verifyPortable(forged, files, signal(), await portableNative(f)),
    ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
    await f.importer.verifyPortable(pinned.acquisition, files, signal(), await portableNative(f));
  },
);

test("integer capture evidence maps into exact normalized acquisition support", async () => {
  const f = await fixture(),
    intent = await f.admit();
  const value = await f.importer.executeImport(
    intent.acquisitionId,
    "exact",
    {
      ...f.native,
      probe: async (path) => ({
        ...(await f.native.probe(path)),
        originUs: { numerator: 199, denominator: 2 },
      }),
    },
    signal(),
  );
  const binding = value.bindings.find((row) => row.sourceRoles.includes("narration"))!;
  expect(binding.sourceToAssetOffsetUs).toEqual({ numerator: -199, denominator: 2 });
  expect(binding.available).toEqual([
    { startUs: { numerator: 1, denominator: 2 }, endUs: { numerator: 81, denominator: 2 } },
    { startUs: { numerator: 121, denominator: 2 }, endUs: { numerator: 201, denominator: 2 } },
  ]);
  const selected = selectSource(f.assets, f.acquisitions, {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: value.id,
  });
  expect(selected.track.available).toEqual([
    binding.available[0],
    { startUs: { numerator: 121, denominator: 2 }, endUs: 100 },
  ]);
  expect(f.evidence.audio(value.evidence, "narration", { startUs: 0, endUs: 300 })).toEqual([
    { startUs: 100, endUs: 140 },
    { startUs: 160, endUs: 200 },
  ]);
});

type CameraSegment = { startUs: number; endUs: number; empty: boolean };
/** Native boundary fixture: the receipt carries a camera proof and the probe reports edit segments. */
function cameraNative(
  f: Awaited<ReturnType<typeof fixture>>,
  proof: Record<string, unknown>,
  originUs: number,
  segments: CameraSegment[],
) {
  const canonical = { bytes: "5", sha256: createHash("sha256").update("video").digest("hex") };
  return {
    exportSource: (async (...args) => ({
      ...(await f.native.exportSource(...args)),
      publications: { video: { ...proof, canonical } },
    })) as SourceExporter,
    probe: async (path: string) => {
      const probed = await f.native.probe(path);
      if (probed.streams[0]!.kind !== "video") return probed;
      return {
        originUs,
        streams: [{ ...probed.streams[0]!, startUs: 0, endUs: segments.at(-1)!.endUs, segments }],
      };
    },
  };
}
const cameraFile = { bytes: "10", sha256: "b".repeat(64) };
const gappedCameraProof = {
  receipt: cameraFile,
  mapping: cameraFile,
  representedFrames: 9,
  support: { startUs: 100, endUs: 400 },
  gaps: [
    { startUs: 150, endUs: 200 },
    { startUs: 250, endUs: 300 },
  ],
};
// Canonical edits for the gapped proof at asset origin 100: occupied pictures, empty edits between.
const gappedCameraSegments = [
  { startUs: 0, endUs: 50, empty: false },
  { startUs: 50, endUs: 100, empty: true },
  { startUs: 100, endUs: 150, empty: false },
  { startUs: 150, endUs: 200, empty: true },
  { startUs: 200, endUs: 300, empty: false },
];

test("a gapped camera proof admits a canonical movie whose occupied edits equal its intervals", async () => {
  const f = await fixture();
  const intent = await f.admit("gapped-camera");
  const value = await f.importer.executeImport(
    intent.acquisitionId,
    "gapped",
    cameraNative(f, gappedCameraProof, 100, gappedCameraSegments),
    signal(),
  );
  const video = value.bindings.find((row) => row.sourceRoles.includes("video"))!;
  expect(video.available).toEqual([
    { startUs: 0, endUs: 50 },
    { startUs: 100, endUs: 150 },
    { startUs: 200, endUs: 300 },
  ]);
  expect(video.sourceToAssetOffsetUs).toBe(-100);
  expect(value.evidence.receipt.publications?.video?.gaps).toEqual(gappedCameraProof.gaps);
});

test.each([
  [
    "a held picture across the off time",
    gappedCameraProof,
    [{ startUs: 0, endUs: 300, empty: false }],
  ],
  [
    "gaps the canonical edits do not show",
    { ...gappedCameraProof, gaps: [{ startUs: 150, endUs: 210 }, gappedCameraProof.gaps[1]!] },
    gappedCameraSegments,
  ],
  [
    "a continuous proof over a gapped movie",
    { ...gappedCameraProof, gaps: undefined },
    gappedCameraSegments,
  ],
])("camera admission refuses %s", async (_name, proof, segments) => {
  const f = await fixture();
  const intent = await f.admit("refused-camera");
  await expect(
    f.importer.executeImport(
      intent.acquisitionId,
      "refused",
      cameraNative(f, proof, 100, segments),
      signal(),
    ),
  ).rejects.toMatchObject({
    code: "INVALID_EVIDENCE",
    message: "Camera physical support differs from verified source support",
  });
  expect(() => f.acquisitions.get(intent.acquisitionId)).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
});

test("a 0.1.33 camera proof admits unchanged", async () => {
  const f = await fixture();
  // Proof stored by release 0.1.33 for corpus B's camera take
  // (specs/done/camera-toggle/assets/pre-toggle-corpus/b.tar.gz, acquisitions table); only the canonical
  // identity is replaced by this fixture's movie.
  const retained = {
    mapping: {
      bytes: "9654",
      sha256: "ac4c08db438064cfdd2204cb9ae9104fd7f7b24fa9e7c84ff724252b3c3efdff",
    },
    receipt: {
      bytes: "1018",
      sha256: "90560b7900b880187d91376efdfc94927798c72a25270329eab6459dc318c064",
    },
    representedFrames: 5,
    support: { endUs: 933333, startUs: 200000 },
  };
  const intent = await f.admit("camera-0.1.33");
  const value = await f.importer.executeImport(
    intent.acquisitionId,
    "attempt-1",
    cameraNative(f, retained, 200000, [{ startUs: 0, endUs: 733333, empty: false }]),
    signal(),
  );
  const video = value.bindings.find((row) => row.sourceRoles.includes("video"))!;
  expect(video.available).toEqual([{ startUs: 0, endUs: 733333 }]);
  expect(value.evidence.receipt.publications?.video).toEqual({
    ...retained,
    canonical: { bytes: "5", sha256: createHash("sha256").update("video").digest("hex") },
  });
});
