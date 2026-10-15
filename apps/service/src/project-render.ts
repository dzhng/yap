import { divide, fromTime, sampleAt, subtract } from "@yap/composition";
import type { AudioWindowInput, ProjectRenderSupport } from "@yap/core/project-window";
import { executeComposition } from "./composition-worker.js";
import { withAudioProcessing, type AudioProcessingRuntime } from "./audio-processing.js";
import { nativeProcessing } from "./native-processing.js";
import { constants } from "node:fs";
import { copyFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CatalogError } from "@yap/core/catalog";
import { normalizationCorrectionPolicy } from "@yap/core/audio-measurement";
import type { CompositionMovie, ProjectMovieRenderer } from "@yap/core/project-preview";
import type { ProjectFrameRenderer } from "@yap/core/frame-inspection";
import type { ProjectAudioRenderer } from "@yap/core/audio-inspection";
import { withRenderAttempt, withRenderedFile } from "./render.js";
import {
  MAX_MEDIA_TIMEOUT_MS,
  renderWindowDeadlineMs,
  nativeResult,
  type MediaWorker,
} from "./worker.js";

import type { PointerPreparation, PointerHistoryRenderer } from "@yap/core/pointer-preparation";
import type { SourceEvidenceReader } from "@yap/core/evidence-read";
import type { PresentationReceipt } from "@yap/core/presentation-evidence";
import { prepareCompositionPointers } from "@yap/core/composition-pointer";
import { renderPlan } from "@yap/core/presentation-time";
export type NativePictureCapabilities = { sdrCorrection?: string; lut?: string };
export async function nativePictureCapabilities(
  worker: MediaWorker,
): Promise<NativePictureCapabilities> {
  try {
    const result = nativeResult(await worker("media.pictureCapabilities", {}, { timeoutMs: 5000 }));
    if (typeof result !== "object" || result === null) return {};
    const sdr = "sdrCorrection" in result ? result.sdrCorrection : undefined;
    const lut = "lut" in result ? result.lut : undefined;
    return {
      ...(typeof sdr === "string" &&
      sdr.startsWith("coreimage-sdr-source-neutral-recovery-v2:") &&
      sdr.length <= 256
        ? { sdrCorrection: sdr }
        : {}),
      ...(typeof lut === "string" &&
      lut.startsWith("coreimage-unit-linear-srgb-cube-trilinear-v1:") &&
      lut.length <= 256
        ? { lut }
        : {}),
    };
  } catch {
    return {};
  }
}
function picturePayload(
  window: AudioWindowInput["window"],
  capabilities: NativePictureCapabilities,
) {
  const payload: { sdrCorrectionImplementationId?: string; lutImplementationId?: string } = {};
  for (const [type, identity, field] of [
    ["sdr-correction", capabilities.sdrCorrection, "sdrCorrectionImplementationId"],
    ["lut", capabilities.lut, "lutImplementationId"],
  ] as const) {
    const requirements = window.manifest.requirements.filter(
      (item) => item.kind === "processor" && item.processor.type === type,
    );
    if (!requirements.length) continue;
    if (!identity || requirements.some((item) => item.implementationId !== identity))
      throw new CatalogError("NOT_READY", `The bound native ${type} recipe is unavailable`);
    payload[field] = identity;
  }
  return payload;
}
export type NativeAudioCapabilities = {
  rnnoise?: string;
  retime?: string;
  statePreparation?: string;
};
/** An absent/older worker leaves authoring and retained reads usable. */
export async function nativeAudioCapabilities(
  worker: MediaWorker,
): Promise<NativeAudioCapabilities> {
  try {
    const result = nativeResult(await worker("media.audioCapabilities", {}, { timeoutMs: 5000 }));
    if (typeof result !== "object" || result === null) return {};
    const rnnoise = "rnnoise" in result ? result.rnnoise : undefined;
    const retime = "retime" in result ? result.retime : undefined;
    const statePreparation = "statePreparation" in result ? result.statePreparation : undefined;
    return {
      ...(statePreparation === "native-audio-state-domains-v1" ? { statePreparation } : {}),
      ...(typeof rnnoise === "string" && /^rnnoise-[a-zA-Z0-9-]{1,240}$/.test(rnnoise)
        ? { rnnoise }
        : {}),
      ...(typeof retime === "string" && retime.length > 0 && retime.length <= 256
        ? { retime }
        : {}),
    };
  } catch {
    return {};
  }
}

