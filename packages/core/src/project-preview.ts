import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  resolveOutputSettings,
  resolvedOutputSettingsSchema,
  type OutputSettings,
  type OutputSettingsInput,
  rangeSchema,
  type Issue,
} from "@yap/composition";
import type { PreparedAudioStore, PreparedAudioRead } from "./prepared-audio.js";
import { AssetStore } from "./assets.js";
import {
  projectComposition,
  projectCapabilities,
  retimeImplementation,
  validateProjectAudio,
  type CompositionWindow,
  type CompositionAssetBinding,
  type ImmutableAssetBinding,
  type ProjectRenderSupport,
} from "./project-window.js";
export type { CompositionWindow, CompositionAssetBinding } from "./project-window.js";
import { CatalogError } from "./catalog.js";
import { ProjectStore } from "./projects.js";
import type { Job, JobAdmission, JobExecution, JobQueue, StagedJobResult } from "./jobs.js";
import { audioProcessingEvidenceSchema, audioProcessingIssues } from "./audio-measurement.js";
import type { DerivedCache } from "./cache.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import { checkRenderedMovie, type RenderedMovie } from "./rendered-movie.js";
import { textFallbackIssues, textFallbacksSchema } from "./text-fallback.js";

export type ProjectPreviewInput = {
  /** Internal immutable preparation binding; never a public selector. */
  preparedResourceId?: string | null | undefined;
  projectId: string;
  revisionId?: string | undefined;
  range?: { startUs: number; endUs: number } | undefined;
  /** Optional long-edge bound for a draft preview; exports never use this. */
  maxLongEdge?: number | null | undefined;
  settings?: OutputSettingsInput | undefined;
  /** Internal retained intent binding; public requests omit this field. */
  implementationId?: string | undefined;
  retimeImplementationId?: string | undefined;
};
export type CompositionMovie = RenderedMovie & {
  settings: OutputSettings;
  encodedVideo: { profile: OutputSettings["video"]["profile"]; level: string };
  audio?: {
    frames: number;
    sampleRate: number;
    channels: number;
    /** Validated as audio processing evidence before the movie publishes. */
    processingEvidence?: unknown[];
  };
  /** Native font fallback facts, validated before the movie publishes; omitted when clean. */
  textFallbacks?: unknown;
};
export type ProjectMovieRenderer = ProjectRenderSupport & {
  render(
    request: {
      prepared?: PreparedAudioRead | undefined;
      model: import("@yap/composition").ValidatedComposition;
      window: CompositionWindow;
      maxLongEdge: number | null;
      assets: readonly CompositionAssetBinding[];
      fonts: readonly ImmutableAssetBinding[];
      luts: readonly ImmutableAssetBinding[];
      output: string;
      settings: OutputSettings;
    },
    signal: AbortSignal,
  ): Promise<CompositionMovie>;
};
export type PinnedProjectPreview = {
  preparedResourceId?: string | null | undefined;
  projectId: string;
  revisionId: string;
  range: { startUs: number; endUs: number };
  maxLongEdge: number | null;
  settings: OutputSettings;
  implementationId: string;
  retimeImplementationId?: string | undefined;
};
export type ProjectPreviewArtifact = CompositionMovie & PinnedProjectPreview & { cacheId: string };
const optionsSchema = z
  .object({
    preparedResourceId: z.string().min(1).nullable().optional(),
    range: rangeSchema,
    maxLongEdge: z.int().positive().max(8192).nullable().default(null),
    settings: resolvedOutputSettingsSchema,
    implementationId: z.string().min(1),
    retimeImplementationId: z.string().min(1).optional(),
  })
  .strict();

/** Immutable composition admission and publication under the shared queue and disposable cache. */
export class ProjectPreviewInspection {
  constructor(
    private readonly projects: ProjectStore,
    private readonly assets: AssetStore,
    private readonly jobs: JobQueue,
    private readonly cache: DerivedCache,
    private readonly renderer: ProjectMovieRenderer,
    private readonly prepared: PreparedAudioStore,
  ) {
    if (!renderer.implementationId)
      throw new Error("A composition renderer implementation is required");
  }

  capabilities() {
    return projectCapabilities(this.renderer);
  }

