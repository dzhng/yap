import { omit } from "@yap/composition";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DerivedCache } from "./cache.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import { ResourceReferences } from "./references.js";
import { CaptureStore, isSettled } from "./capture-store.js";
import { AssetStore } from "./assets.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { Catalog, CatalogError } from "./catalog.js";
import {
  JobDependencyLost,
  JobQueue,
  type Job,
  type JobExecutor,
  type ContextJob,
  type JobContext,
  type JobTargets,
} from "./jobs.js";

/** One attempt the queue handed to the executor, held open until the test answers it. */
type Attempt = {
  job: Job;
  signal: AbortSignal;
  finish: (result: string) => void;
  fail: (error: unknown) => void;
};

const roots: string[] = [];
const stores: Catalog[] = [];
const queues: JobQueue[] = [];
const held: Pick<Attempt, "fail">[] = [];

/** A queue plus the executor it drives, where starting and settling are observed, never waited out. */
function open(path: string, prefix: string) {
  let id = 0;
  const store = new CaptureStore(path, {
    now: () => "2026-09-15T00:00:00.000Z",
    newId: () => `${prefix}-${++id}`,
  });
  stores.push(store);
  const attempts = new Map<string, Attempt>();
  const waiting = new Map<string, () => void>();
  const execute: JobExecutor = ({ job, signal }) =>
    new Promise<string>((resolve, reject) => {
      const attempt: Attempt = { job, signal, finish: resolve, fail: reject };
      attempts.set(job.attemptId, attempt);
      held.push(attempt);
      waiting.get(job.attemptId)?.();
    });
  const projects = projectStoreFixture(store, new AssetStore(store, dirname(path)), dirname(path));
  const targets: JobTargets = {
    pin(target) {
      if (target.kind === "recording") {
        if (target.revisionId !== null)
          throw new CatalogError("NOT_READY", "Unsupported recording job target");
        const recording = store.get(target.id);
        if (
          !isSettled(recording.state) ||
          recording.state === "canceled" ||
          store.isDeleting(target.id)
        )
          throw new CatalogError(
            "INVALID_STATE",
            "Source-owned work requires a settled available recording",
          );
        return { ...target, revisionId: null };
      }
      if (target.kind === "project") projects.requireRevision(target.id, target.revisionId);
      // Other managed domain fixtures vouch for their inputs; real owners validate their rows.
      return target;
    },
    isAvailable: (target) =>
      target.kind === "recording"
        ? store.isAvailable(target.id)
        : target.kind === "project"
          ? projects.hasRevision(target.id, target.revisionId)
          : true,
    isDeleting: (owner) =>
      owner.kind === "recording"
        ? store.isDeleting(owner.id)
        : owner.kind === "project" && projects.isDeleting(owner.id),
    isCapturing: () => store.isCapturing(),
  };
  const queue = new JobQueue({
    store,
    targets,
    execute,
    providers: { newId: () => `${prefix}-${++id}` },
  });
  queues.push(queue);
  const started = async (attemptId: string): Promise<Attempt> => {
    if (!attempts.has(attemptId))
      await new Promise<void>((resolve) => waiting.set(attemptId, resolve));
    return attempts.get(attemptId)!;
  };
  return { store, projects, queue, attempts, started, targets };
}

function fixture(prefix = "run") {
  const root = mkdtempSync(join(tmpdir(), "yap-jobs-"));
  roots.push(root);
  const path = join(root, "library.sqlite");
  return { path, ...open(path, prefix) };
}

test("a job's public record names itself id and reports WorkState", async () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  const waiting = queue.submitDeferred({
    target: { kind: "recording", id: recordingId, revisionId: null },
    artifact: "export",
    input: "waiting",
    lane: "heavy",
  });
  queue.startAdmission(() => ({ state: "waiting", dependency: "missing" }));
  await queue.idle();
  expect(queue.job(waiting.jobId).state).toBe("waiting");
  const record = queue.inspect(waiting.jobId);
  expect(record).toMatchObject({
    id: waiting.jobId,
    state: "queued",
    attemptId: waiting.attemptId,
    attemptGeneration: 1,
    target: { kind: "recording", id: recordingId, revisionId: null },
    published: null,
  });
  expect(record).not.toHaveProperty("jobId");
  expect(record).not.toHaveProperty("generation");
  queue.cancel(waiting.jobId);
});

test("update blocking includes dependency wait and queued work even when idle has no live attempt", async () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  const waiting = queue.submitDeferred({
    target: { kind: "recording", id: recordingId, revisionId: null },
    artifact: "export",
    input: "waiting",
    lane: "heavy",
  });
  queue.startAdmission(() => ({ state: "waiting", dependency: "missing" }));
  await queue.idle();
  expect(queue.job(waiting.jobId).state).toBe("waiting");
  expect(queue.updateBlocked).toBe(true);
  queue.cancel(waiting.jobId);
  await turn();
  expect(queue.updateBlocked).toBe(false);
  store.allocate();
  const queued = queue.submit({
    target: { kind: "recording", id: recordingId, revisionId: null },
    artifact: "transcript",
    input: "queued",
    lane: "heavy",
  });
  await queue.idle();
  expect(queue.job(queued.jobId).state).toBe("queued");
  expect(queue.updateBlocked).toBe(true);
  queue.cancel(queued.jobId);
  await turn();
  expect(queue.updateBlocked).toBe(false);
});

/** A settled source: no capture of it is still outstanding. */
function finished(store: CaptureStore, sourceDurationUs = 20): string {
  const { recordingId, sourceId } = store.allocate().recording;
  store.ingestLifecycle(recordingId, { sourceId, sequence: 1, state: "recording" });
  store.ingestLifecycle(recordingId, { sourceId, sequence: 2, state: "finalizing" });
  store.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 3,
    state: "complete",
    sourceDurationUs,
  });
  return recordingId;
}

function project(projects: ReturnType<typeof projectStoreFixture>) {
  const created = projects.create({
    requestId: "create",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  return { projectId: created.project.projectId, revisionId: created.revision.revisionId };
}

afterEach(async () => {
  for (const attempt of held.splice(0)) attempt.fail(new Error("test teardown"));
  for (const queue of queues.splice(0)) await queue.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("identical work retains its published result without another automatic attempt", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy" as const,
    input: "narration",
  };
  const job = queue.submit(request);
  expect(queue.submit(request).jobId).toBe(job.jobId);
  const attempt = await started(job.attemptId);
  expect(queue.submit(request)).toEqual({ ...job, state: "running" });
  attempt.finish("transcript-a");
  await queue.idle();
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "transcript",
      input: "narration",
    }),
  ).toEqual({
    state: "ready",
    jobId: job.jobId,
    reason: null,
    retryable: false,
    published: {
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "transcript",
      generation: 1,
      issues: [],
      input: "narration",
      result: "transcript-a",
    },
  });
  expect(queue.job(job.jobId)).toMatchObject({ state: "ready", generation: 1 });

  expect(queue.submit(request)).toEqual(queue.job(job.jobId));
  expect(queue.retry(job.jobId)).toEqual(queue.job(job.jobId));
});

test("a restart fails the interrupted attempt, whose late answer cannot overwrite its retry", async () => {
  const { store, queue, path, started } = fixture("first");
  const recordingId = finished(store);
  const job = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy",
    input: "narration",
  });
  const lost = await started(job.attemptId);

  const relaunched = open(path, "second");
  expect(
    relaunched.queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },

      artifact: "transcript",
      input: "narration",
    }),
  ).toEqual({
    state: "failed",
    jobId: job.jobId,
    reason: "interrupted",
    retryable: true,
    published: null,
  });
  const retried = relaunched.queue.retry(job.jobId);
  expect(retried.attemptId).not.toBe(job.attemptId);
  expect(retried.target).toEqual(job.target);
  const fresh = await relaunched.started(retried.attemptId);

  lost.finish("answer-from-the-dead-process");
  await queue.idle();
  expect(
    relaunched.queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },

      artifact: "transcript",
      input: "narration",
    }).published,
  ).toBeNull();
  expect(relaunched.queue.job(job.jobId).state).toBe("running");

  fresh.finish("answer-from-the-retry");
  await relaunched.queue.idle();
  expect(
    relaunched.queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },

      artifact: "transcript",
      input: "narration",
    }).published,
  ).toEqual({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    generation: 2,
    issues: [],
    input: "narration",
    result: "answer-from-the-retry",
  });
});

test("an edit during processing does not move the revision the work was admitted for", async () => {
  const { projects, queue, started } = fixture();
  const { projectId, revisionId } = project(projects);
  const request = {
    target: { kind: "project" as const, id: projectId, revisionId },
    artifact: "transcript",
    lane: "heavy" as const,
    input: "narration",
  };
  const job = queue.submit(request);
  const attempt = await started(job.attemptId);
  expect(attempt.job.target).toEqual({ kind: "project", id: projectId, revisionId: revisionId });
  const edited = projects.apply(projectId, {
    requestId: "resize-1",
    expectedRevisionId: revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  }).revision;
  attempt.finish("transcript-a");
  await queue.idle();
  expect(projects.revision(projectId).revisionId).toBe(edited.revisionId);
  expect(
    queue.status({
      target: { kind: "project" as const, id: projectId, revisionId: revisionId },
      artifact: "transcript",
      input: "narration",
    }).published,
  ).toEqual({
    target: { kind: "project" as const, id: projectId, revisionId: revisionId },
    artifact: "transcript",
    generation: 1,
    issues: [],
    input: "narration",
    result: "transcript-a",
  });
  expect(
    queue.submit({ ...request, target: { ...request.target, revisionId: edited.revisionId } })
      .target,
  ).toEqual({
    kind: "project",
    id: projectId,
    revisionId: edited.revisionId,
  });
});

test("one heavy and two frame attempts run at once", async () => {
  const { store, queue, attempts, started } = fixture();
  const recordingId = finished(store);
  const transcript = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy",
    input: "narration",
  });
  const exported = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    lane: "heavy",
    input: "video",
  });
  const frames = ["5s", "6s", "7s"].map((input) =>
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: `frame-${input}`,
      lane: "frame",
      input,
    }),
  );
  await started(frames[1]!.attemptId);
  expect([...attempts.keys()]).toEqual([
    transcript.attemptId,
    frames[0]!.attemptId,
    frames[1]!.attemptId,
  ]);

  (await started(frames[0]!.attemptId)).finish("frame-a");
  expect((await started(frames[2]!.attemptId)).job.jobId).toBe(frames[2]!.jobId);
  expect(queue.job(exported.jobId).state).toBe("queued");
});

test("a new heavy job waits while a take is capturing; frame work does not", async () => {
  const { store, queue, attempts, started } = fixture();
  const recordingId = finished(store);
  const live = store.allocate().recording;
  store.ingestLifecycle(live.recordingId, {
    sourceId: live.sourceId,
    sequence: 1,
    state: "recording",
  });
  const transcript = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy",
    input: "narration",
  });
  const frame = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "5s",
  });
  await started(frame.attemptId);
  expect([...attempts.keys()]).toEqual([frame.attemptId]);
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "transcript",
      input: "narration",
    }),
  ).toEqual({
    state: "queued",
    jobId: transcript.jobId,
    reason: null,
    retryable: false,
    published: null,
  });

  store.ingestLifecycle(live.recordingId, {
    sourceId: live.sourceId,
    sequence: 2,
    state: "interrupted",
    reason: "stopped",
    sourceDurationUs: 10,
  });
  queue.schedule();
  expect((await started(transcript.attemptId)).job.jobId).toBe(transcript.jobId);
});

