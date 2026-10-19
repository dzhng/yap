// One naming rule for every public record: identities are `<noun>Id`, quantities end in their unit.
// The operation-schema lint applies it to every schema; service tests apply it to every response.

const units = ["Us", "Ms", "Bytes", "Hz", "Px", "Frames", "Samples", "Count", "Db", "Lufs"];
const bareUnits = new Set(units.map((unit) => unit.toLowerCase()));
const nonCanonicalUnits = ["Seconds", "Milliseconds", "Micros", "Sec"];
const quantityWords = new Set([
  "age",
  "at",
  "deadline",
  "delay",
  "duration",
  "elapsed",
  "end",
  "eta",
  "expires",
  "gap",
  "inference",
  "interval",
  "latency",
  "length",
  "offset",
  "position",
  "size",
  "start",
  "time",
  "timeout",
]);
const lastWord = (key: string) => key.match(/[A-Z]?[a-z0-9]+$/)?.[0] ?? key;

/** Why `key` breaks the naming rule, or null. `numeric` says whether its value is a number. */
export function keyViolation(key: string, numeric: boolean): string | null {
  if (key === "id" || key === "ids") return "identity without a noun";
  if (!numeric) return null;
  if (bareUnits.has(key)) return "unit without a noun";
  if (nonCanonicalUnits.some((unit) => key.endsWith(unit))) return "non-canonical unit";
  if (quantityWords.has(lastWord(key).toLowerCase()) && !units.some((unit) => key.endsWith(unit)))
    return "quantity without a unit";
  return null;
}

/**
 * Paths this rule doesn't own, each with its owner. The edit document and export settings
 * belong to the composition format; their names change with that format, not here.
 */
export const namingExemptions: readonly { path: RegExp; owner: string }[] = [
  { path: /\.document\./, owner: "composition edit document" },
  { path: /\.operations\[\]\./, owner: "composition edit operations" },
  { path: /\.settings\.video\./, owner: "composition export settings" },
  { path: /\.cues\[\]\.style\./, owner: "composition caption style" },
];

/** Every naming violation in a response value, as `path: reason`, unique and sorted. */
export function valueNamingViolations(value: unknown, path: string): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, `${at}[]`);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const here = `${at}.${key}`;
      if (namingExemptions.some(({ path }) => path.test(`${here}.`))) continue;
      const reason = keyViolation(key, typeof child === "number");
      if (reason) found.add(`${here}: ${reason}`);
      walk(child, here);
    }
  };
  walk(value, path);
  return [...found].sort();
}
