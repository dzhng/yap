import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  statfs,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { CatalogError } from "./catalog.js";
import { copyImportedFile, fileIdentity, hashFile } from "./files.js";
import { O_NOFOLLOW_ANY } from "./open-flags.js";
import type { RuntimeArtifact, RuntimeEntry, SpeechModelFile } from "./model-types.js";

const mismatch = (path: string) =>
  new CatalogError(
    "MODEL_HASH_MISMATCH",
    "Model preparation differs from its registered artifact",
    { path },
  );
const reserve = 512 * 1024 * 1024;

/** Hashes through a no-link descriptor; neither a same-size rewrite nor a pathname swap is trusted. */
async function verifiedFile(path: string, pin: SpeechModelFile, signal?: AbortSignal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(pin.bytes)) throw mismatch(path);
    const hashed = await hashFile(handle, pin.bytes, signal ?? new AbortController().signal);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      hashed.sha256 !== pin.sha256 ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw mismatch(path);
    return after;
  } finally {
    await handle.close();
  }
}

export async function adoptFile(
  source: string,
  target: string,
  pin: SpeechModelFile,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  signal.throwIfAborted();
  const original = await verifiedFile(source, pin, signal);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const available = await statfs(dirname(target));
  if (available.bavail * available.bsize < reserve + pin.bytes)
    throw new CatalogError(
      "MODEL_STORAGE_FULL",
      "An independent model copy requires its file size plus 512 MiB of free reserve",
      {},
    );
  await copyImportedFile(
    source,
    target,
    signal,
    { path: source, bytes: pin.bytes, identity: fileIdentity(original), sha256: pin.sha256 },
    pin.bytes,
  );
  await chmod(target, Number(original.mode & 0o777n));
  signal.throwIfAborted();
  const copied = await verifiedFile(target, pin, signal);
  if (copied.ino === original.ino && copied.dev === original.dev) throw mismatch(target);
  progress(pin.bytes);
  return { modifiedNs: String(copied.mtimeNs), inode: String(copied.ino) };
}

/** Registry data is finite and self-contained; links never grant an escape from the artifact. */
function inventory(artifact: RuntimeArtifact) {
  if (
    createHash("sha256").update(JSON.stringify(artifact.entries)).digest("hex") !== artifact.digest
  )
    throw mismatch("runtime manifest");
  const entries = new Map<string, RuntimeEntry>();
  for (const entry of artifact.entries) {
    if (
      !entry.path ||
      isAbsolute(entry.path) ||
      posix.normalize(entry.path) !== entry.path ||
      entry.path.split("/").includes("..") ||
      entries.has(entry.path)
    )
      throw mismatch(entry.path);
    if (entry.kind === "symlink") {
      const resolved = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
      if (isAbsolute(entry.target) || resolved === ".." || resolved.startsWith("../"))
        throw mismatch(entry.path);
    }
    if (
      entry.kind === "file" &&
      (!Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256))
    )
      throw mismatch(entry.path);
    entries.set(entry.path, entry);
  }
  for (const entry of entries.values()) {
    const parent = posix.dirname(entry.path);
    if (parent !== "." && entries.get(parent)?.kind !== "directory") throw mismatch(entry.path);
    if (entry.kind === "symlink" && !entries.has(posix.normalize(posix.join(parent, entry.target))))
      throw mismatch(entry.path);
  }
  return entries;
}

/**
 * Checks an installed runtime against its registered inventory: paths, kinds, modes, link targets
 * and no extra entries. `contents` also hashes every file; `inventory` compares file sizes only,
 * which cannot see bytes rewritten in place and so never stands in for verification before use.
 */
export async function verifyRuntime(
  root: string,
  artifact: RuntimeArtifact,
  signal?: AbortSignal,
  check: "contents" | "inventory" = "contents",
) {
  const expected = inventory(artifact);
  if (!(await lstat(root)).isDirectory()) throw mismatch(root);
  let found = 0;
  async function walk(directory: string, prefix: string) {
    const stream = await opendir(directory);
    for await (const dirent of stream) {
      signal?.throwIfAborted();
      const relative = prefix + dirent.name,
        path = join(root, relative),
        entry = expected.get(relative);
      if (!entry || ++found > expected.size) throw mismatch(path);
      const stat = await lstat(path);
      if (entry.kind === "directory") {
        if (!stat.isDirectory() || (stat.mode & 0o777) !== entry.mode) throw mismatch(path);
        await walk(path, relative + "/");
      } else if (entry.kind === "symlink") {
        if (!stat.isSymbolicLink() || (await readlink(path)) !== entry.target) throw mismatch(path);
      } else {
        if (!stat.isFile() || (stat.mode & 0o777) !== entry.mode) throw mismatch(path);
        if (check === "inventory") {
          if (stat.size !== entry.bytes) throw mismatch(path);
        } else await verifiedFile(path, entry, signal);
      }
    }
  }
  await walk(root, "");
  if (found !== expected.size) throw mismatch(root);
}

export async function adoptRuntime(
  source: string,
  target: string,
  artifact: RuntimeArtifact,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  source = await realpath(source);
  await verifyRuntime(source, artifact, signal);
  await mkdir(target, { mode: 0o700 });
  for (const entry of artifact.entries) {
    signal.throwIfAborted();
    const path = join(target, entry.path);
    if (entry.kind === "directory") {
      await mkdir(path, { mode: entry.mode });
      await chmod(path, entry.mode);
    } else if (entry.kind === "symlink") await symlink(entry.target, path);
    else {
      await adoptFile(join(source, entry.path), path, entry, signal, progress);
    }
  }
  await verifyRuntime(target, artifact, signal);
}
