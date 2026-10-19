import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { CaptureStore } from "@yap/core/capture-store";
import type { OperationResult } from "@yap/protocol";
import { CaptureService, sourceDirectory } from "./capture.js";

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

// Scripted publisher bytes exercise service settlement, not native media validity.
async function recoveredSource(
  home: string,
  recordingId: string,
  sourceId: string,
  durationUs: number,
) {
  const journal = { header: { sessionID: sourceId } };
  const journalBytes = Buffer.from(JSON.stringify(journal));
  const video = Buffer.from("scripted canonical video bytes");
  const directory = sourceDirectory(home, recordingId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "source.journal.jsonl"), journalBytes);
  await writeFile(join(directory, "video.mov"), video);
  return {
    durationUs,
    journal,
    inputsClosed: true,
    sourcePublication: {
      state: "published" as const,
      source: {
        kind: "primary" as const,
        sourceId,
        sourceDurationUs: durationUs,
        originHostUs: 0,
        journal: {
          file: "source.journal.jsonl" as const,
          bytes: journalBytes.length,
          sha256: createHash("sha256").update(journalBytes).digest("hex"),
          lastSequence: 2,
          layout: 2 as const,
        },
        members: {
          "video.mov": {
            bytes: String(video.length),
            sha256: createHash("sha256").update(video).digest("hex"),
          },
        },
      },
    },
  };
}

