import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { writeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { callLocal } from "@yap/client";
import { CONTROL_FRAME_BYTES, JsonLineStream, controlMessageSchema } from "@yap/protocol";
import type { OperationResult } from "@yap/protocol";
import { startProjectService } from "./project-service.js";
import type { MediaWorker } from "./worker.js";

export async function captureFixture(
  cleanup: (() => Promise<void>)[],
  home?: string,
  worker?: MediaWorker,
  silentOperation?: string,
  /** The control channel's default per-call deadline; production uses the protocol's. */
  controlTimeoutMs?: number,
) {
  if (!home) {
    home = await mkdtemp("/tmp/project-capture-");
    const root = home;
    cleanup.push(() => rm(root, { recursive: true, force: true }));
  }
  const input = new PassThrough(),
    output = new PassThrough();
  const frames = new JsonLineStream(CONTROL_FRAME_BYTES);
  const reports = new Map<string, (result: OperationResult) => void>();
  const nativeCalls: string[] = [];
  const nativeRequests: { operation: string; params: Record<string, unknown> }[] = [];
  const unanswered = new Map<string, string>();
  /** Native's own refusal for the next call of an operation. */
  const refusals = new Map<string, { code: string; message: string }>();
  let take: { recordingId: string; sourceId: string } | undefined;
  let selection: Record<string, unknown> | null = null;
  let camera: { deviceId: string; state: "on" | "off" } | null = null;
  let deviceState = "idle";
  let sequence = 0;
  const publications = new Map<string, unknown>();
  const publicationReport = async (value: unknown) => {
    const report = value as Record<string, unknown>;
    const sourceId = String(report.sourceId);
    if (report.publication != null) {
      publications.set(sourceId, report.publication);
      const publication = report.publication as Record<
        string,
        { state?: string; source?: unknown } | null
      >;
      for (const kind of ["primary", "camera"]) {
        const outcome = publication[kind];
        if (outcome?.state !== "published") continue;
        const directory = join(
          home,
          "library/recordings",
          String(report.recordingId),
          kind === "primary" ? "source" : "camera",
        );
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "source.publication.json"), JSON.stringify(outcome.source));
      }
    }
    if (
      report.publication !== undefined ||
      !["complete", "interrupted"].includes(String(report.state)) ||
      typeof report.sourceDurationUs !== "number" ||
      report.sourceDurationUs <= 0
    )
      return value;
    if (!publications.has(sourceId)) {
      const directory = join(home, "library/recordings", String(report.recordingId), "source");
      const journal = await readFile(join(directory, "capture.journal.jsonl")).catch(() =>
        Buffer.from(JSON.stringify({ sessionID: sourceId })),
      );
      const video = await readFile(join(directory, "video.mov")).catch(() =>
        Buffer.from("scripted source bytes"),
      );
      await writeFile(join(directory, "source.journal.jsonl"), journal);
      const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      publications.set(sourceId, {
        generation: `fixture-${sourceId}`,
        sourceId,
        inputsClosed: true,
        primary: {
          state: "published",
          source: {
            kind: "primary",
            sourceId,
            sourceDurationUs: report.sourceDurationUs,
            originHostUs: 0,
            journal: {
              file: "source.journal.jsonl",
              bytes: journal.length,
              sha256: sha256(journal),
              lastSequence: 2,
              layout: 2,
            },
            members: { "video.mov": { bytes: String(video.length), sha256: sha256(video) } },
          },
        },
        camera: null,
      });
      await writeFile(
        join(directory, "source.publication.json"),
        JSON.stringify(
          (publications.get(sourceId) as { primary: { source: unknown } }).primary.source,
        ),
      );
    }
    return { ...report, publication: publications.get(sourceId) };
  };
  output.on("data", (chunk: Buffer) => {
    for (const frame of frames.push(chunk)) {
      if (!frame.ok) throw frame.error;
      const message = controlMessageSchema.parse(frame.value);
      if (message.event === "result") reports.get(message.response.id!)?.(message.response);
      if (message.event !== "call") continue;
      const { operation, params } = message.request;
      nativeCalls.push(operation);
      nativeRequests.push({ operation, params });
      if (operation === "capture.start") {
        take = { recordingId: String(params.recordingId), sourceId: String(params.sourceId) };
        selection = {
          source: params.source,
          microphone: params.microphone,
          systemAudio: params.systemAudio,
          ...(params.cameraDeviceId === undefined ? {} : { cameraDeviceId: params.cameraDeviceId }),
          ...(params.cameraAtStart === undefined ? {} : { cameraAtStart: params.cameraAtStart }),
        };
        camera =
          params.cameraDeviceId === undefined
            ? null
            : {
                deviceId: String(params.cameraDeviceId),
                state: params.cameraAtStart === "off" ? "off" : "on",
              };
        sequence = 0;
      }
      const refusal = refusals.get(operation);
      if (refusal) {
        refusals.delete(operation);
        input.write(
          JSON.stringify({
            event: "result",
            response: {
              id: message.request.id,
              ok: false,
              error: { ...refusal, retryable: false, details: {} },
            },
          }) + "\n",
        );
        continue;
      }
      if (operation === "capture.setCamera" && camera) camera.state = params.on ? "on" : "off";
      const device = ["capture.status", "capture.setCamera"].includes(operation);
      const state = ["capture.stop", "capture.cancel"].includes(operation)
        ? "finalizing"
        : operation === "capture.pause"
          ? "paused"
          : "recording";
      const data = device
        ? {
            state: deviceState,
            recordingId: take?.recordingId ?? null,
            sourceId: take?.sourceId ?? null,
            elapsedUs: take ? 0 : null,
            selection,
            camera: camera && { ...camera },
            permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
          }
        : { ...take, sequence: ++sequence, state };
      if (!device) deviceState = state;
      if (operation === "capture.cancel") {
        take = undefined;
        selection = null;
        camera = null;
        deviceState = "idle";
      }
      if (operation === silentOperation) {
        unanswered.set(operation, message.request.id!);
        continue;
      }
      input.write(
        JSON.stringify({
          event: "result",
          response: {
            id: message.request.id,
            ok: true,
            data,
          },
        }) + "\n",
      );
    }
  });
  const service = await startProjectService({
    home,
    control: {
      input,
      output,
      ...(controlTimeoutMs === undefined ? {} : { timeoutMs: controlTimeoutMs }),
    },
    worker: async (operation, params, options) => {
      if (operation === "storage.clearRenderWorkspace")
        return { ok: true, data: { removed: true } };
      if (operation === "media.audioCapabilities") return { ok: true, data: {} };
      if (worker) return worker(operation, params, options);
      return filesWorker(operation, params, options);
    },
  });
  cleanup.push(() => service.close());
  return {
    home,
    service,
    input,
    nativeCalls,
    nativeRequests,
    refuseNext(operation: string, code: string, message = code) {
      refusals.set(operation, { code, message });
    },
    async reply(operation: string, data: unknown) {
      const id = unanswered.get(operation);
      if (!id) throw new Error(`No unanswered controller request: ${operation}`);
      unanswered.delete(operation);
      input.write(
        JSON.stringify({
          event: "result",
          response: { id, ok: true, data: await publicationReport(data) },
        }) + "\n",
      );
    },
    call: (operation: string, params: Record<string, unknown> = {}) =>
      callLocal(service.socketPath, { id: randomUUID(), operation, params }),
    report: async (params: Record<string, unknown>) => {
      params = (await publicationReport(params)) as Record<string, unknown>;
      return new Promise<OperationResult>((resolve) => {
        if (
          ["complete", "interrupted"].includes(String(params.state)) &&
          params.recordingId === take?.recordingId
        ) {
          take = undefined;
          selection = null;
          camera = null;
          deviceState = "idle";
        }
        const id = randomUUID();
        reports.set(id, resolve);
        input.write(
          JSON.stringify({
            event: "request",
            request: { id, operation: "capture.report", params },
          }) + "\n",
        );
      });
    },
  };
}

