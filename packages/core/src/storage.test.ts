import { afterEach, expect, test, vi } from "vitest";
import * as filesystem from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { CaptureStore } from "./capture-store.js";
import { DerivedCache, recordingCacheOwnerCheck } from "./cache.js";
import { ManagedStorage } from "./storage.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(cacheBudget?: number) {
  const home = await mkdtemp("/tmp/yap-storage-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => "fixture",
    newId: randomUUID,
  });
  cleanups.push(() => store.close());
  const cache = new DerivedCache(store, home, recordingCacheOwnerCheck(store), cacheBudget);
  await cache.reconcile();
  const storage = new ManagedStorage(store, cache, home);
  cleanups.push(() => storage.close());
  const take = store.allocate().recording;
  async function file(path: string, bytes: number) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes, 65));
    return path;
  }
  return { home, store, cache, storage, take, file };
}

test("actual usage includes partial, canceled and deleting bytes and separates shared ownership", async () => {
  const { home, store, cache, storage, take, file } = await fixture();
  const root = join(home, "recordings", take.id);
  await file(join(root, "source", "unfinished.mov"), 17);
  await file(join(root, "evidence", "staging", "unpublished.jsonl"), 19);
  await file(join(root, "unclassified.bin"), 7);
  const pending = cache.reserve({ kind: "recording", id: take.id });
  await file(pending.path, 13);
  const ready = cache.reserve({ kind: "recording", id: take.id });
  await file(ready.path, 11);
  await cache.publish(ready.id);
  // Actual bytes can differ from metadata while a producer is still writing.
  await writeFile(pending.path, Buffer.alloc(23));
  const canceled = store.allocate().recording;
  store.ingestLifecycle(canceled.id, {
    sourceId: canceled.sourceId,
    sequence: 1,
    state: "canceled",
  });
  await file(join(home, "recordings", canceled.id, "source", "leftover.mov"), 29);
  const failed = store.allocate().recording;
  store.ingestLifecycle(failed.id, {
    sourceId: failed.sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "NO_VIDEO",
    sourceDurationUs: null,
  });
  await file(join(home, "recordings", failed.id, "source", "journal.jsonl"), 31);
  await file(join(home, "recordings", "no-catalog-owner", "lost.bin"), 37);
  await file(join(home, "cache", "derived", "unattributed.tmp"), 41);
  await file(join(home, "models", "weights.bin"), 1000);
  store.markDeleting(take.id);
  const one = await storage.usage(take.id);
  expect(one).toMatchObject({
    recordingId: take.id,
    sourceBytes: 17,
    evidenceBytes: 19,
    cacheBytes: 34,
    otherBytes: 7,
    sharedBytes: 0,
    modelBytes: 0,
    totalBytes: 77,
    measurement: "live",
  });
  expect(Number.isNaN(Date.parse(one.observedAt))).toBe(false);
  expect((await storage.usage(canceled.id)).totalBytes).toBe(29);
  expect((await storage.usage(failed.id)).sourceBytes).toBe(31);
  const all = await storage.usage();
  let databaseBytes = 0;
  for (const name of ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"]) {
    try {
      databaseBytes += (await lstat(join(home, name))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  expect(all).toMatchObject({
    recordingId: null,
    sourceBytes: 77,
    evidenceBytes: 19,
    cacheBytes: 34,
    otherBytes: 7,
    sharedBytes: databaseBytes + 78,
    modelBytes: 1000,
    totalBytes: databaseBytes + 1215,
  });
  expect(await readFile(pending.path)).toHaveLength(23);
});

test("symlinked files and directories never import external bytes", async () => {
  const { home, storage, take, file } = await fixture();
  const external = await mkdtemp("/tmp/yap-storage-external-");
  cleanups.push(() => rm(external, { recursive: true, force: true }));
  const sentinel = await file(join(external, "sentinel"), 511);
  const source = join(home, "recordings", take.id, "source");
  await file(join(source, "own"), 3);
  await symlink(sentinel, join(source, "linked-file"));
  await symlink(external, join(source, "linked-directory"));
  await symlink(external, join(home, "linked-export"));
  expect((await storage.usage(take.id)).sourceBytes).toBe(3);
  const aggregate = await storage.usage();
  expect(aggregate.sourceBytes).toBe(3);
  expect(aggregate.otherBytes).toBe(0);
  expect(await readFile(sentinel)).toHaveLength(511);
});

test("a never-allocated ID cannot inspect a same-named directory", async () => {
  const { home, storage, file } = await fixture();
  await file(join(home, "recordings", "unknown", "source", "secret"), 73);
  await expect(storage.usage("unknown")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(storage.usage("../../models")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("large file and reservation inventories yield while unrelated catalog reads keep working", async () => {
  const { home, store, cache, storage, take, file } = await fixture();
  const other = store.allocate().recording;
  for (let i = 0; i < 350; i++) {
    await file(join(home, "recordings", take.id, "evidence", `${i}.json`), 2);
    await file(cache.reserve({ kind: "recording", id: take.id }).path, 3);
  }
  let done = false,
    reads = 0;
  const scanning = storage.usage(take.id).finally(() => {
    done = true;
  });
  while (!done) {
    expect(store.get(other.id).sourceId).toBe(other.sourceId);
    reads++;
    await setImmediate();
  }
  expect(reads).toBeGreaterThan(1);
  expect(await scanning).toMatchObject({ evidenceBytes: 700, cacheBytes: 1050, totalBytes: 1750 });
});

test("disappearing files are a live observation, while unexpected I/O failure is explicit", async () => {
  const { home, storage, take, file } = await fixture();
  const source = join(home, "recordings", take.id, "source");
  const temporary = await file(join(source, "temporary"), 17);
  const pending = storage.usage(take.id);
  await rm(temporary);
  expect([0, 17]).toContain((await pending).sourceBytes);
  const denied = join(source, "unreadable");
  await mkdir(denied);
  await chmod(denied, 0);
  try {
    await expect(storage.usage(take.id)).rejects.toMatchObject({
      code: "STORAGE_IO",
      details: { cause: "EACCES" },
    });
  } finally {
    await chmod(denied, 0o700);
  }
});

test("a directory replaced by an external symlink mid-scan cannot contribute bytes", async () => {
  const { home, storage, take, file } = await fixture();
  const source = join(home, "recordings", take.id, "source");
  await file(join(source, "a"), 3);
  await file(join(source, "b"), 5);
  const external = await mkdtemp("/tmp/yap-storage-swap-");
  cleanups.push(() => rm(external, { recursive: true, force: true }));
  await file(join(external, "a"), 511);
  await file(join(external, "b"), 512);
  const { lstat: readStat } =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let swapped = false;
  vi.mocked(filesystem.lstat).mockImplementation(async (path, options) => {
    const result = await readStat(path, options);
    if (!swapped && String(path).endsWith(`/source/a`) && result.isFile()) {
      swapped = true;
      await rename(source, source + "-retained");
      await symlink(external, source);
    }
    return result;
  });
  try {
    await expect(storage.usage(take.id)).rejects.toMatchObject({
      code: "STORAGE_CHANGED",
    });
  } finally {
    vi.mocked(filesystem.lstat).mockImplementation(readStat);
  }
  expect(swapped).toBe(true);
  expect(await readFile(join(external, "b"))).toHaveLength(512);
});

test.each(["lstat", "open"] as const)(
  "a transient ancestor symlink at %s cannot supply external bytes",
  async (edge) => {
    const { home, storage, take, file } = await fixture();
    const source = join(home, "recordings", take.id, "source");
    await file(join(source, "a"), 3);
    const external = await mkdtemp("/tmp/yap-storage-transient-");
    cleanups.push(() => rm(external, { recursive: true, force: true }));
    await file(join(external, "a"), 511);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let swapped = false;
    const replaceDuring = async <T>(path: unknown, read: () => Promise<T>): Promise<T> => {
      if (swapped || !String(path).endsWith("/source/a")) return read();
      swapped = true;
      await rename(source, source + "-retained");
      await symlink(external, source);
      try {
        return await read();
      } finally {
        await rm(source);
        await rename(source + "-retained", source);
      }
    };
    if (edge === "lstat")
      vi.mocked(filesystem.lstat).mockImplementation((path, options) =>
        replaceDuring(path, () => actual.lstat(path, options)),
      );
    else
      vi.mocked(filesystem.open).mockImplementation((path, flags, mode) =>
        replaceDuring(path, () => actual.open(path, flags, mode)),
      );
    try {
      if (edge === "lstat") expect((await storage.usage(take.id)).sourceBytes).toBe(3);
      else
        await expect(storage.usage(take.id)).rejects.toMatchObject({
          code: "STORAGE_CHANGED",
        });
    } finally {
      vi.mocked(filesystem.lstat).mockImplementation(actual.lstat);
      vi.mocked(filesystem.open).mockImplementation(actual.open);
    }
    expect(swapped).toBe(true);
    expect(await readFile(join(external, "a"))).toHaveLength(511);
  },
);

test("shutdown cancels and drains held file inspection before the catalog may close", async () => {
  const { home, storage, take, file } = await fixture();
  await file(join(home, "recordings", take.id, "source", "held"), 3);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let descriptor: Awaited<ReturnType<typeof actual.open>> | undefined;
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path).endsWith("/source/held")) {
      descriptor = handle;
      entered();
      await held;
    }
    return handle;
  });
  const inspection = storage.usage(take.id);
  const canceled = expect(inspection).rejects.toMatchObject({ code: "CANCELED" });
  await opened;
  let stopped = false;
  const closing = storage.close().then(() => {
    stopped = true;
  });
  try {
    await setImmediate();
    expect(stopped).toBe(false);
    await expect(storage.usage()).rejects.toMatchObject({ code: "CANCELED" });
  } finally {
    release();
    vi.mocked(filesystem.open).mockImplementation(actual.open);
    await canceled;
    await closing;
  }
  expect(stopped).toBe(true);
  expect(descriptor).toBeDefined();
  await expect(descriptor!.stat()).rejects.toMatchObject({ code: "EBADF" });
});

test("same-scope retries join a held observation while another recording stays readable", async () => {
  const { home, store, storage, take, file } = await fixture();
  const target = await file(join(home, "recordings", take.id, "source", "held"), 3);
  const sibling = store.allocate().recording;
  await file(join(home, "recordings", sibling.id, "source", "other"), 7);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opens = 0;
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path).endsWith(`/${take.id}/source/held`)) {
      opens++;
      entered();
      await held;
    }
    return handle;
  });
  const first = storage.usage();
  let retry: ReturnType<typeof storage.usage> | undefined;
  try {
    await opened;
    // A transport may have dropped the first waiter, but the observation still owns this file.
    retry = storage.usage();
    expect((await storage.usage(sibling.id)).sourceBytes).toBe(7);
    await setImmediate();
    expect(opens).toBe(1);
    release();
    const [original, joined] = await Promise.all([first, retry]);
    expect(joined).toEqual(original);
    expect(joined.sourceBytes).toBe(10);
    await writeFile(target, Buffer.alloc(11));
    expect((await storage.usage()).sourceBytes).toBe(18);
    expect(opens).toBe(2);
  } finally {
    release();
    await Promise.allSettled([first, ...(retry ? [retry] : [])]);
    vi.mocked(filesystem.open).mockImplementation(actual.open);
  }
});

