import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { ResourceReferences } from "./references.js";
import { LibraryUsers } from "./library-users.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const home = await mkdtemp("/tmp/yap-library-users-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const references = new ResourceReferences(catalog);
  catalog.catalog.exec(`
    CREATE TABLE projects (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL, createdAt TEXT NOT NULL, currentRevisionId TEXT NOT NULL,
      deletedAt TEXT, createRequestId TEXT UNIQUE NOT NULL, createArguments TEXT NOT NULL,
      createResult TEXT NOT NULL
    );
    CREATE TABLE project_revisions (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, ordinal INTEGER NOT NULL,
      content TEXT NOT NULL, UNIQUE(projectId,ordinal)
    );
    CREATE TABLE project_undo (projectId TEXT NOT NULL, position INTEGER NOT NULL, targetId TEXT NOT NULL,
      PRIMARY KEY(projectId,position));
    CREATE TABLE acquisitions (
      id TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, admission TEXT NOT NULL, metadata TEXT
    );
  `);
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const files = {
    asset: (id: string) => [assets.path(id)],
    acquisition: (id: string) => [join(home, "acquisitions", id)],
    recording: (id: string) => [join(home, "recordings", id)],
    project: () => [],
  };
  return { home, catalog, assets, references, files };
}

async function addAsset(f: Awaited<ReturnType<typeof fixture>>, id: string, content: string) {
  const fileName = `${id}.mp4`;
  const path = join(f.home, "assets", fileName);
  await writeFile(path, content);
  const bytes = Number((await stat(path)).size);
  f.catalog.catalog
    .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
    .run(id, JSON.stringify({ id, bytes, fileName, createdAt: "now", streams: [] }));
  return { id, path, bytes };
}

function addProject(
  f: Awaited<ReturnType<typeof fixture>>,
  projectId: string,
  title: string,
  revisionIds: string[],
  deletedAt: string | null = null,
) {
  f.catalog.catalog
    .prepare(
      "INSERT INTO projects(projectId,title,createdAt,currentRevisionId,deletedAt,createRequestId,createArguments,createResult) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      projectId,
      title,
      "now",
      revisionIds.at(-1) ?? null,
      deletedAt,
      `request-${projectId}`,
      "{}",
      "{}",
    );
  for (const [ordinal, revisionId] of revisionIds.entries())
    f.catalog.catalog
      .prepare("INSERT INTO project_revisions(id,projectId,ordinal,content) VALUES(?,?,?,?)")
      .run(revisionId, projectId, ordinal, "{}");
}

function addAcquisition(f: Awaited<ReturnType<typeof fixture>>, id: string, recordingId?: string) {
  f.catalog.catalog
    .prepare("INSERT INTO acquisitions VALUES(?,?,?,?)")
    .run(
      id,
      `request-${id}`,
      JSON.stringify(recordingId ? { kind: "capture", recordingId } : {}),
      "{}",
    );
}

test("reports a clip retained only by a project's undo history and its actual bytes", async () => {
  const f = await fixture();
  const assetId = "asset-undo";
  const { bytes } = await addAsset(f, assetId, "undo clip");
  addProject(f, "project-1", "Undo holder", ["revision-1", "revision-2"]);
  f.references.retain("asset", { kind: "revision", id: "revision-1" }, [assetId]);
  f.references.retain("asset", { kind: "revision", id: "revision-2" }, [assetId]);

  const result = new LibraryUsers(f.catalog, f.files).usersOf({
    kind: "asset",
    id: assetId,
  });
  expect(result).toMatchObject({
    usedBy: [{ kind: "project", projectId: "project-1", title: "Undo holder", revisions: 2 }],
    acquisitions: [],
    derivedAssets: [],
    freesBytes: bytes,
    cascadeFreesBytes: bytes,
  });
});

test("collapses two projects and all of their revisions into project users", async () => {
  const f = await fixture();
  const asset = await addAsset(f, "asset-two-projects", "two projects");
  addProject(f, "project-a", "A", ["a-1", "a-2"]);
  addProject(f, "project-b", "B", ["b-1"]);
  for (const revisionId of ["a-1", "a-2", "b-1"])
    f.references.retain("asset", { kind: "revision", id: revisionId }, [asset.id]);
  expect(
    new LibraryUsers(f.catalog, f.files).usersOf({ kind: "asset", id: asset.id }),
  ).toMatchObject({
    usedBy: [
      { kind: "project", projectId: "project-a", title: "A", revisions: 2 },
      { kind: "project", projectId: "project-b", title: "B", revisions: 1 },
    ],
    freesBytes: asset.bytes,
    cascadeFreesBytes: asset.bytes,
  });
});

