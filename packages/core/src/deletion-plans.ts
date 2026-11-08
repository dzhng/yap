import type { Catalog } from "./catalog.js";

export type DeletionPhase = "planned" | "tombstoned" | "drained" | "files" | "rows";
export type DeletionPlanMember = {
  subjectKind: string;
  subjectId: string;
  memberKind: string;
  memberId: string;
};
export type DeletionPlan = {
  subjectKind: string;
  subjectId: string;
  cascade: boolean;
  phase: DeletionPhase;
  createdAt: string;
};

export type DeletionRequest = {
  requestId: string;
  subjectKind: string;
  subjectId: string;
  cascade: boolean;
  freedBytes: number;
  result: Record<string, unknown> | null;
};

/** Durable deletion intent shared by every library subject. */
export class DeletionPlans {
  constructor(private readonly store: Catalog) {
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS deletion_plans (
        subjectKind TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        cascade INTEGER NOT NULL CHECK(cascade IN (0,1)),
        phase TEXT NOT NULL CHECK(phase IN ('planned','tombstoned','drained','files','rows')),
        createdAt TEXT NOT NULL,
        PRIMARY KEY(subjectKind, subjectId)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deletion_plan_members (
        subjectKind TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        memberKind TEXT NOT NULL,
        memberId TEXT NOT NULL,
        PRIMARY KEY(subjectKind, subjectId, memberKind, memberId)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deletion_plan_members_subject
        ON deletion_plan_members(subjectKind, subjectId);
      CREATE TABLE IF NOT EXISTS deletion_requests (
        requestId TEXT PRIMARY KEY,
        subjectKind TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        cascade INTEGER NOT NULL CHECK(cascade IN (0,1)),
        freedBytes INTEGER NOT NULL,
        result TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deletion_requests_subject
        ON deletion_requests(subjectKind, subjectId);
    `);
  }

  request(requestId: string): DeletionRequest | null {
    const row = this.store.catalog
      .prepare(
        "SELECT requestId,subjectKind,subjectId,cascade,freedBytes,result FROM deletion_requests WHERE requestId=?",
      )
      .get(requestId) as
      | {
          requestId: string;
          subjectKind: string;
          subjectId: string;
          cascade: number;
          freedBytes: number;
          result: string | null;
        }
      | undefined;
    return row
      ? {
          requestId: row.requestId,
          subjectKind: row.subjectKind,
          subjectId: row.subjectId,
          cascade: row.cascade === 1,
          freedBytes: row.freedBytes,
          result: row.result === null ? null : (JSON.parse(row.result) as Record<string, unknown>),
        }
      : null;
  }

  requestsForSubject(subjectKind: string, subjectId: string): DeletionRequest[] {
    const rows = this.store.catalog
      .prepare(
        "SELECT requestId,subjectKind,subjectId,cascade,freedBytes,result FROM deletion_requests WHERE subjectKind=? AND subjectId=? ORDER BY requestId",
      )
      .all(subjectKind, subjectId) as Array<{
      requestId: string;
      subjectKind: string;
      subjectId: string;
      cascade: number;
      freedBytes: number;
      result: string | null;
    }>;
    return rows.map((row) => ({
      requestId: row.requestId,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      cascade: row.cascade === 1,
      freedBytes: row.freedBytes,
      result: row.result === null ? null : (JSON.parse(row.result) as Record<string, unknown>),
    }));
  }

  recordRequest(
    requestId: string,
    subjectKind: string,
    subjectId: string,
    cascade: boolean,
    freedBytes: number,
  ): void {
    this.store.catalog
      .prepare(
        "INSERT OR IGNORE INTO deletion_requests(requestId,subjectKind,subjectId,cascade,freedBytes,result) VALUES(?,?,?,?,?,NULL)",
      )
      .run(requestId, subjectKind, subjectId, cascade ? 1 : 0, freedBytes);
  }

  saveSubjectRequestResults(
    subjectKind: string,
    subjectId: string,
    result: Record<string, unknown>,
  ): void {
    this.store.catalog
      .prepare(
        "UPDATE deletion_requests SET result=? WHERE subjectKind=? AND subjectId=? AND result IS NULL",
      )
      .run(JSON.stringify(result), subjectKind, subjectId);
  }

  get(subjectKind: string, subjectId: string): DeletionPlan | null {
    const row = this.store.catalog
      .prepare(
        "SELECT subjectKind,subjectId,cascade,phase,createdAt FROM deletion_plans WHERE subjectKind=? AND subjectId=?",
      )
      .get(subjectKind, subjectId) as
      | {
          subjectKind: string;
          subjectId: string;
          cascade: number;
          phase: DeletionPhase;
          createdAt: string;
        }
      | undefined;
    return row ? { ...row, cascade: row.cascade === 1 } : null;
  }

  /** Whether deletion has reached its durable tombstone phase for this subject. */
  isTombstoned(subjectKind: string, subjectId: string): boolean {
    return Boolean(
      this.store.catalog
        .prepare(
          "SELECT 1 FROM deletion_plans WHERE subjectKind=? AND subjectId=? AND phase <> 'planned' LIMIT 1",
        )
        .get(subjectKind, subjectId),
    );
  }

  list(subjectKind?: string): DeletionPlan[] {
    const rows =
      subjectKind === undefined
        ? this.store.catalog
            .prepare(
              "SELECT subjectKind,subjectId,cascade,phase,createdAt FROM deletion_plans ORDER BY subjectKind,subjectId",
            )
            .all()
        : this.store.catalog
            .prepare(
              "SELECT subjectKind,subjectId,cascade,phase,createdAt FROM deletion_plans WHERE subjectKind=? ORDER BY subjectId",
            )
            .all(subjectKind);
    return (
      rows as Array<{
        subjectKind: string;
        subjectId: string;
        cascade: number;
        phase: DeletionPhase;
        createdAt: string;
      }>
    ).map((row) => ({ ...row, cascade: row.cascade === 1 }));
  }

  members(subjectKind: string, subjectId: string): DeletionPlanMember[] {
    return this.store.catalog
      .prepare(
        "SELECT subjectKind,subjectId,memberKind,memberId FROM deletion_plan_members WHERE subjectKind=? AND subjectId=? ORDER BY memberKind,memberId",
      )
      .all(subjectKind, subjectId) as DeletionPlanMember[];
  }

  /**
   * Insert a plan, its exact members and the request that asked for it atomically, so a crash
   * cannot leave a plan whose request would run again instead of replaying. Existing plans are
   * immutable.
   */
  create(
    subjectKind: string,
    subjectId: string,
    cascade: boolean,
    members: readonly Omit<DeletionPlanMember, "subjectKind" | "subjectId">[] = [],
    request?: { requestId: string; freedBytes: number },
    createdAt = new Date().toISOString(),
  ): DeletionPlan {
    return this.store.transaction(() => {
      if (request)
        this.recordRequest(request.requestId, subjectKind, subjectId, cascade, request.freedBytes);
      const existing = this.get(subjectKind, subjectId);
      if (existing) return existing;
      this.store.catalog
        .prepare(
          "INSERT INTO deletion_plans(subjectKind,subjectId,cascade,phase,createdAt) VALUES (?,?,?,?,?)",
        )
        .run(subjectKind, subjectId, cascade ? 1 : 0, "planned", createdAt);
      const insert = this.store.catalog.prepare(
        "INSERT INTO deletion_plan_members(subjectKind,subjectId,memberKind,memberId) VALUES (?,?,?,?)",
      );
      for (const member of members)
        insert.run(subjectKind, subjectId, member.memberKind, member.memberId);
      return { subjectKind, subjectId, cascade, phase: "planned", createdAt };
    });
  }

  /** A tombstone that has no plan, such as one an earlier release wrote, resumes through the coordinator. */
  adopt(
    subjectKind: string,
    subjectId: string,
    createdAt = new Date().toISOString(),
  ): DeletionPlan {
    return this.store.transaction(() => {
      const existing = this.get(subjectKind, subjectId);
      if (existing) return existing;
      this.store.catalog
        .prepare(
          "INSERT INTO deletion_plans(subjectKind,subjectId,cascade,phase,createdAt) VALUES (?,?,?,?,?)",
        )
        .run(subjectKind, subjectId, 0, "tombstoned", createdAt);
      return { subjectKind, subjectId, cascade: false, phase: "tombstoned", createdAt };
    });
  }

  setPhase(subjectKind: string, subjectId: string, phase: DeletionPhase): void {
    this.store.transaction(() => {
      this.store.catalog
        .prepare("UPDATE deletion_plans SET phase=? WHERE subjectKind=? AND subjectId=?")
        .run(phase, subjectKind, subjectId);
    });
  }

  clear(subjectKind: string, subjectId: string): void {
    this.store.transaction(() => {
      this.store.catalog
        .prepare("DELETE FROM deletion_plan_members WHERE subjectKind=? AND subjectId=?")
        .run(subjectKind, subjectId);
      this.store.catalog
        .prepare("DELETE FROM deletion_plans WHERE subjectKind=? AND subjectId=?")
        .run(subjectKind, subjectId);
    });
  }
}
