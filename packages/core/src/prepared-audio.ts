import { projectJsonBytes } from "./package-archive.js";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  audioOutputCapabilities,
  executionWindowManifestSchema,
  isMediaClip,
  type ProcessingTap,
  type ExecutionWindowManifest,
  omit,
} from "@yap/composition";
import { AssetStore, type AssetProbe } from "./assets.js";
import { CatalogError, type Catalog } from "./catalog.js";
import { ResourceReferences, resourceKinds, type ResourceReference } from "./references.js";
import type { ProjectStore } from "./projects.js";
import {
  retainedPublicationSchema,
  type JobExecution,
  type ArtifactStatus,
  type RetainedArtifact,
  type JobQueue,
  type StagedJobResult,
} from "./jobs.js";
import {
  compositionMediaInputs,
  projectWindow,
  projectComposition,
  stateSupportIssues,
  validateProjectAudio,
} from "./project-window.js";
import {
  projectAudioReceiptSchema,
  checkProjectAudioResult,
  type ProjectAudioRenderer,
} from "./audio-inspection.js";
import { audioProcessingIssues } from "./audio-measurement.js";
import { fileIdentity, IdentifiedFiles, retainedFileRead, type FileIdentity } from "./files.js";
import { validateAudioWave } from "./audio-wave.js";

type Input = { projectId: string; revisionId?: string; tap?: ProcessingTap | undefined };
export type PreparedAudio = Omit<ReturnType<typeof checkProjectAudioResult>, "file"> & {
  resourceId: string;
  dependencies: ResourceReference[];
  assetId: string;
  identity: FileIdentity;
  sampleRange: { start: number; end: number };
};
function encodePreparedAudioReceipt(value: PreparedAudio) {
  const { bytes, frames, sampleRange, ...rest } = value as any;
  return {
    ...rest,
    sizeBytes: bytes,
    frameCount: frames,
    sampleRange: { startSamples: sampleRange.start, endSamples: sampleRange.end },
  };
}
function decodePreparedAudioReceipt(value: unknown): PreparedAudio {
  const record = value as Record<string, any>;
  if ("bytes" in record || "frames" in record || record.sampleRange?.startSamples === undefined)
    throw new CatalogError("ARTIFACT_CHANGED", "Prepared audio receipt uses an obsolete shape");
  const { sizeBytes, frameCount, sampleRange, ...rest } = record;
  return {
    ...rest,
    bytes: sizeBytes,
    frames: frameCount,
    sampleRange: { start: sampleRange.startSamples, end: sampleRange.endSamples },
  } as PreparedAudio;
}

const portableSample = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const portablePreparedAudioSchema = z.strictObject({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  publication: retainedPublicationSchema.extend({
    input: z.string().refine((value) => Buffer.byteLength(value) <= projectJsonBytes, {
      message: "Prepared recipe exceeds the project JSON budget",
    }),
  }),
  audio: projectAudioReceiptSchema
    .omit({ file: true })
    .extend({
      assetId: z.string().regex(/^[a-f0-9]{64}$/),
      sampleRange: z
        .strictObject({ start: portableSample, end: portableSample })
        .refine((r) => r.end > r.start),
      dependencies: z
        .array(z.strictObject({ kind: z.enum(resourceKinds), id: z.string().min(1) }))
        .max(25000),
    })
    .strict(),
});
export type PortablePreparedAudio = z.infer<typeof portablePreparedAudioSchema>;
export const preparedAudioResource = (projectId: string, attemptId: string) =>
  JSON.stringify([projectId, attemptId]);

function audioDependencies(
  plan: Pick<ReturnType<typeof projectWindow>, "model" | "window">,
): ResourceReference[] {
  const media = compositionMediaInputs(plan.window.manifest);
  const dependencies: ResourceReference[] = [...new Set(media.map((source) => source.assetId))].map(
    (id) => ({
      kind: "asset",
      id,
    }),
  );
  const clips = new Set(media.map((source) => source.clipId));
  const acquisitions = new Set<string>();
  for (const clip of plan.model.document.clips)
    if (isMediaClip(clip) && clips.has(clip.id) && clip.acquisitionId)
      acquisitions.add(clip.acquisitionId);
  for (const id of acquisitions) dependencies.push({ kind: "acquisition", id });
  return dependencies;
}

