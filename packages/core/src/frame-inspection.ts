import {
  pictureObservationRequestSchema,
  pictureObservationsSchema,
  type PictureObservationRequest,
  type NormalizedPictureObservationRequest,
  faceObservationRequestSchema,
  faceObservationsSchema,
  type FaceObservationRequest,
} from "@yap/protocol";
import { sceneSampleSourceTime } from "./source-scenes.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  compiledFrameSchema,
  timeValueSchema,
  signedTimeValueSchema,
  add,
  subtract,
  toSignedTime,
  rational,
  round,
  type SelectionRange,
  compare,
  fromTime,
  fontReferenceSchema,
  textStrokeSchema,
  textShadowSchema,
  textBackgroundSchema,
  textHighlightSchema,
  processingTapSchema,
  type ProcessingTap,
  type CompiledFrame,
  omit,
  type Issue,
} from "@yap/composition";
import type { ProjectStore } from "./projects.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { selectSource, sourceSelectionSchema, type SourceSelection } from "./source-selection.js";
import { compositionAsset, type AssetStore } from "./assets.js";
import type {
  JobQueue,
  JobExecution,
  JobOwner,
  Job,
  JobAdmission,
  StagedJobResult,
} from "./jobs.js";
import type { DerivedCache } from "./cache.js";
import { CatalogError } from "./catalog.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import {
  projectWindow,
  type CompositionWindow,
  type CompositionAssetBinding,
  type ImmutableAssetBinding,
  type ProjectRenderSupport,
} from "./project-window.js";
import { textFallbackIssues, textFallbacksSchema } from "./text-fallback.js";

const time = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const selectedPicture = {
  clipId: z.string().min(1),
  assetId: z.string().min(1),
  streamId: z.string().min(1),
};
const pictureDeliverySchema = z.object({
  file: z.string(),
  mediaType: z.literal("image/png"),
  width: z.int().positive(),
  height: z.int().positive(),
  observations: pictureObservationsSchema.optional(),
  faceObservations: faceObservationsSchema.optional(),
  sourceWidth: z.int().positive(),
  sourceHeight: z.int().positive(),
  bytes: z
    .int()
    .positive()
    .max(32 * 1024 * 1024),
});
const textLayoutSchema = z
  .object({
    font: fontReferenceSchema,
    text: z.string().max(8192),
    visibleRange: z.tuple([time, time]),
    lines: z
      .array(
        z
          .object({
            range: z.tuple([time, time]),
            text: z.string().max(8192),
            origin: z.tuple([z.number().finite(), z.number().finite()]),
            width: z.number().finite().nonnegative(),
            fonts: z.array(z.string().min(1)).max(8192),
          })
          .strict(),
      )
      .max(8192),
    inkBounds: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
    ]),
    visibleBounds: z.union([
      z.tuple([
        z.number().finite(),
        z.number().finite(),
        z.number().finite().nonnegative(),
        z.number().finite().nonnegative(),
      ]),
      z.tuple([]),
    ]),
    decorationBounds: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
    ]),
    verticalOffset: z.number().finite(),
    stroke: textStrokeSchema.optional(),
    shadow: textShadowSchema.optional(),
    background: textBackgroundSchema.optional(),
    highlight: textHighlightSchema.optional(),
    activeRanges: z
      .array(z.tuple([time, time]).refine(([start, end]) => start < end, "Expected active range"))
      .max(10000)
      .optional(),
  })
  .refine((layout) => {
    const [x, y, width, height] = layout.decorationBounds;
    const [inkX, inkY, inkWidth, inkHeight] = layout.inkBounds;
    return x <= inkX && y <= inkY && x + width >= inkX + inkWidth && y + height >= inkY + inkHeight;
  }, "Decoration bounds must contain ink bounds")
  .strict();
const nativeProjectReceiptSchema = pictureDeliverySchema.extend({
  profile: z.literal("h264-rec709"),
  frame: compiledFrameSchema,
  decodedSamples: time,
  readerOpens: time,
  decodedImages: time,
  pictures: z.array(
    z.discriminatedUnion("kind", [
      z.discriminatedUnion("status", [
        z.strictObject({
          kind: z.literal("text"),
          clipId: z.string().min(1),
          status: z.literal("available"),
          layout: textLayoutSchema,
        }),
        z.strictObject({
          kind: z.literal("text"),
          clipId: z.string().min(1),
          status: z.literal("unavailable"),
          reason: z.string().min(1),
        }),
      ]),
      z
        .strictObject({
          kind: z.literal("image"),
          ...selectedPicture,
          status: z.enum(["available", "unavailable"]),
          reason: z.string().min(1).optional(),
        })
        .refine((value) =>
          value.status === "available" ? value.reason === undefined : value.reason !== undefined,
        ),
      z.discriminatedUnion("status", [
        z.strictObject({
          kind: z.literal("video"),
          status: z.literal("unavailable"),
          ...selectedPicture,
          requestedSourceUs: timeValueSchema,
          reason: z.string().min(1),
        }),
        z.strictObject({
          kind: z.literal("video"),
          status: z.literal("available"),
          ...selectedPicture,
          requestedSourceUs: timeValueSchema,
          actualSourceUs: z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
          sample: z.object({
            value: z.string().regex(/^-?\d+$/),
            timescale: z.int().positive(),
            originUs: signedTimeValueSchema,
          }),
        }),
      ]),
    ]),
  ),
  /** Omitted when every text drew with its pinned face, as in every receipt before fallback published. */
  textFallbacks: textFallbacksSchema.optional(),
});
const projectReceiptSchema = nativeProjectReceiptSchema.extend({
  frame: z.strictObject(compiledFrameSchema.shape).omit({ visual: true }),
});
export const projectPictureOptionsSchema = z.strictObject({
  maxLongEdge: z.int().min(1).max(8192),
  tap: processingTapSchema,
  implementationId: z.string().min(1),
  observationRequest: pictureObservationRequestSchema.optional(),
  faceObservationRequest: faceObservationRequestSchema.optional(),
});
const optionsSchema = z.strictObject({
  atUs: time,
  cursorTrailUs: z.int().min(0).max(10_000_000).optional(),
  ...projectPictureOptionsSchema.shape,
});
export const retainedProjectFrameSchema = projectReceiptSchema
  .extend({
    ...optionsSchema.shape,
    projectId: z.string().min(1),
    revisionId: z.string().min(1),
  })
  .strict();
