import { setImmediate } from "node:timers/promises";
import { CatalogError } from "@yap/core/catalog";
import type { DeletionPlan, DeletionPlans } from "@yap/core/deletion-plans";

export type LibrarySubject = { kind: string; id: string };
export type DeletionPhase = "check" | "plan" | "tombstone" | "drain" | "files" | "rows" | "clear";
export type DeletionBoundaryTiming = "before" | "after";
export type DeletionFault = (
  boundary: DeletionPhase,
  subject: LibrarySubject,
  timing: DeletionBoundaryTiming,
) => void | Promise<void>;
export type DeletionLifetime = { readonly fd: number } | undefined;

export type DeletionRegistration = {
  kind: string;
  errorMode?: "preserve-catalog" | "delete-failed";
  checkUsers?: (
    subject: LibrarySubject,
    cascade: boolean,
  ) =>
    | readonly { memberKind: string; memberId: string }[]
    | Promise<readonly { memberKind: string; memberId: string }[]>;
  tombstone: (subject: LibrarySubject) => boolean | Promise<boolean>;
  scope?: (
    subject: LibrarySubject,
    signal: AbortSignal,
    run: (lifetime: DeletionLifetime) => Promise<void>,
  ) => Promise<void>;
  beforeScope?: (subject: LibrarySubject, signal: AbortSignal) => void | Promise<void>;
  drain: (
    subject: LibrarySubject,
    signal: AbortSignal,
    lifetime?: DeletionLifetime,
  ) => void | Promise<void>;
  files: (
    subject: LibrarySubject,
    signal: AbortSignal,
    lifetime?: DeletionLifetime,
  ) => void | Promise<void>;
  rows: (
    subject: LibrarySubject,
    signal: AbortSignal,
    lifetime?: DeletionLifetime,
  ) => boolean | Promise<boolean>;
  clearTombstone?: (subject: LibrarySubject) => void | Promise<void>;
  markersPage?: (afterId?: string) => { subjects: LibrarySubject[]; nextAfterId: string | null };
  result?: (subject: LibrarySubject) => Record<string, unknown>;
  freedBytes?: (subject: LibrarySubject) => number;
};

/** One crash-resumable ordering for every library subject kind. */
export class LibraryDeletion {
  onUpdateProgress: (() => void) | undefined;
  private readonly active = new Map<string, Promise<Record<string, unknown>>>();
  private readonly requests = new Map<
    string,
    { kind: string; id: string; cascade: boolean; result: Promise<Record<string, unknown>> }
  >();
  private readonly lifetime = new AbortController();
  private readonly registrations = new Map<string, DeletionRegistration>();

  constructor(
    private readonly plans: DeletionPlans,
    private readonly options: { fault?: DeletionFault } = {},
  ) {}

  get updateBlocked(): boolean {
    return this.active.size > 0;
  }

  register(registration: DeletionRegistration): void {
    if (this.registrations.has(registration.kind))
      throw new Error(`Deletion subject kind already registered: ${registration.kind}`);
    this.registrations.set(registration.kind, registration);
  }

  delete(
    subject: LibrarySubject,
    options: { cascade?: boolean; requestId?: string } = {},
  ): Promise<Record<string, unknown>> {
    if (this.lifetime.signal.aborted)
      throw new CatalogError("SERVICE_STOPPED", "Library deletion is closed", {});
    const registration = this.requireRegistration(subject.kind);
    const cascade = options.cascade ?? false;
    if (options.requestId) {
      const prior = this.requests.get(options.requestId);
      if (prior) {
        if (prior.kind !== subject.kind || prior.id !== subject.id || prior.cascade !== cascade)
          throw new CatalogError("REQUEST_CONFLICT", "Request identity names a different deletion");
        return prior.result;
      }
    }
    const key = `${subject.kind}:${subject.id}`;
    const existing = this.active.get(key);
    if (existing) {
      if (options.requestId) {
        this.requests.set(options.requestId, {
          kind: subject.kind,
          id: subject.id,
          cascade,
          result: existing,
        });
        void existing.catch(() => {
          const prior = this.requests.get(options.requestId!);
          if (prior?.result === existing) this.requests.delete(options.requestId!);
        });
      }
      return existing;
    }
    const result = this.remove(subject, registration, cascade).finally(() => {
      this.active.delete(key);
      this.onUpdateProgress?.();
    });
    this.active.set(key, result);
    if (options.requestId)
      this.requests.set(options.requestId, { kind: subject.kind, id: subject.id, cascade, result });
    if (options.requestId)
      void result.catch(() => {
        const prior = this.requests.get(options.requestId!);
        if (prior?.result === result) this.requests.delete(options.requestId!);
      });
    return result;
  }

