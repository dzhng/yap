import type { DirectoryIdentity } from "@yap/core/cache";
import { isPrivateDirectory } from "./managed-files.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { CatalogError } from "@yap/core/catalog";
import { O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import { nativeConfirmed, nativeResult, type MediaWorker } from "./worker.js";

type Identity = Readonly<{ dev: string; ino: string }>;
type Parent = Readonly<{ directory: string; handle: FileHandle }>;

/** Admit the one private root shared by archive workspaces; its handle owns later lookup authority. */
export async function openPackageParent(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const before = await lstat(path, { bigint: true });
  if (!isPrivateDirectory(before))
    throw new CatalogError("INVALID_STORAGE", "Package root must be a private owned directory");
  const directory = await realpath(path);
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
  try {
    const actual = await handle.stat({ bigint: true });
    if (!isPrivateDirectory(actual) || actual.dev !== before.dev || actual.ino !== before.ino)
      throw new CatalogError("INVALID_STORAGE", "Package root identity changed during admission");
    return { directory, handle, identity: { dev: String(actual.dev), ino: String(actual.ino) } };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

class FailedWorkspaceProvision extends CatalogError {
  constructor(
    readonly workspaceName: string,
    readonly childIdentity: Identity,
    cause: unknown,
    cleanup: unknown,
  ) {
    super("INVALID_STORAGE", "Workspace admission and cleanup failed", {
      name: workspaceName,
      identity: childIdentity,
      cause: String(cause),
      cleanup: String(cleanup),
    });
  }
}

/** Parent is borrowed until removal succeeds. Close RetainedPackage before calling remove. */
export async function provisionPackageWorkspace(
  parent: Parent,
  worker: MediaWorker,
  options: { name?: string; signal?: AbortSignal } = {},
) {
  const name = options.name ?? randomUUID();
  const parentHandle = parent.handle;
  const directory = join(parent.directory, name);
  const signal = options.signal;
  if (signal?.aborted) throw new CatalogError("CANCELED", "Workspace creation canceled");
  const info = await parentHandle.stat({ bigint: true });
  const parentIdentity = { dev: info.dev.toString(), ino: info.ino.toString() };
  const call = (
    operation: string,
    identity?: Identity,
    handle?: FileHandle,
    signal?: AbortSignal,
  ) =>
    worker(
      operation,
      { parent: parentIdentity, name, ...(identity ? { identity } : {}) },
      {
        descriptors: [parentHandle.fd, ...(handle ? [handle.fd] : [])],
        ...(signal ? { signal } : {}),
      },
    );
  // Once mkdir can occur, drain creation to its receipt before honoring cancellation.
  let receipt: { name?: unknown; identity?: Identity };
  try {
    receipt = nativeResult(await call("packageWorkspace.create")) as typeof receipt;
  } catch (cause) {
    throw new CatalogError(
      "PACKAGE_STORAGE_UNAVAILABLE",
      "Workspace creation failed; reservation may need recovery",
      { name, cause: String(cause) },
    );
  }
  if (
    receipt?.name !== name ||
    !receipt.identity ||
    typeof receipt.identity.dev !== "string" ||
    typeof receipt.identity.ino !== "string" ||
    !/^\d+$/.test(receipt.identity.dev) ||
    !/^\d+$/.test(receipt.identity.ino)
  )
    throw new CatalogError("INVALID_STORAGE", "Invalid workspace creation receipt", { name });
  const identity = Object.freeze({ ...receipt.identity });
  let handle: FileHandle | undefined;
  try {
    if (signal?.aborted) throw new CatalogError("CANCELED", "Workspace creation canceled");
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
    const actual = await handle.stat({ bigint: true });
    if (
      !actual.isDirectory() ||
      actual.dev.toString() !== identity.dev ||
      actual.ino.toString() !== identity.ino
    )
      throw new CatalogError("INVALID_STORAGE", "Workspace locator identity changed");
    nativeResult(await call("packageWorkspace.admit", identity, handle, signal));
  } catch (cause) {
    await handle?.close();
    try {
      await removePackageWorkspace(parent, name, identity, worker);
    } catch (cleanup) {
      throw new FailedWorkspaceProvision(name, identity, cause, cleanup);
    }
    throw cause;
  }
  const admitted = handle;
  let removed = false;
  let closed = false;
  let removal: Promise<void> | undefined;
  return {
    name,
    directory,
    identity,
    handle: admitted,
    remove(): Promise<void> {
      if (removed) return Promise.resolve();
      if (removal) return removal;
      removal = (async () => {
        if (!closed) {
          await admitted.close();
          closed = true;
        }
        await removePackageWorkspace(parent, name, identity, worker);
        removed = true;
      })().finally(() => {
        removal = undefined;
      });
      return removal;
    },
  };
}

/** Startup-only: caller blocks admission and exclusively owns the borrowed private parent. */
export function recoverPackageWorkspaces(
  parent: Parent,
  worker: MediaWorker,
): Promise<{ recovered: number }> {
  return recoverWorkspaces(parent, worker);
}

/** A known identity is removed exactly. Without a creation receipt, only an empty child or
 * absence authorizes release. Removing an already absent child succeeds. */
export async function removePackageWorkspace(
  parent: Parent,
  name: string,
  identity: Identity | null,
  worker: MediaWorker,
): Promise<void> {
  if (!identity) {
    await recoverWorkspaces(parent, worker, name);
    return;
  }
  const info = await parent.handle.stat({ bigint: true });
  nativeConfirmed(
    await worker(
      "packageWorkspace.remove",
      { parent: { dev: info.dev.toString(), ino: info.ino.toString() }, name, identity },
      { descriptors: [parent.handle.fd] },
    ),
    "removed",
    "Workspace removal was not confirmed",
  );
}

async function recoverWorkspaces(
  parent: Parent,
  worker: MediaWorker,
  name?: string,
): Promise<{ recovered: number }> {
  const handle = parent.handle;
  const info = await handle.stat({ bigint: true });
  const receipt = nativeResult(
    await worker(
      name === undefined ? "packageWorkspace.recover" : "packageWorkspace.recoverUnconfirmed",
      {
        ...(name === undefined ? {} : { name }),
        parent: { dev: info.dev.toString(), ino: info.ino.toString() },
      },
      { descriptors: [handle.fd] },
    ),
  ) as { recovered?: unknown };
  if (
    !receipt ||
    !Number.isInteger(receipt.recovered) ||
    (receipt.recovered as number) < 0 ||
    (receipt.recovered as number) > 4
  )
    throw new CatalogError("INVALID_NATIVE_RESPONSE", "Invalid workspace recovery receipt");
  return { recovered: receipt.recovered as number };
}

/** Retries a failed provision with the identity it observed, or as an unconfirmed creation. */
export function cleanupFailedPackageWorkspace(
  parent: Parent,
  name: string,
  failure: unknown,
  worker: MediaWorker,
): Promise<void> {
  if (failure instanceof FailedWorkspaceProvision && failure.workspaceName !== name)
    return Promise.reject(new CatalogError("INVALID_STORAGE", "Failed workspace name changed"));
  return removePackageWorkspace(
    parent,
    name,
    failure instanceof FailedWorkspaceProvision ? failure.childIdentity : null,
    worker,
  );
}

export type AssemblyReservation = {
  parent: DirectoryIdentity;
  bytes?: number;
  input: { name: string; identity: DirectoryIdentity | null };
  zip: { name: string; identity: DirectoryIdentity | null };
};
type Workspace = { directory: string; handle: FileHandle; identity: DirectoryIdentity };

export async function checkWorkspace(workspace: Workspace): Promise<void> {
  const current = await open(
    workspace.directory,
    constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY,
  );
  try {
    const stat = await current.stat({ bigint: true });
    if (String(stat.dev) !== workspace.identity.dev || String(stat.ino) !== workspace.identity.ino)
      throw new CatalogError("INVALID_STORAGE", "Assembly workspace locator changed");
  } finally {
    await current.close();
  }
}