test("canceling a running job frees its lane only once the work settles", async () => {
  const { store, queue, attempts, started } = fixture();
  const recordingId = finished(store);
  const first = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy",
    input: "narration",
  });
  const running = await started(first.attemptId);
  expect(queue.cancel(first.jobId).state).toBe("canceled");
  expect(running.signal.aborted).toBe(true);

  const second = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    lane: "heavy",
    input: "video",
  });
  expect(attempts.has(second.attemptId)).toBe(false);
  running.finish("answer-after-cancellation");
  expect((await started(second.attemptId)).job.jobId).toBe(second.jobId);
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "transcript",
      input: "narration",
    }),
  ).toEqual({
    state: "not_requested",
    jobId: first.jobId,
    reason: "canceled",
    retryable: true,
    published: null,
  });
});

test("domain-admitted work that outlives a discarded capture publishes nothing and does not revive it", async () => {
  const { store, queue, attempts, started, targets } = fixture();
  // This queue-domain control admits live work; current source service admission still refuses it.
  targets.pin = (target) => {
    if (target.kind !== "recording" || target.revisionId !== null)
      throw Error("Source target required");
    store.get(target.id);
    return { ...target, revisionId: null };
  };
  const recording = store.allocate().recording;
  store.ingestLifecycle(recording.recordingId, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "recording",
  });
  store.registerSource(recording.recordingId, 20);
  const [running, alsoRunning, waiting] = ["5s", "6s", "7s"].map((input) =>
    queue.submit({
      target: { kind: "recording" as const, id: recording.recordingId, revisionId: null },
      artifact: `frame-${input}`,
      lane: "frame",
      input,
    }),
  );
  const attempt = await started(running!.attemptId);
  const other = await started(alsoRunning!.attemptId);
  expect(attempts.has(waiting!.attemptId)).toBe(false);
  store.ingestLifecycle(recording.recordingId, {
    sourceId: recording.sourceId,
    sequence: 2,
    state: "canceled",
  });

  attempt.finish("answer-for-a-discarded-take");
  other.fail(new Error("worker stopped"));
  await queue.idle();
  expect(store.get(recording.recordingId).state).toBe("canceled");
  expect(store.list().recordings).toEqual([]);
  expect(attempts.has(waiting!.attemptId)).toBe(false);
  for (const job of [running!, waiting!]) {
    expect(queue.job(job.jobId).state).toBe("canceled");
    expect(queue.status(job)).toEqual({
      state: "not_requested",
      jobId: job.jobId,
      reason: "recording_unavailable",
      retryable: false,
      published: null,
    });
  }
});

test("waiting work is bounded, while work already admitted still answers", async () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  const running = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy",
    input: "narration",
  });
  const queued: Job[] = [];
  let refused: unknown;
  for (let index = 0; index < 500; index += 1) {
    try {
      queued.push(
        queue.submit({
          target: { kind: "recording" as const, id: recordingId, revisionId: null },
          artifact: `frame-${index}`,
          lane: "heavy",
          input: `${index}`,
        }),
      );
    } catch (error) {
      refused = error;
      break;
    }
  }
  expect(refused).toMatchObject({ code: "CAPACITY_EXCEEDED", retryable: true });
  expect(queue.job(running.jobId).state).toBe("running");
  const oldest = queued[0]!;
  expect(queue.job(oldest.jobId).state).toBe("queued");
  expect(
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: oldest.artifact,
      lane: "heavy",
      input: oldest.input,
    }).jobId,
  ).toBe(oldest.jobId);

  queue.cancel(oldest.jobId);
  expect(
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "late",
      lane: "heavy",
      input: "late",
    }).state,
  ).toBe("queued");
});

test("a validated absence is not retryable, while an ordinary failure is", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const absent = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy",
    input: "narration",
  });
  (await started(absent.attemptId)).fail(
    new CatalogError("UNAVAILABLE", "unavailable:no_narration"),
  );
  await queue.idle();
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "transcript",
      input: "narration",
    }),
  ).toEqual({
    state: "unavailable",
    jobId: absent.jobId,
    reason: "unavailable:no_narration",
    retryable: false,
    published: null,
  });
  expect(() => queue.retry(absent.jobId)).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));

  const failed = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    lane: "heavy",
    input: "video",
  });
  (await started(failed.attemptId)).fail(new Error("encoder exited with 1"));
  await queue.idle();
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "export",
      input: "video",
    }),
  ).toEqual({
    state: "failed",
    jobId: failed.jobId,
    reason: "encoder exited with 1",
    retryable: true,
    published: null,
  });
  const retried = queue.retry(failed.jobId);
  expect(retried.attemptId).not.toBe(failed.attemptId);
  (await started(retried.attemptId)).finish("export-a");
  await queue.idle();
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "export",
      input: "video",
    }).published,
  ).toMatchObject({ result: "export-a" });
  expect(queue.retry(failed.jobId)).toEqual(queue.job(failed.jobId));
});

test("an unchanged failed request needs explicit retry, including after reopen", async () => {
  const { store, queue, started, path } = fixture();
  const recordingId = finished(store);
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    lane: "heavy" as const,
    input: "narration",
  };
  const job = queue.submit(request);
  (await started(job.attemptId)).fail(new Error("decoder failed"));
  await queue.idle();
  expect(queue.submit(request)).toMatchObject({
    jobId: job.jobId,
    state: "failed",
    attemptId: job.attemptId,
  });
  const next = open(path, "again");
  expect(next.queue.submit(request)).toMatchObject({ jobId: job.jobId, state: "failed" });
});

test("the same parameters on an edited revision never reuse the old running job", async () => {
  const { projects, queue, started } = fixture();
  const { projectId, revisionId } = project(projects);
  const request = {
    target: { kind: "project" as const, id: projectId, revisionId },
    artifact: "frame",
    lane: "frame" as const,
    input: "at=2",
  };
  const first = queue.submit(request);
  await started(first.attemptId);
  const revision = projects.apply(projectId, {
    requestId: "resize",
    expectedRevisionId: revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  }).revision;
  const second = queue.submit({
    ...request,
    target: { ...request.target, revisionId: revision.revisionId },
  });
  expect(second.target).toEqual({
    kind: "project",
    id: projectId,
    revisionId: revision.revisionId,
  });
  expect(second.jobId).not.toBe(first.jobId);
});

test("out-of-order results retain their own revision and input identities", async () => {
  const { projects, queue, started } = fixture();
  const { projectId, revisionId } = project(projects);
  const request = {
    target: { kind: "project" as const, id: projectId, revisionId },
    artifact: "frame",
    lane: "frame" as const,
    input: "at=2",
  };
  const old = queue.submit(request);
  const oldWork = await started(old.attemptId);
  const edited = projects.apply(projectId, {
    requestId: "resize",
    expectedRevisionId: revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  }).revision;
  const current = queue.submit({
    ...request,
    target: { ...request.target, revisionId: edited.revisionId },
  });
  (await started(current.attemptId)).finish("new-revision-pixels");
  // An acknowledged next start proves the preceding result was durably settled.
  const alternate = queue.submit({ ...request, target: current.target, input: "at=4" });
  (await started(alternate.attemptId)).finish("other-time-pixels");
  oldWork.finish("old-revision-pixels");
  await queue.idle();
  expect(queue.status(current).published).toMatchObject({
    target: { revisionId: edited.revisionId },
    input: "at=2",
    result: "new-revision-pixels",
  });
  expect(queue.status(alternate).published).toMatchObject({
    target: { revisionId: edited.revisionId },
    input: "at=4",
    result: "other-time-pixels",
  });
  expect(queue.status(old).published).toMatchObject({
    target: { revisionId: revisionId },
    result: "old-revision-pixels",
  });
  expect(
    queue.submit({ ...request, target: { ...request.target, revisionId: revisionId } }).jobId,
  ).toBe(old.jobId);
});

test("a permanent processing error is failed rather than unavailable", async () => {
  const { store, queue, started } = fixture();
  const job = queue.submit({
    target: { kind: "recording" as const, id: finished(store), revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "at=2",
  });
  (await started(job.attemptId)).fail(new CatalogError("INVALID_RANGE", "bad decode plan"));
  await queue.idle();
  expect(queue.status(job)).toMatchObject({ state: "failed", retryable: false });
  expect(queue.submit(job).jobId).toBe(job.jobId);
});

test("shutdown rejects late success and leaves the attempt explicitly retryable", async () => {
  const { store, queue, started } = fixture();
  const request = {
    target: { kind: "recording" as const, id: finished(store), revisionId: null },
    artifact: "frame",
    lane: "frame" as const,
    input: "at=2",
  };
  const job = queue.submit(request);
  const attempt = await started(job.attemptId);
  const closing = queue.close();
  expect(attempt.signal.aborted).toBe(true);
  expect(() => queue.submit(request)).toThrow(expect.objectContaining({ code: "SERVICE_STOPPED" }));
  attempt.finish("answer-after-shutdown");
  await closing;
  expect(queue.status(job)).toMatchObject({
    state: "failed",
    reason: "interrupted",
    retryable: true,
    published: null,
  });
});

test("shutdown still stops running work when the catalog cannot record the interruption", async () => {
  const { path, store, queue, started } = fixture();
  const job = queue.submit({
    target: { kind: "recording" as const, id: finished(store), revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "at=3",
  });
  const attempt = await started(job.attemptId);
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(path);
  other.exec("BEGIN IMMEDIATE");
  try {
    let settled = false;
    const closing = queue.close().finally(() => {
      settled = true;
    });
    expect(attempt.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    attempt.fail(new Error("stopped"));
    await expect(closing).rejects.toMatchObject({ code: "STORAGE_BUSY" });
    await queue.idle();
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
  const restarted = open(path, "restart");
  expect(restarted.queue.status(job)).toMatchObject({
    state: "failed",
    retryable: true,
    published: null,
  });
});

test("an executor submitting dependent work cannot exceed the frame capacity", async () => {
  const { store, queue: initial, targets } = fixture();
  await initial.close();
  const recordingId = finished(store);
  const started: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new JobQueue({
    store,
    targets,
    providers: {
      newId: (() => {
        let n = 0;
        return () => `nested-${++n}`;
      })(),
    },
    execute: async ({ job }) => {
      started.push(job.input);
      if (job.input === "first") {
        queue.submit({
          target: { kind: "recording" as const, id: recordingId, revisionId: null },
          artifact: "frame",
          input: "second",
          lane: "frame",
        });
        queue.submit({
          target: { kind: "recording" as const, id: recordingId, revisionId: null },
          artifact: "frame",
          input: "third",
          lane: "frame",
        });
      }
      await hold;
      return job.input;
    },
  });
  queues.push(queue);
  queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    input: "first",
    lane: "frame",
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual(["first", "second"]);
  release();
  await queue.idle();
  expect(started).toEqual(["first", "second", "third"]);
});

test("explicit retry of canceled work waits for its old executor to release capacity", async () => {
  const { store, queue, started, attempts } = fixture();
  const request = {
    target: { kind: "recording" as const, id: finished(store), revisionId: null },
    artifact: "transcript",
    lane: "heavy" as const,
    input: "narration",
  };
  const job = queue.submit(request);
  const old = await started(job.attemptId);
  queue.cancel(job.jobId);
  expect(queue.submit(request).state).toBe("canceled");
  const retry = queue.retry(job.jobId);
  expect(retry.generation).toBe(job.generation + 1);
  expect(attempts.has(retry.attemptId)).toBe(false);
  old.finish("stale");
  (await started(retry.attemptId)).finish("fresh");
  await queue.idle();
  expect(queue.status(retry).published?.result).toBe("fresh");
});

test("regenerating an evicted artifact preserves its revision and cannot invalidate a newer publication", async () => {
  const { projects, queue, started } = fixture();
  const { projectId, revisionId } = project(projects);
  const request = {
    target: { kind: "project" as const, id: projectId, revisionId },
    artifact: "frame",
    lane: "frame" as const,
    input: "at=10",
  };
  const original = queue.submit(request);
  (await started(original.attemptId)).finish("frame-one");
  await queue.idle();
  projects.apply(projectId, {
    requestId: "edit",
    expectedRevisionId: revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  const replacement = queue.regenerate(original.jobId, original.generation);
  expect(replacement).toMatchObject({ target: { revisionId: revisionId }, generation: 2 });
  expect(replacement.attemptId).not.toBe(original.attemptId);
  expect(
    queue.status({ ...request, target: { ...request.target, revisionId: revisionId } }).published,
  ).toBeNull();
  expect(queue.regenerate(original.jobId, original.generation).attemptId).toBe(
    replacement.attemptId,
  );
  (await started(replacement.attemptId)).finish("frame-two");
  await queue.idle();
  expect(queue.regenerate(original.jobId, original.generation)).toMatchObject({
    state: "ready",
    generation: 2,
    attemptId: replacement.attemptId,
  });
  expect(
    queue.status({ ...request, target: { ...request.target, revisionId: revisionId } }).published
      ?.result,
  ).toBe("frame-two");
});

test("cache regeneration preserves the published artifact when queue admission is full", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const job = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "cached",
  });
  (await started(job.attemptId)).finish("still-readable");
  await queue.idle();
  // Capture holds the heavy lane, so all pending slots remain occupied.
  store.allocate();
  for (let i = 0; i < 32; i++)
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "transcript",
      lane: "heavy",
      input: `pending-${i}`,
    });
  expect(() => queue.regenerate(job.jobId, job.generation)).toThrow(
    expect.objectContaining({ code: "CAPACITY_EXCEEDED" }),
  );
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "frame",
      input: "cached",
    }),
  ).toMatchObject({ state: "ready", published: { generation: 1, result: "still-readable" } });
});

