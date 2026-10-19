import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Record identity (specs/done/record-identity): every stored record names itself `id` and every
 * owner reference is `{kind, id}`. This module is the one place older stored shapes are
 * rewritten: catalog format 29 → 30 once, and a version-6 project package's members as it is
 * imported. No reader accepts two shapes.
 */

/** Catalog format 29 → 30, inside the caller's transaction. */
export function migrateToFormat30(catalog: DatabaseSync): void {
  const tables = catalog
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name: table } of tables) {
    const columns = catalog.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string;
      type: string;
      pk: number;
    }[];
    const text = columns.filter((column) => column.type === "TEXT").map((column) => column.name);
    if (!text.length) continue;
    const rowid = !(
      catalog.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }
    ).sql.includes("WITHOUT ROWID");
    // A rowid read under its own name, since a table's INTEGER PRIMARY KEY renames the column.
    const keys = rowid
      ? ["rowid"]
      : columns.filter((column) => column.pk > 0).map((column) => `"${column.name}"`);
    const rows = catalog
      .prepare(
        `SELECT ${[...keys.map((key, index) => `${key} AS key${index}`), ...text.map((name) => `"${name}"`)].join(",")} FROM "${table}"`,
      )
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const changed: Record<string, string> = {};
      for (const column of text) {
        const stored = row[column];
        if (typeof stored !== "string" || !/^[[{]/.test(stored)) continue;
        let value: unknown;
        try {
          value = JSON.parse(stored);
        } catch {
          continue;
        }
        const rewritten = rewrite(table, column, value);
        const next = canonicalColumns.has(`${table}.${column}`)
          ? canonical(rewritten)
          : JSON.stringify(rewritten);
        if (next !== stored) changed[column] = next;
      }
      // A job input names its artifact by digest; a rewritten input keeps its digest in step.
      if (changed.input !== undefined && text.includes("inputSha256"))
        changed.inputSha256 = createHash("sha256").update(changed.input).digest("hex");
      const assignments = Object.keys(changed);
      if (!assignments.length) continue;
      catalog
        .prepare(
          `UPDATE "${table}" SET ${assignments.map((name) => `"${name}"=?`).join(",")} WHERE ${keys
            .map((key) => `${key}=?`)
            .join(" AND ")}`,
        )
        .run(
          ...assignments.map((name) => changed[name]!),
          ...keys.map((_, index) => row[`key${index}`] as never),
        );
    }
  }
}

const ownerKinds = new Set(["import", "asset", "acquisition", "project", "recording"]);
/** Replay keys stored as canonical JSON (sorted keys), which a renamed key must keep sorted. */
const canonicalColumns = new Set(["projects.createArguments", "project_requests.arguments"]);
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The same object with one key renamed in place, so key order (and canonical text) is kept. */
function renamed(value: JsonObject, from: string, to: string): JsonObject {
  if (!(from in value) || to in value) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key === from ? to : key, child]),
  );
}

function rewrite(table: string, column: string, value: unknown): unknown {
  let next = snapshots(owners(inStrings(value as Json, (inner) => snapshots(owners(inner)))));
  if (table === "project_revisions" && column === "content") next = revision(next);
  if (table === "projects" && column === "createResult") next = created(next);
  if (table === "project_requests" && column === "result") next = projectResult(next);
  if (table === "deletion_requests" && column === "result") next = deleted(next);
  return next;
}

/** `{kind: "asset", assetId}` and its siblings become `{kind, id}`, anywhere in a document. */
function owners(value: Json): Json {
  if (Array.isArray(value)) return value.map(owners);
  if (!isObject(value)) return value;
  let next: JsonObject = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, owners(child)]),
  );
  if (typeof next.kind === "string" && ownerKinds.has(next.kind))
    next = renamed(next, `${next.kind}Id`, "id");
  return next;
}

/**
 * A project snapshot (a package adoption's replay key, a package export's pinned history) names
 * its project and revisions by `id`, wherever it is stored.
 */
function snapshots(value: Json): Json {
  if (Array.isArray(value)) return value.map(snapshots);
  if (!isObject(value)) return value;
  const next: JsonObject = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, snapshots(child)]),
  );
  if (!isObject(next.project) || !Array.isArray(next.revisions) || !("undo" in next)) return next;
  return {
    ...next,
    project: renamed(next.project, "projectId", "id"),
    revisions: next.revisions.map(revision),
  };
}

