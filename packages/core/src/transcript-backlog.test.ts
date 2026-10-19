import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { TranscriptBacklog } from "./transcript-backlog.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("transcript backlog waits for readiness and resubmits retryable failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "transcript-backlog-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(async () => catalog.close());
  const selection = { assetId: "asset", streamId: "audio" };
  let ready = false;
  let status: "not_requested" | "failed" | "queued" | "ready" = "not_requested";
  let submissions = 0;
  let priority: "background" | undefined;
  let retries = 0;
  const backlog = new TranscriptBacklog(catalog, {
    readiness: () => ready,
    status: () => ({ state: status, retryable: status === "failed" }),
    submit: (_selection, submittedPriority) => {
      submissions++;
      priority = submittedPriority;
      status = "queued";
    },
    retry: () => {
      retries++;
      status = "queued";
    },
  });

  backlog.enqueue(selection);
  expect(backlog.state(selection)).toBe("pending");
  await backlog.drain();
  expect(submissions).toBe(0);
  expect(backlog.state(selection)).toBe("pending");

  ready = true;
  await backlog.drain();
  expect(submissions).toBe(1);
  expect(priority).toBe("background");
  expect(backlog.state(selection)).toBe("submitted");

  status = "failed";
  await backlog.drain();
  expect(retries).toBe(1);

  status = "queued";
  await backlog.drain();
  status = "not_requested";
  await backlog.drain();
  expect(backlog.state(selection)).toBe("submitted");
  status = "queued";
  await backlog.drain();
  status = "ready";
  await backlog.drain();
  expect(backlog.state(selection)).toBe("none");
});