test("recording deletion drains only its held attempts and fences queued and late publication", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const other = finished(store);
  const target = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "target",
  });
  const sibling = queue.submit({
    target: { kind: "recording" as const, id: other, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "sibling",
  });
  const waiting = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "waiting",
  });
  const targetAttempt = await started(target.attemptId);
  const siblingAttempt = await started(sibling.attemptId);
  queue.cancel(target.jobId);
  store.markDeleting(recordingId);
  let drained = false;
  const draining = queue.drainOwner({ kind: "recording", id: recordingId }).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(targetAttempt.signal.aborted).toBe(true);
  expect(siblingAttempt.signal.aborted).toBe(false);
  expect(drained).toBe(false);
  expect(queue.job(waiting.jobId).state).toBe("canceled");
  expect(() => queue.retry(target.jobId)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() =>
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "frame",
      lane: "frame",
      input: "new",
    }),
  ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  targetAttempt.finish("late target");
  await draining;
  expect(queue.status(target).published).toBeNull();
  expect(queue.job(sibling.jobId).state).toBe("running");
  siblingAttempt.finish("sibling kept");
  await queue.idle();
  expect(queue.status(sibling).published?.result).toBe("sibling kept");
});

test("startup skips deletion-marked queued work and runs the next recording", async () => {
  const first = fixture();
  const live = first.store.allocate().recording;
  const recordingId = finished(first.store);
  const sibling = finished(first.store);
  const blocked = first.queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "source",
    lane: "heavy",
    input: "gone",
  });
  const next = first.queue.submit({
    target: { kind: "recording" as const, id: sibling, revisionId: null },
    artifact: "source",
    lane: "heavy",
    input: "kept",
  });
  first.store.markDeleting(recordingId);
  first.store.ingestLifecycle(live.recordingId, {
    sourceId: live.sourceId,
    sequence: 1,
    state: "canceled",
  });
  await first.queue.close();
  queues.splice(queues.indexOf(first.queue), 1);
  first.store.close();
  const reopened = open(first.path, "reopen");
  expect(reopened.queue.job(blocked.jobId).state).toBe("canceled");
  const attempt = await reopened.started(next.attemptId);
  expect([...reopened.attempts.values()].map((value) => value.job.target)).toEqual([
    { kind: "recording", id: sibling, revisionId: null },
  ]);
  attempt.finish("sibling result");
  await reopened.queue.idle();
  expect(reopened.queue.status(next).published?.result).toBe("sibling result");
});

test("intent alone fences an executor resolving before cancellation is requested", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const job = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "late",
  });
  const attempt = await started(job.attemptId);
  store.markDeleting(recordingId);
  attempt.finish("must not publish");
  await queue.idle();
  expect(queue.job(job.jobId).state).toBe("canceled");
  expect(queue.status(job).published).toBeNull();
});

test("forgetting a recording refuses closing executors and removes only its drained jobs", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store),
    sibling = finished(store);
  const own = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    input: "own",
    lane: "frame",
  });
  const other = queue.submit({
    target: { kind: "recording" as const, id: sibling, revisionId: null },
    artifact: "frame",
    input: "other",
    lane: "frame",
  });
  const ownWorker = await started(own.attemptId),
    siblingWorker = await started(other.attemptId);
  await expect(queue.forgetOwner({ kind: "recording", id: recordingId })).rejects.toMatchObject({
    code: "INVALID_STATE",
  });
  store.markDeleting(recordingId);
  const draining = queue.drainOwner({ kind: "recording", id: recordingId });
  await expect(queue.forgetOwner({ kind: "recording", id: recordingId })).rejects.toMatchObject({
    code: "PROCESSING_BUSY",
    retryable: true,
  });
  ownWorker.finish("late");
  await draining;
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  siblingWorker.finish("sibling-result");
  await queue.idle();
  expect(queue.status(other).published?.result).toBe("sibling-result");
  expect(
    store.catalog
      .prepare("SELECT jobId FROM jobs WHERE targetKind='recording' AND targetId=?")
      .all(recordingId),
  ).toEqual([]);
  expect(
    store.catalog
      .prepare("SELECT result FROM artifacts WHERE targetKind='recording' AND targetId=?")
      .all(recordingId),
  ).toEqual([]);
});

test("forgetting a large ready history yields and preserves another recording's publication", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store),
    sibling = finished(store);
  const other = queue.submit({
    target: { kind: "recording" as const, id: sibling, revisionId: null },
    artifact: "frame",
    input: "other",
    lane: "frame",
  });
  (await started(other.attemptId)).finish("retained");
  await queue.idle();
  for (let i = 0; i < 260; i++) {
    const job = queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "frame",
      input: `frame-${i}`,
      lane: "frame",
    });
    (await started(job.attemptId)).finish(`result-${i}`);
    await queue.idle();
  }
  store.markDeleting(recordingId);
  await queue.drainOwner({ kind: "recording", id: recordingId });
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  expect(yielded).toBe(true);
  expect(store.catalog.prepare("SELECT targetKind,targetId,result FROM artifacts").all()).toEqual([
    { targetKind: "recording", targetId: sibling, result: "retained" },
  ]);
  expect(store.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([{ jobId: other.jobId }]);
  store.finishDeletion(recordingId);
  expect(store.deleting(recordingId)).toBeNull();
  expect(queue.status(other).published?.result).toBe("retained");
});

test("forget refuses intent-marked work still queued behind capture priority", async () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  store.allocate();
  const job = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "transcript",
    input: "queued",
    lane: "heavy",
  });
  expect(job.state).toBe("queued");
  store.markDeleting(recordingId);
  await expect(queue.forgetOwner({ kind: "recording", id: recordingId })).rejects.toMatchObject({
    code: "PROCESSING_BUSY",
  });
  await queue.drainOwner({ kind: "recording", id: recordingId });
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  store.finishDeletion(recordingId);
  expect(store.isDeleting(recordingId)).toBe(false);
});

function packageContext(queue: JobQueue) {
  const attempts: {
    job: ContextJob;
    signal: AbortSignal;
    finish: (result: string) => void;
    fail: (error: unknown) => void;
  }[] = [];
  const context = queue.createContext(
    ({ job, signal }) =>
      new Promise<string>((finish, fail) => {
        const attempt = { job, signal, finish, fail };
        attempts.push(attempt);
        held.push(attempt);
      }),
  );
  return { context, attempts };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const packageRequest = (input: string, lane: "frame" | "heavy" = "heavy") => ({
  artifact: "inspection",
  input,
  lane,
});

test("library and same-provenance package contexts share FIFO heavy admission and one slot", async () => {
  const { queue, store, started } = fixture();
  const recordingId = finished(store),
    a = packageContext(queue),
    b = packageContext(queue);
  const first = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "source",
    lane: "heavy",
    input: "first",
  });
  const one = queue.submitContext(a.context, packageRequest(recordingId));
  const two = queue.submitContext(b.context, packageRequest(recordingId));
  const last = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "source",
    lane: "heavy",
    input: "last",
  });
  expect(one.contextId).not.toBe(two.contextId);
  expect(store.catalog.prepare("SELECT COUNT(*) AS count FROM recordings").get()).toEqual({
    count: 1,
  });
  (await started(first.attemptId)).finish("library-first");
  await turn();
  expect(a.attempts.map((attempt) => attempt.job.input)).toEqual([recordingId]);
  expect(b.attempts).toEqual([]);
  expect(queue.job(last.jobId).state).toBe("queued");
  a.attempts[0]!.finish("package-a");
  await turn();
  expect(queue.contextJob(a.context, one.jobId).result).toBe("package-a");
  expect(b.attempts.map((attempt) => attempt.job.input)).toEqual([recordingId]);
  expect(queue.job(last.jobId).state).toBe("queued");
  b.attempts[0]!.finish("package-b");
  await turn();
  (await started(last.attemptId)).finish("library-last");
  await queue.idle();
  expect(queue.contextJob(b.context, two.jobId).result).toBe("package-b");
});

test("package serialization spends no frame slot and canceled attempts retain capacity until terminal", async () => {
  const { queue, store, started } = fixture();
  const recordingId = finished(store),
    a = packageContext(queue),
    b = packageContext(queue);
  const one = queue.submitContext(a.context, packageRequest("a1", "frame"));
  const two = queue.submitContext(a.context, packageRequest("a2", "frame"));
  const sibling = queue.submitContext(b.context, packageRequest("b", "frame"));
  const library = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "library",
  });
  await turn();
  expect(a.attempts.map((attempt) => attempt.job.input)).toEqual(["a1"]);
  expect(b.attempts.map((attempt) => attempt.job.input)).toEqual(["b"]);
  queue.cancelContextJob(a.context, one.jobId);
  expect(a.attempts[0]!.signal.aborted).toBe(true);
  expect(() => queue.forgetContextJob(a.context, one.jobId)).toThrow("still active");
  expect(queue.job(library.jobId).state).toBe("queued");
  b.attempts[0]!.finish("sibling");
  await turn();
  expect(queue.job(library.jobId).state).toBe("running");
  expect(queue.contextJob(a.context, two.jobId).state).toBe("queued");
  a.attempts[0]!.finish("late canceled result");
  await turn();
  expect(queue.contextJob(a.context, one.jobId)).toMatchObject({ state: "canceled", result: null });
  expect(a.attempts.map((attempt) => attempt.job.input)).toEqual(["a1", "a2"]);
  a.attempts[1]!.finish("second");
  (await started(library.attemptId)).finish("library");
  await queue.idle();
  expect(queue.contextJob(b.context, sibling.jobId).result).toBe("sibling");
});

