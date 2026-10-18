import { lstatSync, readdirSync } from "node:fs";
import type { Catalog } from "./catalog.js";
import { DeletionPlans } from "./deletion-plans.js";
import { ResourceReferences } from "./references.js";
import { join } from "node:path";

export type LibraryUserSubject = {
  kind: "asset" | "acquisition" | "recording" | "project";
  id: string;
};
export type LibraryUserProject = {
  kind: "project";
  projectId: string;
  title: string;
  revisions: number;
};
export type LibraryUserAcquisition = { kind: "acquisition"; acquisitionId: string };
export type LibraryUserDerivedAsset = { kind: "asset"; assetId: string };
export type LibraryUsersResult = {
  usedBy: LibraryUserProject[];
  acquisitions: LibraryUserAcquisition[];
  derivedAssets: LibraryUserDerivedAsset[];
  freesBytes: number;
  cascadeFreesBytes: number;
};
export type LibraryUsersFiles = {
  asset(id: string): readonly string[];
  acquisition(id: string): readonly string[];
  recording(id: string): readonly string[];
  project(id: string): readonly string[];
};

/** Read-only inventory of the owners and reclaimable files for a library subject. */
export class LibraryUsers {
  private readonly references: ResourceReferences;
  private readonly plans: DeletionPlans;
  private readonly files: LibraryUsersFiles;
  private readonly catalog: Catalog;

  constructor(catalog: Catalog, files: LibraryUsersFiles) {
    this.catalog = catalog;
    this.files = files;
    this.references = new ResourceReferences(catalog);
    this.plans = new DeletionPlans(catalog);
  }

  usersOf(subject: LibraryUserSubject): LibraryUsersResult {
    const assetIds = this.assetClosure(subject);
    const acquisitionIds = this.acquisitionClosure(subject, assetIds);
    const projectIds = new Set<string>();
    for (const assetId of assetIds) this.addProjectUsers("asset", assetId, projectIds);
    for (const acquisitionId of acquisitionIds)
      this.addProjectUsers("acquisition", acquisitionId, projectIds);
    const usedBy = [...projectIds]
      .map((projectId) => this.projectUser(projectId))
      .filter((project): project is LibraryUserProject => project !== null)
      .sort((a, b) => a.projectId.localeCompare(b.projectId));
    const acquisitions = [...acquisitionIds]
      .filter((id) => id !== subject.id || subject.kind !== "acquisition")
      .sort()
      .map((acquisitionId) => ({ kind: "acquisition" as const, acquisitionId }));
    const derivedAssets = [...assetIds]
      .filter((id) => id !== subject.id || subject.kind !== "asset")
      .sort()
      .map((assetId) => ({ kind: "asset" as const, assetId }));
    const ownPaths = this.subjectPaths(subject);
    const cascadePaths = new Set(ownPaths);
    for (const assetId of assetIds) this.addAssetPath(cascadePaths, assetId);
    for (const acquisitionId of acquisitionIds)
      this.addAcquisitionPath(cascadePaths, acquisitionId);
    for (const project of usedBy) this.addProjectPath(cascadePaths, project.projectId);
    const freePaths = new Set<string>();
    for (const path of ownPaths) freePaths.add(path);
    for (const assetId of assetIds) {
      if (assetId === subject.id && subject.kind === "asset") continue;
      if (this.assetHasLiveNonAssetOwner(assetId, assetIds)) continue;
      this.addAssetPath(freePaths, assetId);
    }
    for (const acquisitionId of acquisitionIds) {
      if (subject.kind === "acquisition" && acquisitionId === subject.id) continue;
      if (this.acquisitionHasLiveProjectOwner(acquisitionId)) continue;
      this.addAcquisitionPath(freePaths, acquisitionId);
    }
    return {
      usedBy,
      acquisitions,
      derivedAssets,
      freesBytes: this.bytes(freePaths),
      cascadeFreesBytes: this.bytes(cascadePaths),
    };
  }

  private assetClosure(subject: LibraryUserSubject): Set<string> {
    const result = new Set<string>();
    const queue: string[] = [];
    if (subject.kind === "asset") queue.push(subject.id);
    else {
      for (const acquisitionId of this.captureOrSubjectAcquisitions(subject))
        for (const resource of this.references.dependencies({
          kind: "acquisition",
          id: acquisitionId,
        }))
          if (resource.kind === "asset") queue.push(resource.id);
    }
    while (queue.length) {
      const id = queue.shift()!;
      if (result.has(id)) continue;
      result.add(id);
      for (const owner of this.references.owners("asset", id))
        if (owner.kind === "asset") queue.push(owner.id);
    }
    return result;
  }

