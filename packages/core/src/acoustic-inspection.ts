import { loudnessMeasurementSchema, type LoudnessMeasurement } from "./audio-measurement.js";
import {
  selectionRangeSchema,
  sourceAvailability,
  compare,
  fromTime,
  toTime,
  rational,
  sampleAt,
  type TimeValue,
} from "@yap/composition";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { CatalogError } from "./catalog.js";
import type { DerivedCache } from "./cache.js";
import type { JobQueue, JobExecution, Job } from "./jobs.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import {
  MediaAudioInspection,
  parsePublicAudioArtifact,
  type MediaAudioInput,
  type SourceAudioArtifact,
  type ProjectAudioArtifact,
  selectedRange,
} from "./audio-inspection.js";
import { pauseIntervals, waveformBuckets, sampleGrid, validateAudioWave } from "./audio-wave.js";
import { spectralLayout, spectralWindows } from "./audio-spectrum.js";
import { acousticImageRequest, type AcousticImageRequest } from "./acoustic-image.js";

const waveformOptions = z.strictObject({
  audioJobId: z.string().min(1),
  audioGeneration: z.int().positive(),
  bucketFrames: z.int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  policy: z.literal("waveform-buckets-v1"),
});
const spectrumOptions = waveformOptions.omit({ bucketFrames: true, policy: true }).extend({
  fftFrames: z.int().positive(),
  hopFrames: z.int().positive(),
  range: selectionRangeSchema,
  sampleRange: z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() }),
  policy: z.literal("spectrum-density-v1"),
});
const loudnessSignalSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preparedResourceId: z.string().nullable(),
  processingSha256: z.string().nullable(),
});
const loudnessOptions = waveformOptions.omit({ bucketFrames: true, policy: true }).extend({
  policy: z.literal("loudness-bs1770-v1"),
  implementationId: z.string().min(1),
  channelInterpretation: z.enum(["native", "dual-mono"]),
  truePeak: z.boolean(),
  signalRecipe: loudnessSignalSchema,
  scope: z.enum(["full-signal", "excerpt"]),
});
const pauseOptions = waveformOptions.omit({ bucketFrames: true, policy: true }).extend({
  policy: z.literal("pause-rms-v1"),
  thresholdRMS: z.number().finite().nonnegative(),
  windowFrames: z.int().positive(),
  hopFrames: z.int().positive(),
  channel: z.int().nonnegative().nullable(),
  minDurationUs: z.number().int().positive(),
  windowUs: z.int().positive(),
  hopUs: z.int().positive(),
});
export { loudnessMeasurementSchema, type LoudnessMeasurement } from "./audio-measurement.js";
export type LoudnessAnalyzer = {
  implementationId: string;
  measure(
    request: {
      source: { fd: number; bytes: number };
      audio: Pick<AudioArtifact, "frames" | "sampleRate" | "channels">;
      channelInterpretation: "native" | "dual-mono";
      truePeak: boolean;
    },
    signal: AbortSignal,
  ): Promise<LoudnessMeasurement>;
};
const optionsSchema = z.union([waveformOptions, spectrumOptions, loudnessOptions, pauseOptions]);
const PAUSE_DEFAULTS = {
  thresholdRMS: 0.01,
  windowUs: 20_000,
  hopUs: 10_000,
  minDurationUs: 300_000,
} as const;
export type AcousticInput = MediaAudioInput & { format?: "json" | "image" | undefined } & (
    | { kind?: "waveform"; bucketFrames?: number | undefined }
    | { kind: "spectrum"; fftFrames?: number | undefined; hopFrames?: number | undefined }
    | {
        kind: "loudness";
        channelInterpretation?: "native" | "dual-mono" | undefined;
        truePeak?: boolean | undefined;
      }
    | {
        kind: "pause";
        thresholdRMS?: number | undefined;
        minDurationUs?: number | undefined;
        channel?: number | undefined;
      }
  );
