import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog, CatalogError } from "./catalog.js";
import { TranscriptBacklog, type TranscriptBacklogDriver } from "./transcript-backlog.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function backlogWith(driver: Partial<TranscriptBacklogDriver>) {
  const home = await mkdtemp(join(tmpdir(), "transcript-backlog-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(async () => catalog.close());
  const reported: unknown[] = [];
  const backlog = new TranscriptBacklog(catalog, {
    readiness: () => true,
    status: () => ({ state: "not_requested", retryable: false }),
    submit: () => {},
    report: (error) => reported.push(error),
    ...driver,
  });
  return { backlog, reported };
}

test("transcript backlog waits for readiness and admits first work", async () => {
  const selection = { assetId: "asset", streamId: "audio" };
  let ready = false;
  let status: "not_requested" | "failed" | "queued" | "ready" = "not_requested";
  let submissions = 0;
  let priority: "background" | undefined;
  const { backlog } = await backlogWith({
    readiness: () => ready,
    status: () => ({ state: status, retryable: status === "failed" }),
    submit: (_selection, submittedPriority) => {
      submissions++;
      priority = submittedPriority;
      status = "queued";
    },
  });

  backlog.enqueue(selection);
  expect(backlog.pending(selection)).toBe(true);
  backlog.drain();
  expect(submissions).toBe(0);
  expect(backlog.pending(selection)).toBe(true);

  ready = true;
  backlog.drain();
  expect(submissions).toBe(1);
  expect(priority).toBe("background");
  expect(backlog.pending(selection)).toBe(true);

  status = "queued";
  backlog.drain();
  expect(backlog.pending(selection)).toBe(true);
  status = "ready";
  backlog.drain();
  expect(backlog.pending(selection)).toBe(false);
});

test("one row's failure is reported and never stops the others or rejects the drain", async () => {
  const submitted: string[] = [];
  const { backlog, reported } = await backlogWith({
    submit: (selection) => {
      if (selection.assetId === "broken") throw new CatalogError("UNAVAILABLE", "worker offline");
      submitted.push(selection.assetId);
    },
  });
  backlog.enqueue({ assetId: "broken", streamId: "audio" });
  backlog.enqueue({ assetId: "fine", streamId: "audio" });
  expect(() => backlog.drain()).not.toThrow();
  expect(submitted).toEqual(["fine"]);
  expect(reported).toEqual([expect.objectContaining({ code: "UNAVAILABLE" })]);
  expect(backlog.pending({ assetId: "broken", streamId: "audio" })).toBe(true);
});

test("a full job queue ends the pass quietly and the next drain carries on", async () => {
  let full = true;
  const submitted: string[] = [];
  const { backlog, reported } = await backlogWith({
    submit: (selection) => {
      if (full) throw new CatalogError("CAPACITY_EXCEEDED", "queue is full");
      submitted.push(selection.assetId);
    },
  });
  backlog.enqueue({ assetId: "first", streamId: "audio" });
  backlog.enqueue({ assetId: "second", streamId: "audio" });
  expect(() => backlog.drain()).not.toThrow();
  expect(reported).toEqual([]);
  full = false;
  backlog.drain();
  expect(submitted).toEqual(["first", "second"]);
});

test("wake never rejects, even when the backlog cannot be read at all", async () => {
  const { backlog, reported } = await backlogWith({
    readiness: () => {
      throw new Error("readiness exploded");
    },
  });
  backlog.wake();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reported).toEqual([expect.objectContaining({ message: "readiness exploded" })]);
});

test.each(["failed", "canceled"] as const)(
  "%s work leaves the backlog even when retryable",
  async (state) => {
    let reads = 0;
    const selection = { assetId: "asset", streamId: "audio" };
    const { backlog } = await backlogWith({
      status: () => {
        reads++;
        return { state, retryable: true };
      },
      submit: () => {
        throw new Error("Failed work must not be submitted again");
      },
    });
    backlog.enqueue(selection);
    backlog.drain();
    expect(backlog.pending(selection)).toBe(false);
    backlog.drain();
    expect(reads).toBe(1);
  },
);