export const sourceWorker: MediaWorker = async (operation, params, options) => {
  if (operation.startsWith("storage.")) return filesWorker(operation, params, options);
  if (operation === "media.sourceEvidence") {
    const header = JSON.parse(
      await readFile(join(String(params.directory), "capture.journal.jsonl"), "utf8"),
    );
    await writeFile(String(params.output), "");
    return {
      ok: true,
      data: {
        ...(params.sourceAuthority
          ? { verifiedSourceAuthority: (params.sourceAuthority as { source: unknown }).source }
          : {}),
        file: params.output,
        journal: "capture.journal.jsonl",
        header,
        originHostUs: 0,
        completion: { sequence: 2, state: "complete", durationUs: 100 },
        cursorSamples: 0,
        geometryRecords: 0,
        displaySpaces: 0,
        pauseEvents: 0,
        audioIntervals: 0,
        lastSequence: 2,
        incompleteTail: false,
        finished: true,
        bytes: 0,
      },
    };
  }
  if (operation === "media.probe") {
    const bytes = Buffer.from(
      JSON.stringify({
        originUs: 0,
        streams: [
          {
            id: "track:1",
            kind: "video",
            codec: "fixture",
            width: 16,
            height: 16,
            orientedWidth: 16,
            orientedHeight: 16,
            decodable: true,
            startUs: 0,
            endUs: 100,
            segments: [{ startUs: 0, endUs: 100, empty: false }],
          },
        ],
      }),
    );
    writeSync(
      options!.descriptors![Number(String(params.output).split("/").at(-1)) - 3]!,
      bytes,
      0,
      bytes.length,
      0,
    );
    return {
      ok: true,
      data: {
        file: params.output,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
  throw new Error(`Unexpected fixture worker operation: ${operation}`);
};

// This filesystem edge exercises coordination, not native descriptor validation.
export const filesWorker: MediaWorker = async (operation, params, options) => {
  if (operation === "storage.recordingDirectory") {
    const info = fstatSync(options!.descriptors![0]!, { bigint: true });
    return { ok: true, data: { dev: String(info.dev), ino: String(info.ino) } };
  }
  if (operation === "storage.removeRecordingDirectory") {
    await rm(join(String(params.home), "recordings", String(params.recordingId)), {
      recursive: true,
      force: true,
    });
    return { ok: true, data: { removed: true } };
  }
  if (operation === "storage.removeCacheFiles") return { ok: true, data: { removed: true } };
  throw new Error(`Unexpected worker operation: ${operation}`);
};

/** Starts, stops and completes one display take whose source the service then admits. */
export async function settleCapture(
  f: Awaited<ReturnType<typeof captureFixture>>,
  requestId: string,
) {
  const started = await f.call("capture.start", {
    requestId,
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  const directory = join(f.home, "library", "recordings", recordingId, "source");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: sourceId }),
  );
  await writeFile(join(directory, "video.mov"), "borrowed source bytes");
  await f.call("capture.stop", { recordingId });
  const reported = await f.report({
    recordingId,
    sourceId,
    sequence: 3,
    state: "complete",
    sourceDurationUs: 100,
  });
  if (!reported.ok) throw new Error(JSON.stringify(reported));
  const { acquisitionId, job } = (
    reported.data as { sourceAdmissions: { acquisitionId: string; job: { jobId: string } }[] }
  ).sourceAdmissions[0]!;
  return { recordingId, sourceId, directory, acquisitionId, job };
}