function retimePayload(window: AudioWindowInput["window"], identity?: string) {
  const requirements = window.manifest.requirements.filter((item) => item.kind === "retime");
  if (!requirements.length) return {};
  if (!identity || requirements.some((item) => item.implementationId !== identity))
    throw new CatalogError(
      "NOT_READY",
      "The bound native retiming recipe is unavailable",
      {},
      true,
    );
  return { retimeImplementationId: identity };
}
function nativeAudioSupport(
  worker: MediaWorker,
  workspace: string,
  capabilities: NativeAudioCapabilities,
  signal: AbortSignal,
): Pick<ProjectRenderSupport, "rnnoise" | "retime" | "validateAudio"> {
  return {
    ...capabilities,
    ...(capabilities.retime || capabilities.statePreparation
      ? {
          async validateAudio({ window, assets }: AudioWindowInput) {
            await mkdir(workspace, { recursive: true, mode: 0o700 });
            await withRenderAttempt(
              worker,
              workspace,
              signal,
              async (directory, execute) => {
                const result = nativeResult(
                  await executeComposition(
                    execute,
                    "media.validateCompositionAudio",
                    {
                      output: join(directory, "audio.wav"),
                      range: window.manifest.sampleRange,
                      clips: [...window.audio()],
                      processing: nativeProcessing(window.processing()),
                      assets,
                      ...statePayload(window, capabilities.rnnoise, capabilities.statePreparation),
                      ...retimePayload(window, capabilities.retime),
                    },
                    { signal, timeoutMs: 5000 },
                  ),
                );
                if (
                  !result ||
                  typeof result !== "object" ||
                  (window.manifest.requirements.some((item) => item.kind === "retime") &&
                    (!("retime" in result) || result.retime !== capabilities.retime)) ||
                  (window.manifest.state?.domains.some(
                    (domain) => domain.recipe.type !== "rnnoise",
                  ) &&
                    (!("statePreparation" in result) ||
                      result.statePreparation !== capabilities.statePreparation))
                )
                  throw new CatalogError(
                    "INVALID_NATIVE_RESPONSE",
                    "Native admission did not confirm the bound audio recipe",
                  );
              },
              async () => undefined,
            );
          },
        }
      : {}),
  };
}

function retainedPayload(
  read: NonNullable<Parameters<ProjectAudioRenderer["render"]>[0]["prepared"]>,
  window: Parameters<ProjectAudioRenderer["render"]>[0]["window"],
) {
  const unavailable = [...window.audio()]
    .filter((clip) => clip.source.kind === "range")
    .map((clip) => ({
      clipId: clip.clipId,
      ranges: (read.value.unavailable.find((entry) => entry.clipId === clip.clipId)?.ranges ?? [])
        .map((range) => ({
          start: Math.max(range.start, clip.sampleRange.start),
          end: Math.min(range.end, clip.sampleRange.end),
        }))
        .filter((range) => range.end > range.start),
    }));
  return {
    retained: {
      descriptor: 3,
      identity: read.value.identity,
      bytes: read.value.bytes,
      dataOffset: read.dataOffset,
      frames: read.value.frames,
      range: read.sampleRange,
      unavailable,
    },
  };
}

