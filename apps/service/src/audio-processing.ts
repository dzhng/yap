import { createHash } from "node:crypto";
import { constants, readSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { setImmediate } from "node:timers/promises";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessorImplementations } from "@yap/composition";
import { CatalogError } from "@yap/core/catalog";
import { fileIdentity } from "@yap/core/files";
import { O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import { readAudioWave } from "@yap/core/audio-wave";
import {
  normalizationGainDb,
  normalizationStep,
  normalizationTolerance,
  selectNormalizationAttempt,
  type AudioProcessingEvidence,
} from "@yap/core/audio-measurement";
import type { AudioWindowInput } from "@yap/core/project-window";
import { inspectFFmpegTools, type FFmpegInstallation } from "./ffmpeg-tools.js";
import { ffmpegLoudnessAnalyzer } from "./loudness.js";
import { cliWorker, nativeResult, type MediaWorker } from "./worker.js";
import { executeComposition } from "./composition-worker.js";
import { withFfmpegArtifact } from "./ffmpeg-artifact.js";
import type { RenderAttemptAuthority } from "./render.js";

export type AudioProcessingRuntime = {
  implementationId: string;
  installation: FFmpegInstallation;
  ownerExecutable: string;
  preparationId: string;
  processors: ProcessorImplementations;
};
const externalTypes = ["normalization", "limiter", "compressor"] as const;
/**
 * Each external processor's implementation id. It reaches every prepared-audio job key, so renaming
 * one re-keys work an earlier version failed instead of answering its old failure.
 */
export function processorImplementations(
  toolsReceiptSha256: string,
  preparationId: string,
): Record<(typeof externalTypes)[number], string> {
  return Object.fromEntries(
    externalTypes.map((type) => [
      type,
      `${type === "limiter" ? "linked-mono-max-limiter-v2" : type === "compressor" ? "peak-maximum-downward-compressor-v1" : "bounded-offset-normalization-v2"}:${toolsReceiptSha256}:${preparationId}`,
    ]),
  ) as Record<(typeof externalTypes)[number], string>;
}
export async function audioProcessingRuntime(
  installation: FFmpegInstallation | undefined,
  ownerExecutable: string | undefined,
  preparationId: string | undefined,
  signal: AbortSignal,
): Promise<AudioProcessingRuntime | undefined> {
  if (!installation || !ownerExecutable || preparationId !== "native-audio-state-domains-v1")
    return;
  const tools = await inspectFFmpegTools(installation, signal, ownerExecutable);
  if (!tools.available) return;
  const processors = processorImplementations(tools.receiptSha256, preparationId);
  return {
    installation,
    ownerExecutable,
    preparationId,
    processors,
    implementationId:
      "audio-processing-" + createHash("sha256").update(JSON.stringify(processors)).digest("hex"),
  };
}
async function validateWave(file: FileHandle, frameCount: number, signal: AbortSignal) {
  const bytes = Number((await file.stat()).size);
  const audio = readAudioWave({
    bytes,
    read: (buffer, position) => readSync(file.fd, buffer, 0, buffer.length, position),
  });
  if (audio.sampleRate !== 48000 || audio.channels !== 2 || audio.frames !== frameCount)
    throw new CatalogError(
      "INVALID_RESPONSE",
      "Audio recipe changed its complete stereo 48 kHz domain count",
    );
  const block = Buffer.alloc(8192 * 8);
  let peak = 0;
  for (let position = 0; position < audio.frames; position += 8192) {
    signal.throwIfAborted();
    const count = Math.min(8192, audio.frames - position) * 8;
    if (readSync(file.fd, block, 0, count, audio.dataOffset + position * 8) !== count)
      throw new CatalogError("INVALID_RESPONSE", "Audio recipe output is truncated");
    for (let at = 0; at < count; at += 4) {
      peak = Math.max(peak, Math.abs(block.readFloatLE(at)));
      if (!Number.isFinite(block.readFloatLE(at)))
        throw new CatalogError("INVALID_RESPONSE", "Audio recipe produced non-finite PCM");
    }
    await setImmediate(undefined, { signal });
  }
  return { ...audio, peak };
}
const inputArgs = (slot: number) => [
  "-protocol_whitelist",
  "fd,pipe",
  "-format_whitelist",
  "wav",
  "-fd",
  String(slot),
  "-i",
  "fd:",
];
const preamble = ["-nostdin", "-hide_banner", "-nostats"];
type Held = {
  domainIndex: number;
  recipe: NonNullable<
    ReturnType<AudioWindowInput["window"]["audioState"]>
  >["domains"][number]["recipe"];
  sampleRange: { start: number; end: number };
  sampleRate: 48000;
  channels: 2;
  pcm: {
    descriptor: number;
    identity: ReturnType<typeof fileIdentity>;
    bytes: number;
    dataOffset: number;
    frames: number;
    range: { start: number; end: number };
    unavailable: never[];
  };
};

/** Native owns prefix timing and routing; this executor walks only compiled dependencies. */
export async function withAudioProcessing<T>(
  request: AudioWindowInput & {
    directory: string;
    worker: MediaWorker;
    authority: RenderAttemptAuthority;
    plan: Record<string, unknown> & { output: string };
    runtime?: AudioProcessingRuntime | undefined;
    timeoutMs: number;
  },
  signal: AbortSignal,
  consume: (
    worker: MediaWorker,
    held: Held[],
    descriptors: number[],
    evidence: AudioProcessingEvidence[],
  ) => Promise<T>,
): Promise<T> {
  const state = request.window.audioState();
  const domains = state?.domains ?? [];
  if (
    !domains.some(
      (domain) =>
        domain.recipe.type !== "rnnoise" && domain.sampleRange.end > domain.sampleRange.start,
    )
  )
    return consume(request.worker, [], [], []);
  const runtime = request.runtime;
  if (!runtime)
    throw new CatalogError("NOT_READY", "Bundled typed audio processing is unavailable", {});
  const tools = await inspectFFmpegTools(runtime.installation, signal, runtime.ownerExecutable);
  if (!tools.available) throw new CatalogError(tools.code, tools.message, {});
  const order: number[] = [],
    status = new Uint8Array(domains.length);
  for (let start = 0; start < domains.length; start++) {
    if (status[start] === 2) continue;
    const pending: [number, number][] = [[start, 0]];
    status[start] = 1;
    while (pending.length) {
      const [index, next] = pending[pending.length - 1]!;
      const domain = domains[index]!;
      if (next === domain.dependencies.length) {
        status[index] = 2;
        order.push(index);
        pending.pop();
      } else {
        const dependency = domain.dependencies[next]!;
        pending[pending.length - 1]![1]++;
        if (status[dependency] === 1)
          throw new CatalogError("INVALID_RESPONSE", "Compiled audio dependency cycle");
        if (status[dependency] !== 2) {
          status[dependency] = 1;
          pending.push([dependency, 0]);
        }
      }
    }
  }
  const external = order.filter(
    (index) =>
      domains[index]!.recipe.type !== "rnnoise" &&
      domains[index]!.sampleRange.end > domains[index]!.sampleRange.start,
  );
  const held: Held[] = [],
    descriptors: number[] = [],
    evidence: AudioProcessingEvidence[] = [];
  const meter = ffmpegLoudnessAnalyzer(runtime.installation, runtime.ownerExecutable);
  const recurse = async (ordinal: number): Promise<T> => {
    if (ordinal === external.length) return consume(request.worker, held, descriptors, evidence);
    const domainIndex = external[ordinal]!,
      domain = domains[domainIndex]!,
      recipe = domain.recipe,
      frames = domain.sampleRange.end - domain.sampleRange.start;
    const implementationId = runtime.processors[recipe.type];
    if (!implementationId)
      throw new CatalogError("PREREQUISITE_MISSING", "Audio recipe implementation is unavailable");
    const expected = request.window.manifest.requirements.filter(
      (item) => item.kind === "processor" && item.processor.type === recipe.type,
    );
    if (
      expected.some(
        (item) => item.implementationId != null && item.implementationId !== implementationId,
      )
    )
      throw new CatalogError(
        "PREREQUISITE_MISSING",
        "Audio processing implementation differs from its pinned requirement",
      );
    const prefixes: {
      path: string;
      file: FileHandle;
      audio: Awaited<ReturnType<typeof validateWave>>;
    }[] = [];
    const prefix = async (input: "program" | "detector") => {
      const path = join(request.directory, `domain-${domainIndex}-${input}.wav`);
      const receipt = nativeResult(
        await executeComposition(
          request.worker,
          "media.prepareCompositionAudioDomain",
          { ...request.plan, output: path, held, domainIndex, input },
          { signal, timeoutMs: request.timeoutMs, descriptors },
        ),
      );
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("file" in receipt) ||
        receipt.file !== path ||
        !("domainIndex" in receipt) ||
        receipt.domainIndex !== domainIndex ||
        !("recipe" in receipt) ||
        !isDeepStrictEqual(receipt.recipe, recipe) ||
        !("sampleRange" in receipt) ||
        !isDeepStrictEqual(receipt.sampleRange, domain.sampleRange) ||
        !("input" in receipt) ||
        receipt.input !== input
      )
        throw new CatalogError("INVALID_RESPONSE", "Native domain receipt changed its output path");
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
      try {
        const audio = await validateWave(file, frames, signal);
        const value = { path, file, audio };
        prefixes.push(value);
        return value;
      } catch (error) {
        await file.close();
        throw error;
      }
    };
    try {
      const program = await prefix("program");
      const detector =
        recipe.type === "compressor" && recipe.detector.kind !== "input"
          ? await prefix("detector")
          : undefined;
      let filter: string, before: Awaited<ReturnType<typeof meter.measure>> | undefined;
      let dynamic: { offsetDb: number; filter: (offsetDb: number) => string } | undefined;
      const attempts: NonNullable<AudioProcessingEvidence["normalization"]>["attempts"] = [];
      // Nothing measurable to normalize: the signal passes through at unity, with an issue.
      const unity = "[0:a]volume=1:precision=double[out]";
      if (recipe.type === "limiter") {
        const ceiling = 10 ** (recipe.ceilingDbfs / 20);
        filter = `[0:a]asetnsamples=n=128:p=1,asplit=2[p][d];[d]aeval=exprs=max(abs(val(0))\\,abs(val(1))):c=mono,asplit=2[m][md];[m]alimiter=limit=${ceiling}:attack=${recipe.lookaheadMs}:release=${recipe.releaseMs}:level_in=1:level_out=1:level=false:asc=false:latency=true,asetnsamples=n=128:p=1[ml];[p][md][ml]amerge=inputs=3,aeval=exprs=if(eq(val(2)\\,0)\\,val(0)\\,val(0)*val(3)/val(2))|if(eq(val(2)\\,0)\\,val(1)\\,val(1)*val(3)/val(2)):c=stereo,atrim=end_sample=${frames}[out]`;
      } else if (recipe.type === "compressor") {
        const inputs = detector
          ? "[0:a]asetnsamples=n=128:p=1[p];[1:a]asetnsamples=n=128:p=1[d]"
          : "[0:a]asetnsamples=n=128:p=1,asplit=2[p][d]";
        filter = `${inputs};[p][d]sidechaincompress=threshold=${10 ** (recipe.thresholdDbfs / 20)}:ratio=${recipe.ratio}:attack=${recipe.attackMs}:release=${recipe.releaseMs}:knee=${10 ** (recipe.kneeDb / 20)}:detection=peak:link=maximum:level_in=1:level_sc=1:makeup=${10 ** ((recipe.makeupGainDb ?? 0) / 20)}:mix=1:mode=downward,atrim=end_sample=${frames}[out]`;
      } else if (recipe.type === "normalization") {
        before = await meter.measure(
          {
            source: { fd: program.file.fd, bytes: program.audio.bytes },
            audio: program.audio,
            channelInterpretation: "native",
            truePeak: true,
          },
          signal,
        );
        const gain = normalizationGainDb(recipe, before);
        if (!gain) filter = unity;
        else if (recipe.mode === "gain-only")
          filter = `[0:a]volume=${10 ** (gain.gainDb / 20)}:precision=double[out]`;
        else {
          const base = `loudnorm=I=${recipe.targetIntegratedLufs}:TP=${recipe.truePeakCeilingDbtp}:LRA=${recipe.maxLoudnessRangeLu}:linear=false`;
          const first = nativeResult(
            await cliWorker(
              {
                executable: tools.executables.ffmpeg.path,
                ownerExecutable: runtime.ownerExecutable,
                args: [
                  ...preamble,
                  ...inputArgs(3),
                  "-af",
                  base + ":print_format=json",
                  "-f",
                  "null",
                  "-",
                ],
              },
              {
                signal,
                timeoutMs: request.timeoutMs,
                maxBytes: 65536,
                descriptors: [program.file.fd, ...request.authority.descriptors],
                rewindDescriptors: [3],
              },
            ),
          ) as { stderr: string };
          const at = first.stderr.lastIndexOf("{");
          let measured: Record<string, unknown>;
          try {
            measured = JSON.parse(first.stderr.slice(at, first.stderr.indexOf("}", at) + 1));
          } catch {
            throw new CatalogError(
              "INVALID_RESPONSE",
              "Dynamic normalization has no first-pass statistics",
            );
          }
          const statistics = [
            "input_i",
            "input_tp",
            "input_lra",
            "input_thresh",
            "target_offset",
          ].map((name) => (typeof measured[name] === "string" ? Number(measured[name]) : NaN));
          if (statistics.every(Number.isFinite)) {
            const [integrated, truePeak, range, threshold, offsetDb] = statistics as number[];
            const measuredFilter = `${base}:measured_I=${integrated}:measured_TP=${truePeak}:measured_LRA=${range}:measured_thresh=${threshold}`;
            dynamic = {
              offsetDb: offsetDb!,
              filter: (offsetDb) => `[0:a]${measuredFilter}:offset=${offsetDb}[out]`,
            };
            filter = dynamic.filter(dynamic.offsetDb);
          } else filter = unity;
        }
      } else throw new CatalogError("INVALID_RESPONSE", "Unexpected external audio recipe");
      // Each measured candidate's publication; nested artifact lifetimes keep every one held until
      // correction settles, so the best can be published whichever attempt it was.
      const candidates: (() => Promise<T>)[] = [];
      const treat = async (candidate: number): Promise<T> => {
        const filename = `domain-${domainIndex}-treated-${candidate}.wav`;
        return withFfmpegArtifact(
          request.worker,
          {
            attempt: {
              directory: request.directory,
              worker: request.worker,
              authority: request.authority,
            },
            filename,
            executable: tools.executables.ffmpeg.path,
            ownerExecutable: runtime.ownerExecutable,
            descriptors: [program.file.fd, ...(detector ? [detector.file.fd] : [])],
            rewindDescriptors: detector ? [3, 4] : [3],
            timeoutMs: request.timeoutMs,
            maxBytes: 65536,
            args: (slot) => [
              ...preamble,
              ...inputArgs(3),
              ...(detector ? inputArgs(4) : []),
              "-filter_complex",
              filter,
              "-map",
              "[out]",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-c:a",
              "pcm_f32le",
              "-f",
              "wav",
              "-fd",
              String(slot),
              "fd:",
            ],
          },
          signal,
          async (file) => {
            const audio = await validateWave(file, frames, signal);
            const normalization =
              recipe.type === "normalization"
                ? {
                    before: before!,
                    after: await meter.measure(
                      {
                        source: { fd: file.fd, bytes: audio.bytes },
                        audio,
                        channelInterpretation: "native",
                        truePeak: true,
                      },
                      signal,
                    ),
                    attempts,
                    selectedAttempt: candidate,
                    meterImplementationId: meter.implementationId,
                    tolerances: normalizationTolerance,
                  }
                : undefined;
            if (normalization)
              attempts.push({ offsetDb: dynamic?.offsetDb ?? null, after: normalization.after });
            return { audio, normalization };
          },
          async (artifact) => {
            const finish = async (): Promise<T> => {
              held.push({
                domainIndex,
                recipe,
                sampleRange: domain.sampleRange,
                sampleRate: 48000,
                channels: 2,
                pcm: {
                  descriptor: 3 + descriptors.length,
                  identity: artifact.identity,
                  bytes: artifact.bytes,
                  dataOffset: artifact.evidence.audio.dataOffset,
                  frames,
                  range: { start: 0, end: frames },
                  unavailable: [],
                },
              });
              descriptors.push(artifact.file.fd);
              evidence.push({
                domainIndex,
                recipe,
                sampleRange: domain.sampleRange,
                implementationId,
                ...(artifact.evidence.normalization
                  ? { normalization: artifact.evidence.normalization }
                  : {}),
                // The limited peak is evidence; a peak over the ceiling becomes an issue.
                ...(recipe.type === "limiter"
                  ? { limiter: { samplePeak: artifact.evidence.audio.peak } }
                  : {}),
              });
              // Retain only completed domain outputs while downstream recipes execute.
              for (const p of prefixes.splice(0)) {
                await p.file.close();
                await unlink(p.path);
              }
              return recurse(ordinal + 1);
            };
            if (!dynamic || recipe.type !== "normalization") return finish();
            candidates.push(finish);
            const step = normalizationStep(recipe, attempts);
            if ("offsetDb" in step) {
              dynamic.offsetDb = step.offsetDb;
              filter = dynamic.filter(step.offsetDb);
              return treat(candidate + 1);
            }
            // Publish the best measured candidate; a missed target becomes an issue.
            return candidates[selectNormalizationAttempt(recipe, attempts)]!();
          },
        );
      };
      return await treat(0);
    } finally {
      for (const p of prefixes) {
        await p.file.close();
        await unlink(p.path);
      }
    }
  };
  return recurse(0);
}
