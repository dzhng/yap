import { ledgerVerdicts } from "../ledger-verdicts.mjs";

// The launcher must answer even when the app's files cannot be opened. Compile its emitted
// codes' verdicts from the authoritative ledger instead of carrying another runtime registry.
const codes = ledgerVerdicts(new URL("main.c", import.meta.url), /fail\("([A-Z_]+)"/g);
export const launcherVerdicts = `-DYAP_REFUSAL_LEDGER={${codes
  .map(({ code, entry }) => {
    return `{${JSON.stringify(code)},${Number(entry.retryable)},${entry.retryAfterMs ?? 0}}`;
  })
  .join(",")}}`;
