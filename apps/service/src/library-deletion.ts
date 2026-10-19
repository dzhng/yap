import { setImmediate } from "node:timers/promises";
import { CatalogError } from "@yap/core/catalog";
import type { DeletionPlan, DeletionPlans } from "@yap/core/deletion-plans";

export type LibrarySubject = { kind: string; id: string };
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
  cascadeMembers?: (
    subject: LibrarySubject,
    members: readonly { memberKind: string; memberId: string }[],
    signal: AbortSignal,
    deleteMember: (
      subject: LibrarySubject,
      options?: { cascade?: boolean },
    ) => Promise<Record<string, unknown>>,
  ) => void | Promise<void>;
  /** Some subjects own members even when the public request is not a cascade. */
  cascadeMembersWithoutCascade?: boolean;
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
  freedBytes: (subject: LibrarySubject, cascade: boolean) => number;
};

/** One crash-resumable ordering for every library subject kind. */
export class LibraryDeletion {
  onUpdateProgress: (() => void) | undefined;
  private readonly active = new Map<string, Promise<Record<string, unknown>>>();
  private readonly activeCascade = new Map<string, boolean>();
  private readonly requests = new Map<
    string,
    { kind: string; id: string; cascade: boolean; result: Promise<Record<string, unknown>> }
  >();
  private readonly lifetime = new AbortController();
  private readonly registrations = new Map<string, DeletionRegistration>();

