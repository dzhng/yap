import {
  audioProcessingEvidenceSchema,
  audioProcessingIssues,
  normalizationPassedThrough,
  selectNormalizationAttempt,
  type AudioProcessingEvidence,
} from "./audio-measurement.js";
import {
  admitReadRange,
  type Issue,
  selectionRangeSchema,
  resolveAudioOutputSettings,
  resolvedAudioOutputSettingsSchema,
  audioOutputCapabilities,
  type AudioOutputSettings,
  type AudioOutputSettingsInput,
  sampleAt,
  fromTime,
  toTime,
  rational,
  compare,
  type TimeValue,
  type SelectionRange,
} from "@yap/composition";
import { createHash } from "node:crypto";
import { readAudioWaveFile } from "./audio-wave.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { rangeSchema, processingTapSchema, type ProcessingTap } from "@yap/composition";
import type { ProjectStore } from "./projects.js";
import {
  projectComposition,
  retimeImplementation,
  validateProjectAudio,
  type ProjectRenderSupport,
  type CompositionWindow,
  type CompositionAssetBinding,
} from "./project-window.js";
import type { PreparedAudioStore, PreparedAudioRead } from "./prepared-audio.js";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import {
  JobDependencyLost,
  type Job,
  type JobAdmission,
  type JobExecution,
  type JobQueue,
  type StagedJobResult,
} from "./jobs.js";
import type { DerivedCache } from "./cache.js";
import { CatalogError, dependencyRefusal } from "./catalog.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import { selectSource, sourceSelectionSchema, type SourceSelection } from "./source-selection.js";
import type { TimeRange } from "./presentation-time.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receiptSchema = z.object({
  file: z.string(),
  mediaType: z.literal("audio/wav"),
  bytes: integer.positive(),
  sampleRate: integer.min(1).max(192000),
  channels: z.union([z.literal(1), z.literal(2)]),
  layout: z.enum(["mono", "stereo"]),
  range: selectionRangeSchema,
  sampleRange: z.object({ start: integer, end: integer }),
  frames: integer,
  decodedFrames: integer,
  unavailable: z.array(selectionRangeSchema),
});
export type SourceAudioResult = z.infer<typeof receiptSchema>;
export type SourceAudioInput = SourceSelection & { range?: SelectionRange | undefined };
export type SourceAudioRenderer = {
  implementationId: string;
  render(
    request: {
      source: ReturnType<typeof selectSource>["track"];
      range: SelectionRange;
      output: string;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type SourceAudioArtifact = SourceAudioResult &
  SourceSelection & {
    cacheId: string;
    supportDigest: string;
    implementationId: string;
  };
/** Decode the retained public audio receipt; old internal names are stale. */
export function parsePublicAudioArtifact(
  value: unknown,
): SourceAudioArtifact | ProjectAudioArtifact {
  if (!value || typeof value !== "object")
    throw new CatalogError("ARTIFACT_CHANGED", "Audio receipt is unavailable");
  const record = value as Record<string, any>;
  if (
    "bytes" in record ||
    "frames" in record ||
    (!("projectId" in record) && "range" in record) ||
    !Number.isSafeInteger(record.sizeBytes) ||
    !Number.isSafeInteger(record.frameCount) ||
    !record.sampleRange ||
    !Number.isSafeInteger(record.sampleRange.startSamples) ||
    !Number.isSafeInteger(record.sampleRange.endSamples)
  )
    throw new CatalogError("ARTIFACT_CHANGED", "Audio receipt uses an obsolete shape");
  const { sizeBytes, frameCount, sampleRange, sourceRange, ...rest } = record;
  const range = "projectId" in record ? record.range : sourceRange;
  if (!range) throw new CatalogError("ARTIFACT_CHANGED", "Audio receipt has no selected range");
  return {
    ...rest,
    bytes: sizeBytes,
    frames: frameCount,
    sampleRange: { start: sampleRange.startSamples, end: sampleRange.endSamples },
    range,
  } as SourceAudioArtifact | ProjectAudioArtifact;
}
function publicAudioArtifact(value: any) {
  const { bytes, frames, sampleRange, range, ...rest } = value;
  return {
    ...rest,
    sizeBytes: bytes,
    frameCount: frames,
    sampleRange: { startSamples: sampleRange.start, endSamples: sampleRange.end },
    ...(range === undefined ? {} : "projectId" in value ? { range } : { sourceRange: range }),
  };
}
const optionsSchema = z.strictObject({
  selection: sourceSelectionSchema,
  range: selectionRangeSchema,
  supportDigest: z.string(),
  implementationId: z.string().min(1),
});
const projectOptionsSchema = z.strictObject({
  retimeImplementationId: z.string().min(1).optional(),
  preparedResourceId: z.string().min(1).nullable().optional(),
  range: rangeSchema,
  tap: processingTapSchema,
  implementationId: z.string().min(1),
});
const sampleRangeSchema = z
  .object({ start: integer, end: integer })
  .refine((value) => value.end >= value.start);
export const projectAudioReceiptSchema = z.object({
  file: z.string(),
  bytes: integer.positive(),
  sampleRate: z.literal(48000),
  channels: z.literal(2),
  frames: integer,
  peak: z.number().finite().nonnegative(),
  clippedSamples: integer,
  maximumBlockFrames: integer.positive(),
  peakResidentBytes: integer,
  decoderContext: z.object({
    policy: z.literal("bounded-current-retained-run"),
    sampleRate: z.literal(48000),
    maximumPrerollFrames: integer,
    maximumTailFrames: integer,
  }),
  unavailable: z.array(z.object({ clipId: z.string(), ranges: z.array(sampleRangeSchema) })),
  processingEvidence: z.array(audioProcessingEvidenceSchema).optional(),
});
export type ProjectAudioInput = {
  /** Internal immutable preparation binding. */
  preparedResourceId?: string | null | undefined;
  projectId: string;
  revisionId?: string | undefined;
  range?: TimeRange | undefined;
  tap?: ProcessingTap | undefined;
};
export type ProjectAudioRenderer = ProjectRenderSupport & {
  encodingImplementationId?: string;
  validateOutput?(settings: AudioOutputSettings): Promise<void>;
  encode?(
    request: {
      source: { fd: number; bytes: number };
      input: { sampleRate: 48000; channels: 2; frames: number };
      settings: AudioOutputSettings;
      output: string;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
  render(
    request: {
      prepared?: PreparedAudioRead | undefined;
      window: CompositionWindow;
      assets: readonly CompositionAssetBinding[];
      output: string;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type ProjectAudioArtifact = z.infer<typeof projectAudioReceiptSchema> & {
  projectId: string;
  revisionId: string;
  range: TimeRange;
  tap: ProcessingTap;
  implementationId: string;
  sampleRange: { start: number; end: number };
  mediaType: "audio/wav";
  layout: "stereo";
  cacheId: string;
};
export type PinnedProjectAudioExport = ProjectAudioInput &
  z.infer<typeof projectOptionsSchema> & {
    revisionId: string;
    settings: AudioOutputSettings;
    encodingImplementationId?: string | undefined;
  };
export type ProjectAudioExportInput = ProjectAudioInput & {
  settings?: AudioOutputSettingsInput | undefined;
};
export type MediaAudioInput = SourceAudioInput | ProjectAudioInput;
const artifact = "audio";
function invalid(message: string): never {
  throw new CatalogError("INVALID_RESPONSE", message);
}
const sample = (us: TimeValue, rate: number) => sampleAt(fromTime(us), rate);
function unavailable(range: SelectionRange, support: readonly SelectionRange[]) {
  const gaps: SelectionRange[] = [];
  let at = fromTime(range.startUs);
  const end = fromTime(range.endUs);
  for (const part of support) {
    const start = fromTime(part.startUs),
      through = fromTime(part.endUs);
    if (compare(through, at) <= 0) continue;
    if (compare(start, end) >= 0) break;
    if (compare(start, at) > 0) gaps.push({ startUs: toTime(at), endUs: toTime(start) });
    at = compare(end, through) < 0 ? end : through;
  }
  if (compare(at, end) < 0) gaps.push({ startUs: toTime(at), endUs: range.endUs });
  return gaps;
}

/** Source and project PCM share admission, cache publication and WAV validation. */
export class MediaAudioInspection {
  constructor(
    private readonly owners: {
      assets: AssetStore;
      acquisitions: AcquisitionStore;
      jobs: JobQueue;
      cache: DerivedCache;
      sourceRenderer: SourceAudioRenderer;
      project?: {
        projects: ProjectStore;
        renderer: ProjectAudioRenderer;
        prepared: PreparedAudioStore;
      };
    },
  ) {
    if (owners.project && !owners.project.renderer.implementationId)
      throw new Error("Project audio renderer needs an implementation identity");
    if (!owners.sourceRenderer.implementationId)
      throw new Error("Audio renderer needs an implementation identity");
  }
  private plan(input: SourceAudioInput) {
    const { range, ...selection } = input;
    const source = selectSource(this.owners.assets, this.owners.acquisitions, selection);
    if (source.stream.kind !== "audio")
      throw new CatalogError("UNSUPPORTED_MEDIA", "Audio inspection requires an audio stream");
    const admitted = admitReadRange(range === undefined ? source.stream.bounds : range, {
      startUs: 0,
      endUs: source.durationUs,
    });
    const stream = this.owners.assets
      .get(source.selection.assetId)
      .streams.find((value) => value.id === source.selection.streamId)!;
    // Native admission owns unsupported formats. Known PCM dimensions permit early size refusal.
    if (
      stream.sampleRate !== undefined &&
      Number.isSafeInteger(stream.sampleRate) &&
      stream.sampleRate > 0 &&
      stream.channels !== undefined
    ) {
      const frames =
        BigInt(sample(admitted.range.endUs, stream.sampleRate)) -
        BigInt(sample(admitted.range.startUs, stream.sampleRate));
      const minimumBytes = frames * BigInt(stream.channels) * 4n + 44n;
      if (minimumBytes > BigInt(Number.MAX_SAFE_INTEGER))
        throw new CatalogError("LIMIT_EXCEEDED", "Audio derivative size exceeds safe accounting");
      this.owners.cache.checkCapacity(Number(minimumBytes));
    }
    return {
      source,
      issues: admitted.issues,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      options: {
        selection: source.selection,
        range: admitted.range,
        supportDigest: source.supportDigest,
        implementationId: this.owners.sourceRenderer.implementationId,
      },
    };
  }
  private sourceRecipe(input: SourceAudioInput) {
    const { options, sampleRate: rate, source, channels, issues } = this.plan(input);
    return {
      issues,
      durationUs: source.durationUs,
      fullRange: source.stream.bounds,
      channels,
      sampleClock:
        rate === undefined || !Number.isSafeInteger(rate) || rate <= 0
          ? undefined
          : {
              sampleRate: rate,
              sampleRange: {
                start: sample(options.range.startUs, rate),
                end: sample(options.range.endUs, rate),
              },
            },
      options,
      selection: { ...options.selection, range: options.range },
      identity: {
        target: { kind: "asset" as const, id: options.selection.assetId },
        artifact,
        input: JSON.stringify(options),
      },
    };
  }
  /** Canonical immutable audio identity without submitting work or regenerating evicted PCM. */
  recipe(input: MediaAudioInput) {
    return "projectId" in input ? this.projectRecipe(input) : this.sourceRecipe(input);
  }
  /** Surrounding analysis samples use the same pinned selector, masks and native audio owner. */
  context(input: MediaAudioInput, requested: { start: number; end: number }) {
    const plan =
      "projectId" in input
        ? { domain: "project" as const, recipe: this.projectRecipe(input) }
        : { domain: "source" as const, recipe: this.sourceRecipe(input) };
    const recipe = plan.recipe,
      clock = recipe.sampleClock;
    if (!clock)
      throw new CatalogError(
        "UNSUPPORTED_FORMAT",
        "Audio context requires an integral sample rate",
      );
    if (
      !Number.isSafeInteger(requested.start) ||
      !Number.isSafeInteger(requested.end) ||
      requested.start > clock.sampleRange.start ||
      requested.end < clock.sampleRange.end
    )
      throw new CatalogError(
        "INVALID_RANGE",
        "Audio context must contain the requested sample range",
      );
    const start = Math.max(0, requested.start);
    const end = Math.min(sample(recipe.durationUs, clock.sampleRate), requested.end);
    if (plan.domain === "project") {
      const recipe = plan.recipe;
      const us = (frame: number) =>
        Number(
          (BigInt(frame) * 1_000_000n + BigInt(clock.sampleRate) - 1n) / BigInt(clock.sampleRate),
        );
      return this.recipe({
        ...recipe.selection,
        range: {
          startUs: Math.min(recipe.selection.range.startUs, us(start)),
          endUs: Math.max(recipe.selection.range.endUs, Math.min(recipe.durationUs, us(end))),
        },
      });
    }
    const at = rational(BigInt(start) * 1_000_000n, BigInt(clock.sampleRate));
    const through = rational(BigInt(end) * 1_000_000n, BigInt(clock.sampleRate));
    const selected = plan.recipe.selection.range;
    return this.recipe({
      ...plan.recipe.selection,
      range: {
        startUs: compare(at, fromTime(selected.startUs)) < 0 ? toTime(at) : selected.startUs,
        endUs: compare(through, fromTime(selected.endUs)) > 0 ? toTime(through) : selected.endUs,
      },
    });
  }

  private requestSource(input: SourceAudioInput) {
    const { options, identity, issues } = this.sourceRecipe(input);
    const { assets, acquisitions, jobs, cache } = this.owners;
    const status = submitCachedDerivative<SourceAudioArtifact>(jobs, cache, identity, "heavy", {
      admitted: (job) => {
        const owner = { kind: "job" as const, id: job.jobId };
        assets.retain(owner, [options.selection.assetId]);
        if (options.selection.acquisitionId)
          acquisitions.retain(owner, [options.selection.acquisitionId]);
      },
    });
    return {
      ...options.selection,
      range: options.range,
      issues,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            audio: status.published.value,
          }
        : null,
    };
  }
  request(input: SourceAudioInput): Promise<ReturnType<MediaAudioInspection["requestSource"]>>;
  request(input: ProjectAudioInput): ReturnType<MediaAudioInspection["requestProject"]>;
  request(
    input: MediaAudioInput,
  ): Promise<
    | ReturnType<MediaAudioInspection["requestSource"]>
    | Awaited<ReturnType<MediaAudioInspection["requestProject"]>>
  >;
  async request(input: MediaAudioInput) {
    return "projectId" in input ? this.requestProject(input) : this.requestSource(input);
  }
  retry(input: SourceAudioInput): Promise<ReturnType<MediaAudioInspection["requestSource"]>>;
  retry(input: ProjectAudioInput): ReturnType<MediaAudioInspection["requestProject"]>;
  retry(
    input: MediaAudioInput,
  ): Promise<
    | ReturnType<MediaAudioInspection["requestSource"]>
    | Awaited<ReturnType<MediaAudioInspection["requestProject"]>>
  >;
  async retry(input: MediaAudioInput) {
    const current = await this.request(input);
    if (current.jobId) this.owners.jobs.retry(current.jobId);
    return this.request(
      "projectId" in current
        ? {
            projectId: current.projectId,
            revisionId: current.revisionId,
            range: current.range,
            tap: current.tap,
            preparedResourceId: current.preparedResourceId,
          }
        : input,
    );
  }
  private projectPlan(input: ProjectAudioInput) {
    const owner = this.owners.project;
    if (!owner) throw new CatalogError("NOT_READY", "Project audio renderer is unavailable", {});
    const composition = projectComposition(owner.projects, this.owners.assets, input);
    const retained =
      input.preparedResourceId === null
        ? null
        : owner.prepared.resolve(composition, input.tap, input.preparedResourceId);
    const plan = composition.window(
      input,
      owner.renderer,
      "audio",
      retained ? "retained" : "produced",
    );
    const { sampleRange } = plan.window.manifest;
    if (sampleRange.end <= sampleRange.start)
      throw new CatalogError(
        "INVALID_RANGE",
        "Project audio window must contain at least one sample",
      );
    const bytes = BigInt(sampleRange.end - sampleRange.start) * 8n + 44n;
    if (bytes - 44n > BigInt(audioOutputCapabilities.wav.maximumDataBytes))
      throw new CatalogError(
        "LIMIT_EXCEEDED",
        "Project PCM exceeds the Float32 WAV container limit",
      );
    this.owners.cache.checkCapacity(Number(bytes));
    return { ...plan, retained };
  }
  private projectRecipe(input: ProjectAudioInput, plan = this.projectPlan(input)) {
    const { window, durationUs, retained } = plan;
    const retime = retained
      ? undefined
      : retimeImplementation(window, this.owners.project!.renderer);
    const { range, tap, revisionId } = window.manifest;
    const options = {
      range,
      tap,
      implementationId: this.owners.project!.renderer.implementationId,
      ...(retime ? { retimeImplementationId: retime } : {}),
      preparedResourceId: retained?.resourceId ?? null,
    };
    return {
      issues: plan.issues,
      durationUs,
      fullRange: { startUs: 0, endUs: durationUs },
      processingSha256: createHash("sha256")
        .update(JSON.stringify(retained?.recipe ?? window.manifest))
        .digest("hex"),
      channels: 2 as const,
      options,
      sampleClock: { sampleRate: 48000, sampleRange: window.manifest.sampleRange },
      selection: {
        projectId: input.projectId,
        revisionId,
        range,
        tap,
        preparedResourceId: options.preparedResourceId,
      },
      identity: {
        target: { kind: "project" as const, id: input.projectId, revisionId },
        artifact,
        input: JSON.stringify(options),
      },
    };
  }
  private async requestProject(input: ProjectAudioInput) {
    return (await this.prepareProject(input)).submit();
  }
  private async prepareProject(input: ProjectAudioInput, plan = this.projectPlan(input)) {
    const { selection, identity, options, issues } = this.projectRecipe(input, plan);
    const prior = this.owners.jobs.status(identity);
    if (!plan.retained && !prior.jobId && !prior.published)
      await validateProjectAudio(this.owners.project!.renderer, plan);
    return {
      snapshot: { ...selection, ...options },
      submit: (admitted?: () => void) => this.submitProject(identity, selection, issues, admitted),
    };
  }
  private submitProject(
    identity: ReturnType<MediaAudioInspection["projectRecipe"]>["identity"],
    selection: ReturnType<MediaAudioInspection["projectRecipe"]>["selection"],
    issues: Issue[],
    admitted?: () => void,
  ) {
    const status = submitCachedDerivative<ProjectAudioArtifact>(
      this.owners.jobs,
      this.owners.cache,
      identity,
      "heavy",
      admitted ? { admitted } : {},
    );
    return {
      ...selection,
      issues,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            audio: status.published.value,
          }
        : null,
    };
  }

  /** Export pins the existing PCM recipe; encoded renditions depend on that same job/cache. */
  async prepareExport(input: ProjectAudioExportInput | PinnedProjectAudioExport) {
    let settings: AudioOutputSettings;
    try {
      settings = resolveAudioOutputSettings(input.settings);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new CatalogError("INVALID_PARAMS", "Invalid standalone audio output settings", {
          issues: error.issues,
        });
      throw error;
    }
    const plan = this.projectPlan(input);
    const recipe = this.projectRecipe(input, plan);
    const snapshot: PinnedProjectAudioExport = {
      ...recipe.selection,
      ...recipe.options,
      settings,
      ...(settings.container === "m4a"
        ? { encodingImplementationId: this.owners.project!.renderer.encodingImplementationId }
        : {}),
    };
    if (
      "implementationId" in input &&
      (input.implementationId !== snapshot.implementationId ||
        input.retimeImplementationId !== snapshot.retimeImplementationId)
    )
      throw new CatalogError("NOT_READY", "Pinned project audio implementation is unavailable", {
        implementationId: input.implementationId,
      });
    if (
      settings.container === "m4a" &&
      "encodingImplementationId" in input &&
      input.encodingImplementationId !== snapshot.encodingImplementationId
    )
      throw new CatalogError("NOT_READY", "Pinned audio encoding implementation is unavailable", {
        implementationId: input.encodingImplementationId,
      });
    if (
      settings.container === "m4a" &&
      !this.owners.jobs.status(this.exportIdentity(snapshot)).jobId
    ) {
      if (
        !this.owners.project?.renderer.encodingImplementationId ||
        !this.owners.project.renderer.encode ||
        !this.owners.project.renderer.validateOutput
      )
        throw new CatalogError("NOT_READY", "Standalone AAC output is unavailable", {});
      await this.owners.project.renderer.validateOutput(settings);
    }
    const prepared = await this.prepareProject(input, plan);
    return {
      snapshot,
      submit: (admitted?: () => void) => {
        if (settings.container === "wav") return prepared.submit(admitted);
        prepared.submit();
        return this.submitExport(snapshot, admitted);
      },
    };
  }
  private exportIdentity(pinned: PinnedProjectAudioExport) {
    const { projectId, revisionId, settings, encodingImplementationId, ...pcm } = pinned;
    return {
      target: { kind: "project" as const, id: projectId, revisionId },
      artifact: "audio-file",
      input: JSON.stringify({ pcm, settings, encodingImplementationId }),
    };
  }
  private submitExport(pinned: PinnedProjectAudioExport, admitted?: () => void) {
    const status = submitCachedDerivative<{
      cacheId: string;
      bytes: number;
      settings: AudioOutputSettings;
    }>(this.owners.jobs, this.owners.cache, this.exportIdentity(pinned), "heavy", {
      deferred: true,
      ...(admitted ? { admitted } : {}),
    });
    return {
      ...status,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            audio: status.published.value,
          }
        : null,
    };
  }
  private exportRecipe(pinned: PinnedProjectAudioExport) {
    const recipe = this.projectRecipe(pinned);
    if (
      pinned.settings.container === "m4a" &&
      pinned.encodingImplementationId !== this.owners.project!.renderer.encodingImplementationId
    )
      throw new CatalogError("NOT_READY", "Pinned audio encoding implementation is unavailable", {
        implementationId: pinned.encodingImplementationId,
      });
    if (
      pinned.implementationId !== recipe.options.implementationId ||
      pinned.retimeImplementationId !== recipe.options.retimeImplementationId
    )
      throw new CatalogError("NOT_READY", "Pinned project audio implementation is unavailable", {
        implementationId: pinned.implementationId,
      });
    return recipe;
  }
  resumeExport(pinned: PinnedProjectAudioExport) {
    const recipe = this.exportRecipe(pinned);
    if (!this.owners.jobs.status(recipe.identity).jobId)
      throw new CatalogError(
        "NOT_READY",
        "Pinned project audio dependency has not been admitted",
        {},
      );
    const pcm = this.submitProject(recipe.identity, recipe.selection, recipe.issues);
    return pinned.settings.container === "wav" ? pcm : this.submitExport(pinned);
  }
  async retryExport(pinned: PinnedProjectAudioExport) {
    const prepared = await this.prepareExport(pinned);
    prepared.submit();
    const pcm = this.owners.jobs.status(this.projectRecipe(pinned).identity);
    if (pcm.jobId && !pcm.published) this.owners.jobs.retry(pcm.jobId);
    if (pinned.settings.container === "m4a") {
      const file = this.owners.jobs.status(this.exportIdentity(pinned));
      if (file.jobId && !file.published) this.owners.jobs.retry(file.jobId);
    }
    return this.resumeExport(pinned);
  }
  private encodedSnapshot(job: Job) {
    if (job.target.kind !== "project" || job.artifact !== "audio-file")
      throw new CatalogError("UNSUPPORTED_JOB", "Encoded audio requires a pinned project");
    const options = z
      .strictObject({
        pcm: projectOptionsSchema,
        settings: resolvedAudioOutputSettingsSchema,
        encodingImplementationId: z.string().min(1),
      })
      .parse(JSON.parse(job.input));
    if (options.settings.container !== "m4a")
      throw new CatalogError("INVALID_JOB", "Encoded audio requires M4A settings");
    if (options.encodingImplementationId !== this.owners.project?.renderer.encodingImplementationId)
      throw new CatalogError("NOT_READY", "Pinned audio encoding implementation is unavailable", {
        implementationId: options.encodingImplementationId,
      });
    return {
      ...options.pcm,
      encodingImplementationId: options.encodingImplementationId,
      settings: options.settings,
      projectId: job.target.id,
      revisionId: job.target.revisionId,
    };
  }
  admitExport(job: Job): ReturnType<JobAdmission> {
    const pinned = this.encodedSnapshot(job);
    const recipe = this.exportRecipe(pinned);
    const pcm = this.submitProject(recipe.identity, recipe.selection, recipe.issues);
    if (pcm.published) return { state: "ready" };
    if (!pcm.jobId || ["failed", "canceled", "unavailable"].includes(pcm.state))
      throw dependencyRefusal(
        "DEPENDENCY_FAILED",
        pcm.reason ?? "Project PCM is unavailable",
        { dependency: pcm.jobId },
        pcm.retryable,
      );
    return { state: "waiting", dependency: pcm.jobId };
  }
  private async executeEncoded({ job, signal }: JobExecution): Promise<StagedJobResult> {
    const pinned = this.encodedSnapshot(job);
    const recipe = this.exportRecipe(pinned);
    const status = this.owners.jobs.status(recipe.identity);
    if (!status.published) throw new CatalogError("NOT_READY", "Project PCM is not ready", {});
    const pcm = JSON.parse(status.published.result) as ProjectAudioArtifact;
    const output = this.owners.cache.reserve(job.target);
    try {
      const value = await this.owners.cache.withDescriptor(pcm.cacheId, async (source) => {
        if (source.bytes !== pcm.bytes) invalid("PCM cache size changed");
        const encoded = await this.owners.project!.renderer.encode!(
          {
            source,
            input: { sampleRate: 48000, channels: 2, frames: pcm.frames },
            settings: pinned.settings,
            output: output.path,
          },
          signal,
        );
        const receipt = z
          .object({
            file: z.string(),
            bytes: integer.positive(),
            settings: resolvedAudioOutputSettingsSchema,
            sampleRate: integer.positive(),
            channels: z.union([z.literal(1), z.literal(2)]),
            inputFrames: integer,
            durationUs: integer,
            encodedFrames: integer,
            contentFrames: integer,
          })
          .parse(encoded);
        if (
          receipt.file !== output.path ||
          !isDeepStrictEqual(receipt.settings, pinned.settings) ||
          receipt.sampleRate !== pinned.settings.audio.sampleRate ||
          receipt.channels !== (pinned.settings.audio.layout === "mono" ? 1 : 2) ||
          receipt.inputFrames !== pcm.frames ||
          receipt.contentFrames !==
            Math.floor((pcm.frames * pinned.settings.audio.sampleRate) / 48000) ||
          receipt.encodedFrames < receipt.contentFrames ||
          receipt.durationUs !== Math.floor((pcm.frames * 1000000) / 48000)
        )
          invalid("Encoded audio changed the pinned rendition or duration");
        return receipt;
      });
      signal.throwIfAborted();
      const cached = await this.owners.cache.publish(output.id);
      signal.throwIfAborted();
      if (cached.bytes !== value.bytes) invalid("Encoded audio size differs from its file");
      const result = JSON.stringify({
        ...value,
        ...pinned,
        mediaType: "audio/mp4",
        layout: pinned.settings.audio.layout,
        input: {
          sampleRate: pcm.sampleRate,
          channels: pcm.channels,
          frames: pcm.frames,
          sampleRange: pcm.sampleRange,
        },
        cacheId: output.id,
      });
      // The encoded file carries the issues of the PCM it encodes.
      return { result, issues: status.published.issues };
    } catch (error) {
      this.owners.cache.remove(output.id);
      if (error instanceof CatalogError && error.code === "ARTIFACT_EXPIRED")
        throw new JobDependencyLost("Project PCM disappeared before encoding");
      throw error;
    }
  }
  private async renderProject(
    job: Pick<Job, "target" | "artifact" | "input">,
    raw: unknown,
    output: string,
    signal: AbortSignal,
  ) {
    const parsed = projectOptionsSchema.safeParse(raw);
    if (job.target.kind !== "project" || job.artifact !== artifact || !parsed.success)
      throw new CatalogError("UNSUPPORTED_JOB", "Audio job does not name a project window");
    const owner = this.owners.project;
    if (!owner || owner.renderer.implementationId !== parsed.data.implementationId)
      throw new CatalogError("NOT_READY", "Pinned project audio renderer is unavailable", {});
    const plan = this.projectPlan({
      projectId: job.target.id,
      revisionId: job.target.revisionId,
      ...parsed.data,
      preparedResourceId: parsed.data.preparedResourceId ?? null,
    });
    if (
      parsed.data.retimeImplementationId !==
      (plan.retained ? undefined : retimeImplementation(plan.window, owner.renderer))
    )
      throw new CatalogError("NOT_READY", "Pinned retiming implementation is unavailable", {});
    signal.throwIfAborted();
    let prepared: PreparedAudioRead | undefined;
    try {
      prepared = plan.retained
        ? owner.prepared.open(plan.retained.resourceId, plan.window.manifest.sampleRange)
        : undefined;
      const value = checkProjectAudioResult(
        await owner.renderer.render({ ...plan, prepared, output }, signal),
        plan.window,
        output,
        prepared,
      );
      signal.throwIfAborted();
      const sampleRange = plan.window.manifest.sampleRange;
      return {
        value: {
          ...value,
          ...parsed.data,
          projectId: job.target.id,
          revisionId: job.target.revisionId,
          mediaType: "audio/wav",
          layout: "stereo",
          sampleRange,
        } satisfies Omit<ProjectAudioArtifact, "cacheId">,
        issues: [...plan.outputIssues, ...audioProcessingIssues(value.processingEvidence ?? [])],
      };
    } finally {
      prepared?.release();
    }
  }
  /** One selection renderer and receipt validator for transient inspection and retained excerpts. */
  async renderSelection(
    job: Pick<Job, "target" | "artifact" | "input">,
    output: string,
    signal: AbortSignal,
  ) {
    let raw: unknown;
    try {
      raw = JSON.parse(job.input);
    } catch {
      throw new CatalogError("UNSUPPORTED_JOB", "Invalid audio job input");
    }
    if (job.target.kind === "project") return this.renderProject(job, raw, output, signal);
    const parsed = optionsSchema.safeParse(raw);
    if (
      job.target.kind !== "asset" ||
      job.artifact !== artifact ||
      !parsed.success ||
      parsed.data.selection.assetId !== job.target.id
    )
      throw new CatalogError("UNSUPPORTED_JOB", "Audio job does not name a selected asset stream");
    const options = parsed.data;
    if (options.implementationId !== this.owners.sourceRenderer.implementationId)
      throw new CatalogError("NOT_READY", "Pinned audio renderer is unavailable", {});
    const { source } = this.plan({ ...options.selection, range: options.range });
    if (source.supportDigest !== options.supportDigest)
      throw new CatalogError("ARTIFACT_CHANGED", "Selected source support changed");
    signal.throwIfAborted();
    const receipt = receiptSchema.safeParse(
      await this.owners.sourceRenderer.render(
        { source: source.track, range: options.range, output },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!receipt.success) invalid("Malformed source audio receipt");
    const value = receipt.data;
    const metadata = this.owners.assets
      .get(options.selection.assetId)
      .streams.find((stream) => stream.id === options.selection.streamId)!;
    const first = sample(options.range.startUs, value.sampleRate),
      last = sample(options.range.endUs, value.sampleRate);
    if (
      value.file !== output ||
      !isDeepStrictEqual(value.range, options.range) ||
      value.sampleRange.start !== first ||
      value.sampleRange.end !== last ||
      value.frames !== last - first ||
      value.layout !== (value.channels === 1 ? "mono" : "stereo") ||
      (metadata.sampleRate !== undefined && metadata.sampleRate !== value.sampleRate) ||
      (metadata.channels !== undefined && metadata.channels !== value.channels) ||
      !isDeepStrictEqual(value.unavailable, unavailable(options.range, source.track.available))
    )
      invalid("Source audio receipt differs from its selected stream or sample window");
    checkAudioWaveFile(value);
    return {
      value: {
        ...value,
        ...options.selection,
        supportDigest: options.supportDigest,
        implementationId: options.implementationId,
      } satisfies Omit<SourceAudioArtifact, "cacheId">,
      issues: [],
    };
  }
  async execute({ job, signal }: JobExecution): Promise<string | StagedJobResult> {
    if (job.artifact === "audio-file") return this.executeEncoded({ job, signal });
    if (job.target.kind !== "project" && job.target.kind !== "asset")
      throw new CatalogError("UNSUPPORTED_JOB", "Audio requires a project or asset selection");
    const output = this.owners.cache.reserve(job.target);
    try {
      const { value, issues } = await this.renderSelection(job, output.path, signal);
      signal.throwIfAborted();
      const cached = await this.owners.cache.publish(output.id);
      signal.throwIfAborted();
      if (cached.bytes !== value.bytes) invalid("Published audio size differs from its receipt");
      // A processed project window carries its state splits and treatments' issues to every read.
      return {
        result: JSON.stringify({ ...publicAudioArtifact(value), cacheId: output.id }),
        issues,
      };
    } catch (error) {
      this.owners.cache.remove(output.id);
      throw error;
    }
  }
}

/** Validate the completed producer file before immutable publication. */
function checkAudioWaveFile(
  value: Pick<SourceAudioResult, "file" | "bytes" | "sampleRate" | "channels" | "frames">,
) {
  const actual = readAudioWaveFile(value.file, value.bytes);
  if (
    actual.frames !== value.frames ||
    actual.sampleRate !== value.sampleRate ||
    actual.channels !== value.channels
  )
    invalid("WAV dimensions differ from the native receipt");
}

/** The same receipt and source-gap contract applies to cached and durably prepared audio. */
export function checkProjectAudioResult(
  result: unknown,
  window: CompositionWindow,
  output: string,
  retained?: { value: { processingEvidence?: AudioProcessingEvidence[] | undefined } },
) {
  const receipt = projectAudioReceiptSchema.safeParse(result);
  if (!receipt.success) invalid("Malformed project audio receipt");
  const value = receipt.data;
  const evidence = value.processingEvidence ?? [];
  if (retained) {
    if (!isDeepStrictEqual(evidence, retained.value.processingEvidence ?? []))
      invalid("Retained audio changed its complete processing evidence");
  } else {
    const domains = window.audioState()?.domains ?? [];
    const expected = new Map(
      domains.flatMap((domain, index) =>
        domain.recipe.type === "rnnoise" || domain.sampleRange.end === domain.sampleRange.start
          ? []
          : [[index, domain] as const],
      ),
    );
    for (const item of evidence) {
      const domain = expected.get(item.domainIndex);
      if (
        !domain ||
        !isDeepStrictEqual(item.recipe, domain.recipe) ||
        !isDeepStrictEqual(item.sampleRange, domain.sampleRange)
      )
        invalid("Audio processing evidence differs from its complete compiled domain");
      const binding = window.manifest.requirements.find(
        (requirement) =>
          requirement.kind === "processor" && requirement.processor.type === domain.recipe.type,
      );
      if (!binding?.implementationId || binding.implementationId !== item.implementationId)
        invalid("Audio processing evidence changed its pinned implementation");
      if (item.recipe.type === "normalization") {
        if (!item.normalization)
          invalid("Normalization omitted complete before/after measurements");
        const attempts = item.normalization.attempts;
        const single = attempts.length === 1 && attempts[0]!.offsetDb === null;
        if (
          !isDeepStrictEqual(
            attempts[item.normalization.selectedAttempt]?.after,
            item.normalization.after,
          ) ||
          item.normalization.selectedAttempt !==
            selectNormalizationAttempt(item.recipe, attempts) ||
          (item.recipe.mode === "gain-only" ||
          normalizationPassedThrough(item.recipe, item.normalization)
            ? !single
            : attempts.some((attempt) => attempt.offsetDb === null))
        )
          invalid("Normalization candidate evidence differs from its final signal or mode");
      } else if (item.normalization)
        invalid("Non-normalization domain supplied normalization measurements");
      if (item.limiter && item.recipe.type !== "limiter")
        invalid("Non-limiter domain supplied a limited peak");
      expected.delete(item.domainIndex);
    }
    if (expected.size) invalid("Audio processing omitted a complete prepared domain");
  }
  const sampleRange = window.manifest.sampleRange;
  if (
    value.file !== output ||
    value.frames !== sampleRange.end - sampleRange.start ||
    value.clippedSamples > value.frames * 2
  )
    invalid("Project audio receipt differs from its pinned sample window");
  const clips = new Map(
    [...window.audio()]
      .filter((clip) => clip.source.kind === "range")
      .map((clip) => [clip.clipId, clip]),
  );
  for (const missing of value.unavailable) {
    const clip = clips.get(missing.clipId);
    if (!clip) invalid("Project audio receipt names an unselected or repeated clip");
    let through = clip.sampleRange.start;
    for (const gap of missing.ranges) {
      if (gap.start < through || gap.end <= gap.start || gap.end > clip.sampleRange.end)
        invalid("Project audio unavailable samples exceed their clip");
      through = gap.end;
    }
    clips.delete(missing.clipId);
  }
  if (clips.size) invalid("Project audio receipt omitted a selected clip");
  checkAudioWaveFile(value);
  return value;
}
