import { createHash } from "node:crypto";
import { lstat, realpath, open, type FileHandle } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { readSync, closeSync, constants, fstatSync, openSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { CatalogError } from "./catalog.js";
import { O_NOFOLLOW_ANY, O_EXLOCK, O_SHLOCK } from "./open-flags.js";

/** The lock follows the inherited open-file description; parents may be canonical aliases,
 * but the selected directory itself must retain its admitted inode. Busy is left to its owner. */
export async function openDirectoryLease(
  directory: string,
  mode: "shared" | "exclusive",
): Promise<FileHandle> {
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory())
    throw new CatalogError("INVALID_STORAGE", "Directory lease requires a directory");
  const handle = await open(
    await realpath(directory),
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NONBLOCK |
      O_NOFOLLOW_ANY |
      (mode === "exclusive" ? O_EXLOCK : O_SHLOCK),
  );
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino)
      throw new CatalogError("INVALID_STORAGE", "Directory changed during lease admission");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export type OpenedFile = { readonly fd: number; close(): void };
export type FileAccess = {
  path(file: string): string;
  open(file: string): OpenedFile;
  check(): void;
};
export type FileIdentity = { device: string; inode: string; modifiedNs: string; changedNs: string };
export type IdentifiedFile = { path: string; bytes: number; identity: FileIdentity };
export function fileIdentity(stat: BigIntStats): FileIdentity {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
  };
}
export function openedFile(fd: number, onClose = () => {}): OpenedFile {
  let closed = false;
  return {
    get fd() {
      if (closed) throw new CatalogError("CONTEXT_CLOSED", "File read has been closed");
      return fd;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } finally {
        onClose();
      }
    },
  };
}
/** Trusted library/fixture directories retain their existing leaf-check contract. */
export function fileAccess(root: string | FileAccess): FileAccess {
  if (typeof root !== "string") return root;
  return {
    check: () => {},
    path: (file) => join(root, file),
    open: (file) =>
      openedFile(
        openSync(
          join(root, file),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ),
      ),
  };
}
export function fileSubdirectory(files: FileAccess, directory: string): FileAccess {
  return {
    check: () => files.check(),
    path: (file) => files.path(`${directory}/${file}`),
    open: (file) => files.open(`${directory}/${file}`),
  };
}