  constructor(private readonly plans: DeletionPlans) {}

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
    const storedPlan = this.plans.get(subject.kind, subject.id);
    if (storedPlan && storedPlan.cascade !== cascade)
      throw new CatalogError(
        "REQUEST_CONFLICT",
        "Deletion is already planned with another cascade mode",
        {
          [subject.kind + "Id"]: subject.id,
        },
      );
    const pendingRequest = this.pendingRequest(subject);
    if (pendingRequest && pendingRequest.cascade !== cascade)
      throw new CatalogError(
        "REQUEST_CONFLICT",
        "Deletion is already planned with another cascade mode",
        {
          [subject.kind + "Id"]: subject.id,
        },
      );
    if (options.requestId) {
      const stored = this.plans.request(options.requestId);
      if (stored) {
        if (
          stored.subjectKind !== subject.kind ||
          stored.subjectId !== subject.id ||
          stored.cascade !== cascade
        )
          throw new CatalogError("REQUEST_CONFLICT", "Request identity names a different deletion");
        if (stored.result) return Promise.resolve(stored.result);
      }
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
      if (this.activeCascade.get(key) !== cascade)
        throw new CatalogError(
          "REQUEST_CONFLICT",
          "Deletion is already running with another cascade mode",
          {
            [subject.kind + "Id"]: subject.id,
          },
        );
      if (options.requestId) {
        if (!this.plans.request(options.requestId)) {
          const pending = this.pendingRequest(subject);
          this.plans.recordRequest(
            options.requestId,
            subject.kind,
            subject.id,
            cascade,
            pending?.freedBytes ?? registration.freedBytes(subject, cascade),
          );
        }
        this.requests.set(options.requestId, {
          kind: subject.kind,
          id: subject.id,
          cascade,
          result: existing,
        });
        this.forgetWhenSettled(options.requestId, existing);
      }
      return existing;
    }
    const result = this.remove(subject, registration, cascade, options.requestId).finally(() => {
      this.active.delete(key);
      this.activeCascade.delete(key);
      this.onUpdateProgress?.();
    });
    this.active.set(key, result);
    this.activeCascade.set(key, cascade);
    if (options.requestId)
      this.requests.set(options.requestId, { kind: subject.kind, id: subject.id, cascade, result });
    if (options.requestId) this.forgetWhenSettled(options.requestId, result);
    return result;
  }

  /** A settled request is answered from its durable row, so memory only joins one in flight. */
  private forgetWhenSettled(requestId: string, result: Promise<unknown>) {
    const forget = () => {
      if (this.requests.get(requestId)?.result === result) this.requests.delete(requestId);
    };
    void result.then(forget, forget);
  }

  /** Settled requests stay for replay; only an unsettled one belongs to the delete in flight. */
  private pendingRequest(subject: LibrarySubject) {
    return this.plans
      .requestsForSubject(subject.kind, subject.id)
      .find((request) => request.result === null);
  }

  private async remove(
    subject: LibrarySubject,
    registration: DeletionRegistration,
    cascade: boolean,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const storedRequest = requestId ? this.plans.request(requestId) : null;
      const pendingRequest = this.pendingRequest(subject);
      const freedBytes =
        storedRequest?.freedBytes ??
        pendingRequest?.freedBytes ??
        registration.freedBytes(subject, cascade);
      let plan = this.plans.get(subject.kind, subject.id);
      if (!plan) {
        const checked = registration.checkUsers?.(subject, cascade);
        const members =
          checked === undefined ? [] : checked instanceof Promise ? await checked : checked;
        plan = this.plans.create(subject.kind, subject.id, cascade, members);
        if (requestId && !storedRequest)
          this.plans.recordRequest(requestId, subject.kind, subject.id, cascade, freedBytes);
        const marked = registration.tombstone(subject);
        if (!(marked instanceof Promise ? await marked : marked)) {
          this.plans.clear(subject.kind, subject.id);
          const result = {
            ...(registration.result?.(subject) ?? {
              [subject.kind + "Id"]: subject.id,
              deleted: true,
            }),
            freedBytes,
          };
          this.plans.saveSubjectRequestResults(subject.kind, subject.id, result);
          return result;
        }
        this.plans.setPhase(subject.kind, subject.id, "tombstoned");
        plan = { ...plan, phase: "tombstoned" };
      }
      if (requestId && !storedRequest)
        this.plans.recordRequest(requestId, subject.kind, subject.id, cascade, freedBytes);
      await this.resumePlan(subject, registration, plan);
      const result = {
        ...(registration.result?.(subject) ?? { [subject.kind + "Id"]: subject.id, deleted: true }),
        freedBytes,
      };
      this.plans.saveSubjectRequestResults(subject.kind, subject.id, result);
      return result;
    } catch (error) {
      // An IN_USE refusal names its users, so it reaches the caller whatever the mode.
      if (
        error instanceof CatalogError &&
        (registration.errorMode !== "delete-failed" || error.code === "IN_USE")
      )
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
      this.plans.setPhase(subject.kind, subject.id, "tombstoned");
      plan = { ...plan, phase: "tombstoned" };
    }
    const run = async (lifetime: DeletionLifetime) => {
      if (plan.phase === "tombstoned") {
        await registration.drain(subject, this.lifetime.signal, lifetime);
        this.plans.setPhase(subject.kind, subject.id, "drained");
        plan = { ...plan, phase: "drained" };
      }
      if (plan.phase === "drained") {
        await registration.files(subject, this.lifetime.signal, lifetime);
        this.plans.setPhase(subject.kind, subject.id, "files");
        plan = { ...plan, phase: "files" };
      }
      if (plan.phase === "files") {
        for (;;) {
          this.lifetime.signal.throwIfAborted();
          if (await registration.rows(subject, this.lifetime.signal, lifetime)) break;
          await setImmediate();
        }
        this.plans.setPhase(subject.kind, subject.id, "rows");
        plan = { ...plan, phase: "rows" };
      }
      if (plan.phase === "rows") {
        if (
          registration.cascadeMembers &&
          (plan.cascade || registration.cascadeMembersWithoutCascade)
        )
          await registration.cascadeMembers(
            subject,
            this.plans.members(subject.kind, subject.id),
            this.lifetime.signal,
            (member, options) => this.delete(member, { cascade: options?.cascade ?? plan.cascade }),
          );
        await registration.clearTombstone?.(subject);
        this.plans.clear(subject.kind, subject.id);
      }
    };
    if (registration.scope) {
      if (plan.phase === "tombstoned")
        await registration.beforeScope?.(subject, this.lifetime.signal);
      await registration.scope(subject, this.lifetime.signal, run);
    } else await run(undefined);
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
