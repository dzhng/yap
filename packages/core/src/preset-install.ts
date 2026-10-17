import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  folderFor,
  isPackageId,
  unsupportedIndex,
  type PresetFile,
  type PresetIndex,
  type PresetKind,
  type PresetManifest,
} from "./preset-format.js";
import { readLocalIds, writeJsonAtomic } from "./preset-store.js";

export type PackageSource = {
  index(): Promise<PresetIndex>;
  file(pkg: PresetManifest, path: string): Promise<ReadableStream<Uint8Array>>;
  source: "bundled" | "downloaded";
  commit?: string | undefined;
};

export type InstalledPackage = {
  kind: PresetKind;
  version: number;
  source: "bundled" | "downloaded";
  commit?: string;
  files: PresetFile[];
};

export type PresetReceipt = {
  packages: Record<string, InstalledPackage>;
  conflicts: Record<string, { version: number }>;
};

/** The installed packages under a presets root; a missing receipt means nothing is installed. */
export function readReceipt(root: string): PresetReceipt {
  let receipt: Partial<PresetReceipt>;
  try {
    receipt = JSON.parse(
      readFileSync(join(root, "receipt.json"), "utf8"),
    ) as Partial<PresetReceipt>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { packages: {}, conflicts: {} };
    throw error;
  }
  return { packages: receipt.packages ?? {}, conflicts: receipt.conflicts ?? {} };
}

async function writeReceipt(root: string, receipt: PresetReceipt): Promise<void> {
  await writeJsonAtomic(join(root, "receipt.json"), receipt);
}

export type InstallReport = {
  installed: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; reason: string }>;
  removed: string[];
  conflicts: string[];
};

export type InstallOptions = {
  removeMissingDownloaded?: boolean;
  /** With removeMissingDownloaded, only packages this accepts may be removed (an id-scoped refresh). */
  removeSelector?: PackageSelector | undefined;
};
export type PackageSelector = (remote: PresetManifest, installed?: InstalledPackage) => boolean;

// The service is the sole owner of ~/.yap/presets, so an in-process queue is
// sufficient; cross-process locking would add machinery for an unsupported use.
const queues = new Map<string, Promise<void>>();
/** Targets whose staging this process has cleared; anything there before was left by a crash. */
const swept = new Set<string>();

function validPackage(pkg: Pick<PresetManifest, "id" | "kind">): boolean {
  if (!isPackageId(pkg.id)) return false;
  if (pkg.kind === "preset") return true;
  return (pkg.kind === "kit" || pkg.kind === "authoring") && pkg.id === pkg.kind;
}

function safeRelative(path: string): string {
  const clean = path.replaceAll("\\", "/");
  if (!clean || clean.startsWith("/") || clean.split("/").includes(".."))
    throw new Error(`invalid package path: ${path}`);
  return clean;
}

async function withTargetQueue<T>(target: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(target) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  queues.set(target, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(target) === queued) queues.delete(target);
  }
}

/** What an install reports before it has done anything. */
export function emptyInstallReport(): InstallReport {
  return { installed: [], skipped: [], failed: [], removed: [], conflicts: [] };
}

export function newerThanInstalled(remote: PresetManifest, installed?: InstalledPackage): boolean {
  return !installed || remote.version > installed.version;
}

