import { omit } from "@yap/composition";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileIdentity } from "./files.js";
import { verifySourceEvidence } from "./source-admission.js";
import type { SourceEvidenceReceipt } from "./evidence.js";

test.runIf(Boolean(process.env.YAP_NATIVE))(
  "package source admission reproduces pre-change schema-3 bytes and receipt through native export",
  async () => {
    const directory = await mkdtemp("/tmp/source-golden-admission-");
    try {
      const journal = fileURLToPath(
        new URL("../../../fixtures/journal/schema3-marks.jsonl", import.meta.url),
      );
      const golden = new URL(
        "../../../helpers/mac/Tests/fixtures/journal-goldens/",
        import.meta.url,
      );
      const receipt = JSON.parse(
        await readFile(new URL("schema3-marks.receipt.json", golden), "utf8"),
      );
      const normalized = gunzipSync(await readFile(new URL("schema3-marks.jsonl.gz", golden)));
      const original = await readFile(journal);
      const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
      const stat = await lstat(journal, { bigint: true });
      const native = process.env.YAP_NATIVE!;
      const verify = (sha256: string) =>
        verifySourceEvidence({
          directory,
          receipt,
          signal: new AbortController().signal,
          canonical: {},
          files: {
            journal: {
              path: journal,
              bytes: original.length,
              sha256: hash(original),
              identity: fileIdentity(stat),
            },
            normalized: { bytes: normalized.length, sha256 },
          },
          exportSource: async (source, output) => {
            const result = spawnSync(native, [], {
              input:
                JSON.stringify({
                  id: "admission",
                  operation: "media.sourceEvidence",
                  params: { directory: source, output },
                }) + "\n",
              encoding: "utf8",
              timeout: 30_000,
            });
            expect(result.status, result.stderr).toBe(0);
            const response = JSON.parse(result.stdout);
            expect(response.ok, result.stdout).toBe(true);
            return response.data;
          },
          audio: () => {
            throw new Error("No audio in fixture");
          },
        });
      await verify(hash(normalized));
      await expect(verify("0".repeat(64))).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
      expect(await readFile(journal)).toEqual(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("canonical admission preserves historical receipt format but verifies current diagnostic text", async () => {
  const directory = await mkdtemp("/tmp/source-diagnostic-");
  try {
    const journal = join(directory, "capture.journal.jsonl");
    const body = "immutable journal fixture";
    await writeFile(journal, body);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const current: SourceEvidenceReceipt = {
      normalizationVersion: 2,
      file: "unused",
      journal: "capture.journal.jsonl",
      header: { sessionID: "source" },
      cursorSamples: 0,
      geometryRecords: 0,
      displaySpaces: 0,
      pauseEvents: 0,
      audioIntervals: 0,
      lastSequence: 2,
      incompleteTail: false,
      finished: true,
      bytes: 0,
      completion: {
        sequence: 2,
        state: "interrupted",
        durationUs: 0,
        failureCode: "DEVICE_LOST",
        failureMessage: "The microphone disconnected.",
      },
    };
    const receipt = omit(current, "file");
    const verify = (expected: typeof receipt) =>
      verifySourceEvidence({
        directory,
        receipt: expected,
        signal: new AbortController().signal,
        canonical: {},
        files: {
          journal: {
            path: journal,
            bytes: Buffer.byteLength(body),
            sha256: digest(body),
            identity: fileIdentity(stat),
          },
          normalized: { bytes: 0, sha256: digest("") },
        },
        exportSource: async (_source, output) => {
          await writeFile(output, "");
          return { ...current, file: output };
        },
        audio: () => {
          throw new Error("No audio in fixture");
        },
      });
    const stat = await lstat(journal, { bigint: true });
    await verify(receipt);
    const historical = omit(receipt, "normalizationVersion");
    const completion = omit(current.completion!, "failureMessage");
    await verify({ ...historical, completion });
    await expect(
      verify({ ...receipt, completion: { ...current.completion!, failureMessage: "Altered" } }),
    ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
    await expect(
      verify({ ...historical, completion: { ...completion, failureCode: "ALTERED" } }),
    ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
