import { issuesSchema, type Issue } from "@yap/composition";
import { z } from "zod";

/**
 * The only asynchronous work vocabulary exposed at the protocol edge.
 *
 * Storage owners keep their own stored words and map them at the boundary.  The
 * vocabulary deliberately describes lifecycle, rather than the implementation
 * (queue, downloader, installer, or model verifier) that happens to own it.
 */
export const workStateSchema = z.enum([
  "idle",
  "queued",
  "running",
  "ready",
  "failed",
  "unavailable",
  "canceled",
]);
export type WorkState = z.infer<typeof workStateSchema>;

/** Domain facts are kept beside the lifecycle state instead of being collapsed into it. */
export const skillInstallationSchema = z.enum([
  "installed",
  "missing",
  "unmanaged",
  "disabled",
  "needs_attention",
]);
export const cliInstallationSchema = z.enum([
  "installed",
  "missing",
  "different",
  "unavailable",
  "needs_attention",
]);
export const modelPresenceSchema = z.enum(["absent", "ready", "invalid"]);

export const asyncWorkSchema = z.strictObject({
  state: workStateSchema,
  jobId: z.string().min(1).nullable(),
});

export const skillStatusSchema = asyncWorkSchema
  .extend({
    installation: skillInstallationSchema,
  })
  .passthrough();
export const cliStatusSchema = asyncWorkSchema
  .extend({
    installation: cliInstallationSchema,
    path: z.string(),
    onPath: z.boolean(),
  })
  .passthrough();
export const modelStatusSchema = asyncWorkSchema
  .extend({
    modelId: z.string().min(1),
    presence: modelPresenceSchema,
  })
  .passthrough();

export const jobStatusSchema = asyncWorkSchema
  .extend({
    attemptId: z.string().min(1),
    attemptGeneration: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    target: z.record(z.string(), z.unknown()),
    retryable: z.boolean(),
  })
  .passthrough();
export const artifactStatusSchema = asyncWorkSchema
  .extend({
    reason: z.string().nullable().optional(),
    retryable: z.boolean().optional(),
    published: z.unknown().nullable().optional(),
  })
  .passthrough();

/** Map one stored vocabulary at its protocol boundary. */
export function mapWorkState<Stored extends string>(
  state: string,
  mapping: Readonly<Record<Stored, WorkState>>,
): WorkState {
  if (!(state in mapping)) throw new Error(`Unknown stored work state: ${state}`);
  return mapping[state as Stored];
}

/** JobQueue's durable states are stored verbatim in catalog rows. */
export type JobStoredState =
  | "waiting"
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "unavailable"
  | "canceled";
export const jobWorkState = {
  waiting: "queued",
  queued: "queued",
  running: "running",
  ready: "ready",
  failed: "failed",
  unavailable: "unavailable",
  canceled: "canceled",
} as const satisfies Record<JobStoredState, WorkState>;

export type ArtifactStoredState =
  | "not_requested"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "unavailable";
export const artifactWorkState = {
  not_requested: "idle",
  queued: "queued",
  processing: "running",
  ready: "ready",
  failed: "failed",
  unavailable: "unavailable",
} as const satisfies Record<ArtifactStoredState, WorkState>;

export type ModelStoredState = "absent" | "preparing" | "ready" | "invalid" | "failed";
export const modelWorkState = {
  absent: "unavailable",
  preparing: "running",
  ready: "ready",
  invalid: "failed",
  failed: "failed",
} as const satisfies Record<ModelStoredState, WorkState>;

export type PackageStoredState =
  | "queued"
  | "opening"
  | "ready"
  | "closing"
  | "cleanup_failed"
  | "failed"
  | "canceled"
  | "closed";
/** A closed package admission holds nothing open and runs nothing. */
export const packageWorkState = {
  queued: "queued",
  opening: "running",
  ready: "ready",
  closing: "running",
  cleanup_failed: "failed",
  failed: "failed",
  canceled: "canceled",
  closed: "idle",
} as const satisfies Record<PackageStoredState, WorkState>;

/** An export's own word for a committed file; its job and recovery report the job vocabulary. */
export const exportWorkState = { committed: "ready" } as const satisfies Record<
  "committed",
  WorkState
>;

/** Evidence that waits for its sources to be read reports `not_ready`. */
export const evidenceWorkState = { not_ready: "queued" } as const satisfies Record<
  "not_ready",
  WorkState
>;

/** Every owner's stored words. Owners that share a word mean the same lifecycle by it. */
export const storedWorkState = {
  ...jobWorkState,
  ...artifactWorkState,
  ...modelWorkState,
  ...packageWorkState,
  ...exportWorkState,
  ...evidenceWorkState,
} as const;
export type StoredWorkState = keyof typeof storedWorkState;

const workMark = Symbol("storedWork");

/**
 * An owner marks the status record it returns as work in its stored vocabulary. The mark survives
 * object spread and never serializes; the service edge maps exactly the marked records.
 */
export function storedWork<T extends { state: StoredWorkState }>(record: T): T {
  Object.assign(record, { [workMark]: true });
  return record;
}

/** The WorkState of a record an owner marked, or undefined for every other record. */
export function markedWorkState(record: object): WorkState | undefined {
  return workMark in record
    ? mapWorkState(String(Reflect.get(record, "state")), storedWorkState)
    : undefined;
}

/**
 * Retained publication identity is separate from a replacement job's attempt. Every publication
 * carries the issues reported with it, empty when the output is clean.
 */
export function publishedOutputSchema<T extends z.ZodType>(output: T) {
  return z.object({
    generation: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    output,
    issues: issuesSchema,
  });
}

/** Expose one domain payload without leaking a queue recipe or serialized worker result. */
export function publishedOutput<
  Publication extends { generation: number | string; attemptId?: string; issues: Issue[] },
  Output,
>(publication: Publication | null, output: (publication: Publication) => Output) {
  return publication
    ? {
        generation: String(publication.generation),
        ...(publication.attemptId === undefined ? {} : { attemptId: publication.attemptId }),
        output: output(publication),
        issues: publication.issues,
      }
    : null;
}
