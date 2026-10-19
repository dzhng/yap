import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { AcquisitionStore } from "./acquisitions.js";
import { AssetStore } from "./assets.js";
import { Catalog, catalogFormat } from "./catalog.js";
import { DeletionPlans } from "./deletion-plans.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { ProjectStore } from "./projects.js";
import { TranscriptStore } from "./transcript.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const canvas = {
  width: 160,
  height: 96,
  fps: { numerator: 30, denominator: 1 },
  background: "#000000ff",
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
const renamed = (value: JsonObject, from: string, to: string): JsonObject =>
  from in value
    ? Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key === from ? to : key, child]),
      )
    : value;
const walk = (value: Json, visit: (object: JsonObject) => JsonObject): Json =>
  Array.isArray(value)
    ? value.map((item) => walk(item, visit))
    : isObject(value)
      ? visit(
          Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, walk(child, visit)]),
          ),
        )
      : value;

/** The shapes 0.1.61 wrote, from shapes this build writes: what the migration must undo. */
function asWrittenBy0161(table: string, column: string, value: Json, row: Record<string, unknown>) {
  let next = walk(value, (object) =>
    typeof object.kind === "string" &&
    ["import", "asset", "acquisition", "project", "recording"].includes(object.kind) &&
    "id" in object
      ? renamed(object, "id", `${object.kind}Id`)
      : object,
  );
  const revision = (item: Json) => (isObject(item) ? renamed(item, "id", "revisionId") : item);
  if (table === "project_revisions" && column === "content") next = revision(next);
  if (table === "projects" && column === "createResult" && isObject(next))
    next = {
      ...next,
      project: renamed(next.project as JsonObject, "id", "projectId"),
      revision: revision(next.revision!),
    };
  if (table === "project_requests" && column === "result" && isObject(next)) {
    if ("ordinal" in next) next = revision(next);
    else if (isObject(next.edit)) {
      const edit = next.edit as JsonObject;
      next = {
        ...next,
        revision: revision(next.revision!),
        edit: {
          ...edit,
          createdIds: (edit.createdIds as JsonObject[]).map((entry) =>
            renamed(entry, "id", "entityId"),
          ),
          normalized: (edit.normalized as JsonObject[]).map((step) => ({
            ...step,
            changes: (step.changes as JsonObject[]).map((change) => {
              const named = renamed(change, "id", "changeId");
              return isObject(named.value)
                ? { ...named, value: renamed(named.value, "id", "entityId") }
                : named;
            }),
          })),
        },
      };
    }
  }
  if (table === "deletion_requests" && column === "result" && isObject(next))
    next = renamed(next, "id", `${String(row.subjectKind)}Id`);
  return next;
}

/** Every JSON-bearing text cell in the catalog, by table, column and row. */
function cells(db: DatabaseSync) {
  const found: { table: string; column: string; rowid: number; text: string }[] = [];
  const tables = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string; sql: string }[];
  for (const { name, sql } of tables) {
    if (sql.includes("WITHOUT ROWID")) continue;
    const columns = (
      db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]
    )
      .filter((column) => column.type === "TEXT")
      .map((column) => column.name);
    for (const column of columns)
      for (const row of db
        .prepare(`SELECT rowid AS rowid_,"${column}" AS text FROM "${name}"`)
        .all() as { rowid_: number; text: unknown }[])
        if (typeof row.text === "string" && /^[[{]/.test(row.text))
          found.push({ table: name, column, rowid: row.rowid_, text: row.text });
  }
  return found;
}

test("a format-29 library migrates back to exactly what this build writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "yap-format-30-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "catalog.sqlite");
  const catalog = new Catalog(path);
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const projects = projectStoreFixture(catalog, assets, home);
  const created = projects.create({ requestId: "create", title: "Interview", canvas });
  const edited = projects.apply(created.project.id, {
    requestId: "add",
    expectedRevisionId: created.revision.id,
    operations: [{ operation: "track.add", track: { kind: "audio", order: 0 }, label: "voice" }],
  });
  projects.undo(created.project.id, { requestId: "undo", expectedRevisionId: edited.revision.id });
  projects.duplicate({ requestId: "copy", projectId: created.project.id });
  const plans = new DeletionPlans(catalog);
  plans.recordRequest("delete-asset", "asset", "asset-1", false, 7);
  plans.saveSubjectRequestResults("asset", "asset-1", {
    id: "asset-1",
    deleted: true,
    freedBytes: 7,
  });
  // A job whose input embeds a project target, as project audio processing's recipe does.
  const input = JSON.stringify({
    recipe: { target: { kind: "project", id: "p", revisionId: "r" } },
  });
  catalog.catalog.exec(
    "CREATE TABLE jobs_probe (input TEXT NOT NULL, inputSha256 TEXT NOT NULL) STRICT",
  );
  catalog.catalog.prepare("INSERT INTO jobs_probe VALUES(?,?)").run(input, sha(input));
  catalog.close();

  const db = new DatabaseSync(path);
  const current = cells(db);
  let aged = 0;
  for (const cell of current) {
    const row = db.prepare(`SELECT * FROM "${cell.table}" WHERE rowid=?`).get(cell.rowid) as Record<
      string,
      unknown
    >;
    const old = JSON.stringify(
      asWrittenBy0161(cell.table, cell.column, JSON.parse(cell.text), row),
    );
    if (old === cell.text) continue;
    aged++;
    db.prepare(`UPDATE "${cell.table}" SET "${cell.column}"=? WHERE rowid=?`).run(old, cell.rowid);
    if (cell.column === "input")
      db.prepare(`UPDATE "${cell.table}" SET inputSha256=? WHERE rowid=?`).run(
        sha(old),
        cell.rowid,
      );
  }
  db.exec("PRAGMA user_version=29");
  db.close();
  // Revisions, create and edit replays, an undo, a duplicate, a delete replay and a job input.
  expect(aged).toBeGreaterThanOrEqual(9);

  new Catalog(path).close();
  const migrated = new DatabaseSync(path);
  expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: catalogFormat });
  expect(cells(migrated)).toEqual(current);
  expect(migrated.prepare("SELECT inputSha256 FROM jobs_probe").get()).toEqual({
    inputSha256: sha(input),
  });
  migrated.close();

  const reopened = new Catalog(path);
  cleanup.push(async () => reopened.close());
  const store = projectStoreFixture(reopened, new AssetStore(reopened, home), home);
  expect(
    store.apply(created.project.id, {
      requestId: "add",
      expectedRevisionId: created.revision.id,
      operations: [{ operation: "track.add", track: { kind: "audio", order: 0 }, label: "voice" }],
    }),
  ).toEqual(edited);
});