/**
 * A prepared signal's issues follow from its recipe (state split at support gaps) and its
 * processing evidence, so a stored or adopted publication must carry exactly these.
 */
function preparedAudioIssues(
  recipe: Pick<ExecutionWindowManifest, "state">,
  audio: Pick<PreparedAudio, "processingEvidence">,
) {
  return [...stateSupportIssues(recipe), ...audioProcessingIssues(audio.processingEvidence ?? [])];
}

/** Compare semantics while binding requirements to the publication's original policy. */
function readRecipe(input: string, code: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new CatalogError(code, "Invalid prepared audio recipe");
  }
  const parsed = executionWindowManifestSchema.safeParse(raw);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, raw))
    throw new CatalogError(code, "Unsupported prepared audio recipe");
  if (parsed.data.requirements.some((requirement) => requirement.implementationId === null))
    throw new CatalogError(code, "Prepared audio has unresolved execution requirements");
  return parsed.data;
}
export type PreparedAudioResolution = {
  resourceId: string;
  publication: RetainedArtifact;
  audio: PreparedAudio;
  recipe: ExecutionWindowManifest;
};
function bindRecordedRecipe(
  window: ReturnType<ReturnType<typeof projectComposition>["compiler"]["audioWindow"]>,
  recipe: ExecutionWindowManifest,
) {
  const bound = {
    ...window,
    manifest: {
      ...window.manifest,
      requirements: window.manifest.requirements.map((requirement, index) => ({
        ...requirement,
        implementationId: recipe.requirements[index]?.implementationId ?? null,
      })),
    },
  };
  return recipe.requirements.every((requirement) => requirement.implementationId !== null) &&
    isDeepStrictEqual({ ...recipe, revisionId: window.manifest.revisionId }, bound.manifest)
    ? bound
    : null;
}

