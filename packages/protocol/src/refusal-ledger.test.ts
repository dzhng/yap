import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { issueCodes } from "@yap/composition";
import { describe, expect, it } from "vitest";

// Output by default: a refusal is legitimate only for malformed or ambiguous input, conflicts,
// resource bounds, missing prerequisites, destructive actions or execution failures. Every code
// literal in product source is classified here so a new quality gate cannot appear unnoticed.
// UPDATE_REFUSAL_LEDGER=1 refreshes per-file counts; new codes still need a category by hand.

const root = join(import.meta.dirname, "../../..");
const ledgerPath = join(import.meta.dirname, "refusal-ledger.json");
const sourceRoots = [
  ...["packages", "apps"].flatMap((parent) =>
    readdirSync(join(root, parent))
      .map((name) => join(parent, name, "src"))
      .filter((dir) => exists(dir)),
  ),
  "helpers/mac/Sources",
  "apps/macos/Sources",
  "skills/yap/scripts",
];
const refusalCategories = new Set([
  "malformed",
  "ambiguous",
  "conflict",
  "resource-bound",
  "missing-prerequisite",
  "destructive",
  "execution-failure",
]);
const categories = new Set([...refusalCategories, "issue-code", "not-a-refusal"]);
const gateWords = /UNMET|FEASIBLE|DISAGREEMENT|TOLERANCE|THRESHOLD|QUALITY/;

type Ledger = {
  rules: string;
  refusedStatus: Record<string, string>;
  codes: Record<
    string,
    {
      category: string | null;
      retryable: boolean;
      retryAfterMs?: number;
      cause?: string;
      reason?: string;
      files: Record<string, number>;
    }
  >;
};

function exists(dir: string) {
  try {
    return statSync(join(root, dir)).isDirectory();
  } catch {
    return false;
  }
}

function productFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|swift|mjs)$/.test(name) && !/\.(test|fixture)\./.test(name))
        out.push(relative(root, path));
    }
  };
  for (const dir of sourceRoots) walk(join(root, dir));
  return out.sort();
}

/** Test sources beside product source, the repo's script tests and the native helper tests. */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "node_modules" || name === "dist") continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.test\.(ts|mjs)$/.test(name) ||
        (dir.includes("/Tests") && name.endsWith(".swift"))
      )
        out.push(relative(root, path));
    }
  };
  for (const dir of [...sourceRoots, "scripts", "helpers/mac/Tests"]) walk(join(root, dir));
  return out.filter((file) => file !== relative(root, import.meta.filename));
}

const files = productFiles();
const text = new Map(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));

function scan() {
  const codes = new Map<string, Record<string, number>>();
  for (const [file, source] of text) {
    const found = [
      ...[...source.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g)].map((match) => match[1]!),
      // A single-word code carries no underscore, so it is recognised only where a refusal is built.
      ...[...source.matchAll(/(?:Error|operationError|NativeFailure)\(\s*"([A-Z][A-Z0-9]+)"/g)].map(
        (match) => match[1]!,
      ),
    ];
    for (const code of found) {
      const perFile = codes.get(code) ?? {};
      perFile[file] = (perFile[file] ?? 0) + 1;
      codes.set(code, perFile);
    }
  }
  return codes;
}

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
const scanned = scan();

if (process.env.UPDATE_REFUSAL_LEDGER === "1") {
  const codes: Ledger["codes"] = {};
  // Reserved codes may be registered before their producers ship.
  for (const code of [...new Set([...scanned.keys(), ...Object.keys(ledger.codes)])].sort()) {
    codes[code] = {
      ...ledger.codes[code],
      category: ledger.codes[code]?.category ?? null,
      retryable: ledger.codes[code]?.retryable ?? false,
      files: Object.fromEntries(Object.entries(scanned.get(code) ?? {}).sort()),
    };
  }
  writeFileSync(ledgerPath, `${JSON.stringify({ ...ledger, codes }, null, 2)}\n`);
  Object.assign(ledger, { codes });
}

