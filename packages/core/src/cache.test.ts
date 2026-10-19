import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import { DerivedCache, recordingCacheOwnerCheck, type RemoveCacheFiles } from "./cache.js";
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((run) => run()),
);
async function fixture(budget: number | null = 8) {
  const home = mkdtempSync(join(tmpdir(), "derived-cache-"));
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => "",
    newId: (() => {
      let id = 0;
      return () => `recording-${++id}`;
    })(),
  });
  cleanups.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => store.close(),
  );
  store.allocate();
  const cache = new DerivedCache(store, home, recordingCacheOwnerCheck(store), budget ?? undefined);
  await cache.reconcile();
  const removeFiles: RemoveCacheFiles = async ({ ids, root }) => {
    const directory = join(home, "cache", "derived");
    const stat = lstatSync(directory);
    expect(root).toEqual({ dev: stat.dev.toString(), ino: stat.ino.toString() });
    for (const id of ids) {
      if (basename(id) !== id) throw new Error("Fixture refuses a nonlocal cache name");
      rmSync(join(directory, `${id}.cache`), { force: true });
    }
  };
  return { home, store, cache, removeFiles };
}
async function add(cache: DerivedCache, data: string) {
  const pending = cache.reserve({ kind: "recording", id: "recording-1" });
  writeFileSync(pending.path, data, { flag: "wx" });
  return cache.publish(pending.id);
}
function read(cache: DerivedCache, id: string) {
  const handle = cache.acquire(id);
  if (!handle) return null;
  try {
    const bytes = Buffer.alloc(handle.bytes);
    handle.read(bytes, 0);
    return bytes.toString();
  } finally {
    handle.release();
  }
}
test("access changes LRU and pressure removes only the least recently read derivative", async () => {
  const { cache } = await fixture();
  const a = await add(cache, "aaaa"),
    b = await add(cache, "bbbb");
  expect(read(cache, a.id)).toBe("aaaa");
  const c = await add(cache, "cccc");
  expect(read(cache, b.id)).toBeNull();
  expect(read(cache, a.id)).toBe("aaaa");
  expect(read(cache, c.id)).toBe("cccc");
  expect(cache.bytes).toBe(8);
});

test("held reads survive pressure and deny removal until every handle releases", async () => {
  const { cache } = await fixture(4);
  const a = await add(cache, "safe");
  const first = cache.acquire(a.id)!,
    second = cache.acquire(a.id)!;
  await expect(add(cache, "next")).rejects.toThrow("active readers");
  expect(() => cache.remove(a.id)).toThrow("being read");
  const bytes = Buffer.alloc(4);
  first.read(bytes, 0);
  expect(bytes.toString()).toBe("safe");
  first.release();
  first.release();
  await expect(add(cache, "next")).rejects.toThrow("active readers");
  second.release();
  expect(read(cache, (await add(cache, "next")).id)).toBe("next");
  expect(read(cache, a.id)).toBeNull();
  expect(() => first.read(bytes, 0)).toThrow("released");
});

test("restart preserves LRU and reconciles missing, interrupted and orphan files", async () => {
  const { cache, home, store } = await fixture(8);
  const a = await add(cache, "aaaa"),
    b = await add(cache, "bbbb");
  expect(read(cache, a.id)).toBe("aaaa");
  const pending = cache.reserve({ kind: "recording", id: "recording-1" });
  writeFileSync(pending.path, "partial");
  const reopened = new DerivedCache(store, home, recordingCacheOwnerCheck(store), 8);
  await reopened.reconcile();
  const c = await add(reopened, "cccc");
  expect(read(reopened, b.id)).toBeNull();
  expect(read(reopened, a.id)).toBe("aaaa");
  rmSync(c.path);
  const again = new DerivedCache(store, home, recordingCacheOwnerCheck(store), 8);
  await again.reconcile();
  expect(again.bytes).toBe(4);
  expect(read(again, c.id)).toBeNull();
  await expect(again.publish(pending.id)).rejects.toThrow("No cache reservation");
});

