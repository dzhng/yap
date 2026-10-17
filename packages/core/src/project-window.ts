import type { SignedTimeValue } from "@yap/composition";
import {
  admitReadRange,
  createCompiler,
  captionSidecar,
  type CaptionSidecarRequest,
  documentAssetIds,
  isMediaClip,
  isStatefulProcessor,
  processingCapabilities,
  requireWindowReady,
  validateComposition,
  type ExecutionWindowManifest,
  type WireRange,
  type Issue,
  type ProcessingTap,
  type ProcessorImplementations,
  type SelectionRange,
} from "@yap/composition";
import { AssetStore, compositionAsset } from "./assets.js";
import { ProjectStore, type ProjectRevision } from "./projects.js";
import { CatalogError } from "./catalog.js";
import type { PointerPreparation } from "./pointer-preparation.js";
import { compositionPointerSources } from "./composition-pointer.js";
export type ProjectRenderSupport = {
  implementationId: string;
  sdrCorrection?: string;
  lut?: string;
  processors?: ProcessorImplementations;
  rnnoise?: string;
  retime?: string;
  validateAudio?: (request: AudioWindowInput) => Promise<void>;
  pointers?: PointerPreparation;
};

export type CompositionWindow = ReturnType<ReturnType<typeof createCompiler>["window"]>;
export type ImmutableAssetBinding = { assetId: string; path: string };
export type CompositionAssetBinding = {
  assetId: string;
  streamId: string;
  path: string;
  originUs: SignedTimeValue;
};

export type AudioWindowInput = {
  window: CompositionWindow;
  assets: readonly CompositionAssetBinding[];
};

export function retimeImplementation(window: CompositionWindow, support: ProjectRenderSupport) {
  return window.manifest.requirements.some((requirement) => requirement.kind === "retime")
    ? support.retime
    : undefined;
}

/** Native owns physical source intersections and recipe-specific count admission. */
export async function validateProjectAudio(
  support: ProjectRenderSupport,
  request: AudioWindowInput,
) {
  const retime = request.window.manifest.requirements.some(
    (requirement) => requirement.kind === "retime",
  );
  const externalState = request.window.manifest.state?.domains.some(
    (domain) => domain.recipe.type !== "rnnoise",
  );
  if (!retime && !externalState) return;
  if (!support.validateAudio || (retime && !support.retime))
    throw new CatalogError("NOT_READY", "Native audio input admission is unavailable", {});
  await support.validateAudio(request);
}

/** Every file consumed by the requested output or a selected DSP prerequisite. */
export function compositionMediaInputs(manifest: CompositionWindow["manifest"]) {
  const inputs = new Map(
    manifest.sources.map(({ clipId, assetId, streamId }) => [
      clipId,
      { clipId, assetId, streamId },
    ]),
  );
  for (const { clip } of manifest.state?.inputs ?? [])
    if (isMediaClip(clip))
      inputs.set(clip.id, { clipId: clip.id, assetId: clip.assetId, streamId: clip.streamId });
  return [...inputs.values()];
}
/** A layout state processing can't verify is ambiguous input; source gaps split state instead. */
function requireStateInputsReady(manifest: CompositionWindow["manifest"]) {
  if (!manifest.state) return;
  const issues: Record<string, unknown>[] = [];
  for (const input of manifest.state.inputs) {
    if (
      isMediaClip(input.clip) &&
      (![1, 2].includes(input.channels ?? 0) || input.sampleRate === undefined)
    )
      issues.push({
        kind: "unverified-audio-channels",
        clipId: input.clip.id,
        channels: input.channels ?? null,
        sampleRate: input.sampleRate ?? null,
      });
  }
  for (const node of manifest.state.nodes)
    for (const step of node.steps)
      if (step.enabled && step.processor.type !== "gain" && !isStatefulProcessor(step.processor))
        issues.push({
          kind: "unverified-channel-prefix",
          target: node.target,
          stepId: step.id,
          processor: step.processor.type,
        });
  if (issues.length)
    throw new CatalogError(
      "PREREQUISITE_MISSING",
      "State processing requires verified mono or stereo input",
      {
        stateInputs: issues,
      },
    );
}

/**
 * One `support-gap` per unavailable span that split the selected state, naming the split steps.
 * Derived from the window's recipe alone, so a retained or packaged recipe re-derives its issues.
 */
