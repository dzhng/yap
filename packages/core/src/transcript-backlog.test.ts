import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog, CatalogError } from "./catalog.js";
import { JobQueue } from "./jobs.js";
import { AssetStore } from "./assets.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
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

test("interrupted work stays owed across queue restart and resumes once", async () => {
  const home = await mkdtemp(join(tmpdir(), "backlog-restart-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const catalog = new Catalog(join(home, "original.sqlite"));
  cleanups.push(async () => catalog.close());
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const path = join(home, "audio.mov");
  await writeFile(path, "hardware fixture");
  const asset = await assets.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "audio",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000,
        segments: [{ startUs: 0, endUs: 1000, empty: false }],
      },
    ],
  }));
  const selection = { assetId: asset.id, streamId: "audio" };
  const targets = {
    pin: (target: Parameters<ConstructorParameters<typeof JobQueue>[0]["targets"]["pin"]>[0]) => {
      if (target.kind !== "asset") throw new Error("Expected asset work");
      assets.get(target.id);
      return target;
    },
    isAvailable: () => true,
    isDeleting: () => false,
    isCapturing: () => false,
  };
  let entered!: () => void, finish!: (result: string) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const queue = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets,
    execute: async () => {
      entered();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  });
  const admitted = queue.submit({
    target: { kind: "asset", id: asset.id },
    artifact: "transcript",
    lane: "heavy",
    input: "audio",
  });
  const backlog = new TranscriptBacklog(catalog, {
    readiness: () => true,
    status: () => ({ state: "processing", retryable: false }),
    submit: () => {},
    report: (error) => {
      throw error;
    },
  });
  backlog.enqueue(selection);
  await started;
  const snapshot = join(home, "restarted.sqlite");
  // Snapshot real running rows to reproduce abrupt process death without inventing stored state.
  catalog.catalog.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  finish(JSON.stringify({ transcript: "published" }));
  await queue.idle();
  await queue.close();
  const reopened = new Catalog(snapshot);
  cleanups.push(async () => reopened.close());
  let attempts = 0;
  const resumed = new JobQueue({
    store: reopened,
    providers: { newId: randomUUID },
    targets,
    execute: async () => {
      attempts++;
      return JSON.stringify({ transcript: "published" });
    },
  });
  cleanups.push(() => resumed.close());
  const jobId = admitted.jobId;
  expect(resumed.job(jobId).errorCode).toBe("JOB_INTERRUPTED");
  const pending = new TranscriptBacklog(reopened, {
    readiness: () => true,
    status: () => {
      const job = resumed.job(jobId);
      return {
        state:
          job.state === "running" ? "processing" : (job.state as "failed" | "queued" | "ready"),
        retryable: job.retryable,
        errorCode: job.errorCode,
        retryJobId: jobId,
      };
    },
    submit: (_selection, _priority, retryJobId) => {
      expect(retryJobId).toBe(jobId);
      resumed.retry(retryJobId!);
    },
    report: (error) => {
      throw error;
    },
  });
  pending.drain();
  pending.drain();
  await resumed.idle();
  pending.drain();
  expect(resumed.inspect(jobId)).toMatchObject({ state: "ready", attemptGeneration: 2 });
  expect(attempts).toBe(1);
  expect(pending.pending(selection)).toBe(false);
});
