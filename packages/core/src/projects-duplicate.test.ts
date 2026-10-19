import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { TranscriptStore } from "./transcript.js";
import { assetTranscriptOwner } from "./transcript-processing.js";
import { ProjectStore, type DuplicateStep } from "./projects.js";
import { LibraryUsers } from "./library-users.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("duplicates the selected document into a one-revision project", async () => {
  const home = await mkdtemp("/tmp/yap-project-duplicate-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const transcripts = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  const projects = new ProjectStore(catalog, assets, transcripts, acquisitions);
  const canvas = {
    width: 160,
    height: 96,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const source = projects.create({ requestId: "source-create", title: "Demo", canvas });
  const edited = projects.apply(source.project.projectId, {
    requestId: "source-edit",
    expectedRevisionId: source.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { ...canvas, width: 320 } }],
  });

  const copy = projects.duplicate({
    requestId: "duplicate",
    projectId: source.project.projectId,
    revisionId: edited.revision.revisionId,
  });

  expect(copy.project.title).toBe("Demo copy");
  expect(copy.revision.projectId).toBe(copy.project.projectId);
  expect(copy.revision.document).toEqual(edited.revision.document);
  expect(projects.history(copy.project.projectId)).toEqual({
    revisions: [copy.revision],
    nextCursor: null,
  });
});

test("duplicate replays the same request and rejects changed arguments", async () => {
  const home = await mkdtemp("/tmp/yap-project-duplicate-replay-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const transcripts = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  const projects = new ProjectStore(catalog, assets, transcripts, acquisitions);
  const canvas = {
    width: 160,
    height: 96,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const source = projects.create({ requestId: "source-create", title: "Demo", canvas });
  const request = { requestId: "duplicate", projectId: source.project.projectId };
  const first = projects.duplicate(request);
  expect(projects.duplicate(request)).toEqual(first);
  expect(() => projects.duplicate({ ...request, title: "Other" })).toThrowError(
    expect.objectContaining({ code: "REQUEST_CONFLICT" }),
  );
});

test("duplicate retains only the assets in the copied document", async () => {
  const home = await mkdtemp("/tmp/yap-project-duplicate-users-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const probe = async () => ({
    originUs: 0,
    streams: [
      {
        id: "a",
        kind: "audio" as const,
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1_000,
        segments: [{ startUs: 0, endUs: 1_000, empty: false }],
      },
    ],
  });
  const firstPath = join(home, "first.wav");
  const secondPath = join(home, "second.wav");
  await writeFile(firstPath, "first");
  await writeFile(secondPath, "second");
  const firstAsset = await assets.import(firstPath, { kind: "import" }, probe);
  const secondAsset = await assets.import(secondPath, { kind: "import" }, probe);
  const acquisitions = new AcquisitionStore(catalog);
  const transcripts = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  const projects = new ProjectStore(catalog, assets, transcripts, acquisitions);
  const canvas = {
    width: 160,
    height: 96,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const source = projects.create({ requestId: "source-create", canvas });
  const placed = projects.apply(source.project.projectId, {
    requestId: "place",
    expectedRevisionId: source.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "track" },
      {
        operation: "place",
        label: "first",
        clip: {
          trackId: { label: "track" },
          assetId: firstAsset.id,
          streamId: "a",
          source: { kind: "range", range: { startUs: 0, endUs: 1_000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1_000 } },
        },
      },
    ],
  });
  const withBoth = projects.apply(source.project.projectId, {
    requestId: "place-second",
    expectedRevisionId: placed.revision.revisionId,
    operations: [
      {
        operation: "place",
        clip: {
          trackId: placed.revision.document.tracks[0]!.id,
          assetId: secondAsset.id,
          streamId: "a",
          source: { kind: "range", range: { startUs: 0, endUs: 1_000 } },
          placement: { kind: "project", range: { startUs: 1_000, endUs: 2_000 } },
        },
      },
    ],
  });
  const current = projects.apply(source.project.projectId, {
    requestId: "remove-first",
    expectedRevisionId: withBoth.revision.revisionId,
    operations: [{ operation: "remove", clipIds: [placed.edit.labels.first!], ripple: "none" }],
  });
  const copy = projects.duplicate({
    requestId: "duplicate-users",
    projectId: source.project.projectId,
    revisionId: current.revision.revisionId,
  });
  const files = {
    asset: (id: string) => [assets.path(id)],
    acquisition: () => [],
    recording: () => [],
    project: () => [],
  };
  const firstUsers = new LibraryUsers(catalog, files).usersOf({
    kind: "asset",
    id: firstAsset.id,
  });
  const secondUsers = new LibraryUsers(catalog, files).usersOf({
    kind: "asset",
    id: secondAsset.id,
  });
  expect(firstUsers.usedBy.map(({ id }) => id)).toEqual([source.project.projectId]);
  expect(secondUsers.usedBy.map(({ id }) => id).sort()).toEqual(
    [source.project.projectId, copy.project.projectId].sort(),
  );
});

test("duplicate rolls back every catalog and reference write after an injected failure", async () => {
  const home = await mkdtemp("/tmp/yap-project-duplicate-atomic-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const transcripts = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  let failure: DuplicateStep | undefined;
  const projects = new ProjectStore(catalog, assets, transcripts, acquisitions, (step) => {
    if (step === failure) throw new Error(`duplicate failure at ${step}`);
  });
  const canvas = {
    width: 160,
    height: 96,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const mediaPath = join(home, "media.wav");
  await writeFile(mediaPath, "media");
  const asset = await assets.import(mediaPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "a",
        kind: "audio" as const,
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1_000,
        segments: [{ startUs: 0, endUs: 1_000, empty: false }],
      },
    ],
  }));
  const source = projects.create({ requestId: "source-create", canvas });
  projects.apply(source.project.projectId, {
    requestId: "source-place",
    expectedRevisionId: source.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "track" },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "a",
          source: { kind: "range", range: { startUs: 0, endUs: 1_000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1_000 } },
        },
      },
    ],
  });
  const baseline = {
    projects: (
      catalog.catalog.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }
    ).count,
    revisions: (
      catalog.catalog.prepare("SELECT COUNT(*) AS count FROM project_revisions").get() as {
        count: number;
      }
    ).count,
    references: (
      catalog.catalog.prepare("SELECT COUNT(*) AS count FROM resource_references").get() as {
        count: number;
      }
    ).count,
  };
  for (const [index, step] of (
    ["project", "references", "revision", "result"] as DuplicateStep[]
  ).entries()) {
    failure = step;
    expect(() =>
      projects.duplicate({
        requestId: `duplicate-failure-${index}`,
        projectId: source.project.projectId,
      }),
    ).toThrow(`duplicate failure at ${step}`);
    expect(
      (catalog.catalog.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number })
        .count,
    ).toBe(baseline.projects);
    expect(
      (
        catalog.catalog.prepare("SELECT COUNT(*) AS count FROM project_revisions").get() as {
          count: number;
        }
      ).count,
    ).toBe(baseline.revisions);
    expect(
      (
        catalog.catalog.prepare("SELECT COUNT(*) AS count FROM resource_references").get() as {
          count: number;
        }
      ).count,
    ).toBe(baseline.references);
    expect(
      catalog.catalog
        .prepare("SELECT COUNT(*) AS count FROM projects WHERE createRequestId=?")
        .get(`duplicate-failure-${index}`),
    ).toEqual({ count: 0 });
  }
});
