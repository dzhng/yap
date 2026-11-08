import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DirectoryIdentity } from "@yap/core/cache";
import { CatalogError } from "@yap/core/catalog";
import { O_EXLOCK, O_SHLOCK, O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import { nativeConfirmed, type MediaWorker } from "./worker.js";

export type RenderAttemptAuthority = {
  descriptors: readonly number[];
  identity: DirectoryIdentity;
};
type LockedWorkspace = {
  directory: string;
  descriptors: readonly number[];
  identity: DirectoryIdentity;
  worker: MediaWorker;
  clear: () => Promise<void>;
};

async function withLockedRenderWorkspace<T>(
  worker: MediaWorker,
  directory: string,
  signal: AbortSignal,
  authority: {
    lock: "shared" | "exclusive";
    inherited: readonly number[];
    parent?: { expectedDirectory: DirectoryIdentity; name: string };
  },
  action: (workspace: LockedWorkspace) => Promise<T>,
): Promise<T> {
  // This dedicated 0700 directory is exclusively owned by the service. The lock
  // follows the inherited open-file description if the service dies first.
  const before = await lstat(directory, { bigint: true });
  if (
    !before.isDirectory() ||
    (before.mode & 0o777n) !== 0o700n ||
    before.uid !== BigInt(process.getuid!())
  )
    throw new CatalogError(
      "INVALID_STORAGE",
      "Render workspace must be an owned private directory",
    );
  const parent = await realpath(directory);
  const flags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NONBLOCK |
    (authority.lock === "shared" ? O_SHLOCK : O_EXLOCK) |
    O_NOFOLLOW_ANY;
  const workspace = await open(parent, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
      throw new CatalogError(
        "RENDER_WORKSPACE_BUSY",
        "Another render still owns this workspace",
        {},
      );
    throw error;
  });
  const identity = { dev: before.dev.toString(), ino: before.ino.toString() };
  const descriptors = [workspace.fd, ...authority.inherited];
  const boundWorker: MediaWorker = (operation, params, options) =>
    worker(operation, params, {
      ...options,
      signal,
      // Explicit /dev/fd/N locators belong to the caller; leases follow those descriptors.
      descriptors: [...(options?.descriptors ?? []), ...descriptors],
    });
  const clear = async () => {
    nativeConfirmed(
      await worker(
        "storage.clearRenderWorkspace",
        {
          expectedDirectory: identity,
          ...(authority.parent ? { parent: authority.parent } : {}),
        },
        { descriptors },
      ),
      "removed",
      "Render workspace cleanup did not confirm completion",
    );
  };
  try {
    const opened = await workspace.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new CatalogError("INVALID_STORAGE", "Render workspace changed while opening");
    const result = await action({
      directory: parent,
      descriptors,
      identity,
      worker: boundWorker,
      clear,
    });
    if (signal.aborted) throw new CatalogError("CANCELED", "Media render was canceled");
    return result;
  } finally {
    await workspace.close();
  }
}

/** Startup/deletion admission uses the same authority before jobs may start.
 * A missing workspace needs neither creation nor a native process. */
export async function clearRenderWorkspace(
  worker: MediaWorker,
  parent: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new CatalogError("CANCELED", "Media render was canceled");
  try {
    await lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await withLockedRenderWorkspace(
    worker,
    parent,
    signal,
    { lock: "exclusive", inherited: [] },
    async ({ clear }) => clear(),
  );
}

/** Native encoders may stage beside their output. Keep that entire lifetime under
 * the render workspace lock; only completed bytes enter the disposable cache. */
export async function withRenderedFile(
  worker: MediaWorker,
  request: {
    attemptParent: string;
    output: string;
    filename: "audio.wav" | "audio.m4a" | "frame.png" | "presentation.jsonl";
  },
  signal: AbortSignal,
  produce: (
    output: string,
    worker: MediaWorker,
    authority: RenderAttemptAuthority,
  ) => Promise<unknown>,
): Promise<unknown> {
  return withRenderAttempt(
    worker,
    request.attemptParent,
    signal,
    async (directory, boundWorker, authority) => {
      const file = join(directory, request.filename);
      const receipt = await produce(file, boundWorker, authority);
      if (!receipt || typeof receipt !== "object" || !("file" in receipt) || receipt.file !== file)
        throw new CatalogError("INVALID_RESPONSE", "Media receipt changed the render attempt path");
      return { ...receipt, file };
    },
    async (artifact) => {
      await copyFile(
        artifact.file,
        request.output,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      return { ...artifact, file: request.output };
    },
  );
}

/** The render action owns media semantics; this owner fences late results and
 * retains the workspace lock until the consumer and native children finish.
 * Independent attempts share the root but own their child cleanup. Startup must
 * clear stale attempts before admitting jobs. Actions must await every native call. */
export async function withRenderAttempt<Artifact, Result>(
  worker: MediaWorker,
  parent: string,
  signal: AbortSignal,
  render: (
    directory: string,
    worker: MediaWorker,
    authority: Pick<LockedWorkspace, "descriptors" | "identity">,
  ) => Promise<Artifact>,
  consume: (artifact: Artifact) => Promise<Result>,
): Promise<Result> {
  const checkCanceled = () => {
    if (signal.aborted) throw new CatalogError("CANCELED", "Media render was canceled");
  };
  checkCanceled();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return withLockedRenderWorkspace(
    worker,
    parent,
    signal,
    { lock: "shared", inherited: [] },
    async ({ directory, descriptors, identity }) => {
      checkCanceled();
      const attempt = await mkdtemp(join(directory, "render-"));
      return withLockedRenderWorkspace(
        worker,
        attempt,
        signal,
        {
          lock: "exclusive",
          inherited: descriptors,
          parent: { expectedDirectory: identity, name: basename(attempt) },
        },
        async ({ worker: boundWorker, clear, descriptors, identity }) => {
          try {
            checkCanceled();
            const artifact = await render(attempt, boundWorker, { descriptors, identity });
            checkCanceled();
            const result = await consume(artifact);
            checkCanceled();
            return result;
          } finally {
            await clear();
          }
        },
      );
    },
  );
}
