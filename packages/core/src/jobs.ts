import { omit, type Issue } from "@yap/composition";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ResourceReferences, type ResourceKind } from "./references.js";
import { setImmediate } from "node:timers/promises";
import { CatalogError, type Catalog } from "./catalog.js";
import { createOutputIssues, outputIssues, writeOutputIssues } from "./issues.js";

/** What an attempt occupies while it runs. Frame work is small and parallel; heavy work is not. */
export type JobLane = "heavy" | "frame";
export type JobState =
  | "waiting"
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "unavailable"
  | "canceled";
/** The readiness vocabulary a caller sees for one pinned artifact. */
export type ArtifactState =
  | "not_requested"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "unavailable";

/** Contracts cap concurrent work at one heavy job and two frame jobs across library and package contexts. */
const laneLimits: Readonly<Record<JobLane, number>> = { heavy: 1, frame: 2 };
/**
 * Admission stops here. Waiting work is durable, so an unbounded queue would be an unbounded
 * catalog; a caller that hits this retries after the queue drains instead of being absorbed.
 */
const queuedLimit = 32;
const waitingLimit = 32;
export type JobAdmission = (
  job: Job,
) => { state: "ready" } | { state: "waiting"; dependency: string };

/** A preparation request exists before its result asset; revisions name immutable project/take inputs. */
export type JobOwner =
  | Readonly<{ kind: "import"; importId: string }>
  | Readonly<{ kind: "asset"; assetId: string }>
  | Readonly<{ kind: "acquisition"; acquisitionId: string }>
  | Readonly<{ kind: "project"; projectId: string }>
  | Readonly<{ kind: "recording"; recordingId: string }>;
/** Recording work selects settled source lifetime; only projects carry edit revisions. */
export type JobTarget =
  | Extract<JobOwner, { kind: "import" | "asset" | "acquisition" }>
  | (Extract<JobOwner, { kind: "project" }> & Readonly<{ revisionId: string }>)
  | (Extract<JobOwner, { kind: "recording" }> & Readonly<{ revisionId: null }>);
export type JobRequestTarget =
  | Exclude<JobTarget, { kind: "recording" }>
  | (Extract<JobOwner, { kind: "recording" }> & Readonly<{ revisionId?: string | null }>);

/** Domain owners validate existence and deletion intent in the same catalog transaction as admission. */
export type JobTargets = {
  pin(target: JobRequestTarget): JobTarget;
  isAvailable(target: JobTarget): boolean;
  isDeleting(owner: JobOwner): boolean;
  isCapturing(): boolean;
};

export type JobRequest = Readonly<{
  target: JobRequestTarget;
  /** Which artifact this work produces, named by its owning adapter. */
  artifact: string;
  lane: JobLane;
  /** Canonical identity of the work's inputs. The queue only compares it; its meaning is the caller's. */
  input: string;
}>;

export type Job = Readonly<{
  jobId: string;
  /**
   * Identity of the one attempt that may currently answer for this job. A retry mints a new one,
   * so the answer of an attempt that was abandoned, canceled or lost to a restart cannot land.
   */
  attemptId: string;
  /** Fixed at admission; retries validate this identity without following later edits. */
  target: JobTarget;
  artifact: string;
  lane: JobLane;
  input: string;
  state: JobState;
  reason: string | null;
  errorCode: string | null;
  errorDetails: Record<string, unknown> | null;
  retryable: boolean;
  /** Reserved for this attempt before work starts; retries never reuse a generation. */
  generation: number;
}>;

/** One published artifact: what the work produced, and the identity it was produced for. */
export type Artifact = Readonly<{
  target: JobTarget;
  artifact: string;
  generation: number;
  input: string;
  result: string;
}>;

export const retainedPublicationSchema = z.strictObject({
  generation: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  attemptId: z.string().min(1).max(256),
  input: z.string().max(65536),
});
/** Publication provenance survives relocation without claiming a local execution. */
export type RetainedArtifact = Artifact & Readonly<{ attemptId: string }>;

/** A publication as callers read it: the artifact and every issue reported with it. */
export type PublishedArtifact = Artifact & Readonly<{ issues: Issue[] }>;

export type ArtifactStatus = Readonly<{
  state: ArtifactState;
  jobId: string | null;
  reason: string | null;
  retryable: boolean;
  published: PublishedArtifact | null;
}>;

type Settlement =
  | (Pick<StagedJobResult, "result" | "issues"> & Partial<Pick<StagedJobResult, "publish">>)
  | { error: unknown };
/** The running attempt handed to the executor, with the signal that asks it to stop. */
export type JobExecution = Readonly<{ job: Job; signal: AbortSignal }>;
/**
 * File work finishes before settlement; only synchronous catalog writes join the queue fence. Issues
 * describe this result and publish in the same transaction. A result with nothing staged omits
 * `publish` and `close`.
 */
export type StagedJobResult = {
  result: string;
  issues?: readonly Issue[];
  publish?(): undefined;
  close?(): Promise<void>;
};
/**
 * Does the actual work and resolves with the artifact result to publish. An ordinary rejection is a
 * retryable failure. Only CatalogError("UNAVAILABLE") reports an absent artifact; other
 * non-retryable errors remain failures rather than pretending the evidence cannot exist.
 */
export type JobExecutor = (execution: JobExecution) => Promise<string | StagedJobResult>;
/**
 * A lost prerequisite releases the settled attempt back to dependency admission once. Losing it
 * again fails the job as retryable, so a prerequisite that keeps disappearing cannot cycle forever.
 */
export class JobDependencyLost extends Error {}

declare const contextBrand: unique symbol;
/** Queue-issued lifetime authority. The embedded recording ID is never a scheduling owner. */
export type JobContext = Readonly<{ contextId: string; [contextBrand]: true }>;
export type ContextJobRequest = Pick<JobRequest, "artifact" | "lane" | "input">;
export type ContextJob = Omit<Job, "target" | "state"> & {
  state: Exclude<JobState, "waiting">;
  contextId: string;
  result: string | null;
};
export type ContextJobExecutor = (execution: {
  job: ContextJob;
  signal: AbortSignal;
}) => Promise<string>;
type ContextRow = ContextJob & { queuedSequence: number };
type ContextState = {
  id: string;
  execute?: ContextJobExecutor;
  jobs: Map<string, ContextRow>;
  closed: boolean;
  closing?: Promise<void>;
};
type ClaimedJob = { job: Job; context?: never } | { job: ContextJob; context: ContextState };
function contextValue(row: ContextRow): ContextJob {
  return omit(row, "queuedSequence");
}
const contextLimit = 4;
const contextJobLimit = 32;
const contextValueBytes = 64 * 1024;

const summaryColumns =
  "jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,state,reason,retryable,generation,errorCode,errorDetails";