/** Every place an old shape survives in a migrated catalog, including JSON held in strings. */
function oldShapes(db: DatabaseSync): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, at: string): void => {
    if (typeof value === "string" && /^[[{]/.test(value)) {
      try {
        visit(JSON.parse(value), `${at}<json>`);
      } catch {
        // Not a document.
      }
      return;
    }
    if (Array.isArray(value)) return value.forEach((item) => visit(item, `${at}[]`));
    if (!isObject(value)) return;
    const kind = value.kind;
    if (typeof kind === "string" && `${kind}Id` in value && !("id" in value))
      if (["import", "asset", "acquisition", "project", "recording"].includes(kind))
        found.add(`${at}: owner`);
    if ("revisionId" in value && "ordinal" in value && "document" in value)
      found.add(`${at}: revision`);
    if ("entityId" in value || "changeId" in value) found.add(`${at}: edit report`);
    if (
      value.deleted === true &&
      Object.keys(value).some((key) => /^(asset|project|recording|acquisition)Id$/.test(key))
    )
      found.add(`${at}: delete result`);
    if ("projectId" in value && "title" in value && "currentRevisionId" in value)
      found.add(`${at}: project`);
    for (const [key, child] of Object.entries(value)) visit(child, `${at}.${key}`);
  };
  for (const cell of cells(db)) visit(JSON.parse(cell.text), `${cell.table}.${cell.column}`);
  return [...found];
}

test.for(["format-29-editing", "format-29-deletion"])(
  "a catalog 0.1.61 wrote (%s) opens migrated with no old shape left",
  async (name) => {
    const home = await mkdtemp(join(tmpdir(), "yap-format-29-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const path = join(home, "catalog.sqlite");
    await copyFile(new URL(`../fixtures/${name}.sqlite`, import.meta.url), path);
    const catalog = new Catalog(path);
    cleanup.push(async () => catalog.close());
    expect(catalog.catalog.prepare("PRAGMA user_version").get()).toEqual({
      user_version: catalogFormat,
    });
    expect(oldShapes(catalog.catalog)).toEqual([]);
    // Background transcription queues behind interactive work, so every job carries a priority.
    expect(
      catalog.catalog
        .prepare("SELECT dflt_value FROM pragma_table_info('jobs') WHERE name='priority'")
        .get(),
    ).toEqual({ dflt_value: "'interactive'" });
    const projects = new ProjectStore(
      catalog,
      new AssetStore(catalog, home),
      new TranscriptStore(catalog, home, () => {}),
      new AcquisitionStore(catalog),
    );
    const listed = projects.list({ limit: 1000 }).projects;
    if (name === "format-29-editing") expect(listed.length).toBeGreaterThan(0);
    for (const project of listed)
      for (const revision of projects.history(project.id, null, 1000).revisions)
        expect(revision).toMatchObject({ id: expect.any(String), projectId: project.id });
    const replays = catalog.catalog
      .prepare("SELECT requestId FROM deletion_requests WHERE result IS NOT NULL")
      .all() as { requestId: string }[];
    if (name === "format-29-deletion") expect(replays.length).toBeGreaterThan(0);
    for (const { requestId } of replays)
      expect(new DeletionPlans(catalog).request(requestId)?.result).toMatchObject({
        id: expect.any(String),
        deleted: true,
      });
  },
);

test("a format-29 catalog a development build already gave job priorities still migrates", async () => {
  const home = await mkdtemp(join(tmpdir(), "yap-format-29-priority-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "catalog.sqlite");
  await copyFile(new URL("../fixtures/format-29-editing.sqlite", import.meta.url), path);
  const touched = new DatabaseSync(path);
  touched.exec(
    "ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'interactive' CHECK(priority IN ('interactive','background'))",
  );
  touched.exec("UPDATE jobs SET priority='background' WHERE rowid=(SELECT min(rowid) FROM jobs)");
  touched.close();
  const catalog = new Catalog(path);
  cleanup.push(async () => catalog.close());
  expect(catalog.catalog.prepare("PRAGMA user_version").get()).toEqual({
    user_version: catalogFormat,
  });
  expect(oldShapes(catalog.catalog)).toEqual([]);
  expect(
    catalog.catalog.prepare("SELECT count(*) AS n FROM jobs WHERE priority='background'").get(),
  ).toEqual({ n: 1 });
});