/** Durable bytes use AssetStore; the queue alone publishes their recipe and revision binding. */
export class PreparedAudioStore {
  private readonly references: ResourceReferences;
  constructor(
    private readonly owners: {
      catalog: Catalog;
      assets: AssetStore;
      projects: ProjectStore;
      jobs: JobQueue;
      renderer: ProjectAudioRenderer;
      probe: AssetProbe;
      staging: string;
    },
  ) {
    this.references = new ResourceReferences(owners.catalog);
  }
  /** Startup under the same exclusive service lifetime as asset recovery. */
  async recover() {
    await rm(this.owners.staging, { recursive: true, force: true });
    await mkdir(this.owners.staging, { recursive: true, mode: 0o700 });
  }
  private plan(input: Input) {
    return projectWindow(
      this.owners.projects,
      this.owners.assets,
      input,
      this.owners.renderer,
      "audio",
    );
  }
  resolve(
    composition: ReturnType<typeof projectComposition>,
    tap?: ProcessingTap,
    pinned?: string,
  ): PreparedAudioResolution | null {
    const references = this.owners.projects
      .revisionDependencies(composition.projectId, composition.revisionId)
      .filter((reference) => reference.kind === "prepared-audio");
    if (pinned && !references.some((reference) => reference.id === pinned))
      throw new CatalogError("ARTIFACT_CHANGED", "Pinned prepared signal is no longer referenced");
    if (!references.length) return null;
    const window = composition.compiler.audioWindow({
      range: { startUs: 0, endUs: composition.model.durationUs },
      rendition: { sampleRate: 48000, channels: 2 },
      tap: tap ?? { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const candidates: PreparedAudioResolution[] = [];
    for (const reference of references) {
      if (pinned && reference.id !== pinned) continue;
      const publication = this.publication(reference.id);
      const recipe = readRecipe(publication.input, "INVALID_STORAGE");
      if (!bindRecordedRecipe(window, recipe)) continue;
      // A compatible but broken publication must remain visible, even alongside another policy.
      const read = this.open(reference.id);
      try {
        if (!isDeepStrictEqual(read.value.sampleRange, window.manifest.sampleRange))
          throw new CatalogError(
            "INVALID_STORAGE",
            "Prepared output range differs from its recipe",
          );
        if (
          !isDeepStrictEqual(
            this.owners.jobs.issues(publication),
            preparedAudioIssues(recipe, read.value),
          )
        )
          throw new CatalogError(
            "ARTIFACT_CHANGED",
            "Prepared audio issues differ from its recipe and processing evidence",
          );
        candidates.push({ resourceId: reference.id, publication, audio: read.value, recipe });
      } finally {
        read.release();
      }
    }
    if (pinned && !candidates.length)
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Pinned prepared signal no longer matches this revision",
      );
    const equivalent = new Map<string, PreparedAudioResolution>();
    for (const candidate of candidates) {
      const key = JSON.stringify({
        recipe: { ...candidate.recipe, revisionId: composition.revisionId },
        assetId: candidate.audio.assetId,
        sampleRange: candidate.audio.sampleRange,
        dependencies: candidate.audio.dependencies,
        unavailable: candidate.audio.unavailable,
      });
      if (!equivalent.has(key)) equivalent.set(key, candidate);
    }
    if (equivalent.size > 1)
      throw new CatalogError(
        "AMBIGUOUS_PREPARED_AUDIO",
        "Several retained output policies match this revision",
        {
          candidates: candidates.map(({ resourceId, audio }) => ({
            resourceId,
            assetId: audio.assetId,
          })),
        },
      );
    return candidates[0] ?? null;
  }
  async request(input: Input): Promise<ArtifactStatus> {
    const composition = projectComposition(this.owners.projects, this.owners.assets, input);
    const retained = this.resolve(composition, input.tap);
    if (retained)
      return {
        state: "ready",
        jobId: this.owners.jobs.status(retained.publication).jobId,
        reason: null,
        retryable: false,
        published: {
          ...retained.publication,
          issues: this.owners.jobs.issues(retained.publication),
        },
      };
    const plan = composition.window({ tap: input.tap }, this.owners.renderer, "audio");
    const frames = plan.window.manifest.sampleRange.end - plan.window.manifest.sampleRange.start;
    if (frames > audioOutputCapabilities.maximumInternalPCMFrames)
      throw new CatalogError(
        "LIMIT_EXCEEDED",
        "Prepared PCM exceeds the native WAV container limit",
      );
    const identity = {
      target: {
        kind: "project" as const,
        id: input.projectId,
        revisionId: plan.window.manifest.revisionId,
      },
      artifact: "prepared-audio",
      input: JSON.stringify(plan.window.manifest),
    };
    const prior = this.owners.jobs.status(identity);
    if (!prior.jobId && !prior.published) await validateProjectAudio(this.owners.renderer, plan);
    const dependencies = audioDependencies(plan);
    if (!this.owners.jobs.status(identity).published)
      this.owners.jobs.submit({ ...identity, lane: "heavy" }, (job) => {
        for (const kind of resourceKinds)
          this.owners.jobs.retainInputs(
            job.jobId,
            kind,
            dependencies.filter((value) => value.kind === kind).map((value) => value.id),
          );
      });
    return this.owners.jobs.status(identity);
  }
  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    if (job.target.kind !== "project" || job.artifact !== "prepared-audio")
      throw new CatalogError("UNSUPPORTED_JOB", "Prepared audio requires a project revision");
    const plan = this.plan({
      projectId: job.target.id,
      revisionId: job.target.revisionId,
      tap: readRecipe(job.input, "INVALID_STORAGE").tap,
    });
    if (JSON.stringify(plan.window.manifest) !== job.input)
      throw new CatalogError("ARTIFACT_CHANGED", "Prepared audio recipe is no longer available");
    const output = join(this.owners.staging, `${job.attemptId}.wav`);
    let staged: Awaited<ReturnType<AssetStore["stage"]>> | undefined;
    try {
      const { file: renderedFile, ...audio } = checkProjectAudioResult(
        await this.owners.renderer.render({ ...plan, output }, signal),
        plan.window,
        output,
      );
      const sampleRange = plan.window.manifest.sampleRange;
      staged = await this.owners.assets.stage(
        renderedFile,
        { kind: "generated", source: "prepared-audio" },
        this.owners.probe,
        signal,
      );
      if (staged.asset.bytes !== audio.bytes)
        throw new CatalogError(
          "INVALID_NATIVE_RESPONSE",
          "Prepared audio size differs from its receipt",
        );
      const assetId = staged.asset.id;
      const dependencies = this.references
        .dependencies({ kind: "job-input", id: job.jobId })
        .filter((value) => value.kind !== "asset" || value.id !== assetId);
      // Drop the temporary hard link before recording the durable file's local identity.
      await staged.close();
      const file = await open(staged.path, "r");
      let identity: FileIdentity;
      try {
        identity = fileIdentity(await file.stat({ bigint: true }));
      } finally {
        await file.close();
      }
      const value: PreparedAudio = {
        ...audio,
        dependencies,
        resourceId: preparedAudioResource(job.target.id, job.attemptId),
        assetId,
        bytes: audio.bytes,
        identity,
        sampleRange,
      };
      const publication = staged;
      return {
        result: JSON.stringify(encodePreparedAudioReceipt(value)),
        issues: preparedAudioIssues(plan.window.manifest, value),
        publish: () => {
          publication.publish();
          this.retain(value, plan.window.manifest.revisionId);
          return undefined;
        },
        close: async () => {
          try {
            await publication.close();
          } finally {
            await rm(output, { force: true });
          }
        },
      };
    } catch (error) {
      try {
        await staged?.close();
      } finally {
        await rm(output, { force: true });
      }
      throw error;
    }
  }
  private retain(value: PreparedAudio, revisionId: string) {
    const owner = { kind: "revision" as const, id: revisionId };
    this.references.retain("prepared-audio", owner, [value.resourceId]);
    this.owners.assets.retain(owner, [value.assetId]);
    for (const kind of resourceKinds)
      this.references.retain(
        kind,
        owner,
        value.dependencies
          .filter((reference) => reference.kind === kind)
          .map((reference) => reference.id),
      );
  }
  private publication(resourceId: string) {
    let identity: unknown;
    try {
      identity = JSON.parse(resourceId);
    } catch {
      identity = null;
    }
    const parsed = z.tuple([z.string().min(1), z.string().min(1)]).safeParse(identity);
    if (!parsed.success)
      throw new CatalogError("INVALID_PARAMS", "Invalid prepared audio identity");
    const [projectId, attemptId] = parsed.data;
    const publication = this.owners.jobs.retainedArtifact(
      { kind: "project", id: projectId },
      "prepared-audio",
      attemptId,
    );
    if (!publication)
      throw new CatalogError("NOT_FOUND", "Prepared audio publication is unavailable");
    return publication;
  }
  portable(resourceId: string): PortablePreparedAudio {
    const publication = this.publication(resourceId);
    if (publication.target.kind !== "project")
      throw new CatalogError("INVALID_STORAGE", "Prepared audio has no project owner");
    const read = this.open(resourceId);
    try {
      const audio = omit(read.value, "resourceId", "identity");
      return portablePreparedAudioSchema.parse({
        projectId: publication.target.id,
        revisionId: publication.target.revisionId,
        publication: {
          generation: publication.generation,
          attemptId: publication.attemptId,
          input: publication.input,
        },
        audio,
      });
    } finally {
      read.release();
    }
  }
  /** Validate copied bytes and original execution meaning before the shared publication transaction. */
  async stagePortable(
    input: unknown,
    composition: ReturnType<typeof projectComposition>,
    path: string,
    reference: (value: ResourceReference) => ResourceReference,
    signal: AbortSignal,
  ) {
    const parsed = portablePreparedAudioSchema.safeParse(input);
    if (!parsed.success)
      throw new CatalogError("INVALID_PACKAGE", "Invalid prepared audio publication");
    const portable = parsed.data;
    const recipe = readRecipe(portable.publication.input, "INVALID_PACKAGE");
    const window = composition.compiler.audioWindow({
      range: { startUs: 0, endUs: composition.model.durationUs },
      rendition: { sampleRate: 48000, channels: 2 },
      tap: recipe.tap,
    });
    const bound = bindRecordedRecipe(window, recipe);
    if (
      recipe.revisionId !== portable.revisionId ||
      !bound ||
      !isDeepStrictEqual(portable.audio.sampleRange, window.manifest.sampleRange)
    ) {
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Prepared audio recipe differs from its pinned revision",
      );
    }
    const dependencies = new Set(
      portable.audio.dependencies.map((value) => JSON.stringify([value.kind, value.id])),
    );
    const needed = audioDependencies({ model: composition.model, window });
    if (
      dependencies.size !== portable.audio.dependencies.length ||
      needed.some(
        (value) =>
          !(value.kind === "asset" && value.id === portable.audio.assetId) &&
          !dependencies.has(JSON.stringify([value.kind, value.id])),
      )
    )
      throw new CatalogError("INVALID_PACKAGE", "Prepared audio omitted an upstream dependency");
    signal.throwIfAborted();
    checkProjectAudioResult({ ...portable.audio, file: path }, bound, path);
    // Issues are not carried in the package: the recipient derives them from what it carries.
    const issues = preparedAudioIssues(recipe, portable.audio);
    const file = await open(path, "r");
    let identity: FileIdentity;
    try {
      identity = fileIdentity(await file.stat({ bigint: true }));
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    const value: PreparedAudio = {
      ...portable.audio,
      identity,
      resourceId: preparedAudioResource(composition.projectId, portable.publication.attemptId),
      dependencies: portable.audio.dependencies.map(reference),
    };
    return {
      resourceId: value.resourceId,
      publish: () => {
        signal.throwIfAborted();
        this.owners.jobs.adoptArtifact(
          {
            ...portable.publication,
            target: {
              kind: "project",
              id: composition.projectId,
              revisionId: composition.revisionId,
            },
            artifact: "prepared-audio",
            input: JSON.stringify({ ...recipe, revisionId: composition.revisionId }),
            result: JSON.stringify(encodePreparedAudioReceipt(value)),
          },
          issues,
        );
        this.retain(value, composition.revisionId);
      },
    };
  }
  /** Bounded PCM view of an already published result; never invokes the renderer or model. */
  open(resourceId: string, range?: { start: number; end: number }) {
    const publication = this.publication(resourceId);
    const value = decodePreparedAudioReceipt(JSON.parse(publication.result));
    const selection = range ?? value.sampleRange;
    if (
      !Number.isSafeInteger(selection.start) ||
      !Number.isSafeInteger(selection.end) ||
      selection.start < value.sampleRange.start ||
      selection.end > value.sampleRange.end ||
      selection.end <= selection.start
    )
      throw new CatalogError("INVALID_RANGE", "Requested PCM is outside the prepared signal");
    const path = this.owners.assets.path(value.assetId);
    const files = new IdentifiedFiles(dirname(path), [
      { path: basename(path), bytes: value.bytes, identity: value.identity },
    ]);
    try {
      const file = files.open(basename(path));
      const source = retainedFileRead(file, value.bytes);
      const { dataOffset } = validateAudioWave(source, value);
      const frameBytes = value.channels * 4;
      const offset = dataOffset + (selection.start - value.sampleRange.start) * frameBytes;
      const bytes = (selection.end - selection.start) * frameBytes;
      return {
        value,
        fd: file.fd,
        dataOffset,
        sampleRange: selection,
        bytes,
        read(buffer: Uint8Array, position: number) {
          if (!Number.isSafeInteger(position) || position < 0 || position > bytes)
            throw new CatalogError("INVALID_RANGE", "PCM read is outside the excerpt");
          return source.read(
            buffer.subarray(0, Math.min(buffer.length, bytes - position)),
            offset + position,
          );
        },
        release: () => files.close(),
      };
    } catch (error) {
      files.close();
      throw error;
    }
  }
}

export type PreparedAudioRead = ReturnType<PreparedAudioStore["open"]>;
