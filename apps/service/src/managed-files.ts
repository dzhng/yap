import { join } from "node:path";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { DirectoryIdentity } from "@yap/core/cache";
import { CatalogError } from "@yap/core/catalog";
import { openDirectoryLease } from "@yap/core/files";
import { O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import { nativeConfirmed, nativeResult, type MediaWorker } from "./worker.js";

/** A directory only this user can enter: the precondition for every private workspace. */
export function isPrivateDirectory(info: BigIntStats): boolean {
  return (
    info.isDirectory() && info.uid === BigInt(process.getuid!()) && (info.mode & 0o777n) === 0o700n
  );
}

/** Native file operations anchor deletion to directory descriptors, not re-resolved paths. */
export class ManagedFiles {
  private readonly home: string;
  private readonly expectedHome: DirectoryIdentity;
  constructor(
    home: string,
    private readonly worker: MediaWorker,
  ) {
    this.home = realpathSync(home);
    const stat = lstatSync(this.home, { bigint: true });
    this.expectedHome = { dev: stat.dev.toString(), ino: stat.ino.toString() };
  }
  /** The same library-root identity used for deletion defines where exports cannot live. */
  async externalDirectory(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ directory: string; identity: DirectoryIdentity }> {
    signal?.throwIfAborted();
    const directory = await realpath(path);
    const parent = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
    );
    try {
      const identity = nativeResult(
        await this.worker(
          "storage.externalDirectory",
          { home: this.home, expectedHome: this.expectedHome },
          { descriptors: [parent.fd], ...(signal ? { signal } : {}) },
        ),
      ) as DirectoryIdentity;
      if (!identity || typeof identity.dev !== "string" || typeof identity.ino !== "string")
        throw new CatalogError(
          "INVALID_NATIVE_RESPONSE",
          "External destination was not identified",
        );
      return { directory, identity };
    } finally {
      await parent.close();
    }
  }
  async recordingDirectory(recordingId: string, signal?: AbortSignal) {
    const directory = join(this.home, "recordings", recordingId);
    const handle = await openDirectoryLease(directory, "exclusive").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
          throw new CatalogError(
            "RECORDING_BUSY",
            "A native worker still owns this recording; retry after it exits",
            { recordingId },
          );
        throw error;
      },
    );
    try {
      const identity = nativeResult(
        await this.worker(
          "storage.recordingDirectory",
          { home: this.home, expectedHome: this.expectedHome, recordingId },
          { descriptors: [handle.fd], ...(signal ? { signal } : {}) },
        ),
      ) as DirectoryIdentity;
      if (!identity || typeof identity.dev !== "string" || typeof identity.ino !== "string")
        throw new CatalogError("INVALID_NATIVE_RESPONSE", "Recording directory was not identified");
      return { directory, handle, identity };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  /** The path owned by recording retirement; byte inspection uses this same root. */
  recordingPaths(recordingId: string): readonly string[] {
    return [join(this.home, "recordings", recordingId)];
  }
  removeRecordingDirectory(
    recordingId: string,
    signal: AbortSignal,
    lifetime?: { readonly fd: number },
  ): Promise<void> {
    return this.remove("storage.removeRecordingDirectory", { recordingId }, signal, lifetime);
  }
  removeCacheFiles(
    ids: string[],
    root: DirectoryIdentity,
    signal: AbortSignal,
    lifetime?: { readonly fd: number },
  ): Promise<void> {
    return this.remove(
      "storage.removeCacheFiles",
      { ids, expectedCacheRoot: root },
      signal,
      lifetime,
    );
  }
  private async remove(
    operation: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    lifetime?: { readonly fd: number },
  ): Promise<void> {
    nativeConfirmed(
      await this.worker(
        operation,
        { home: this.home, expectedHome: this.expectedHome, ...params },
        { signal, descriptors: lifetime ? [lifetime.fd] : [] },
      ),
      "removed",
      "Native storage removal did not confirm completion",
    );
  }
}