test("capture blocks package heavy work while frame work proceeds", async () => {
  const { queue, store } = fixture();
  const take = store.allocate().recording,
    a = packageContext(queue),
    b = packageContext(queue);
  const heavy = queue.submitContext(a.context, packageRequest("open"));
  const frame = queue.submitContext(b.context, packageRequest("frame", "frame"));
  await turn();
  expect(a.attempts).toEqual([]);
  expect(b.attempts).toHaveLength(1);
  store.ingestLifecycle(take.recordingId, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "canceled",
  });
  queue.schedule();
  await turn();
  expect(a.attempts).toHaveLength(1);
  a.attempts[0]!.finish("opened");
  b.attempts[0]!.finish("frame");
  await queue.idle();
  expect(queue.contextJob(a.context, heavy.jobId).result).toBe("opened");
  expect(queue.contextJob(b.context, frame.jobId).result).toBe("frame");
});

test("closing capabilities cannot be forged, transferred or resurrected by late answers", async () => {
  const { queue } = fixture(),
    other = fixture("other");
  const contexts = Array.from({ length: 4 }, () => packageContext(queue));
  const a = contexts[0]!;
  const job = queue.submitContext(a.context, packageRequest("same provenance", "frame"));
  await turn();
  expect(() => packageContext(queue)).toThrow("Too many");
  expect(() => other.queue.submitContext(a.context, packageRequest("x"))).toThrow("not open");
  expect(() =>
    queue.submitContext({ contextId: a.context.contextId } as JobContext, packageRequest("x")),
  ).toThrow("not open");
  const closed = queue.closeContext(a.context);
  expect(queue.closeContext(a.context)).toBe(closed);
  expect(() => queue.submitContext(a.context, packageRequest("x"))).toThrow("not open");
  expect(() => packageContext(queue)).toThrow("Too many");
  a.attempts[0]!.finish("late answer");
  await closed;
  expect(() => queue.contextJob(a.context, job.jobId)).toThrow("not open");
  const replacement = packageContext(queue);
  const fresh = queue.submitContext(
    replacement.context,
    packageRequest("same provenance", "frame"),
  );
  await turn();
  replacement.attempts[0]!.finish("fresh");
  await queue.idle();
  expect(queue.contextJob(replacement.context, fresh.jobId).result).toBe("fresh");
  expect(() => queue.submitContext(a.context, packageRequest("same provenance"))).toThrow(
    "not open",
  );
});

test("terminal metadata can be released for unlimited sequential requests, never active attempts", async () => {
  const { queue } = fixture();
  const context = queue.createContext(async ({ job }) => `result:${job.input}`);
  const jobs: ContextJob[] = [];
  for (let i = 0; i < 32; i++) {
    const job = queue.submitContext(context, packageRequest(String(i)));
    jobs.push(job);
    await queue.idle();
    expect(queue.contextJob(context, job.jobId).result).toBe(`result:${i}`);
  }
  expect(() => queue.submitContext(context, packageRequest("next"))).toThrow("metadata limit");
  for (let i = 0; i < 40; i++) {
    const previous = jobs.shift()!;
    queue.forgetContextJob(context, previous.jobId);
    expect(() => queue.contextJob(context, previous.jobId)).toThrow("does not exist");
    const job = queue.submitContext(context, packageRequest(`later-${i}`));
    jobs.push(job);
    await queue.idle();
    expect(queue.contextJob(context, job.jobId).result).toBe(`result:later-${i}`);
  }
  expect(() => queue.submitContext(context, packageRequest("x".repeat(65537)))).toThrow(
    "too large",
  );
});

test("library deletion cannot cancel two package contexts with identical provenance inputs", async () => {
  const { queue, store, started } = fixture();
  const recordingId = finished(store),
    a = packageContext(queue),
    b = packageContext(queue);
  const library = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "source",
    lane: "heavy",
    input: "library",
  });
  const one = queue.submitContext(a.context, packageRequest(recordingId, "frame"));
  const two = queue.submitContext(b.context, packageRequest(recordingId, "frame"));
  await turn();
  store.markDeleting(recordingId);
  const draining = queue.drainOwner({ kind: "recording", id: recordingId });
  expect(a.attempts[0]!.signal.aborted).toBe(false);
  expect(b.attempts[0]!.signal.aborted).toBe(false);
  (await started(library.attemptId)).finish("discard");
  await draining;
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  a.attempts[0]!.finish("a");
  b.attempts[0]!.finish("b");
  await queue.idle();
  expect(queue.contextJob(a.context, one.jobId).result).toBe("a");
  expect(queue.contextJob(b.context, two.jobId).result).toBe("b");
});

test("global waiting admission counts both owners and cancellation releases only queued admission", async () => {
  const { queue, store } = fixture();
  const recordingId = finished(store);
  store.allocate();
  const a = packageContext(queue),
    b = packageContext(queue);
  for (let i = 0; i < 16; i++)
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "source",
      lane: "heavy",
      input: String(i),
    });
  const jobs = Array.from({ length: 16 }, (_, i) =>
    queue.submitContext(a.context, packageRequest(String(i))),
  );
  expect(() => queue.submitContext(b.context, packageRequest("overflow"))).toThrow(
    "already waiting",
  );
  expect(() =>
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "source",
      lane: "heavy",
      input: "overflow",
    }),
  ).toThrow("already waiting");
  queue.cancelContextJob(a.context, jobs[0]!.jobId);
  expect(queue.submitContext(b.context, packageRequest("replacement")).state).toBe("queued");
  expect(a.attempts).toEqual([]);
  expect(b.attempts).toEqual([]);
});

test("retry pins a new attempt while stale package completion cannot publish or free its successor", async () => {
  const { queue } = fixture(),
    a = packageContext(queue);
  const job = queue.submitContext(a.context, packageRequest("immutable"));
  await turn();
  expect(queue.submitContext(a.context, packageRequest("immutable")).jobId).toBe(job.jobId);
  queue.cancelContextJob(a.context, job.jobId);
  let retry = queue.retryContext(a.context, job.jobId);
  expect(retry.attemptId).not.toBe(job.attemptId);
  expect(retry.generation).toBe(2);
  queue.cancelContextJob(a.context, job.jobId);
  expect(() => queue.forgetContextJob(a.context, job.jobId)).toThrow("still active");
  retry = queue.retryContext(a.context, job.jobId);
  expect(retry.generation).toBe(3);
  expect(a.attempts).toHaveLength(1);
  a.attempts[0]!.finish("old");
  await turn();
  expect(queue.contextJob(a.context, job.jobId)).toMatchObject({
    state: "running",
    result: null,
    attemptId: retry.attemptId,
  });
  a.attempts[1]!.finish("new");
  await queue.idle();
  expect(queue.contextJob(a.context, job.jobId).result).toBe("new");
  queue.forgetContextJob(a.context, job.jobId);
  const next = queue.submitContext(a.context, packageRequest("immutable"));
  expect(next.jobId).not.toBe(job.jobId);
  await turn();
  a.attempts[2]!.finish("again");
  await queue.idle();
});

test("oversized result metadata fails explicitly and queue shutdown invalidates package capabilities", async () => {
  const { queue } = fixture();
  const context = queue.createContext(async () => "x".repeat(65537));
  const job = queue.submitContext(context, packageRequest("large"));
  await queue.idle();
  expect(queue.contextJob(context, job.jobId)).toMatchObject({
    state: "failed",
    retryable: false,
    result: null,
  });
  expect(() => queue.retryContext(context, job.jobId)).toThrow("cannot be retried");
  await queue.close();
  expect(() => queue.contextJob(context, job.jobId)).toThrow("not open");
  expect(() => queue.submitContext(context, packageRequest("next"))).toThrow("queue is closed");
  await queue.closeContext(context);
});

test("32 deferred jobs leave capacity for their shared prerequisite and never spin on replay", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const dependency = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },

    artifact: "source",
    input: "shared",
    lane: "heavy" as const,
  };
  let calls = 0;
  const pending = Array.from({ length: 32 }, (_, n) =>
    queue.submitDeferred({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "export",
      input: String(n),
      lane: "heavy",
    }),
  );
  expect(() =>
    queue.submitDeferred({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "export",
      input: "overflow",
      lane: "heavy",
    }),
  ).toThrow("Too much dependency work");
  expect(calls).toBe(0);
  queue.startAdmission(() => {
    calls++;
    const job = queue.submit(dependency);
    return queue.job(job.jobId).state === "ready"
      ? { state: "ready" }
      : { state: "waiting", dependency: job.jobId };
  });
  expect(calls).toBe(32);
  const source = queue.submit(dependency);
  const active = await started(source.attemptId);
  for (let n = 0; n < 100; n++) {
    queue.submit(dependency);
    queue.status({ ...dependency });
  }
  expect(calls).toBe(32);
  expect(
    queue.status({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "export",
      input: "0",
    }),
  ).toMatchObject({ state: "queued", reason: source.jobId });
  active.finish("source-evidence");
  await started(pending[0]!.attemptId);
  expect(queue.job(pending[0]!.jobId).state).toBe("running");
  expect(queue.job(pending[31]!.jobId).state).toBe("queued");
  expect(calls).toBe(64);
});

test("a lost prerequisite readmits a deferred job once, and only an explicit retry renews that", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const exporter = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "pinned",
    lane: "heavy",
  });
  let admissions = 0;
  queue.startAdmission(() => {
    admissions++;
    return { state: "ready" };
  });
  const lose = async (attemptId: string) => {
    (await started(attemptId)).fail(new JobDependencyLost("Preview disappeared"));
    await turn();
    return queue.job(exporter.jobId);
  };
  const readmitted = await lose(exporter.attemptId);
  expect(readmitted.attemptId).not.toBe(exporter.attemptId);
  expect(queue.wasReadmitted(exporter.jobId)).toBe(true);
  expect(readmitted.state).toBe("running");
  expect(admissions).toBe(2);
  expect(await lose(readmitted.attemptId)).toMatchObject({
    attemptId: readmitted.attemptId,
    state: "failed",
    reason: "Preview disappeared",
    retryable: true,
  });
  expect(admissions).toBe(2);
  const retried = queue.retry(exporter.jobId);
  expect(queue.wasReadmitted(exporter.jobId)).toBe(false);
  expect(await lose(retried.attemptId)).toMatchObject({ state: "running" });
});

test("deferred cancellation and restart preserve identity until explicit retry", async () => {
  const first = fixture();
  const recordingId = finished(first.store);
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "pinned-r0",
    lane: "heavy" as const,
  };
  const original = first.queue.submitDeferred(request);
  first.queue.startAdmission(() => ({ state: "waiting", dependency: "source-job" }));
  await first.queue.close();
  queues.splice(queues.indexOf(first.queue), 1);
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);
  queues.splice(queues.indexOf(first.queue), 1);
  const next = open(first.path, "restart");
  expect(next.queue.job(original.jobId)).toMatchObject({
    attemptId: original.attemptId,
    state: "waiting",
    reason: "source-job",
  });
  expect(next.attempts.size).toBe(0);
  next.queue.cancel(original.jobId);
  let evaluations = 0;
  next.queue.startAdmission(() => {
    evaluations++;
    return { state: "ready" };
  });
  expect(evaluations).toBe(0);
  expect(next.queue.submitDeferred(request).state).toBe("canceled");
  const retry = next.queue.retry(original.jobId);
  expect(retry.attemptId).not.toBe(original.attemptId);
  expect(retry.target).toEqual({ kind: "recording", id: recordingId, revisionId: null });
  expect(retry.state).toBe("running");
  (await next.started(retry.attemptId)).finish("export");
  await next.queue.idle();
  expect(next.queue.job(original.jobId).state).toBe("ready");
});

