import { ResourceReferences, resourceKinds, type ResourceReference } from "./references.js";
import { archiveLimits, checkProjectJsonBytes } from "./package-archive.js";
import { AcquisitionStore } from "./acquisitions.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  applyBatch,
  getProcessing,
  validateComposition,
  compositionSchema,
  editOperationSchema,
  textSeedCuesSchema,
  documentAssetIds,
  documentAcquisitionIds,
  clipAssetIds,
  type Composition,
  type EditBatchResult,
  omit,
} from "@yap/composition";
import { TranscriptStore } from "./transcript.js";
import { seedTextOperations, textSeeds, validateTextSeeds } from "./text-seeds.js";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore, compositionAsset } from "./assets.js";
import { speakerCorrectionSchema, type SpeakerCorrection } from "./speaker-attribution.js";
import { pageCursor } from "./page-cursor.js";

export type Project = {
  id: string;
  title: string;
  createdAt: string;
  currentRevisionId: string;
};
export type ProjectRevision = {
  id: string;
  projectId: string;
  ordinal: number;
  createdAt: string;
  operation: "create" | "apply" | "undo" | "restore";
  document: EditBatchResult["document"];
  speakerCorrections?: SpeakerCorrection[];
};
export type ProjectSnapshot = {
  project: Project;
  revisions: ProjectRevision[];
  undo: string[];
  references: { revisionId: string; resources: ResourceReference[] }[];
};
export const projectSnapshotReferencesSchema = z
  .array(
    z.strictObject({
      revisionId: z.string().min(1),
      resources: z
        .array(z.strictObject({ kind: z.enum(resourceKinds), id: z.string().min(1).max(2048) }))
        .max(25000),
    }),
  )
  .max(archiveLimits.history)
  .refine((values) => values.reduce((sum, value) => sum + value.resources.length, 0) <= 25000);
const projectSnapshotSchema = z.strictObject({
  project: z.strictObject({
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.string().min(1),
    currentRevisionId: z.string().min(1),
  }),
  revisions: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        projectId: z.string().min(1),
        ordinal: z.number().int().nonnegative(),
        createdAt: z.string().min(1),
        operation: z.enum(["create", "apply", "undo", "restore"]),
        document: compositionSchema,
        speakerCorrections: z.array(speakerCorrectionSchema).optional(),
      }),
    )
    .min(1)
    .max(archiveLimits.history),
  undo: z.array(z.string().min(1)).max(archiveLimits.history),
  references: projectSnapshotReferencesSchema,
});
/** Untrusted snapshots must retain a complete ordered history and a valid undo stack. */
export function validateProjectSnapshot(value: unknown): ProjectSnapshot {
  const result = projectSnapshotSchema.safeParse(value);
  if (!result.success) throw new CatalogError("INVALID_PACKAGE", "Invalid project snapshot");
  const snapshot = result.data;
  const ids = new Set<string>();
  for (const [ordinal, revision] of snapshot.revisions.entries()) {
    if (
      revision.ordinal !== ordinal ||
      revision.projectId !== snapshot.project.id ||
      ids.has(revision.id)
    )
      throw new CatalogError("INVALID_PACKAGE", "Project history is incomplete or ambiguous");
    ids.add(revision.id);
  }
  if (
    snapshot.project.currentRevisionId !== snapshot.revisions.at(-1)!.id ||
    snapshot.undo.some((id) => !ids.has(id))
  )
    throw new CatalogError("INVALID_PACKAGE", "Project head or undo target is missing");
  const owners = new Set<string>();
  for (const reference of snapshot.references) {
    if (!ids.has(reference.revisionId) || owners.has(reference.revisionId))
      throw new CatalogError("INVALID_PACKAGE", "Revision dependency owner is missing or repeated");
    owners.add(reference.revisionId);
    const resources = new Set(
      reference.resources.map((value) => JSON.stringify([value.kind, value.id])),
    );
    if (resources.size !== reference.resources.length)
      throw new CatalogError("INVALID_PACKAGE", "Revision dependency is repeated");
  }
  return {
    ...snapshot,
    revisions: snapshot.revisions.map((revision) =>
      revision.speakerCorrections === undefined
        ? ({ ...revision } as ProjectRevision)
        : (revision as ProjectRevision),
    ),
  };
}
export type ProjectEditResult = {
  revision: ProjectRevision;
  edit: any;
};
function editResult(
  result: ProjectEditResult & { edit: { document?: EditBatchResult["document"] } },
): ProjectEditResult {
  // The revision already carries the document; the edit reports only what changed.
  const clean = (value: any): any =>
    Array.isArray(value)
      ? value.map(clean)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, child]) => child !== undefined)
              .map(([key, child]) => [key, clean(child)]),
          )
        : value;
  return clean({ revision: result.revision, edit: omit(result.edit, "document") });
}
export type ProjectHistoryCursor = string;
export type DuplicateStep = "project" | "references" | "revision" | "result";
const projectColumns = "projectId AS id,title,createdAt,currentRevisionId";
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CatalogError("INVALID_PARAMS", result.error.message);
  return result.data;
}
function pageLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new CatalogError("INVALID_PARAMS", "Page limit must be 1–1000");
}