function statePayload(
  window: Parameters<ProjectAudioRenderer["render"]>[0]["window"],
  identity?: string,
  preparationId?: string,
) {
  const state = window.audioState();
  if (!state) return {};
  if (!identity) throw new CatalogError("NOT_READY", "The native RNNoise recipe is unavailable");
  const external = state.domains.some(
    (domain) =>
      domain.recipe.type !== "rnnoise" && domain.sampleRange.end > domain.sampleRange.start,
  );
  if (external && !preparationId)
    throw new CatalogError("NOT_READY", "The native audio state preparation recipe is unavailable");
  return {
    ...(external ? { statePreparationImplementationId: preparationId } : {}),
    state: { ...state, processing: nativeProcessing(state.processing), implementationId: identity },
  };
}
export function audioDeadline(window: AudioWindowInput["window"], retained = false) {
  let preparationFrames = 0n;
  if (!retained) {
    for (const domain of window.manifest.state?.domains ?? []) {
      // Two initial scans plus a render and scanner for each bounded candidate.
      const passes =
        domain.recipe.type === "normalization" && domain.recipe.mode === "dynamic"
          ? normalizationCorrectionPolicy.maximumCandidates + 1
          : 1;
      preparationFrames +=
        BigInt(domain.sampleRange.end - domain.sampleRange.start) * BigInt(passes);
    }
    const retimed = new Set(
      window.manifest.requirements.flatMap((item) => (item.kind === "retime" ? [item.clipId] : [])),
    );
    const seen = new Set<string>();
    for (const clip of [...window.audio(), ...(window.audioState()?.clips ?? [])]) {
      if (clip.source.kind !== "range" || !retimed.has(clip.clipId)) continue;
      const rate = divide(
        subtract(fromTime(clip.source.range.endUs), fromTime(clip.source.range.startUs)),
        subtract(fromTime(clip.placement.endUs), fromTime(clip.placement.startUs)),
      );
      for (const context of clip.context) {
        const key = JSON.stringify([
          clip.source.assetId,
          clip.source.streamId,
          `${rate.numerator}/${rate.denominator}`,
          clip.pitch,
          context,
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        preparationFrames +=
          BigInt(context.sampleRange.end - context.sampleRange.start) +
          BigInt(
            sampleAt(fromTime(context.source.endUs), 48000) -
              sampleAt(fromTime(context.source.startUs), 48000),
          );
      }
    }
  }
  // Preparation is measured in frames; only its scheduling budget rounds up to milliseconds.
  const preparationMs = Number((preparationFrames * 1000n + 47999n) / 48000n);
  return Math.min(
    MAX_MEDIA_TIMEOUT_MS,
    renderWindowDeadlineMs(window.manifest.range) + 2 * preparationMs,
  );
}
type PointerOwners = { preparation: PointerPreparation; evidence: SourceEvidenceReader };
export function projectPointerHistoryRenderer(
  worker: MediaWorker,
  workspace: string,
): PointerHistoryRenderer {
  return {
    implementationId: "native-pointer-presentation-v2",
    render: async (request, signal) =>
      (await withRenderedFile(
        worker,
        { attemptParent: workspace, output: request.output, filename: "presentation.jsonl" },
        signal,
        async (output, execute) =>
          nativeResult(
            await execute(
              "media.presentationEvidence",
              {
                source: request.source,
                streamId: request.streamId,
                clockOffsetUs: request.clockOffsetUs,
                plan: renderPlan({ spans: request.spans }),
                output,
                ...request.limits,
              },
              {
                signal,
                timeoutMs: renderWindowDeadlineMs({
                  startUs: 0,
                  endUs: request.spans.reduce((sum, span) => sum + span.endUs - span.startUs, 0),
                }),
              },
            ),
          ) as PresentationReceipt,
      )) as PresentationReceipt,
  };
}
async function pointerFile(
  owners: PointerOwners | undefined,
  request: Pick<Parameters<ProjectMovieRenderer["render"]>[0], "window" | "model">,
  directory: string,
  signal: AbortSignal,
) {
  if (
    !owners ||
    !request.window.manifest.processing.some((node) =>
      node.steps.some((step) => step.enabled && step.processor.type === "pointer"),
    )
  )
    return undefined;
  return prepareCompositionPointers(
    {
      model: request.model,
      frames: () => request.window.frames(),
      output: join(directory, "pointers.jsonl"),
      preparation: owners.preparation,
      evidence: owners.evidence,
    },
    signal,
  );
}

/** Compiled pictures and PCM share the existing attempt and final movie publication boundary. */
export function projectMovieRenderer(
  worker: MediaWorker,
  workspace: string,
  pointers?: PointerOwners,
  capabilities: NativeAudioCapabilities = {},
  admissionSignal: AbortSignal = new AbortController().signal,
  pictureCapabilities: NativePictureCapabilities = {},
  processingRuntime?: AudioProcessingRuntime,
): ProjectMovieRenderer {
  return {
    implementationId:
      "native-composition-movie-v25" +
      (pictureCapabilities.sdrCorrection ? ":" + pictureCapabilities.sdrCorrection : "") +
      (pictureCapabilities.lut ? ":" + pictureCapabilities.lut : "") +
      (processingRuntime ? ":" + processingRuntime.implementationId : ""),
    ...pictureCapabilities,
    ...(processingRuntime ? { processors: processingRuntime.processors } : {}),
    ...nativeAudioSupport(worker, workspace, capabilities, admissionSignal),
    ...(pointers ? { pointers: pointers.preparation } : {}),
    async render(request, signal) {
      const pictureRecipe = picturePayload(request.window, pictureCapabilities);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const { manifest } = request.window;
      return withRenderAttempt(
        worker,
        workspace,
        signal,
        async (directory, execute, authority) => {
          const prepared = await pointerFile(pointers, request, directory, signal);
          const frames = join(directory, "frames.jsonl");
          const handle = await open(frames, "wx", 0o600);
          let frameCount = 0;
          try {
            let batch = "";
            for (const frame of request.window.frames()) {
              signal.throwIfAborted();
              batch += JSON.stringify(frame) + "\n";
              frameCount++;
              if (Buffer.byteLength(batch) >= 64 * 1024) {
                await handle.writeFile(batch);
                batch = "";
              }
            }
            if (batch) await handle.writeFile(batch);
          } finally {
            await handle.close();
          }
          signal.throwIfAborted();
          const file = join(directory, "movie.mp4");
          const params = {
            output: file,
            ...(prepared ? { pointers: prepared } : {}),
            frames,
            range: manifest.range,
            canvas: manifest.canvas,
            maxLongEdge: request.maxLongEdge,
            ...pictureRecipe,
            settings: request.settings,
            processing: nativeProcessing(request.window.processing()),
            assets: request.assets,
            fonts: request.fonts,
            luts: request.luts,
            audio: {
              range: manifest.sampleRange,
              clips: [...request.window.audio()],
              ...(request.prepared
                ? retainedPayload(request.prepared, request.window)
                : {
                    ...statePayload(
                      request.window,
                      capabilities.rnnoise,
                      capabilities.statePreparation,
                    ),
                    ...retimePayload(request.window, capabilities.retime),
                  }),
            },
          };
          const timeoutMs = audioDeadline(request.window, !!request.prepared);
          const consume = async (
            bound: MediaWorker,
            held: unknown[],
            descriptors: number[],
            processingEvidence: unknown[],
          ) => {
            const response = await executeComposition(
              bound,
              "media.renderCompositionMovie",
              {
                ...params,
                audio: { ...params.audio, ...(held.length ? { held } : {}) },
              },
              {
                signal,
                timeoutMs,
                descriptors: request.prepared ? [request.prepared.fd] : descriptors,
              },
            );
            const movie = nativeResult(response) as CompositionMovie;
            const evidence = request.prepared?.value.processingEvidence ?? processingEvidence;
            return {
              ...movie,
              ...(movie.audio && evidence.length
                ? { audio: { ...movie.audio, processingEvidence: evidence } }
                : {}),
            };
          };
          const movieResult = request.prepared
            ? await consume(execute, [], [], [])
            : await withAudioProcessing(
                {
                  window: request.window,
                  assets: request.assets,
                  directory,
                  worker: execute,
                  authority,
                  plan: {
                    output: file,
                    ...params.audio,
                    processing: params.processing,
                    assets: params.assets,
                  },
                  runtime: processingRuntime,
                  timeoutMs,
                },
                signal,
                consume,
              );
          signal.throwIfAborted();
          const movie = movieResult;
          if (movie.file !== file || movie.frameCount !== frameCount)
            throw new CatalogError(
              "INVALID_RESPONSE",
              "Movie receipt changed the compiled frame stream",
            );
          return movie;
        },
        async (movie) => {
          await copyFile(movie.file, request.output, constants.COPYFILE_EXCL);
          return { ...movie, file: request.output };
        },
      );
    },
  };
}

export function projectAudioRenderer(
  worker: MediaWorker,
  workspace: string,
  capabilities: NativeAudioCapabilities = {},
  admissionSignal: AbortSignal = new AbortController().signal,
  processingRuntime?: AudioProcessingRuntime,
): ProjectAudioRenderer {
  return {
    implementationId:
      "native-composition-audio-v10" +
      (processingRuntime ? ":" + processingRuntime.implementationId : ""),
    ...(processingRuntime ? { processors: processingRuntime.processors } : {}),
    encodingImplementationId: "native-aac-file-v1",
    validateOutput: async (settings) => {
      nativeResult(
        await worker(
          "media.validateAudioOutput",
          { settings },
          { signal: admissionSignal, timeoutMs: 5000 },
        ),
      );
    },
    encode: async ({ source, input, settings, output }, signal) =>
      withRenderedFile(
        worker,
        { attemptParent: workspace, output, filename: "audio.m4a" },
        signal,
        async (file, execute) =>
          nativeResult(
            await execute(
              "media.encodeAudioFile",
              { source: "/dev/fd/3", input, settings, output: file },
              {
                signal,
                timeoutMs: renderWindowDeadlineMs({
                  startUs: 0,
                  endUs: Math.floor((input.frames * 1000000) / input.sampleRate),
                }),
                descriptors: [source.fd],
              },
            ),
          ),
      ),
    ...nativeAudioSupport(worker, workspace, capabilities, admissionSignal),
    render: async ({ window, assets, output, prepared }, signal) =>
      withRenderedFile(
        worker,
        { attemptParent: workspace, output, filename: "audio.wav" },
        signal,
        async (file, execute, authority) => {
          const plan = {
            output: file,
            range: window.manifest.sampleRange,
            ...(prepared
              ? retainedPayload(prepared, window)
              : {
                  ...statePayload(window, capabilities.rnnoise, capabilities.statePreparation),
                  ...retimePayload(window, capabilities.retime),
                }),
            clips: [...window.audio()],
            processing: nativeProcessing(window.processing()),
            assets,
          };
          const timeoutMs = audioDeadline(window, !!prepared);
          const consume = async (
            bound: MediaWorker,
            held: unknown[],
            descriptors: number[],
            processingEvidence: unknown[],
          ) => {
            const result = nativeResult(
              await executeComposition(
                bound,
                "media.mixCompositionAudio",
                {
                  ...plan,
                  ...(held.length ? { held } : {}),
                },
                { signal, timeoutMs, descriptors: prepared ? [prepared.fd] : descriptors },
              ),
            );
            if (!result || typeof result !== "object")
              throw new CatalogError("INVALID_RESPONSE", "Malformed composition audio result");
            const evidence = prepared?.value.processingEvidence ?? processingEvidence;
            return { ...result, ...(evidence.length ? { processingEvidence: evidence } : {}) };
          };
          return prepared
            ? consume(execute, [], [], [])
            : withAudioProcessing(
                {
                  window,
                  assets,
                  directory: dirname(file),
                  worker: execute,
                  authority,
                  plan,
                  runtime: processingRuntime,
                  timeoutMs,
                },
                signal,
                consume,
              );
        },
      ),
  };
}

export function projectFrameRenderer(
  worker: MediaWorker,
  workspace: string,
  pointers?: PointerOwners,
  capabilities: NativePictureCapabilities = {},
): ProjectFrameRenderer {
  return {
    implementationId:
      "native-composition-picture-v21" +
      (capabilities.sdrCorrection ? ":" + capabilities.sdrCorrection : "") +
      (capabilities.lut ? ":" + capabilities.lut : ""),
    ...capabilities,
    ...(pointers ? { pointers: pointers.preparation } : {}),
    render: async (request, signal) => {
      const { window, assets, fonts, luts, output, maxLongEdge, observations, faceObservations } =
        request;
      const pictureRecipe = picturePayload(window, capabilities);
      return withRenderedFile(
        worker,
        { attemptParent: workspace, output, filename: "frame.png" },
        signal,
        async (file, execute) => {
          const prepared = await pointerFile(pointers, request, dirname(file), signal);
          return nativeResult(
            await execute(
              "media.renderCompositionFrame",
              {
                output: file,
                ...(prepared ? { pointers: prepared } : {}),
                frame: window.frames().next().value,
                canvas: window.manifest.canvas,
                ...pictureRecipe,
                profile: "h264-rec709",
                processing: nativeProcessing(window.processing()),
                assets,
                fonts,
                luts,
                maxLongEdge,
                ...(observations === undefined ? {} : { observations }),
                ...(faceObservations === undefined ? {} : { faceObservations }),
              },
              { signal },
            ),
          );
        },
      );
    },
  };
}
