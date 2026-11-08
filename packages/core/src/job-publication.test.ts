import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Catalog } from "./catalog.js";
import { JobQueue, type JobExecutor } from "./jobs.js";
import { issueLimit, type Issue } from "@yap/composition";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(execute: JobExecutor) {
  const home = mkdtempSync("/tmp/prepared-publication-");
  const store = new Catalog(join(home, "catalog.sqlite"));
  store.catalog.exec("CREATE TABLE published(value TEXT) STRICT");
  const queue = new JobQueue({
    store,
    providers: { newId: randomUUID },
    execute,
    targets: {
      pin: (target) => {
        if (target.kind !== "project") throw Error("project");
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
  });
  cleanup.push(async () => {
    await queue.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const request = {
    target: { kind: "project" as const, id: "p", revisionId: "r" },
    artifact: "prepared-audio",
    input: "recipe",
    lane: "heavy" as const,
  };
  return { store, queue, request };
}
test("staged publication and queue readiness roll back together", async () => {
  let closed = false;
  const f = fixture(async () => ({
    result: "exact result",
    publish: () => {
      f.store.catalog.prepare("INSERT INTO published VALUES(?)").run("must roll back");
      throw Error("publication refused");
    },
    close: async () => {
      closed = true;
    },
  }));
  f.queue.submit(f.request);
  await f.queue.idle();
  expect(f.queue.status(f.request)).toMatchObject({ state: "failed", published: null });
  expect(f.store.catalog.prepare("SELECT * FROM published").all()).toEqual([]);
  expect(closed).toBe(true);
});

test("canceled stale completion cannot publish after a replacement and closes before releasing attempt", async () => {
  const reached = gate(),
    execution = gate(),
    closing = gate(),
    finishClose = gate();
  let starts = 0,
    closed = 0;
  const f = fixture(async () => {
    const ordinal = ++starts;
    if (ordinal === 1) {
      reached.resolve();
      await execution.promise;
    }
    return {
      result: String(ordinal),
      publish: () => {
        f.store.catalog.prepare("INSERT INTO published VALUES(?)").run(String(ordinal));
        return undefined;
      },
      close: async () => {
        if (ordinal === 1) {
          closing.resolve();
          await finishClose.promise;
        }
        closed++;
      },
    };
  });
  try {
    const first = f.queue.submit(f.request);
    await reached.promise;
    f.queue.cancel(first.jobId);
    f.queue.retry(first.jobId);
    execution.resolve();
    await closing.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toBe(1);
    expect(f.queue.status(f.request).state).toBe("queued");
    expect(f.store.catalog.prepare("SELECT value FROM published").all()).toEqual([]);
  } finally {
    execution.resolve();
    finishClose.resolve();
  }
  await f.queue.idle();
  expect(f.queue.status(f.request)).toMatchObject({ state: "ready", published: { result: "2" } });
  expect(f.store.catalog.prepare("SELECT value FROM published").all()).toEqual([{ value: "2" }]);
  expect(closed).toBe(2);
});

const numberedIssue = (number: number): Issue => ({
  code: "caption-omitted",
  message: `Caption c${number} was omitted`,
  evidence: { placementId: `c${number}`, reason: "empty-text" },
});

test("issues publish with their output, roll back with it, and are replaced by the next generation", async () => {
  const attempts: { issues: Issue[]; refuse?: boolean }[] = [
    { issues: [numberedIssue(1)], refuse: true },
    { issues: [numberedIssue(2), numberedIssue(3)] },
    { issues: [] },
  ];
  const f = fixture(async () => {
    const attempt = attempts.shift()!;
    return {
      result: JSON.stringify("output"),
      issues: attempt.issues,
      publish: () => {
        if (attempt.refuse) throw Error("publication refused");
        return undefined;
      },
      close: async () => {},
    };
  });
  const { jobId } = f.queue.submit(f.request);
  await f.queue.idle();
  expect(f.queue.status(f.request)).toMatchObject({ state: "failed", published: null });
  expect(f.store.catalog.prepare("SELECT * FROM output_issues").all()).toEqual([]);

  f.queue.retry(jobId);
  await f.queue.idle();
  const ready = f.queue.status(f.request);
  expect(ready.published?.issues).toEqual([numberedIssue(2), numberedIssue(3)]);
  expect(f.queue.inspect(jobId).published?.issues).toEqual([numberedIssue(2), numberedIssue(3)]);

  f.queue.regenerate(jobId, ready.published!.generation);
  await f.queue.idle();
  expect(f.queue.status(f.request)).toMatchObject({ state: "ready", published: { issues: [] } });
  expect(f.store.catalog.prepare("SELECT * FROM output_issues").all()).toEqual([]);
});

test("stored issues are bounded, ending in the count of what was omitted", async () => {
  const f = fixture(async () => ({
    result: JSON.stringify("output"),
    issues: Array.from({ length: issueLimit + 5 }, (_, index) => numberedIssue(index + 1)),
    publish: () => undefined,
    close: async () => {},
  }));
  f.queue.submit(f.request);
  await f.queue.idle();
  const issues = f.queue.status(f.request).published!.issues;
  expect(issues).toHaveLength(issueLimit + 1);
  expect(issues[issueLimit - 1]).toEqual(numberedIssue(issueLimit));
  expect(issues.at(-1)).toMatchObject({ code: "issues-truncated", evidence: { omitted: 5 } });
});

test("a catalog written before issue storage opens and reads its publications as clean", async () => {
  const f = fixture(async () => JSON.stringify("output"));
  const { jobId } = f.queue.submit(f.request);
  await f.queue.idle();
  await f.queue.close();
  f.store.catalog.exec("DROP TABLE output_issues");
  const reopened = new JobQueue({
    store: f.store,
    providers: { newId: randomUUID },
    execute: async () => "unused",
    targets: {
      pin: (target) => target as never,
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
  });
  cleanup.push(() => reopened.close());
  expect(reopened.status(f.request)).toMatchObject({ state: "ready", published: { issues: [] } });
  expect(reopened.inspect(jobId).published?.issues).toEqual([]);
});