const jobColumns = `${summaryColumns},input`;
function inputDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
function requireExactInput(actual: string, expected: string): void {
  if (actual !== expected)
    throw new CatalogError("IDENTITY_COLLISION", "Different job inputs have the same digest");
}
type TargetRow = { targetKind: JobOwner["kind"]; targetId: string; revisionId: string };
type JobRow = Omit<Job, "target" | "retryable" | "errorDetails"> &
  TargetRow & { retryable: number; errorDetails: string | null };
type ArtifactRow = Omit<Artifact, "target"> & TargetRow;
export function ownerIdentity(owner: JobOwner): [JobOwner["kind"], string] {
  switch (owner.kind) {
    case "import":
      return [owner.kind, owner.importId];
    case "asset":
      return [owner.kind, owner.assetId];
    case "acquisition":
      return [owner.kind, owner.acquisitionId];
    case "project":
      return [owner.kind, owner.projectId];
    case "recording":
      return [owner.kind, owner.recordingId];
  }
}
function targetValues(target: JobTarget): [JobOwner["kind"], string, string] {
  return [...ownerIdentity(target), "revisionId" in target ? (target.revisionId ?? "") : ""];
}
export function ownerFromIdentity(kind: JobOwner["kind"], id: string): JobOwner {
  switch (kind) {
    case "import":
      return { kind, importId: id };
    case "asset":
      return { kind, assetId: id };
    case "acquisition":
      return { kind, acquisitionId: id };
    case "project":
      return { kind, projectId: id };
    case "recording":
      return { kind, recordingId: id };
  }
}
function targetFrom({ targetKind, targetId, revisionId }: TargetRow): JobTarget {
  const owner = ownerFromIdentity(targetKind, targetId);
  if (owner.kind === "recording") return { ...owner, revisionId: null };
  return owner.kind === "project" ? { ...owner, revisionId } : owner;
}
function toArtifact(stored: ArtifactRow & { attemptId?: string }): Artifact {
  const { targetKind, targetId, revisionId, ...row } = omit(stored, "attemptId");
  return { ...row, target: targetFrom({ targetKind, targetId, revisionId }) };
}
function toJob({ targetKind, targetId, revisionId, ...row }: JobRow): Job {
  return {
    ...row,
    target: targetFrom({ targetKind, targetId, revisionId }),
    errorDetails: row.errorDetails === null ? null : JSON.parse(row.errorDetails),
    retryable: row.retryable === 1,
  };
}
function sameOwner(first: JobOwner | undefined, second: JobOwner): boolean {
  return (
    first !== undefined &&
    ownerIdentity(first).every((value, index) => value === ownerIdentity(second)[index])
  );
}

/** Copy only bounded JSON data; never execute diagnostic getters or toJSON hooks. */
function failureDetails(details: Record<string, unknown>): Record<string, unknown> {
  let entries = 0;
  let bytes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++entries > 1024 || depth > 8) throw new Error("limit");
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > 16384) throw new Error("limit");
      return value;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    if (!value || typeof value !== "object") throw new Error("unsupported");
    const array = Array.isArray(value);
    if (
      !array &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("unsupported");
    const result: Record<string, unknown> = Object.create(null);
    // Stop enumerating once the entry budget is exhausted, even for enormous source diagnostics.
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      bytes += Buffer.byteLength(key);
      if (bytes > 16384) throw new Error("limit");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("accessor");
      result[key] = copy(descriptor.value, depth + 1);
    }
    return array ? Object.values(result) : result;
  };
  try {
    const result = copy(details, 0) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw new Error("limit");
    return result;
  } catch {
    return { truncated: true, reason: "Diagnostic details exceed limits or are not JSON data" };
  }
}

/** An absent artifact is unavailable; anything else fails, retryable unless a CatalogError says not. */
function failure(error: unknown): Pick<
  Job,
  "reason" | "retryable" | "errorCode" | "errorDetails"
> & {
  state: "failed" | "unavailable";
} {
  return {
    state: error instanceof CatalogError && error.code === "UNAVAILABLE" ? "unavailable" : "failed",
    errorCode: error instanceof CatalogError ? error.code : "JOB_FAILED",
    errorDetails: error instanceof CatalogError ? failureDetails(error.details) : null,
    reason: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
    retryable: !(error instanceof CatalogError) || error.retryable,
  };
}

/**
 * One execution queue for durable library artifacts and transient package contexts. Durable rows
 * stay in the shared catalog, so a restart reads the same authority. Work starts only when a
 * submission, a settled attempt or a reported capture change says something might now be allowed.
 * Nothing polls, and a failed attempt waits for an explicit retry; the one automatic re-admission is
 * a deferred job whose prerequisite was lost once. The service that owns the catalog owns one queue.
 */
export class JobQueue {
  onUpdateProgress: (() => void) | undefined;
  private readonly store: Catalog;
  private readonly references: ResourceReferences;
  private readonly targets: JobTargets;
  private readonly execute: JobExecutor;
  private readonly newId: () => string;
  private readonly attempts = new Map<
    string,
    {
      jobId: string;
      target?: JobOwner;
      context?: ContextState;
      lane: JobLane;
      controller: AbortController;
      done: Promise<void>;
    }
  >();
  get updateBlocked(): boolean {
    if (this.attempts.size || this.admissionScheduled || this.admitting) return true;
    if (
      this.store.catalog
        .prepare("SELECT 1 FROM jobs WHERE state IN ('waiting','queued','running') LIMIT 1")
        .get()
    )
      return true;
    return [...this.activeContexts].some((context) =>
      [...context.jobs.values()].some((job) => job.state === "queued" || job.state === "running"),
    );
  }

  private readonly contexts = new WeakMap<JobContext, ContextState>();
  private readonly activeContexts = new Set<ContextState>();
  private sequence = 0;
  private closed = false;
  private executionStarted: boolean;
  private admission: JobAdmission | undefined;
  private admitting = false;
  private admissionScheduled = false;
  private readonly onCapacity: (() => void) | undefined;