// This pins the service half of asynchronous stop. The native termination/publisher and
// full controller deadline gates are separate: this fixture neither captures nor verifies media.
test("finalizing acknowledgment releases control order while cancellation waits for actual unwind", async () => {
  const home = await mkdtemp("/tmp/yap-finalizing-queue-");
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
  const source = sourceDirectory(home, recording.id);
  await mkdir(source, { recursive: true });
  const sentinel = join(source, "sentinel");
  await writeFile(sentinel, "retain until native unwinds");
  let enterCancel!: () => void;
  const cancelEntered = new Promise<void>((resolve) => {
    enterCancel = resolve;
  });
  let unwind!: (result: OperationResult) => void;
  const terminal = new Promise<OperationResult>((resolve) => {
    unwind = resolve;
  });
  const report = (sequence: number) => ({
    recordingId: recording.id,
    sourceId: recording.sourceId,
    sequence,
    state: "finalizing" as const,
  });
  const service = new CaptureService(
    store,
    home,
    async (operation) => {
      if (operation === "capture.stop") return { ok: true, data: report(2) };
      if (operation === "capture.cancel") {
        enterCancel();
        return terminal;
      }
      if (operation === "capture.status")
        return {
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
        };
      throw new Error(`Unexpected native operation: ${operation}`);
    },
    async () => {
      throw new Error("This active take must not enter recovery");
    },
  );
  let cancel: ReturnType<CaptureService["cancel"]> | undefined;
  try {
    expect(await service.stop(recording.id)).toMatchObject({ state: "finalizing" });
    expect(await service.status()).toMatchObject({ device: { state: "finalizing" } });
    cancel = service.cancel(recording.id);
    await cancelEntered;
    expect(await readFile(sentinel, "utf8")).toBe("retain until native unwinds");
    expect(store.get(recording.id).state).toBe("finalizing");
    unwind({ ok: true, data: report(3) });
    expect(await cancel).toMatchObject({ state: "canceled" });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    unwind({
      ok: false,
      error: { code: "SERVICE_STOPPED", message: "fixture ended", retryable: true, details: {} },
    });
    await cancel?.catch(() => undefined);
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("unproved start keeps finalizing media out of recovery until the native terminal report", async () => {
  const home = await mkdtemp("/tmp/yap-unproved-finalizing-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const recording = store.allocate().recording;
  let recoveries = 0;
  const service = new CaptureService(
    store,
    home,
    async (operation) => {
      expect(operation).toBe("capture.stop");
      return {
        ok: true,
        data: {
          recordingId: recording.id,
          sourceId: recording.sourceId,
          sequence: 1,
          state: "finalizing",
        },
      };
    },
    async () => {
      recoveries += 1;
      throw new Error("Unfinished media must not be inspected");
    },
  );
  try {
    await expect(service.stop(recording.id)).resolves.toMatchObject({
      state: "finalizing",
    });
    expect(recoveries).toBe(0);
    expect(store.get(recording.id).state).toBe("finalizing");
    expect(await service.stop(recording.id)).toMatchObject({ state: "finalizing" });
    expect(
      service.report({
        recordingId: recording.id,
        sourceId: recording.sourceId,
        sequence: 2,
        state: "complete",
        sourceDurationUs: 1234,
      }),
    ).toMatchObject({ state: "complete", sourceDurationUs: 1234 });
    expect(await service.stop(recording.id)).toMatchObject({
      state: "complete",
      sourceDurationUs: 1234,
    });
    expect(recoveries).toBe(0);
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["cleanup", "completion", "role"] as const)(
  "recovery retains cleanup detail with %s precedence",
  async (mode) => {
    const home = await mkdtemp("/tmp/yap-recovery-cleanup-");
    const store = new CaptureStore(join(home, "library.sqlite"), {
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const recording = store.allocate().recording;
    store.ingestLifecycle(recording.id, {
      sourceId: recording.sourceId,
      sequence: 1,
      state: "finalizing",
    });
    const recovered = await recoveredSource(home, recording.id, recording.sourceId, 1234);
    const logs: string[] = [];
    const service = new CaptureService(
      store,
      home,
      async (operation) =>
        operation === "capture.status"
          ? idleNative
          : {
              ok: false,
              error: { code: "INVALID_STATE", message: "closed", retryable: false, details: {} },
            },
      async () => ({
        ok: true,
        data: {
          ...recovered,
          journal: {
            ...recovered.journal,
            completion: { failureCode: mode === "completion" ? "JOURNAL_FAILED" : null },
          },
          tracks:
            mode === "role"
              ? [{ failure: { code: "AUDIO_UNAVAILABLE", message: "no mapped audio" } }]
              : [],
          cleanupFailure: { code: "CLEANUP_PENDING", message: "Retained owned working files" },
        },
      }),
      (line) => logs.push(line),
    );
    try {
      expect(await service.stop(recording.id)).toMatchObject({ state: "finalizing" });
      await expect
        .poll(() => store.get(recording.id))
        .toMatchObject({
          state: "interrupted",
          sourceDurationUs: 1234,
          interruptionReason:
            mode === "completion"
              ? "JOURNAL_FAILED"
              : mode === "role"
                ? "AUDIO_UNAVAILABLE"
                : "CLEANUP_PENDING",
        });
      expect(logs.some((line) => line.includes("Retained owned working files"))).toBe(true);
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("absent-native recovery acknowledges finalizing before media finishes and retains failure for retry", async () => {
  const home = await mkdtemp("/tmp/yap-recovery-continuation-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const take = store.allocate().recording;
  store.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "recording",
  });
  let finish!: (value: OperationResult) => void;
  let entered!: () => void;
  const workerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = new Promise<OperationResult>((resolve) => {
    finish = resolve;
  });
  const service = new CaptureService(
    store,
    home,
    async (operation) =>
      operation === "capture.status"
        ? {
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
          }
        : {
            ok: false,
            error: {
              code: "INVALID_STATE",
              message: "No native take",
              retryable: false,
              details: {},
            },
          },
    async () => {
      entered();
      return work;
    },
  );
  const failure: OperationResult = {
    ok: false,
    error: {
      code: "MEDIA_WORKER_TIMEOUT",
      message: "Recovery exceeded its attempt budget",
      retryable: true,
      details: {},
    },
  };
  const release = setTimeout(() => finish(failure), 1000);
  try {
    const stopped = service.stop(take.id);
    await workerEntered;
    expect(await stopped).toMatchObject({ state: "finalizing", finalizationError: null });
    expect(await service.status()).toMatchObject({
      device: { state: "idle" },
      recording: { id: take.id, state: "finalizing" },
    });
    finish(failure);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.get(take.id)).toMatchObject({
      state: "finalizing",
      finalizationError: { code: "MEDIA_WORKER_TIMEOUT", retryable: true },
    });
  } finally {
    clearTimeout(release);
    finish(failure);
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["recording", "finalizing", "idle"] as const)(
  "service restart does not fence a surviving native take in %s",
  async (state) => {
    const home = await mkdtemp("/tmp/yap-survived-native-");
    const store = new CaptureStore(join(home, "library.sqlite"), {
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const take = store.allocate().recording;
    store.ingestLifecycle(take.id, {
      sourceId: take.sourceId,
      sequence: 1,
      state: "recording",
    });
    let recoveries = 0;
    const service = new CaptureService(
      store,
      home,
      async (operation) => {
        expect(operation).toBe("capture.status");
        return {
          ok: true,
          data: {
            state,
            recordingId: take.id,
            sourceId: take.sourceId,
            elapsedUs: 10,
            selection: null,
            camera: null,
            permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
          },
        };
      },
      async () => {
        recoveries++;
        throw new Error("Native still owns this take");
      },
    );
    try {
      await service.reconcileStranded();
      expect(recoveries).toBe(0);
      expect(store.get(take.id)).toMatchObject({
        state: "recording",
        lifecycleSequence: 1,
        finalizationError: null,
      });
      service.report({
        recordingId: take.id,
        sourceId: take.sourceId,
        sequence: 2,
        state: "finalizing",
      });
      service.report({
        recordingId: take.id,
        sourceId: take.sourceId,
        sequence: 3,
        state: "complete",
        sourceDurationUs: 10,
      });
      expect(store.get(take.id).state).toBe("complete");
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("explicit stop retries retained recovery failure and completed result wins cancellation", async () => {
  const home = await mkdtemp("/tmp/yap-recovery-retry-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const take = store.allocate().recording;
  store.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "finalizing",
  });
  let attempts = 0;
  let complete!: (value: OperationResult) => void;
  const result = new Promise<OperationResult>((resolve) => {
    complete = resolve;
  });
  const service = new CaptureService(
    store,
    home,
    async (operation) =>
      operation === "capture.status"
        ? idleNative
        : {
            ok: false,
            error: { code: "INVALID_STATE", message: "No take", retryable: false, details: {} },
          },
    async () => {
      attempts++;
      return attempts === 1
        ? {
            ok: false,
            error: {
              code: "MEDIA_WORKER_FAILED",
              message: "Retained for retry",
              retryable: true,
              details: {},
            },
          }
        : result;
    },
  );
  try {
    expect(await service.stop(take.id)).toMatchObject({ state: "finalizing" });
    await expect.poll(() => store.get(take.id).finalizationError?.code).toBe("MEDIA_WORKER_FAILED");
    expect((await service.status()) as object).toMatchObject({
      recording: { finalizationError: { code: "MEDIA_WORKER_FAILED" } },
    });
    expect(attempts).toBe(1);
    expect(await service.stop(take.id)).toMatchObject({
      state: "finalizing",
      finalizationError: null,
    });
    expect(await service.stop(take.id)).toMatchObject({
      state: "finalizing",
      finalizationError: null,
    });
    await expect.poll(() => attempts).toBe(2);
    complete({
      ok: true,
      data: await recoveredSource(home, take.id, take.sourceId, 10),
    });
    await expect.poll(() => store.get(take.id).state).toBe("interrupted");
    await expect(service.cancel(take.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(store.get(take.id)).toMatchObject({
      state: "interrupted",
      sourceDurationUs: 10,
      finalizationError: null,
    });
  } finally {
    complete({
      ok: false,
      error: { code: "CANCELED", message: "fixture ended", retryable: true, details: {} },
    });
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("status follows the active recovery ahead of an older retained failure", async () => {
  const home = await mkdtemp("/tmp/yap-recovery-status-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const older = store.allocate().recording;
  store.ingestLifecycle(older.id, {
    sourceId: older.sourceId,
    sequence: 1,
    state: "finalizing",
    finalizationError: { code: "OLDER_FAILURE", message: "Explicit retry needed", retryable: true },
  });
  const selected = store.allocate().recording;
  store.ingestLifecycle(selected.id, {
    sourceId: selected.sourceId,
    sequence: 1,
    state: "recording",
  });
  let finish!: (value: OperationResult) => void;
  const work = new Promise<OperationResult>((resolve) => {
    finish = resolve;
  });
  const service = new CaptureService(
    store,
    home,
    async (operation) =>
      operation === "capture.status"
        ? idleNative
        : {
            ok: false,
            error: { code: "INVALID_STATE", message: "No take", retryable: false, details: {} },
          },
    async () => work,
  );
  try {
    expect(await service.stop(selected.id)).toMatchObject({ state: "finalizing" });
    expect(await service.status()).toMatchObject({
      recording: { id: selected.id, finalizationError: null },
    });
    finish({
      ok: true,
      data: await recoveredSource(home, selected.id, selected.sourceId, 10),
    });
    await expect.poll(() => store.get(selected.id).state).toBe("interrupted");
    expect(await service.status()).toMatchObject({
      recording: { id: older.id, finalizationError: { code: "OLDER_FAILURE" } },
    });
  } finally {
    finish({
      ok: false,
      error: { code: "CANCELED", message: "fixture ended", retryable: true, details: {} },
    });
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("startup drains each recovery before continuing past a retained failure", async () => {
  const home = await mkdtemp("/tmp/yap-recovery-startup-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const first = store.allocate().recording;
  const second = store.allocate().recording;
  for (const take of [first, second])
    store.ingestLifecycle(take.id, {
      sourceId: take.sourceId,
      sequence: 1,
      state: "recording",
    });
  let release!: (value: OperationResult) => void;
  const held = new Promise<OperationResult>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const service = new CaptureService(
    store,
    home,
    async () => idleNative,
    async () => {
      attempts++;
      if (attempts === 1) return held;
      return {
        ok: true,
        data: await recoveredSource(home, second.id, second.sourceId, 20),
      };
    },
  );
  const startup = service.reconcileStranded();
  try {
    await expect.poll(() => attempts).toBe(1);
    expect(store.get(second.id).state).toBe("recording");
    expect(await service.status()).toMatchObject({ recording: { id: first.id } });
    release({
      ok: false,
      error: { code: "RETRY_MEDIA", message: "Retained", retryable: true, details: {} },
    });
    await startup;
    expect(store.get(first.id)).toMatchObject({
      state: "finalizing",
      finalizationError: { code: "RETRY_MEDIA" },
    });
    expect(store.get(second.id)).toMatchObject({
      state: "interrupted",
      sourceDurationUs: 20,
    });
    expect(attempts).toBe(2);
  } finally {
    release({
      ok: false,
      error: { code: "CANCELED", message: "fixture ended", retryable: true, details: {} },
    });
    await startup;
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("native finalization failures persist until a reported new attempt or terminal outcome", async () => {
  const home = await mkdtemp("/tmp/yap-native-finalization-error-");
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  const take = store.allocate().recording;
  const service = new CaptureService(
    store,
    home,
    async () => idleNative,
    async () => {
      throw new Error("Native still owns this take");
    },
  );
  const identity = { recordingId: take.id, sourceId: take.sourceId };
  const error = {
    code: "INVALID_OUTPUT",
    message: "Publication permission denied",
    retryable: true,
  };
  try {
    service.report({ ...identity, sequence: 1, state: "recording" });
    service.report({ ...identity, sequence: 2, state: "finalizing", finalizationError: error });
    expect(store.get(take.id)).toMatchObject({
      state: "finalizing",
      finalizationError: error,
    });
    service.report({ ...identity, sequence: 3, state: "finalizing" });
    expect(store.get(take.id).finalizationError).toEqual(error);
    service.report({ ...identity, sequence: 4, state: "finalizing", finalizationError: null });
    expect(store.get(take.id).finalizationError).toBeNull();
    service.report({ ...identity, sequence: 5, state: "complete", sourceDurationUs: 100 });
    expect(store.get(take.id)).toMatchObject({
      state: "complete",
      finalizationError: null,
    });
  } finally {
    await service.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
