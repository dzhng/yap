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

export type SkillStoredState =
  | "installed"
  | "missing"
  | "unmanaged"
  | "disabled"
  | "needs_attention"
  | "updating";
export const skillWorkState = {
  installed: "ready",
  missing: "unavailable",
  unmanaged: "unavailable",
  disabled: "unavailable",
  needs_attention: "failed",
  updating: "running",
} as const satisfies Record<SkillStoredState, WorkState>;

export type CliStoredState =
  | "installed"
  | "missing"
  | "different"
  | "unavailable"
  | "needs_attention";
export const cliWorkState = {
  installed: "ready",
  missing: "unavailable",
  different: "unavailable",
  unavailable: "unavailable",
  needs_attention: "failed",
} as const satisfies Record<CliStoredState, WorkState>;

export type UpdateStoredState =
  | "unavailable"
  | "disabled"
  | "idle"
  | "checking"
  | "downloading"
  | "waiting"
  | "installing"
  | "failed";
export const updateWorkState = {
  unavailable: "unavailable",
  disabled: "unavailable",
  idle: "idle",
  checking: "running",
  downloading: "running",
  waiting: "queued",
  installing: "running",
  failed: "failed",
} as const satisfies Record<UpdateStoredState, WorkState>;

export const edgeWorkState = {
  ...jobWorkState,
  ...artifactWorkState,
  ...modelWorkState,
  ...skillWorkState,
  ...cliWorkState,
  ...updateWorkState,
} as const;

export const transientWorkState = {
  not_ready: "queued",
  opening: "running",
  closing: "running",
  cleanup_pending: "running",
  pending: "queued",
} as const satisfies Record<
  "not_ready" | "opening" | "closing" | "cleanup_pending" | "pending",
  WorkState
>;

export const publicationWorkState = {
  complete: "ready",
  completed: "ready",
  committed: "ready",
} as const satisfies Record<"complete" | "completed" | "committed", WorkState>;

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