type AudioArtifact = SourceAudioArtifact | ProjectAudioArtifact;
function metadata(audio: AudioArtifact) {
  const common = {
    range: audio.range,
    timeOriginUs: 0,
    sampleRange: audio.sampleRange,
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    layout: audio.layout,
    implementationId: audio.implementationId,
  };
  return "projectId" in audio
    ? {
        ...common,
        unavailable: audio.unavailable,
        domain: "project" as const,
        projectId: audio.projectId,
        revisionId: audio.revisionId,
        tap: audio.tap,
      }
    : {
        ...common,
        unavailable: audio.unavailable,
        domain: "source" as const,
        assetId: audio.assetId,
        streamId: audio.streamId,
        ...(audio.acquisitionId ? { acquisitionId: audio.acquisitionId } : {}),
        supportDigest: audio.supportDigest,
      };
}
function publicAcousticArtifact(value: AcousticArtifact) {
  const { bytes, range, sampleRange, context, ...rest } = value as any;
  return {
    ...rest,
    sizeBytes: bytes,
    ...("projectId" in value ? { range } : { sourceRange: range }),
    sampleRange: { startSamples: sampleRange.start, endSamples: sampleRange.end },
    ...(context
      ? {
          context: {
            ...context,
            sampleRange: {
              startSamples: context.sampleRange.start,
              endSamples: context.sampleRange.end,
            },
          },
        }
      : {}),
  };
}
function parsePublicAcousticArtifact(value: unknown): AcousticArtifact {
  if (!value || typeof value !== "object")
    throw new CatalogError("ARTIFACT_CHANGED", "Acoustic receipt is unavailable");
  const record = value as Record<string, any>;
  if (
    "bytes" in record ||
    !Number.isSafeInteger(record.sizeBytes) ||
    !record.sampleRange ||
    !Number.isSafeInteger(record.sampleRange.startSamples) ||
    !Number.isSafeInteger(record.sampleRange.endSamples)
  )
    throw new CatalogError("ARTIFACT_CHANGED", "Acoustic receipt uses an obsolete shape");
  const { sizeBytes, sourceRange, sampleRange, context, ...rest } = record;
  const project = "projectId" in record;
  if (
    (project && (sourceRange !== undefined || rest.range === undefined)) ||
    (!project && (sourceRange === undefined || rest.range !== undefined))
  )
    throw new CatalogError("ARTIFACT_CHANGED", "Acoustic receipt uses an obsolete shape");
  return {
    ...rest,
    bytes: sizeBytes,
    range: project ? rest.range : sourceRange,
    sampleRange: { start: sampleRange.startSamples, end: sampleRange.endSamples },
    ...(context
      ? {
          context: {
            ...context,
            sampleRange: {
              start: context.sampleRange.startSamples,
              end: context.sampleRange.endSamples,
            },
          },
        }
      : {}),
  } as AcousticArtifact;
}
export type AcousticArtifact = ReturnType<typeof metadata> & {
  file: string;
  bytes: number;
  mediaType: "application/json" | "image/png";
  cacheId: string;
  bucketFrames?: number;
  bucketCount?: number;
  context?: Pick<ReturnType<typeof metadata>, "range" | "sampleRange" | "unavailable">;
  analysis:
    | { kind: "waveform"; bucketFrames: number; bucketCount: number }
    | { kind: "spectrum"; fftFrames: number; hopFrames: number; columnCount: number }
    | {
        kind: "loudness";
        channelInterpretation: "native" | "dual-mono";
        truePeak: boolean;
        implementationId: string;
        signalRecipe: z.infer<typeof loudnessSignalSchema>;
        scope: "full-signal" | "excerpt";
        measurement: LoudnessMeasurement;
      }
    | {
        kind: "pause";
        thresholdRMS: number;
        windowUs: number;
        hopUs: number;
        channel: number | null;
        minDurationUs: number;
        algorithm: "rms-window-v1";
        intervals: {
          range: ReturnType<typeof metadata>["range"];
          durationUs: number;
          rms: number;
        }[];
        unavailable: ReturnType<typeof metadata>["unavailable"];
      };
  audio: { jobId: string; generation: number };
};
const imageOptions = z.strictObject({
  measurementJobId: z.string().min(1),
  measurementGeneration: z.int().positive(),
  implementationId: z.string().min(1),
});
const imageReceipt = z.object({
  file: z.string(),
  bytes: z
    .int()
    .positive()
    .max(32 * 1024 * 1024),
  mediaType: z.literal("image/png"),
  width: z.int().positive(),
  height: z.int().positive(),
  provenance: z.array(z.string()),
  plotLeft: z.int().nonnegative(),
  plotWidth: z.int().positive(),
  plotTop: z.int().nonnegative(),
  panelHeight: z.int().positive(),
  panelStride: z.int().positive(),
  amplitudeLimit: z.number().positive().nullable().optional(),
  densityFloorDb: z.number().nullable().optional(),
  densityCeilingDb: z.number().nullable().optional(),
});
export type AcousticRenderer = {
  implementationId: string;
  render(request: AcousticImageRequest, signal: AbortSignal): Promise<unknown>;
};
const lost = (message: string) => new CatalogError("DEPENDENCY_LOST", message);
function audioUnavailableSamples(audio: AudioArtifact) {
  return "projectId" in audio
    ? audio.unavailable.flatMap((entry) => entry.ranges)
    : audio.unavailable.map((range) => ({
        start: sampleAt(fromTime(range.startUs), audio.sampleRate),
        end: sampleAt(fromTime(range.endUs), audio.sampleRate),
      }));
}
/** Acoustic derivatives retain audio provenance; only a rebuild needs the disposable PCM bytes. */
export class AcousticInspection {
  constructor(
    private readonly owners: {
      audio: MediaAudioInspection;
      jobs: JobQueue;
      cache: DerivedCache;
      renderer?: AcousticRenderer;
      loudness?: LoudnessAnalyzer;
    },
  ) {}
  private input(value: AcousticInput) {
    const { format, ...input } = value;
    if (input.kind === "loudness") {
      const { kind, channelInterpretation = "native", truePeak = true, ...selection } = input;
      if (format !== undefined)
        throw new CatalogError(
          "INVALID_PARAMS",
          "Loudness returns measurements without an image rendition",
        );
      const analyzer = this.owners.loudness;
      if (!analyzer)
        throw new CatalogError("PREREQUISITE_MISSING", "Loudness analyzer is unavailable", {});
      const recipe = this.owners.audio.recipe(selection);
      if (channelInterpretation === "dual-mono" && recipe.channels !== 1)
        throw new CatalogError("INVALID_PARAMS", "Dual-mono interpretation requires a mono signal");
      return {
        recipe,
        selection: recipe.selection,
        artifact: kind,
        parameters: {
          policy: "loudness-bs1770-v1" as const,
          implementationId: analyzer.implementationId,
          channelInterpretation,
          truePeak,
          signalRecipe: {
            sha256: createHash("sha256")
              .update(
                JSON.stringify({
                  ...recipe.identity,
                  ...("processingSha256" in recipe
                    ? { processingSha256: recipe.processingSha256 }
                    : {}),
                }),
              )
              .digest("hex"),
            preparedResourceId:
              "preparedResourceId" in recipe.options
                ? (recipe.options.preparedResourceId ?? null)
                : null,
            processingSha256: "processingSha256" in recipe ? recipe.processingSha256 : null,
          },
          scope: isDeepStrictEqual(selectedRange(recipe.selection), recipe.fullRange)
            ? ("full-signal" as const)
            : ("excerpt" as const),
        },
      };
    }
    if (input.kind === "pause") {
      const {
        kind,
        thresholdRMS = PAUSE_DEFAULTS.thresholdRMS,
        minDurationUs = PAUSE_DEFAULTS.minDurationUs,
        channel,
        ...selection
      } = input;
      const recipe = this.owners.audio.recipe(selection),
        clock = recipe.sampleClock;
      if (!clock)
        throw new CatalogError(
          "UNSUPPORTED_FORMAT",
          "Pause detection requires an integral sample rate",
        );
      if (channel !== undefined && (recipe.channels === undefined || channel >= recipe.channels))
        throw new CatalogError("INVALID_PARAMS", "Pause channel is outside the selected audio");
      const windowFrames = Math.max(
        1,
        Math.round((PAUSE_DEFAULTS.windowUs * clock.sampleRate) / 1_000_000),
      );
      const hopFrames = Math.max(
        1,
        Math.round((PAUSE_DEFAULTS.hopUs * clock.sampleRate) / 1_000_000),
      );
      return {
        recipe,
        selection: recipe.selection,
        parameters: {
          policy: "pause-rms-v1" as const,
          thresholdRMS,
          windowFrames,
          hopFrames,
          channel: channel ?? null,
          minDurationUs,
          windowUs: PAUSE_DEFAULTS.windowUs,
          hopUs: PAUSE_DEFAULTS.hopUs,
        },
        artifact: kind,
      };
    }
    if (input.kind === "spectrum") {
      const { kind, fftFrames = 1024, hopFrames = 512, ...selection } = input;
      const display = this.owners.audio.recipe(selection),
        clock = display.sampleClock;
      if (!clock)
        throw new CatalogError("UNSUPPORTED_FORMAT", "Spectra require an integral sample rate");
      if (display.channels !== 1 && display.channels !== 2)
        throw new CatalogError("UNSUPPORTED_FORMAT", "Spectra require known mono or stereo audio");
      const layout = spectralLayout(
        {
          ...clock,
          frames: clock.sampleRange.end - clock.sampleRange.start,
          channels: display.channels,
        },
        { fftFrames, hopFrames },
      );
      const recipe = this.owners.audio.context(display.selection, layout.context);
      return {
        recipe,
        selection: display.selection,
        parameters: {
          fftFrames,
          hopFrames,
          range: selectedRange(display.selection),
          sampleRange: clock.sampleRange,
          policy: "spectrum-density-v1" as const,
        },
        artifact: kind,
      };
    }
    const { bucketFrames, kind, ...selection } = input;
    if (bucketFrames !== undefined && (!Number.isSafeInteger(bucketFrames) || bucketFrames < 1))
      throw new CatalogError("INVALID_PARAMS", "bucketFrames must be a positive integer");
    const recipe = this.owners.audio.recipe(selection);
    if (bucketFrames !== undefined && recipe.sampleClock) {
      const { sampleRange } = recipe.sampleClock;
      sampleGrid({ sampleRange, frames: sampleRange.end - sampleRange.start }, { bucketFrames });
    }
    return {
      recipe,
      selection: recipe.selection,
      parameters: {
        bucketFrames: bucketFrames ?? null,
        policy: "waveform-buckets-v1" as const,
      },
      artifact: kind ?? "waveform",
    };
  }
  private dependency(identity: ReturnType<MediaAudioInspection["recipe"]>["identity"]) {
    const status = this.owners.jobs.status(identity);
    return {
      status,
      summary: {
        jobId: status.jobId,
        state: status.state,
        reason: status.reason,
        retryable: status.retryable,
        generation: status.published?.generation ?? null,
      },
    };
  }
  async request(input: AcousticInput) {
    return input.format === "image" ? this.image(input) : this.measurements(input);
  }
  private async measurements(input: AcousticInput, regenerate = true) {
    const { recipe, selection, parameters, artifact } = this.input(input);
    let dependency = this.dependency(recipe.identity);
    if (!dependency.status.published) {
      await this.owners.audio.request(recipe.selection);
      dependency = this.dependency(recipe.identity);
    }
    if (!dependency.status.published)
      return {
        ...selection,
        state: dependency.status.state,
        reason: dependency.status.reason,
        retryable: dependency.status.retryable,
        jobId: dependency.status.jobId,
        dependency: dependency.summary,
        published: null,
      };
    if (artifact === "loudness") {
      const audio = parsePublicAudioArtifact(JSON.parse(dependency.status.published.result));
      assertLoudnessCoverage(audio);
    }
    const identity = {
      target: recipe.identity.target,
      artifact,
      input: JSON.stringify({
        audioJobId: dependency.status.jobId!,
        audioGeneration: dependency.status.published.generation,
        ...parameters,
      }),
    };
    const retained = this.owners.jobs.status(identity);
    const status =
      !regenerate && retained.published
        ? {
            ...retained,
            published: {
              generation: retained.published.generation,
              issues: retained.published.issues,
              value: JSON.parse(retained.published.result) as AcousticArtifact,
            },
          }
        : submitCachedDerivative<AcousticArtifact>(
            this.owners.jobs,
            this.owners.cache,
            identity,
            "heavy",
          );
    return {
      ...selection,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      dependency: dependency.summary,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            artifact: status.published.value,
          }
        : null,
    };
  }
  private async image(input: AcousticInput) {
    const renderer = this.owners.renderer;
    if (!renderer)
      throw new CatalogError("PREREQUISITE_MISSING", "Acoustic image renderer is unavailable", {});
    const measurement = await this.measurements(input, false);
    if (!measurement.published) return measurement;
    const source = this.owners.jobs.job(measurement.jobId!);
    const status = submitCachedDerivative<AcousticArtifact>(
      this.owners.jobs,
      this.owners.cache,
      {
        target: source.target,
        artifact: "acoustic-image",
        input: JSON.stringify({
          measurementJobId: source.jobId,
          measurementGeneration: measurement.published.generation,
          implementationId: renderer.implementationId,
        }),
      },
      "heavy",
    );
    return {
      ...measurement,
      ...status,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            artifact: status.published.value,
          }
        : null,
    };
  }
  async retry(input: AcousticInput) {
    const { recipe, selection } = this.input(input);
    const pinnedInput = { ...input, ...selection };
    const current = await this.request(pinnedInput);
    if (current.published) return current;
    if (input.format === "image") {
      await this.retry({ ...pinnedInput, format: "json" });
    } else await this.owners.audio.retry(recipe.selection);
    const next = await this.request(pinnedInput);
    if (next.jobId && next.jobId !== next.dependency.jobId) this.owners.jobs.retry(next.jobId);
    return this.request(pinnedInput);
  }
  private pinned(job: Job, options: z.infer<typeof optionsSchema>) {
    const source = this.owners.jobs.job(options.audioJobId);
    if (
      !["audio", "audio-file"].includes(source.artifact) ||
      !isDeepStrictEqual(source.target, job.target)
    )
      throw lost("Acoustic dependency does not belong to its selected audio target");
    const status = this.owners.jobs.status(source);
    if (
      !status.published ||
      status.published.generation !== options.audioGeneration ||
      source.generation !== options.audioGeneration
    )
      throw lost("Pinned audio generation is no longer available");
    return parsePublicAudioArtifact(JSON.parse(status.published.result));
  }
  private measurement(job: Job, options: z.infer<typeof imageOptions>) {
    const source = this.owners.jobs.job(options.measurementJobId);
    const status = this.owners.jobs.status(source);
    if (
      !["waveform", "spectrum"].includes(source.artifact) ||
      !isDeepStrictEqual(source.target, job.target) ||
      !status.published ||
      source.generation !== options.measurementGeneration ||
      status.published.generation !== options.measurementGeneration
    )
      throw lost("Pinned acoustic measurements are no longer available");
    return {
      kind: source.artifact,
      value: parsePublicAcousticArtifact(JSON.parse(status.published.result)),
    };
  }
  private async executeImage({ job, signal }: JobExecution, raw: unknown) {
    const options = imageOptions.parse(raw),
      renderer = this.owners.renderer;
    if (!renderer || renderer.implementationId !== options.implementationId)
      throw new CatalogError(
        "PINNED_IMPLEMENTATION_UNAVAILABLE",
        "Pinned acoustic renderer is unavailable",
        {},
      );
    const measurement = this.measurement(job, options),
      lease = this.owners.cache.acquire(measurement.value.cacheId);
    if (!lease)
      throw new CatalogError(
        "ARTIFACT_EXPIRED",
        "Acoustic measurements were evicted; retry image preparation",
        {},
      );
    let output: ReturnType<DerivedCache["reserve"]> | undefined;
    try {
      if (lease.bytes > 16 * 1024 * 1024)
        throw new CatalogError("LIMIT_EXCEEDED", "Acoustic measurements exceed 16 MiB");
      const documentBytes = Buffer.alloc(lease.bytes);
      if (lease.read(documentBytes, 0) !== documentBytes.length)
        throw lost("Acoustic measurements are incomplete");
      const document = JSON.parse(documentBytes.toString("utf8"));
      const evidence =
        measurement.kind === "waveform"
          ? {
              kind: "waveform" as const,
              data: document as Awaited<ReturnType<typeof waveformBuckets>>,
            }
          : {
              kind: "spectrum" as const,
              data: { ...document, density: Float64Array.from(document.density) } as Awaited<
                ReturnType<typeof spectralWindows>
              >,
            };
      output = this.owners.cache.reserve(job.target);
      const request = acousticImageRequest(measurement.value, evidence, output.path);
      const receipt = imageReceipt.parse(await renderer.render(request, signal));
      signal.throwIfAborted();
      if (
        receipt.file !== output.path ||
        !isDeepStrictEqual(receipt.provenance, request.provenance)
      )
        throw lost("Acoustic image receipt differs from its pinned request");
      this.measurement(job, options);
      lease.release();
      const published = await this.owners.cache.publish(output.id);
      if (published.bytes !== receipt.bytes)
        throw lost("Acoustic image byte count differs from its receipt");
      signal.throwIfAborted();
      this.measurement(job, options);
      const { bytes, ...publicReceipt } = receipt;
      return JSON.stringify({
        ...publicAcousticArtifact(measurement.value),
        ...publicReceipt,
        sizeBytes: bytes,
        cacheId: output.id,
        measurements: {
          jobId: options.measurementJobId,
          generation: options.measurementGeneration,
        },
        imageImplementationId: renderer.implementationId,
      });
    } catch (error) {
      if (output) this.owners.cache.remove(output.id);
      throw error;
    } finally {
      lease.release();
    }
  }
  async execute(execution: JobExecution) {
    const { job, signal } = execution;
    let raw: unknown;
    try {
      raw = JSON.parse(job.input);
    } catch {
      throw new CatalogError("UNSUPPORTED_JOB", "Invalid acoustic input");
    }
    if (job.artifact === "acoustic-image") return this.executeImage(execution, raw);
    const parsed = optionsSchema.safeParse(raw);
    if (
      !["waveform", "spectrum", "loudness", "pause"].includes(job.artifact) ||
      !parsed.success ||
      (job.target.kind !== "asset" && job.target.kind !== "project")
    )
      throw new CatalogError("UNSUPPORTED_JOB", "Job does not name acoustic measurements");
    const options = parsed.data,
      audio = this.pinned(job, options);
    const lease = this.owners.cache.acquire(audio.cacheId);
    if (!lease)
      throw new CatalogError(
        "ARTIFACT_EXPIRED",
        "Pinned PCM bytes were evicted; retry acoustic preparation",
        {},
      );
    let output: ReturnType<DerivedCache["reserve"]> | undefined;
    try {
      output = this.owners.cache.reserve(job.target);
      const provenance = { jobId: options.audioJobId, generation: options.audioGeneration };
      const description = metadata(audio);
      let context: AcousticArtifact["context"];
      let measurements: object;
      let analysis: AcousticArtifact["analysis"];
      if (options.policy === "waveform-buckets-v1") {
        const bucketFrames = options.bucketFrames ?? Math.max(1, Math.ceil(audio.frames / 1024));
        const result = await waveformBuckets(lease, audio, { bucketFrames }, signal);
        measurements = {
          ...result,
          units: {
            range: "microsecond",
            sampleRange: "sample-frame",
            amplitude: "linear",
            rms: "linear",
          },
        };
        analysis = { kind: "waveform", bucketFrames, bucketCount: result.buckets.length };
      } else if (options.policy === "spectrum-density-v1") {
        const result = await spectralWindows(lease, audio, options, signal);
        context = {
          range: description.range,
          sampleRange: description.sampleRange,
          unavailable: description.unavailable,
        };
        description.range = options.range;
        description.sampleRange = options.sampleRange;
        if (description.domain === "project") {
          description.unavailable = description.unavailable.map((entry) => ({
            ...entry,
            ranges: entry.ranges
              .map((span) => ({
                start: Math.max(span.start, options.sampleRange.start),
                end: Math.min(span.end, options.sampleRange.end),
              }))
              .filter((span) => span.start < span.end),
          }));
        } else {
          description.unavailable = sourceAvailability(description.unavailable, [options.range]);
        }
        measurements = { ...result, density: Array.from(result.density) };
        analysis = {
          kind: "spectrum",
          fftFrames: options.fftFrames,
          hopFrames: options.hopFrames,
          columnCount: result.columns.length,
        };
      } else if (options.policy === "pause-rms-v1") {
        const pause = options;
        validateAudioWave(lease, audio);
        const result = await pauseIntervals(
          lease,
          audio,
          {
            windowFrames: pause.windowFrames,
            hopFrames: pause.hopFrames,
            thresholdRMS: pause.thresholdRMS,
            ...(pause.channel === null ? {} : { channel: pause.channel }),
            unavailable: audioUnavailableSamples(audio),
          },
          signal,
        );
        const intervals = result.intervals
          .filter(
            (interval) =>
              Math.round(
                ((interval.sampleRange.end - interval.sampleRange.start) * 1_000_000) /
                  audio.sampleRate,
              ) >= pause.minDurationUs,
          )
          .map((interval) => {
            const startUs = toTime(
              rational(BigInt(interval.sampleRange.start) * 1_000_000n, BigInt(audio.sampleRate)),
            );
            const endUs = toTime(
              rational(BigInt(interval.sampleRange.end) * 1_000_000n, BigInt(audio.sampleRate)),
            );
            return {
              range: { startUs, endUs },
              durationUs: Math.round(
                ((interval.sampleRange.end - interval.sampleRange.start) * 1_000_000) /
                  audio.sampleRate,
              ),
              rms: interval.rms,
            };
          });
        analysis = {
          kind: "pause",
          thresholdRMS: pause.thresholdRMS,
          windowUs: PAUSE_DEFAULTS.windowUs,
          hopUs: PAUSE_DEFAULTS.hopUs,
          channel: pause.channel,
          minDurationUs: pause.minDurationUs,
          algorithm: "rms-window-v1",
          intervals,
          unavailable: description.unavailable,
        };
        measurements = {
          ...analysis,
          coverage: description.unavailable.length ? "partial" : "complete",
        };
      } else {
        assertLoudnessCoverage(audio);
        const analyzer = this.owners.loudness;
        if (!analyzer || analyzer.implementationId !== options.implementationId)
          throw new CatalogError(
            "PINNED_IMPLEMENTATION_UNAVAILABLE",
            "Pinned loudness implementation is unavailable",
            {},
          );
        validateAudioWave(lease, audio);
        const measurement = loudnessMeasurementSchema.parse(
          await this.owners.cache.withDescriptor(audio.cacheId, (source) =>
            analyzer.measure(
              {
                source,
                audio,
                channelInterpretation: options.channelInterpretation,
                truePeak: options.truePeak,
              },
              signal,
            ),
          ),
        );
        analysis = {
          kind: "loudness",
          channelInterpretation: options.channelInterpretation,
          truePeak: options.truePeak,
          implementationId: analyzer.implementationId,
          signalRecipe: options.signalRecipe,
          scope: options.scope,
          measurement,
        };
        measurements = {
          ...analysis,
          units: {
            integratedLufs: "LUFS",
            loudnessRangeLu: "LU",
            samplePeakDbfs: "dBFS",
            truePeakDbtp: "dBTP",
          },
        };
      }
      signal.throwIfAborted();
      const document = {
        ...description,
        ...measurements,
        ...(context ? { context } : {}),
        audio: provenance,
        generation: job.generation,
      };
      const bytes = Buffer.from(JSON.stringify(document) + "\n");
      const maximum = options.policy === "waveform-buckets-v1" ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
      if (bytes.length > maximum)
        throw new CatalogError("LIMIT_EXCEEDED", "Acoustic JSON exceeds its byte limit");
      this.owners.cache.checkCapacity(bytes.length);
      await writeFile(output.path, bytes, { flag: "wx", signal });
      const pinned = this.pinned(job, options);
      if (pinned.cacheId !== audio.cacheId)
        throw lost("Pinned PCM identity changed during reduction");
      lease.release();
      const published = await this.owners.cache.publish(output.id);
      signal.throwIfAborted();
      this.pinned(job, options);
      return JSON.stringify(
        publicAcousticArtifact({
          ...description,
          ...(context ? { context } : {}),
          file: output.path,
          bytes: published.bytes,
          mediaType: "application/json",
          cacheId: output.id,
          analysis,
          ...(analysis.kind === "waveform"
            ? { bucketFrames: analysis.bucketFrames, bucketCount: analysis.bucketCount }
            : {}),
          audio: provenance,
        } as AcousticArtifact),
      );
    } catch (error) {
      if (output) this.owners.cache.remove(output.id);
      throw error;
    } finally {
      lease.release();
    }
  }
}

