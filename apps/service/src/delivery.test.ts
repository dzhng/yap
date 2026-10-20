import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  truncateSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { DerivedCache, recordingCacheOwnerCheck } from "@yap/core/cache";
import { CaptureStore } from "@yap/core/capture-store";
import { DerivativeDelivery } from "./delivery.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((run) => run());
  vi.useRealTimers();
});
async function fixture(data = Buffer.from("screen evidence")) {
  const home = mkdtempSync(join(tmpdir(), "derivative-delivery-"));
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => "",
    newId: randomUUID,
  });
  const cache = new DerivedCache(store, home, recordingCacheOwnerCheck(store));
  await cache.reconcile();
  const recordingId = store.allocate().recording.id;
  const otherRecordingId = store.allocate().recording.id;
  const reservation = cache.reserve({ kind: "recording", id: recordingId });
  writeFileSync(reservation.path, data);
  const file = await cache.publish(reservation.id);
  const delivery = new DerivativeDelivery();
  cleanups.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => store.close(),
    () => delivery.dispose(),
  );
  return { home, cache, file, delivery, data, recordingId, otherRecordingId };
}
test("chunks round-trip binary bytes and any position can be retried including EOF", async () => {
  const f = await fixture(Buffer.from([0, 255, 1, 254, 2, 253, 3]));
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  const first = f.delivery.read(lease.token, 0, 3);
  expect(Buffer.from(first.data, "base64")).toEqual(f.data.subarray(0, 3));
  expect(first).toMatchObject({ offsetBytes: 0, nextOffsetBytes: 3, eof: false });
  const last = f.delivery.read(lease.token, 3, 30);
  expect(Buffer.from(last.data, "base64")).toEqual(f.data.subarray(3));
  expect(last).toMatchObject({ offsetBytes: 3, nextOffsetBytes: 7, eof: true });
  expect(f.delivery.read(lease.token, 0, 3)).toEqual(first);
  expect(f.delivery.read(lease.token, 7, 30)).toEqual({
    data: "",
    offsetBytes: 7,
    nextOffsetBytes: 7,
    eof: true,
  });
  expect(() => f.cache.remove(f.file.id)).toThrow("being read");
  f.delivery.close(lease.token);
  f.delivery.close(lease.token);
  f.cache.remove(f.file.id);
  expect(f.cache.acquire(f.file.id)).toBeNull();
});

test("a fixed expiry releases the cache without another delivery call", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  expect(lease.expiresAtMs).toBe(31_000);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(f.delivery.read(lease.token, 0, 1).data).toBe(f.data.subarray(0, 1).toString("base64"));
  await vi.advanceTimersByTimeAsync(1000);
  // Only a cache operation follows the timer; expiry cannot rely on read/open polling.
  expect(() => f.cache.remove(f.file.id)).not.toThrow();
  expect(() => f.delivery.read(lease.token, 0, 1)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED", retryable: true }),
  );
});

test("renewal retains the same bytes past the old deadline but cannot revive expired or revoked leases", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  const renewed = f.delivery.renew(lease.token);
  expect(renewed).toEqual({ ...lease, expiresAtMs: 51_000 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(Buffer.from(f.delivery.read(lease.token, 0, 100).data, "base64")).toEqual(f.data);
  expect(() => f.cache.remove(f.file.id)).toThrow("being read");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(() => f.delivery.renew(lease.token)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED", retryable: true }),
  );
  const next = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  f.delivery.revoke({ kind: "recording", id: f.recordingId });
  expect(() => f.delivery.renew(next.token)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED", retryable: true }),
  );
  f.cache.remove(f.file.id);
  expect(f.cache.acquire(f.file.id)).toBeNull();
});

test("lease limit is explicit and dispose releases every reader and refuses reopening", async () => {
  const f = await fixture();
  const leases = Array.from({ length: 32 }, () =>
    f.delivery.open({ kind: "recording", id: f.recordingId }, () => f.cache.acquire(f.file.id)),
  );
  expect(new Set(leases.map((lease) => lease.token)).size).toBe(32);
  const forbiddenAcquire = () => {
    throw new Error("Acquisition ran before admission");
  };
  expect(() => f.delivery.open({ kind: "recording", id: f.recordingId }, forbiddenAcquire)).toThrow(
    expect.objectContaining({ code: "CAPACITY_EXCEEDED", retryable: true }),
  );
  f.delivery.close(leases[0]!.token);
  f.delivery.open({ kind: "recording", id: f.recordingId }, () => f.cache.acquire(f.file.id));
  f.delivery.dispose();
  f.delivery.dispose();
  expect(() => f.cache.remove(f.file.id)).not.toThrow();
  expect(() => f.delivery.open({ kind: "recording", id: f.recordingId }, forbiddenAcquire)).toThrow(
    expect.objectContaining({ code: "OWNER_CLOSED", retryable: true }),
  );
});

test("a read past the delivery's end is refused without discarding a usable lease", async () => {
  const f = await fixture(Buffer.alloc(512 * 1024 + 1, 0xfa));
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  expect(() => f.delivery.read(lease.token, f.data.length + 1, 1)).toThrow(
    expect.objectContaining({ code: "INVALID_RANGE" }),
  );
  const first = f.delivery.read(lease.token, 0, 512 * 1024);
  const last = f.delivery.read(lease.token, first.nextOffsetBytes, 512 * 1024);
  expect(
    Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(last.data, "base64")]),
  ).toEqual(f.data);
  expect(last).toMatchObject({ nextOffsetBytes: f.data.length, eof: true });
});