  private async remove(
    subject: LibrarySubject,
    registration: DeletionRegistration,
    cascade: boolean,
  ): Promise<Record<string, unknown>> {
    try {
      const freedBytes = registration.freedBytes?.(subject) ?? 0;
      let plan = this.plans.get(subject.kind, subject.id);
      if (!plan) {
        const checked = registration.checkUsers?.(subject, cascade);
        const members =
          checked === undefined ? [] : checked instanceof Promise ? await checked : checked;
        if (this.options.fault) await this.boundary("check", subject, "before");
        if (this.options.fault) await this.boundary("plan", subject, "before");
        plan = this.plans.create(subject.kind, subject.id, cascade, members);
        if (this.options.fault) await this.boundary("plan", subject, "after");
        const marked = registration.tombstone(subject);
        if (!(marked instanceof Promise ? await marked : marked)) {
          this.plans.clear(subject.kind, subject.id);
          return {
            ...(registration.result?.(subject) ?? {
              [subject.kind + "Id"]: subject.id,
              deleted: true,
            }),
            freedBytes,
          };
        }
        if (this.options.fault) await this.boundary("tombstone", subject, "before");
        this.plans.setPhase(subject.kind, subject.id, "tombstoned");
        if (this.options.fault) await this.boundary("tombstone", subject, "after");
        plan = { ...plan, phase: "tombstoned" };
      }
      await this.resumePlan(subject, registration, plan);
      return {
        ...(registration.result?.(subject) ?? { [subject.kind + "Id"]: subject.id, deleted: true }),
        freedBytes,
      };
    } catch (error) {
      if (registration.errorMode !== "delete-failed" && error instanceof CatalogError)
        throw new CatalogError(error.code, error.message, {
          ...error.details,
          [subject.kind + "Id"]: subject.id,
        });
      throw new CatalogError(
        "DELETE_FAILED",
        `${subject.kind} deletion could not finish: ${error instanceof Error ? error.message : String(error)}`,
        { [subject.kind + "Id"]: subject.id },
      );
    }
  }

  private async resumePlan(
    subject: LibrarySubject,
    registration: DeletionRegistration,
    initial: DeletionPlan,
  ): Promise<void> {
    let plan = initial;
    if (plan.phase === "planned") {
      const marked = registration.tombstone(subject);
      if (!(marked instanceof Promise ? await marked : marked)) {
        this.plans.clear(subject.kind, subject.id);
        return;
      }
      if (this.options.fault) await this.boundary("tombstone", subject, "before");
      this.plans.setPhase(subject.kind, subject.id, "tombstoned");
      if (this.options.fault) await this.boundary("tombstone", subject, "after");
      plan = { ...plan, phase: "tombstoned" };
    }
    const run = async (lifetime: DeletionLifetime) => {
      if (plan.phase === "tombstoned") {
        await registration.drain(subject, this.lifetime.signal, lifetime);
        if (this.options.fault) await this.boundary("drain", subject, "before");
        this.plans.setPhase(subject.kind, subject.id, "drained");
        if (this.options.fault) await this.boundary("drain", subject, "after");
        plan = { ...plan, phase: "drained" };
      }
      if (plan.phase === "drained") {
        await registration.files(subject, this.lifetime.signal, lifetime);
        if (this.options.fault) await this.boundary("files", subject, "before");
        this.plans.setPhase(subject.kind, subject.id, "files");
        if (this.options.fault) await this.boundary("files", subject, "after");
        plan = { ...plan, phase: "files" };
      }
      if (plan.phase === "files") {
        for (;;) {
          this.lifetime.signal.throwIfAborted();
          if (await registration.rows(subject, this.lifetime.signal, lifetime)) break;
          await setImmediate();
        }
        if (this.options.fault) await this.boundary("rows", subject, "before");
        this.plans.setPhase(subject.kind, subject.id, "rows");
        if (this.options.fault) await this.boundary("rows", subject, "after");
        plan = { ...plan, phase: "rows" };
      }
      if (plan.phase === "rows") {
        await registration.clearTombstone?.(subject);
        if (this.options.fault) await this.boundary("clear", subject, "before");
        if (this.options.fault) await this.boundary("clear", subject, "after");
        this.plans.clear(subject.kind, subject.id);
      }
    };
    if (registration.scope) {
      if (plan.phase === "tombstoned")
        await registration.beforeScope?.(subject, this.lifetime.signal);
      await registration.scope(subject, this.lifetime.signal, run);
    } else await run(undefined);
  }

  private async boundary(
    boundary: DeletionPhase,
    subject: LibrarySubject,
    timing: DeletionBoundaryTiming,
  ): Promise<void> {
    await this.options.fault?.(boundary, subject, timing);
  }

  private requireRegistration(kind: string): DeletionRegistration {
    const registration = this.registrations.get(kind);
    if (!registration)
      throw new CatalogError("INVALID_PARAMS", `Unknown deletion subject kind: ${kind}`);
    return registration;
  }

  async resume(reportFailure: (error: unknown) => void): Promise<void> {
    for (const plan of this.plans.list()) {
      if (this.lifetime.signal.aborted) return;
      const registration = this.registrations.get(plan.subjectKind);
      if (!registration) continue;
      try {
        await this.delete(
          { kind: plan.subjectKind, id: plan.subjectId },
          { cascade: plan.cascade },
        );
      } catch (error) {
        reportFailure(error);
      }
    }
    for (const registration of this.registrations.values()) {
      if (this.lifetime.signal.aborted) return;
      if (!registration.markersPage) continue;
      let afterId: string | undefined;
      for (;;) {
        const page = registration.markersPage(afterId);
        for (const subject of page.subjects) {
          if (this.lifetime.signal.aborted) return;
          if (this.plans.get(subject.kind, subject.id)) continue;
          try {
            this.plans.adopt(subject.kind, subject.id);
            await this.delete(subject);
          } catch (error) {
            reportFailure(error);
          }
        }
        if (page.nextAfterId === null) break;
        afterId = page.nextAfterId;
      }
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled(this.active.values());
  }
}
