import { expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { journalCapabilities } from "./evidence.js";

// Version interpretation is a format boundary. A new caller must ask its language's owner.
test("journal version literals stay in the two capability tables", () => {
  const root = new URL("../../../", import.meta.url);
  const swift = ["YapCapture", "YapWire"].flatMap((module) => {
    const directory = `helpers/mac/Sources/${module}/`;
    return readdirSync(new URL(directory, root))
      .filter((name) => name.endsWith(".swift"))
      .map((name) => directory + name);
  });
  const typescript = readdirSync(new URL("packages/core/src/", root))
    // Tests and their fixtures write journals of a named version; they never interpret one.
    .filter((name) => name.endsWith(".ts") && !/\.(test|fixture)\.ts$/.test(name))
    .map((name) => "packages/core/src/" + name);
  const violations: string[] = [];
  for (const path of [...swift, ...typescript]) {
    let source = readFileSync(new URL(path, root), "utf8");
    if (path.endsWith("CaptureJournal.swift"))
      source = source.replace(/public enum JournalSchema \{[\s\S]*?\n\}/, "");
    if (path.endsWith("/evidence.ts"))
      source = source.replace(/const journalSchemas = \{[\s\S]*?\n\}\n/, "");
    const literal =
      /\b(?:schemaVersion|schema|layout)\s*(?::\s*Int\??\s*)?(?:[=!<>]=*|:)\s*[1-9]\b|\[[1-9](?:,\s*[1-9])+\]\.(?:contains|includes)\([^\n]*(?:schema|layout)/;
    for (const [index, line] of source.split("\n").entries())
      if (literal.test(line)) violations.push(`${path}:${index + 1}: ${line.trim()}`);
  }
  expect(violations).toEqual([]);
});

test("historical sampling defaults and explicit sampling share one interpretation", () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    expect(journalCapabilities({ schemaVersion })?.cursorSampling).toEqual({
      intervalUs: 16_667,
      holds: false,
    });
    // Only schema 4 writes change-only samples; an older header cannot declare holds.
    expect(
      journalCapabilities({ schemaVersion, cursorSampling: { intervalUs: 20_000, holds: true } })
        ?.cursorSampling,
    ).toEqual({ intervalUs: 20_000, holds: schemaVersion === 4 });
  }
  for (const schemaVersion of [5, "4", null, 0, 1.5])
    expect(journalCapabilities({ schemaVersion })).toBeUndefined();
});