  constructor(options: {
    store: Catalog;
    targets: JobTargets;
    execute: JobExecutor;
    providers: { newId: () => string };
    onCapacity?: () => void;
    /** Assembled services call start() after all owners and recovery are ready. */
    deferExecution?: boolean;
  }) {
    this.store = options.store;
    this.executionStarted = !options.deferExecution;
    // SQL consumers use the same digest for joins on their bounded identity keys.
    this.store.catalog.function("job_input_digest", { deterministic: true }, (input) => {
      if (typeof input !== "string") throw new TypeError("Job input must be text");
      return inputDigest(input);
    });
    this.references = new ResourceReferences(this.store);
    this.targets = options.targets;
    this.execute = options.execute;
    this.newId = options.providers.newId;
    this.onCapacity = options.onCapacity;
    this.store.catalog.exec(`
   CREATE TABLE IF NOT EXISTS jobs (
    jobId TEXT PRIMARY KEY,attemptId TEXT NOT NULL,targetKind TEXT NOT NULL,targetId TEXT NOT NULL,revisionId TEXT NOT NULL,
    artifact TEXT NOT NULL,lane TEXT NOT NULL,state TEXT NOT NULL,
    reason TEXT,errorCode TEXT,errorDetails TEXT,retryable INTEGER NOT NULL,generation INTEGER NOT NULL,queuedSequence INTEGER NOT NULL,
    deferred INTEGER NOT NULL DEFAULT 0 CHECK(deferred IN (0,1)),
    readmitted INTEGER NOT NULL DEFAULT 0 CHECK(readmitted IN (0,1)),
    inputSha256 TEXT NOT NULL,input TEXT NOT NULL
   ) STRICT;
   CREATE UNIQUE INDEX IF NOT EXISTS jobs_identity
    ON jobs(targetKind,targetId,revisionId,artifact,inputSha256);
   CREATE INDEX IF NOT EXISTS jobs_waiting ON jobs(queuedSequence) WHERE state='waiting';
   CREATE TABLE IF NOT EXISTS artifacts (
    targetKind TEXT NOT NULL,targetId TEXT NOT NULL,artifact TEXT NOT NULL,generation INTEGER NOT NULL,
    revisionId TEXT NOT NULL,attemptId TEXT NOT NULL,result TEXT NOT NULL,inputSha256 TEXT NOT NULL,input TEXT NOT NULL,
    PRIMARY KEY(targetKind,targetId,revisionId,artifact,inputSha256)
   ) STRICT;
   CREATE INDEX IF NOT EXISTS artifacts_attempt ON artifacts(targetKind,targetId,artifact,attemptId);
  `);
    createOutputIssues(this.store);
    // Only a process that died holding an attempt can leave a running row behind, so reopening the
    // catalog resolves the ambiguity instead of leaving work that nobody is doing look busy.
    this.store.catalog
      .prepare(
        "UPDATE jobs SET state='failed',reason=?,errorCode='JOB_INTERRUPTED',errorDetails=NULL,retryable=1 WHERE state='running'",
      )
      .run("interrupted");
    this.sequence = Number(
      (
        this.store.catalog
          .prepare("SELECT COALESCE(MAX(queuedSequence),0) AS sequence FROM jobs")
          .get() as { sequence: number }
      ).sequence,
    );
    this.runQueued();
  }

  /** Release the shared execution barrier only after owner recovery has settled. */
  start(): void {
    this.requireOpen();
    if (this.executionStarted) return;
    this.executionStarted = true;
    this.resumeAdmission();
    this.runQueued();
  }

  createContext(execute: ContextJobExecutor): JobContext {
    this.requireOpen();
    if (this.activeContexts.size >= contextLimit)
      throw new CatalogError("CAPACITY_EXCEEDED", "Too many package contexts are open", {});
    const context = Object.freeze({ contextId: this.newId() }) as JobContext;
    const state: ContextState = { id: context.contextId, execute, jobs: new Map(), closed: false };
    this.contexts.set(context, state);
    this.activeContexts.add(state);
    return context;
  }
  private context(context: JobContext, allowClosed = false): ContextState {
    const state = this.contexts.get(context);
    if (!state || (state.closed && !allowClosed))
      throw new CatalogError("CONTEXT_CLOSED", "Package context is not open in this queue");
    return state;
  }
  submitContext(context: JobContext, request: ContextJobRequest): ContextJob {
    this.requireOpen();
    const state = this.context(context);
    if (
      !request.artifact ||
      Buffer.byteLength(request.artifact) > 128 ||
      Buffer.byteLength(request.input) > contextValueBytes
    )
      throw new CatalogError("LIMIT_EXCEEDED", "Package job identity is too large");
    const existing = [...state.jobs.values()].find(
      (job) => job.artifact === request.artifact && job.input === request.input,
    );
    if (existing) {
      if (existing.lane !== request.lane)
        throw new CatalogError("INVALID_REQUEST", "An existing job cannot change execution lane");
      this.runQueued();
      return this.contextJob(context, existing.jobId);
    }
    if (state.jobs.size >= contextJobLimit)
      throw new CatalogError("LIMIT_EXCEEDED", "Package context job metadata limit exceeded");
    this.admit();
    const job: ContextRow = {
      jobId: this.newId(),
      attemptId: this.newId(),
      contextId: state.id,
      artifact: request.artifact,
      input: request.input,
      lane: request.lane,
      state: "queued",
      reason: null,
      errorCode: null,
      errorDetails: null,
      retryable: false,
      generation: 1,
      result: null,
      queuedSequence: ++this.sequence,
    };
    state.jobs.set(job.jobId, job);
    this.runQueued();
    return this.contextJob(context, job.jobId);
  }
  contextJobs(context: JobContext): { jobs: ContextJob[]; capacity: number; valueBytes: number } {
    return {
      jobs: [...this.context(context).jobs.values()].map(contextValue),
      capacity: contextJobLimit,
      valueBytes: contextValueBytes,
    };
  }
  contextJob(context: JobContext, jobId: string): ContextJob {
    const job = this.context(context).jobs.get(jobId);
    if (!job) throw new CatalogError("NOT_FOUND", "Package job does not exist", { jobId });
    return contextValue(job);
  }
  retryContext(context: JobContext, jobId: string): ContextJob {
    this.requireOpen();
    const state = this.context(context),
      current = this.contextJob(context, jobId);
    if (["queued", "running", "ready"].includes(current.state)) {
      this.runQueued();
      return this.contextJob(context, jobId);
    }
    if (!current.retryable) throw new CatalogError("UNAVAILABLE", "Package job cannot be retried");
    this.admit();
    state.jobs.set(jobId, {
      ...current,
      attemptId: this.newId(),
      generation: current.generation + 1,
      queuedSequence: ++this.sequence,
      state: "queued",
      reason: null,
      errorCode: null,
      errorDetails: null,
      retryable: false,
      result: null,
    });
    this.runQueued();
    return this.contextJob(context, jobId);
  }
  cancelContextJob(context: JobContext, jobId: string): ContextJob {
    this.requireOpen();
    const state = this.context(context),
      job = this.contextJob(context, jobId);
    if (job.state === "queued" || job.state === "running") {
      Object.assign(state.jobs.get(jobId)!, {
        state: "canceled",
        reason: "canceled",
        errorCode: null,
        errorDetails: null,
        retryable: true,
      });
      this.attempts.get(job.attemptId)?.controller.abort();
      this.capacityAvailable();
    }
    return this.contextJob(context, jobId);
  }
  /** The owner releases terminal metadata after retaining any result it needs. Active attempts are never evicted. */
  forgetContextJob(context: JobContext, jobId: string): void {
    const state = this.context(context),
      job = this.contextJob(context, jobId);
    if (
      job.state === "queued" ||
      job.state === "running" ||
      [...this.attempts.values()].some((attempt) => attempt.jobId === jobId)
    )
      throw new CatalogError("PROCESSING_BUSY", "Package job is still active", {});
    state.jobs.delete(jobId);
  }
  closeContext(context: JobContext): Promise<void> {
    const state = this.context(context, true);
    return (state.closing ??= (async () => {
      state.closed = true;
      for (const job of state.jobs.values())
        if (job.state === "queued" || job.state === "running")
          Object.assign(job, {
            state: "canceled",
            reason: "context_closed",
            errorCode: null,
            errorDetails: null,
            retryable: false,
          });
      const attempts = [...this.attempts.values()].filter((attempt) => attempt.context === state);
      for (const attempt of attempts) attempt.controller.abort();
      this.capacityAvailable();
      await Promise.all(attempts.map((attempt) => attempt.done));
      state.jobs.clear();
      delete state.execute;
      this.activeContexts.delete(state);
    })());
  }