/** Local extraction identities are authority; paths are only locators, checked before consuming bytes. */
export class IdentifiedFiles implements FileAccess {
  private readonly entries = new Map<string, IdentifiedFile>();
  private readonly leases = new Map<OpenedFile, string>();
  private closed = false;
  private accepting = true;
  constructor(
    private readonly root: string,
    entries: readonly IdentifiedFile[],
    private readonly maximumOpen = 32,
  ) {
    if (process.platform !== "darwin")
      throw new CatalogError(
        "UNSUPPORTED_PLATFORM",
        "Retained packages require macOS file admission",
      );
    for (const entry of entries) this.add(entry);
  }
  add(entry: IdentifiedFile): void {
    if (this.closed) throw new CatalogError("CONTEXT_CLOSED", "Package is closed");
    if (
      !/^[A-Za-z0-9_./-]+$/.test(entry.path) ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      this.entries.has(entry.path)
    )
      throw new CatalogError("INVALID_PACKAGE", "Invalid or repeated local file identity");
    this.entries.set(entry.path, entry);
  }
  stop(): void {
    this.accepting = false;
  }
  check(): void {
    if (!this.accepting || this.closed)
      throw new CatalogError("CONTEXT_CLOSED", "Package is closed");
  }
  path(file: string): string {
    return join(this.root, file);
  }
  open(file: string, writable = false, onClose = () => {}): OpenedFile {
    this.check();
    const expected = this.entries.get(file);
    if (!expected) throw new CatalogError("NOT_FOUND", "File is not admitted to this package");
    if (this.leases.size >= this.maximumOpen)
      throw new CatalogError("CAPACITY_EXCEEDED", "Package open-file limit exceeded", {});
    const fd = openSync(
      this.path(file),
      (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
    );
    try {
      const stat = fstatSync(fd, { bigint: true }),
        actual = fileIdentity(stat);
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.size !== BigInt(expected.bytes) ||
        actual.device !== expected.identity.device ||
        actual.inode !== expected.identity.inode ||
        actual.modifiedNs !== expected.identity.modifiedNs ||
        actual.changedNs !== expected.identity.changedNs
      )
        throw new CatalogError("INVALID_STORAGE", "Package member changed after extraction");
      const lease = openedFile(fd, () => {
        this.leases.delete(lease);
        onClose();
      });
      this.leases.set(lease, file);
      return lease;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  refresh(file: string, lease: OpenedFile): IdentifiedFile {
    const previous = this.entries.get(file),
      stat = fstatSync(lease.fd, { bigint: true });
    if (
      !previous ||
      !stat.isFile() ||
      stat.nlink !== 1n ||
      String(stat.dev) !== previous.identity.device ||
      String(stat.ino) !== previous.identity.inode ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new CatalogError("INVALID_STORAGE", "Output identity changed while writing");
    const entry = { path: file, bytes: Number(stat.size), identity: fileIdentity(stat) };
    this.entries.set(file, entry);
    return entry;
  }
  forget(file: string): void {
    if ([...this.leases.values()].includes(file))
      throw new CatalogError("PROCESSING_BUSY", "File still has active reads");
    this.entries.delete(file);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    const failures: unknown[] = [];
    for (const lease of this.leases.keys()) {
      try {
        lease.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Package file closure failed");
  }
}

/** Positioned reads of one retained file, bounded by its admitted length, until released. */
export type RetainedRead = Readonly<{
  bytes: number;
  read(buffer: Uint8Array, position: number): number;
  release(): void;
}>;
export function retainedFileRead(file: OpenedFile, bytes: number): RetainedRead {
  let released = false;
  return {
    bytes,
    read(buffer: Uint8Array, position: number): number {
      if (released)
        throw new CatalogError("INVALID_EVIDENCE", "Retained file read has been released");
      if (!Number.isSafeInteger(position) || position < 0 || position > bytes)
        throw new CatalogError("INVALID_EVIDENCE", "Invalid retained file read position");
      return readSync(file.fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
    },
    release() {
      if (!released) {
        released = true;
        file.close();
      }
    },
  };
}

/** Copies through a held descriptor; the caller releases its lease after publication or failure. */
export async function copyRetainedFile(
  source: RetainedRead,
  destination: string,
  signal?: AbortSignal,
) {
  const output = await open(destination, "wx");
  try {
    const buffer = Buffer.alloc(65536),
      hash = createHash("sha256");
    for (let position = 0; position < source.bytes;) {
      signal?.throwIfAborted();
      const bytes = source.read(buffer, position);
      if (!bytes) throw new CatalogError("INVALID_EVIDENCE", "Retained image ended during copy");
      const part = buffer.subarray(0, bytes);
      hash.update(part);
      await output.writeFile(part);
      position += bytes;
    }
    return { bytes: source.bytes, sha256: hash.digest("hex") };
  } finally {
    await output.close();
  }
}

/** Hash a borrowed regular-file descriptor within its declared size and identity. */
export async function hashFile(file: FileHandle, expectedBytes: number, signal: AbortSignal) {
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.size !== BigInt(expectedBytes))
    throw new CatalogError("INVALID_STORAGE", "Retained file size differs from its identity");
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  for (let position = 0; position < expectedBytes;) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - position),
      position,
    );
    if (!bytesRead) throw new CatalogError("INVALID_STORAGE", "Retained file ended during hashing");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (!isDeepStrictEqual(fileIdentity(before), fileIdentity(await file.stat({ bigint: true }))))
    throw new CatalogError("SOURCE_CHANGED", "Retained file changed during hashing");
  signal.throwIfAborted();
  return { bytes: expectedBytes, sha256: hash.digest("hex") };
}

/** Copy a frozen local file with bounded memory; the caller owns staged-file cleanup/publication. */
export async function copyImportedFile(
  path: string,
  destination: string,
  signal: AbortSignal,
  expected?: IdentifiedFile & { sha256?: string },
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<{ sha256: string; bytes: number }> {
  signal.throwIfAborted();
  let input;
  try {
    input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new CatalogError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "NOT_FOUND" : "INVALID_PATH",
      "Cannot open import source",
      { filesystemCode: (error as NodeJS.ErrnoException).code },
    );
  }
  try {
    const before = await input.stat({ bigint: true });
    if (
      expected &&
      (BigInt(expected.bytes) !== before.size ||
        !isDeepStrictEqual(expected.identity, fileIdentity(before)))
    )
      throw new CatalogError(
        "SOURCE_CHANGED",
        "Import source no longer matches the frozen request; create a new import",
        {},
      );
    if (!before.isFile() || before.size > BigInt(maximumBytes))
      throw new CatalogError(
        "UNSUPPORTED_MEDIA",
        "Import source must be a regular file of supported size",
      );
    const output = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        signal.throwIfAborted();
        const read = await input.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        if (BigInt(bytes) > before.size)
          throw new CatalogError("SOURCE_CHANGED", "Import source grew during copying", {});
        hash.update(buffer.subarray(0, read.bytesRead));
        let written = 0;
        while (written < read.bytesRead) {
          signal.throwIfAborted();
          const result = await output.write(buffer, written, read.bytesRead - written);
          if (!result.bytesWritten)
            throw new CatalogError("STORAGE_ERROR", "Import copy made no progress");
          written += result.bytesWritten;
        }
      }
      const after = await input.stat({ bigint: true });
      if (
        BigInt(bytes) !== before.size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new CatalogError("SOURCE_CHANGED", "Import source changed during copying", {});
      await output.chmod(0o400);
      await output.sync();
    } finally {
      await output.close();
    }
    const sha256 = hash.digest("hex");
    if (expected?.sha256 !== undefined && sha256 !== expected.sha256)
      throw new CatalogError(
        "SOURCE_CHANGED",
        "Imported bytes differ from verified source identity",
      );
    return { sha256, bytes };
  } finally {
    await input.close();
  }
}
