import { refusalRetryable } from "./refusal-ledger.js";
import { z } from "zod";
import { RESPONSE_FRAME_BYTES } from "./framing.js";
import { operationSchema } from "./operations.js";
export { pageParams, pageResult, hasPageParams } from "./paging.js";

export const requestSchema = z
  .object({
    id: z.string().min(1),
    operation: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

export type OperationRequest = z.infer<typeof requestSchema>;

export function parseRequest(value: unknown): OperationRequest {
  return requestSchema.parse(value);
}

export const wireRequestSchema = requestSchema.extend({
  resultDelivery: z
    .strictObject({ inlineBytes: z.int().min(1).max(RESPONSE_FRAME_BYTES) })
    .optional(),
});
export type OperationWireRequest = z.infer<typeof wireRequestSchema>;

export const operationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
});
export const waitJobSchema = z.object({
  jobId: z.string().min(1),
  generation: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  attemptId: z.string().min(1),
});
/** Adapter deadline outcome; it does not change the service's work or publication state. */
export const waitMetadataSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("settled"),
    timeoutMs: z.int().positive().max(2_147_483_647),
    job: waitJobSchema.optional(),
  }),
  z.object({
    state: z.literal("timed_out"),
    timeoutMs: z.int().positive().max(2_147_483_647),
    job: waitJobSchema.optional(),
  }),
  z.object({
    state: z.literal("interrupted"),
    timeoutMs: z.int().positive().max(2_147_483_647),
    job: waitJobSchema.optional(),
    error: operationErrorSchema,
  }),
]);
export type WaitMetadata = z.infer<typeof waitMetadataSchema>;
const successSchema = z.object({ ok: z.literal(true), data: z.unknown() });
const failureSchema = z.object({ ok: z.literal(false), error: operationErrorSchema });
export const resultSchema = z.discriminatedUnion("ok", [successSchema, failureSchema]);
export const responseSchema = z.discriminatedUnion("ok", [
  successSchema.extend({ id: requestSchema.shape.id, wait: waitMetadataSchema.optional() }),
  failureSchema.extend({ id: requestSchema.shape.id, wait: waitMetadataSchema.optional() }),
]);
export type OperationResult = z.infer<typeof resultSchema>;
export type OperationResponse = z.infer<typeof responseSchema>;
export const deliveredResponseSchema = z.object({
  id: requestSchema.shape.id,
  ok: z.boolean(),
  resultDelivery: z.object({
    token: z.string().min(1),
    bytes: z
      .int()
      .positive()
      .max(RESPONSE_FRAME_BYTES - 1),
    expiresAt: z.int(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.literal("application/json"),
  }),
});
export const wireResponseSchema = z.union([responseSchema, deliveredResponseSchema]);
export type OperationWireResponse = z.infer<typeof wireResponseSchema>;
export type OperationFailure = Extract<OperationResult, { ok: false }>;

/** The one shape every peer refuses an operation with. */
export function operationError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): OperationFailure {
  return { ok: false, error: { code, message, retryable: refusalRetryable(code), details } };
}

/**
 * Schema admission shared by every peer. A rejection names its first 20 rejected fields (and how
 * many more there were), so a caller can fix the request without re-reading the whole schema.
 */
export function admitOperation(
  request: unknown,
): { ok: true; data: z.infer<typeof operationSchema> } | OperationFailure {
  const parsed = operationSchema.safeParse(request);
  if (parsed.success) return { ok: true, data: parsed.data };
  return operationError("INVALID_PARAMS", "Parameters do not match the operation schema", {
    invalid: parsed.error.issues
      .slice(0, 20)
      .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    ...(parsed.error.issues.length > 20 ? { omitted: parsed.error.issues.length - 20 } : {}),
  });
}

// The app's inherited pipe carries many frames from one trusted peer, so an
// unparsable request has no trustworthy correlation ID and answers with a null one
// instead of closing the channel the way a single-request socket does.
export const controlResponseSchema = z.discriminatedUnion("ok", [
  successSchema.extend({ id: requestSchema.shape.id }),
  failureSchema.extend({ id: requestSchema.shape.id.nullable() }),
]);
export const controlMessageSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("started"),
      pid: z.int().positive(),
      socketPath: z.string().min(1),
    })
    .strict(),
  z.object({ event: z.literal("failed"), error: operationErrorSchema }).strict(),
  z.object({ event: z.literal("result"), response: controlResponseSchema }).strict(),
  z.object({ event: z.literal("call"), request: requestSchema }).strict(),
  z.object({ event: z.literal("update.progress") }).strict(),
]);

// The same channel the other way round. Both peers issue calls and both answer them, so each
// direction carries one labelled message kind rather than a shape the reader has to guess at.
export const appMessageSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("request"), request: requestSchema }).strict(),
  z.object({ event: z.literal("result"), response: controlResponseSchema }).strict(),
]);
export type ControlResponse = z.infer<typeof controlResponseSchema>;
export type ControlMessage = z.infer<typeof controlMessageSchema>;

// The CLI combines and counts issue lists from several reads by the same rules as the service.
export { boundedIssues, issueCount, type Issue } from "@yap/composition";
export * from "./capture.js";
export * from "./framing.js";
export * from "./layout.js";
export * from "./refusal-ledger.js";
export * from "./operations.js";
export * from "./tools.js";
export * from "./update.js";
export * from "./work.js";

export * from "./picture.js";
export * from "./faces.js";
export * from "./correspondence.js";
export * from "./in-use.js";
