import { readFileSync } from "node:fs";
import ledger from "../../packages/protocol/src/refusal-ledger.json" with { type: "json" };

// The launcher must answer even when the app's files cannot be opened. Compile its emitted
// codes' verdicts from the authoritative ledger instead of carrying another runtime registry.
const source = readFileSync(new URL("main.c", import.meta.url), "utf8");
const codes = [...new Set([...source.matchAll(/fail\("([A-Z_]+)"/g)].map((match) => match[1]))];
export const launcherVerdicts = `-DYAP_REFUSAL_LEDGER={${codes
  .map((code) => {
    const entry = ledger.codes[code];
    if (!entry) throw new Error(`Unregistered launcher code ${code}`);
    return `{${JSON.stringify(code)},${Number(entry.retryable)},${entry.retryAfterMs ?? 0}}`;
  })
  .join(",")}}`;