  pin(input: ProjectPreviewInput): PinnedProjectPreview {
    return this.admission(input).pinned;
  }
  /** The pinned preview keeps the applied range; a clamp is reported on the request's result. */
  private admission(input: ProjectPreviewInput) {
    if (input.implementationId !== undefined) this.requireImplementation(input.implementationId);
    const plan = this.plan(input);
    let settings: OutputSettings;
    try {
      settings = resolveOutputSettings(input.settings);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new CatalogError(
          "INVALID_PARAMS",
          error.issues.map((issue) => issue.message).join("; "),
        );
      throw error;
    }
    const fps = plan.window.manifest.canvas.fps;
    if (
      settings.video.nonDroppableFrameRate !== null &&
      settings.video.nonDroppableFrameRate > fps.numerator / fps.denominator
    )
      throw new CatalogError(
        "INVALID_PARAMS",
        "Non-droppable frame rate exceeds composition frame rate",
      );
    const retime = plan.retained ? undefined : retimeImplementation(plan.window, this.renderer);
    if (input.retimeImplementationId !== undefined && input.retimeImplementationId !== retime)
      throw new CatalogError(
        "PINNED_IMPLEMENTATION_UNAVAILABLE",
        "Pinned retiming implementation is not available",
        {
          implementationId: input.implementationId ?? this.renderer.implementationId,
          retimeImplementationId: input.retimeImplementationId,
        },
      );
    const pinned: PinnedProjectPreview = {
      projectId: input.projectId,
      revisionId: plan.window.manifest.revisionId,
      range: plan.window.manifest.range,
      maxLongEdge: input.maxLongEdge ?? null,
      settings,
      implementationId: this.renderer.implementationId,
      ...(retime ? { retimeImplementationId: retime } : {}),
      preparedResourceId: plan.retained?.resourceId ?? null,
    };
    return { pinned, issues: plan.issues };
  }
  private identity(pinned: PinnedProjectPreview) {
    const { projectId, revisionId, ...options } = pinned;
    return {
      target: { kind: "project" as const, id: projectId, revisionId },
      artifact: "preview",
      input: JSON.stringify(options),
    };
  }