test("oversized output and aliased files cannot consume cache or alter source", async () => {
  const { cache, home } = await fixture(4);
  const source = join(home, "source.mov");
  writeFileSync(source, "original");
  const kept = await add(cache, "keep");
  const big = cache.reserve({ kind: "recording", id: "recording-1" });
  writeFileSync(big.path, "too large");
  await expect(cache.publish(big.id)).rejects.toThrow("exceeds cache budget");
  expect(existsSync(big.path)).toBe(false);
  expect(read(cache, kept.id)).toBe("keep");
  const hard = cache.reserve({ kind: "recording", id: "recording-1" });
  linkSync(source, hard.path);
  await expect(cache.publish(hard.id)).rejects.toThrow("independent regular file");
  const symbolic = cache.reserve({ kind: "recording", id: "recording-1" });
  symlinkSync(source, symbolic.path);
  await expect(cache.publish(symbolic.id)).rejects.toThrow();
  cache.remove(symbolic.id);
  expect(readFileSync(source, "utf8")).toBe("original");
  expect(cache.bytes).toBe(4);
  expect(() => cache.remove("../../source.mov")).not.toThrow();
});

test("startup interruption is retryable, yields, and never reconciles an active producer", async () => {
  const { cache, home, store } = await fixture(200);
  for (let i = 0; i < 140; i++) await add(cache, "a");
  const reopened = new DerivedCache(store, home, recordingCacheOwnerCheck(store), 200);
  expect(() => reopened.reserve({ kind: "recording", id: "recording-1" })).toThrow(
    "reconciliation",
  );
  const controller = new AbortController();
  const scanning = reopened.reconcile(controller.signal);
  setImmediate(() => controller.abort());
  await expect(scanning).rejects.toThrow();
  expect(() => reopened.acquire("anything")).toThrow("reconciliation");
  await reopened.reconcile();
  expect(reopened.bytes).toBe(140);
});

test("cache ancestors cannot redirect deletion or publication into source directories", async () => {
  const { home, store } = await fixture();
  const source = join(home, "recordings");
  mkdirSync(source);
  const sourceFile = join(source, "video.mov");
  writeFileSync(sourceFile, "source");
  rmSync(join(home, "cache"), { recursive: true });
  symlinkSync(source, join(home, "cache"));
  expect(() => new DerivedCache(store, home, recordingCacheOwnerCheck(store))).toThrow(
    "must not be a link",
  );
  expect(readFileSync(sourceFile, "utf8")).toBe("source");
});

test("concurrent publications share the budget instead of each spending free capacity", async () => {
  const { cache } = await fixture(4);
  const [a, b] = await Promise.all([add(cache, "aaaa"), add(cache, "bbbb")]);
  expect(cache.bytes).toBe(4);
  expect(read(cache, a.id)).toBeNull();
  expect(read(cache, b.id)).toBe("bbbb");
});

test("more than one eviction batch of held files terminates with pressure instead of spinning", async () => {
  const { cache } = await fixture(70);
  const handles = [];
  for (let i = 0; i < 70; i++) handles.push(cache.acquire((await add(cache, "x")).id)!);
  try {
    await expect(add(cache, "y")).rejects.toThrow("active readers");
  } finally {
    handles.forEach((handle) => handle.release());
  }
});

test("eviction progresses past a batch of readers to a later disposable file", async () => {
  const { cache } = await fixture(71);
  const handles = [];
  for (let i = 0; i < 70; i++) handles.push(cache.acquire((await add(cache, "x")).id)!);
  try {
    const disposable = await add(cache, "d");
    const replacement = await add(cache, "r");
    expect(read(cache, disposable.id)).toBeNull();
    expect(read(cache, replacement.id)).toBe("r");
    expect(cache.bytes).toBe(71);
  } finally {
    handles.forEach((handle) => handle.release());
  }
});

