import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { callLocal } from "@yap/client";
import { encodeJsonLine, REQUEST_FRAME_BYTES } from "@yap/protocol";
import { startProjectService } from "./project-service.js";
import type { MediaWorker } from "./worker.js";
import { PassThrough } from "node:stream";
import { EventEmitter, once } from "node:events";
import {
  CONTROL_FRAME_BYTES,
  JsonLineStream,
  type ControlMessage,
  type ControlResponse,
} from "@yap/protocol";
import { idempotentOperations, operationNames, readOnlyOperations } from "@yap/protocol";

/** The same framed pipe and socket composition as the native host, with observable write completion. */
export async function projectServiceControlFixture(
  cleanups: (() => Promise<void>)[],
  worker: MediaWorker,
) {
  const input = new PassThrough(),
    output = new PassThrough();
  const stream = new JsonLineStream(CONTROL_FRAME_BYTES);
  const events = new EventEmitter();
  let sequence = 0;
  output.on("data", (chunk: Buffer) => {
    for (const outcome of stream.push(chunk)) {
      if (!outcome.ok) throw outcome.error;
      const message = outcome.value as ControlMessage;
      if (message.event === "result") events.emit(message.response.id!, message.response);
      else events.emit(message.event, message);
    }
  });
  const fixture = await projectServiceFixture(cleanups, worker, undefined, {
    control: { input, output },
  });
  const control = async (operation: string, params: Record<string, unknown> = {}) => {
    const id = `fixture-${++sequence}`;
    const needsRequestId =
      operationNames.has(operation) &&
      !readOnlyOperations.has(operation as never) &&
      !idempotentOperations.has(operation as never) &&
      params.requestId === undefined;
    const wireParams = needsRequestId ? { ...params, requestId: id } : params;
    const response = once(events, id);
    input.write(
      JSON.stringify({ event: "request", request: { id, operation, params: wireParams } }) + "\n",
    );
    return (await response)[0] as ControlResponse;
  };
  return { ...fixture, control, events, input, output };
}

export function probeFileFixture(home: string, worker: MediaWorker): MediaWorker {
  return async (operation, params, options) => {
    // Preserve the real worker's strict wire boundary even when its execution is a fixture.
    encodeJsonLine({ id: "fixture", operation, params }, REQUEST_FRAME_BYTES);
    if (["media.audioCapabilities", "media.pictureCapabilities"].includes(operation))
      return { ok: true, data: {} };
    if (operation === "storage.clearRenderWorkspace") {
      const parent = params.parent as { name: string } | undefined;
      if (parent)
        await rm(join(home, "library", "render", parent.name), { recursive: true, force: true });
      return { ok: true, data: { removed: true } };
    }
    const result = await worker(operation, params, options);
    if (operation !== "media.probe" || !result.ok) return result;
    // Model the native file handoff; each test still supplies its own probe result/error.
    const bytes = Buffer.from(JSON.stringify(result.data));
    const index = Number(String(params.output).split("/").at(-1)) - 3;
    writeSync(options!.descriptors![index]!, bytes, 0, bytes.length, 0);
    return {
      ok: true,
      data: {
        file: params.output,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
}
export async function projectServiceFixture(
  cleanups: (() => Promise<void>)[],
  worker: MediaWorker,
  existingHome?: string,
  serviceOptions: Pick<
    Parameters<typeof startProjectService>[0],
    "control" | "version" | "autoPrepareModels" | "presets"
  > = {},
) {
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), "asset-service-")));
  if (!existingHome) cleanups.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "source.png");
  await writeFile(path, "image bytes");
  const service = await startProjectService({
    ...serviceOptions,
    autoPrepareModels: false,
    home,
    worker: probeFileFixture(home, worker),
    // The fake worker is the whole native side; a YAP_NATIVE in the caller's environment is not it.
    nativeExecutable: undefined,
  });
  cleanups.push(() => service.close());
  let requestSequence = 0;
  async function call(operation: string, params: Record<string, unknown>) {
    // Public writes now require request identity. Keep older service fixtures focused on their
    // behavior by supplying a fresh identity when the test is not explicitly exercising replay.
    const needsRequestId =
      !readOnlyOperations.has(operation as never) &&
      !idempotentOperations.has(operation as never) &&
      params.requestId === undefined;
    const wireParams = needsRequestId
      ? { ...params, requestId: `fixture-${operation}-${++requestSequence}` }
      : params;
    try {
      const result = await callLocal(service.socketPath, {
        id: "test",
        operation,
        params: wireParams,
      });
      if (result.ok && ["job.get", "job.retry", "job.cancel", "asset.import"].includes(operation)) {
        expect(result.data).not.toHaveProperty("input");
        expect(result.data).toHaveProperty("inputSha256", expect.stringMatching(/^[a-f0-9]{64}$/));
      }
      return result;
    } catch (error) {
      throw error;
    }
  }
  async function job(jobId: string, state: string) {
    const deadline = performance.now() + 3000;
    for (;;) {
      const result = await call("job.get", { jobId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          state: string;
          published: { generation: string; attemptId: string; output: { assetId: string } } | null;
          attemptGeneration: number;
          errorCode: string | null;
        };
        if (data.state === state) return data;
        if (["failed", "unavailable", "canceled"].includes(data.state))
          throw new Error(`Unexpected terminal job: ${JSON.stringify(data)}`);
      }
      if (performance.now() >= deadline)
        throw new Error(`Job never reached ${state}: ${JSON.stringify(result)}`);
      await delay(10);
    }
  }
  return { home, path, service, call, job };
}