/** Immutable revisions and replay receipts share the catalog transaction with asset references. */
export class ProjectStore {
  private readonly references: ResourceReferences;
  constructor(
    private readonly store: Catalog,
    private readonly assets: AssetStore,
    private readonly transcripts: TranscriptStore,
    private readonly acquisitions = new AcquisitionStore(store),
    private readonly duplicateFault?: (step: DuplicateStep) => void,
  ) {
    this.references = new ResourceReferences(store);
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL, createdAt TEXT NOT NULL, currentRevisionId TEXT NOT NULL,
        deletedAt TEXT, createRequestId TEXT UNIQUE NOT NULL, createArguments TEXT NOT NULL,
        createResult TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_revisions (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, ordinal INTEGER NOT NULL,
        content TEXT NOT NULL, UNIQUE(projectId,ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_requests (
        projectId TEXT NOT NULL, requestId TEXT NOT NULL, arguments TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(projectId,requestId)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_undo (
        projectId TEXT NOT NULL, position INTEGER NOT NULL, targetId TEXT NOT NULL,
        PRIMARY KEY(projectId,position)
      ) STRICT;
    `);
  }
  create(input: { requestId: string; title?: string; canvas: unknown }): {
    project: Project;
    revision: ProjectRevision;
  } {
    const canvas = parsed(compositionSchema.shape.canvas, input.canvas);
    const title = input.title ?? "Untitled";
    const argumentsKey = canonical({ canvas, title });
    return this.store.transaction(() => {
      const prior = this.store.catalog
        .prepare("SELECT createArguments,createResult FROM projects WHERE createRequestId=?")
        .get(input.requestId);
      if (prior) {
        if (prior.createArguments !== argumentsKey)
          throw new CatalogError(
            "REQUEST_CONFLICT",
            "Request ID was already used with different arguments",
          );
        return JSON.parse(prior.createResult as string);
      }
      const projectId = randomUUID(),
        id = randomUUID(),
        createdAt = new Date().toISOString();
      const document: Composition = {
        canvas,
        tracks: [],
        groups: [],
        clips: [],
        syncGroups: [],
        processing: [],
      };
      const revision: ProjectRevision = {
        id,
        projectId,
        ordinal: 0,
        createdAt,
        operation: "create",
        document,
      };
      const project: Project = { id: projectId, title, createdAt, currentRevisionId: id };
      const result = { project, revision };
      this.store.catalog
        .prepare(
          `INSERT INTO projects(projectId,title,createdAt,currentRevisionId,createRequestId,createArguments,createResult) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          projectId,
          title,
          createdAt,
          id,
          input.requestId,
          argumentsKey,
          JSON.stringify(result),
        );
      this.insertRevision(revision);
      return result;
    });
  }
  duplicate(input: { requestId: string; projectId: string; revisionId?: string; title?: string }): {
    project: Project;
    revision: ProjectRevision;
  } {
    const argumentsKey = canonical({
      operation: "duplicate",
      projectId: input.projectId,
      revisionId: input.revisionId ?? null,
      title: input.title ?? null,
    });
    return this.store.transaction(() => {
      const prior = this.store.catalog
        .prepare("SELECT createArguments,createResult FROM projects WHERE createRequestId=?")
        .get(input.requestId);
      if (prior) {
        if (prior.createArguments !== argumentsKey)
          throw new CatalogError(
            "REQUEST_CONFLICT",
            "Request ID was already used with different arguments",
          );
        return JSON.parse(prior.createResult as string) as {
          project: Project;
          revision: ProjectRevision;
        };
      }
      const source = this.get(input.projectId);
      const selected = this.revision(input.projectId, input.revisionId);
      const projectId = randomUUID();
      const revisionId = randomUUID();
      const createdAt = new Date().toISOString();
      const revision: ProjectRevision = {
        ...selected,
        id: revisionId,
        projectId,
        ordinal: 0,
        createdAt,
        operation: "create",
        document: structuredClone(selected.document),
        ...(selected.speakerCorrections === undefined
          ? {}
          : { speakerCorrections: structuredClone(selected.speakerCorrections) }),
      };
      const project: Project = {
        id: projectId,
        title: input.title ?? `${source.title} copy`,
        createdAt,
        currentRevisionId: revisionId,
      };
      const result = { project, revision };
      this.duplicateFault?.("project");
      this.store.catalog
        .prepare(
          `INSERT INTO projects(projectId,title,createdAt,currentRevisionId,createRequestId,createArguments,createResult) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          projectId,
          project.title,
          createdAt,
          revisionId,
          input.requestId,
          argumentsKey,
          JSON.stringify(result),
        );
      this.duplicateFault?.("references");
      this.insertRevision(revision);
      this.duplicateFault?.("result");
      return result;
    });
  }
  get(projectId: string): Project {
    const row = this.store.catalog
      .prepare(`SELECT ${projectColumns} FROM projects WHERE projectId=? AND deletedAt IS NULL`)
      .get(projectId);
    if (!row) throw new CatalogError("NOT_FOUND", "Project does not exist", { projectId });
    return row as Project;
  }
  /** A deleting project is never discoverable through library listings. */
  listable(projectId: string): boolean {
    return Boolean(
      this.store.catalog
        .prepare("SELECT 1 FROM projects WHERE projectId=? AND deletedAt IS NULL")
        .get(projectId),
    );
  }
  /** Pages are newest first; the opaque continuation anchors below the prior page's tail. */
  list(input: { cursor?: string; limit?: number } = {}) {
    const limit = input.limit ?? 100,
      position =
        input.cursor === undefined
          ? undefined
          : pageCursor.decode("project.list", input.cursor, {}),
      after = position === undefined ? undefined : (position as { sequence?: unknown }).sequence;
    pageLimit(limit);
    if (after !== undefined && (!Number.isSafeInteger(after) || (after as number) < 0))
      throw new CatalogError("INVALID_PARAMS", "Invalid project cursor");
    const where = "deletedAt IS NULL AND sequence<?";
    const rows = this.store.catalog
      .prepare(
        `SELECT sequence,${projectColumns} FROM projects WHERE ${where} ORDER BY sequence DESC LIMIT ?`,
      )
      .all(after === undefined ? Number.MAX_SAFE_INTEGER : (after as number), limit + 1);
    return {
      projects: rows.slice(0, limit).map((row) => omit(row, "sequence") as Project),
      nextCursor:
        rows.length > limit
          ? pageCursor.encode("project.list", { sequence: rows[limit - 1]!.sequence as number }, {})
          : null,
    };
  }
  /** The marker fences all readers and new work before asynchronous owners drain. */
  markDeleting(projectId: string): boolean {
    return this.store.transaction(() => {
      this.store.catalog
        .prepare("UPDATE projects SET deletedAt=COALESCE(deletedAt,?) WHERE projectId=?")
        .run(new Date().toISOString(), projectId);
      return Boolean(
        this.store.catalog
          .prepare("SELECT 1 FROM project_revisions WHERE projectId=? LIMIT 1")
          .get(projectId),
      );
    });
  }
  isDeleting(projectId: string): boolean {
    return Boolean(
      this.store.catalog
        .prepare("SELECT 1 FROM projects WHERE projectId=? AND deletedAt IS NOT NULL")
        .get(projectId),
    );
  }
  deletionsPage(afterId = "") {
    const rows = this.store.catalog
      .prepare(`SELECT projectId FROM projects WHERE deletedAt IS NOT NULL AND projectId>?
      AND EXISTS(SELECT 1 FROM project_revisions WHERE project_revisions.projectId=projects.projectId)
      ORDER BY projectId LIMIT 256`)
      .all(afterId);
    const projectIds = rows.map((row) => row.projectId as string);
    return { projectIds, nextAfterId: rows.length === 256 ? projectIds.at(-1)! : null };
  }
  /** Only the deletion coordinator calls this, after every asynchronous owner has drained. */
  finishDeletionPage(projectId: string): boolean {
    return this.store.transaction(() => {
      if (!this.isDeleting(projectId))
        throw new CatalogError("INVALID_STATE", "Project deletion has not been requested");
      // Keep revisions as the recovery marker until undo retirement has also finished.
      this.store.catalog
        .prepare(`DELETE FROM project_undo WHERE rowid IN
        (SELECT rowid FROM project_undo WHERE projectId=? LIMIT 256)`)
        .run(projectId);
      if (
        this.store.catalog
          .prepare("SELECT 1 FROM project_undo WHERE projectId=? LIMIT 1")
          .get(projectId)
      )
        return false;
      const rows = this.store.catalog
        .prepare("SELECT id FROM project_revisions WHERE projectId=? LIMIT 256")
        .all(projectId);
      for (const row of rows) {
        // Retire every dependency kind before deleting the immutable revision marker.
        if (this.references.releaseOwnerPage({ kind: "revision", id: row.id as string }) === 256)
          return false;
        this.store.catalog.prepare("DELETE FROM project_revisions WHERE id=?").run(row.id!);
      }
      const complete = !this.store.catalog
        .prepare("SELECT 1 FROM project_revisions WHERE projectId=? LIMIT 1")
        .get(projectId);
      return complete;
    });
  }
  /** Exact pinned revision availability, without hydrating its document. */
  hasRevision(projectId: string, revisionId: string): boolean {
    return Boolean(
      this.store.catalog
        .prepare(
          "SELECT 1 FROM project_revisions AS r JOIN projects AS p ON p.projectId=r.projectId WHERE r.projectId=? AND r.id=? AND p.deletedAt IS NULL",
        )
        .get(projectId, revisionId),
    );
  }
  /** Require a live project and its pinned revision without hydrating the document. */
  requireRevision(projectId: string, revisionId: string): void {
    this.get(projectId);
    if (!this.hasRevision(projectId, revisionId))
      throw new CatalogError("NOT_FOUND", "Revision does not exist in project", {
        projectId,
        revisionId,
      });
  }
  revision(projectId: string, revisionId?: string): ProjectRevision {
    const project = this.get(projectId);
    const row = this.store.catalog
      .prepare("SELECT content FROM project_revisions WHERE projectId=? AND id=?")
      .get(projectId, revisionId ?? project.currentRevisionId);
    if (!row)
      throw new CatalogError("NOT_FOUND", "Revision does not exist in project", {
        projectId,
        revisionId,
      });
    return JSON.parse(row.content as string);
  }
  apply(
    projectId: string,
    request: { requestId: string; expectedRevisionId: string; operations: unknown },
  ): ProjectEditResult {
    const operations = parsed(z.array(editOperationSchema).max(1000), request.operations);
    const args = { operation: "apply", expectedRevisionId: request.expectedRevisionId, operations };
    return this.mutate(
      projectId,
      request.requestId,
      args,
      () =>
        this.applyOperations(
          this.current(projectId, request.expectedRevisionId),
          request.requestId,
          operations,
        ),
      (result) =>
        editResult(
          result as ProjectEditResult & { edit: { document?: EditBatchResult["document"] } },
        ),
    ) as ProjectEditResult;
  }
  correctSpeakers(
    projectId: string,
    request: {
      requestId: string;
      expectedRevisionId: string;
      corrections: readonly SpeakerCorrection[];
    },
  ): ProjectRevision {
    return this.mutate(
      projectId,
      request.requestId,
      {
        operation: "speaker.correct",
        expectedRevisionId: request.expectedRevisionId,
        corrections: request.corrections,
      },
      () => {
        const current = this.current(projectId, request.expectedRevisionId);
        const revision: ProjectRevision = {
          ...current,
          id: randomUUID(),
          ordinal: current.ordinal + 1,
          createdAt: new Date().toISOString(),
          operation: "apply",
          speakerCorrections: [...(current.speakerCorrections ?? []), ...request.corrections],
        };
        this.pushUndo(projectId, current.id);
        this.insertRevision(revision);
        this.publishHead(revision);
        return revision;
      },
    );
  }
  seedText(
    projectId: string,
    request: { requestId: string; expectedRevisionId: string; cues: unknown },
  ): ProjectEditResult {
    const cues = parsed(textSeedCuesSchema, request.cues);
    return editResult(
      this.mutate(
        projectId,
        request.requestId,
        { operation: "text.seed", expectedRevisionId: request.expectedRevisionId, cues },
        () => {
          const current = this.current(projectId, request.expectedRevisionId);
          const model = validateComposition(
            current.document,
            documentAssetIds(current.document).map((id) => compositionAsset(this.assets.get(id))),
            this.contexts(current.document),
          );
          const operations = parsed(
            z.array(editOperationSchema).max(1000),
            seedTextOperations(model, cues, this.transcripts),
          );
          return this.applyOperations(current, request.requestId, operations);
        },
      ),
    );
  }
  private applyOperations(
    current: ProjectRevision,
    requestId: string,
    operations: z.infer<typeof editOperationSchema>[],
  ): ProjectEditResult {
    const projectId = current.projectId;
    const assetIds = new Set(documentAssetIds(current.document));
    const contextIds = new Set(documentAcquisitionIds(current.document));
    for (const operation of operations) {
      if (operation.operation === "processing.set")
        for (const { processor } of operation.steps)
          if (processor.type === "lut") assetIds.add(processor.assetId);
      if (operation.operation === "place")
        clipAssetIds(operation.clip).forEach((id) => assetIds.add(id));
      if (operation.operation === "text.set")
        clipAssetIds({ source: operation.source }).forEach((id) => assetIds.add(id));
      if (operation.operation === "replace") {
        clipAssetIds(operation.media).forEach((id) => assetIds.add(id));
        if (operation.media.acquisitionId) contextIds.add(operation.media.acquisitionId);
      }
      if (operation.operation === "place" && "assetId" in operation.clip) {
        if (operation.clip.acquisitionId) contextIds.add(operation.clip.acquisitionId);
      }
    }
    const metadata = [...assetIds].map((id) => compositionAsset(this.assets.get(id)));
    const namespace = createHash("sha256")
      .update(canonical([projectId, requestId]))
      .digest("hex");
    const edit = applyBatch(current.document, operations, {
      assets: metadata,
      namespace,
      acquisitions: [...contextIds].map((id) => this.acquisitions.context(id)),
    });
    if (!edit.changed) return editResult({ revision: current, edit });
    this.pushUndo(projectId, current.id);
    const revision: ProjectRevision = {
      id: randomUUID(),
      projectId,
      ordinal: current.ordinal + 1,
      createdAt: new Date().toISOString(),
      operation: "apply",
      document: edit.document,
      ...(current.speakerCorrections === undefined
        ? {}
        : { speakerCorrections: current.speakerCorrections }),
    };
    this.insertRevision(revision, {
      origins: current.document.clips,
      inherited: textSeeds(current.document),
    });
    this.publishHead(revision);
    return editResult({ revision, edit });
  }

  undo(
    projectId: string,
    request: { requestId: string; expectedRevisionId: string },
  ): ProjectRevision {
    return this.restoreRevision(projectId, request, "undo");
  }
  restore(
    projectId: string,
    request: { requestId: string; expectedRevisionId: string; targetRevisionId: string },
  ): ProjectRevision {
    return this.restoreRevision(projectId, request, "restore", request.targetRevisionId);
  }
  processing(projectId: string, revisionId: string, target: unknown) {
    const revision = this.revision(projectId, revisionId);
    const ids = documentAssetIds(revision.document);
    const model = validateComposition(
      revision.document,
      ids.map((id) => compositionAsset(this.assets.get(id))),
      this.contexts(revision.document),
    );
    return {
      projectId,
      revisionId: revision.id,
      target,
      steps: getProcessing(model, target),
    };
  }
  history(projectId: string, cursor: ProjectHistoryCursor | null = null, limit = 100) {
    this.get(projectId);
    pageLimit(limit);
    const position =
      cursor === null ? undefined : pageCursor.decode("revision.history", cursor, { projectId });
    const decoded = position as { afterOrdinal?: unknown; throughOrdinal?: unknown } | undefined;
    const afterOrdinal = (decoded?.afterOrdinal ?? -1) as number;
    const throughOrdinal =
      (decoded?.throughOrdinal as number | undefined) ??
      (this.store.catalog
        .prepare("SELECT MAX(ordinal) AS ordinal FROM project_revisions WHERE projectId=?")
        .get(projectId)!.ordinal as number);
    if (decoded) {
      const currentThrough = this.store.catalog
        .prepare("SELECT MAX(ordinal) AS ordinal FROM project_revisions WHERE projectId=?")
        .get(projectId)!.ordinal as number;
      if (throughOrdinal > currentThrough)
        throw new CatalogError("ARTIFACT_CHANGED", "Project history pin is stale");
    }
    if (
      !Number.isSafeInteger(afterOrdinal) ||
      afterOrdinal < -1 ||
      !Number.isSafeInteger(throughOrdinal) ||
      throughOrdinal < afterOrdinal
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid history cursor");
    const rows = this.store.catalog
      .prepare(
        "SELECT content FROM project_revisions WHERE projectId=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?",
      )
      .all(projectId, afterOrdinal, throughOrdinal, limit + 1);
    const revisions = rows
      .slice(0, limit)
      .map((row) => JSON.parse(row.content as string) as ProjectRevision);
    return {
      revisions,
      nextCursor:
        rows.length > limit
          ? pageCursor.encode(
              "revision.history",
              { afterOrdinal: revisions.at(-1)!.ordinal, throughOrdinal },
              { projectId },
            )
          : null,
    };
  }
  snapshot(projectId: string, revisionId?: string): ProjectSnapshot {
    const project = this.get(projectId);
    const selected = this.revision(projectId, revisionId);
    const usage = this.store.catalog
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM project_revisions WHERE projectId=? AND ordinal<=?",
      )
      .get(projectId, selected.ordinal) as { count: number; bytes: number };
    if (usage.count > archiveLimits.history)
      throw new CatalogError(
        "LIMIT_EXCEEDED",
        "Project history exceeds the portable snapshot budget",
      );
    checkProjectJsonBytes(usage.bytes);
    const history = this.history(
      projectId,
      pageCursor.encode(
        "revision.history",
        { afterOrdinal: -1, throughOrdinal: selected.ordinal },
        { projectId },
      ),
      archiveLimits.history,
    );
    if (history.nextCursor)
      throw new CatalogError(
        "LIMIT_EXCEEDED",
        "Project history exceeds the portable snapshot limit",
      );
    const undo: string[] =
      selected.id === project.currentRevisionId
        ? this.store.catalog
            .prepare(
              "SELECT targetId FROM project_undo WHERE projectId=? ORDER BY position LIMIT 1001",
            )
            .all(projectId)
            .map((row) => row.targetId as string)
        : [];
    if (selected.id !== project.currentRevisionId)
      for (let index = 1; index < history.revisions.length; index++) {
        const revision = history.revisions[index]!;
        if (revision.operation === "undo") undo.pop();
        else undo.push(history.revisions[index - 1]!.id);
      }
    if (undo.length > archiveLimits.history)
      throw new CatalogError("LIMIT_EXCEEDED", "Project undo exceeds the portable snapshot limit");
    let edges = 0;
    const references = history.revisions.map((revision) => {
      const resources = this.references.dependencies({ kind: "revision", id: revision.id });
      edges += resources.length;
      if (edges > 25000)
        throw new CatalogError(
          "LIMIT_EXCEEDED",
          "Project revision dependencies exceed package budget",
        );
      return { revisionId: revision.id, resources };
    });
    return {
      project: { ...project, currentRevisionId: selected.id },
      revisions: history.revisions,
      undo,
      references,
    };
  }
  /** Identity preparation is transient; publication rechecks replay before exposing any dependencies. */
  prepareAdoption(input: { requestId: string; packageIdentity: string; snapshot: unknown }) {
    const snapshot = validateProjectSnapshot(input.snapshot);
    const key = canonical({ packageIdentity: input.packageIdentity, snapshot });
    const replay = () => {
      const prior = this.store.catalog
        .prepare("SELECT createArguments,createResult FROM projects WHERE createRequestId=?")
        .get(input.requestId);
      if (!prior) return null;
      if (prior.createArguments !== key)
        throw new CatalogError(
          "REQUEST_CONFLICT",
          "Adoption request ID already names another package",
        );
      return JSON.parse(prior.createResult as string) as {
        project: Project;
        revision: ProjectRevision;
        revisionIds: Record<string, string>;
      };
    };
    const prior = replay();
    const projectId = prior?.project.id ?? randomUUID();
    const revisionIds =
      prior?.revisionIds ??
      Object.fromEntries(snapshot.revisions.map((revision) => [revision.id, randomUUID()]));
    const revisions = snapshot.revisions.map((revision) => ({
      ...revision,
      id: revisionIds[revision.id]!,
      projectId,
    }));
    const project = {
      ...snapshot.project,
      id: projectId,
      currentRevisionId: revisionIds[snapshot.project.currentRevisionId]!,
    };
    const result = { project, revision: revisions.at(-1)!, revisionIds };
    return {
      ...structuredClone(result),
      revisions: structuredClone(revisions),
      publish: (
        publishDependencies: () => void,
        evidence?: { publish(): void; reference(resource: ResourceReference): ResourceReference },
      ) =>
        this.store.transaction(() => {
          const existing = replay();
          if (existing) return existing;
          publishDependencies();
          for (const revision of revisions) {
            const ids = documentAssetIds(revision.document);
            validateComposition(
              revision.document,
              ids.map((id) => compositionAsset(this.assets.get(id))),
              this.contexts(revision.document),
            );
          }
          this.store.catalog
            .prepare(
              "INSERT INTO projects(projectId,title,createdAt,currentRevisionId,createRequestId,createArguments,createResult) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              projectId,
              project.title,
              project.createdAt,
              project.currentRevisionId,
              input.requestId,
              key,
              JSON.stringify(result),
            );
          const origins: ProjectRevision["document"]["clips"][number][] = [];
          const inherited: ReturnType<typeof textSeeds> = [];
          for (const revision of revisions) {
            this.insertRevision(revision, { origins, inherited, adopted: true });
            origins.push(...revision.document.clips);
            inherited.push(...textSeeds(revision.document));
          }
          for (const dependency of snapshot.references)
            for (const resource of dependency.resources) {
              const retained = evidence?.reference(resource) ?? resource;
              this.references.retain(
                retained.kind,
                { kind: "revision", id: revisionIds[dependency.revisionId]! },
                [retained.id],
              );
            }
          for (const id of snapshot.undo) this.pushUndo(projectId, revisionIds[id]!);
          evidence?.publish();
          return result;
        }),
    };
  }
  private mutate<T>(
    projectId: string,
    requestId: string,
    args: unknown,
    run: () => T,
    retain: (result: T) => T = (result) => result,
  ): T {
    const key = canonical(args);
    return this.store.transaction(() => {
      this.get(projectId);
      const replay = this.store.catalog
        .prepare("SELECT arguments,result FROM project_requests WHERE projectId=? AND requestId=?")
        .get(projectId, requestId);
      if (replay) {
        if (replay.arguments !== key)
          throw new CatalogError(
            "REQUEST_CONFLICT",
            "Request ID was already used with different arguments",
          );
        return JSON.parse(replay.result as string) as T;
      }
      const result = run();
      const retained = retain(result);
      this.store.catalog
        .prepare("INSERT INTO project_requests VALUES(?,?,?,?)")
        .run(projectId, requestId, key, JSON.stringify(retained));
      return retained;
    });
  }
  private current(projectId: string, expected: string) {
    const current = this.revision(projectId);
    if (current.id !== expected)
      throw new CatalogError("STALE_REVISION", "Current revision has changed", {
        currentRevisionId: current.id,
      });
    return current;
  }
  private pushUndo(projectId: string, targetId: string) {
    this.store.catalog
      .prepare(
        "INSERT INTO project_undo SELECT ?,COALESCE(MAX(position),0)+1,? FROM project_undo WHERE projectId=?",
      )
      .run(projectId, targetId, projectId);
  }
  private restoreRevision(
    projectId: string,
    request: { requestId: string; expectedRevisionId: string },
    operation: "undo" | "restore",
    targetRevisionId?: string,
  ): ProjectRevision {
    return this.mutate(
      projectId,
      request.requestId,
      {
        operation,
        expectedRevisionId: request.expectedRevisionId,
        ...(targetRevisionId ? { targetRevisionId } : {}),
      },
      () => {
        const current = this.current(projectId, request.expectedRevisionId);
        let targetId = targetRevisionId;
        if (operation === "undo") {
          const entry = this.store.catalog
            .prepare(
              "SELECT position,targetId FROM project_undo WHERE projectId=? ORDER BY position DESC LIMIT 1",
            )
            .get(projectId);
          if (!entry) throw new CatalogError("NOTHING_TO_UNDO", "No active edit remains to undo");
          targetId = entry.targetId as string;
          this.store.catalog
            .prepare("DELETE FROM project_undo WHERE projectId=? AND position=?")
            .run(projectId, entry.position!);
        } else this.pushUndo(projectId, current.id);
        const target = this.revision(projectId, targetId);
        const revision: ProjectRevision = {
          ...target,
          id: randomUUID(),
          ordinal: current.ordinal + 1,
          createdAt: new Date().toISOString(),
          operation,
        };
        this.insertRevision(revision);
        this.publishHead(revision);
        const prepared = this.references
          .dependencies({ kind: "revision", id: target.id })
          .filter((reference) => reference.kind === "prepared-audio")
          .map((reference) => reference.id);
        this.references.retain("prepared-audio", { kind: "revision", id: revision.id }, prepared);
        return revision;
      },
    );
  }
  contexts(document: ProjectRevision["document"]) {
    return documentAcquisitionIds(document).map((id) => this.acquisitions.context(id));
  }
  revisionDependencies(projectId: string, revisionId: string) {
    this.requireRevision(projectId, revisionId);
    return this.references.dependencies({ kind: "revision", id: revisionId });
  }
  private insertRevision(
    revision: ProjectRevision,
    seedOrigins?: Parameters<typeof validateTextSeeds>[2],
  ) {
    const resources = validateTextSeeds(revision.document, this.transcripts, seedOrigins);
    for (const resource of resources)
      this.references.retain(resource.kind, { kind: "revision", id: revision.id }, [resource.id]);
    const ids = documentAssetIds(revision.document);
    this.assets.retain({ kind: "revision", id: revision.id }, ids);
    this.acquisitions.retain(
      { kind: "revision", id: revision.id },
      documentAcquisitionIds(revision.document),
    );
    this.duplicateFault?.("revision");
    this.store.catalog
      .prepare("INSERT INTO project_revisions VALUES(?,?,?,?)")
      .run(revision.id, revision.projectId, revision.ordinal, JSON.stringify(revision));
  }
  private publishHead(revision: ProjectRevision) {
    this.store.catalog
      .prepare("UPDATE projects SET currentRevisionId=? WHERE projectId=?")
      .run(revision.id, revision.projectId);
  }
}