test("reopening the catalog retains cache content and LRU, removing only owned orphan names", async () => {
  const home = mkdtempSync(join(tmpdir(), "derived-reopen-"));
  const connect = () =>
    new CaptureStore(join(home, "library.sqlite"), {
      now: () => "",
      newId: (() => {
        let id = 0;
        return () => `recording-${++id}`;
      })(),
    });
  let store = connect();
  cleanups.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => store.close(),
  );
  store.allocate();
  let cache = new DerivedCache(store, home, recordingCacheOwnerCheck(store), 8);
  await cache.reconcile();
  const a = await add(cache, "aaaa"),
    b = await add(cache, "bbbb");
  read(cache, a.id);
  const orphan = join(home, "cache", "derived", "11111111-1111-1111-1111-111111111111.cache");
  writeFileSync(orphan, "orphan");
  const unrelated = join(home, "cache", "derived", "notes.txt");
  writeFileSync(unrelated, "keep");
  store.close();
  store = connect();
  cache = new DerivedCache(store, home, recordingCacheOwnerCheck(store), 8);
  await cache.reconcile();
  expect(read(cache, a.id)).toBe("aaaa");
  await add(cache, "cccc");
  expect(read(cache, b.id)).toBeNull();
  expect(existsSync(orphan)).toBe(false);
  expect(readFileSync(unrelated, "utf8")).toBe("keep");
});

test("recording purge removes published and pending files, preserving sibling readers", async () => {
  const { cache, store, removeFiles } = await fixture(100);
  const sibling = store.allocate().recording.recordingId;
  const a = await add(cache, "deleted");
  const pending = cache.reserve({ kind: "recording", id: "recording-1" });
  writeFileSync(pending.path, "unfinished");
  const b = cache.reserve({ kind: "recording", id: sibling });
  writeFileSync(b.path, "sibling");
  await cache.publish(b.id);
  const reader = cache.acquire(b.id)!;
  await cache.purgeOwner({ kind: "recording", id: "recording-1" }, removeFiles);
  expect(existsSync(a.path)).toBe(false);
  expect(existsSync(pending.path)).toBe(false);
  await expect(cache.publish(pending.id)).rejects.toThrow("No cache reservation");
  const bytes = Buffer.alloc(7);
  reader.read(bytes, 0);
  expect(bytes.toString()).toBe("sibling");
  reader.release();
  expect(read(cache, b.id)).toBe("sibling");
  await cache.purgeOwner({ kind: "recording", id: "recording-1" }, removeFiles);
  await cache.purgeOwner({ kind: "recording", id: "unknown" }, removeFiles);
  expect(cache.bytes).toBe(7);
});

test("purge refuses pinned recording bytes and retries without releasing unrelated pins", async () => {
  const { cache, store, removeFiles } = await fixture(100);
  const sibling = store.allocate().recording.recordingId;
  const a = await add(cache, "target");
  const b = cache.reserve({ kind: "recording", id: sibling });
  writeFileSync(b.path, "sibling");
  await cache.publish(b.id);
  const targetRead = cache.acquire(a.id)!,
    siblingRead = cache.acquire(b.id)!;
  await expect(
    cache.purgeOwner({ kind: "recording", id: "recording-1" }, removeFiles),
  ).rejects.toMatchObject({
    code: "CACHE_BUSY",
    retryable: true,
  });
  expect(readFileSync(a.path, "utf8")).toBe("target");
  expect(read(cache, a.id)).toBe("target");
  targetRead.release();
  await cache.purgeOwner({ kind: "recording", id: "recording-1" }, removeFiles);
  expect(existsSync(a.path)).toBe(false);
  const bytes = Buffer.alloc(7);
  siblingRead.read(bytes, 0);
  expect(bytes.toString()).toBe("sibling");
  siblingRead.release();
});

