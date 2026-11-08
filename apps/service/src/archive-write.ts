import type { FileHandle } from "node:fs/promises";
import { CatalogError } from "@yap/core/catalog";
import { IdentifiedFiles, fileIdentity } from "@yap/core/files";
import {
  archiveLimits,
  verifyArchiveWriteReceipt,
  validateArchiveLimits,
  type ArchiveLimits,
} from "@yap/core/package-archive";
import { nativeConfirmed, nativeResult, type MediaWorker } from "./worker.js";
import { publicationDeadlineMs } from "./publication.js";

type Options = { signal?: AbortSignal; limits?: ArchiveLimits; timeoutMs?: number };
/** Borrow both private directories and the immutable member plan until close settles.
 * The caller registers their identities for crash recovery before this operation writes bytes. */
export async function writeArchive(
  input: { handle: FileHandle; plan: FileHandle; bytes: number },
  workspace: { directory: string; handle: FileHandle },
  worker: MediaWorker,
  options: Options = {},
) {
  const limits = options.limits ?? archiveLimits;
  validateArchiveLimits(limits);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
    throw new CatalogError("INVALID_PARAMS", "ZIP input byte total must be a nonnegative integer");
  const stage = await workspace.handle.stat({ bigint: true }),
    source = await input.handle.stat({ bigint: true }),
    plan = await input.plan.stat({ bigint: true });
  const identity = { dev: String(stage.dev), ino: String(stage.ino) };
  const nativeOptions = {
    descriptors: [workspace.handle.fd],
  };
  try {
    nativeConfirmed(
      await worker(
        "archive.prepare",
        { identity },
        { ...nativeOptions, ...(options.signal ? { signal: options.signal } : {}) },
      ),
      "empty",
      "ZIP workspace admission was not confirmed",
    );
  } catch (error) {
    if (error instanceof CatalogError && error.code === "INVALID_STORAGE")
      throw new CatalogError("PACKAGE_STORAGE_UNAVAILABLE", error.message, error.details);
    throw error;
  }
  let files: IdentifiedFiles | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    files?.close();
    nativeConfirmed(
      await worker("archive.cleanup", { identity }, { ...nativeOptions, timeoutMs: null }),
      "removed",
      "ZIP workspace cleanup was not confirmed",
    );
    closed = true;
  };
  try {
    let nativeReceipt: unknown;
    try {
      nativeReceipt = nativeResult(
        await worker(
          "archive.write",
          {
            identity,
            inputBytes: input.bytes,
            inputIdentity: { dev: String(source.dev), ino: String(source.ino) },
            plan: { bytes: Number(plan.size), identity: fileIdentity(plan) },
            limits,
          },
          {
            ...nativeOptions,
            descriptors: [workspace.handle.fd, input.handle.fd, input.plan.fd],
            timeoutMs: options.timeoutMs ?? publicationDeadlineMs(input.bytes),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        ),
      );
    } catch (error) {
      if (error instanceof CatalogError && error.code === "INVALID_STORAGE")
        throw new CatalogError("PACKAGE_STORAGE_UNAVAILABLE", error.message, error.details);
      throw error;
    }
    const receipt = verifyArchiveWriteReceipt(nativeReceipt, limits);
    if (receipt.expandedBytes !== input.bytes)
      throw new CatalogError(
        "INVALID_NATIVE_RESPONSE",
        "ZIP byte total differs from admitted input",
      );
    files = new IdentifiedFiles(workspace.directory, [receipt]);
    const file = files.open(receipt.path);
    return { file, receipt, close };
  } catch (failure) {
    try {
      await close();
    } catch (cleanup) {
      throw new CatalogError(
        "ARCHIVE_CLEANUP_FAILED",
        "ZIP cleanup failed; retain its owned workspace for recovery",
        {
          operationError: String(failure),
          cleanupError: String(cleanup),
        },
      );
    }
    throw failure;
  }
}
