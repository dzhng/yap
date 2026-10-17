import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../dist/assets.js";
import { Catalog } from "../dist/catalog.js";
import { LibraryUsers } from "../dist/library-users.js";
import { ResourceReferences } from "../dist/references.js";

const root = await mkdtemp(join(tmpdir(), "yap-library-users-"));
const catalog = new Catalog(join(root, "catalog.sqlite"));
try {
  const assets = new AssetStore(catalog, root);
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
  const addAsset = async (id, content) => {
    const fileName = `${id}.mp4`,
      path = join(root, "assets", fileName);
    await writeFile(path, content);
    const bytes = Number((await stat(path)).size);
    catalog.catalog
      .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
      .run(id, JSON.stringify({ id, bytes, fileName, createdAt: "now", streams: [] }));
    return { id, bytes };
  };
  const addProject = (id, title, revisions, deletedAt = null) => {
    catalog.catalog
      .prepare(
        "INSERT INTO projects(projectId,title,createdAt,currentRevisionId,deletedAt,createRequestId,createArguments,createResult) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, title, "now", revisions.at(-1), deletedAt, `request-${id}`, "{}", "{}");
    for (const [ordinal, revisionId] of revisions.entries())
      catalog.catalog
        .prepare("INSERT INTO project_revisions(id,projectId,ordinal,content) VALUES(?,?,?,?)")
        .run(revisionId, id, ordinal, "{}");
  };
  const addAcquisition = (id, recordingId) =>
    catalog.catalog
      .prepare("INSERT INTO acquisitions VALUES(?,?,?,?)")
      .run(id, `request-${id}`, JSON.stringify({ kind: "capture", recordingId }), "{}");

  const undo = await addAsset("asset-undo", "undo clip");
  addProject("project-undo", "Undo holder", ["undo-1", "undo-2"]);
  references.retain("asset", { kind: "revision", id: "undo-1" }, [undo.id]);
  references.retain("asset", { kind: "revision", id: "undo-2" }, [undo.id]);

  const two = await addAsset("asset-two-projects", "two projects");
  addProject("project-a", "A", ["a-1", "a-2"]);
  addProject("project-b", "B", ["b-1"]);
  for (const revisionId of ["a-1", "a-2", "b-1"])
    references.retain("asset", { kind: "revision", id: revisionId }, [two.id]);

  const source = await addAsset("asset-source", "source");
  const hdr = await addAsset("asset-hdr", "hdr output");
  references.retain("asset", { kind: "asset", id: hdr.id }, [source.id]);
  addProject("project-derived", "Derived", ["derived-1"]);
  references.retain("asset", { kind: "revision", id: "derived-1" }, [hdr.id]);

  const deleting = await addAsset("asset-deleting-project", "deleting");
  addProject("project-deleting", "Deleting", ["deleting-1"], "now");
  references.retain("asset", { kind: "revision", id: "deleting-1" }, [deleting.id]);

  const acquisitionId = "acquisition-capture";
  addAcquisition(acquisitionId, "recording-1");
  const acquisitionPath = join(root, "acquisitions", acquisitionId);
  await mkdir(acquisitionPath, { recursive: true });
  await writeFile(join(acquisitionPath, "source.bin"), "capture bytes");
  addProject("project-capture", "Capture", ["capture-1"]);
  references.retain("acquisition", { kind: "revision", id: "capture-1" }, [acquisitionId]);

  const users = new LibraryUsers(catalog, {
    asset: (id) => [assets.path(id)],
    acquisition: (id) => [join(root, "acquisitions", id)],
    recording: (id) => [join(root, "recordings", id)],
    project: () => [],
  });
  console.log(
    JSON.stringify(
      {
        undo: users.usersOf({ kind: "asset", id: undo.id }),
        twoProjects: users.usersOf({ kind: "asset", id: two.id }),
        derivedChain: users.usersOf({ kind: "asset", id: source.id }),
        deletingProject: users.usersOf({ kind: "asset", id: deleting.id }),
        captureAcquisition: users.usersOf({ kind: "acquisition", id: acquisitionId }),
      },
      null,
      2,
    ),
  );
} finally {
  catalog.close();
  await rm(root, { recursive: true, force: true });
}