test("admission failures stay terminal, isolate siblings, and never retry dependencies", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const dependency = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "source",
    input: "source",
    lane: "heavy",
  });
  (await started(dependency.attemptId)).fail(
    new CatalogError("MEDIA_WORKER_FAILED", "bad source", {}),
  );
  await queue.idle();
  const bad = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "bad",
    lane: "heavy",
  });
  const good = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "good",
    lane: "heavy",
  });
  queue.startAdmission((job) => {
    if (job.input === "bad") {
      const source = queue.submit({
        target: { kind: "recording" as const, id: recordingId, revisionId: null },
        artifact: "source",
        input: "source",
        lane: "heavy",
      });
      expect(source.attemptId).toBe(dependency.attemptId);
      throw new CatalogError("DEPENDENCY_FAILED", source.reason!, {});
    }
    return { state: "ready" };
  });
  expect(queue.job(bad.jobId)).toMatchObject({
    state: "failed",
    reason: "bad source",
    retryable: true,
  });
  (await started(good.attemptId)).finish("good");
  await queue.idle();
  queue.schedule();
  expect(queue.job(dependency.jobId)).toMatchObject({
    state: "failed",
    attemptId: dependency.attemptId,
  });
  expect(queue.job(bad.jobId)).toMatchObject({ state: "failed", attemptId: bad.attemptId });
});

test("ready admission respects package capacity, FIFO and capture while frame work progresses", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const blocker = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "source",
    input: "blocker",
    lane: "heavy",
  });
  const active = await started(blocker.attemptId);
  const context = packageContext(queue);
  const packages = Array.from({ length: 32 }, (_, n) =>
    queue.submitContext(context.context, packageRequest(String(n))),
  );
  const deferred = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "after-packages",
    lane: "heavy",
  });
  queue.startAdmission(() => ({ state: "ready" }));
  expect(queue.job(deferred.jobId).state).toBe("waiting");
  queue.cancelContextJob(context.context, packages[31]!.jobId);
  expect(queue.job(deferred.jobId).state).toBe("queued");
  const capture = store.allocate().recording;
  active.finish("done");
  await turn();
  expect(context.attempts).toEqual([]);
  expect(queue.job(deferred.jobId).state).toBe("queued");
  queue.cancelContextJob(context.context, packages[30]!.jobId);
  const frame = queue.submit({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "frame",
    input: "frame",
    lane: "frame",
  });
  (await started(frame.attemptId)).finish("frame");
  store.ingestLifecycle(capture.recordingId, {
    sourceId: capture.sourceId,
    sequence: 1,
    state: "canceled",
  });
  queue.schedule();
  await turn();
  expect(context.attempts.map((a) => a.job.input)).toEqual(["0"]);
  expect(queue.job(deferred.jobId).state).toBe("queued");
  for (let n = 0; n < 30; n++) {
    context.attempts[n]!.finish(String(n));
    await turn();
  }
  (await started(deferred.attemptId)).finish("export");
  await queue.idle();
  expect(queue.job(deferred.jobId).state).toBe("ready");
});

test("deletion fences waiting jobs before admission and forgets them after drain", async () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  const waiting = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "pending",
    lane: "heavy",
  });
  store.markDeleting(recordingId);
  let evaluations = 0;
  queue.startAdmission(() => {
    evaluations++;
    return { state: "ready" };
  });
  await queue.drainOwner({ kind: "recording", id: recordingId });
  expect(evaluations).toBe(0);
  expect(queue.job(waiting.jobId)).toMatchObject({
    state: "canceled",
    reason: "recording_unavailable",
    retryable: false,
  });
  expect(() => queue.retry(waiting.jobId)).toThrow();
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  expect(() => queue.job(waiting.jobId)).toThrow("Job does not exist");
});

test("dependency owners can cancel a waiting sibling without admitting its stale snapshot", () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  const first = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "first",
    lane: "heavy",
  });
  const sibling = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "sibling",
    lane: "heavy",
  });
  const visited: string[] = [];
  queue.startAdmission((job) => {
    visited.push(job.input);
    queue.cancel(sibling.jobId);
    queue.submit({
      target: { kind: "recording" as const, id: recordingId, revisionId: null },
      artifact: "source",
      input: "source",
      lane: "heavy",
    });
    return { state: "waiting", dependency: "source" };
  });
  expect(visited).toEqual(["first"]);
  expect(queue.job(first.jobId).state).toBe("waiting");
  expect(queue.job(sibling.jobId).state).toBe("canceled");
  queue.retry(first.jobId);
  queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "first",
    lane: "heavy",
  });
  expect(visited).toEqual(["first"]);
});

test("regeneration re-admits deferred work without an unrelated wake and ignores stale generations", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  let calls = 0;
  queue.startAdmission(() => {
    calls++;
    return { state: "ready" };
  });
  const job = queue.submitDeferred({
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "derivative",
    input: "pinned",
    lane: "heavy",
  });
  (await started(job.attemptId)).finish("first");
  await queue.idle();
  const replacement = queue.regenerate(job.jobId, job.generation);
  expect(replacement.state).toBe("running");
  const before = calls;
  queue.regenerate(job.jobId, job.generation);
  expect(calls).toBe(before);
  (await started(replacement.attemptId)).finish("regenerated");
  await queue.idle();
  expect(queue.status(job).published?.result).toBe("regenerated");
});

test("single-job retirement drains older canceled attempts before forgetting identity and result", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "export",
    input: "one",
    lane: "heavy" as const,
  };
  const first = queue.submit(request),
    active = await started(first.attemptId);
  queue.cancel(first.jobId);
  const retry = queue.retry(first.jobId);
  const draining = queue.drainJob(first.jobId);
  let done = false;
  draining.then(() => {
    done = true;
  });
  await turn();
  expect(done).toBe(false);
  expect(active.signal.aborted).toBe(true);
  expect(queue.job(retry.jobId).state).toBe("canceled");
  expect(() => queue.forgetJob(first.jobId)).toThrow("still active");
  active.finish("late result");
  await draining;
  queue.forgetJob(first.jobId);
  expect(queue.status(first)).toMatchObject({
    state: "not_requested",
    published: null,
    jobId: null,
  });
  const next = queue.submit(request);
  expect(next.jobId).not.toBe(first.jobId);
  (await started(next.attemptId)).finish("ready result");
  await queue.idle();
  expect(queue.status(next).published?.result).toBe("ready result");
  await queue.drainJob(next.jobId);
  queue.forgetJob(next.jobId);
  expect(queue.status(next)).toMatchObject({
    state: "not_requested",
    published: null,
    jobId: null,
  });
});

// Preparation has a durable identity before it can publish an asset.
test("import preparation needs no recording and retries the frozen input", async () => {
  const { store, queue, started } = fixture();
  const request = {
    target: { kind: "import" as const, id: "import-first" },
    artifact: "asset-import",
    lane: "heavy" as const,
    input: JSON.stringify({ snapshot: "owned-source", sha256: "frozen-by-import-owner" }),
  };
  const job = queue.submit(request);
  const first = await started(job.attemptId);
  first.fail(new Error("temporary probe failure"));
  await queue.idle();
  const retried = queue.retry(job.jobId);
  expect(retried.target).toEqual(request.target);
  expect(retried.input).toBe(request.input);
  expect(retried.attemptId).not.toBe(job.attemptId);
  expect(retried.generation).toBe(2);
  const second = await started(retried.attemptId);
  second.finish(JSON.stringify({ assetId: "asset-ready" }));
  await queue.idle();
  expect(queue.status(request).published?.result).toBe(JSON.stringify({ assetId: "asset-ready" }));
  expect(queue.submit(request).jobId).toBe(job.jobId);
  expect(store.list().recordings).toEqual([]);
});

test("managed targets retain distinct kind and revision identities after restart", async () => {
  const first = fixture();
  first.targets.pin = (target) => {
    if (target.kind === "recording") throw Error("Managed target required");
    return target;
  };
  first.targets.isAvailable = () => true;
  const targets = [
    { kind: "import" as const, id: "shared-id" },
    { kind: "asset" as const, id: "shared-id" },
    { kind: "project" as const, id: "shared-id", revisionId: "r1" },
    { kind: "project" as const, id: "shared-id", revisionId: "r2" },
  ];
  const jobs = targets.map((target) =>
    first.queue.submit({
      target,
      artifact: "prepared",
      lane: "frame",
      input: "same-frozen-input",
    }),
  );
  for (const job of jobs) (await first.started(job.attemptId)).finish(JSON.stringify(job.target));
  await first.queue.idle();
  await first.queue.close();
  const reopened = open(first.path, "restarted");
  reopened.targets.pin = first.targets.pin;
  reopened.targets.isAvailable = first.targets.isAvailable;
  for (const [index, target] of targets.entries()) {
    const job = reopened.queue.submit({
      target,
      artifact: "prepared",
      lane: "frame",
      input: "same-frozen-input",
    });
    expect(job.jobId).toBe(jobs[index]!.jobId);
    expect(job.target).toEqual(target);
    expect(reopened.queue.status(job).published).toMatchObject({
      target,
      result: JSON.stringify(target),
    });
  }
  expect(reopened.attempts.size).toBe(0);
});

test("typed preparation failures survive restart and attempt transitions clear error codes", async () => {
  const first = fixture();
  const job = first.queue.submit({
    target: { kind: "import", id: "typed-failure" },
    artifact: "asset-import",
    lane: "heavy",
    input: "frozen-source",
  });
  (await first.started(job.attemptId)).fail(
    new CatalogError("SOURCE_CHANGED", "Snapshot source changed", {
      streams: [{ codec: "unsupported" }],
    }),
  );
  await first.queue.idle();
  expect(first.queue.job(job.jobId).errorCode).toBe("SOURCE_CHANGED");
  await first.queue.close();
  const reopened = open(first.path, "retry");
  expect(reopened.queue.job(job.jobId)).toMatchObject({
    errorCode: "SOURCE_CHANGED",
    reason: "Snapshot source changed",
    errorDetails: { streams: [{ codec: "unsupported" }] },
  });
  expect(() => reopened.queue.retry(job.jobId)).toThrow(
    expect.objectContaining({
      code: "UNAVAILABLE",
      details: expect.objectContaining({ errorCode: "SOURCE_CHANGED" }),
    }),
  );
  const transient = reopened.queue.submit({
    target: { kind: "import", id: "transient" },
    artifact: "asset-import",
    lane: "heavy",
    input: "another-frozen-source",
  });
  (await reopened.started(transient.attemptId)).fail(new Error("worker failed"));
  await reopened.queue.idle();
  expect(reopened.queue.job(transient.jobId)).toMatchObject({
    errorCode: "JOB_FAILED",
    retryable: true,
  });
  const canceled = reopened.queue.retry(transient.jobId);
  expect(canceled.errorCode).toBeNull();
  expect(canceled.errorDetails).toBeNull();
  const worker = await reopened.started(canceled.attemptId);
  expect(reopened.queue.cancel(transient.jobId).errorCode).toBeNull();
  worker.finish("late");
  await reopened.queue.idle();
  const final = reopened.queue.retry(transient.jobId);
  (await reopened.started(final.attemptId)).finish("published");
  await reopened.queue.idle();
  expect(reopened.queue.job(transient.jobId)).toMatchObject({
    state: "ready",
    errorCode: null,
    errorDetails: null,
  });
});

