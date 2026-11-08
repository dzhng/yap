import { omit } from "@yap/composition";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CatalogError } from "./catalog.js";
import { copyImportedFile, hashFile, type IdentifiedFile } from "./files.js";
import { sourceEvidenceRecords, type RecordRow, type SourceEvidenceReceipt } from "./evidence.js";
import type { MediaProbe } from "./assets.js";
import type { CapturePublishedSource, CaptureSourceAuthority } from "./capture-publication.js";

export type SourceExporter = (
  directory: string,
  output: string,
  signal: AbortSignal,
  canonical?: Partial<
    Record<"video" | "narration" | "system", IdentifiedFile & { metadata?: MediaProbe }>
  >,
  lifetimes?: readonly number[],
  sourceAuthority?: CaptureSourceAuthority,
) => Promise<SourceEvidenceReceipt & { verifiedSourceAuthority?: CapturePublishedSource }>;

const publicationNames = {
  narration: "narration.publication.json",
  system: "system.publication.json",
  video: "camera.publication.json",
} as const;
export const sourcePublicationMembers = [
  ...Object.values(publicationNames),
  "camera.mapping.jsonl",
] as const;

/** Publication dependencies have one inventory meaning across managed and portable acquisitions. */
export function sourcePublicationFiles(receipt: Pick<SourceEvidenceReceipt, "publications">) {
  const files: {
    name: (typeof sourcePublicationMembers)[number];
    identity: { bytes: string; sha256: string };
  }[] = [];
  for (const role of ["video", "narration", "system"] as const) {
    const proof = receipt.publications?.[role];
    if (proof) files.push({ name: publicationNames[role], identity: proof.receipt });
  }
  if (receipt.publications?.video)
    files.push({ name: "camera.mapping.jsonl", identity: receipt.publications.video.mapping });
  return files;
}
export type SourceAdmissionFiles = {
  journal: IdentifiedFile & { sha256: string };
  normalized: { bytes: number; sha256: string };
} & Partial<Record<(typeof sourcePublicationMembers)[number], IdentifiedFile & { sha256: string }>>;

/** Native proof precedes both transient package availability and durable source adoption.
 * The caller's existing workspace owns crash recovery; no canonical media is copied here.
 * Audio callbacks are provisional until this function returns successfully. */
export async function verifySourceEvidence(input: {
  directory: string;
  receipt: Omit<SourceEvidenceReceipt, "file">;
  files: SourceAdmissionFiles;
  canonical: NonNullable<Parameters<SourceExporter>[3]>;
  exportSource: SourceExporter;
  signal: AbortSignal;
  lifetime?: { readonly fd: number };
  audio(row: RecordRow): void;
}): Promise<void> {
  const { receipt: expected, files, canonical, signal } = input;
  signal.throwIfAborted();
  const directory = join(input.directory, `verify-${randomUUID()}`);
  const sourceDirectory = join(directory, "source");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const output = join(directory, "source.jsonl");
  try {
    for (const [name, file] of [
      ["capture.journal.jsonl", files.journal],
      ...sourcePublicationFiles(expected).map(({ name, identity }) => {
        const file = files[name];
        if (!file || file.bytes !== Number(identity.bytes) || file.sha256 !== identity.sha256)
          throw new CatalogError("INVALID_PACKAGE", "Publication proof differs from inventory");
        return [name, file] as const;
      }),
    ] as const) {
      await copyImportedFile(file.path, join(sourceDirectory, name), signal, file);
    }
    const derived = await input
      .exportSource(
        sourceDirectory,
        output,
        signal,
        canonical,
        input.lifetime ? [input.lifetime.fd] : undefined,
      )
      .catch((error: unknown) => {
        // These refusals validate the supplied journal/media, before normalized output exists.
        if (
          error instanceof CatalogError &&
          [
            "INVALID_JOURNAL",
            "INVALID_JOURNAL_PREFIX",
            "INVALID_MEDIA",
            "PACKED_MEDIA_INVALID",
            "INVALID_CAMERA_MAPPING",
            "INVALID_AUDIO_TIMING",
          ].includes(error.code)
        )
          throw new CatalogError("INVALID_INPUT_EVIDENCE", error.message, {
            ...error.details,
            cause: error.code,
          });
        throw error;
      });
    const receipt = omit(derived, "file");
    // Historical receipts predate message disclosure. Reproduce that declared format
    // without weakening publication proofs, normalized bytes, or current-format equality.
    if (expected.normalizationVersion === undefined && receipt.normalizationVersion === 2) {
      delete receipt.normalizationVersion;
      if (receipt.completion) receipt.completion = omit(receipt.completion, "failureMessage");
    }
    const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const digest = await hashFile(handle, derived.bytes, signal);
      if (
        digest.sha256 !== files.normalized.sha256 ||
        derived.bytes !== files.normalized.bytes ||
        !isDeepStrictEqual(receipt, expected)
      )
        throw new CatalogError(
          "INVALID_PACKAGE",
          "Canonical verification differs from retained evidence",
        );
    } finally {
      await handle.close();
    }
    for await (const row of sourceEvidenceRecords(output, derived, signal)) {
      signal.throwIfAborted();
      if (row.event === "audioAcquired") input.audio(row);
    }
    signal.throwIfAborted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
