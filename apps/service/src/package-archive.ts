import { readSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonDescriptor } from "@yap/core/json-stream";
import { publicationDeadlineMs } from "./publication.js";
import type { FileHandle } from "node:fs/promises";
import { omit } from "@yap/composition";
import { CatalogError } from "@yap/core/catalog";
import {
  archiveLimits,
  validateArchiveLimits,
  verifyArchiveReceipt,
  type ArchiveLimits,
  type ArchiveManifest,
  type ArchiveManifestValidator,
} from "@yap/core/package-archive";
import { IdentifiedFiles, fileSubdirectory, type FileAccess } from "@yap/core/files";
import { nativeConfirmed, nativeResult, type MediaWorker } from "./worker.js";
import type { AdmittedArchive } from "./archive-input.js";
import { isPrivateDirectory } from "./managed-files.js";

type ManifestResolver<Parsed extends ArchiveManifest, Ready extends ArchiveManifest> = (
  input: { manifest: Parsed; revisions: ReadonlyMap<string, string>; files: FileAccess },
  signal: AbortSignal | undefined,
  lifetime: { readonly fd: number },
) => Promise<Ready>;

/** A differently shaped parsed manifest cannot enter readiness without its resolver. */
export type PackageManifestResolution<
  Ready extends ArchiveManifest,
  Parsed extends ArchiveManifest = Ready,
> = {
  validate: ArchiveManifestValidator<Parsed>;
} & ([Parsed] extends [Ready]
  ? { resolve?: ManifestResolver<Parsed, Ready> }
  : { resolve: ManifestResolver<Parsed, Ready> });

export type PackageArchiveOptions<
  T extends ArchiveManifest,
  Parsed extends ArchiveManifest = T,