test("deleting a project drains every pinned revision without touching a same-named asset", async () => {
  const f = fixture();
  f.targets.pin = (target) => {
    if (target.kind === "recording") throw Error("Managed target required");
    return target;
  };
  f.targets.isAvailable = () => true;
  const request = { artifact: "preview", lane: "frame" as const, input: "frozen" };
  const first = f.queue.submit({
    ...request,
    target: { kind: "project", id: "shared", revisionId: "r1" },
  });
  const second = f.queue.submit({
    ...request,
    target: { kind: "project", id: "shared", revisionId: "r2" },
  });
  const workers = await Promise.all([f.started(first.attemptId), f.started(second.attemptId)]);
  const asset = f.queue.submit({ ...request, target: { kind: "asset", id: "shared" } });
  const pin = f.targets.pin;
  f.targets.pin = (target) => {
    if (target.kind === "project") throw new CatalogError("NOT_FOUND", "Project is deleting");
    return pin(target);
  };
  f.targets.isAvailable = (target) => target.kind !== "project";
  f.targets.isDeleting = (owner) => owner.kind === "project";
  let drained = false;
  const closing = f.queue.drainOwner({ kind: "project", id: "shared" }).then(() => {
    drained = true;
  });
  expect(workers.map((worker) => worker.signal.aborted)).toEqual([true, true]);
  expect(drained).toBe(false);
  await expect(f.queue.forgetOwner({ kind: "project", id: "shared" })).rejects.toMatchObject({
    code: "PROCESSING_BUSY",
  });
  expect(() => f.queue.retry(first.jobId)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  workers.forEach((worker) => worker.finish("stale publication"));
  await closing;
  await f.queue.forgetOwner({ kind: "project", id: "shared" });
  expect(() => f.queue.job(first.jobId)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() => f.queue.job(second.jobId)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  (await f.started(asset.attemptId)).finish("asset result");
  await f.queue.idle();
  expect(f.queue.status(asset).published?.result).toBe("asset result");
});

test("an import job runs on the shared Catalog without a recording store", async () => {
  const root = mkdtempSync(join(tmpdir(), "yap-managed-jobs-"));
  roots.push(root);
  const store = new Catalog(join(root, "catalog.sqlite"));
  stores.push(store);
  let id = 0;
  const queue = new JobQueue({
    store,
    targets: {
      pin(target) {
        if (target.kind !== "import") throw new CatalogError("NOT_FOUND", "No such import");
        return target;
      },
      isAvailable: (target) => target.kind === "import",
      isDeleting: () => false,
      isCapturing: () => false,
    },
    providers: { newId: () => `managed-${++id}` },
    execute: async ({ job }) => `processed:${job.input}`,
  });
  queues.push(queue);
  const job = queue.submit({
    target: { kind: "import", id: "admitted" },
    artifact: "asset.import",
    lane: "heavy",
    input: "owned immutable bytes",
  });
  await queue.idle();
  expect(queue.status(job).published).toMatchObject({
    target: { kind: "import", id: "admitted" },
    result: "processed:owned immutable bytes",
  });
});

test("failure diagnostics remain bounded and cannot break settlement", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  for (const details of [{ huge: "x".repeat(20000) }, circular, accessor, { bigint: 1n }]) {
    const f = fixture();
    const job = f.queue.submit({
      target: { kind: "import", id: "diagnostic" },
      artifact: "asset.import",
      lane: "heavy",
      input: "frozen",
    });
    (await f.started(job.attemptId)).fail(
      new CatalogError("MEDIA_WORKER_FAILED", "Cannot import source", details),
    );
    await f.queue.idle();
    expect(f.queue.job(job.jobId)).toMatchObject({
      state: "failed",
      errorCode: "MEDIA_WORKER_FAILED",
      reason: "Cannot import source",
      errorDetails: { truncated: true },
    });
    const retry = f.queue.retry(job.jobId);
    expect(retry.errorDetails).toBeNull();
    const worker = await f.started(retry.attemptId);
    expect(f.queue.cancel(job.jobId).errorDetails).toBeNull();
    worker.finish("late");
    await f.queue.idle();
  }
});

test("admission rolls back domain writes when capacity is exhausted", async () => {
  const { store, queue, started } = fixture();
  store.catalog.exec("CREATE TABLE admission_owners (id TEXT PRIMARY KEY)");
  const request = (importId: string) => ({
    target: { kind: "import" as const, id: importId },
    artifact: "asset.import",
    lane: "heavy" as const,
    input: "frozen",
  });
  const accepted = queue.submit(() => {
    store.catalog.prepare("INSERT INTO admission_owners VALUES (?)").run("accepted");
    return request("accepted");
  });
  const worker = await started(accepted.attemptId);
  expect(store.catalog.prepare("SELECT id FROM admission_owners").all()).toEqual([
    { id: "accepted" },
  ]);
  expect(() =>
    queue.submit(() => {
      store.catalog.prepare("INSERT INTO admission_owners VALUES (?)").run("broken");
      throw new Error("owner refused");
    }),
  ).toThrow("owner refused");
  expect(store.catalog.prepare("SELECT id FROM admission_owners").all()).toEqual([
    { id: "accepted" },
  ]);
  store.allocate();
  for (let i = 0; i < 32; i++) queue.submit(request(`pending-${i}`));
  expect(
    queue.submit(() => {
      store.catalog.prepare("INSERT OR IGNORE INTO admission_owners VALUES (?)").run("accepted");
      return request("accepted");
    }).jobId,
  ).toBe(accepted.jobId);
  expect(() =>
    queue.submit(() => {
      store.catalog.prepare("INSERT INTO admission_owners VALUES (?)").run("refused");
      return request("refused");
    }),
  ).toThrow(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
  expect(store.catalog.prepare("SELECT id FROM admission_owners").all()).toEqual([
    { id: "accepted" },
  ]);
  expect(store.catalog.prepare("SELECT targetId FROM jobs WHERE targetId='refused'").all()).toEqual(
    [],
  );
  worker.finish("ready");
});

test("acquisition jobs retain their domain across restart and retirement without affecting same-named assets", async () => {
  const f = fixture();
  const input = { artifact: "source-evidence", lane: "heavy" as const, input: "frozen-capture" };
  const acquisition = f.queue.submit({
    ...input,
    target: { kind: "acquisition", id: "shared" },
  });
  (await f.started(acquisition.attemptId)).finish("capture records");
  await f.queue.idle();
  const asset = f.queue.submit({ ...input, target: { kind: "asset", id: "shared" } });
  (await f.started(asset.attemptId)).finish("physical records");
  await f.queue.idle();
  await f.queue.close();
  queues.splice(queues.indexOf(f.queue), 1);
  f.store.close();
  const next = open(f.path, "reopened");
  expect(next.queue.status(acquisition).published).toMatchObject({
    target: { kind: "acquisition", id: "shared" },
    result: "capture records",
  });
  expect(next.queue.status(asset).published?.result).toBe("physical records");
  next.targets.isDeleting = (owner) => owner.kind === "acquisition";
  await next.queue.forgetOwner({ kind: "acquisition", id: "shared" });
  expect(() => next.queue.job(acquisition.jobId)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(next.queue.status(asset).published?.result).toBe("physical records");
});

test("preparation inputs survive canceled workers and explicit retry but retire with success", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const references = new ResourceReferences(store);
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "screenshot-index",
    lane: "heavy" as const,
    input: "frozen-scenes",
  };
  const admit = (job: Job) => {
    references.retain("asset", { kind: "job", id: job.jobId }, ["original"]);
    queue.retainInputs(job.jobId, "scene-generation", ["scene-a", "scene-b"]);
  };
  const job = queue.submit(request, admit);
  const first = await started(job.attemptId);
  expect(queue.retainsInput("scene-generation", "scene-a")).toBe(true);
  queue.cancel(job.jobId);
  expect(queue.retainsInput("scene-generation", "scene-b")).toBe(true);
  expect(() => queue.forgetJob(job.jobId)).toThrow("still active");
  first.fail(new Error("canceled"));
  await queue.idle();
  expect(queue.retainsInput("scene-generation", "scene-a")).toBe(true);
  const retry = queue.retry(job.jobId);
  (await started(retry.attemptId)).finish("retained-pngs");
  await queue.idle();
  expect(queue.retainsInput("scene-generation", "scene-a")).toBe(false);
  expect(references.owners("scene-generation", "scene-a")).toEqual([]);
  expect(references.owners("asset", "original")).toEqual([{ kind: "job", id: job.jobId }]);
  queue.submit(request, admit);
  expect(references.owners("scene-generation", "scene-b")).toEqual([]);
  queue.forgetJob(job.jobId);
  expect(references.owners("asset", "original")).toEqual([]);
});

test("retryable failures and restart keep inputs while permanent failures release them", async () => {
  const { store, queue, started, path } = fixture();
  const recordingId = finished(store);
  const refs = new ResourceReferences(store);
  const job = queue.submit(
    {
      target: { kind: "recording", id: recordingId, revisionId: null },
      artifact: "index",
      lane: "heavy",
      input: "scenes",
    },
    (job) => queue.retainInputs(job.jobId, "scene-generation", ["frozen"]),
  );
  (await started(job.attemptId)).fail(new CatalogError("NOT_READY", "try later", {}));
  await queue.idle();
  expect(queue.retainsInput("scene-generation", "frozen")).toBe(true);
  const retried = queue.retry(job.jobId);
  const interrupted = await started(retried.attemptId);
  const restarted = open(path, "restart-inputs");
  expect(restarted.queue.retainsInput("scene-generation", "frozen")).toBe(true);
  expect(restarted.queue.job(job.jobId)).toMatchObject({ state: "failed", retryable: true });
  interrupted.fail(new Error("old worker closed"));
  await queue.idle();
  const last = restarted.queue.retry(job.jobId);
  (await restarted.started(last.attemptId)).fail(new CatalogError("BAD_INPUT", "permanent"));
  await restarted.queue.idle();
  expect(restarted.queue.retainsInput("scene-generation", "frozen")).toBe(false);
  expect(refs.owners("scene-generation", "frozen")).toEqual([]);
});

test("an older canceled worker pins inputs after a concurrent retry publishes", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const refs = new ResourceReferences(store);
  const job = queue.submit(
    {
      target: { kind: "recording", id: recordingId, revisionId: null },
      artifact: "frame-index",
      lane: "frame",
      input: "scenes",
    },
    (job) => queue.retainInputs(job.jobId, "scene-generation", ["frozen"]),
  );
  const old = await started(job.attemptId);
  queue.cancel(job.jobId);
  const retry = queue.retry(job.jobId);
  (await started(retry.attemptId)).finish("ready");
  // The newer frame lane can complete while the older canceled executor still holds its input.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(queue.job(job.jobId).state).toBe("ready");
  expect(queue.retainsInput("scene-generation", "frozen")).toBe(true);
  old.finish("stale");
  await queue.idle();
  expect(queue.retainsInput("scene-generation", "frozen")).toBe(false);
  expect(refs.owners("scene-generation", "frozen")).toEqual([]);
});

test("deleting a drained owner reclaims all ordinary and input reference pages", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const refs = new ResourceReferences(store);
  const job = queue.submit(
    {
      target: { kind: "recording", id: recordingId, revisionId: null },
      artifact: "index",
      lane: "heavy",
      input: "scenes",
    },
    (job) => {
      queue.retainInputs(
        job.jobId,
        "scene-generation",
        Array.from({ length: 513 }, (_, i) => `s${i}`),
      );
      refs.retain("asset", { kind: "job", id: job.jobId }, ["original"]);
    },
  );
  const active = await started(job.attemptId);
  store.markDeleting(recordingId);
  const draining = queue.drainOwner({ kind: "recording", id: recordingId });
  expect(queue.retainsInput("scene-generation", "s512")).toBe(true);
  await expect(queue.forgetOwner({ kind: "recording", id: recordingId })).rejects.toThrow(
    "closing",
  );
  active.fail(new Error("canceled"));
  await draining;
  expect(queue.retainsInput("scene-generation", "s512")).toBe(false);
  await queue.forgetOwner({ kind: "recording", id: recordingId });
  expect(refs.owners("scene-generation", "s0")).toEqual([]);
  expect(refs.owners("asset", "original")).toEqual([]);
});

