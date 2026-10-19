import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CaptureStore } from "@yap/core/capture-store";

/**
 * Seeds one take in each discoverable lifecycle (complete, interrupted, unfinished) plus a
 * canceled take listings must hide, in creation order, while no service owns the catalog.
 */
export async function seedRecordingStates(home: string) {
  await mkdir(join(home, "library"), { recursive: true, mode: 0o700 });
  const store = new CaptureStore(join(home, "library", "catalog.sqlite"), {
    now: () => "2026-10-02T00:00:00.000Z",
    newId: randomUUID,
  });
  try {
    const complete = store.allocate().recording;
    store.ingestLifecycle(complete.id, {
      sourceId: complete.sourceId,
      sequence: 1,
      state: "recording",
    });
    store.ingestLifecycle(complete.id, {
      sourceId: complete.sourceId,
      sequence: 2,
      state: "finalizing",
    });
    store.ingestLifecycle(complete.id, {
      sourceId: complete.sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: 10_000_000,
    });
    const failed = store.allocate().recording;
    store.ingestLifecycle(failed.id, {
      sourceId: failed.sourceId,
      sequence: 1,
      state: "interrupted",
      reason: "START_FAILED",
      sourceDurationUs: null,
    });
    const unfinished = store.allocate().recording;
    const canceled = store.allocate().recording;
    store.ingestLifecycle(canceled.id, {
      sourceId: canceled.sourceId,
      sequence: 1,
      state: "canceled",
    });
    return { complete, failed, unfinished, canceled };
  } finally {
    store.close();
  }
}
