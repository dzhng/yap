import { signedTimeValueSchema } from "@yap/composition";
import { z } from "zod";
import { timeValueSchema } from "@yap/composition";
import { sourceSceneClockSchema } from "./source-scene-chunks.js";
import { isDeepStrictEqual } from "node:util";
import { isMediaClip } from "@yap/composition";
import { CatalogError } from "./catalog.js";
import { compositionPointerSources } from "./composition-pointer.js";
import { projectComposition, type ProjectRenderSupport } from "./project-window.js";
import {
  projectPictureOptionsSchema,
  retainedProjectFrameSchema,
  validateRetainedProjectFrameReceipt,
  validatePictureObservations,
  validateFaceObservations,
  type ProjectFrameArtifact,
  type ProjectFrameInput,
} from "./frame-inspection.js";
import {
  sourceSceneDescriptor,
  portableSceneMetadataSchema,
  type SceneEvidenceMetadata,
  type SceneEvidenceStore,
} from "./scene-evidence.js";
import { selectSource, sourceSelectionKey, type SourceSelection } from "./source-selection.js";
import { projectIndexPolicy, type ProjectIndexCandidate } from "./project-index-selection.js";
import type { IndexDomain } from "./screenshot-index.js";
import type { TimeRange } from "./presentation-time.js";

export type ProjectIndexIdentity = Pick<
  ProjectFrameArtifact,
  | "projectId"
  | "revisionId"
  | "tap"
  | "implementationId"
  | "maxLongEdge"
  | "observationRequest"
  | "faceObservationRequest"
> & { generation: string; selectionPolicy: string; scenes: SceneEvidenceMetadata[] };
export type ProjectIndexCoverage = { project: TimeRange } & (
  | { ordinal: number; equality: "sampled" }
  | { ordinal: null; equality: "unproven" }
);
export type ProjectIndexRecords = {
  identity: ProjectIndexIdentity;
  candidate: ProjectIndexCandidate;
  frame: z.infer<typeof retainedProjectFrameSchema>;
  coverage: ProjectIndexCoverage;
};

const portableTime = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const portableRange = z
  .strictObject({ startUs: portableTime, endUs: portableTime })
  .refine((r) => r.endUs > r.startUs);
export const portableProjectIndexMetadataSchema = projectPictureOptionsSchema
  .extend({
    projectId: z.string().min(1),
    revisionId: z.string().min(1),
    generation: z.string().min(1).max(256),
    selectionPolicy: z.literal(projectIndexPolicy.id),
    scenes: z.array(portableSceneMetadataSchema).max(25000),
    durationUs: portableTime,
    candidateCount: portableTime.max(25000),
    coverageCount: portableTime.max(25000),
    sizeBytes: portableTime,
  })
  .strict();
export const portableProjectIndexRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("entry"),
    candidate: z.strictObject({
      ordinal: portableTime,
      index: portableTime,
      sampleAtUs: portableTime,
      visibleRange: portableRange,
      reasons: z
        .array(
          z.union([
            z.strictObject({
              kind: z.literal("scene"),
              clipId: z.string().min(1),
              generation: z.string().min(1),
              observedSourceUs: portableTime,
              projectAtUs: timeValueSchema,
              side: z.enum(["before", "after"]),
              sample: sourceSceneClockSchema,
              originUs: signedTimeValueSchema,
            }),
            z.strictObject({
              kind: z.enum(["first", "last", "coverage"]),
              projectAtUs: timeValueSchema,
            }),
            z.strictObject({
              kind: z.literal("processing"),
              projectAtUs: timeValueSchema,
              side: z.enum(["before", "after"]),
            }),
            z.strictObject({
              kind: z.enum(["clip", "availability"]),
              clipId: z.string().min(1),
              edge: z.enum(["start", "end"]),
              projectAtUs: timeValueSchema,
              side: z.enum(["before", "after"]),
            }),
          ]),
        )
        .max(100000),
    }),
    frame: retainedProjectFrameSchema,
  }),
  z.strictObject({
    kind: z.literal("coverage"),
    coverage: z.union([
      z.strictObject({
        project: portableRange,
        ordinal: portableTime,
        equality: z.literal("sampled"),
      }),
      z.strictObject({
        project: portableRange,
        ordinal: z.null(),
        equality: z.literal("unproven"),
      }),
    ]),
  }),
]);