test("missing cache and broken reads report expiry and release failed transfer handles", async () => {
  const f = await fixture();
  expect(() =>
    f.delivery.open({ kind: "recording", id: f.recordingId }, () => f.cache.acquire("unknown")),
  ).toThrow(expect.objectContaining({ code: "ARTIFACT_EXPIRED", retryable: true }));
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  truncateSync(f.file.path, 0);
  expect(() => f.delivery.read(lease.token, 0, 512)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
  );
  expect(() => f.cache.remove(f.file.id)).not.toThrow();
  expect(() => f.delivery.read(lease.token, 0, 1)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
  );
});

test("an empty derivative has a retryable empty EOF response", async () => {
  const f = await fixture(Buffer.alloc(0));
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  expect(f.delivery.read(lease.token, 0, 1)).toEqual({
    data: "",
    offsetBytes: 0,
    nextOffsetBytes: 0,
    eof: true,
  });
  expect(f.delivery.read(lease.token, 0, 1)).toEqual({
    data: "",
    offsetBytes: 0,
    nextOffsetBytes: 0,
    eof: true,
  });
});

test("open releases expired pins before attempting to acquire another artifact", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  vi.setSystemTime(lease.expiresAtMs);
  expect(() =>
    f.delivery.open({ kind: "recording", id: f.recordingId }, () => {
      f.cache.remove(f.file.id);
      return null;
    }),
  ).toThrow(expect.objectContaining({ code: "ARTIFACT_EXPIRED", retryable: true }));
  expect(f.cache.acquire(f.file.id)).toBeNull();
});

