import { JobQueue } from "@yap/core/jobs";
import { CaptureStore } from "@yap/core/capture-store";
import { seedRecordingStates } from "./capture-store.fixture.js";
import { CatalogError } from "@yap/core/catalog";
import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { callLocal } from "@yap/client";
import {
  CONTROL_FRAME_BYTES,
  DEFAULT_CALL_TIMEOUT_MS,
  JsonLineStream,
  controlMessageSchema,
  captureSelectionSchema,
  type OperationResult,
} from "@yap/protocol";

const entry = new URL("../dist/main.js", import.meta.url).pathname;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it(
  "acknowledges absent-native cancellation while slow recovery proves absence",
  { timeout: 25_000 },
  async () => {
    const peer = capturingPeer();
    let absent = false;
    const service = await startService(
      await temporaryHome(),
      (operation, params) => {
        if (operation === "capture.status" && absent)
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
        if (operation === "capture.cancel") {
          absent = true;
          return {
            ok: false,
            error: {
              code: "INVALID_STATE",
              message: "No take held",
              retryable: true,
              details: {},
            },
          };
        }
        return peer(operation, params);
      },
      // Real worker wait exceeds the old control-only deadline; acknowledgment must not.
      { YAP_NATIVE: await recovers({ durationUs: 0, journal: null }, 16) },
    );
    const started = await service.call("capture.start", {
      requestId: "slow-cancel",
      source: fixtureSource,
    });
    if (!started.ok) throw new Error("start failed");
    const { id: recordingId } = started.data as { id: string };
    const before = Date.now();
    expect(await service.call("capture.cancel", { recordingId })).toMatchObject({
      ok: true,
      data: { id: recordingId, state: "finalizing" },
    });
    expect(Date.now() - before).toBeLessThan(DEFAULT_CALL_TIMEOUT_MS);
    await expect
      .poll(() => service.call("recording.get", { recordingId }), { timeout: 20_000 })
      .toMatchObject({
        ok: true,
        data: { id: recordingId, state: "canceled" },
      });
  },
);

