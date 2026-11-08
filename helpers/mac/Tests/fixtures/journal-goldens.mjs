import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const goldens = new URL("./journal-goldens/", import.meta.url);
export const journalGoldenCases = [
  ["schema3-marks", "fixtures/journal/schema3-marks.jsonl"],
  ["launch-capture", "fixtures/launch-video/session/recording/source/capture.journal.jsonl"],
  ["launch-source", "fixtures/launch-video/session/recording/source/source.journal.jsonl"],
  ["narrated-workbench", "fixtures/narrated-workbench/capture.journal.jsonl"],
].map(([name, path]) => ({
  name,
  journal: new URL(`../../../../${path}`, import.meta.url),
  goldens,
}));

export function exportJournalGolden(executable, entry, root) {
  const directory = join(root, "source");
  mkdirSync(directory);
  copyFileSync(entry.journal, join(directory, "capture.journal.jsonl"));
  const output = join(root, "normalized.jsonl");
  const result = spawnSync(executable, [], {
    input:
      JSON.stringify({
        id: "golden",
        operation: "media.sourceEvidence",
        params: { directory, output },
      }) + "\n",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, result.stdout);
  const { file, ...receipt } = response.data;
  assert.equal(file, output);
  return { bytes: readFileSync(output), receipt };
}