test("settling one job cannot release a scene still pinned by another retryable job", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const refs = new ResourceReferences(store);
  const submit = (input: string) =>
    queue.submit(
      {
        target: { kind: "recording", id: recordingId, revisionId: null },
        artifact: "index",
        lane: "frame",
        input,
      },
      (job) => queue.retainInputs(job.jobId, "scene-generation", ["shared"]),
    );
  const first = submit("first"),
    second = submit("second");
  (await started(second.attemptId)).fail(new CatalogError("MEDIA_WORKER_FAILED", "try later", {}));
  (await started(first.attemptId)).finish("ready");
  await queue.idle();
  expect(refs.owners("scene-generation", "shared")).toEqual([
    { kind: "job-input", id: second.jobId },
  ]);
  expect(queue.retainsInput("scene-generation", "shared")).toBe(true);
  queue.forgetJob(first.jobId);
  expect(queue.retainsInput("scene-generation", "shared")).toBe(true);
  queue.forgetJob(second.jobId);
  expect(queue.retainsInput("scene-generation", "shared")).toBe(false);
  expect(refs.owners("scene-generation", "shared")).toEqual([]);
});

test("cache-loss readmission restores transient inputs transactionally and ready replay retains none", async () => {
  const f = fixture();
  const recordingId = finished(f.store);
  const cache = new DerivedCache(f.store, dirname(f.path), () => {});
  await cache.reconcile();
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "prepared",
    input: "pinned",
  };
  const admitted = (job: Job) => f.queue.retainInputs(job.jobId, "asset", ["source"]);
  const first = submitCachedDerivative(f.queue, cache, request, "heavy", { admitted });
  expect(f.queue.retainsInput("asset", "source")).toBe(true);
  const reserved = cache.reserve(request.target);
  writeFileSync(reserved.path, "prepared");
  await cache.publish(reserved.id);
  const initial = f.queue.job(first.jobId!);
  (await f.started(initial.attemptId)).finish(JSON.stringify({ cacheId: reserved.id }));
  await f.queue.idle();
  expect(f.queue.retainsInput("asset", "source")).toBe(false);
  expect(submitCachedDerivative(f.queue, cache, request, "heavy", { admitted }).state).toBe(
    "ready",
  );
  expect(f.queue.retainsInput("asset", "source")).toBe(false);
  cache.remove(reserved.id);
  const next = submitCachedDerivative(f.queue, cache, request, "heavy", { admitted });
  expect(f.queue.retainsInput("asset", "source")).toBe(true);
  const replacement = f.queue.job(next.jobId!);
  expect(replacement.generation).toBe(2);
  (await f.started(replacement.attemptId)).finish(JSON.stringify({ cacheId: "replacement" }));
  await f.queue.idle();
  expect(f.queue.retainsInput("asset", "source")).toBe(false);
});

test("regeneration admission failure rolls back references, attempt and published artifact", async () => {
  const f = fixture();
  const recordingId = finished(f.store);
  const job = f.queue.submit({
    target: { kind: "recording", id: recordingId, revisionId: null },
    artifact: "frame",
    lane: "frame",
    input: "pinned",
  });
  (await f.started(job.attemptId)).finish("published");
  await f.queue.idle();
  expect(() =>
    f.queue.regenerate(job.jobId, job.generation, (next) => {
      f.queue.retainInputs(next.jobId, "asset", ["source"]);
      throw new Error("admission failed");
    }),
  ).toThrow("admission failed");
  expect(f.queue.retainsInput("asset", "source")).toBe(false);
  expect(f.queue.job(job.jobId)).toMatchObject({
    state: "ready",
    attemptId: job.attemptId,
    generation: 1,
  });
  expect(f.queue.status(job).published?.result).toBe("published");
});

test("permanent admission size limits fail while transient queue pressure remains waiting", async () => {
  const { store, queue } = fixture();
  const recordingId = finished(store);
  const request = {
    target: { kind: "recording" as const, id: recordingId, revisionId: null },
    artifact: "admission-size",
    lane: "heavy" as const,
  };
  const permanent = queue.submitDeferred({ ...request, input: "permanent" });
  const pressure = queue.submitDeferred({ ...request, input: "pressure" });
  let visits = 0;
  queue.startAdmission((job) => {
    visits++;
    throw new CatalogError(
      job.input === "pressure" ? "CAPACITY_EXCEEDED" : "LIMIT_EXCEEDED",
      job.input,
      { bound: 10, observed: 11 },
    );
  });
  expect(queue.job(permanent.jobId)).toMatchObject({
    state: "failed",
    retryable: false,
    errorCode: "LIMIT_EXCEEDED",
  });
  expect(queue.job(pressure.jobId)).toMatchObject({ state: "waiting" });
  queue.schedule();
  expect(queue.job(permanent.jobId).attemptId).toBe(permanent.attemptId);
  expect(queue.job(pressure.jobId).attemptId).toBe(pressure.attemptId);
  await queue.idle();
  const afterEvent = visits;
  for (let i = 0; i < 3; i++) {
    queue.submitDeferred({ ...request, input: "pressure" });
    queue.status(pressure);
    await turn();
  }
  expect(visits).toBe(afterEvent);
  await queue.idle();
});

test("nested deferred children start without an external wake or recursive admission", async () => {
  const { store, queue, started } = fixture();
  const recordingId = finished(store);
  const target = { kind: "recording" as const, id: recordingId, revisionId: null };
  const outer = queue.submitDeferred({ target, artifact: "outer", input: "pinned", lane: "heavy" });
  let inner: Job | undefined, source: Job | undefined;
  let depth = 0,
    maximumDepth = 0;
  queue.startAdmission((job) => {
    depth++;
    maximumDepth = Math.max(maximumDepth, depth);
    try {
      const dependency =
        job.artifact === "outer"
          ? (inner = queue.submitDeferred({
              target,
              artifact: "inner",
              input: "pinned",
              lane: "heavy",
            }))
          : (source = queue.submit({ target, artifact: "source", input: "pinned", lane: "heavy" }));
      return dependency.state === "ready"
        ? { state: "ready" }
        : { state: "waiting", dependency: dependency.jobId };
    } finally {
      depth--;
    }
  });
  await turn();
  expect(source).toBeDefined();
  (await started(source!.attemptId)).finish("history");
  await turn();
  (await started(inner!.attemptId)).finish("preview");
  await turn();
  (await started(outer.attemptId)).finish("export");
  await queue.idle();
  expect(queue.job(outer.jobId).state).toBe("ready");
  expect(maximumDepth).toBe(1);
});

test.each(["UNAVAILABLE", "LIMIT_EXCEEDED"] as const)(
  "nested terminal %s admission settles parents without runnable work",
  async (code) => {
    const { store, queue, attempts } = fixture();
    const target = { kind: "recording" as const, id: finished(store), revisionId: null };
    const parent = queue.submitDeferred({
      target,
      artifact: "parent",
      input: "fixed",
      lane: "heavy",
    });
    let visits = 0;
    queue.startAdmission((job) => {
      visits++;
      if (job.artifact === "child") throw new CatalogError(code, "Permanent source failure");
      const child = queue.submitDeferred({
        target,
        artifact: "child",
        input: "fixed",
        lane: "heavy",
      });
      if (["unavailable", "failed"].includes(child.state))
        throw new CatalogError(child.errorCode!, child.reason!, {});
      return { state: "waiting", dependency: child.jobId };
    });
    await queue.idle();
    expect(queue.job(parent.jobId)).toMatchObject({
      state: code === "UNAVAILABLE" ? "unavailable" : "failed",
      retryable: false,
      errorCode: code,
    });
    expect(attempts.size).toBe(0);
    const settledVisits = visits;
    await turn();
    await turn();
    expect(visits).toBe(settledVisits);
  },
);

test("retained publications survive restart without invented jobs and precede later real generations", async () => {
  const first = fixture("portable");
  const identity = {
    target: { kind: "asset" as const, id: "asset" },
    artifact: "source-scenes",
    input: "selection",
  };
  const receipt = {
    ...identity,
    generation: 7,
    attemptId: "donor-attempt",
    result: "retained-evidence",
  };
  expect(() =>
    first.store.transaction(() => {
      first.queue.adoptArtifact(receipt, []);
      throw new Error("owner publication failed");
    }),
  ).toThrow("owner publication failed");
  expect(first.queue.status(identity).state).toBe("not_requested");
  first.store.transaction(() => first.queue.adoptArtifact(receipt, []));
  expect(first.queue.status(identity)).toMatchObject({
    state: "ready",
    jobId: null,
    published: { generation: 7, result: "retained-evidence" },
  });
  expect(
    first.queue.retainedArtifact(identity.target, identity.artifact, receipt.attemptId),
  ).toEqual(receipt);
  expect(first.attempts.size).toBe(0);
  first.store.transaction(() => first.queue.adoptArtifact(receipt, []));
  expect(() =>
    first.store.transaction(() => first.queue.adoptArtifact({ ...receipt, result: "changed" }, [])),
  ).toThrow(/conflicts/);
  await first.queue.close();
  queues.splice(queues.indexOf(first.queue), 1);
  first.store.close();
  const reopened = open(first.path, "recipient");
  expect(reopened.queue.status(identity)).toMatchObject({
    state: "ready",
    jobId: null,
    published: { generation: 7 },
  });
  expect(reopened.queue.retainsAttempt(identity.target, identity.artifact, "donor-attempt")).toBe(
    true,
  );
  const job = reopened.queue.submit({ ...identity, lane: "heavy" });
  expect(job.generation).toBe(8);
  expect(reopened.queue.status(identity)).toMatchObject({
    state: "processing",
    jobId: job.jobId,
    published: { generation: 7 },
  });
  (await reopened.started(job.attemptId)).finish("new-evidence");
  await reopened.queue.idle();
  expect(reopened.queue.status(identity)).toMatchObject({
    state: "ready",
    jobId: job.jobId,
    published: { generation: 8, result: "new-evidence" },
  });
  expect(reopened.queue.retainsAttempt(identity.target, identity.artifact, "donor-attempt")).toBe(
    false,
  );
});

test("compact job inspection preserves publication and recipe identity through restart", async () => {
  const first = fixture("inspect");
  const recordingId = finished(first.store);
  const input = "exact input ".repeat(10000);
  const job = first.queue.submit({
    target: { kind: "recording", id: recordingId, revisionId: null },
    artifact: "inspect",
    lane: "frame",
    input,
  });
  const { jobId: id, generation: attemptGeneration, ...rest } = omit(job, "input");
  const summary = {
    id,
    ...rest,
    attemptGeneration,
    inputSha256: createHash("sha256").update(input).digest("hex"),
    published: null,
  };
  expect(first.queue.inspect(job.jobId)).toEqual(summary);
  (await first.started(job.attemptId)).finish('{"ready":true}');
  await first.queue.idle();
  expect(first.queue.inspect(job.jobId)).toMatchObject({
    state: "ready",
    published: { generation: "1", attemptId: job.attemptId, output: { ready: true } },
    inputSha256: summary.inputSha256,
  });
  const ready = first.queue.inspect(job.jobId);
  await first.queue.close();
  queues.splice(queues.indexOf(first.queue), 1);
  first.store.close();
  const second = open(first.path, "inspect-restart");
  expect(second.queue.inspect(job.jobId)).toEqual(ready);
});

