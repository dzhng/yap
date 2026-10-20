import ledger from "./refusal-ledger.json" with { type: "json" };

type LedgerEntry = { retryable: boolean; retryAfterMs?: number; cause?: string };

const entries = ledger.codes as Record<string, LedgerEntry>;

/** Retryability belongs to the refusal ledger, so every adapter gets one answer per code. */
export function refusalRetryable(code: string): boolean {
  return entries[code]?.retryable ?? false;
}

export function refusalRetryAfterMs(code: string): number | undefined {
  return entries[code]?.retryAfterMs;
}

export function refusalCause(code: string): string | undefined {
  return entries[code]?.cause;
}