test("a caller-owned file outside the cache uses the same retryable chunk lease", async () => {
  const f = await fixture();
  const retained = join(f.home, "retained.png");
  const bytes = Buffer.from([12, 0, 250, 44, 255]);
  writeFileSync(retained, bytes);
  let descriptor = -1;
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () => {
    descriptor = openSync(retained, "r");
    return {
      bytes: fstatSync(descriptor).size,
      read: (buffer, position) =>
        readSync(descriptor, buffer, 0, Math.min(buffer.length, 2), position),
      release: () => closeSync(descriptor),
    };
  });
  const chunk = f.delivery.read(lease.token, 0, bytes.length);
  expect(Buffer.from(chunk.data, "base64")).toEqual(bytes);
  expect(chunk).toMatchObject({ offsetBytes: 0, nextOffsetBytes: bytes.length, eof: true });
  expect(f.delivery.read(lease.token, 0, bytes.length)).toEqual(chunk);
  f.delivery.close(lease.token);
  expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

test("a read exception closes its lease and releases the real backing pin", async () => {
  const f = await fixture();
  const failure = new Error("file read failed");
  const lease = f.delivery.open({ kind: "recording", id: f.recordingId }, () => {
    const handle = f.cache.acquire(f.file.id)!;
    return {
      ...handle,
      read: () => {
        throw failure;
      },
    };
  });
  expect(() => f.delivery.read(lease.token, 0, 1)).toThrow(failure);
  f.cache.remove(f.file.id);
  expect(f.cache.acquire(f.file.id)).toBeNull();
  expect(() => f.delivery.read(lease.token, 0, 1)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED", retryable: true }),
  );
});

test("revoking one recording releases all its leases and preserves another recording", async () => {
  const f = await fixture();
  const other = f.cache.reserve({ kind: "recording", id: f.otherRecordingId });
  writeFileSync(other.path, "other recording");
  await f.cache.publish(other.id);
  const a = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  const a2 = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  const b = f.delivery.open({ kind: "recording", id: f.otherRecordingId }, () =>
    f.cache.acquire(other.id),
  );
  f.delivery.revoke({ kind: "recording", id: f.recordingId });
  f.delivery.revoke({ kind: "recording", id: f.recordingId });
  f.delivery.revoke({ kind: "recording", id: "missing" });
  for (const lease of [a, a2])
    expect(() => f.delivery.read(lease.token, 0, 1)).toThrow(
      expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
    );
  f.cache.remove(f.file.id);
  expect(Buffer.from(f.delivery.read(b.token, 0, 100).data, "base64").toString()).toBe(
    "other recording",
  );
  expect(() => f.cache.remove(other.id)).toThrow("being read");
  f.delivery.close(b.token);
  f.cache.remove(other.id);
});

test("recording and package owners with the same ID revoke independently", async () => {
  const f = await fixture();
  const recording = f.delivery.open({ kind: "recording", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  const packageLease = f.delivery.open({ kind: "package", id: f.recordingId }, () =>
    f.cache.acquire(f.file.id),
  );
  f.delivery.revoke({ kind: "recording", id: f.recordingId });
  expect(() => f.delivery.read(recording.token, 0, 1)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
  );
  expect(Buffer.from(f.delivery.read(packageLease.token, 0, 100).data, "base64")).toEqual(f.data);
  expect(() => f.cache.remove(f.file.id)).toThrow("being read");
  f.delivery.revoke({ kind: "package", id: f.recordingId });
  expect(() => f.delivery.renew(packageLease.token)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
  );
  f.cache.remove(f.file.id);
});

test("package IDs revoke separately while renewed held-file reads survive the old deadline", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const descriptors: number[] = [];
  const acquire = (name: string, content: string) => {
    const path = join(f.home, name);
    writeFileSync(path, content);
    const fd = openSync(path, "r");
    descriptors.push(fd);
    rmSync(path);
    return {
      bytes: fstatSync(fd).size,
      read: (buffer: Uint8Array, position: number) =>
        readSync(fd, buffer, 0, buffer.length, position),
      release: () => closeSync(fd),
    };
  };
  const first = f.delivery.open({ kind: "package", id: "first" }, () =>
    acquire("first", "first package"),
  );
  const second = f.delivery.open({ kind: "package", id: "second" }, () =>
    acquire("second", "second package"),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.delivery.renew(second.token).expiresAtMs).toBe(51_000);
  f.delivery.revoke({ kind: "package", id: "first" });
  expect(() => f.delivery.renew(first.token)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
  );
  expect(() => fstatSync(descriptors[0]!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  await vi.advanceTimersByTimeAsync(10_000);
  const chunk = f.delivery.read(second.token, 0, 100);
  expect(Buffer.from(chunk.data, "base64").toString()).toBe("second package");
  expect(chunk.eof).toBe(true);
  expect(f.delivery.read(second.token, 0, 100)).toEqual(chunk);
  f.delivery.revoke({ kind: "package", id: "second" });
  expect(() => fstatSync(descriptors[1]!)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

test("a delivery retains the owner value supplied at admission", async () => {
  const f = await fixture();
  const owner: { kind: "recording" | "package"; id: string } = { kind: "package", id: "original" };
  const lease = f.delivery.open(owner, () => f.cache.acquire(f.file.id));
  owner.kind = "recording";
  owner.id = f.recordingId;
  f.delivery.revoke(owner);
  expect(Buffer.from(f.delivery.read(lease.token, 0, 100).data, "base64")).toEqual(f.data);
  f.delivery.revoke({ kind: "package", id: "original" });
  expect(() => f.delivery.read(lease.token, 0, 1)).toThrow(
    expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
  );
  f.cache.remove(f.file.id);
});

test("release callbacks cannot retarget an in-progress owner revocation", async () => {
  const f = await fixture();
  const owner = { kind: "package" as const, id: "first" };
  f.delivery.open(owner, () => {
    const handle = f.cache.acquire(f.file.id)!;
    return {
      ...handle,
      release() {
        owner.id = "second";
        handle.release();
      },
    };
  });
  const survivor = f.delivery.open({ kind: "package", id: "second" }, () =>
    f.cache.acquire(f.file.id),
  );
  f.delivery.revoke(owner);
  expect(Buffer.from(f.delivery.read(survivor.token, 0, 100).data, "base64")).toEqual(f.data);
});