  private acquisitionClosure(subject: LibraryUserSubject, assetIds: Set<string>): Set<string> {
    const result = new Set<string>();
    if (subject.kind === "acquisition") result.add(subject.id);
    if (subject.kind === "recording")
      for (const row of this.recordingAcquisitions(subject.id)) result.add(row);
    for (const assetId of assetIds)
      for (const owner of this.references.owners("asset", assetId))
        if (owner.kind === "acquisition") result.add(owner.id);
    return result;
  }

  private captureOrSubjectAcquisitions(subject: LibraryUserSubject): string[] {
    if (subject.kind === "acquisition") return [subject.id];
    if (subject.kind !== "recording") return [];
    return this.recordingAcquisitions(subject.id);
  }

  private recordingAcquisitions(recordingId: string): string[] {
    return (
      this.catalog.catalog
        .prepare(
          `SELECT id FROM acquisitions
           WHERE json_extract(admission,'$.kind')='capture'
             AND json_extract(admission,'$.recordingId')=? ORDER BY id`,
        )
        .all(recordingId) as { id: string }[]
    ).map((row) => row.id);
  }

  private addProjectUsers(
    resourceKind: "asset" | "acquisition",
    resourceId: string,
    out: Set<string>,
  ) {
    for (const owner of this.references.owners(resourceKind, resourceId)) {
      if (owner.kind !== "revision") continue;
      const row = this.catalog.catalog
        .prepare("SELECT projectId FROM project_revisions WHERE id=?")
        .get(owner.id) as { projectId: string } | undefined;
      if (row) out.add(row.projectId);
    }
  }

  private projectUser(projectId: string): LibraryUserProject | null {
    const row = this.catalog.catalog
      .prepare(
        `SELECT p.projectId,p.title,
          (SELECT COUNT(*) FROM project_revisions r WHERE r.projectId=p.projectId) revisions,
          p.deletedAt
         FROM projects p WHERE p.projectId=?`,
      )
      .get(projectId) as
      | { projectId: string; title: string; revisions: number; deletedAt: string | null }
      | undefined;
    if (!row || row.deletedAt !== null || this.plans.isTombstoned("project", projectId))
      return null;
    return {
      kind: "project",
      projectId: row.projectId,
      title: row.title,
      revisions: row.revisions,
    };
  }

  private assetHasLiveNonAssetOwner(assetId: string, closure: Set<string>): boolean {
    for (const owner of this.references.owners("asset", assetId)) {
      if (owner.kind === "asset" && closure.has(owner.id)) continue;
      if (owner.kind === "job" || owner.kind === "job-input") continue;
      if (owner.kind === "revision") {
        const project = this.projectUserForRevision(owner.id);
        if (project === null) continue;
      }
      return true;
    }
    return false;
  }

  private acquisitionHasLiveProjectOwner(acquisitionId: string): boolean {
    for (const owner of this.references.owners("acquisition", acquisitionId)) {
      if (owner.kind === "job" || owner.kind === "job-input") continue;
      if (owner.kind === "revision" && this.projectUserForRevision(owner.id) === null) continue;
      return true;
    }
    return false;
  }

  private projectUserForRevision(revisionId: string): string | null {
    const row = this.catalog.catalog
      .prepare("SELECT projectId FROM project_revisions WHERE id=?")
      .get(revisionId) as { projectId: string } | undefined;
    if (!row) return null;
    return this.projectUser(row.projectId)?.projectId ?? null;
  }

  private subjectPaths(subject: LibraryUserSubject) {
    const paths = new Set<string>();
    for (const path of this.subjectFiles(subject)) paths.add(path);
    return paths;
  }

  private subjectFiles(subject: LibraryUserSubject): readonly string[] {
    return this.files[subject.kind](subject.id);
  }

  private addAssetPath(paths: Set<string>, id: string): void {
    for (const path of this.files.asset(id)) paths.add(path);
  }

  private addAcquisitionPath(paths: Set<string>, id: string): void {
    for (const path of this.files.acquisition(id)) paths.add(path);
  }

  private addRecordingPath(paths: Set<string>, id: string): void {
    for (const path of this.files.recording(id)) paths.add(path);
  }

  private addProjectPath(paths: Set<string>, id: string): void {
    for (const path of this.files.project(id)) paths.add(path);
  }

  private bytes(paths: Set<string>): number {
    let total = 0;
    const seen = new Set<string>();
    for (const path of paths) {
      total += this.pathBytes(path, seen);
    }
    return total;
  }

  private pathBytes(path: string, seen: Set<string>): number {
    try {
      const info = lstatSync(path, { bigint: true });
      const identity = `${info.dev}:${info.ino}`;
      if (seen.has(identity)) return 0;
      seen.add(identity);
      if (info.isFile()) return Number(info.size);
      if (!info.isDirectory()) return 0;
      return readdirSync(path).reduce(
        (sum, name) => sum + this.pathBytes(join(path, name), seen),
        0,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return 0;
      throw error;
    }
  }
}