export function stateSupportIssues(manifest: Pick<ExecutionWindowManifest, "state">): Issue[] {
  const gaps = new Map<
    string,
    { clipId: string; unavailable: SelectionRange; stepIds: string[] }
  >();
  for (const domain of manifest.state?.domains ?? [])
    for (const { clipId, range } of domain.supportGaps ?? []) {
      const key = JSON.stringify([clipId, range]);
      const gap = gaps.get(key) ?? { clipId, unavailable: range, stepIds: [] };
      for (const { stepId } of domain.members)
        if (!gap.stepIds.includes(stepId)) gap.stepIds.push(stepId);
      gaps.set(key, gap);
    }
  return [...gaps.values()].map((evidence) => ({
    code: "support-gap",
    message:
      "Source support is unavailable here, so stateful processing was split: each side was processed as its own state domain",
    at: { range: evidence.unavailable },
    evidence: { ...evidence, stepIds: evidence.stepIds.sort() },
  }));
}

const implementations = (support: ProjectRenderSupport): ProcessorImplementations => ({
  ...(support.lut ? { lut: support.lut } : {}),
  ...(support.sdrCorrection ? { "sdr-correction": support.sdrCorrection } : {}),
  geometry: support.implementationId,
  "motion-blur": support.implementationId,
  opacity: support.implementationId,
  blend: support.implementationId,
  gain: support.implementationId,
  ...(support.rnnoise ? { rnnoise: support.rnnoise } : {}),
  ...(support.pointers ? { pointer: support.implementationId } : {}),
  ...support.processors,
});
export const projectCapabilities = (support: ProjectRenderSupport) =>
  processingCapabilities(implementations(support));

/** One immutable revision context owns model validation, compiler timing and source bindings. */
export function projectComposition(
  projects: ProjectStore,
  assets: AssetStore,
  input: { projectId: string; revisionId?: string | undefined; cursorTrailUs?: number | undefined },
) {
  const revision = projects.revision(input.projectId, input.revisionId);
  if (input.cursorTrailUs === undefined)
    return projectCompositionFromRevision(revision, assets, projects.contexts(revision.document));
  const pointerIds = new Set(
    revision.document.processing
      .filter(
        (
          stack,
        ): stack is (typeof revision.document.processing)[number] & {
          target: { kind: "clip"; id: string };
        } => stack.target.kind === "clip",
      )
      .filter((stack) =>
        stack.steps.some((step) => step.enabled && step.processor.type === "pointer"),
      )
      .map((stack) => stack.target.id),
  );
  const trailUs = input.cursorTrailUs;
  const temporary = {
    ...revision.document,
    processing: [
      ...revision.document.processing.map((stack) =>
        stack.target.kind !== "clip" || !pointerIds.has(stack.target.id)
          ? stack
          : {
              ...stack,
              steps: stack.steps.map((step) =>
                step.enabled && step.processor.type === "pointer"
                  ? { ...step, processor: { type: "pointer" as const, trailUs } }
                  : step,
              ),
            },
      ),
      ...revision.document.clips
        .filter((clip) => clip.source.kind === "range" || clip.source.kind === "hold")
        .filter((clip) => !pointerIds.has(clip.id))
        .map((clip) => ({
          target: { kind: "clip" as const, id: clip.id },
          steps: [
            {
              id: `review-pointer-${clip.id}`,
              enabled: true,
              processor: { type: "pointer" as const, trailUs },
            },
          ],
        })),
    ],
  } as typeof revision.document;
  return projectCompositionFromRevision(
    { ...revision, document: temporary },
    assets,
    projects.contexts(temporary),
  );
}

/**
 * A project read's range is clamped to the pinned project, with `range-clamped`; one with no part
 * inside it refuses. An omitted range is the whole project.
 */
export function admitProjectRange<Range extends WireRange = { startUs: number; endUs: number }>(
  durationUs: number,
  range: Range | undefined,
) {
  const admitted = admitReadRange(range ?? { startUs: 0, endUs: durationUs }, {
    startUs: 0,
    endUs: durationUs,
  });
  // The applied bounds are the requested ones or the project's whole microseconds.
  return { range: admitted.range as Range, issues: admitted.issues };
}

/**
 * Evidence reads enumerate what a project holds, so an empty project reads as 0..0 with no issue
 * when the caller omits the range. `stored` marks a range a continuation re-reads from its own
 * query, which may be that 0..0. A range the caller states must still be a nonempty part.
 */
export function admitProjectEvidenceRange(
  durationUs: number,
  range: { startUs: number; endUs: number } | undefined,
  stored: boolean,
) {
  return durationUs === 0 &&
    (range === undefined || (stored && range.startUs === 0 && range.endUs === 0))
    ? { range: { startUs: 0, endUs: 0 }, issues: [] }
    : admitProjectRange(durationUs, range);
}