  /** Native validation finishes before the queue's synchronous catalog admission. */
  async prepare(input: ProjectPreviewInput) {
    const { pinned: snapshot, issues } = this.admission(input);
    const plan = this.plan(snapshot);
    const prior = this.jobs.status(this.identity(snapshot));
    if (!plan.retained && !prior.jobId && !prior.published)
      await validateProjectAudio(this.renderer, plan);
    return {
      snapshot: structuredClone(snapshot),
      submit: (admitted?: () => void) => this.submit(snapshot, plan, issues, admitted),
    };
  }
  async request(input: ProjectPreviewInput) {
    return (await this.prepare(input)).submit();
  }
  /** Waiting export intents may resume only a previously admitted exact dependency. */
  resume(input: PinnedProjectPreview) {
    const pinned = this.pin(input);
    if (!this.jobs.status(this.identity(pinned)).jobId)
      throw new CatalogError("NOT_READY", "Pinned preview dependency has not been admitted", {
        implementationId: pinned.implementationId,
      });
    return this.submit(pinned, this.plan(pinned), []);
  }
  private submit(
    pinned: PinnedProjectPreview,
    plan: ReturnType<ProjectPreviewInspection["plan"]>,
    issues: Issue[],
    admitted?: () => void,
  ) {
    const status = submitCachedDerivative<ProjectPreviewArtifact>(
      this.jobs,
      this.cache,
      this.identity(pinned),
      "heavy",
      {
        deferred: plan.pointerSources.length > 0,
        ...(admitted ? { admitted } : {}),
      },
    );
    return {
      projectId: pinned.projectId,
      revisionId: pinned.revisionId,
      range: structuredClone(pinned.range),
      settings: structuredClone(pinned.settings),
      issues,
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            preview: status.published.value,
          }
        : null,
    };
  }

  async retry(input: ProjectPreviewInput) {
    const prepared = await this.prepare(input);
    const current = prepared.submit();
    if (!current.published)
      for (const selection of this.plan(prepared.snapshot).pointerSources)
        this.renderer.pointers?.retry(selection);
    if (current.jobId) this.jobs.retry(current.jobId);
    return prepared.submit();
  }

  admit(job: Job): ReturnType<JobAdmission> {
    const options = optionsSchema.parse(JSON.parse(job.input));
    this.requireImplementation(options.implementationId);
    if (job.target.kind !== "project" || job.artifact !== "preview")
      throw new CatalogError("UNSUPPORTED_JOB", "Preview admission requires a project job");
    const pinned = this.pin({
      projectId: job.target.id,
      revisionId: job.target.revisionId,
      ...options,
    });
    const plan = this.plan(pinned);
    return this.renderer.pointers?.admit(plan.pointerSources) ?? { state: "ready" };
  }
  private requireImplementation(implementationId: string) {
    if (implementationId !== this.renderer.implementationId)
      throw new CatalogError(
        "PINNED_IMPLEMENTATION_UNAVAILABLE",
        "Pinned preview implementation is not available",
        {
          implementationId,
        },
      );
  }

  private plan(input: ProjectPreviewInput) {
    const composition = projectComposition(this.projects, this.assets, input);
    const retained =
      input.preparedResourceId === null
        ? null
        : this.prepared.resolve(composition, undefined, input.preparedResourceId);
    if (retained) composition.window(input, this.renderer, "video");
    return {
      ...composition.window(input, this.renderer, undefined, retained ? "retained" : "produced"),
      retained,
    };
  }

  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    const options = optionsSchema.safeParse(JSON.parse(job.input));
    if (job.target.kind !== "project" || job.artifact !== "preview" || !options.success)
      throw new CatalogError("UNSUPPORTED_JOB", "Composition preview cannot execute this job");
    this.requireImplementation(options.data.implementationId);
    const pinned = this.pin({
      projectId: job.target.id,
      revisionId: job.target.revisionId,
      ...options.data,
      preparedResourceId: options.data.preparedResourceId ?? null,
    });
    const plan = this.plan(pinned);
    signal.throwIfAborted();
    const range = plan.window.manifest.sampleRange;
    const output = this.cache.reserve({ kind: "project", id: job.target.id });
    let prepared: PreparedAudioRead | undefined;
    try {
      prepared =
        plan.retained && range.end > range.start
          ? this.prepared.open(plan.retained.resourceId, range)
          : undefined;
      const render = () =>
        this.renderer.render(
          {
            ...plan,
            prepared,
            maxLongEdge: options.data.maxLongEdge,
            settings: options.data.settings,
            output: output.path,
          },
          signal,
        );
      const movie = this.renderer.pointers
        ? await this.renderer.pointers.withReady(plan.pointerSources, render)
        : await render();
      signal.throwIfAborted();
      if (
        !isDeepStrictEqual(
          resolvedOutputSettingsSchema.parse(movie.settings),
          options.data.settings,
        )
      )
        throw new CatalogError("INVALID_RESPONSE", "Renderer changed the pinned output settings");
      checkRenderedMovie(movie, {
        file: output.path,
        codec: options.data.settings.video.codec,
        durationUs: options.data.range.endUs - options.data.range.startUs,
        maxLongEdge: options.data.maxLongEdge,
      });
      if (
        options.data.maxLongEdge === null &&
        (movie.width !== plan.window.manifest.canvas.width ||
          movie.height !== plan.window.manifest.canvas.height)
      )
        throw new CatalogError("INVALID_RESPONSE", "Renderer changed the pinned canvas");
      const evidence = audioProcessingEvidenceSchema
        .array()
        .optional()
        .safeParse(movie.audio?.processingEvidence);
      if (!evidence.success)
        throw new CatalogError("INVALID_RESPONSE", "Renderer returned malformed audio evidence");
      const fallbacks = textFallbacksSchema.optional().safeParse(movie.textFallbacks);
      if (!fallbacks.success)
        throw new CatalogError("INVALID_RESPONSE", "Renderer returned malformed text fallbacks");
      // The movie's audio postconditions and font fallbacks are issues on the movie, never a refusal.
      const issues = [
        ...plan.outputIssues,
        ...audioProcessingIssues(evidence.data ?? []),
        ...textFallbackIssues(fallbacks.data, (clipId) => {
          const clip = plan.model.clips.find((candidate) => candidate.clip.id === clipId)?.clip;
          return clip?.source.kind === "text" ? clip.source.font : undefined;
        }),
      ];
      const cached = await this.cache.publish(output.id);
      signal.throwIfAborted();
      if (cached.bytes !== movie.bytes)
        throw new CatalogError("INVALID_RESPONSE", "Preview byte count does not match its file");
      const result: ProjectPreviewArtifact = {
        ...movie,
        ...options.data,
        projectId: job.target.id,
        revisionId: job.target.revisionId,
        cacheId: output.id,
      };
      return { result: JSON.stringify(result), issues };
    } catch (error) {
      this.cache.remove(output.id);
      throw error;
    } finally {
      prepared?.release();
    }
  }
}