test("digest candidates never merge different exact recipes at admission, adoption or publication", async () => {
  const f = fixture("collision");
  const target = { kind: "asset" as const, id: "asset" };
  const digest = createHash("sha256").update("candidate").digest("hex");
  const original = f.queue.submit({ target, artifact: "job", lane: "frame", input: "original" });
  f.queue.cancel(original.jobId);
  // Simulate a hash collision at the durable boundary; no test-only hash injection in production.
  f.store.catalog
    .prepare("UPDATE jobs SET inputSha256=? WHERE jobId=?")
    .run(digest, original.jobId);
  expect(() =>
    f.queue.submit({ target, artifact: "job", lane: "frame", input: "candidate" }),
  ).toThrow(/same digest/);
  expect(f.queue.job(original.jobId).input).toBe("original");
  expect(() =>
    f.store.transaction(() =>
      f.queue.adoptArtifact(
        {
          target,
          artifact: "job",
          input: "candidate",
          generation: 1,
          attemptId: "cross-table",
          result: "{}",
        },
        [],
      ),
    ),
  ).toThrow(/same digest/);
  expect(f.queue.retainedArtifact(target, "job", "cross-table")).toBe(null);

  const receipt = {
    target,
    artifact: "publication",
    input: "original",
    generation: 1,
    attemptId: "retained",
    result: '{"original":true}',
  };
  const candidate = f.queue.submit({
    target,
    artifact: receipt.artifact,
    input: "candidate",
    lane: "frame",
  });
  f.store.transaction(() => f.queue.adoptArtifact(receipt, []));
  f.store.catalog
    .prepare("UPDATE artifacts SET inputSha256=? WHERE artifact=?")
    .run(digest, receipt.artifact);
  expect(() =>
    f.store.transaction(() => f.queue.adoptArtifact({ ...receipt, input: "candidate" }, [])),
  ).toThrow(/same digest/);
  (await f.started(candidate.attemptId)).finish('{"wrong":true}');
  await Promise.resolve();
  // Release canceled executor before waiting for all attempt cleanup.
  (await f.started(original.attemptId)).fail(new Error("canceled"));
  await f.queue.idle();
  expect(f.queue.job(candidate.jobId)).toMatchObject({
    state: "failed",
    errorCode: "IDENTITY_COLLISION",
    retryable: false,
  });
  expect(f.queue.retainedArtifact(target, receipt.artifact, receipt.attemptId)).toEqual(receipt);
});

test("inspection keeps a previous publication during replacement and hides it after owner loss", async () => {
  const f = fixture("prior-inspection");
  const target = { kind: "asset" as const, id: "asset" };
  const receipt = {
    target,
    artifact: "evidence",
    input: "same",
    generation: 7,
    attemptId: "donor",
    result: '{"retained":true}',
  };
  f.store.transaction(() => f.queue.adoptArtifact(receipt, []));
  const job = f.queue.submit({ ...receipt, lane: "frame" });
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "running",
    attemptGeneration: 8,
    published: { generation: "7", attemptId: "donor", output: { retained: true } },
  });
  f.queue.cancel(job.jobId);
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "canceled",
    published: { generation: "7", attemptId: "donor", output: { retained: true } },
  });
  f.targets.isAvailable = () => false;
  expect(f.queue.inspect(job.jobId)).toMatchObject({ state: "canceled", published: null });
});

test("source-owned recording jobs retain null identity without manufacturing a revision", async () => {
  const { store, queue, started, path } = fixture();
  const recording = store.allocate().recording;
  store.ingestLifecycle(recording.recordingId, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "NO_VIDEO",
    sourceDurationUs: null,
  });
  const request = {
    target: { kind: "recording" as const, id: recording.recordingId, revisionId: null },
    artifact: "capture-cleanup",
    lane: "heavy" as const,
    input: recording.sourceId,
  };
  const job = queue.submit(request);
  expect(job.target).toEqual(request.target);
  expect(store.catalog.prepare("SELECT * FROM project_revisions").all()).toEqual([]);
  expect(store.catalog.prepare("SELECT * FROM projects").all()).toEqual([]);
  (await started(job.attemptId)).finish(JSON.stringify({ state: "retained" }));
  await queue.idle();
  expect(queue.status(request).published).toMatchObject({
    target: request.target,
    result: JSON.stringify({ state: "retained" }),
  });
  expect(queue.inspect(job.jobId).target).toEqual(request.target);
  await queue.close();
  const reopened = open(path, "retained");
  expect(reopened.queue.inspect(job.jobId)).toMatchObject({
    target: request.target,
    state: "ready",
    published: { output: { state: "retained" } },
  });
  expect(reopened.queue.status(request).published?.target).toEqual(request.target);
});

test("source targets stay distinct from explicit project revisions and refuse recording edit selectors", async () => {
  const { store, projects, queue, started } = fixture();
  const recordingId = finished(store);
  const pinned = project(projects);
  const target = {
    kind: "project" as const,
    id: pinned.projectId,
    revisionId: pinned.revisionId,
  };
  const base = { artifact: "target-proof", lane: "heavy" as const, input: "same input" };
  const source = queue.submit({
    ...base,
    target: { kind: "recording", id: recordingId, revisionId: null },
  });
  const revision = queue.submit({ ...base, target });
  expect(source.target).toEqual({ kind: "recording", id: recordingId, revisionId: null });
  expect(revision.target).toEqual(target);
  expect(source.jobId).not.toBe(revision.jobId);
  expect(queue.submit({ ...base, target }).jobId).toBe(revision.jobId);
  expect(() => queue.submit({ ...base, target: { kind: "recording", id: recordingId } })).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  expect(() =>
    queue.submit({ ...base, target: { kind: "recording", id: recordingId, revisionId: "r0" } }),
  ).toThrow(expect.objectContaining({ code: "NOT_READY" }));
  (await started(source.attemptId)).finish("{}");
  (await started(revision.attemptId)).finish("{}");
  await queue.idle();
});

test("source-owned targets survive reopen, retry, cancellation and owner deletion fencing", async () => {
  const f = fixture();
  const recording = f.store.allocate().recording;
  f.store.ingestLifecycle(recording.recordingId, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "NO_VIDEO",
    sourceDurationUs: null,
  });
  const request = {
    target: { kind: "recording" as const, id: recording.recordingId, revisionId: null },
    artifact: "capture-cleanup",
    lane: "heavy" as const,
    input: recording.sourceId,
  };
  const first = f.queue.submit(request);
  (await f.started(first.attemptId)).fail(
    new CatalogError("MEDIA_UNAVAILABLE", "access denied", {}),
  );
  await f.queue.idle();
  await f.queue.close();
  const reopened = open(f.path, "reopened");
  expect(reopened.queue.inspect(first.jobId)).toMatchObject({
    target: request.target,
    state: "failed",
    retryable: true,
  });
  const retried = reopened.queue.retry(first.jobId);
  expect(retried.target).toEqual(request.target);
  const running = await reopened.started(retried.attemptId);
  reopened.queue.cancel(first.jobId);
  expect(running.signal.aborted).toBe(true);
  running.finish("{}");
  await reopened.queue.idle();
  expect(reopened.queue.status(request).published).toBeNull();
  const again = reopened.queue.retry(first.jobId);
  const deleting = await reopened.started(again.attemptId);
  reopened.store.markDeleting(recording.recordingId);
  let closed = false;
  const drained = reopened.queue
    .drainOwner({ kind: "recording", id: recording.recordingId })
    .then(() => {
      closed = true;
    });
  await Promise.resolve();
  expect(deleting.signal.aborted).toBe(true);
  expect(closed).toBe(false);
  expect(() => reopened.queue.submit(request)).toThrow();
  deleting.finish("{}");
  await drained;
  expect(reopened.queue.status(request).published).toBeNull();
  await reopened.queue.forgetOwner({ kind: "recording", id: recording.recordingId });
  expect(() => reopened.queue.inspect(first.jobId)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
});

test("source-owned work refuses live or discarded recordings without pinning a revision", () => {
  const { store, queue } = fixture();
  const take = store.allocate().recording;
  const request = {
    target: { kind: "recording" as const, id: take.recordingId, revisionId: null },
    artifact: "capture-cleanup",
    lane: "heavy" as const,
    input: take.sourceId,
  };
  expect(() => queue.submit(request)).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  store.ingestLifecycle(take.recordingId, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "canceled",
  });
  expect(() => queue.submit(request)).toThrow();
});

test("persisted queued work and dependency admission wait for an assembled owner's explicit start", async () => {
  const root = mkdtempSync(join(tmpdir(), "yap-deferred-start-"));
  roots.push(root);
  const store = new Catalog(join(root, "catalog.sqlite"));
  stores.push(store);
  let ready = false;
  const executed: string[] = [];
  let nextId = 0;
  const targets: JobTargets = {
    pin: (target) => {
      if (target.kind !== "asset") throw Error("asset");
      return target;
    },
    isAvailable: () => true,
    isDeleting: () => false,
    isCapturing: () => false,
  };
  const make = () => {
    const queue = new JobQueue({
      store,
      targets,
      providers: { newId: () => `job-${++nextId}` },
      deferExecution: true,
      execute: async ({ job }) => {
        expect(ready).toBe(true);
        executed.push(job.artifact);
        return "complete";
      },
    });
    queues.push(queue);
    return queue;
  };
  const first = make();
  const queued = first.submit({
    target: { kind: "asset", id: "source" },
    artifact: "queued",
    lane: "heavy",
    input: "frozen",
  });
  const waiting = first.submitDeferred({
    target: { kind: "asset", id: "source" },
    artifact: "waiting",
    lane: "frame",
    input: "frozen",
  });
  await first.close();
  const resumed = make();
  resumed.startAdmission(() => {
    expect(ready).toBe(true);
    return { state: "ready" };
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(resumed.job(queued.jobId).state).toBe("queued");
  expect(resumed.job(waiting.jobId).state).toBe("waiting");
  expect(executed).toEqual([]);
  ready = true;
  resumed.start();
  resumed.start();
  await expect.poll(() => resumed.job(queued.jobId).state).toBe("ready");
  await expect.poll(() => resumed.job(waiting.jobId).state).toBe("ready");
  expect(executed.sort()).toEqual(["queued", "waiting"]);
});

test("ordinary scheduling resumes durable queued work after retryable activation contention", async () => {
  const root = mkdtempSync(join(tmpdir(), "yap-start-contention-"));
  roots.push(root);
  const path = join(root, "catalog.sqlite"),
    store = new Catalog(path);
  stores.push(store);
  let id = 0,
    executions = 0;
  const queue = new JobQueue({
    store,
    deferExecution: true,
    providers: { newId: () => `job-${++id}` },
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw Error("asset");
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: async () => {
      executions++;
      return "complete";
    },
  });
  queues.push(queue);
  const job = queue.submit({
    target: { kind: "asset", id: "reference" },
    artifact: "owned-work",
    lane: "heavy",
    input: "frozen",
  });
  const writer = new DatabaseSync(path);
  writer.exec("BEGIN IMMEDIATE");
  try {
    expect(() => queue.start()).toThrow("Catalog is locked");
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  expect(queue.job(job.jobId).state).toBe("queued");
  expect(executions).toBe(0);
  queue.schedule();
  await expect.poll(() => queue.job(job.jobId).state).toBe("ready");
  expect(executions).toBe(1);
});
