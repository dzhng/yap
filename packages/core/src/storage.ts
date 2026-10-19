import { lstat, open, opendir } from "node:fs/promises";
import { constants, lstatSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { CaptureStore, Recording } from "./capture-store.js";
import { CatalogError } from "./catalog.js";
import type { DerivedCache } from "./cache.js";
import { O_NOFOLLOW_ANY } from "./open-flags.js";

type Category =
  | "sourceBytes"
  | "evidenceBytes"
  | "cacheBytes"
  | "otherBytes"
  | "sharedBytes"
  | "modelBytes";
export type StorageUsage = Record<Category | "totalBytes", number> & {
  recordingId: string | null;
  observedAt: string;
  measurement: "live";
};
type DirectoryIdentity = { path: string; dev: bigint; ino: bigint };
type Location = {
  area: "home" | "recordings" | "recording" | "models" | "files";
  category: Category;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Actual regular-file lengths, never artifact metadata or an estimate of SQLite row ownership.
 * Without a recording catalog, retained library bytes remain shared across projects. */
export class ManagedStorage {
  private readonly home: string;
  private readonly homeIdentity: DirectoryIdentity;
  private readonly lifetime = new AbortController();
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return this.active.size > 0;
  }
  private readonly active = new Map<string | undefined, Promise<StorageUsage>>();
  constructor(
    private readonly store: CaptureStore | null,
    private readonly cache: DerivedCache,
    home: string,
    private readonly exportUsage?: (
      signal: AbortSignal,
      recordingId: string | undefined,
    ) => Promise<number>,
  ) {
    this.home = realpathSync(home);
    const stat = lstatSync(this.home, { bigint: true });
    this.homeIdentity = { path: this.home, dev: stat.dev, ino: stat.ino };
  }

  private recording(id: string): Recording | null {
    if (this.store === null) return null;
    const deleting = this.store.deleting(id);
    if (deleting) return deleting;
    try {
      return this.store.get(id);
    } catch (error) {
      if (error instanceof CatalogError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  /** Repeated requests join the same live observation, even if an earlier transport timed out. */
  usage(recordingId?: string): Promise<StorageUsage> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(new CatalogError("CANCELED", "Storage inspection is closed"));
    const existing = this.active.get(recordingId);
    if (existing) {
      try {
        if (recordingId !== undefined && !this.recording(recordingId))
          return Promise.reject(
            new CatalogError("NOT_FOUND", "Recording does not exist", { recordingId }),
          );
        return existing;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const inspection = this.inspect(recordingId);
    this.active.set(recordingId, inspection);
    const settle = () => {
      this.active.delete(recordingId);
      this.onUpdateProgress?.();
    };
    void inspection.then(settle, settle);
    return inspection;
  }

  /** No scan may retain directory/file handles or consult the catalog after this resolves. */
  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled(this.active.values());
  }

  private async inspect(recordingId?: string): Promise<StorageUsage> {
    if (process.platform !== "darwin")
      throw new CatalogError("UNSUPPORTED_PLATFORM", "Contained storage inspection requires macOS");
    // Only an existing catalog identity may turn an explicit ID into a recording path.
    const recording = recordingId === undefined ? null : this.recording(recordingId);
    if (recordingId !== undefined && !recording)
      throw new CatalogError("NOT_FOUND", "Recording does not exist", { recordingId });
    if (
      recording &&
      (basename(recording.id) !== recording.id || [".", "..", ""].includes(recording.id))
    )
      throw new CatalogError(
        "INVALID_CATALOG",
        "Recording identity is not a storage directory name",
      );
    const usage: StorageUsage = {
      recordingId: recording?.id ?? null,
      observedAt: "",
      measurement: "live",
      sourceBytes: 0,
      evidenceBytes: 0,
      cacheBytes: 0,
      otherBytes: 0,
      sharedBytes: 0,
      modelBytes: 0,
      totalBytes: 0,
    };
    const checkDirectories = async (directories: readonly DirectoryIdentity[]) => {
      this.lifetime.signal.throwIfAborted();
      for (const directory of directories) {
        this.lifetime.signal.throwIfAborted();
        const stat = await lstat(directory.path, { bigint: true });
        if (!stat.isDirectory() || stat.dev !== directory.dev || stat.ino !== directory.ino)
          throw new CatalogError(
            "STORAGE_CHANGED",
            "Managed directory changed during inspection",
            {},
          );
      }
    };
    let visited = 0;
    const count = async (
      path: string,
      category: Category,
      directories: readonly DirectoryIdentity[],
    ) => {
      try {
        await checkDirectories(directories);
        if (category === "cacheBytes") this.cache.checkRoot();
        if ((await lstat(path)).isFile()) {
          const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
          try {
            const stat = await file.stat();
            if (stat.isFile()) {
              await checkDirectories(directories);
              if (category === "cacheBytes") this.cache.checkRoot();
              if (
                !Number.isSafeInteger(stat.size) ||
                !Number.isSafeInteger(usage.totalBytes + stat.size)
              )
                throw new CatalogError(
                  "LIMIT_EXCEEDED",
                  "Storage byte total exceeds safe integer range",
                );
              usage[category] += stat.size;
              usage.totalBytes += stat.size;
            }
          } finally {
            await file.close();
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP")
          throw new CatalogError(
            "STORAGE_CHANGED",
            "Managed path became a symbolic link during inspection",
            {},
          );
        if (!missing(error)) throw error;
      }
      if (++visited % 64 === 0) await setImmediate();
    };
    const walk = async (
      path: string,
      location: Location,
      parents: readonly DirectoryIdentity[],
    ): Promise<void> => {
      if (parents.length > 64)
        throw new CatalogError("LIMIT_EXCEEDED", "Managed storage nesting exceeds 64 directories");
      try {
        await checkDirectories(parents);
        const stat = await lstat(path, { bigint: true });
        if (stat.isSymbolicLink()) return;
        if (!stat.isDirectory()) {
          await count(path, location.category, parents);
          return;
        }
        const directories =
          path === this.home ? parents : [...parents, { path, dev: stat.dev, ino: stat.ino }];
        const directory = await opendir(path, { bufferSize: 64 });
        try {
          await checkDirectories(directories);
          for (let entry = await directory.read(); entry; entry = await directory.read()) {
            this.lifetime.signal.throwIfAborted();
            const child = join(path, entry.name);
            let next: Location = { area: "files", category: location.category };
            if (this.store !== null && location.area === "home" && entry.name === "recordings")
              next = { area: "recordings", category: "sharedBytes" };
            else if (location.area === "home" && entry.name === "models")
              next = { area: "models", category: "modelBytes" };
            else if (location.area === "recordings" && this.recording(entry.name))
              next = { area: "recording", category: "otherBytes" };
            else if (location.area === "recording")
              next.category =
                entry.name === "source"
                  ? "sourceBytes"
                  : entry.name === "evidence"
                    ? "evidenceBytes"
                    : "otherBytes";
            if (entry.isDirectory()) await walk(child, next, directories);
            else {
              const category =
                location.area === "files" &&
                location.category === "sharedBytes" &&
                this.cache.ownerForFile(child)
                  ? "cacheBytes"
                  : next.category;
              await count(child, category, directories);
            }
            if (++visited % 64 === 0) await setImmediate();
          }
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    };
    try {
      if (recording) {
        const parent = join(this.home, "recordings");
        try {
          await checkDirectories([this.homeIdentity]);
          const stat = await lstat(parent, { bigint: true });
          if (stat.isDirectory())
            await walk(
              join(parent, recording.id),
              {
                area: "recording",
                category: "otherBytes",
              },
              [this.homeIdentity, { path: parent, dev: stat.dev, ino: stat.ino }],
            );
        } catch (error) {
          if (!missing(error)) throw error;
        }
        for (const path of this.cache.usageFiles({
          kind: "recording",
          id: recording.id,
        }))
          await count(path, "cacheBytes", [this.homeIdentity]);
      } else {
        await walk(this.home, { area: "home", category: "sharedBytes" }, [this.homeIdentity]);
      }
      if (this.exportUsage) {
        const bytes = await this.exportUsage(this.lifetime.signal, recordingId);
        this.lifetime.signal.throwIfAborted();
        if (
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          !Number.isSafeInteger(usage.totalBytes + bytes)
        )
          throw new CatalogError(
            "LIMIT_EXCEEDED",
            "Export storage byte total exceeds safe integer range",
          );
        usage.otherBytes += bytes;
        usage.totalBytes += bytes;
      }
    } catch (error) {
      if (this.lifetime.signal.aborted)
        throw new CatalogError("CANCELED", "Storage inspection was canceled");
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("STORAGE_IO", "Cannot inspect managed storage", {
        cause: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
      });
    }
    usage.observedAt = new Date().toISOString();
    return usage;
  }
}