export type ProjectFrameInput = {
  projectId: string;
  revisionId?: string | undefined;
  atUs: number;
  maxLongEdge?: number | undefined;
  tap?: ProcessingTap | undefined;
  observations?: PictureObservationRequest | undefined;
  faceObservations?: FaceObservationRequest | undefined;
  cursorTrailUs?: number | undefined;
};
export type ProjectFrameRenderer = ProjectRenderSupport & {
  implementationId: string;
  render(
    request: {
      model: import("@yap/composition").ValidatedComposition;
      window: CompositionWindow;
      assets: readonly CompositionAssetBinding[];
      fonts: readonly ImmutableAssetBinding[];
      luts: readonly ImmutableAssetBinding[];
      output: string;
      maxLongEdge: number;
      observations?: NormalizedPictureObservationRequest | undefined;
      faceObservations?: FaceObservationRequest | undefined;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type ProjectFrameArtifact = z.infer<typeof projectReceiptSchema> &
  z.infer<typeof optionsSchema> & {
    projectId: string;
    revisionId: string;
    cacheId: string;
  };

const sourceOptionsSchema = z.strictObject({
  selection: sourceSelectionSchema,
  atUs: time,
  cursorTrailUs: z.int().min(0).max(10_000_000).optional(),
  maxLongEdge: z.int().min(1).max(8192),
  supportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  implementationId: z.string().min(1),
  observationRequest: pictureObservationRequestSchema.optional(),
  faceObservationRequest: faceObservationRequestSchema.optional(),
});
const sourceReceiptSchema = pictureDeliverySchema.extend({
  decodedSamples: time,
  readerOpens: time,
  assetId: z.string().min(1),
  streamId: z.string().min(1),
  requestedSourceUs: time,
  actualSourceUs: z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  sample: z.object({
    value: z
      .string()
      .max(21)
      .regex(/^-?\d+$/),
    timescale: z.int().positive(),
    endValue: z
      .string()
      .max(21)
      .regex(/^-?\d+$/),
    endTimescale: z.int().positive(),
    originUs: signedTimeValueSchema,
  }),
});
const sourceImageSelectionSchema = sourceSelectionSchema.omit({ acquisitionId: true });
const imageOptionsSchema = z.strictObject({
  kind: z.literal("image"),
  selection: sourceImageSelectionSchema,
  maxLongEdge: z.int().min(1).max(8192),
  implementationId: z.string().min(1),
  observationRequest: pictureObservationRequestSchema.optional(),
  faceObservationRequest: faceObservationRequestSchema.optional(),
});
const imageReceiptSchema = pictureDeliverySchema.extend({
  kind: z.literal("image"),
  ...sourceImageSelectionSchema.shape,
  orientation: z.int().min(1).max(8),
  hasAlpha: z.boolean(),
  decodedImages: z.literal(1),
  readerOpens: z.literal(1),
});
const imageInputSchema = sourceImageSelectionSchema
  .extend({
    maxLongEdge: imageOptionsSchema.shape.maxLongEdge.optional(),
    observations: pictureObservationRequestSchema.optional(),
    faceObservations: faceObservationRequestSchema.optional(),
  })
  .strict();
export type SourceImageInput = z.input<typeof imageInputSchema>;
export type SourceImageRenderer = {
  implementationId: string;
  render(
    request: {
      asset: Pick<CompositionAssetBinding, "assetId" | "streamId" | "path">;
      maxLongEdge: number;
      observations?: NormalizedPictureObservationRequest | undefined;
      faceObservations?: FaceObservationRequest | undefined;
      output: string;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type SourceImageArtifact = z.infer<typeof imageReceiptSchema> & {
  maxLongEdge: number;
  implementationId: string;
  observationRequest?: NormalizedPictureObservationRequest | undefined;
  faceObservationRequest?: FaceObservationRequest | undefined;
  cacheId: string;
};

export type SourceFrameInput = SourceSelection & {
  atUs: number;
  cursorTrailUs?: number | undefined;
  maxLongEdge?: number | undefined;
  observations?: PictureObservationRequest | undefined;
  faceObservations?: FaceObservationRequest | undefined;
};
export type SourceFrameUnavailable = z.infer<typeof sourceOptionsSchema> &
  Pick<Job, "jobId" | "attemptId" | "reason"> & {
    observation: { requestedSourceUs: number; status: "unavailable"; reason: "empty_edit" };
  };
/** Retained no-picture evidence keeps donor attempt identity without requiring a local execution. */
export const sourceFrameUnavailableSchema = sourceOptionsSchema
  .extend({
    jobId: z.uuid(),
    attemptId: z.uuid(),
    reason: z.string().max(4096).nullable(),
    observation: z.strictObject({
      requestedSourceUs: time,
      status: z.literal("unavailable"),
      reason: z.literal("empty_edit"),
    }),
  })
  .refine((value) => value.observation.requestedSourceUs === value.atUs);
export type MediaFrameInput = SourceFrameInput | SourceImageInput | ProjectFrameInput;
export type SourceFrameRenderer = {
  implementationId: string;
  render(
    request: {
      asset: CompositionAssetBinding;
      available: SelectionRange[];
      atUs: number;
      maxLongEdge: number;
      observations?: NormalizedPictureObservationRequest | undefined;
      faceObservations?: FaceObservationRequest | undefined;
      output: string;
      cursorOverlay?: unknown;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type SourceFrameArtifact = z.infer<typeof sourceReceiptSchema> &
  SourceSelection & {
    atUs: number;
    maxLongEdge: number;
    supportDigest: string;
    implementationId: string;
    observationRequest?: NormalizedPictureObservationRequest | undefined;
    faceObservationRequest?: FaceObservationRequest | undefined;
    cacheId: string;
  };

export function validateSourceFrameGeometry(
  value: Pick<SourceFrameArtifact, "sourceWidth" | "sourceHeight" | "width" | "height">,
  source: { width: number; height: number },
  maxLongEdge: number,
): void {
  if (
    value.sourceWidth !== Math.round(source.width) ||
    value.sourceHeight !== Math.round(source.height) ||
    value.width > value.sourceWidth ||
    value.height > value.sourceHeight ||
    Math.max(value.width, value.height) > maxLongEdge
  )
    throw new CatalogError("INVALID_RESPONSE", "Source picture receipt changed its geometry");
}

export function validateFaceObservations(
  value: { width: number; height: number; faceObservations?: unknown },
  request: FaceObservationRequest | undefined,
): void {
  if (request === undefined) {
    if (value.faceObservations !== undefined)
      throw new CatalogError("INVALID_RESPONSE", "Unexpected face observations were returned");
    return;
  }
  const observations = faceObservationsSchema.safeParse(value.faceObservations);
  if (!observations.success)
    throw new CatalogError("INVALID_RESPONSE", "Requested face observations were not returned");
  if (observations.data.width !== value.width || observations.data.height !== value.height)
    throw new CatalogError(
      "INVALID_RESPONSE",
      "Face observations address another delivered raster",
    );
}

export const retainedSourceFrameSchema = sourceReceiptSchema
  .extend({
    ...sourceSelectionSchema.shape,
    atUs: time,
    maxLongEdge: sourceOptionsSchema.shape.maxLongEdge,
    supportDigest: sourceOptionsSchema.shape.supportDigest,
    implementationId: z.string().min(1).max(256),
    observationRequest: pictureObservationRequestSchema.optional(),
    faceObservationRequest: faceObservationRequestSchema.optional(),
  })
  .strict();

/** A demanded picture uses the movie's global schedule and shared derivative lifetime. */
export class MediaFrameInspection {
  constructor(
    private readonly owners: {
      assets: AssetStore;
      acquisitions: AcquisitionStore;
      jobs: JobQueue;
      cache: DerivedCache;
      sourceRenderer: SourceFrameRenderer;
      imageRenderer?: SourceImageRenderer;
      project?: { projects: ProjectStore; renderer: ProjectFrameRenderer };
      cursorOverlay?: (
        input: SourceSelection & { atUs: number; trailUs: number },
        signal: AbortSignal,
      ) => Promise<unknown | null>;
    },
  ) {
    if (
      !owners.sourceRenderer.implementationId ||
      (owners.imageRenderer && !owners.imageRenderer.implementationId) ||
      (owners.project && !owners.project.renderer.implementationId)
    )
      throw new Error("Picture renderer needs an implementation identity");
  }
  private get project() {
    if (!this.owners.project)
      throw new CatalogError("UNSUPPORTED_JOB", "Project pictures are unavailable");
    return this.owners.project;
  }

  private imagePlan(input: SourceImageInput) {
    // Input keys are checked separately so an image cannot acquire a timed selection by accident.
    const parsedInput = imageInputSchema.safeParse(input);
    if (!parsedInput.success)
      throw new CatalogError(
        "INVALID_PARAMS",
        "Still images accept assetId, streamId, maxLongEdge and observations only",
      );
    const asset = this.owners.assets.get(input.assetId);
    const stream = compositionAsset(asset).streams.find((value) => value.id === input.streamId);
    if (!stream || stream.kind !== "image")
      throw new CatalogError(
        "INVALID_PARAMS",
        "A timeless picture requires an image stream; video requires atUs",
      );
    const renderer = this.owners.imageRenderer;
    if (!renderer)
      throw new CatalogError("UNSUPPORTED_JOB", "Still-image pictures are unavailable");
    const metadata = asset.streams.find((value) => value.id === stream.id)!;
    const options = imageOptionsSchema.parse({
      kind: "image",
      selection: { assetId: asset.id, streamId: stream.id },
      maxLongEdge: input.maxLongEdge ?? 1600,
      ...(input.observations === undefined ? {} : { observationRequest: input.observations }),
      ...(input.faceObservations === undefined
        ? {}
        : { faceObservationRequest: input.faceObservations }),
      implementationId: renderer.implementationId,
    });
    return {
      options,
      metadata,
      stream,
      renderer,
      asset: { assetId: asset.id, streamId: stream.id, path: this.owners.assets.path(asset.id) },
    };
  }
  private sourceDerivative<T extends { cacheId: string }>(
    options: z.infer<typeof sourceOptionsSchema> | z.infer<typeof imageOptionsSchema>,
  ) {
    const { assets, acquisitions, jobs, cache } = this.owners;
    return submitCachedDerivative<T>(
      jobs,
      cache,
      {
        target: { kind: "asset", assetId: options.selection.assetId },
        artifact: "frame",
        input: JSON.stringify(options),
      },
      "frame",
      {
        admitted: (job) => {
          const owner = { kind: "job" as const, id: job.jobId };
          assets.retain(owner, [options.selection.assetId]);
          if ("acquisitionId" in options.selection && options.selection.acquisitionId)
            acquisitions.retain(owner, [options.selection.acquisitionId]);
        },
      },
    );
  }
  private requestImage(input: SourceImageInput) {
    const { options } = this.imagePlan(input);
    const status = this.sourceDerivative<SourceImageArtifact>(options);
    return {
      ...options.selection,
      kind: options.kind,
      maxLongEdge: options.maxLongEdge,
      ...(options.observationRequest === undefined
        ? {}
        : { observationRequest: options.observationRequest }),
      ...(options.faceObservationRequest === undefined
        ? {}
        : { faceObservationRequest: options.faceObservationRequest }),
      implementationId: options.implementationId,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            frame: status.published.value,
          }
        : null,
    };
  }

  sourcePlan(input: SourceFrameInput) {
    const source = selectSource(this.owners.assets, this.owners.acquisitions, {
      assetId: input.assetId,
      streamId: input.streamId,
      ...(input.acquisitionId === undefined ? {} : { acquisitionId: input.acquisitionId }),
    });
    if (source.stream.kind !== "video")
      throw new CatalogError("UNSUPPORTED_MEDIA", "Source pictures require timed video");
    const parsed = sourceOptionsSchema.safeParse({
      selection: source.selection,
      atUs: input.atUs,
      ...(input.cursorTrailUs === undefined ? {} : { cursorTrailUs: input.cursorTrailUs }),
      maxLongEdge: input.maxLongEdge ?? 1600,
      ...(input.observations === undefined ? {} : { observationRequest: input.observations }),
      ...(input.faceObservations === undefined
        ? {}
        : { faceObservationRequest: input.faceObservations }),
      supportDigest: source.supportDigest,
      implementationId: this.owners.sourceRenderer.implementationId,
    });
    if (!parsed.success || compare(fromTime(input.atUs), fromTime(source.durationUs)) >= 0)
      throw new CatalogError("INVALID_RANGE", "Picture time must lie within the source duration");
    const contains = (range: SelectionRange) =>
      compare(fromTime(range.startUs), fromTime(input.atUs)) <= 0 &&
      compare(fromTime(input.atUs), fromTime(range.endUs)) < 0;
    const available = source.track.available.filter(contains);
    const reason = !source.stream.available.some(contains)
      ? "physical_gap"
      : !available.length
        ? "acquisition_excluded"
        : null;
    const asset: CompositionAssetBinding = {
      assetId: source.selection.assetId,
      streamId: source.selection.streamId,
      path: source.track.source,
      originUs: toSignedTime(subtract(fromTime(0), fromTime(source.track.sourceOffsetUs))),
    };
    return { source, options: parsed.data, asset, reason, available };
  }
  private requestSource(input: SourceFrameInput) {
    const { options, reason } = this.sourcePlan(input);
    const status = reason
      ? {
          state: "unavailable" as const,
          reason,
          retryable: false,
          jobId: null,
          published: null,
        }
      : this.sourceDerivative<SourceFrameArtifact>(options);
    return {
      ...options.selection,
      atUs: options.atUs,
      maxLongEdge: options.maxLongEdge,
      ...(options.cursorTrailUs === undefined ? {} : { cursorTrailUs: options.cursorTrailUs }),
      ...(options.observationRequest === undefined
        ? {}
        : { observationRequest: options.observationRequest }),
      ...(options.faceObservationRequest === undefined
        ? {}
        : { faceObservationRequest: options.faceObservationRequest }),
      supportDigest: options.supportDigest,
      implementationId: options.implementationId,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            frame: status.published.value,
          }
        : null,
    };
  }
  /** Snapshots only a native no-picture observation; ordinary failures never become missing pixels. */
  sourceUnavailable(input: SourceFrameInput): SourceFrameUnavailable {
    const { options } = this.sourcePlan(input);
    const status = this.owners.jobs.status({
      target: { kind: "asset", assetId: options.selection.assetId },
      artifact: "frame",
      input: JSON.stringify(options),
    });
    const job = status.jobId ? this.owners.jobs.job(status.jobId) : null;
    if (
      !job ||
      job.state !== "unavailable" ||
      job.errorCode !== "UNAVAILABLE" ||
      job.errorDetails?.reason !== "empty_edit" ||
      job.errorDetails?.requestedSourceUs !== options.atUs
    )
      throw new CatalogError(
        "PREREQUISITE_MISSING",
        "No physical no-picture observation exists for this request",
      );
    return {
      ...options,
      jobId: job.jobId,
      attemptId: job.attemptId,
      reason: job.reason,
      observation: { requestedSourceUs: options.atUs, status: "unavailable", reason: "empty_edit" },
    };
  }

  private async publish<T extends { file: string; bytes: number }>(
    owner: Extract<JobOwner, { kind: "asset" | "project" }>,
    signal: AbortSignal,
    render: (output: string) => Promise<T>,
  ) {
    signal.throwIfAborted();
    const output = this.owners.cache.reserve(owner);
    try {
      const value = await render(output.path);
      signal.throwIfAborted();
      if (value.file !== output.path)
        throw new CatalogError("INVALID_RESPONSE", "Picture receipt changed output path");
      const cached = await this.owners.cache.publish(output.id);
      signal.throwIfAborted();
      if (cached.bytes !== value.bytes)
        throw new CatalogError(
          "INVALID_RESPONSE",
          "Published picture size differs from its receipt",
        );
      return JSON.stringify({ ...value, cacheId: output.id });
    } catch (error) {
      this.owners.cache.remove(output.id);
      throw error;
    }
  }
  private async executeImage({ job, signal }: JobExecution) {
    const parsed = imageOptionsSchema.safeParse(JSON.parse(job.input));
    if (
      job.target.kind !== "asset" ||
      job.artifact !== "frame" ||
      !parsed.success ||
      parsed.data.selection.assetId !== job.target.assetId
    )
      throw new CatalogError("UNSUPPORTED_JOB", "Picture job does not name a still image");
    const plan = this.imagePlan({
      ...parsed.data.selection,
      maxLongEdge: parsed.data.maxLongEdge,
      observations: parsed.data.observationRequest,
      faceObservations: parsed.data.faceObservationRequest,
    });
    if (plan.options.implementationId !== parsed.data.implementationId)
      throw new CatalogError("NOT_READY", "Pinned image renderer is unavailable", {});
    return this.publish(job.target, signal, async (output) => {
      const receipt = imageReceiptSchema.safeParse(
        await plan.renderer.render(
          {
            asset: plan.asset,
            output,
            maxLongEdge: plan.options.maxLongEdge,
            ...(plan.options.observationRequest === undefined
              ? {}
              : { observations: plan.options.observationRequest }),
            ...(plan.options.faceObservationRequest === undefined
              ? {}
              : { faceObservations: plan.options.faceObservationRequest }),
          },
          signal,
        ),
      );
      if (!receipt.success)
        throw new CatalogError("INVALID_RESPONSE", "Malformed still-image receipt");
      const value = receipt.data;
      validatePictureObservations(value, plan.options.observationRequest);
      validateFaceObservations(value, plan.options.faceObservationRequest);
      const scale = Math.min(
        1,
        plan.options.maxLongEdge / Math.max(plan.stream.width, plan.stream.height),
      );
      if (
        value.assetId !== plan.asset.assetId ||
        value.streamId !== plan.asset.streamId ||
        value.sourceWidth !== plan.stream.width ||
        value.sourceHeight !== plan.stream.height ||
        value.width !== Math.max(1, Math.round(plan.stream.width * scale)) ||
        value.height !== Math.max(1, Math.round(plan.stream.height * scale)) ||
        value.orientation !== plan.metadata.orientation ||
        value.hasAlpha !== plan.metadata.hasAlpha
      )
        throw new CatalogError(
          "INVALID_RESPONSE",
          "Still-image receipt changed its identity or dimensions",
        );
      return {
        ...value,
        maxLongEdge: plan.options.maxLongEdge,
        implementationId: plan.options.implementationId,
        ...(plan.options.observationRequest === undefined
          ? {}
          : { observationRequest: plan.options.observationRequest }),
        ...(plan.options.faceObservationRequest === undefined
          ? {}
          : { faceObservationRequest: plan.options.faceObservationRequest }),
      };
    });
  }
  private async executeSource({ job, signal }: JobExecution) {
    const parsed = sourceOptionsSchema.safeParse(JSON.parse(job.input));
    if (
      job.target.kind !== "asset" ||
      job.artifact !== "frame" ||
      !parsed.success ||
      parsed.data.selection.assetId !== job.target.assetId
    )
      throw new CatalogError("UNSUPPORTED_JOB", "Picture job does not name a selected source");
    if (parsed.data.implementationId !== this.owners.sourceRenderer.implementationId)
      throw new CatalogError("NOT_READY", "Pinned picture renderer is unavailable", {});
    const plan = this.sourcePlan({
      ...parsed.data.selection,
      ...parsed.data,
      observations: parsed.data.observationRequest,
      faceObservations: parsed.data.faceObservationRequest,
    });
    if (plan.options.supportDigest !== parsed.data.supportDigest)
      throw new CatalogError("ARTIFACT_CHANGED", "Selected source support changed");
    if (plan.reason) throw new CatalogError("UNAVAILABLE", plan.reason);
    return this.publish({ kind: "asset", assetId: job.target.assetId }, signal, async (output) => {
      const parsedReceipt = sourceReceiptSchema.safeParse(
        await this.owners.sourceRenderer
          .render(
            {
              asset: plan.asset,
              // Native admission needs only the demanded interval; the job pins complete support.
              available: plan.available,
              atUs: plan.options.atUs,
              maxLongEdge: plan.options.maxLongEdge,
              ...(plan.options.cursorTrailUs === undefined
                ? {}
                : {
                    cursorOverlay: await this.owners.cursorOverlay?.(
                      {
                        ...plan.options.selection,
                        atUs: plan.options.atUs,
                        trailUs: plan.options.cursorTrailUs,
                      },
                      signal,
                    ),
                  }),
              ...(plan.options.observationRequest === undefined
                ? {}
                : { observations: plan.options.observationRequest }),
              ...(plan.options.faceObservationRequest === undefined
                ? {}
                : { faceObservations: plan.options.faceObservationRequest }),
              output,
            },
            signal,
          )
          .catch((error: unknown) => {
            if (error instanceof CatalogError && error.code === "SOURCE_PICTURE_UNAVAILABLE")
              throw new CatalogError("UNAVAILABLE", error.message, {
                reason: "empty_edit",
                requestedSourceUs: plan.options.atUs,
              });
            throw error;
          }),
      );
      if (!parsedReceipt.success)
        throw new CatalogError("INVALID_RESPONSE", "Malformed source picture receipt");
      validatePictureObservations(parsedReceipt.data, plan.options.observationRequest);
      validateFaceObservations(parsedReceipt.data, plan.options.faceObservationRequest);
      const value = parsedReceipt.data,
        sample = value.sample;
      const start = BigInt(sample.value),
        end = BigInt(sample.endValue),
        scale = BigInt(sample.timescale),
        endScale = BigInt(sample.endTimescale);
      const at = add(fromTime(plan.options.atUs), fromTime(plan.asset.originUs));
      const metadata = this.owners.assets
        .get(plan.asset.assetId)
        .streams.find((stream) => stream.id === plan.asset.streamId)!;
      if (
        value.assetId !== plan.asset.assetId ||
        value.streamId !== plan.asset.streamId ||
        value.requestedSourceUs !== plan.options.atUs ||
        compare(fromTime(sample.originUs), fromTime(plan.asset.originUs)) !== 0 ||
        round(sceneSampleSourceTime(sample, sample.originUs)) !== value.actualSourceUs ||
        compare(rational(start * 1000000n, scale), at) > 0 ||
        compare(rational(end * 1000000n, endScale), at) <= 0
      )
        throw new CatalogError(
          "INVALID_RESPONSE",
          "Source picture receipt changed its selection or physical clock",
        );
      validateSourceFrameGeometry(
        value,
        {
          width: metadata.orientedWidth ?? metadata.width!,
          height: metadata.orientedHeight ?? metadata.height!,
        },
        plan.options.maxLongEdge,
      );
      return {
        ...value,
        ...plan.options.selection,
        atUs: plan.options.atUs,
        maxLongEdge: plan.options.maxLongEdge,
        supportDigest: plan.options.supportDigest,
        implementationId: plan.options.implementationId,
        ...(plan.options.observationRequest === undefined
          ? {}
          : { observationRequest: plan.options.observationRequest }),
        ...(plan.options.faceObservationRequest === undefined
          ? {}
          : { faceObservationRequest: plan.options.faceObservationRequest }),
      };
    });
  }

  private planProject(input: ProjectFrameInput) {
    const options = optionsSchema.safeParse({
      atUs: input.atUs,
      ...(input.cursorTrailUs === undefined ? {} : { cursorTrailUs: input.cursorTrailUs }),
      maxLongEdge: input.maxLongEdge ?? 1600,
      ...(input.observations === undefined ? {} : { observationRequest: input.observations }),
      ...(input.faceObservations === undefined
        ? {}
        : { faceObservationRequest: input.faceObservations }),
      tap: input.tap ?? { target: { kind: "output" }, point: { kind: "processed" } },
      implementationId: this.project.renderer.implementationId,
    });
    if (!options.success || input.atUs === Number.MAX_SAFE_INTEGER)
      throw new CatalogError("INVALID_PARAMS", "Invalid demanded picture options");
    const plan = projectWindow(
      this.project.projects,
      this.owners.assets,
      {
        projectId: input.projectId,
        revisionId: input.revisionId,
        range: { startUs: input.atUs, endUs: input.atUs + 1 },
        tap: options.data.tap,
        cursorTrailUs: input.cursorTrailUs,
      },
      this.project.renderer,
      "video",
    );
    return { ...plan, options: options.data };
  }

  private requestProject(input: ProjectFrameInput) {
    const { window, options, pointerSources } = this.planProject(input);
    const revisionId = window.manifest.revisionId;
    const status = submitCachedDerivative<ProjectFrameArtifact>(
      this.owners.jobs,
      this.owners.cache,
      {
        target: { kind: "project", projectId: input.projectId, revisionId },
        artifact: "frame",
        input: JSON.stringify({
          ...options,
          ...(input.cursorTrailUs === undefined ? {} : { cursorTrailUs: input.cursorTrailUs }),
        }),
      },
      "frame",
      { deferred: pointerSources.length > 0 },
    );
    return {
      projectId: input.projectId,
      revisionId,
      ...options,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            frame: status.published.value,
          }
        : null,
    };
  }

  request(input: SourceFrameInput): ReturnType<MediaFrameInspection["requestSource"]>;
  request(input: SourceImageInput): ReturnType<MediaFrameInspection["requestImage"]>;
  request(input: ProjectFrameInput): ReturnType<MediaFrameInspection["requestProject"]>;
  request(
    input: MediaFrameInput,
  ):
    | ReturnType<MediaFrameInspection["requestImage"]>
    | ReturnType<MediaFrameInspection["requestSource"]>
    | ReturnType<MediaFrameInspection["requestProject"]>;
  request(input: MediaFrameInput) {
    return "projectId" in input
      ? this.requestProject(input)
      : "atUs" in input
        ? this.requestSource(input)
        : this.requestImage(input);
  }
  retry(input: SourceFrameInput): ReturnType<MediaFrameInspection["requestSource"]>;
  retry(input: SourceImageInput): ReturnType<MediaFrameInspection["requestImage"]>;
  retry(input: ProjectFrameInput): ReturnType<MediaFrameInspection["requestProject"]>;
  retry(
    input: MediaFrameInput,
  ):
    | ReturnType<MediaFrameInspection["requestImage"]>
    | ReturnType<MediaFrameInspection["requestSource"]>
    | ReturnType<MediaFrameInspection["requestProject"]>;
  retry(input: MediaFrameInput) {
    const current = this.request(input);
    if ("projectId" in input && !current.published)
      for (const selection of this.planProject(input).pointerSources)
        this.project.renderer.pointers?.retry(selection);
    if (current.jobId) this.owners.jobs.retry(current.jobId);
    return this.request(
      "projectId" in current
        ? { ...input, projectId: current.projectId, revisionId: current.revisionId }
        : input,
    );
  }
  get projectSupport(): ProjectRenderSupport {
    return this.project.renderer;
  }
  admit(job: Job): ReturnType<JobAdmission> {
    const options = optionsSchema.parse(JSON.parse(job.input));
    if (options.implementationId !== this.project.renderer.implementationId)
      throw new CatalogError("NOT_READY", "Pinned picture renderer is unavailable", {
        implementationId: options.implementationId,
      });
    if (job.target.kind !== "project" || job.artifact !== "frame")
      throw new CatalogError("UNSUPPORTED_JOB", "Picture admission requires a project job");
    const plan = this.planProject({
      projectId: job.target.projectId,
      revisionId: job.target.revisionId,
      ...options,
      observations: options.observationRequest,
      faceObservations: options.faceObservationRequest,
    });
    return this.project.renderer.pointers?.admit(plan.pointerSources) ?? { state: "ready" };
  }
  async execute(execution: JobExecution): Promise<string | StagedJobResult> {
    return execution.job.target.kind === "project"
      ? this.executeProject(execution)
      : JSON.parse(execution.job.input).kind === "image"
        ? this.executeImage(execution)
        : this.executeSource(execution);
  }
  private async executeProject({ job, signal }: JobExecution): Promise<StagedJobResult> {
    const parsed = optionsSchema.safeParse(JSON.parse(job.input));
    if (job.target.kind !== "project" || job.artifact !== "frame" || !parsed.success)
      throw new CatalogError("UNSUPPORTED_JOB", "Picture job does not name a project frame");
    if (parsed.data.implementationId !== this.project.renderer.implementationId)
      throw new CatalogError("NOT_READY", "Pinned picture renderer is unavailable", {});
    const plan = this.planProject({
      projectId: job.target.projectId,
      revisionId: job.target.revisionId,
      ...parsed.data,
      observations: parsed.data.observationRequest,
      faceObservations: parsed.data.faceObservationRequest,
    });
    const projectId = job.target.projectId;
    let issues: Issue[] = [];
    const result = await this.publish({ kind: "project", projectId }, signal, async (output) => {
      const render = () =>
        this.project.renderer.render(
          {
            model: plan.model,
            window: plan.window,
            assets: plan.assets,
            fonts: plan.fonts,
            luts: plan.luts,
            output,
            maxLongEdge: plan.options.maxLongEdge,
            ...(plan.options.observationRequest === undefined
              ? {}
              : { observations: plan.options.observationRequest }),
            ...(plan.options.faceObservationRequest === undefined
              ? {}
              : { faceObservations: plan.options.faceObservationRequest }),
          },
          signal,
        );
      const receipt = this.project.renderer.pointers
        ? await this.project.renderer.pointers.withReady(plan.pointerSources, render)
        : await render();
      signal.throwIfAborted();
      const value = validateProjectFrameReceipt(receipt, plan, output, plan.options.maxLongEdge);
      validatePictureObservations(value, plan.options.observationRequest);
      validateFaceObservations(value, plan.options.faceObservationRequest);
      issues = pictureTextIssues(value);
      return { ...value, ...plan.options, projectId, revisionId: plan.window.manifest.revisionId };
    });
    return { result, issues };
  }
}

type PicturePlan = Pick<ReturnType<typeof projectWindow>, "window" | "assets" | "frameBoundary">;
type PictureReceipt = z.infer<typeof projectReceiptSchema>;
function inspectedFrame(frame: CompiledFrame, plan: PicturePlan): PictureReceipt["frame"] {
  return {
    ...omit(frame, "visual"),
    visibleRange: plan.frameBoundary(frame.sampleAtUs).after!.visibleRange,
  };
}

/** Native instructions stay private, but must match before any public evidence is projected. */
export function validateProjectFrameReceipt(
  receipt: unknown,
  plan: PicturePlan,
  output: string,
  maxLongEdge: number,
): PictureReceipt {
  const parsed = nativeProjectReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new CatalogError("INVALID_RESPONSE", "Malformed picture receipt");
  checkPictureReceipt(parsed.data, plan.window.frames().next().value!, plan, output, maxLongEdge);
  return { ...parsed.data, frame: inspectedFrame(parsed.data.frame, plan) };
}

/** Retained records contain the same public evidence; renderer-private instructions are never stored. */
export function validateRetainedProjectFrameReceipt(
  receipt: unknown,
  plan: PicturePlan,
  output: string,
  maxLongEdge: number,
): PictureReceipt {
  const parsed = projectReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new CatalogError("INVALID_RESPONSE", "Malformed picture receipt");
  checkPictureReceipt(
    parsed.data,
    inspectedFrame(plan.window.frames().next().value!, plan),
    plan,
    output,
    maxLongEdge,
  );
  return parsed.data;
}
function checkPictureReceipt(
  value: PictureReceipt,
  expected: PictureReceipt["frame"],
  plan: PicturePlan,
  output: string,
  maxLongEdge: number,
) {
  const { pictures } = value;
  // A line may name the pinned face or a face its clip's fallback report names, and nothing else.
  const fallbackFaces = (clipId: string) =>
    (value.textFallbacks ?? [])
      .filter((entry) => entry.clipId === clipId)
      .map((entry) => entry.face);
  if (
    value.file !== output ||
    !isDeepStrictEqual(value.frame, expected) ||
    value.sourceWidth !== plan.window.manifest.canvas.width ||
    value.sourceHeight !== plan.window.manifest.canvas.height ||
    value.width > value.sourceWidth ||
    value.height > value.sourceHeight ||
    Math.max(value.width, value.height) > maxLongEdge ||
    pictures.length !== expected.layers.length ||
    pictures.some((picture, index) => {
      const layer = expected.layers[index]!;
      return (
        picture.clipId !== layer.clipId ||
        (picture.kind !== "text" &&
          layer.kind !== "text" &&
          (picture.assetId !== layer.assetId || picture.streamId !== layer.streamId)) ||
        (picture.kind === "text" &&
          layer.kind === "text" &&
          picture.status === "available" &&
          (!isDeepStrictEqual(picture.layout.font, layer.text.font) ||
            picture.layout.text !== layer.text.text ||
            !isDeepStrictEqual(picture.layout.stroke, layer.text.stroke) ||
            !isDeepStrictEqual(picture.layout.shadow, layer.text.shadow) ||
            !isDeepStrictEqual(picture.layout.background, layer.text.background) ||
            !isDeepStrictEqual(picture.layout.highlight, layer.text.highlight) ||
            !isDeepStrictEqual(picture.layout.activeRanges, layer.text.activeRanges) ||
            picture.layout.visibleRange[0] + picture.layout.visibleRange[1] >
              layer.text.text.length ||
            picture.layout.lines.some(
              (line) =>
                line.text !== layer.text.text.slice(line.range[0], line.range[0] + line.range[1]) ||
                line.fonts.some(
                  (font) =>
                    font !== layer.text.font.postScriptName &&
                    !fallbackFaces(picture.clipId).includes(font),
                ),
            ) ||
            fallbackFaces(picture.clipId).some(
              (face) => !picture.layout.lines.some((line) => line.fonts.includes(face)),
            ))) ||
        picture.kind !== layer.kind ||
        (picture.kind === "video" &&
          layer.kind === "video" &&
          compare(fromTime(picture.requestedSourceUs), fromTime(layer.sourceUs)) !== 0) ||
        (layer.availability !== "available" &&
          (picture.status !== "unavailable" || picture.reason !== layer.availability)) ||
        (layer.availability !== "available" && picture.status === "available")
      );
    })
  )
    throw new CatalogError("INVALID_RESPONSE", "Picture receipt differs from its pinned frame");
  if (
    pictures.some(
      (picture) =>
        picture.kind === "video" &&
        picture.status === "available" &&
        (round(sceneSampleSourceTime(picture.sample, picture.sample.originUs)) !==
          picture.actualSourceUs ||
          !isDeepStrictEqual(
            picture.sample.originUs,
            plan.assets.find(
              (asset) => asset.assetId === picture.assetId && asset.streamId === picture.streamId,
            )?.originUs,
          )),
    )
  )
    throw new CatalogError("INVALID_RESPONSE", "Picture receipt changed its source clock");
  pictureTextIssues(value);
}

/** The font fallback issues a picture publishes, derived from its retained receipt alone. */
export function pictureTextIssues(value: Pick<PictureReceipt, "pictures" | "textFallbacks">) {
  return textFallbackIssues(value.textFallbacks, (clipId) => {
    const picture = value.pictures.find((candidate) => candidate.clipId === clipId);
    return picture?.kind === "text" && picture.status === "available"
      ? picture.layout.font
      : undefined;
  });
}

/** Measurement admission binds the receipt to the exact requested masks and delivered geometry. */
export function validatePictureObservations(
  value: {
    width: number;
    height: number;
    observations?: import("@yap/protocol").PictureObservations | undefined;
  },
  request: NormalizedPictureObservationRequest | undefined,
): void {
  if (
    (request === undefined) !== (value.observations === undefined) ||
    (value.observations &&
      (value.observations.width !== value.width ||
        value.observations.height !== value.height ||
        !isDeepStrictEqual(value.observations.request, request)))
  )
    throw new CatalogError(
      "INVALID_RESPONSE",
      "Picture measurements differ from their requested masks or delivered raster",
    );
}
