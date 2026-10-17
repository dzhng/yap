import { CatalogError, type Catalog } from "./catalog.js";
import { DeletionPlans } from "./deletion-plans.js";

export const resourceKinds = [
  "asset",
  "acquisition",
  "scene-generation",
  "speaker-generation",
  "alignment-generation",
  "transcript-generation",
  "imported-transcript-generation",
  "prepared-audio",
  "index-generation",
] as const;
export type ResourceKind = (typeof resourceKinds)[number];
export type ResourceReference = { kind: ResourceKind; id: string };
export type ResourceOwner = {
  kind:
    | "asset"
    | "acquisition"
    | "project"
    | "revision"
    | "job"
    | "job-input"
    | "export"
    | "index-generation";
  id: string;
};

/** Domain owners validate existence; their publication transactions retain these dependencies. */
export class ResourceReferences {
  private readonly plans: DeletionPlans;
  constructor(private readonly store: Catalog) {
    this.plans = new DeletionPlans(store);
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS resource_references (
        resourceKind TEXT NOT NULL, resourceId TEXT NOT NULL,
        ownerKind TEXT NOT NULL, ownerId TEXT NOT NULL,
        PRIMARY KEY(resourceKind,resourceId,ownerKind,ownerId)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS resource_reference_owner
        ON resource_references(ownerKind,ownerId,resourceKind);
    `);
  }
  retain(kind: ResourceKind, owner: ResourceOwner, ids: readonly string[]): void {
    for (const id of ids)
      if (this.plans.isTombstoned(kind, id))
        throw new CatalogError("DELETE_IN_PROGRESS", `${kind} deletion is in progress`, {
          [`${kind}Id`]: id,
        });
    const insert = this.store.catalog.prepare(
      "INSERT OR IGNORE INTO resource_references VALUES(?,?,?,?)",
    );
    for (const id of ids) insert.run(kind, id, owner.kind, owner.id);
  }
  isTombstoned(kind: ResourceKind, id: string): boolean {
    return this.plans.isTombstoned(kind, id);
  }
  release(kind: ResourceKind, owner: ResourceOwner): void {
    this.store.catalog
      .prepare("DELETE FROM resource_references WHERE resourceKind=? AND ownerKind=? AND ownerId=?")
      .run(kind, owner.kind, owner.id);
  }
  /** Retirement walks the existing owner index in bounded pages. */
  releaseOwnerPage(owner: ResourceOwner): number {
    return Number(
      this.store.catalog
        .prepare(`DELETE FROM resource_references WHERE rowid IN
      (SELECT rowid FROM resource_references WHERE ownerKind=? AND ownerId=? LIMIT 256)`)
        .run(owner.kind, owner.id).changes,
    );
  }
  dependencies(owner: ResourceOwner, limit = 25_000): ResourceReference[] {
    const rows = this.store.catalog
      .prepare(
        `SELECT resourceKind AS kind,resourceId AS id FROM resource_references
       WHERE ownerKind=? AND ownerId=? ORDER BY resourceKind,resourceId LIMIT ?`,
      )
      .all(owner.kind, owner.id, limit + 1) as ResourceReference[];
    if (rows.length > limit)
      throw new RangeError("Resource dependency inventory exceeds its limit");
    return rows;
  }
  has(kind: ResourceKind, id: string): boolean {
    return Boolean(
      this.store.catalog
        .prepare("SELECT 1 FROM resource_references WHERE resourceKind=? AND resourceId=? LIMIT 1")
        .get(kind, id),
    );
  }
  owners(kind: ResourceKind, id: string): ResourceOwner[] {
    return this.store.catalog
      .prepare(`SELECT ownerKind AS kind,ownerId AS id FROM resource_references
        WHERE resourceKind=? AND resourceId=? ORDER BY ownerKind,ownerId`)
      .all(kind, id) as ResourceOwner[];
  }
}