/** Staged and catalog revisions share compilation; file publication is not a read prerequisite. */
export function projectCompositionFromRevision(
  revision: ProjectRevision,
  assets: Pick<AssetStore, "get" | "path">,
  contexts: Parameters<typeof validateComposition>[2],
) {
  const ids = documentAssetIds(revision.document);
  const metadata = new Map(ids.map((id) => [id, assets.get(id)]));
  const model = validateComposition(
    revision.document,
    [...metadata.values()].map(compositionAsset),
    contexts,
  );
  const compiler = createCompiler(model, revision.id);
  return {
    projectId: revision.projectId,
    revisionId: revision.id,
    model,
    compiler,
    window(
      input: {
        range?: { startUs: number; endUs: number } | undefined;
        tap?: ProcessingTap | undefined;
      },
      support: ProjectRenderSupport,
      component?: "audio" | "video",
      admission: "produced" | "retained" = "produced",
    ) {
      const admitted = admitProjectRange(model.durationUs, input.range);
      const window = (
        component === "audio"
          ? compiler.audioWindow
          : component === "video"
            ? compiler.videoWindow
            : compiler.window
      )({
        range: admitted.range,
        rendition: { sampleRate: 48000, channels: 2 },
        tap: input.tap ?? { target: { kind: "output" }, point: { kind: "processed" } },
      });
      const requirements = window.manifest.requirements.map((requirement) => ({
        ...requirement,
        implementationId:
          requirement.kind === "executor"
            ? support.implementationId
            : requirement.kind === "processor"
              ? (implementations(support)[requirement.processor.type] ?? null)
              : requirement.kind === "retime"
                ? (support.retime ?? null)
                : null,
      }));
      const bound = { ...window, manifest: { ...window.manifest, requirements } };
      if (admission === "produced") {
        requireStateInputsReady(bound.manifest);
        requireWindowReady(bound.manifest);
      }
      const bindings = new Map<string, CompositionAssetBinding>();
      for (const source of compositionMediaInputs(bound.manifest)) {
        const asset = metadata.get(source.assetId)!;
        const key = JSON.stringify([asset.id, source.streamId]);
        if (bindings.has(key)) continue;
        bindings.set(key, {
          assetId: asset.id,
          streamId: source.streamId,
          path: assets.path(asset.id),
          originUs: asset.originUs,
        });
      }
      return {
        model,
        /** Issues of the request itself, such as a clamped range. */
        issues: admitted.issues,
        /** Issues of the output this window produces; its producer publishes them with it. */
        outputIssues: stateSupportIssues(bound.manifest),
        pointerSources: compositionPointerSources({
          model,
          compiler,
          processing: bound.manifest.processing,
          range: bound.manifest.range,
        }),
        window: bound,
        assets: [...bindings.values()],
        luts: bound.manifest.luts.map((assetId) => ({ assetId, path: assets.path(assetId) })),
        fonts: [...new Set(bound.manifest.fonts.map((font) => font.assetId))].map((assetId) => ({
          assetId,
          path: assets.path(assetId),
        })),
        durationUs: model.durationUs,
        frameBoundary: compiler.frameBoundary,
      };
    },
  };
}

/** Preview and media inspection resolve the same immutable dependencies and execution requirements. */
export function projectWindow(
  projects: ProjectStore,
  assets: AssetStore,
  input: {
    projectId: string;
    revisionId?: string | undefined;
    range?: { startUs: number; endUs: number } | undefined;
    tap?: ProcessingTap | undefined;
    cursorTrailUs?: number | undefined;
  },
  support: ProjectRenderSupport,
  component?: "audio" | "video",
) {
  return projectComposition(projects, assets, input).window(input, support, component);
}

/** Sidecar intent freezes displayed text and exact placement support before asynchronous publication. */
export function projectCaptionSidecar(
  projects: ProjectStore,
  assets: AssetStore,
  input: CaptionSidecarRequest & { projectId: string; revisionId: string },
) {
  const context = projectComposition(projects, assets, input);
  const placementIds = [...input.placementIds].sort();
  return {
    projectId: context.projectId,
    revisionId: context.revisionId,
    placementIds,
    ...captionSidecar(context.model, { kind: input.kind, placementIds }),
  };
}
export type PinnedCaptionSidecar = ReturnType<typeof projectCaptionSidecar>;
