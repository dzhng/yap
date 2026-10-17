import { CompositionError } from "@yap/composition";
import { CatalogError } from "@yap/core/catalog";
import { PresetNotFoundError } from "@yap/core/presets";
import { operationError, type OperationFailure } from "@yap/protocol";

/** Owner refusals retain their public meaning; unexpected failures do not expose internal messages. */
export function operationFailure(error: unknown): OperationFailure {
  if (error instanceof PresetNotFoundError)
    return operationError(error.code, error.message, error.retryable, { id: error.id });
  if (error instanceof CatalogError)
    return operationError(error.code, error.message, error.retryable, error.details);
  if (error instanceof CompositionError)
    return operationError(error.code, error.message, false, error.details);
  return operationError("INTERNAL_ERROR", "Service handler failed");
}