  /**
   * Admits one job for a pinned target. An existing exact identity returns its current outcome, including failure. Resolve
   * current once at admission; historical requests pin their explicit revision. Only retry
   * creates another attempt, so repeated inspection cannot trigger automatic retry loops.
   * Factories and admission callbacks run on replay too: use idempotent same-catalog writes only.
   * The callback receives the real job ID before commit, so dependency references publish atomically.
   */
  submit(request: JobRequest | (() => JobRequest), admitted?: (job: Job) => void): Job {
    return this.submitJob(request, false, admitted);
  }

  submitDeferred(request: JobRequest, admitted?: (job: Job) => void): Job {
    return this.submitJob(request, true, admitted);
  }

  private submitJob(
    input: JobRequest | (() => JobRequest),
    deferred: boolean,
    admitted?: (job: Job) => void,
  ): Job {
    let created = false;
    const jobId = this.store.transaction(() => {
      this.requireOpen();
      // Domain ownership and queue admission commit together; execution starts after commit.
      const request = typeof input === "function" ? input() : input;
      const target = this.targets.pin(request.target);
      const existing = this.existing({ ...request, target });
      if (existing) {
        if (existing.lane !== request.lane)
          throw new CatalogError("INVALID_REQUEST", "An existing job cannot change execution lane");
        admitted?.(this.job(existing.jobId));
        return existing.jobId;
      }
      if (deferred) this.admitWaiting();
      else this.admit();
      created = true;
      const admittedId = this.newId();
      this.store.catalog
        .prepare(
          `INSERT INTO jobs(jobId,attemptId,targetKind,targetId,revisionId,artifact,lane,input,state,reason,retryable,generation,errorCode,errorDetails,queuedSequence,deferred,inputSha256)
           VALUES (?,?,?,?,?,?,?,?,?,NULL,0,?,NULL,NULL,?,?,?)`,
        )
        .run(
          admittedId,
          this.newId(),
          ...targetValues(target),
          request.artifact,
          request.lane,
          request.input,
          deferred ? "waiting" : "queued",
          this.nextGeneration({ target, artifact: request.artifact, input: request.input }),
          ++this.sequence,
          Number(deferred),
          inputDigest(request.input),
        );
      admitted?.(this.job(admittedId));
      return admittedId;
    });
    if (created) {
      if (deferred && this.admitting) this.scheduleAdmission();
      else this.resumeAdmission();
    }
    this.runQueued();
    return this.job(jobId);
  }

  /**
   * Starts one more attempt at a failed job under a fresh attempt identity. A job that is already
   * queued or running is that attempt, and a job that already produced its artifact is the outcome
   * being asked for, so both are returned unchanged rather than duplicated.
   */
  retry(jobId: string): Job {
    let changed = false;
    const retried = this.store.transaction(() => {
      this.requireOpen();
      const current = this.job(jobId);
      this.targets.pin(current.target);
      if (
        current.state === "waiting" ||
        current.state === "queued" ||
        current.state === "running" ||
        current.state === "ready"
      )
        return current.jobId;
      if (!current.retryable)
        throw new CatalogError("UNAVAILABLE", "This job cannot be retried", {
          state: current.state,
          reason: current.reason,
          errorCode: current.errorCode,
        });
      this.requeue(current);
      changed = true;
      return jobId;
    });
    if (changed) this.resumeAdmission();
    this.runQueued();
    return this.job(retried);
  }

  /** Rebuild an evicted derivative only if the caller still names the published generation. */
  regenerate(jobId: string, generation: number, admitted?: (job: Job) => void): Job {
    let changed = false;
    this.store.transaction(() => {
      this.requireOpen();
      const current = this.job(jobId);
      if (current.state !== "ready" || current.generation !== generation) return;
      this.targets.pin(current.target);
      this.requeue(current);
      admitted?.(this.job(jobId));
      this.store.catalog
        .prepare(
          "DELETE FROM artifacts WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=? AND inputSha256=? AND input=? AND generation=?",
        )
        .run(
          ...targetValues(current.target),
          current.artifact,
          inputDigest(current.input),
          current.input,
          generation,
        );
      changed = true;
    });
    if (changed) this.resumeAdmission();
    this.runQueued();
    return this.job(jobId);
  }

  /** Starts another attempt. Only a lost prerequisite marks it readmitted; an explicit request clears that. */
  private requeue(current: Job, readmitted = false): void {
    const { deferred } = this.store.catalog
      .prepare("SELECT deferred FROM jobs WHERE jobId=?")
      .get(current.jobId) as { deferred: number };
    if (deferred) this.admitWaiting();
    else this.admit();
    this.store.catalog
      .prepare(
        `UPDATE jobs SET state=?,attemptId=?,reason=NULL,errorCode=NULL,errorDetails=NULL,retryable=0,generation=generation+1,
         queuedSequence=?,readmitted=? WHERE jobId=?`,
      )
      .run(
        deferred ? "waiting" : "queued",
        this.newId(),
        ++this.sequence,
        Number(readmitted),
        current.jobId,
      );
    if (deferred && this.admitting) this.scheduleAdmission();
  }

  /**
   * Stops a job. The attempt is asked to abort, but its lane stays occupied until the work actually
   * settles, so cancellation can never hand out capacity that something is still using.
   */
  cancel(jobId: string): Job {
    this.requireOpen();
    const stopped = this.store.transaction(() => {
      const current = this.job(jobId);
      if (current.state !== "waiting" && current.state !== "queued" && current.state !== "running")
        return null;
      this.discard(jobId, "canceled");
      return current.attemptId;
    });
    if (stopped !== null) {
      this.attempts.get(stopped)?.controller.abort();
      this.capacityAvailable();
    }
    return this.job(jobId);
  }

  private requireOpen(): void {
    if (this.closed) throw new CatalogError("SERVICE_STOPPED", "The job queue is closed", {});
  }

  private existing(identity: Pick<Job, "target" | "artifact" | "input">): Job | null {
    const row = this.store.catalog
      .prepare(
        `SELECT ${jobColumns} FROM jobs WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=? AND inputSha256=?`,
      )
      .get(...targetValues(identity.target), identity.artifact, inputDigest(identity.input)) as
      | JobRow
      | undefined;
    if (row) requireExactInput(row.input, identity.input);
    return row ? toJob(row) : null;
  }