async function streamToFile(
  stream: ReadableStream<Uint8Array>,
  destination: string,
  expected: PresetFile,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, "w", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        bytes += chunk.byteLength;
        // Stop at the first overrun; a stream may never end on its own.
        if (bytes > expected.bytes) {
          await reader.cancel().catch(() => {});
          break;
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  if (bytes !== expected.bytes)
    throw new Error(
      `byte count mismatch for ${expected.path}: expected ${expected.bytes}, got ${bytes}`,
    );
  if (digest !== expected.sha256)
    throw new Error(
      `sha256 mismatch for ${expected.path}: expected ${expected.sha256}, got ${digest}`,
    );
}

export async function installPackages(
  source: PackageSource,
  target: string,
  select: PackageSelector = newerThanInstalled,
  options: InstallOptions = {},
): Promise<InstallReport> {
  return withTargetQueue(resolve(target), async () => {
    const report = emptyInstallReport();
    await mkdir(target, { recursive: true });
    if (!swept.has(resolve(target))) {
      await rm(join(target, ".staging"), { recursive: true, force: true });
      swept.add(resolve(target));
    }
    const index = await source.index();
    const unsupported = unsupportedIndex(index);
    if (unsupported) {
      report.failed.push({ id: "index", reason: unsupported });
      return report;
    }
    const receipt = readReceipt(target);
    let receiptChanged = false;
    const locals = readLocalIds(target);
    const remoteIds = new Set(index.packages.map((pkg) => pkg.id));
    for (const id of Object.keys(receipt.conflicts)) {
      if (!locals.has(id) || !remoteIds.has(id)) {
        delete receipt.conflicts[id];
        receiptChanged = true;
      }
    }
    const stagingRoot = join(target, ".staging", randomUUID());
    await mkdir(stagingRoot, { recursive: true });
    try {
      for (const pkg of index.packages) {
        // A remote index is untrusted input: an id or kind outside the format could name a path
        // outside the target, so it is refused before any path is built from it.
        if (!validPackage(pkg)) {
          report.failed.push({ id: String(pkg.id), reason: "invalid package id or kind" });
          continue;
        }
        const installed = receipt.packages[pkg.id];
        if (pkg.kind === "preset" && locals.has(pkg.id)) {
          report.conflicts.push(pkg.id);
          report.skipped.push({ id: pkg.id, reason: "local preset wins" });
          delete receipt.packages[pkg.id];
          receipt.conflicts[pkg.id] = { version: pkg.version };
          receiptChanged = true;
          continue;
        }
        if (!select(pkg, installed)) {
          report.skipped.push({
            id: pkg.id,
            reason: installed && pkg.version === installed.version ? "tie" : "older version",
          });
          continue;
        }
        const packageStage = join(stagingRoot, folderFor(pkg));
        try {
          for (const file of pkg.files) {
            const path = safeRelative(file.path);
            await streamToFile(await source.file(pkg, path), join(packageStage, path), file);
          }
          const folder = folderFor(pkg);
          const installedPath = join(target, folder);
          const oldPath = join(stagingRoot, `.old-${folder}-${randomUUID()}`);
          try {
            await rename(installedPath, oldPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await rename(packageStage, installedPath);
          await rm(oldPath, { recursive: true, force: true });
          receipt.packages[pkg.id] = {
            kind: pkg.kind,
            version: pkg.version,
            source: source.source,
            ...(source.commit ? { commit: source.commit } : {}),
            files: [...pkg.files],
          };
          report.installed.push(pkg.id);
        } catch (error) {
          await rm(packageStage, { recursive: true, force: true });
          report.failed.push({
            id: pkg.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (options.removeMissingDownloaded) {
        for (const [id, installed] of Object.entries(receipt.packages)) {
          if (installed.source !== "downloaded" || remoteIds.has(id) || locals.has(id)) continue;
          // An id-scoped refresh only owns that package (plus kit/authoring). Keep
          // other downloaded packages until a full refresh sees their absence.
          if (
            options.removeSelector &&
            !options.removeSelector(
              { id, kind: installed.kind, version: installed.version, files: installed.files },
              installed,
            )
          )
            continue;
          await rm(join(target, folderFor({ id, kind: installed.kind })), {
            recursive: true,
            force: true,
          });
          delete receipt.packages[id];
          report.removed.push(id);
        }
      }
      if (report.installed.length || report.removed.length || receiptChanged)
        await writeReceipt(target, receipt);
      return report;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
}

export function directorySource(root: string): PackageSource {
  return {
    source: "bundled",
    index: async () => JSON.parse(await readFile(join(root, "index.json"), "utf8")) as PresetIndex,
    file: async (pkg, path) => {
      const absolute = resolve(root, folderFor(pkg), safeRelative(path));
      const base = resolve(root);
      if (relative(base, absolute).startsWith(".."))
        throw new Error(`invalid package path: ${path}`);
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of createReadStream(absolute)) {
              controller.enqueue(new Uint8Array(chunk as Buffer));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    },
  };
}
