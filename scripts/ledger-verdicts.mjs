import { readFileSync } from "node:fs";
import ledger from "../packages/protocol/src/refusal-ledger.json" with { type: "json" };

/** Project retry metadata for the literal refusal codes emitted by one source file. */
export function ledgerVerdicts(file, pattern) {
  const source = readFileSync(file, "utf8");
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort().map((code) => {
    const entry = ledger.codes[code];
    if (!entry) throw new Error(`Unregistered refusal code ${code}`);
    return { code, entry };
  });
}