const revision = (value: Json): Json =>
  isObject(value) ? renamed(value, "revisionId", "id") : value;

function created(value: Json): Json {
  if (!isObject(value)) return value;
  return {
    ...value,
    ...(isObject(value.project) ? { project: renamed(value.project, "projectId", "id") } : {}),
    ...(isObject(value.revision) ? { revision: revision(value.revision) } : {}),
  };
}

/**
 * A replayed project edit: the revision it made names itself `id`, and its edit report keeps
 * composition's own names and no copy of the document the revision already carries.
 */
function projectResult(value: Json): Json {
  if (!isObject(value)) return value;
  if ("ordinal" in value && "document" in value) return revision(value);
  if (!isObject(value.revision)) return value;
  const next: JsonObject = { ...value, revision: revision(value.revision) };
  if (isObject(value.edit)) {
    const { document: _document, ...edit } = value.edit;
    next.edit = {
      ...edit,
      ...(Array.isArray(edit.createdIds)
        ? {
            createdIds: edit.createdIds.map((entry) =>
              isObject(entry) ? renamed(entry, "entityId", "id") : entry,
            ),
          }
        : {}),
      ...(Array.isArray(edit.normalized)
        ? {
            normalized: edit.normalized.map((step) =>
              isObject(step) && Array.isArray(step.changes)
                ? {
                    ...step,
                    changes: step.changes.map((change) => {
                      if (!isObject(change)) return change;
                      const named = renamed(change, "changeId", "id");
                      return isObject(named.value)
                        ? { ...named, value: renamed(named.value, "entityId", "id") }
                        : named;
                    }),
                  }
                : step,
            ),
          }
        : {}),
    };
  }
  return next;
}

/** A replayed delete returns the deleted record's stub. */
function deleted(value: Json): Json {
  if (!isObject(value) || value.deleted !== true) return value;
  const own = Object.keys(value).find((key) =>
    /^(asset|project|recording|acquisition)Id$/.test(key),
  );
  return own ? renamed(value, own, "id") : value;
}

/**
 * Preset request receipts as 0.1.61 stored them (an unversioned file): a `preset.delete`
 * result named its preset `presetId`.
 */
export function presetReceiptsFrom0161(
  receipts: Record<string, { input: string; result: unknown }>,
): Record<string, { input: string; result: unknown }> {
  return Object.fromEntries(
    Object.entries(receipts).map(([requestId, receipt]) => [
      requestId,
      isObject(receipt.result)
        ? { ...receipt, result: renamed(receipt.result, "presetId", "id") }
        : receipt,
    ]),
  );
}

/** A member of a version-6 project package, in the version-7 shape. */
export function packageMemberFromVersion6(
  member: "manifest" | "revision" | "metadata",
  value: unknown,
): unknown {
  if (member === "revision") return revision(owners(value as Json));
  if (member === "manifest")
    return isObject(value) && isObject(value.project)
      ? { ...value, project: renamed(value.project, "projectId", "id") }
      : value;
  const metadata = (inner: Json) => observations(snapshots(owners(inner)));
  return metadata(inStrings(value as Json, metadata));
}

/**
 * Strings that hold a JSON document (a publication's input or result) are rewritten the same
 * way. A string whose document doesn't change keeps its exact bytes.
 */
function inStrings(value: Json, transform: (value: Json) => Json): Json {
  if (typeof value === "string") {
    if (!/^[[{]/.test(value)) return value;
    let parsed: Json;
    try {
      parsed = JSON.parse(value) as Json;
    } catch {
      return value;
    }
    const next = JSON.stringify(transform(inStrings(parsed, transform)));
    return next === JSON.stringify(parsed) ? value : next;
  }
  if (Array.isArray(value)) return value.map((item) => inStrings(item, transform));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, inStrings(child, transform)]),
  );
}

/** A packaged face or observation region names itself `id`. */
function observations(value: Json): Json {
  if (Array.isArray(value)) return value.map(observations);
  if (!isObject(value)) return value;
  let next: JsonObject = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, observations(child)]),
  );
  if ("boundingBox" in next) next = renamed(next, "faceId", "id");
  if ("rect" in next || "requestedRect" in next) next = renamed(next, "regionId", "id");
  return next;
}