test("a failed shared observation releases its scope for a fresh retry", async () => {
  const { home, storage, take, file } = await fixture();
  await file(join(home, "recordings", take.id, "source", "retry"), 13);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    if (String(path).endsWith("/source/retry"))
      throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return actual.open(path, flags, mode);
  });
  try {
    const requests = [storage.usage(take.id), storage.usage(take.id)];
    for (const answer of await Promise.allSettled(requests)) {
      expect(answer).toMatchObject({
        status: "rejected",
        reason: { code: "STORAGE_IO", details: { cause: "EACCES" } },
      });
    }
  } finally {
    vi.mocked(filesystem.open).mockImplementation(actual.open);
  }
  expect((await storage.usage(take.id)).sourceBytes).toBe(13);
});

test("completed deletion refuses a new per-record waiter even while an older observation closes", async () => {
  const { home, store, storage, take, file } = await fixture();
  const directory = join(home, "recordings", take.id);
  await file(join(directory, "source", "held"), 3);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path).endsWith("/source/held")) {
      entered();
      await held;
    }
    return handle;
  });
  const first = storage.usage(take.id);
  void first.catch(() => {});
  try {
    await opened;
    store.markDeleting(take.id);
    const marked = storage.usage(take.id);
    void marked.catch(() => {});
    await rm(directory, { recursive: true });
    store.finishDeletion(take.id);
    const next = storage.usage(take.id);
    // Release only after attaching the assertion; the new request cannot borrow stale identity.
    const refused = expect(next).rejects.toMatchObject({ code: "NOT_FOUND" });
    release();
    await refused;
    await expect(marked).resolves.toMatchObject({ recordingId: take.id });
  } finally {
    release();
    await Promise.allSettled([first]);
    vi.mocked(filesystem.open).mockImplementation(actual.open);
  }
});

