import { omit } from "@yap/composition";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CatalogError } from "./catalog.js";
import { fileIdentity } from "./files.js";
import { verifySourceEvidence } from "./source-admission.js";
import type { SourceEvidenceReceipt } from "./evidence.js";

test("portable source admission preserves historical receipts and separates caller content from generated failures", async () => {
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
    let nativeFailure: string | undefined;
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
          if (nativeFailure) throw new CatalogError(nativeFailure, "Native verification refused");
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
    nativeFailure = "INVALID_JOURNAL";
    await expect(verify(receipt)).rejects.toMatchObject({
      code: "INVALID_INPUT_EVIDENCE",
      retryable: false,
    });
    nativeFailure = "INVALID_EVIDENCE";
    await expect(verify(receipt)).rejects.toMatchObject({
      code: "INVALID_EVIDENCE",
      retryable: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
