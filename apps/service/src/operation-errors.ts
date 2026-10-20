import { CompositionError } from "@yap/composition";
import { CatalogError } from "@yap/core/catalog";
import {
  operationError,
  operationSchema,
  readOnlyOperations,
  type OperationFailure,
  type OperationRequest,
  type OperationResult,
} from "@yap/protocol";

/** Owner refusals retain their public meaning; unexpected failures do not expose internal messages. */
export function operationFailure(error: unknown): OperationFailure {
  if (error instanceof CatalogError)
    return operationError(error.code, error.message, error.details);
  if (error instanceof CompositionError)
    return operationError(error.code, error.message, error.details);
  return operationError("INTERNAL_ERROR", "Service handler failed");
}

/** An identical refused request is a resolving call only when it is valid and safe to resend. */
export function refusedRequest(
  result: OperationResult,
  request: OperationRequest,
): OperationResult {
  if (result.ok) return result;
  const parsed = operationSchema.safeParse({
    operation: request.operation,
    params: request.params,
  });
  const retry =
    result.error.retryable &&
    parsed.success &&
    (readOnlyOperations.has(parsed.data.operation) ||
      ("requestId" in parsed.data.params && typeof parsed.data.params.requestId === "string"))
      ? { operation: request.operation, params: request.params }
      : undefined;
  return operationError(result.error.code, result.error.message, {
    ...result.error.details,
    ...(result.error.details.retry === undefined && retry ? { retry } : {}),
  });
}