test("live inspection tolerates actual LRU eviction while preserving another recording's new file", async () => {
  const { store, cache, storage, take, file } = await fixture(5);
  const old = cache.reserve({ kind: "recording", id: take.id });
  await file(old.path, 3);
  await cache.publish(old.id);
  const sibling = store.allocate().recording;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const opening = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
    if (String(path) === old.path) {
      entered();
      await held;
    }
    return actual.open(path, flags, mode);
  });
  const inspection = storage.usage(take.id);
  void inspection.catch(() => {});
  try {
    await opening;
    const next = cache.reserve({ kind: "recording", id: sibling.id });
    await file(next.path, 4);
    // Publishing through the real owner exceeds its budget and evicts the oldest unpinned file.
    await cache.publish(next.id);
    await expect(actual.lstat(old.path)).rejects.toMatchObject({ code: "ENOENT" });
    release();
    await expect(inspection).resolves.toMatchObject({ cacheBytes: 0, totalBytes: 0 });
    expect((await storage.usage(sibling.id)).cacheBytes).toBe(4);
    expect(await readFile(next.path)).toEqual(Buffer.alloc(4, 65));
  } finally {
    release();
    await Promise.allSettled([inspection]);
    vi.mocked(filesystem.open).mockImplementation(actual.open);
  }
});

test("shared-library aggregation counts registered cache bytes and retains unowned partial bytes", async () => {
  const { home, store, cache, take, file } = await fixture();
  const storage = new ManagedStorage(null, cache, home);
  cleanups.push(() => storage.close());
  const first = await storage.usage();
  await file(join(home, "assets", "retained.bin"), 11);
  await file(join(home, "recordings", take.id, "source", "residue.bin"), 13);
  const cached = cache.reserve({ kind: "recording", id: take.id });
  await file(cached.path, 17);
  await file(join(home, "cache", "derived", "unregistered.tmp"), 19);
  await file(join(home, "models", "weights.bin"), 1000);
  const outside = await mkdtemp("/tmp/storage-donor-");
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await file(join(outside, "media.bin"), 2000);
  await symlink(outside, join(home, "linked-donor"));
  expect(await storage.usage()).toMatchObject({
    recordingId: null,
    sourceBytes: 0,
    evidenceBytes: 0,
    cacheBytes: 17,
    sharedBytes: first.sharedBytes + 43,
    modelBytes: 1000,
    totalBytes: first.totalBytes + 1060,
  });
  await expect(storage.usage(take.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(store.get(take.id).id).toBe(take.id);
});
