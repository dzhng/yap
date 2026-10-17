import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CatalogError } from "@yap/core/catalog";
import { fileIdentity, hashFile, type FileIdentity } from "@yap/core/files";
import { O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import { withRenderAttempt, type RenderAttemptAuthority } from "./render.js";
import { cliWorker, type MediaWorker } from "./worker.js";

export type FfmpegArtifact<Evidence> = {
  path: string;
  file: FileHandle;
  worker: MediaWorker;
  identity: FileIdentity;
  bytes: number;
  sha256: string;
  evidence: Evidence;
};

/** The caller owns recipe and validation meaning; render-attempt owns staging,
 * cleanup and consumer lifetime. CLI completion supplies allocation identity only. */
export async function withFfmpegArtifact<Evidence, Result>(
  worker: MediaWorker,
  request: {
    filename: string;
    executable: string;
    ownerExecutable: string;
    descriptors: readonly number[];
    rewindDescriptors?: readonly number[];
    args: (outputSlot: number) => readonly string[];
    timeoutMs?: number;
    maxBytes?: number;
  } & (
    | { attemptParent: string }
    | { attempt: { directory: string; worker: MediaWorker; authority: RenderAttemptAuthority } }
  ),
  signal: AbortSignal,
  validate: (file: FileHandle, signal: AbortSignal, worker: MediaWorker) => Promise<Evidence>,
  consume: (artifact: FfmpegArtifact<Evidence>) => Promise<Result>,
): Promise<Result> {
  let retained: FileHandle | undefined;
  try {
    const produce = async (
      directory: string,
      boundWorker: MediaWorker,
      authority: RenderAttemptAuthority,
    ) => {
      const placeholder = await open("/dev/null", "w");
      const outputSlot = 3 + request.descriptors.length;
      let completion;
      try {
        completion = await cliWorker(
          {
            executable: request.executable,
            ownerExecutable: request.ownerExecutable,
            args: request.args(outputSlot),
          },
          {
            signal,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
            descriptors: [...request.descriptors, placeholder.fd, ...authority.descriptors],
            rewindDescriptors: request.rewindDescriptors ?? [],
            stagedOutput: {
              directoryDescriptor: outputSlot + 1,
              descriptor: outputSlot,
              name: request.filename,
            },
          },
        );
      } finally {
        await placeholder.close();
      }
      if (!completion.ok)
        throw new CatalogError(
          completion.error.code,
          completion.error.message,
          completion.error.details,
        );
      const allocation = (completion.data as { allocatedOutput: { device: string; inode: string } })
        .allocatedOutput;
      const path = join(directory, request.filename);
      retained = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
      const actual = await retained.stat({ bigint: true });
      if (
        !actual.isFile() ||
        actual.nlink !== 1n ||
        actual.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        actual.dev.toString() !== allocation.device ||
        actual.ino.toString() !== allocation.inode
      )
        throw new CatalogError("INVALID_STORAGE", "CLI staged output changed before validation");
      const identity = fileIdentity(actual);
      const evidence = await validate(retained, signal, boundWorker);
      if (!isDeepStrictEqual(identity, fileIdentity(await retained.stat({ bigint: true }))))
        throw new CatalogError("INVALID_STORAGE", "CLI staged output changed during validation");
      const hash = await hashFile(retained, Number(actual.size), signal);
      return { path, file: retained, worker: boundWorker, identity, evidence, ...hash };
    };
    if ("attempt" in request)
      return await consume(
        await produce(request.attempt.directory, request.attempt.worker, request.attempt.authority),
      );
    return await withRenderAttempt(worker, request.attemptParent, signal, produce, consume);
  } finally {
    await retained?.close();
  }
}