/** Empty targets validate their real processing scope without a synthetic render window. */
export function projectIndexPlan(
  composition: ReturnType<typeof projectComposition>,
  input: Pick<ProjectFrameInput, "tap" | "maxLongEdge" | "observations" | "faceObservations">,
  support: ProjectRenderSupport,
  admission: "produced" | "retained" = "produced",
) {
  const parsed = projectPictureOptionsSchema.safeParse({
    tap: input.tap ?? { target: { kind: "output" }, point: { kind: "processed" } },
    maxLongEdge: input.maxLongEdge ?? 1600,
    ...(input.observations === undefined ? {} : { observationRequest: input.observations }),
    ...(input.faceObservations === undefined
      ? {}
      : { faceObservationRequest: input.faceObservations }),
    implementationId: support.implementationId,
  });
  if (!parsed.success) throw new CatalogError("INVALID_PARAMS", "Invalid project picture options");
  const { model, compiler } = composition;
  const processing = model.durationUs
    ? composition.window({ tap: parsed.data.tap }, support, "video", admission).window.manifest
        .processing
    : compiler.tapPlan(parsed.data.tap, "video");
  const selected = new Set(
    processing.flatMap((node) => (node.target.kind === "clip" ? [node.target.id] : [])),
  );
  const bindings = new Map<string, SourceSelection>();
  for (const value of model.clips) {
    const clip = value.clip;
    if (
      !selected.has(clip.id) ||
      !isMediaClip(clip) ||
      clip.source.kind !== "range" ||
      value.stream?.kind !== "video" ||
      !value.available.length
    )
      continue;
    const selection = {
      assetId: clip.assetId,
      streamId: clip.streamId,
      ...(clip.acquisitionId === undefined ? {} : { acquisitionId: clip.acquisitionId }),
    };
    bindings.set(sourceSelectionKey(selection), selection);
  }
  return {
    identity: {
      projectId: composition.projectId,
      revisionId: composition.revisionId,
      ...parsed.data,
      selectionPolicy: projectIndexPolicy.id,
    },
    model,
    compiler,
    processing,
    pointerSources: compositionPointerSources({
      model,
      compiler,
      processing,
      range: { startUs: 0, endUs: model.durationUs },
    }),
    sources: [...bindings.values()],
  };
}
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}

