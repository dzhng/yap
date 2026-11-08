import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { CatalogError } from "@yap/core/catalog";
import {
  alignmentCorrespondenceInput,
  alignmentOperandByteLimit,
} from "@yap/core/alignment-operands";
import type { AlignmentObserver } from "@yap/core/alignment-processing";
import { sourceChannelPCM } from "./source-channel.js";
import { withRenderAttempt } from "./render.js";
import { nativeResult, preparedModelWorker, type MediaWorker } from "./worker.js";

async function operand(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > alignmentOperandByteLimit)
      throw new CatalogError(
        "INVALID_EVIDENCE",
        "Alignment operand exceeds bounded regular storage",
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
/** Complete original operands are captured before the shared attempt retires. */
export function alignmentObserver(native: MediaWorker, workspace: string): AlignmentObserver {
  return async (request, signal) => {
    const model = preparedModelWorker(request.runtime, 600000),
      worker: MediaWorker = (operation, params, options) =>
        (operation === "alignment.observe" ? model : native)(operation, params, options);
    return withRenderAttempt(
      worker,
      workspace,
      signal,
      async (directory, execute) => {
        const pcmPath = join(directory, "alignment.f32"),
          output = join(directory, "alignment-report.json"),
          pcm = await sourceChannelPCM(execute, request.selected, request.decoder, pcmPath, signal);
        const result = await execute(
          "alignment.observe",
          {
            model: request.checkpoint,
            modelSha256: request.engine.modelSha256,
            pcm: pcmPath,
            pcmSha256: pcm.sha256,
            frames: pcm.frames,
            sampleRate: pcm.sampleRate,
            text: request.selected.text,
            output,
          },
          { signal, timeoutMs: 600000 },
        );
        const operands = {
          nativeReceipt: await operand(output + ".native-unverified.json"),
          report: await operand(output),
          correspondence: "",
        };
        if (!result.ok) {
          const { frames: _frames, ...publicPcm } = pcm;
          return {
            pcm: { ...publicPcm, frameCount: pcm.frames },
            operands,
            failure: new CatalogError(
              result.error.code,
              result.error.message,
              result.error.details,
            ),
          };
        }
        try {
          const input = alignmentCorrespondenceInput(operands);
          operands.correspondence = JSON.stringify(
            nativeResult(await execute("speech.correspond", input, { signal, timeoutMs: 10000 })),
          );
          const { frames: _frames, ...publicPcm } = pcm;
          return { pcm: { ...publicPcm, frameCount: pcm.frames }, operands };
        } catch (error) {
          signal.throwIfAborted();
          return {
            pcm: (() => {
              const { frames: _frames, ...publicPcm } = pcm;
              return { ...publicPcm, frameCount: pcm.frames };
            })(),
            operands,
            failure:
              error instanceof CatalogError
                ? error
                : new CatalogError(
                    "INVALID_EVIDENCE",
                    "Alignment correspondence operands cannot be admitted",
                  ),
          };
        }
      },
      async (observed) => observed,
    );
  };
}
