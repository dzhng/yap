import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Native refusals carry only a code; the shared refusal ledger owns retryability.
const ledger = JSON.parse(
  readFileSync(new URL("../../../packages/protocol/src/refusal-ledger.json", import.meta.url), "utf8"),
);

/** The ledger's retryability for a native refusal, which must not state its own. */
export function retryable(error) {
  assert.equal("retryable" in error, false, "native must not state its own retryability");
  const entry = ledger.codes[error.code];
  assert.ok(entry, `refusal code ${error.code} is in the ledger`);
  return entry.retryable;
}
