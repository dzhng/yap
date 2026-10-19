import type { Catalog } from "@yap/core/catalog";
import { DeletionPlans, type DeletionPhase } from "@yap/core/deletion-plans";
import type { LibrarySubject } from "./library-deletion.js";

/** Every durable write a delete makes, in order; a crash can land on either side of each. */
export type DeletionBoundary = "plan" | "tombstone" | "drain" | "files" | "rows" | "clear";
export type DeletionFault = (
  boundary: DeletionBoundary,
  subject: LibrarySubject,
  timing: "before" | "after",
) => void;

const boundaries: Record<Exclude<DeletionPhase, "planned">, DeletionBoundary> = {
  tombstoned: "tombstone",
  drained: "drain",
  files: "files",
  rows: "rows",
};

/** Deletion plans that call a test's fault around each durable write, so it can fail one. */
export class FaultingDeletionPlans extends DeletionPlans {
  constructor(
    store: Catalog,
    private readonly fault: DeletionFault,
  ) {
    super(store);
  }

  override create(...args: Parameters<DeletionPlans["create"]>) {
    return this.around("plan", { kind: args[0], id: args[1] }, () => super.create(...args));
  }

  override setPhase(subjectKind: string, subjectId: string, phase: DeletionPhase): void {
    const boundary = phase === "planned" ? "plan" : boundaries[phase];
    this.around(boundary, { kind: subjectKind, id: subjectId }, () =>
      super.setPhase(subjectKind, subjectId, phase),
    );
  }

  override clear(subjectKind: string, subjectId: string): void {
    this.around("clear", { kind: subjectKind, id: subjectId }, () =>
      super.clear(subjectKind, subjectId),
    );
  }

  private around<T>(boundary: DeletionBoundary, subject: LibrarySubject, write: () => T): T {
    this.fault(boundary, subject, "before");
    const result = write();
    this.fault(boundary, subject, "after");
    return result;
  }
}