test("purge yields across reservations and serializes already queued and late publication", async () => {
  const { cache, removeFiles } = await fixture(200);
  const pending = [];
  for (let i = 0; i < 130; i++) {
    const output = cache.reserve({ kind: "recording", id: "recording-1" });
    writeFileSync(output.path, `partial-${i}`);
    pending.push(output);
  }
  const publication = cache.publish(pending[0]!.id);
  let heartbeat = false;
  setImmediate(() => {
    heartbeat = true;
  });
  await cache.purgeOwner({ kind: "recording", id: "recording-1" }, removeFiles);
  await publication;
  expect(heartbeat).toBe(true);
  for (const output of pending) expect(existsSync(output.path)).toBe(false);
  await expect(cache.publish(pending[0]!.id)).rejects.toThrow("No cache reservation");
  expect(cache.bytes).toBe(0);
});

test("reservations reject missing owners and retain their owner after reopening", async () => {
  const { cache, home, store, removeFiles } = await fixture(100);
  expect(() => cache.reserve({ kind: "recording", id: "missing" })).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  const owner = store.allocate().recording.recordingId;
  const first = await add(cache, "first");
  const second = cache.reserve({ kind: "recording", id: owner });
  writeFileSync(second.path, "second");
  await cache.publish(second.id);
  const reopened = new DerivedCache(store, home, recordingCacheOwnerCheck(store), 100);
  await reopened.reconcile();
  await reopened.purgeOwner({ kind: "recording", id: owner }, removeFiles);
  expect(read(reopened, second.id)).toBeNull();
  expect(read(reopened, first.id)).toBe("first");
});

test("failed file removal retains cache ownership for retry", async () => {
  const { cache, store, removeFiles } = await fixture(100);
  const output = await add(cache, "retry-me");
  store.markDeleting("recording-1");
  await expect(
    cache.purgeOwner({ kind: "recording", id: "recording-1" }, async () => {
      throw new Error("removal failed");
    }),
  ).rejects.toThrow("removal failed");
  expect(readFileSync(output.path, "utf8")).toBe("retry-me");
  expect(
    store.catalog
      .prepare("SELECT id, ownerKind, ownerId FROM derived_cache WHERE id=?")
      .get(output.id),
  ).toEqual({ id: output.id, ownerKind: "recording", ownerId: "recording-1" });
  await cache.purgeOwner({ kind: "recording", id: "recording-1" }, removeFiles);
  expect(existsSync(output.path)).toBe(false);
  expect(
    store.catalog.prepare("SELECT id FROM derived_cache WHERE id=?").get(output.id),
  ).toBeUndefined();
});

test("the default cache publishes and reads a sparse artifact larger than one GiB", async () => {
  const { cache } = await fixture(null);
  const pending = cache.reserve({ kind: "recording", id: "recording-1" });
  const bytes = 1024 ** 3 + 4096;
  const fd = openSync(pending.path, "wx");
  try {
    ftruncateSync(fd, bytes);
    writeSync(fd, Buffer.from("tail"), 0, 4, bytes - 4);
  } finally {
    closeSync(fd);
  }
  const published = await cache.publish(pending.id);
  expect(published.bytes).toBe(bytes);
  const handle = cache.acquire(published.id)!;
  try {
    const tail = Buffer.alloc(4);
    expect(handle.read(tail, bytes - 4)).toBe(4);
    expect(tail.toString()).toBe("tail");
  } finally {
    handle.release();
  }
});

test("capacity checks neither reserve bytes nor evict held files", async () => {
  const { cache } = await fixture(4);
  const file = await add(cache, "held");
  const held = cache.acquire(file.id)!;
  try {
    cache.checkCapacity(4);
    expect(cache.bytes).toBe(4);
    expect(() => cache.checkCapacity(5)).toThrow("exceeds cache budget");
    for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => cache.checkCapacity(size)).toThrow("Invalid derivative size");
    await expect(add(cache, "next")).rejects.toThrow("active readers");
    expect(read(cache, file.id)).toBe("held");
  } finally {
    held.release();
  }
});