> = PackageManifestResolution<T, Parsed> & {
  inspect?: (
    retained: RetainedPackage<T>,
    signal: AbortSignal | undefined,
    lifetime: { readonly fd: number },
  ) => Promise<void>;
  signal?: AbortSignal;
  limits?: ArchiveLimits;
  timeoutMs?: number;
  inlineRevisions?: boolean;
};
async function extractArchive<T extends ArchiveManifest>(
  archive: AdmittedArchive,
  workspace: FileHandle,
  worker: MediaWorker,
  options: {
    validate: ArchiveManifestValidator<T>;
    signal?: AbortSignal;
    limits?: ArchiveLimits;
    timeoutMs?: number;
    inlineRevisions?: boolean;
  },
) {
  const limits = options.limits ?? archiveLimits;
  validateArchiveLimits(limits);
  const info = await workspace.stat({ bigint: true });
  if (!isPrivateDirectory(info))
    throw new CatalogError(
      "INVALID_STORAGE",
      "Archive workspace must be an owned private directory",
    );
  const identity = { dev: info.dev.toString(), ino: info.ino.toString() };
  const nativeOptions = {
    descriptors: [workspace.fd],
  };
  nativeConfirmed(
    await worker(
      "archive.prepare",
      { identity },
      { ...nativeOptions, ...(options.signal ? { signal: options.signal } : {}) },
    ),
    "empty",
    "Archive workspace admission was not confirmed",
  );
  const close = async (failure?: unknown) => {
    try {
      nativeConfirmed(
        await worker("archive.cleanup", { identity }, { ...nativeOptions, timeoutMs: null }),
        "removed",
        "Archive cleanup did not confirm completion",
      );
    } catch (cleanup) {
      const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new CatalogError(
        "ARCHIVE_CLEANUP_FAILED",
        "Archive workspace cleanup failed; its owner must retain it for recovery",
        {
          operationError: failure === undefined ? null : describe(failure),
          cleanupError: describe(cleanup),
        },
      );
    }
  };
  const scratch = await mkdtemp(join(tmpdir(), "yap-archive-inventory-"));
  const operands: FileHandle[] = [];
  try {
    const receipt = await open(join(scratch, "receipt.json"), "wx+");
    operands.push(receipt);
    const meter = await open(join(scratch, "work"), "wx+");
    operands.push(meter);
    let observed = 0;
    const workBudget = () => {
      const buffer = Buffer.alloc(32);
      const count = readSync(meter.fd, buffer, 0, buffer.length, 0);
      const bytes = Number(buffer.subarray(0, count).toString());
      if (Number.isSafeInteger(bytes) && bytes >= observed) observed = bytes;
      return publicationDeadlineMs(archive.bytes + observed);
    };
    const result = await worker(
      "archive.extract",
      {
        input: { bytes: archive.bytes, identity: archive.identity },
        identity,
        limits,
        ...(options.inlineRevisions === undefined
          ? {}
          : { inlineRevisions: options.inlineRevisions }),
      },
      {
        ...nativeOptions,
        descriptors: [workspace.fd, archive.fd, receipt.fd, meter.fd],
        timeoutMs: options.timeoutMs ?? workBudget,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const reply = nativeResult(result);
    if (
      !reply ||
      typeof reply !== "object" ||
      !("receiptBytes" in reply) ||
      reply.receiptBytes !== Number((await receipt.stat()).size)
    )
      throw new CatalogError(
        "INVALID_NATIVE_RESPONSE",
        "Archive extraction must confirm its retained receipt",
      );
    let inventory: unknown;
    try {
      inventory = readJsonDescriptor(receipt.fd);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new CatalogError("INVALID_NATIVE_RESPONSE", error.message);
      throw error;
    }
    const verified = verifyArchiveReceipt(inventory, limits, options.validate);
    if (verified.copiedBytes !== archive.bytes)
      throw new CatalogError("INVALID_NATIVE_RESPONSE", "Archive copy size differs from admission");
    return { verified, identity, close };
  } catch (failure) {
    await close(failure);
    throw failure;
  } finally {
    await Promise.all(operands.map((file) => file.close()));
    await rm(scratch, { recursive: true, force: true });
  }
}
type Extraction<T extends ArchiveManifest> = Awaited<ReturnType<typeof extractArchive<T>>>;

/** Validates and releases an extraction, returning the full receipt a retained context keeps private. */
export async function verifyPackageArchive<T extends ArchiveManifest>(
  archive: AdmittedArchive,
  workspace: FileHandle,
  worker: MediaWorker,
  options: {
    validate: ArchiveManifestValidator<T>;
    signal?: AbortSignal;
    limits?: ArchiveLimits;
    timeoutMs?: number;
    inlineRevisions?: boolean;
  },
) {
  const extraction = await extractArchive(archive, workspace, worker, options);
  await extraction.close();
  return omit(extraction.verified, "files", "revisionContents");
}

export async function openPackageArchive<
  T extends ArchiveManifest,
  Parsed extends ArchiveManifest = T,
>(
  archive: AdmittedArchive,
  workspace: { directory: string; handle: FileHandle },
  worker: MediaWorker,
  options: PackageArchiveOptions<T, Parsed>,
) {
  const extraction = await extractArchive(archive, workspace.handle, worker, options);
  let opened: IdentifiedFiles | undefined;
  let retained: RetainedPackage<T>;
  try {
    opened = new IdentifiedFiles(workspace.directory, extraction.verified.files);
    options.signal?.throwIfAborted();
    // The type-level contract permits omission only when Parsed is already a Ready shape.
    const manifest = options.resolve
      ? await options.resolve(
          {
            manifest: extraction.verified.manifest,
            revisions: new Map(Object.entries(extraction.verified.revisionContents)),
            files: fileSubdirectory(opened, "content"),
          },
          options.signal,
          workspace.handle,
        )
      : (extraction.verified.manifest as unknown as T);
    options.signal?.throwIfAborted();
    retained = new RetainedPackage(
      { ...extraction, verified: { ...extraction.verified, manifest } },
      opened,
    );
  } catch (error) {
    try {
      opened?.close();
    } finally {
      await extraction.close(error);
    }
    throw error;
  }
  try {
    await options.inspect?.(retained, options.signal, workspace.handle);
  } catch (error) {
    await retained.close();
    throw error;
  }
  return retained;
}

/** Admitted package bytes and metadata; the registry drains borrowers before closing them. */
export class RetainedPackage<T extends ArchiveManifest = ArchiveManifest> {
  readonly manifest: Extraction<T>["verified"]["manifest"];
  readonly archiveUsage: Readonly<Pick<Extraction<T>["verified"], "copiedBytes" | "expandedBytes">>;
  readonly files: FileAccess;
  private closing: Promise<void> | undefined;
  private closeFailed = false;
  constructor(
    private readonly extraction: Extraction<T>,
    private readonly opened: IdentifiedFiles,
  ) {
    this.manifest = extraction.verified.manifest;
    this.archiveUsage = Object.freeze({
      copiedBytes: extraction.verified.copiedBytes,
      expandedBytes: extraction.verified.expandedBytes,
    });
    this.files = fileSubdirectory(opened, "content");
  }
  close(): Promise<void> {
    if (this.closing && !this.closeFailed) return this.closing;
    this.closeFailed = false;
    const attempt = (async () => {
      let closeFailure: unknown;
      try {
        this.opened.close();
      } catch (error) {
        closeFailure = error;
      }
      await this.extraction.close(closeFailure);
      if (closeFailure) throw closeFailure;
    })();
    this.closing = attempt;
    void attempt.catch(() => {
      this.closeFailed = true;
    });
    return attempt;
  }
}