/** Missing support is never converted to integrated silence or concatenated fragments. */
function assertLoudnessCoverage(audio: AudioArtifact) {
  const gaps =
    "projectId" in audio
      ? audio.unavailable.flatMap((entry) =>
          entry.ranges.map((span) => ({
            startUs: toTime(rational(BigInt(span.start) * 1000000n, BigInt(audio.sampleRate))),
            endUs: toTime(rational(BigInt(span.end) * 1000000n, BigInt(audio.sampleRate))),
          })),
        )
      : audio.unavailable;
  if (!gaps.length) return;
  const range = audio.range;
  const available: { startUs: TimeValue; endUs: TimeValue }[] = [];
  let at = fromTime(range.startUs);
  for (const gap of [...gaps].sort((a, b) => compare(fromTime(a.startUs), fromTime(b.startUs)))) {
    const start = fromTime(gap.startUs),
      end = fromTime(gap.endUs);
    if (compare(start, at) > 0) available.push({ startUs: toTime(at), endUs: gap.startUs });
    if (compare(end, at) > 0) at = end;
  }
  if (compare(at, fromTime(range.endUs)) < 0)
    available.push({ startUs: toTime(at), endUs: range.endUs });
  throw new CatalogError(
    "UNAVAILABLE_SUPPORT",
    "Integrated loudness requires complete selected support",
    {
      range,
      unavailable: gaps,
      available,
    },
  );
}
