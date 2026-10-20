import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, test } from "vitest";

// Format interpretation belongs to CaptureJournal; runtime aggregate limits do not.
test("capture and evidence source has no retired aggregate or normalized-line literals", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const failures: string[] = [];
  const scan = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) scan(file);
      else if (/\.(ts|swift)$/.test(file) && !file.endsWith(".test.ts")) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (
              /268_?435_?456/.test(line) ||
              (/1_?048_?576/.test(line) &&
                !(
                  file.endsWith("/CaptureJournal.swift") && line.includes("historicalRecordBytes")
                )) ||
              (/65536/.test(line) && /line|record/i.test(line))
            )
              failures.push(`${file.slice(root.length + 1)}:${index + 1}: ${line.trim()}`);
          });
      }
    }
  };
  for (const folder of [
    "helpers/mac/Sources/YapCapture",
    "helpers/mac/Sources/YapWire",
    "helpers/mac/Sources/YapSpeech",
    "packages/core/src",
    "apps/service/src",
  ])
    scan(join(root, folder));
  expect(failures).toEqual([]);
});
