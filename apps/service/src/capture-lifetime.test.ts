import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { CaptureStore } from "@yap/core/capture-store";
import type { OperationResult } from "@yap/protocol";
import { CaptureService } from "./capture.js";

const idleNative: OperationResult = {
  ok: true,
  data: {
    state: "idle",
    recordingId: null,
    sourceId: null,
    elapsedUs: null,
    selection: null,
    camera: null,
    permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
  },
};

test("closing capture aborts recovery and waits for its worker before releasing the catalog", async () => {
  const home = await mkdtemp("/tmp/yap-capture-close-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const recording = store.allocate().recording;
  let signal: AbortSignal | undefined;
  let finish!: (result: OperationResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = new CaptureService(
    store,
    home,
    async (operation) => {
      expect(operation).toBe("capture.status");
      return idleNative;
    },
    async (_operation, _params, options) => {
      signal = options?.signal;
      entered();
      return new Promise<OperationResult>((resolve) => {
        finish = resolve;
      });
    },
  );
  try {
    const recovery = service.reconcileStranded();
    await started;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    finish({
      ok: false,
      error: { code: "CANCELED", message: "worker closed", retryable: true, details: {} },
    });
    await closing;
    await recovery;
    expect(store.get(recording.id)).toMatchObject({
      state: "finalizing",
      finalizationError: { code: "RECOVERY_CANCELED" },
    });
    await expect(service.reconcileStranded()).rejects.toMatchObject({ code: "OWNER_CLOSED" });
  } finally {
    finish?.({
      ok: false,
      error: { code: "CANCELED", message: "fixture ended", retryable: true, details: {} },
    });
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("deletion quiescence waits behind a held start and keeps source files", async () => {
  const home = await mkdtemp("/tmp/yap-capture-delete-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  let releaseStart!: (result: OperationResult) => void;
  let started!: () => void;
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  let releaseCancel!: (result: OperationResult) => void;
  let cancelEntered!: () => void;
  const canceling = new Promise<void>((resolve) => {
    cancelEntered = resolve;
  });
  let calls = 0;
  const service = new CaptureService(
    store,
    home,
    async (operation) => {
      calls++;
      if (operation === "capture.start") {
        started();
        return new Promise((resolve) => {
          releaseStart = resolve;
        });
      }
      if (operation === "capture.cancel") {
        cancelEntered();
        return new Promise((resolve) => {
          releaseCancel = resolve;
        });
      }
      return {
        ok: true,
        data: {
          state: "idle",
          recordingId: null,
          sourceId: null,
          elapsedUs: null,
          selection: null,
          camera: null,
          permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
        },
      };
    },
    async () => {
      throw new Error("No recovery required");
    },
  );
  try {
    const start = service.start({
      requestId: "held",
      source: { kind: "window", id: 1 },
      microphone: false,
      systemAudio: false,
    });
    const startResult = start.catch((error: unknown) => error);
    await entering;
    const recording = store.latest()!;
    const path = join(home, "recordings", recording.id, "source", "sentinel");
    await writeFile(path, "keep until coordinator owns deletion");
    store.markDeleting(recording.id);
    let quiet = false;
    const quiescing = service.quiesce(recording.id).then(() => {
      quiet = true;
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(quiet).toBe(false);
    releaseStart({
      ok: true,
      data: {
        recordingId: recording.id,
        sourceId: recording.sourceId,
        sequence: 1,
        state: "recording",
      },
    });
    expect(await startResult).toMatchObject({ code: "NOT_FOUND" });
    await canceling;
    expect(quiet).toBe(false);
    releaseCancel({
      ok: true,
      data: {
        recordingId: recording.id,
        sourceId: recording.sourceId,
        sequence: 2,
        state: "finalizing",
      },
    });
    await quiescing;
    expect(await readFile(path, "utf8")).toBe("keep until coordinator owns deletion");
    expect(store.latest()).toBeNull();
  } finally {
    const ended: OperationResult = {
      ok: false,
      error: { code: "SERVICE_STOPPED", message: "fixture ended", retryable: true, details: {} },
    };
    releaseStart?.(ended);
    releaseCancel?.(ended);
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["TIMEOUT", "SERVICE_STOPPED", "INVALID_STATE"])(
  "deletion preserves intent when %s does not prove native closure",
  async (code) => {
    const home = await mkdtemp("/tmp/yap-capture-uncertain-");
    const store = new CaptureStore(join(home, "library.sqlite"), {
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const recording = store.allocate().recording;
    store.markDeleting(recording.id);
    const service = new CaptureService(
      store,
      home,
      async (operation) =>
        operation === "capture.cancel"
          ? { ok: false, error: { code, message: "not proved", retryable: true, details: {} } }
          : {
              ok: true,
              data: {
                state: "finalizing",
                recordingId: recording.id,
                sourceId: recording.sourceId,
                elapsedUs: 1,
                selection: null,
                camera: null,
                permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
              },
            },
      async () => {
        throw new Error("No recovery requested");
      },
    );
    try {
      await expect(service.quiesce(recording.id)).rejects.toMatchObject({
        code: code === "INVALID_STATE" ? "CAPTURE_NOT_QUIET" : code,
        retryable: true,
      });
      expect(store.deleting(recording.id)?.sourceId).toBe(recording.sourceId);
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("deletion retains a take when idle status still names its native source", async () => {
  const home = await mkdtemp("/tmp/yap-capture-idle-authority-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const recording = store.allocate().recording;
  store.markDeleting(recording.id);
  const directory = join(home, "recordings", recording.id, "source");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "sentinel");
  await writeFile(path, "unconfirmed native bytes");
  const service = new CaptureService(
    store,
    home,
    async (operation) =>
      operation === "capture.cancel"
        ? {
            ok: false,
            error: { code: "INVALID_STATE", message: "Not held", retryable: true, details: {} },
          }
        : {
            ...idleNative,
            data: {
              ...(idleNative as { data: object }).data,
              recordingId: recording.id,
              sourceId: recording.sourceId,
            },
          },
    async () => {
      throw new Error("Deletion cannot recover media");
    },
  );
  try {
    await expect(service.quiesce(recording.id)).rejects.toMatchObject({
      code: "CAPTURE_NOT_QUIET",
      retryable: true,
    });
    expect(store.deleting(recording.id)?.state).toBe("preparing");
    expect(await readFile(path, "utf8")).toBe("unconfirmed native bytes");
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("deletion waits for running recovery and does not admit recovery for another marked take", async () => {
  const home = await mkdtemp("/tmp/yap-capture-recover-delete-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const recording = store.allocate().recording;
  const other = store.allocate().recording;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (result: OperationResult) => void;
  let recoveries = 0;
  let nativeCalls = 0;
  const service = new CaptureService(
    store,
    home,
    async (operation) => {
      nativeCalls++;
      return operation === "capture.cancel"
        ? {
            ok: false,
            error: {
              code: "INVALID_STATE",
              message: "not holding take",
              retryable: true,
              details: {},
            },
          }
        : {
            ok: true,
            data: {
              state: "idle",
              recordingId: null,
              sourceId: null,
              elapsedUs: null,
              selection: null,
              camera: null,
              permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
            },
          };
    },
    async () => {
      recoveries++;
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  try {
    const recovering = service.reconcileStranded();
    await started;
    store.markDeleting(recording.id);
    store.markDeleting(other.id);
    const quiet = service.quiesce(recording.id);
    await Promise.resolve();
    expect(nativeCalls).toBe(1); // Authoritative idle inspection preceded recovery.
    finish({ ok: true, data: { durationUs: 100, journal: { header: {} } } });
    await recovering;
    await quiet;
    expect(recoveries).toBe(1);
    expect(store.latest()).toBeNull();
  } finally {
    finish?.({
      ok: false,
      error: { code: "CANCELED", message: "fixture ended", retryable: true, details: {} },
    });
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a marked finished take neither starts replacement capture nor touches native to quiesce", async () => {
  const home = await mkdtemp("/tmp/yap-capture-finished-delete-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const recording = store.allocate().recording;
  store.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "interrupted",
    sourceDurationUs: null,
    reason: "NO_SOURCE_MEDIA",
  });
  store.markDeleting(recording.id);
  const service = new CaptureService(
    store,
    home,
    async () => {
      throw new Error("Finished take cannot reach native");
    },
    async () => {
      throw new Error("No recovery required");
    },
  );
  try {
    await service.quiesce(recording.id);
    await expect(
      service.restart({
        recordingId: recording.id,
        requestId: "replacement",
        source: { kind: "window", id: 1 },
        microphone: false,
        systemAudio: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.latest()).toBeNull();
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("proved native closure releases heavy work while deletion files and intent remain", async () => {
  const { JobQueue } = await import("@yap/core/jobs");
  const home = await mkdtemp("/tmp/yap-capture-priority-delete-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const recording = store.allocate().recording;
  const other = store.allocate().recording;
  store.ingestLifecycle(other.id, {
    sourceId: other.sourceId,
    sequence: 1,
    state: "interrupted",
    sourceDurationUs: 10,
    reason: "fixture",
  });
  store.markDeleting(recording.id);
  const source = join(home, "recordings", recording.id, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "sentinel"), "cleanup still pending");
  let entered!: () => void;
  const cancelEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (result: OperationResult) => void;
  const queue = new JobQueue({
    store,
    targets: {
      pin(target) {
        if (target.kind !== "recording" || target.revisionId !== null)
          throw new Error("Expected source-owned capture work");
        if (!store.isAvailable(target.id)) throw new Error("Capture source is unavailable");
        return { ...target, revisionId: null };
      },
      isAvailable: (target) => target.kind === "recording" && store.isAvailable(target.id),
      isDeleting: (owner) => owner.kind === "recording" && store.isDeleting(owner.id),
      isCapturing: () => store.isCapturing(),
    },
    providers: { newId: randomUUID },
    execute: async () => "other recording processed",
  });
  const job = queue.submit({
    target: { kind: "recording" as const, id: other.id, revisionId: null },
    artifact: "source",
    input: "other",
    lane: "heavy",
  });
  const service = new CaptureService(
    store,
    home,
    async (operation) => {
      if (operation === "capture.cancel") {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return {
        ok: true,
        data: {
          state: "idle",
          recordingId: null,
          sourceId: null,
          elapsedUs: null,
          selection: null,
          camera: null,
          permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
        },
      };
    },
    async () => {
      throw new Error("No recovery required");
    },
    () => {},
    () => queue.schedule(),
  );
  try {
    const quiet = service.quiesce(recording.id);
    await cancelEntered;
    expect(queue.job(job.jobId).state).toBe("queued");
    finish({
      ok: false,
      error: { code: "INVALID_STATE", message: "no longer held", retryable: true, details: {} },
    });
    await quiet;
    await queue.idle();
    expect(queue.status(job).published?.result).toBe("other recording processed");
    expect(store.deleting(recording.id)?.state).toBe("canceled");
    expect(await readFile(join(source, "sentinel"), "utf8")).toBe("cleanup still pending");
    expect(() => store.get(recording.id)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  } finally {
    finish?.({
      ok: false,
      error: { code: "SERVICE_STOPPED", message: "fixture ended", retryable: true, details: {} },
    });
    await service.close();
    await queue.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["complete", "interrupted"] as const)(
  "cancel joining %s finalization retains the finished recording",
  async (state) => {
    const home = await mkdtemp("/tmp/yap-capture-terminal-race-");
    const store = new CaptureStore(join(home, "library.sqlite"), {
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const recording = store.allocate().recording;
    store.ingestLifecycle(recording.id, {
      sourceId: recording.sourceId,
      sequence: 1,
      state: "recording",
    });
    const source = join(home, "recordings", recording.id, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "sentinel"), "finished media stays");
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (result: OperationResult) => void;
    const service = new CaptureService(
      store,
      home,
      async () => {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      async () => {
        throw new Error("No recovery required");
      },
    );
    try {
      const canceled = service.cancel(recording.id).catch((error: unknown) => error);
      await called;
      service.report({
        recordingId: recording.id,
        sourceId: recording.sourceId,
        sequence: 2,
        state: "finalizing",
      });
      const terminal = {
        recordingId: recording.id,
        sourceId: recording.sourceId,
        sequence: 3,
        state,
        sourceDurationUs: 20,
        reason: state === "interrupted" ? "SOURCE_LOST" : undefined,
      };
      service.report(terminal);
      finish({ ok: true, data: terminal });
      expect(await canceled).toMatchObject({ code: "INVALID_STATE" });
      expect(store.get(recording.id)).toMatchObject({
        state,
        sourceDurationUs: 20,
      });
      expect(await readFile(join(source, "sentinel"), "utf8")).toBe("finished media stays");
    } finally {
      finish?.({
        ok: false,
        error: { code: "SERVICE_STOPPED", message: "fixture ended", retryable: true, details: {} },
      });
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each(["media", "empty", "failed", "ambiguous"] as const)(
  "cancel after native forgot take preserves finished media=%s",
  async (mode) => {
    const finished = mode !== "empty";
    const home = await mkdtemp("/tmp/yap-cancel-missed-report-");
    const store = new CaptureStore(join(home, "library.sqlite"), {
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const recording = store.allocate().recording;
    if (finished)
      store.ingestLifecycle(recording.id, {
        sourceId: recording.sourceId,
        sequence: 1,
        state: "finalizing",
      });
    const source = join(home, "recordings", recording.id, "source");
    await mkdir(source, { recursive: true });
    const sentinel = join(source, "sentinel");
    if (finished) await writeFile(sentinel, "canonical media whose terminal report was lost");
    const journal = Buffer.from(JSON.stringify({ sessionID: recording.sourceId }));
    const video = Buffer.from("scripted canonical video bytes");
    if (mode === "media") {
      await writeFile(join(source, "source.journal.jsonl"), journal);
      await writeFile(join(source, "video.mov"), video);
    }
    const service = new CaptureService(
      store,
      home,
      async (operation) =>
        operation === "capture.status"
          ? idleNative
          : {
              ok: false,
              error: {
                code: "INVALID_STATE",
                message: "No take held",
                retryable: true,
                details: {},
              },
            },
      async () => {
        if (mode === "failed")
          return {
            ok: false,
            error: {
              code: "MEDIA_WORKER_FAILED",
              message: "Unknown physical prefix",
              retryable: true,
              details: {},
            },
          };
        return {
          ok: true,
          data: {
            durationUs: mode === "media" ? 1234 : 0,
            journal: mode === "media" ? { header: { sessionID: recording.sourceId } } : null,
            inputsClosed: true,
            sourcePublication:
              mode === "media"
                ? {
                    state: "published",
                    source: {
                      kind: "primary",
                      sourceId: recording.sourceId,
                      sourceDurationUs: 1234,
                      originHostUs: 0,
                      journal: {
                        file: "source.journal.jsonl",
                        bytes: journal.length,
                        sha256: createHash("sha256").update(journal).digest("hex"),
                        lastSequence: 2,
                        layout: 2,
                      },
                      members: {
                        "video.mov": {
                          bytes: String(video.length),
                          sha256: createHash("sha256").update(video).digest("hex"),
                        },
                      },
                    },
                  }
                : {
                    state: "unavailable",
                    error: { code: "NO_SOURCE_MEDIA", message: "Fixture found no source media" },
                  },
          },
        };
      },
    );
    try {
      expect(await service.cancel(recording.id)).toMatchObject({ state: "finalizing" });
      if (finished) {
        if (mode === "media") {
          await expect
            .poll(() => store.get(recording.id))
            .toMatchObject({ state: "interrupted", sourceDurationUs: 1234 });
        } else {
          await expect
            .poll(() => store.get(recording.id))
            .toMatchObject({
              state: "finalizing",
              sourceDurationUs: null,
              finalizationError: {
                code: mode === "failed" ? "MEDIA_WORKER_FAILED" : "CAPTURE_RECOVERY_UNRESOLVED",
              },
            });
        }
        expect(await readFile(sentinel, "utf8")).toBe(
          "canonical media whose terminal report was lost",
        );
      } else {
        await expect.poll(() => store.get(recording.id).state).toBe("canceled");
      }
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
