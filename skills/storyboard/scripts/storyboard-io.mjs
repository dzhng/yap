import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const failure = (code, message, details) =>
  Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

/** Microseconds from an integer or an exact { numerator, denominator } fraction, as Yap returns them. */
export function us(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && value.denominator)
    return value.numerator / value.denominator;
  throw failure("INVALID_REQUEST", `Expected microseconds, got ${JSON.stringify(value)}`);
}

/** A request field may carry the JSON itself or the path of a saved JSON file. */
export async function load(value, name) {
  if (value === undefined || value === null) throw failure("INVALID_REQUEST", `Supply ${name}`);
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(await readFile(value, "utf8"));
  } catch (error) {
    throw failure("INVALID_REQUEST", `Cannot read ${name} from ${value}: ${error.message}`);
  }
}

/** Whether this process was launched as the named helper file (not imported by another program). */
export function launchedAs(moduleUrl, name) {
  if (!process.argv[1]) return false;
  try {
    const launched = realpathSync(process.argv[1]);
    return basename(launched) === name && launched === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** Read one JSON request on stdin, print the helper's JSON result; errors go to stderr, exit 1. */
export async function runJsonHelper(helper, usage) {
  if (process.argv.includes("--help")) {
    console.log(usage);
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    console.log(JSON.stringify(await helper(request), null, 1));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: error.code ?? "INVALID_REQUEST",
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      }),
    );
    process.exitCode = 1;
  }
}
