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

/** A job's own record; work that a job runs refers to it by `jobId` instead. */
export const jobStatusSchema = z
  .object({
    id: z.string().min(1),
    state: workStateSchema,
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

/**
 * Every owner's stored word for its work, and the WorkState it reports. Owners keep their own
 * words inside; the service edge maps the `state` of every record that also carries a `jobId`.
 */
export const storedWorkState = {
  idle: "idle",
  not_requested: "idle",
  // A closed package admission holds nothing open and runs nothing.
  closed: "idle",
  waiting: "queued",
  queued: "queued",
  // Evidence that waits for its sources to be read.
  not_ready: "queued",
  running: "running",
  processing: "running",
  preparing: "running",
  opening: "running",
  closing: "running",
  ready: "ready",
  // An export's committed file.
  committed: "ready",
  failed: "failed",
  invalid: "failed",
  cleanup_failed: "failed",
  unavailable: "unavailable",
  absent: "unavailable",
  canceled: "canceled",
} as const satisfies Record<string, WorkState>;
export type StoredWorkState = keyof typeof storedWorkState;

/** The WorkState an owner's stored word reports. */
export function workState(stored: string): WorkState {
  if (!Object.hasOwn(storedWorkState, stored))
    throw new Error(`Unknown stored work state: ${stored}`);
  return storedWorkState[stored as StoredWorkState];
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