describe("refusal ledger", () => {
  it("explains verdict exceptions and supplies causes and retryable wait delays", () => {
    const usual: Record<string, boolean> = {
      malformed: false,
      ambiguous: false,
      conflict: false,
      "resource-bound": true,
      "missing-prerequisite": true,
      destructive: false,
      "execution-failure": true,
      "issue-code": true,
      "not-a-refusal": false,
    };
    for (const [code, entry] of Object.entries(ledger.codes)) {
      // LUT format tokens retain their historical issue-code classification.
      if (entry.category !== "not-a-refusal" && !["DOMAIN_MIN", "DOMAIN_MAX"].includes(code))
        expect(entry.cause, code).toBeTruthy();
      if (entry.retryable !== usual[entry.category!]) expect(entry.reason, code).toBeTruthy();
      if (entry.retryAfterMs !== undefined) {
        expect(entry.retryable, code).toBe(true);
        expect(entry.retryAfterMs, code).toBeGreaterThan(0);
      }
    }
    expect(ledger.codes.INVALID_EVIDENCE?.retryable).toBe(true);
    expect(ledger.codes.JOB_INTERRUPTED?.retryable).toBe(true);
    expect(ledger.codes.NOT_READY?.retryAfterMs).toBe(15000);
  });
  it("constructs refusal envelopes only through operationError", () => {
    const offenders: string[] = [];
    for (const [file, source] of text) {
      if (
        file.endsWith(".swift") &&
        /ServiceFailure\([^)]*\bretryable:\s*(?:true|false)\b/s.test(source)
      )
        offenders.push(file);
      if (!/\.(ts|mjs)$/.test(file)) continue;
      // Work-state projections have retry bits too; this guard concerns code/message refusals.
      for (const match of source.matchAll(
        /\{[^{}]*\bcode\s*[:,][^{}]*\bmessage\s*[:,][^{}]*\bretryable\s*:\s*(?:true|false)\b/g,
      )) {
        if (/\bstate\s*:/.test(match[0])) continue;
        if (
          file === "packages/protocol/src/index.ts" &&
          match.index! > source.indexOf("export function operationError(") &&
          match.index! < source.indexOf("export function admitOperation(")
        )
          continue;
        offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("classifies every code literal in product source with exact per-file counts", () => {
    const actual = Object.fromEntries(
      [...scanned].map(([code, perFile]) => [
        code,
        Object.fromEntries(Object.entries(perFile).sort()),
      ]),
    );
    const recorded = Object.fromEntries(
      Object.entries(ledger.codes)
        .filter(([, entry]) => Object.keys(entry.files).length > 0)
        .map(([code, entry]) => [code, entry.files]),
    );
    expect(actual).toEqual(recorded);
    const unclassified = Object.entries(ledger.codes).filter(
      ([, entry]) => !entry.category || !categories.has(entry.category),
    );
    expect(unclassified.map(([code]) => code)).toEqual([]);
  });

  it("declares one retryability for every code", () => {
    const missing = Object.entries(ledger.codes)
      .filter(([, entry]) => typeof entry.retryable !== "boolean")
      .map(([code]) => code);
    expect(missing).toEqual([]);
  });

  it("registers every Swift NativeFailure code", () => {
    const nativeCodes = new Set<string>();
    for (const file of files.filter((file) => file.startsWith("helpers/mac/Sources/"))) {
      const source = text.get(file)!;
      for (const [, code] of source.matchAll(
        /NativeFailure(?:\.decodeFailed)?\s*\(\s*"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g,
      ))
        nativeCodes.add(code!);
    }
    expect([...nativeCodes].filter((code) => !(code in ledger.codes))).toEqual([]);
  });

  it("registers every Swift app failure code with a plain cause", () => {
    for (const file of files.filter((file) => file.startsWith("apps/macos/Sources/"))) {
      for (const [, code] of text.get(file)!.matchAll(/ServiceFailure\(\s*code:\s*"([A-Z_]+)"/g)) {
        expect(ledger.codes[code!]?.cause, `${file}: ${code}`).toBeTruthy();
      }
    }
  });

  it("never names a quality gate as a refusal", () => {
    const gates = Object.entries(ledger.codes)
      .filter(([code]) => gateWords.test(code))
      .map(([code]) => code);
    expect(gates).toEqual([]);
  });

  it("hides no code inside a message", () => {
    const embedded = new Set<string>();
    for (const source of text.values()) {
      for (const [, code] of source.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+): /g))
        embedded.add(code!);
    }
    expect([...embedded]).toEqual([]);
  });

  it("produces every registered issue code in product source and asserts it in a test", () => {
    // Registration in the registry is not production: strip each `issue("code", …)` call first.
    const registry = "packages/composition/src/issues.ts";
    const produced = [...text]
      .map(([file, source]) =>
        file === registry ? source.replaceAll(/\bissue\(\s*"[a-z0-9-]+"/g, "") : source,
      )
      .join("\n");
    const asserted = testFiles()
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    const quoted = (code: string) => new RegExp(`["'\`]${code}["'\`]`);
    expect(issueCodes.filter((code) => !quoted(code).test(produced))).toEqual([]);
    expect(issueCodes.filter((code) => !quoted(code).test(asserted))).toEqual([]);
    expect(issueCodes.filter((code) => code in ledger.codes)).toEqual([]);
  });

  it("uses a refused status only for caller-authored verdicts", () => {
    const users = [...text]
      .filter(([, source]) => source.includes('"refused"'))
      .map(([file]) => file);
    expect(users.sort()).toEqual(Object.keys(ledger.refusedStatus).sort());
  });
});