  job(jobId: string): Job {
    const row = this.store.catalog
      .prepare(`SELECT ${jobColumns} FROM jobs WHERE jobId=?`)
      .get(jobId) as JobRow | undefined;
    if (!row) throw new CatalogError("NOT_FOUND", "Job does not exist", { jobId });
    return toJob(row);
  }

  /** Automatic dependency readmission must not acquire the authority of an explicit child retry. */
  wasReadmitted(jobId: string): boolean {
    this.job(jobId);
    return !!(
      this.store.catalog.prepare("SELECT readmitted FROM jobs WHERE jobId=?").get(jobId) as {
        readmitted: number;
      }
    ).readmitted;
  }

  private publication(
    identity: Pick<Artifact, "target" | "artifact" | "input">,
  ): (ArtifactRow & { attemptId: string }) | null {
    const row = this.store.catalog
      .prepare(
        "SELECT targetKind,targetId,revisionId,artifact,generation,input,attemptId,result FROM artifacts WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=? AND inputSha256=?",
      )
      .get(...targetValues(identity.target), identity.artifact, inputDigest(identity.input)) as
      | (ArtifactRow & { attemptId: string })
      | undefined;
    if (row) requireExactInput(row.input, identity.input);
    return row ?? null;
  }

  private nextGeneration(identity: Pick<Artifact, "target" | "artifact" | "input">): number {
    const generation = (this.publication(identity)?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation))
      throw new CatalogError("LIMIT_EXCEEDED", "Artifact generation limit exceeded");
    return generation;
  }

  /** Inspect durable state without decoding or rehashing the execution recipe. */
  inspect(jobId: string) {
    const row = this.store.catalog
      .prepare(`SELECT ${summaryColumns},inputSha256 FROM jobs WHERE jobId=?`)
      .get(jobId) as (Omit<JobRow, "input"> & { inputSha256: string }) | undefined;
    if (!row) throw new CatalogError("NOT_FOUND", "Job does not exist", { jobId });
    const { targetKind, targetId, revisionId, retryable, errorDetails, ...summary } = row;
    const target = targetFrom(row);
    const publication = this.targets.isAvailable(target)
      ? (this.store.catalog
          .prepare(
            "SELECT generation,attemptId,result FROM artifacts WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=? AND inputSha256=?",
          )
          .get(targetKind, targetId, revisionId, row.artifact, row.inputSha256) as
          | { generation: number; attemptId: string; result: string }
          | undefined)
      : undefined;
    return {
      ...summary,
      target,
      retryable: Boolean(retryable),
      errorDetails: errorDetails ? JSON.parse(errorDetails) : null,
      published: publication
        ? {
            generation: publication.generation,
            attemptId: publication.attemptId,
            output: JSON.parse(publication.result) as unknown,
            issues: this.issues(publication),
          }
        : null,
    };
  }

  retainedArtifact(owner: JobOwner, artifact: string, attemptId: string): RetainedArtifact | null {
    const row = this.store.catalog
      .prepare(
        "SELECT targetKind,targetId,revisionId,artifact,generation,input,result FROM artifacts WHERE targetKind=? AND targetId=? AND artifact=? AND attemptId=? LIMIT 1",
      )
      .get(...ownerIdentity(owner), artifact, attemptId) as ArtifactRow | undefined;
    return row ? { ...toArtifact(row), attemptId } : null;
  }

  /**
   * The dependency owner validates the result and supplies its issues, which it re-derives
   * locally from the adopted evidence; every adopter names them, even when there are none. The
   * publication joins the caller's catalog transaction.
   */
  adoptArtifact(receipt: RetainedArtifact, issues: readonly Issue[]): void {
    this.requireOpen();
    this.targets.pin(receipt.target);
    const existing = this.publication(receipt);
    if (existing) {
      if (
        existing.generation !== receipt.generation ||
        existing.attemptId !== receipt.attemptId ||
        existing.result !== receipt.result
      )
        throw new CatalogError(
          "INVALID_PACKAGE",
          "Retained publication conflicts with local artifact",
        );
      return;
    }
    const local = this.existing(receipt);
    if (local) {
      if (["waiting", "queued", "running"].includes(local.state))
        throw new CatalogError(
          "PROCESSING_BUSY",
          "Local work already owns this publication identity",
          {},
        );
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Local terminal work conflicts with retained publication identity",
      );
    }
    if (!Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || !receipt.attemptId)
      throw new CatalogError("INVALID_PACKAGE", "Invalid retained publication identity");
    this.store.catalog
      .prepare(
        "INSERT INTO artifacts(targetKind,targetId,revisionId,artifact,generation,input,attemptId,result,inputSha256) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ...targetValues(receipt.target),
        receipt.artifact,
        receipt.generation,
        receipt.input,
        receipt.attemptId,
        receipt.result,
        inputDigest(receipt.input),
      );
    writeOutputIssues(
      this.store,
      { outputKind: "artifact", outputId: receipt.attemptId, generation: receipt.generation },
      issues,
    );
  }

  /** Recover frozen work by an explicit business-request key before execution readiness.
   * The key lives in canonical JSON input; the recovered input remains the job's exact identity. */
  statusByReplayKey(
    identity: Pick<Job, "target" | "artifact"> & { replayKey: string },
  ): ArtifactStatus | undefined {
    const row = this.store.catalog
      .prepare(`
      SELECT input FROM jobs WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=?
        AND CASE WHEN json_valid(input) THEN json_extract(input,'$.replayKey') END=?
      UNION ALL
      SELECT input FROM artifacts WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=?
        AND CASE WHEN json_valid(input) THEN json_extract(input,'$.replayKey') END=?
      LIMIT 1
    `)
      .get(
        ...targetValues(identity.target),
        identity.artifact,
        identity.replayKey,
        ...targetValues(identity.target),
        identity.artifact,
        identity.replayKey,
      ) as { input: string } | undefined;
    return row ? this.status({ ...identity, input: row.input }) : undefined;
  }

  /** Readiness is for the exact pinned revision and inputs, never whichever job finished last. */
  status(identity: Pick<Job, "target" | "artifact" | "input">): ArtifactStatus {
    const job = this.existing(identity);
    const present = this.targets.isAvailable(identity.target);
    const published = present ? this.publication(identity) : null;
    return {
      state:
        !present || job?.state === "canceled"
          ? "not_requested"
          : !job
            ? published
              ? "ready"
              : "not_requested"
            : job.state === "waiting"
              ? "queued"
              : job.state === "running"
                ? "processing"
                : job.state,
      jobId: job?.jobId ?? null,
      reason: job?.reason ?? null,
      retryable: job?.retryable ?? false,
      published: published ? { ...toArtifact(published), issues: this.issues(published) } : null,
    };
  }

  /** What was reported with one publication, including one retained by attempt. */
  issues(publication: Pick<RetainedArtifact, "generation" | "attemptId">): Issue[] {
    return outputIssues(this.store, {
      outputKind: "artifact",
      outputId: publication.attemptId,
      generation: publication.generation,
    });
  }

  /**
   * Re-examines what may start now. The queue never polls, so the owner calls this after a reported
   * capture transition; every other trigger is a submission, a retry, a cancel or a settled attempt.
   */
  schedule(): void {
    this.resumeAdmission();
    this.runQueued();
  }

  private runQueued(): void {
    if (this.closed || !this.executionStarted || this.admitting) return;
    // A take that can still produce media outranks heavy background work, so heavy attempts wait for
    // it. Startup reconciliation is what settles a stranded take, and with it this pause.
    const capturing = this.targets.isCapturing();
    for (const lane of Object.keys(laneLimits) as JobLane[]) {
      if (lane === "heavy" && capturing) continue;
      while (this.occupied(lane) < laneLimits[lane]) {
        const job = this.claim(lane);
        if (!job) break;
        if (job.context) this.runContext(job.context, job.job);
        else this.run(job.job);
      }
    }
  }

  /** The resource owner must fence retries before draining one job's complete worker lifetime. */
  async drainJob(jobId: string): Promise<void> {
    this.cancel(jobId);
    const active = [...this.attempts.values()].filter((attempt) => attempt.jobId === jobId);
    for (const attempt of active) attempt.controller.abort();
    await Promise.all(active.map((attempt) => attempt.done));
  }

  /** Forget identity and result together only after all attempts, including canceled ones, close. */
  forgetJob(jobId: string): void {
    this.store.transaction(() => {
      const job = this.job(jobId);
      if (
        ["waiting", "queued", "running"].includes(job.state) ||
        [...this.attempts.values()].some((attempt) => attempt.jobId === jobId)
      )
        throw new CatalogError("PROCESSING_BUSY", "Job is still active", {});
      this.store.catalog
        .prepare(
          "DELETE FROM artifacts WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=? AND inputSha256=? AND input=?",
        )
        .run(...targetValues(job.target), job.artifact, inputDigest(job.input), job.input);
      for (const kind of ["job", "job-input"] as const)
        while (this.references.releaseOwnerPage({ kind, id: jobId })) {
          /* Atomic retirement. */
        }
      this.store.catalog.prepare("DELETE FROM jobs WHERE jobId=?").run(jobId);
    });
  }

  /**
   * Retires a publication its owner found stale, with the settled job that produced it. Returns
   * false, forgetting nothing, while that job is still active.
   */
  forgetPublication(owner: JobOwner, artifact: string, attemptId: string): boolean {
    const row = this.store.catalog
      .prepare(
        "SELECT targetKind,targetId,revisionId,input FROM artifacts WHERE targetKind=? AND targetId=? AND artifact=? AND attemptId=?",
      )
      .get(...ownerIdentity(owner), artifact, attemptId) as
      | (TargetRow & { input: string })
      | undefined;
    if (!row) return true;
    const job = this.existing({ target: targetFrom(row), artifact, input: row.input });
    if (
      job &&
      (["waiting", "queued", "running"].includes(job.state) ||
        [...this.attempts.values()].some((attempt) => attempt.jobId === job.jobId))
    )
      return false;
    if (job) this.forgetJob(job.jobId);
    else
      this.store.catalog
        .prepare(
          "DELETE FROM artifacts WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact=? AND attemptId=?",
        )
        .run(row.targetKind, row.targetId, row.revisionId, artifact, attemptId);
    return true;
  }

  /** Intent is committed first: no new attempt may enter while these executors close. */
  async drainOwner(owner: JobOwner): Promise<void> {
    if (!this.targets.isDeleting(owner))
      throw new CatalogError("INVALID_STATE", "Target deletion has not been requested");
    this.store.catalog
      .prepare(`UPDATE jobs SET state='canceled',reason=?,errorCode=NULL,errorDetails=NULL,retryable=0
      WHERE targetKind=? AND targetId=? AND state IN ('waiting','queued','running')`)
      .run(`${owner.kind}_unavailable`, ...ownerIdentity(owner));
    const active = [...this.attempts.values()].filter((attempt) =>
      sameOwner(attempt.target, owner),
    );
    for (const attempt of active) attempt.controller.abort();
    this.capacityAvailable();
    await Promise.all(active.map((attempt) => attempt.done));
  }

  /** Job metadata can disappear only after every executor, including canceled workers, has exited. */
  async forgetOwner(owner: JobOwner): Promise<void> {
    if (!this.targets.isDeleting(owner))
      throw new CatalogError("INVALID_STATE", "Target deletion has not been requested");
    if (
      [...this.attempts.values()].some((attempt) => sameOwner(attempt.target, owner)) ||
      this.store.catalog
        .prepare(
          "SELECT 1 FROM jobs WHERE targetKind=? AND targetId=? AND state IN ('waiting','queued','running') LIMIT 1",
        )
        .get(...ownerIdentity(owner))
    )
      throw new CatalogError("PROCESSING_BUSY", "Target jobs have not finished closing", {});
    for (;;) {
      const jobs = this.store.catalog
        .prepare("SELECT jobId FROM jobs WHERE targetKind=? AND targetId=? LIMIT 256")
        .all(...ownerIdentity(owner)) as { jobId: string }[];
      if (!jobs.length) break;
      for (const { jobId } of jobs) {
        for (const kind of ["job", "job-input"] as const)
          while (this.references.releaseOwnerPage({ kind, id: jobId })) await setImmediate();
        this.store.catalog.prepare("DELETE FROM jobs WHERE jobId=?").run(jobId);
      }
      await setImmediate();
    }
    for (;;) {
      const removed = this.store.catalog
        .prepare(`DELETE FROM artifacts WHERE rowid IN
        (SELECT rowid FROM artifacts WHERE targetKind=? AND targetId=? LIMIT 256)`)
        .run(...ownerIdentity(owner));
      if (Number(removed.changes) === 0) break;
      await setImmediate();
    }
  }
  /** Resolves once no attempt is in flight. Work still queued behind a lane or capture stays queued. */
  async idle(): Promise<void> {
    while (this.attempts.size > 0 || this.admissionScheduled) {
      if (this.attempts.size > 0)
        await Promise.all([...this.attempts.values()].map((attempt) => attempt.done));
      else await setImmediate();
    }
  }

  /** Aborts everything in flight and stops admitting starts. The catalog stays the store's to close. */
  async close(): Promise<void> {
    this.closed = true;
    let interruption: unknown;
    try {
      this.store.transaction(() => {
        for (const attemptId of this.attempts.keys())
          this.store.catalog
            .prepare(
              "UPDATE jobs SET state='failed',reason='interrupted',errorCode='JOB_INTERRUPTED',errorDetails=NULL,retryable=1 WHERE attemptId=? AND state='running'",
            )
            .run(attemptId);
      });
    } catch (error) {
      // Running workers must still stop; startup marks any attempt left running as interrupted.
      interruption = error;
    }
    const contexts = [...this.activeContexts];
    for (const state of contexts) state.closed = true;
    for (const attempt of this.attempts.values()) attempt.controller.abort();
    await this.idle();
    for (const state of contexts) {
      state.jobs.clear();
      delete state.execute;
    }
    this.activeContexts.clear();
    if (interruption) throw interruption;
  }

  /** A canceled attempt still owns its files until its executor has settled. */
  isAttemptActive(attemptId: string): boolean {
    return this.attempts.has(attemptId);
  }

  /** Called within admission's transaction; published replays no longer need preparation inputs. */
  retainInputs(jobId: string, kind: ResourceKind, ids: readonly string[]): void {
    const job = this.job(jobId);
    if (!["waiting", "queued", "running"].includes(job.state) && !job.retryable) return;
    this.references.retain(kind, { kind: "job-input", id: jobId }, ids);
  }

  /** Normalized resource-first lookup, independent of recipe shape and scene count. */
  retainsInput(kind: ResourceKind, id: string): boolean {
    if (
      this.store.catalog
        .prepare(`SELECT 1 FROM resource_references AS ref
      JOIN jobs ON jobs.jobId=ref.ownerId
      WHERE ref.resourceKind=? AND ref.resourceId=? AND ref.ownerKind='job-input'
      AND (jobs.state IN ('waiting','queued','running') OR jobs.retryable=1) LIMIT 1`)
        .get(kind, id)
    )
      return true;
    // A canceled worker may still read its inputs; concurrency caps this scan at three attempts.
    for (const attempt of this.attempts.values())
      if (
        this.store.catalog
          .prepare(`SELECT 1 FROM resource_references
        WHERE resourceKind=? AND resourceId=? AND ownerKind='job-input' AND ownerId=?`)
          .get(kind, id, attempt.jobId)
      )
        return true;
    return false;
  }

  private releaseFinishedInputs(jobId: string, completedAttempt?: string): void {
    if (
      [...this.attempts.entries()].some(
        ([id, attempt]) => attempt.jobId === jobId && id !== completedAttempt,
      )
    )
      return;
    this.store.catalog
      .prepare(`DELETE FROM resource_references
      WHERE ownerKind='job-input' AND ownerId=? AND EXISTS
      (SELECT 1 FROM jobs WHERE jobId=? AND state NOT IN ('waiting','queued','running') AND retryable=0)`)
      .run(jobId, jobId);
  }

  /**
   * Whether files an attempt wrote under its own ID may still be read: the attempt is running or
   * closing, or its result is what this artifact currently publishes for this owner.
   */
  retainsAttempt(owner: JobOwner, artifact: string, attemptId: string): boolean {
    return (
      this.attempts.has(attemptId) ||
      Boolean(
        this.store.catalog
          .prepare(
            "SELECT 1 FROM artifacts WHERE targetKind=? AND targetId=? AND artifact=? AND attemptId=?",
          )
          .get(...ownerIdentity(owner), artifact, attemptId),
      )
    );
  }

  private occupied(lane: JobLane): number {
    let count = 0;
    for (const attempt of this.attempts.values()) if (attempt.lane === lane) count += 1;
    return count;
  }

  /** Install only after dependency owners exist. Persisted waiters cannot execute before this. */
  startAdmission(admit: JobAdmission): void {
    this.requireOpen();
    if (this.admission)
      throw new CatalogError("INVALID_STATE", "Admission owner already installed");
    this.admission = admit;
    this.resumeAdmission();
  }

  /** New dependencies and terminal transitions need a later, nonrecursive admission snapshot. */
  private scheduleAdmission(): void {
    if (this.admissionScheduled || this.closed) return;
    this.admissionScheduled = true;
    void setImmediate().then(() => {
      this.admissionScheduled = false;
      this.resumeAdmission();
      this.onUpdateProgress?.();
    });
  }

  /** One bounded event turn. Dependency submissions cannot recursively restart this scan. */
  resumeAdmission(): void {
    if (this.closed || !this.executionStarted || this.admitting || !this.admission) return;
    this.admitting = true;
    try {
      const rows = this.store.catalog
        .prepare(
          `SELECT ${jobColumns} FROM jobs WHERE state='waiting' ORDER BY queuedSequence LIMIT ?`,
        )
        .all(waitingLimit) as JobRow[];
      for (const row of rows) {
        if (this.closed) break;
        if (this.job(row.jobId).state !== "waiting") continue;
        if (this.targets.isDeleting(targetFrom(row))) {
          this.store.transaction(() => this.discard(row.jobId, `${row.targetKind}_unavailable`));
          this.scheduleAdmission();
          continue;
        }
        try {
          const outcome = this.admission(toJob(row));
          // The callback may cancel this job while requesting another owner.
          if (this.job(row.jobId).state !== "waiting") continue;
          if (outcome.state === "waiting") {
            this.store.catalog
              .prepare("UPDATE jobs SET reason=? WHERE jobId=?")
              .run(outcome.dependency, row.jobId);
          } else {
            this.admit();
            this.store.catalog
              .prepare("UPDATE jobs SET state='queued',reason=NULL,queuedSequence=? WHERE jobId=?")
              .run(++this.sequence, row.jobId);
          }
        } catch (error) {
          if (error instanceof CatalogError && error.code === "CAPACITY_EXCEEDED") continue;
          if (this.job(row.jobId).state !== "waiting") continue;
          this.store.transaction(() => this.fail(row.jobId, error));
          this.scheduleAdmission();
        }
      }
    } finally {
      this.admitting = false;
    }
    this.runQueued();
  }

  private admitWaiting(): void {
    const row = this.store.catalog
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE state='waiting'")
      .get() as { count: number };
    if (row.count >= waitingLimit)
      throw new CatalogError(
        "CAPACITY_EXCEEDED",
        "Too much dependency work is already waiting",
        {},
      );
  }

  private admit(): void {
    const { queued } = this.store.catalog
      .prepare("SELECT COUNT(*) AS queued FROM jobs WHERE state='queued'")
      .get() as { queued: number };
    const contextQueued = [...this.activeContexts].reduce(
      (count, context) =>
        count + [...context.jobs.values()].filter((job) => job.state === "queued").length,
      0,
    );
    if (queued + contextQueued >= queuedLimit)
      throw new CatalogError(
        "CAPACITY_EXCEEDED",
        "Too much work is already waiting; retry once the queue drains",
        { queued: queued + contextQueued },
      );
  }

  private fail(jobId: string, error: unknown, completedAttempt?: string): void {
    const { state, reason, retryable, errorCode, errorDetails } = failure(error);
    this.store.catalog
      .prepare(
        "UPDATE jobs SET state=?,reason=?,retryable=?,errorCode=?,errorDetails=? WHERE jobId=?",
      )
      .run(
        state,
        reason,
        Number(retryable),
        errorCode,
        errorDetails === null ? null : JSON.stringify(errorDetails),
        jobId,
      );
    this.releaseFinishedInputs(jobId, completedAttempt);
  }

  private discard(jobId: string, reason: string): void {
    this.store.catalog
      .prepare(
        "UPDATE jobs SET state='canceled',reason=?,errorCode=NULL,errorDetails=NULL,retryable=? WHERE jobId=?",
      )
      .run(reason, reason === "canceled" ? 1 : 0, jobId);
    this.releaseFinishedInputs(jobId);
  }

  /** Takes the oldest startable job in a lane, dropping work whose owner was discarded meanwhile. */
  private claim(lane: JobLane): ClaimedJob | null {
    const claimed = this.store.transaction<ClaimedJob | null>(() => {
      for (;;) {
        const row = this.store.catalog
          .prepare(
            `SELECT ${jobColumns},queuedSequence FROM jobs
             WHERE lane=? AND state='queued' ORDER BY queuedSequence LIMIT 1`,
          )
          .get(lane) as (JobRow & { queuedSequence: number }) | undefined;
        const eligible = [...this.activeContexts]
          .filter(
            (context) =>
              !context.closed &&
              ![...this.attempts.values()].some((attempt) => attempt.context === context),
          )
          .flatMap((context) =>
            [...context.jobs.values()]
              .filter((job) => job.state === "queued" && job.lane === lane)
              .map((job) => ({ context, job })),
          )
          .sort((a, b) => a.job.queuedSequence - b.job.queuedSequence)[0];
        if (eligible && (!row || eligible.job.queuedSequence < row.queuedSequence)) {
          return {
            context: eligible.context,
            job: { ...contextValue(eligible.job), state: "running" },
          };
        }
        if (!row) return null;
        const fields = omit(row, "queuedSequence");
        if (!this.targets.isAvailable(targetFrom(fields))) {
          this.discard(row.jobId, `${row.targetKind}_unavailable`);
          continue;
        }
        this.store.catalog.prepare("UPDATE jobs SET state='running' WHERE jobId=?").run(row.jobId);
        return { job: { ...toJob(fields), state: "running" } };
      }
    });
    if (claimed?.context)
      Object.assign(claimed.context.jobs.get(claimed.job.jobId)!, { state: "running" });
    return claimed;
  }

  private run(job: Job): void {
    this.startAttempt(
      job,
      { target: job.target },
      (signal) => this.execute({ job, signal }),
      (outcome) => this.settle(job, outcome),
    );
  }
  private runContext(context: ContextState, job: ContextJob): void {
    this.startAttempt(
      job,
      { context },
      (signal) => context.execute!({ job, signal }),
      (outcome) => {
        const current = context.jobs.get(job.jobId);
        if (
          context.closed ||
          !current ||
          current.attemptId !== job.attemptId ||
          current.state !== "running"
        )
          return;
        if ("result" in outcome && Buffer.byteLength(outcome.result) > contextValueBytes)
          outcome = {
            error: new CatalogError("LIMIT_EXCEEDED", "Package job result exceeds metadata limit"),
          };
        if ("result" in outcome)
          Object.assign(current, {
            state: "ready",
            reason: null,
            errorCode: null,
            errorDetails: null,
            result: outcome.result,
          });
        else Object.assign(current, failure(outcome.error));
      },
    );
  }
  private startAttempt(
    job: Pick<Job, "jobId" | "attemptId" | "lane" | "artifact">,
    owner: { target: JobOwner } | { context: ContextState },
    execute: (signal: AbortSignal) => Promise<string | StagedJobResult>,
    settle: (outcome: Settlement) => void,
  ): void {
    const controller = new AbortController();
    let staged: StagedJobResult | undefined;
    const done = Promise.resolve()
      .then(() => execute(controller.signal))
      .then(
        (value) => {
          if (typeof value !== "string") staged = value;
          try {
            settle(typeof value === "string" ? { result: value } : value);
          } catch (error) {
            // Failed catalog publication rolled back; fail the same still-current attempt.
            settle({ error });
          }
        },
        (error: unknown) => settle({ error }),
      )
      .finally(async () => {
        try {
          await staged?.close?.();
        } finally {
          this.attempts.delete(job.attemptId);
          if ("target" in owner)
            this.store.transaction(() => this.releaseFinishedInputs(job.jobId));
        }
      });
    this.attempts.set(job.attemptId, {
      ...owner,
      jobId: job.jobId,
      lane: job.lane,
      controller,
      done,
    });
    void done.then(
      () => this.capacityAvailable(),
      () => this.capacityAvailable(),
    );
  }

  private capacityAvailable(): void {
    if (this.admitting) this.scheduleAdmission();
    else this.resumeAdmission();
    this.runQueued();
    if (!this.closed) this.onCapacity?.();
    this.onUpdateProgress?.();
  }

  private settle(job: Job, outcome: Settlement): void {
    this.store.transaction(() => {
      const current = this.store.catalog
        .prepare(`SELECT ${jobColumns} FROM jobs WHERE jobId=?`)
        .get(job.jobId) as JobRow | undefined;
      // The job may have been canceled, or retried under a new attempt after a restart declared this
      // one lost. Either way this answer is stale and must not overwrite what replaced it.
      if (!current || current.attemptId !== job.attemptId || current.state !== "running") return;
      // An answer that outlived its owner, or its owner's discard, is dropped rather than resurrecting it.
      if (!this.targets.isAvailable(job.target)) {
        this.discard(job.jobId, `${job.target.kind}_unavailable`);
        return;
      }
      if ("error" in outcome) {
        let error = outcome.error;
        if (error instanceof JobDependencyLost) {
          const row = this.store.catalog
            .prepare("SELECT deferred,readmitted FROM jobs WHERE jobId=?")
            .get(job.jobId) as { deferred: number; readmitted: number };
          if (row.deferred && !row.readmitted) {
            try {
              this.requeue(toJob(current), true);
              return;
            } catch (admission) {
              error = admission;
            }
          }
        }
        this.fail(job.jobId, error, job.attemptId);
        return;
      }
      this.publication(job);
      outcome.publish?.();
      this.store.catalog
        .prepare(
          `INSERT INTO artifacts(targetKind,targetId,revisionId,artifact,generation,input,attemptId,result,inputSha256)
           VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(targetKind,targetId,revisionId,artifact,inputSha256) DO UPDATE SET
           generation=excluded.generation,attemptId=excluded.attemptId,result=excluded.result`,
        )
        .run(
          ...targetValues(job.target),
          job.artifact,
          job.generation,
          job.input,
          job.attemptId,
          outcome.result,
          inputDigest(job.input),
        );
      writeOutputIssues(
        this.store,
        { outputKind: "artifact", outputId: job.attemptId, generation: job.generation },
        outcome.issues ?? [],
      );
      this.store.catalog
        .prepare(
          "UPDATE jobs SET state='ready',reason=NULL,errorCode=NULL,errorDetails=NULL,retryable=0 WHERE jobId=?",
        )
        .run(job.jobId);
      this.releaseFinishedInputs(job.jobId, job.attemptId);
    });
  }
}