test("follows a derived asset chain and reports only the live using project", async () => {
  const f = await fixture();
  const source = await addAsset(f, "asset-source", "source");
  const hdr = await addAsset(f, "asset-hdr", "hdr output");
  f.references.retain("asset", { kind: "asset", id: hdr.id }, [source.id]);
  addProject(f, "project-derived", "Derived", ["derived-1"]);
  f.references.retain("asset", { kind: "revision", id: "derived-1" }, [hdr.id]);
  const result = new LibraryUsers(f.catalog, f.files).usersOf({
    kind: "asset",
    id: source.id,
  });
  expect(result).toMatchObject({
    usedBy: [{ projectId: "project-derived", revisions: 1 }],
    derivedAssets: [{ kind: "asset", assetId: hdr.id }],
    freesBytes: source.bytes,
    cascadeFreesBytes: source.bytes + hdr.bytes,
  });
});

test("skips a project that is already being deleted", async () => {
  const f = await fixture();
  const asset = await addAsset(f, "asset-deleting-project", "deleting");
  addProject(f, "project-deleting", "Deleting", ["deleting-1"], "now");
  f.references.retain("asset", { kind: "revision", id: "deleting-1" }, [asset.id]);
  expect(
    new LibraryUsers(f.catalog, f.files).usersOf({ kind: "asset", id: asset.id }),
  ).toMatchObject({
    usedBy: [],
    freesBytes: asset.bytes,
    cascadeFreesBytes: asset.bytes,
  });
});

test("reports a capture acquisition used by a project and counts its managed files", async () => {
  const f = await fixture();
  const acquisitionId = "acquisition-capture";
  addAcquisition(f, acquisitionId, "recording-1");
  const directory = join(f.home, "acquisitions", acquisitionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "source.bin"), "capture bytes");
  const acquisitionBytes = Number((await stat(join(directory, "source.bin"))).size);
  const recordingDirectory = join(f.home, "recordings", "recording-1");
  await mkdir(recordingDirectory, { recursive: true });
  await writeFile(join(recordingDirectory, "take.mov"), "recording bytes");
  const recordingBytes = Number((await stat(join(recordingDirectory, "take.mov"))).size);
  addProject(f, "project-capture", "Capture", ["capture-1"]);
  f.references.retain("acquisition", { kind: "revision", id: "capture-1" }, [acquisitionId]);
  const result = new LibraryUsers(f.catalog, f.files).usersOf({
    kind: "acquisition",
    id: acquisitionId,
  });
  expect(result).toMatchObject({
    usedBy: [{ projectId: "project-capture", title: "Capture", revisions: 1 }],
    freesBytes: acquisitionBytes,
    cascadeFreesBytes: acquisitionBytes,
  });
  expect(
    new LibraryUsers(f.catalog, f.files).usersOf({ kind: "recording", id: "recording-1" }),
  ).toMatchObject({
    usedBy: [{ projectId: "project-capture" }],
    freesBytes: recordingBytes,
    cascadeFreesBytes: acquisitionBytes + recordingBytes,
  });
});

test("does not treat a recording's own acquisition as a live asset owner", async () => {
  const f = await fixture();
  const asset = await addAsset(f, "asset-copy", "copy bytes");
  addAcquisition(f, "capture-copy", "recording-own");
  f.references.retain("asset", { kind: "acquisition", id: "capture-copy" }, [asset.id]);
  const recordingPath = join(f.home, "recordings", "recording-own");
  await mkdir(recordingPath, { recursive: true });
  await writeFile(join(recordingPath, "take.mov"), "take bytes");
  const recordingBytes = Number((await stat(join(recordingPath, "take.mov"))).size);
  const result = new LibraryUsers(f.catalog, f.files).usersOf({
    kind: "recording",
    id: "recording-own",
  });
  expect(result.freesBytes).toBe(recordingBytes + asset.bytes);
});