/** Answers one native capture call, or nothing at all when a test needs a silent peer. */
type NativePeer = (
  operation: string,
  params: Record<string, unknown>,
) => OperationResult | undefined;

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp("/tmp/scr-capture-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** A controlled worker edge: real child lifetime, scripted files, no media decoding. */
async function nativeWorker(
  recoveryScript = `reply({ ok: false, error: { code: "NO_FIXTURE_MEDIA", message: "No scripted media operation", retryable: false, details: {} } });`,
): Promise<string> {
  const path = join(await temporaryHome(), "yap-native");
  await writeFile(
    path,
    `#!${process.execPath}
import { readFileSync, fstatSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const request = JSON.parse(readFileSync(0, "utf8"));
const reply = result => process.stdout.write(JSON.stringify({ id: request.id, ...result }) + "\\n");
if (request.operation === "storage.clearRenderWorkspace") reply({ ok: true, data: { removed: true } });
else if (request.operation === "media.audioCapabilities") reply({ ok: true, data: {} });
else if (request.operation === "storage.recordingDirectory") {
  const info = fstatSync(3, { bigint: true });
  reply({ ok: true, data: { dev: String(info.dev), ino: String(info.ino) } });
} else if (request.operation === "storage.removeRecordingDirectory") {
  await rm(join(request.params.home, "recordings", request.params.recordingId), { recursive: true, force: true });
  reply({ ok: true, data: { removed: true } });
} else if (request.operation === "storage.removeCacheFiles") {
  for (const id of request.params.ids) await rm(join(request.params.home, "cache/derived", id + ".cache"), { force: true });
  reply({ ok: true, data: { removed: true } });
} else {
  ${recoveryScript}
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

/** The takes allocated in the canonical library, whether or not they have source media. */
function takes(home: string): Promise<string[]> {
  return readdir(join(home, "library/recordings")).catch(() => []);
}

function recovers(data: unknown, pauseSeconds = 0): Promise<string> {
  return nativeWorker(`
if (request.operation === "media.cleanupCapture") reply({ ok: true, data: ${JSON.stringify(data)} });
else if (request.operation === "media.recover") {
  await new Promise(resolve => setTimeout(resolve, ${pauseSeconds * 1000}));
  const data = ${JSON.stringify(data)};
  const sourceId = request.params.sourceAuthority.sourceId;
  data.inputsClosed = true;
  if (data.durationUs > 0) {
    data.journal = { ...data.journal, header: { ...data.journal?.header, sessionID: sourceId } };
    const journal = Buffer.from(JSON.stringify(data.journal));
    const video = Buffer.from("scripted source bytes");
    await mkdir(request.params.directory, { recursive: true });
    await writeFile(join(request.params.directory, "source.journal.jsonl"), journal);
    await writeFile(join(request.params.directory, "video.mov"), video);
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const source = {
      kind: "primary", sourceId, sourceDurationUs: data.durationUs, originHostUs: 0,
      journal: { file: "source.journal.jsonl", bytes: journal.length, sha256: hash(journal), lastSequence: 2, layout: 2 },
      members: { "video.mov": { bytes: String(video.length), sha256: hash(video) } }
    };
    await writeFile(join(request.params.directory, "source.publication.json"), JSON.stringify(source));
    data.sourcePublication = { state: "published", source };
  } else data.sourcePublication = { state: "unavailable", error: { code: "NO_SOURCE_MEDIA", message: "Scripted recovery found no source pictures" } };
  reply({ ok: true, data });
} else reply({ ok: false, error: { code: "NO_FIXTURE_MEDIA", message: request.operation, retryable: false, details: {} } });
`);
}

/**
 * Starts the real service with this test acting as the app: it answers the service's native
 * capture calls and can push capture reports up the same pipe.
 */
async function startService(
  home: string,
  peer: NativePeer = () => ({
    ok: false,
    error: { code: "UNKNOWN_OPERATION", message: "no native peer", retryable: false, details: {} },
  }),
  environment: NodeJS.ProcessEnv = {},
) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [entry], {
    cwd: "/",
    env: {
      ...process.env,
      YAP_HOME: home,
      YAP_NATIVE: await nativeWorker(),
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exit;
    clearTimeout(kill);
  };
  cleanup.push(close);
  let diagnostics = "";
  const asked: string[] = [];
  const reported = new Map<string, (response: unknown) => void>();
  child.stderr.on("data", (bytes) => (diagnostics += bytes));
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  const stream = new JsonLineStream(CONTROL_FRAME_BYTES);
  const socketPath = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service not ready: ${diagnostics}`)), 5_000);
    child.once("exit", () => reject(new Error(`Service exited: ${diagnostics}`)));
    child.stdout.on("data", (bytes: Buffer) => {
      for (const frame of stream.push(bytes)) {
        if (!frame.ok) throw frame.error;
        const message = controlMessageSchema.parse(frame.value);
        if (message.event === "started") {
          clearTimeout(timer);
          resolve(message.socketPath);
        }
        if (message.event === "failed") {
          clearTimeout(timer);
          reject(new Error(message.error.message));
        }
        if (message.event === "result") reported.get(message.response.id ?? "")?.(message.response);
        if (message.event === "call") {
          asked.push(message.request.operation);
          const answer = peer(message.request.operation, message.request.params);
          if (answer) send({ event: "result", response: { id: message.request.id, ...answer } });
        }
      }
    });
  });
  return {
    close,
    asked,
    // Background recovery may outlast readiness; await its diagnostic within the fixture budget.
    async waitForDiagnostic(pattern: RegExp) {
      const signal = AbortSignal.timeout(5_000);
      while (!pattern.test(diagnostics)) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Service exited before ${pattern}: ${diagnostics}`);
        await once(child.stderr, "data", { signal });
      }
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await exit;
    },
    /** Pushes one native capture report up the private pipe and waits for its answer. */
    report: (params: Record<string, unknown>) =>
      new Promise<{ ok: boolean; data?: unknown; error?: { code: string } }>((resolve) => {
        const id = randomUUID();
        reported.set(id, resolve as (response: unknown) => void);
        send({ event: "request", request: { id, operation: "capture.report", params } });
      }),
    // The client's own deadline for each operation: a test hears whatever the service answers.
    call: (operation: string, params: Record<string, unknown> = {}) =>
      callLocal(socketPath, { id: randomUUID(), operation, params }),
  };
}

/** A native peer that accepts one take and reports the sequences its journal would have. */
function capturingPeer(
  options: {
    durationUs?: number | null;
    reason?: string;
    message?: string;
    answerStart?: boolean;
  } = {},
): NativePeer {
  let take: { recordingId: string; sourceId: string } | undefined;
  let selection: ReturnType<typeof captureSelectionSchema.parse> | null = null;
  let cameraOn = false;
  let sequence = 1;
  const report = (state: string, extra: Record<string, unknown> = {}) => ({
    ok: true as const,
    data: { ...take, sequence: (sequence += 1), state, ...extra },
  });
  return (operation, params) => {
    if (operation === "capture.start") {
      if (take)
        return {
          ok: false,
          error: {
            code: "INVALID_STATE",
            message: "Another take is already capturing.",
            retryable: true,
            details: {},
          },
        };
      selection = captureSelectionSchema.parse(params);
      cameraOn = selection.cameraAtStart !== "off";
      take = {
        recordingId: params.recordingId as string,
        sourceId: params.sourceId as string,
      };
      // A take that is capturing while its caller hears nothing: the start is under way, so
      // the only word about it is the channel's own deadline.
      return options.answerStart === false ? undefined : report("recording");
    }
    if (operation === "capture.stop") {
      // Like the native helper, a stop with no take capturing answers INVALID_STATE.
      if (!take)
        return {
          ok: false,
          error: {
            code: "INVALID_STATE",
            message: "No take is capturing.",
            retryable: true,
            details: {},
          },
        };
      const duration = options.durationUs ?? 4_000_000;
      const answer = report(
        options.reason ? "interrupted" : "complete",
        options.reason
          ? { reason: options.reason, message: options.message, sourceDurationUs: duration }
          : { sourceDurationUs: duration },
      );
      take = undefined;
      return answer;
    }
    if (operation === "capture.cancel") {
      const answer = report("finalizing");
      take = undefined;
      return answer;
    }
    if (operation === "capture.pause") return report("paused");
    if (operation === "capture.resume") return report("recording");
    if (operation === "capture.setCamera" && take && selection?.cameraDeviceId)
      cameraOn = params.on === true;
    if (operation === "capture.status" || operation === "capture.setCamera")
      return {
        ok: true,
        data: {
          state: take ? "recording" : "idle",
          recordingId: take?.recordingId ?? null,
          sourceId: take?.sourceId ?? null,
          elapsedUs: take ? 1_500_000 : null,
          selection: take ? selection : null,
          camera:
            take && selection?.cameraDeviceId
              ? { deviceId: selection.cameraDeviceId, state: cameraOn ? "on" : "off" }
              : null,
          permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
        },
      };
    return {
      ok: false,
      error: {
        code: "UNKNOWN_OPERATION",
        message: operation,
        retryable: false,
        details: {},
      },
    };
  };
}

const fixtureSource = { kind: "window", id: 7 };

it("preserves a terminal report's message through public reads and restart", async () => {
  const home = await temporaryHome();
  const service = await startService(
    home,
    capturingPeer({ reason: "DEVICE_LOST", message: "The microphone disconnected." }),
  );
  const started = await service.call("capture.start", {
    requestId: "diagnostic",
    source: fixtureSource,
  });
  if (!started.ok) throw new Error("start failed");
  const recordingId = (started.data as { id: string }).id;
  const expected = {
    interruptionReason: "DEVICE_LOST",
    interruptionMessage: "The microphone disconnected.",
  };
  expect(await service.call("capture.stop", { recordingId })).toMatchObject({
    ok: true,
    data: expected,
  });
  expect(await service.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: expected,
  });
  await service.close();
  const reopened = await startService(home);
  expect(await reopened.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: expected,
  });
});

// Each completion restarts a service and may poll recovery for 5 s, so the case owns a wider budget.
it(
  "recovery keeps diagnostic code and message paired even without usable video",
  { timeout: 25_000 },
  async () => {
    for (const completion of [
      undefined,
      { failureCode: "DEVICE_LOST" },
      { failureCode: "DEVICE_LOST", failureMessage: "Original device failure" },
    ]) {
      const home = await temporaryHome();
      const abandoned = await startService(home, capturingPeer());
      const started = await abandoned.call("capture.start", {
        requestId: "diagnostic",
        source: fixtureSource,
      });
      if (!started.ok) throw new Error("start failed");
      const recordingId = (started.data as { id: string }).id;
      await abandoned.close();
      const recovered = await startService(home, capturingPeer(), {
        YAP_NATIVE: await recovers({
          durationUs: 0,
          journal: { header: {}, completion },
          tracks: [{ failure: { code: "ROLE_FAILED", message: "Role decode failed" } }],
        }),
      });
      await expect
        .poll(() => recovered.call("recording.get", { recordingId }), { timeout: 5_000 })
        .toMatchObject({
          ok: true,
          data: {
            state: "interrupted",
            interruptionReason: completion?.failureCode ?? "ROLE_FAILED",
            interruptionMessage: completion
              ? (completion.failureMessage ?? null)
              : "Role decode failed",
          },
        });
      await recovered.close();
    }
  },
);

it("allocates one take per start request and replays a repeated request onto it", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer());
  const first = await service.call("capture.start", { requestId: "take-1", source: fixtureSource });
  const replay = await service.call("capture.start", {
    requestId: "take-1",
    source: fixtureSource,
  });
  expect(first).toMatchObject({ ok: true, data: { state: "recording" } });
  expect(replay.ok && replay.data).toEqual(first.ok && first.data);
  // One allocation, one native start, one source directory: a lost response opens no second take.
  expect(service.asked.filter((operation) => operation === "capture.start")).toHaveLength(1);
  expect(await readdir(join(home, "library/recordings"))).toHaveLength(1);
});

it("reports the active source and audio choices through the public status operation", async () => {
  const service = await startService(await temporaryHome(), capturingPeer());
  const selection = {
    source: { kind: "region", displayId: 3, x: 40, y: 120, width: 800, height: 600 },
    microphone: true,
    microphoneDeviceId: "headset",
    systemAudio: true,
  };
  expect(
    await service.call("capture.start", { requestId: "selected", ...selection }),
  ).toMatchObject({ ok: true });
  expect(await service.call("capture.status")).toMatchObject({
    ok: true,
    data: { device: { selection, elapsedUs: 1_500_000 } },
  });
});

it("reports the device while the take it is capturing awaits deletion", async () => {
  const capturing = capturingPeer();
  const service = await startService(await temporaryHome(), (operation, params) =>
    // Native keeps capturing a take it will not hand over, so deletion cannot prove it quiet.
    operation === "capture.cancel"
      ? {
          ok: false,
          error: { code: "INVALID_STATE", message: "not held", retryable: true, details: {} },
        }
      : capturing(operation, params),
  );
  const started = await service.call("capture.start", {
    requestId: "deleted",
    source: fixtureSource,
  });
  if (!started.ok) throw new Error("the take must start");
  const { id: recordingId } = started.data as { id: string };
  expect(
    await service.call("recording.delete", { requestId: "test-delete", recordingId }),
  ).toMatchObject({
    ok: false,
    error: { code: "CAPTURE_NOT_QUIET", retryable: true },
  });
  expect(await service.call("capture.status")).toMatchObject({
    ok: true,
    data: { device: { state: "recording", recordingId }, recording: null },
  });
});

it("gives concurrent start requests one capturing take and one honest terminal failure", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer());
  const [first, second] = await Promise.all([
    service.call("capture.start", { requestId: "a", source: fixtureSource }),
    service.call("capture.start", { requestId: "b", source: fixtureSource }),
  ]);
  const answers = [first, second];
  expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
  const refused = answers.find((answer) => !answer.ok);
  expect(refused).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  const failedId = (refused as unknown as { error: { details: { recordingId: string } } }).error
    .details.recordingId;
  // A refused take retains its source identity and terminal reason without creating a project.
  expect(await service.call("recording.get", { recordingId: failedId })).toMatchObject({
    ok: true,
    data: {
      state: "interrupted",
      interruptionReason: "INVALID_STATE",
      interruptionMessage: "Another take is already capturing.",
    },
  });
  const ended = await service.call("recording.get", { recordingId: failedId });
  if (!ended.ok) throw new Error("missing refused take");
  const { sourceId } = ended.data as { sourceId: string };
  for (const sequence of [1, 2, 100]) {
    expect(
      await service.report({ recordingId: failedId, sourceId, sequence, state: "recording" }),
    ).toMatchObject({
      ok: true,
      data: { state: "interrupted", interruptionReason: "INVALID_STATE" },
    });
  }
  expect(
    await service.report({
      recordingId: failedId,
      sourceId: "wrong",
      sequence: 101,
      state: "recording",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  expect(await service.call("project.list")).toMatchObject({
    ok: true,
    data: { projects: [] },
  });
});

it("stores exact native transition sequences without a reserved service range", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer());
  const started = await service.call("capture.start", { requestId: "r", source: fixtureSource });
  if (!started.ok) throw new Error("start failed");
  const take = started.data as { id: string; sourceId: string };
  const sequence = 2 ** 40 + 5;
  expect(
    await service.report({
      recordingId: take.id,
      sourceId: take.sourceId,
      sequence,
      state: "paused",
    }),
  ).toMatchObject({ ok: true });
  expect(await service.call("recording.get", { recordingId: take.id })).toMatchObject({
    ok: true,
    data: { state: "paused", lifecycleSequence: sequence },
  });
});

it("cancels only the named take, removes its media, and refuses to revive it afterwards", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer());
  const kept = await service.call("capture.start", { requestId: "kept", source: fixtureSource });
  if (!kept.ok) throw new Error("start failed");
  const keptId = (kept.data as { id: string }).id;
  await service.call("capture.stop", { recordingId: keptId });
  const discarded = await service.call("capture.start", {
    requestId: "discarded",
    source: fixtureSource,
  });
  if (!discarded.ok) throw new Error("start failed");
  const take = discarded.data as { id: string; sourceId: string };
  expect(await service.call("capture.cancel", { recordingId: take.id })).toMatchObject({
    ok: true,
    data: { state: "canceled" },
  });
  expect(await readdir(join(home, "library/recordings"))).toEqual([keptId]);
  expect(await service.call("recording.get")).toMatchObject({
    ok: true,
    data: { id: keptId },
  });
  // A completion that was already in flight when the take was discarded must not resurrect it.
  // Terminal cancellation is authoritative even if an in-flight native report has a later number.
  expect(
    await service.report({
      recordingId: take.id,
      sourceId: take.sourceId,
      sequence: 40,
      state: "complete",
      sourceDurationUs: 9_000_000,
    }),
  ).toMatchObject({ ok: true, data: { state: "canceled" } });
  expect(
    await service.report({
      recordingId: take.id,
      sourceId: take.sourceId,
      sequence: Number.MAX_SAFE_INTEGER,
      state: "complete",
      sourceDurationUs: 9_000_000,
    }),
  ).toMatchObject({ ok: true, data: { state: "canceled" } });
  expect(await service.call("recording.get", { recordingId: take.id })).toMatchObject({
    ok: true,
    data: { state: "canceled", sourceDurationUs: null },
  });
});

it("restarts into a distinct take and answers a replayed restart with that same take", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer());
  const first = await service.call("capture.start", { requestId: "first", source: fixtureSource });
  if (!first.ok) throw new Error("start failed");
  const firstId = (first.data as { id: string }).id;
  const restarted = await service.call("capture.restart", {
    recordingId: firstId,
    requestId: "again",
    source: fixtureSource,
  });
  if (!restarted.ok) throw new Error("restart failed");
  const secondId = (restarted.data as { id: string }).id;
  expect(secondId).not.toBe(firstId);
  expect(restarted).toMatchObject({ ok: true, data: { state: "recording" } });
  const replay = await service.call("capture.restart", {
    recordingId: firstId,
    requestId: "again",
    source: fixtureSource,
  });
  expect(replay.ok && (replay.data as { id: string }).id).toBe(secondId);
  expect(await readdir(join(home, "library/recordings"))).toEqual([secondId]);
  expect(await service.call("recording.get", { recordingId: firstId })).toMatchObject({
    ok: true,
    data: { state: "canceled" },
  });
});

it("settles a stranded take from its own recovered media when a service starts again", async () => {
  const home = await temporaryHome();
  const abandoned = await startService(home, capturingPeer());
  const started = await abandoned.call("capture.start", {
    requestId: "stranded",
    source: fixtureSource,
  });
  if (!started.ok) throw new Error("start failed");
  const recordingId = (started.data as { id: string }).id;
  await abandoned.kill();

  const service = await startService(home, capturingPeer(), {
    YAP_NATIVE: await recovers({
      durationUs: 5_000_000,
      journal: { header: { sessionID: "s" } },
    }),
  });
  await expect
    .poll(() => service.call("recording.get", { recordingId }), { timeout: 5_000 })
    .toMatchObject({
      ok: true,
      data: {
        state: "interrupted",
        interruptionReason: "CAPTURE_INTERRUPTED",
        sourceDurationUs: 5_000_000,
      },
    });
  // Recovered source facts do not authorize an editing project.
  expect(await service.call("project.list")).toMatchObject({
    ok: true,
    data: { projects: [] },
  });
});

it("settles a stranded take with no recoverable video without authoring a project", async () => {
  const home = await temporaryHome();
  const abandoned = await startService(home, capturingPeer());
  const started = await abandoned.call("capture.start", { requestId: "s", source: fixtureSource });
  if (!started.ok) throw new Error("start failed");
  const recordingId = (started.data as { id: string }).id;
  await abandoned.kill();

  const service = await startService(home, capturingPeer(), {
    YAP_NATIVE: await recovers({ durationUs: 0, journal: { header: { sessionID: "s" } } }, 1.2),
  });
  await expect
    .poll(() => service.call("recording.get", { recordingId }), { timeout: 5_000 })
    .toMatchObject({
      ok: true,
      data: {
        state: "interrupted",
        interruptionReason: "NO_RECOVERABLE_VIDEO",
        sourceDurationUs: null,
      },
    });
  expect(await service.call("project.list")).toMatchObject({
    ok: true,
    data: { projects: [] },
  });
});

it("keeps a failed recovery for an explicit retry, which settles it once recovery can run", async () => {
  const home = await temporaryHome();
  const abandoned = await startService(home, capturingPeer());
  const started = await abandoned.call("capture.start", { requestId: "s", source: fixtureSource });
  if (!started.ok) throw new Error("start failed");
  const recordingId = (started.data as { id: string }).id;
  await abandoned.kill();

  const blind = await startService(home, capturingPeer(), {
    YAP_NATIVE: await nativeWorker("process.exit(3)"),
  });
  await blind.waitForDiagnostic(/recovery failed/);
  // Failed recovery remains discoverable and retryable without inventing a terminal outcome.
  expect(await blind.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "finalizing", sourceDurationUs: null, finalizationError: { retryable: true } },
  });
  await blind.close();

  const service = await startService(home, capturingPeer(), {
    YAP_NATIVE: await recovers({ durationUs: 2_000_000, journal: { header: {} } }),
  });
  // A recorded failure is not retried on startup; Retry Finalization (capture.stop) asks again.
  expect(await service.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "finalizing", finalizationError: { retryable: true } },
  });
  await service.call("capture.stop", { recordingId });
  await expect
    .poll(() => service.call("recording.get", { recordingId }), { timeout: 5_000 })
    .toMatchObject({
      ok: true,
      data: { state: "interrupted", sourceDurationUs: 2_000_000 },
    });
});

it(
  "settles a native call that is never answered instead of waiting forever",
  { timeout: 25_000 },
  async () => {
    const service = await startService(await temporaryHome(), () => undefined);
    const started = Date.now();
    const answer = await service.call("capture.status");
    expect(answer).toMatchObject({ ok: false, error: { code: "TIMEOUT", retryable: true } });
    expect(Date.now() - started).toBeLessThan(DEFAULT_CALL_TIMEOUT_MS * 2);
  },
);

it("settles a native call whose answer is unreadable as soon as that answer arrives", async () => {
  const service = await startService(
    await temporaryHome(),
    () => ({ ok: false, error: { code: "DENIED", message: "no details" } }) as OperationResult,
  );
  const started = Date.now();
  expect(await service.call("capture.status")).toMatchObject({
    ok: false,
    error: { code: "CONTROL_RESPONSE_INVALID", retryable: true },
  });
  expect(Date.now() - started).toBeLessThan(DEFAULT_CALL_TIMEOUT_MS);
});

it(
  "acknowledges a replay onto a stranded take while recovery continues",
  { timeout: 30_000 },
  async () => {
    const home = await temporaryHome();
    // A service killed with its start unanswered leaves that take live and its allocation
    // key replayable, which is what a relaunch has to recover before it captures again.
    const abandoned = await startService(home, () => undefined);
    abandoned
      .call("capture.start", { requestId: "replay", source: fixtureSource })
      .catch(() => undefined);
    await expect.poll(async () => (await takes(home)).length).toBe(1);
    await abandoned.kill();
    const [recordingId] = await takes(home);

    const service = await startService(home, capturingPeer(), {
      YAP_NATIVE: await recovers(
        { durationUs: 3_000_000, journal: { header: { sessionID: "s" } } },
        2,
      ),
    });
    // The listener is announced before recovery finishes, so this start arrives while the
    // relaunched service is still settling that same take.
    const replayed = await service.call("capture.start", {
      requestId: "replay",
      source: fixtureSource,
    });
    expect(replayed).toMatchObject({
      ok: true,
      data: { id: recordingId, state: "finalizing", sourceDurationUs: null },
    });
    // Recovery proves native absence without restarting the device.
    expect(service.asked).toEqual(["capture.status"]);
    // The receipt outlived the service that wrote it, so the same ID asking for a different take
    // is still refused rather than answered with this one.
    expect(
      await service.call("capture.start", {
        requestId: "replay",
        source: { kind: "window", id: 8 },
      }),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
    await expect
      .poll(() => service.call("recording.get", { recordingId }), { timeout: 5_000 })
      .toMatchObject({
        ok: true,
        data: { state: "interrupted", sourceDurationUs: 3_000_000 },
      });
  },
);

it(
  "stops and recovers a take whose start went unanswered rather than calling it refused",
  { timeout: 40_000 },
  async () => {
    const home = await temporaryHome();
    const service = await startService(home, capturingPeer({ answerStart: false }), {
      YAP_NATIVE: await recovers({
        durationUs: 6_000_000,
        journal: { header: { sessionID: "s" } },
      }),
    });
    const answer = await service.call("capture.start", {
      requestId: "silent",
      source: fixtureSource,
    });
    expect(answer).toMatchObject({ ok: false, error: { code: "TIMEOUT", retryable: true } });
    const recordingId = (answer as unknown as { error: { details: { recordingId: string } } }).error
      .details.recordingId;
    // The deadline proved nothing about the device, so the take is ended on it and settled from
    // the media that ending left behind.
    expect(service.asked).toContain("capture.stop");
    await expect
      .poll(() => service.call("recording.get", { recordingId }))
      .toMatchObject({
        ok: true,
        data: {
          state: "interrupted",
          interruptionReason: "CAPTURE_INTERRUPTED",
          sourceDurationUs: 6_000_000,
        },
      });
    expect(await service.call("capture.status")).toMatchObject({
      ok: true,
      data: { device: { state: "idle", recordingId: null } },
    });
  },
);

it(
  "leaves a take it could not prove ended open to the native report that follows",
  { timeout: 60_000 },
  async () => {
    const home = await temporaryHome();
    const service = await startService(home, () => undefined);
    const answer = await service.call("capture.start", {
      requestId: "silent",
      source: fixtureSource,
    });
    expect(answer).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", details: { state: "preparing" } },
    });
    const recordingId = (answer as unknown as { error: { details: { recordingId: string } } }).error
      .details.recordingId;
    const take = await service.call("recording.get", { recordingId });
    if (!take.ok) throw new Error("the take must still exist");
    const { sourceId } = take.data as { sourceId: string };
    // Nothing was authored over the take, so the session that did start is still the later word.
    expect(
      await service.report({ recordingId, sourceId, sequence: 2, state: "recording" }),
    ).toMatchObject({ ok: true, data: { state: "recording" } });
  },
);

/**
 * A native peer whose first start is still running when its answer is lost: the start and the
 * cleanup stop that follows are both unanswered, a second start meets the refusal a capturing
 * device gives, and the next stop ends the take.
 */
function heldStartPeer(): NativePeer {
  let held: { recordingId: string; sourceId: string } | undefined;
  let stops = 0;
  let sequence = 1;
  return (operation, params) => {
    if (operation === "capture.start") {
      if (held)
        return {
          ok: false,
          error: {
            code: "INVALID_STATE",
            message: "Another take is already capturing.",
            retryable: true,
            details: {},
          },
        };
      held = { recordingId: params.recordingId as string, sourceId: params.sourceId as string };
      return undefined;
    }
    if (operation === "capture.stop") {
      stops += 1;
      if (stops === 1) return undefined;
      const answer = {
        ok: true as const,
        data: {
          ...held,
          sequence: (sequence += 1),
          state: "interrupted",
          reason: "CAPTURE_INTERRUPTED",
          sourceDurationUs: 6_000_000,
        },
      };
      held = undefined;
      return answer;
    }
    if (operation === "capture.status")
      return {
        ok: true,
        data: {
          state: held ? "recording" : "idle",
          recordingId: held?.recordingId ?? null,
          sourceId: held?.sourceId ?? null,
          elapsedUs: held ? 0 : null,
          selection: null,
          camera: null,
          permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
        },
      };
    return {
      ok: false,
      error: { code: "UNKNOWN_OPERATION", message: operation, retryable: false, details: {} },
    };
  };
}

it(
  "resolves a replayed start onto its own unproved take instead of starting it again",
  { timeout: 120_000 },
  async () => {
    const home = await temporaryHome();
    const service = await startService(home, heldStartPeer(), {
      YAP_NATIVE: await recovers({
        durationUs: 6_000_000,
        journal: { header: { sessionID: "s" } },
      }),
    });
    const request = { requestId: "lost", source: fixtureSource };
    const first = await service.call("capture.start", request);
    expect(first).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", details: { state: "preparing" } },
    });
    const { recordingId } = (first as unknown as { error: { details: { recordingId: string } } })
      .error.details;
    // Neither the start nor the stop was answered, so the take may still be capturing.
    expect(await service.call("recording.get", { recordingId })).toMatchObject({
      ok: true,
      data: { state: "preparing", sourceDurationUs: null },
    });

    const replayed = await service.call("capture.start", request);
    expect(replayed).toMatchObject({ ok: true, data: { id: recordingId, state: "finalizing" } });
    await expect
      .poll(() => service.call("recording.get", { recordingId }))
      .toMatchObject({
        ok: true,
        data: {
          id: recordingId,
          state: "interrupted",
          interruptionReason: "CAPTURE_INTERRUPTED",
          sourceDurationUs: 6_000_000,
        },
      });
    expect(service.asked.filter((operation) => operation === "capture.start")).toHaveLength(1);
    expect(await readdir(join(home, "library/recordings"))).toEqual([recordingId]);
  },
);

it("refuses a start request ID reused for a different take instead of reinterpreting it", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer());
  const request = {
    requestId: "same",
    source: fixtureSource,
    microphone: false,
    systemAudio: false,
  };
  const started = await service.call("capture.start", request);
  expect(started).toMatchObject({ ok: true, data: { state: "recording" } });
  for (const changed of [
    { ...request, systemAudio: true },
    { ...request, source: { kind: "window", id: 8 } },
    { ...request, microphoneDeviceId: "device-1" },
  ])
    expect(await service.call("capture.start", changed)).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CONFLICT" },
    });
  // A refused reuse allocates nothing and starts nothing.
  expect(service.asked.filter((operation) => operation === "capture.start")).toHaveLength(1);
  expect(await readdir(join(home, "library/recordings"))).toHaveLength(1);
  const replayed = await service.call("capture.start", request);
  expect(replayed.ok && replayed.data).toEqual(started.ok && started.data);
});

it("allocates one primary camera and refuses a replay that changes its selected device", async () => {
  const home = await temporaryHome();
  const requested: Record<string, unknown>[] = [];
  const peer = capturingPeer();
  const service = await startService(home, (operation, params) => {
    if (operation === "capture.start") requested.push(params);
    return peer(operation, params);
  });
  const request = {
    requestId: "camera-primary",
    source: { kind: "camera", id: "camera-selected" },
    microphone: false,
    systemAudio: false,
  };
  const started = await service.call("capture.start", request);
  expect(started).toMatchObject({
    ok: true,
    data: { state: "recording", camera: null },
  });
  expect(requested[0]).toMatchObject({
    source: request.source,
    microphone: false,
    systemAudio: false,
  });
  for (const field of ["cameraDeviceId", "cameraSourceId", "cameraDirectory"])
    expect(requested[0]).not.toHaveProperty(field);
  if (!started.ok) throw new Error("Primary camera start failed");
  const { id: recordingId } = started.data as { id: string };
  expect(await readdir(join(home, "library/recordings", recordingId))).not.toContain("camera");
  expect(
    await service.call("capture.start", {
      ...request,
      source: { kind: "camera", id: "different-camera" },
    }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  const replayed = await service.call("capture.start", request);
  expect(replayed.ok && replayed.data).toEqual(started.data);
  expect(requested).toHaveLength(1);
  await service.close();
  const reopened = await startService(home, peer);
  expect(await reopened.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: { id: recordingId, camera: null },
  });
  expect(
    await reopened.call("capture.start", {
      ...request,
      source: { kind: "camera", id: "different-camera" },
    }),
  ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
  expect(await reopened.call("capture.start", request)).toMatchObject({
    ok: true,
    data: { id: recordingId },
  });
  expect(reopened.asked).not.toContain("capture.start");
});

it("replays a companion camera take only with the same start state, absent meaning on", async () => {
  const service = await startService(await temporaryHome(), capturingPeer());
  const request = {
    requestId: "camera-start-state",
    source: fixtureSource,
    cameraDeviceId: "camera-a",
  };
  const started = await service.call("capture.start", request);
  expect(started).toMatchObject({ ok: true, data: { state: "recording" } });
  expect(await service.call("capture.status")).toMatchObject({
    ok: true,
    data: { device: { camera: { deviceId: "camera-a", state: "on" } } },
  });
  expect(await service.call("capture.start", { ...request, cameraAtStart: "on" })).toMatchObject({
    ok: true,
    data: started.ok ? started.data : {},
  });
  expect(await service.call("capture.start", { ...request, cameraAtStart: "off" })).toMatchObject({
    ok: false,
    error: { code: "REQUEST_CONFLICT" },
  });
  expect(service.asked.filter((operation) => operation === "capture.start")).toHaveLength(1);
});

it("refuses pause and resume on a settled take while every other repeat stays idempotent", async () => {
  const home = await temporaryHome();
  const service = await startService(home, capturingPeer({ reason: "SOURCE_LOST" }));
  const started = await service.call("capture.start", { requestId: "take", source: fixtureSource });
  if (!started.ok) throw new Error("start failed");
  const { id: recordingId } = started.data as { id: string };
  // Native alone knows what the device is doing, so repeating a live transition stays idempotent.
  expect(await service.call("capture.pause", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "paused" },
  });
  expect(await service.call("capture.pause", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "paused" },
  });
  expect(await service.call("capture.resume", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "recording" },
  });
  expect(await service.call("capture.resume", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "recording" },
  });
  const stopped = await service.call("capture.stop", { recordingId });
  expect(stopped).toMatchObject({ ok: true, data: { state: "interrupted" } });

  // A take that has ended has no transition left to make, whatever ended it.
  for (const operation of ["capture.pause", "capture.resume"])
    expect(await service.call(operation, { recordingId })).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE", details: { state: "interrupted" } },
    });
  // Stopping a take that already ended still answers with its stored outcome.
  const again = await service.call("capture.stop", { recordingId });
  expect(again.ok && again.data).toEqual(stopped.ok && stopped.data);
  expect(service.asked.filter((operation) => operation === "capture.pause")).toHaveLength(2);
});

it("carries the product's audio default to native, and a caller's explicit refusal untouched", async () => {
  const home = await temporaryHome();
  const requested: Record<string, unknown>[] = [];
  const peer = capturingPeer();
  const service = await startService(home, (operation, params) => {
    if (operation === "capture.start") requested.push(params);
    return peer(operation, params);
  });
  const started = await service.call("capture.start", {
    requestId: "default",
    source: fixtureSource,
  });
  if (!started.ok) throw new Error("start failed");
  // The product records the person by default; nothing here reaches a real device.
  expect(requested[0]).toMatchObject({ microphone: true, systemAudio: false });
  await service.call("capture.stop", {
    recordingId: (started.data as { id: string }).id,
  });
  await service.call("capture.start", {
    requestId: "silent",
    source: fixtureSource,
    microphone: false,
    systemAudio: false,
  });
  expect(requested[1]).toMatchObject({ microphone: false, systemAudio: false });
});

it(
  "stops an unproved start and registers its recovered media on the first stop call",
  { timeout: 40_000 },
  async () => {
    const home = await temporaryHome();
    const peer = heldStartPeer();
    const service = await startService(
      home,
      (operation, params) => {
        const answer = peer(operation, params);
        if (operation === "capture.stop" && answer?.ok) {
          return {
            ok: true,
            data: { ...(answer.data as Record<string, unknown>), state: "complete", reason: null },
          };
        }
        return answer;
      },
      { YAP_NATIVE: await recovers({ durationUs: 6_000_000 }) },
    );
    const started = await service.call("capture.start", {
      requestId: "unproved-stop",
      source: fixtureSource,
    });
    expect(started).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    const latest = await service.call("recording.get");
    if (!latest.ok) throw new Error("Allocated take must be discoverable");
    const { id: recordingId } = latest.data as { id: string };
    const stopped = await service.call("capture.stop", { recordingId });
    expect(stopped).toMatchObject({ ok: true, data: { id: recordingId, state: "finalizing" } });
    await expect
      .poll(() => service.call("recording.get", { recordingId }))
      .toMatchObject({
        ok: true,
        data: {
          id: recordingId,
          state: "interrupted",
          sourceDurationUs: 6_000_000,
        },
      });
    expect(await service.call("capture.status")).toMatchObject({
      ok: true,
      data: { device: { state: "idle", recordingId: null } },
    });
  },
);

it("resumes persisted queued cleanup only after the recording service owners and recovery are ready", async () => {
  const home = await temporaryHome();
  await mkdir(join(home, "library"), { mode: 0o700 });
  const store = new CaptureStore(join(home, "library/catalog.sqlite"), {
    newId: randomUUID,
    now: () => new Date().toISOString(),
  });
  const { id: recordingId, sourceId } = store.allocate().recording;
  store.ingestLifecycle(recordingId, { sourceId, sequence: 1, state: "recording" });
  store.ingestLifecycle(recordingId, { sourceId, sequence: 2, state: "finalizing" });
  store.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 3,
    state: "complete",
    sourceDurationUs: 1000000,
  });
  await mkdir(join(home, "library/recordings", recordingId), { recursive: true, mode: 0o700 });
  const queue = new JobQueue({
    store,
    targets: {
      pin(target) {
        if (target.kind !== "recording" || target.revisionId !== null)
          throw new CatalogError("INVALID_REQUEST", "Cleanup seed requires a source target");
        store.get(target.id);
        return { ...target, revisionId: null };
      },
      isAvailable: (target) => target.kind === "recording" && store.isAvailable(target.id),
      isDeleting: (owner) => owner.kind === "recording" && store.isDeleting(owner.id),
      isCapturing: () => store.isCapturing(),
    },
    providers: { newId: randomUUID },
    deferExecution: true,
    execute: async () => {
      throw Error("Seeding must remain queued");
    },
  });
  const job = queue.submit({
    target: { kind: "recording", id: recordingId, revisionId: null },
    artifact: "capture-cleanup",
    lane: "heavy",
    input: sourceId,
  });
  expect(queue.job(job.jobId).state).toBe("queued");
  await queue.close();
  store.close();
  const service = await startService(home, capturingPeer(), {
    YAP_NATIVE: await recovers([
      { role: "narration", outcome: "alreadyClear" },
      { role: "system", outcome: "alreadyClear" },
    ]),
  });
  await expect
    .poll(() => service.call("job.get", { jobId: job.jobId }))
    .toMatchObject({
      ok: true,
      data: { state: "ready", published: { output: { recordingId, sourceId } } },
    });
});

it("pages source capture facts across default service restart without creating a project", async () => {
  const home = await temporaryHome();
  const { complete, failed, unfinished } = await seedRecordingStates(home);
  let service = await startService(home);
  const first = await service.call("recording.list", { limit: 1 });
  expect(first).toMatchObject({
    ok: true,
    data: {
      recordings: [{ id: unfinished.id, sourceId: unfinished.sourceId }],
      nextCursor: expect.any(String),
    },
  });
  if (!first.ok) throw new Error(JSON.stringify(first));
  expect(await service.call("recording.get")).toMatchObject({
    ok: true,
    data: { id: unfinished.id, sourceId: unfinished.sourceId },
  });
  await service.close();
  service = await startService(home);
  expect(
    await service.call("recording.list", {
      limit: 2,
      cursor: (first.data as { nextCursor: string }).nextCursor,
    }),
  ).toMatchObject({
    ok: true,
    data: {
      recordings: [
        {
          id: failed.id,
          sourceId: failed.sourceId,
          interruptionReason: "START_FAILED",
        },
        {
          id: complete.id,
          sourceId: complete.sourceId,
          sourceDurationUs: 10_000_000,
        },
      ],
      nextCursor: null,
    },
  });
  for (const params of [{ limit: 1001 }, { cursor: "garbage" }, { typo: true }])
    expect(await service.call("recording.list", params)).toMatchObject({
      ok: false,
      error: { code: "INVALID_PARAMS" },
    });
  expect(await service.call("recording.get", { recordingId: "missing" })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await service.call("project.list")).toMatchObject({ ok: true, data: { projects: [] } });
});
