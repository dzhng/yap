import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Bundle.main uses the executable directory as its resource root for unbundled checks. */
export function stageServiceLedger(resources) {
  mkdirSync(join(resources, "service"), { recursive: true });
  copyFileSync(
    new URL("../../../../packages/protocol/src/refusal-ledger.json", import.meta.url),
    join(resources, "service/refusal-ledger.json"),
  );
}
