import { omit, type Omitted } from "@yap/composition";
import { setTimeout } from "node:timers/promises";
import { CatalogError } from "./catalog.js";
import type { DerivedCache } from "./cache.js";
import { copyRetainedFile } from "./files.js";

/** Heavy index workers await existing frame-lane work; only an explicit index retry retries children. */
export async function waitForIndexFrame<T extends { state: string; retryable: boolean }>(
  request: () => T,
  retry: () => T,
  retryFrames: boolean,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let status = request();
  if (retryFrames && status.retryable && !["queued", "processing", "ready"].includes(status.state))
    status = retry();
  while (status.state === "queued" || status.state === "processing") {
    await setTimeout(10, undefined, { signal });
    status = request();
  }
  signal.throwIfAborted();
  return status;
}

/** The cache lease spans copying and publication; retained indexes own independent bytes. */
export async function retainIndexFrame<T extends { cacheId: string; file: string }>(
  cache: DerivedCache,
  frame: T,
  file: string,
  signal: AbortSignal,
  publish: (retained: Omitted<T, "cacheId">) => void,
): Promise<void> {
  const lease = cache.acquire(frame.cacheId);
  if (!lease) throw new CatalogError("NOT_READY", "Picture was evicted before index retention", {});
  try {
    await copyRetainedFile(lease, file, signal);
    signal.throwIfAborted();
    publish({ ...omit(frame, "cacheId"), file });
  } finally {
    lease.release();
  }
}