/** Retained pixels keep their admitted identities even after their source analysis is reclaimed. */
export function projectIndexDomain(
  read: {
    composition(identity: ProjectIndexIdentity): ReturnType<typeof projectComposition>;
    source(selection: SourceSelection): ReturnType<typeof selectSource>;
    scenes: Pick<SceneEvidenceStore, "metadata">;
    isDeleting(projectId: string): boolean;
  },
  support: ProjectRenderSupport,
): IndexDomain<ProjectIndexRecords> {
  // One write context bounds residency and avoids rebuilding a full revision for every appended PNG.
  let active:
    | {
        key: string;
        composition: ReturnType<typeof projectComposition>;
        plan: ReturnType<typeof projectIndexPlan>;
        admission: "produced" | "retained";
      }
    | undefined;
  function resolve(
    identity: ProjectIndexIdentity,
    admission: "produced" | "retained" = active?.admission ?? "produced",
  ) {
    const key = JSON.stringify([
      identity.projectId,
      identity.revisionId,
      identity.tap,
      identity.maxLongEdge,
      identity.observationRequest,
      identity.faceObservationRequest,
      identity.implementationId,
    ]);
    if (active?.key !== key || active.admission !== admission) {
      const composition = read.composition(identity);
      active = {
        key,
        composition,
        admission,
        plan: projectIndexPlan(
          composition,
          {
            ...identity,
            observations: identity.observationRequest,
            faceObservations: identity.faceObservationRequest,
          },
          {
            ...support,
            implementationId: identity.implementationId,
          },
          admission,
        ),
      };
    }
    return active;
  }
  return {
    owner: (identity) => ({ kind: "project", id: identity.projectId }),
    pin: (identity) => ({
      projectId: identity.projectId,
      revisionId: identity.revisionId,
      generation: identity.generation,
      tap: identity.tap,
      implementationId: identity.implementationId,
      maxLongEdge: identity.maxLongEdge,
      ...(identity.observationRequest === undefined
        ? {}
        : { observationRequest: identity.observationRequest }),
      ...(identity.faceObservationRequest === undefined
        ? {}
        : { faceObservationRequest: identity.faceObservationRequest }),
      selectionPolicy: identity.selectionPolicy,
      scenes: identity.scenes,
    }),
    begin(identity, admission) {
      if (admission === "produced" && identity.implementationId !== support.implementationId)
        throw new CatalogError("NOT_READY", "Pinned picture renderer is unavailable", {});
      if (!identity.generation || identity.selectionPolicy !== projectIndexPolicy.id)
        invalid("Project index selection identity is unavailable");
      const { plan } = resolve(identity, admission);
      const bindings = new Map(
        plan.sources.map((selection) => [sourceSelectionKey(selection), selection]),
      );
      const seen = new Set<string>();
      for (const dependency of identity.scenes) {
        if (dependency.owner.kind !== "asset" || dependency.source.kind !== "asset")
          invalid("Project scenes require a selected video source");
        const selection = {
          assetId: dependency.owner.id,
          streamId: dependency.source.streamId,
          ...(dependency.source.acquisitionId === undefined
            ? {}
            : { acquisitionId: dependency.source.acquisitionId }),
        };
        const key = sourceSelectionKey(selection);
        if (seen.has(key) || !bindings.has(key))
          invalid("Project index scene dependency is duplicated or outside its tap");
        seen.add(key);
        const retained = read.scenes.metadata(dependency);
        if (
          !isDeepStrictEqual(retained, dependency) ||
          !isDeepStrictEqual(dependency.source, sourceSceneDescriptor(read.source(selection)))
        )
          invalid("Project index scenes differ from their pinned source");
      }
      return plan.model.durationUs;
    },
    candidate(identity, candidate, frame, path, previous) {
      const { composition, plan, admission } = resolve(identity);
      const expected = plan.compiler.frameBoundary(candidate.sampleAtUs).after;
      if (
        !expected ||
        !isDeepStrictEqual(expected, {
          index: candidate.index,
          sampleAtUs: candidate.sampleAtUs,
          visibleRange: candidate.visibleRange,
        }) ||
        (previous && previous.index >= candidate.index)
      )
        invalid("Project index candidates must be distinct globally phased pictures in order");
      validatePictureObservations(frame, identity.observationRequest);
      validateFaceObservations(frame, identity.faceObservationRequest);
      if (
        frame.projectId !== identity.projectId ||
        frame.revisionId !== identity.revisionId ||
        frame.implementationId !== identity.implementationId ||
        frame.maxLongEdge !== identity.maxLongEdge ||
        !isDeepStrictEqual(frame.observationRequest, identity.observationRequest) ||
        !isDeepStrictEqual(frame.faceObservationRequest, identity.faceObservationRequest) ||
        !isDeepStrictEqual(frame.tap, identity.tap) ||
        frame.atUs !== candidate.sampleAtUs
      )
        invalid("Project index picture belongs to another request");
      validateRetainedProjectFrameReceipt(
        frame,
        composition.window(
          {
            range: { startUs: candidate.sampleAtUs, endUs: candidate.sampleAtUs + 1 },
            tap: identity.tap,
          },
          { ...support, implementationId: identity.implementationId },
          "video",
          admission,
        ),
        path,
        identity.maxLongEdge,
      );
    },
    coverage({ candidate, coverage }) {
      if (coverage.equality === "sampled") {
        if (
          !candidate ||
          coverage.ordinal !== candidate.ordinal ||
          !isDeepStrictEqual(coverage.project, candidate.visibleRange)
        )
          invalid("Sampled project coverage requires the delivered picture's complete visibility");
      } else if (coverage.ordinal !== null || candidate)
        invalid("Unproven project coverage cannot name a sampled picture");
      return coverage.project;
    },
    merge(before, next) {
      return before.equality === "unproven" &&
        next.equality === "unproven" &&
        before.project.endUs === next.project.startUs
        ? { ...before, project: { startUs: before.project.startUs, endUs: next.project.endUs } }
        : null;
    },
    finishEntry(coverageCount) {
      if (coverageCount !== 1)
        invalid("Each delivered project picture requires one complete sampled coverage interval");
    },
    finish(identity, candidateCount) {
      const { plan } = resolve(identity);
      if (plan.model.durationUs && !candidateCount)
        invalid("A nonempty project index requires a delivered picture");
      active = undefined;
    },
    isDeleting: (owner) => owner.kind === "project" && read.isDeleting(owner.id),
    retainedFrame: retainedProjectFrameSchema,
  };
}
