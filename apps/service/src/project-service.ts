import { verifyJoin } from "./join-verification.js";
import { AssetConversionJobs, assetConversionRuntime } from "./asset-conversion.js";
import { UpdateAdmission } from "./update-admission.js";
import { LibraryDeletion, type DeletionFault } from "./library-deletion.js";
import { recordingRetirement } from "./recording-retirement.js";
import { projectRetirement } from "./project-retirement.js";
import { assetRetirement } from "./asset-retirement.js";
import { acquisitionRetirement } from "./acquisition-retirement.js";
import { CaptureCleanup } from "./capture-cleanup.js";
import { ManagedStorage } from "@yap/core/storage";
import { filteredPage, pageCursor, pageEnvelope, pageFilters } from "@yap/core/page-cursor";

import { VoiceGenerationJobs } from "@yap/core/voice-generation";
import { voiceRenderer } from "./voice.js";
import { AudioExtraction } from "@yap/core/audio-extraction";
import { RenderedSpeech } from "@yap/core/rendered-speech";
import { assetProbe } from "./media-probe.js";
import { sourceExporter } from "./source-export.js";
import { PreparedAudioStore } from "@yap/core/prepared-audio";
import { admitProjectRange, projectComposition } from "@yap/core/project-window";
import { selectSource } from "@yap/core/source-selection";
import {
  outputCapabilities,
  audioOutputCapabilities,
  createSourceRangeProjection,
  omit,
} from "@yap/composition";
import { ProjectPackages } from "./project-packages.js";
import { writeFile } from "node:fs/promises";
import { AcousticInspection } from "@yap/core/acoustic-inspection";
import { MediaFrameInspection } from "@yap/core/frame-inspection";
import { CaptureSourceRead } from "@yap/core/capture-source-read";
import { SourceEvents } from "@yap/core/source-events";
import { SourceSceneRead } from "@yap/core/scene-source-read";
import { SceneEvidenceStore, assetSceneOwner } from "@yap/core/scene-evidence";
import { IndexProcessing } from "@yap/core/index-processing";
import { ScreenshotIndexStore } from "@yap/core/screenshot-index";
import { sourceIndexDomain, type SourceIndexRecords } from "@yap/core/source-index";
import { projectIndexDomain, type ProjectIndexRecords } from "@yap/core/project-index";
import { SceneProcessing } from "@yap/core/scene-processing";
import type { SourceVisualObservations } from "@yap/core/source-scenes";
import { MediaAudioInspection } from "@yap/core/audio-inspection";
import { ProjectEvidenceInspection } from "@yap/core/project-evidence";
import { Models } from "@yap/core/models";
import { createPresets, type PresetsOptions } from "@yap/core/presets";
import { PresetRefresh } from "@yap/core/preset-refresh";
import { remoteSource, type RemoteOptions } from "@yap/core/preset-remote";
import { runtimeMaterializer } from "./runtime-materialization.js";
import {
  TranscriptStore,
  publicTranscriptMetadata,
  type SpeechTranscriptionReceipt,
} from "@yap/core/transcript";
import { TranscriptProcessing, assetTranscriptOwner } from "@yap/core/transcript-processing";
import { SourceTranscriptRead } from "@yap/core/transcript-read";
import { wordKind } from "@yap/core/word-kind";
import {
  ImportedTranscriptStore,
  type ImportedTranscriptSource,
} from "@yap/core/imported-transcript";
import { AcquisitionStore, AcquisitionImporter } from "@yap/core/acquisitions";
import { SourceEvidenceStore } from "@yap/core/evidence";
import { MediaExports } from "./exports.js";
import { PointerPreparation } from "@yap/core/pointer-preparation";
import { ProjectPreviewInspection } from "@yap/core/project-preview";
import {
  nativeAudioCapabilities,
  nativePictureCapabilities,
  projectMovieRenderer,
  projectAudioRenderer,
  projectFrameRenderer,
  projectPointerHistoryRenderer,
} from "./project-render.js";
import { clearRenderWorkspace, withRenderedFile } from "./render.js";
import { DerivativeDelivery } from "./delivery.js";
import { DerivedCache } from "@yap/core/cache";
import { ManagedFiles } from "./managed-files.js";
import { ProjectStore } from "@yap/core/projects";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { AssetStore } from "@yap/core/assets";
import { CatalogError, dependencyRefusal } from "@yap/core/catalog";
import { DeletionPlans } from "@yap/core/deletion-plans";
import { LibraryUsers } from "@yap/core/library-users";
import { CaptureStore, isSettled } from "@yap/core/capture-store";
import { CaptureService } from "./capture.js";
import { CaptureSources } from "./capture-sources.js";
import { openControl, type ControlChannel } from "./control.js";
import type { Readable, Writable } from "node:stream";
import { JobQueue, type JobTargets } from "@yap/core/jobs";
import {
  admitOperation,
  publishedOutput,
  operationNames,
  operationError,
  serviceSocketPath,
  serviceRuntimeDirectory,
  captureReportSchema,
  type OperationResult,
  updateControlSchema,
  updateControlOperations,
  type UpdateStatus,
  type UpdateBlocker,
  appOperations,
  mapWorkState,
  edgeWorkState,
  transientWorkState,
  publicationWorkState,
} from "@yap/protocol";

function sourceRangeAsMicroseconds(value: SelectionRange | undefined) {
  if (!value) return undefined;
  const endpoint = (time: SelectionRange["startUs"]) =>
    typeof time === "number" ? time : Math.round(time.numerator / time.denominator);
  return { startUs: endpoint(value.startUs), endUs: endpoint(value.endUs) };
}

type InternalAudioSelection<T> = T extends { assetId: string; sourceRange?: infer SourceRange }
  ? Omit<T, "sourceRange"> & { range?: SourceRange }
  : T;

function internalAudioSelection<T>(params: T): InternalAudioSelection<T> {
  if (!params || typeof params !== "object" || !("assetId" in params))
    return params as InternalAudioSelection<T>;
  const { sourceRange, ...selection } = params as T & { sourceRange?: SelectionRange };
  return {
    ...selection,
    ...(sourceRange === undefined ? {} : { range: sourceRange }),
  } as InternalAudioSelection<T>;
}

import {
  listenLocal,
  prepareRuntimeDirectory,
  type LocalHandler,
  type LocalListener,
} from "./index.js";
import { claimStartup } from "./startup.js";
import {
  renderWindowDeadlineMs,
  mediaWorker,
  nativeResult,
  transcriptionDeadlineMs,
  type MediaWorker,
} from "./worker.js";
import { operationFailure } from "./operation-errors.js";
import { inspectFFmpegTools, type FFmpegInstallation } from "./ffmpeg-tools.js";
import { audioProcessingRuntime } from "./audio-processing.js";
import { ffmpegLoudnessAnalyzer } from "./loudness.js";
import { AlignmentEvidenceStore, assetAlignmentOwner } from "@yap/core/alignment-evidence";
import { AlignmentProcessing } from "@yap/core/alignment-processing";
import { SourceAlignmentRead } from "@yap/core/alignment-read";
import { projectAlignmentRows, projectTapAlignmentRows } from "@yap/core/project-alignment";
import { alignmentObserver } from "./alignment.js";
import { SpeakerEvidenceStore, assetSpeakerOwner } from "@yap/core/speaker-evidence";
import { SpeakerProcessing } from "@yap/core/speaker-processing";
import { SourceSpeakerRead } from "@yap/core/speaker-read";
import { attributeTranscriptWords } from "@yap/core/speaker-attribution";
import { speakerObserver } from "./speaker.js";
import { SpeakerLabelStore } from "@yap/core/speaker-labels";
import type { Issue, SelectionRange } from "@yap/composition";
import { sourcePCMDecoder } from "./source-channel.js";
import { evaluateSpeakerContinuity } from "@yap/core/speaker-continuity";
import { admitCorrespondence, verifyCorrespondenceReceipt } from "@yap/core/correspondence";
import type { CorrespondenceReceipt } from "@yap/protocol";
import { buildFaceTrajectory } from "@yap/core/face-trajectory";
import { layoutDiagnostics } from "@yap/core/layout-diagnostics";
import { captionProposals } from "../../../skills/yap/scripts/caption-proposals.mjs";

type TranscriptSpeakerRequest = {
  streamId: string;
  acquisitionId?: string;
  channel: number;
  modelId: string;
  sourceRange: SelectionRange;
  generation: string;
};
type TranscriptSpeakerCursor = TranscriptSpeakerRequest & { bindingDigest?: string };

/**
 * A ready source read reports the issues published with the transcript it reads, beside its own
 * range admission. Issues anchored to no word (word-dropped, an unpublished boundary peer) appear
 * only here. The page already carries the transcript, so the publication omits it.
 */
function sourceTranscriptPublication(published: { generation: number | string; issues: Issue[] }) {
  return { generation: String(published.generation), issues: published.issues };
}

function importedAlignmentView(
  imported: Awaited<ReturnType<ImportedTranscriptStore["importPath"]>>,
  alignments: AlignmentProcessing,
  records: AlignmentEvidenceStore,
  channel = 0,
  modelId = "nemo-ctc110",
) {
  const cues = imported.cues.map((cue) => {
    const input = {
      assetId: imported.source.assetId,
      streamId: imported.source.streamId,
      ...(imported.source.acquisitionId === undefined
        ? {}
        : { acquisitionId: imported.source.acquisitionId }),
      channel,
      sourceRange: cue.source,
      text: cue.text,
      modelId,
    };
    const status = alignments.sourceStatus(input);
    if (status.state === "not_requested") return cue;
    if (!status.published)
      return {
        ...cue,
        alignment: {
          state: status.state,
          reason: status.reason,
          retryable: status.retryable,
          modelId: input.modelId,
          channel: input.channel,
          sourceRange: cue.source,
        },
      };
    const evidence = status.published.evidence;
    return {
      ...cue,
      alignment: {
        state: "ready" as const,
        generation: evidence.generation,
        modelId: input.modelId,
        channel: input.channel,
        sourceRange: cue.source,
        evidence,
        words: records.page(evidence, "words", -1, 1000).rows,
      },
    };
  });
  return { ...imported, cues };
}

export async function startProjectService(options: {
  home: string;
  worker?: MediaWorker;
  /** The native worker binary; YAP_NATIVE when omitted. Passing undefined means there is none. */
  nativeExecutable?: string | undefined;
  ffmpeg?: FFmpegInstallation | undefined;
  /** Bundled presets to install at startup; `refresh` turns on the launch and daily refresh (off unless passed). */
  presets?: Pick<PresetsOptions, "bundled" | "trash"> & { refresh?: true | RemoteOptions };
  version?: string | null;
  autoPrepareModels?: boolean;
  deletionFault?: DeletionFault;
  control?: { input: Readable; output: Writable; timeoutMs?: number };
}) {
  const started = performance.now();
  const library = join(options.home, "library");
  const runtime = serviceRuntimeDirectory(options.home);
  await prepareRuntimeDirectory(library);
  const ownership = await claimStartup(runtime);
  let catalog: CaptureStore | undefined;
  let jobs: JobQueue | undefined;
  let presetRefresh: PresetRefresh | undefined;
  let listenerStarting: Promise<LocalListener> | undefined;
  let deletion: LibraryDeletion | undefined;
  let exports: MediaExports | undefined;
  let packages: ProjectPackages | undefined;
  let storage: ManagedStorage | undefined;
  let libraryUsers: LibraryUsers | undefined;
  let controller: ControlChannel | undefined;
  let captureControl: CaptureService | undefined;
  let modelsOwner: Models | undefined;
  let reconciliation: Promise<void> | undefined;
  const delivery = new DerivativeDelivery();
  const modelLifetime = new AbortController();
  const modelPreparations = new Set<Promise<void>>();
  const reviewModelPreparations = new Map<string, Promise<void>>();
  const pending = new Set<Promise<OperationResult>>();
  // Keep the receipt lifetime explicit until a durable package resource owner exists.
  const correspondenceReceipts = new Map<string, CorrespondenceReceipt>();
  const continuityReceipts = new Map<
    string,
    { receipt: ReturnType<typeof evaluateSpeakerContinuity>; sourceRange: SelectionRange }
  >();
  let boundListener: LocalListener | undefined;
  let starting = true;
  let update: UpdateStatus = {
    state: "unavailable",
    jobId: null,
    availability: "unavailable",
    availableVersion: null,
    blockers: [],
    error: null,
  };
  const admission = new UpdateAdmission(
    () => {
      const blockers: UpdateBlocker[] = [];
      if (starting) blockers.push("startup");
      if (pending.size) blockers.push("requests");
      if (boundListener?.updateBlocked || controller?.updateBlocked) blockers.push("transport");
      if (jobs?.updateBlocked) blockers.push("jobs");
      if (captureControl?.updateBlocked) blockers.push("capture");
      if (exports?.updateBlocked) blockers.push("publication");
      if (deletion?.updateBlocked) blockers.push("deletion");
      if (packages?.updateBlocked) blockers.push("packages");
      if (delivery.updateBlocked) blockers.push("delivery");
      if (modelsOwner?.updateBlocked || modelPreparations.size) blockers.push("models");
      if (storage?.updateBlocked) blockers.push("storage");
      return blockers;
    },
    () => controller?.emit({ event: "update.progress" }),
    options.control?.timeoutMs,
    (waiting) => {
      const callback = waiting ? admission.progress : undefined;
      delivery.onUpdateProgress = callback;
      if (modelsOwner) modelsOwner.onUpdateProgress = callback;
      if (storage) storage.onUpdateProgress = callback;
      if (deletion) deletion.onUpdateProgress = callback;
      if (exports) exports.onUpdateProgress = callback;
      if (packages) packages.onUpdateProgress = callback;
      if (captureControl) captureControl.onUpdateProgress = callback;
      if (jobs) jobs.onUpdateProgress = callback;
    },
  );
  let closing = false;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closed) return closed;
    closing = true;
    admission.close();
    closed = Promise.resolve().then(async () => {
      controller?.close();
      modelLifetime.abort();
      delivery.dispose();
      // Own the eventual listener before control opens: EOF during bind must not publish a
      // socket after shutdown released the catalog. Every owner drains before that release.
      const results = await Promise.allSettled([
        listenerStarting?.then((bound) => bound.close()),
        presetRefresh?.close(),
        captureControl?.close(),
        reconciliation,
        jobs?.close(),
        deletion?.close(),
        exports?.close(),
        packages?.close(),
        storage?.close(),
        Promise.allSettled(pending),
        Promise.allSettled(modelPreparations),
        modelsOwner?.settled(),
      ]);
      for (const result of results) if (result.status === "rejected") console.error(result.reason);
      catalog?.close();
      ownership.release();
    });
    return closed;
  };
  try {
    catalog = new CaptureStore(join(library, "catalog.sqlite"), {
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const captures = catalog;
    const plans = new DeletionPlans(captures);
    const presetsRoot = join(options.home, "presets");
    const remote = options.presets?.refresh;
    if (remote) {
      const remoteOptions = remote === true ? {} : remote;
      presetRefresh = new PresetRefresh({
        root: presetsRoot,
        source: () => remoteSource(remoteOptions),
      });
    }
    const presets = await createPresets({
      root: presetsRoot,
      ...(options.presets?.bundled ? { bundled: options.presets.bundled } : {}),
      ...(presetRefresh ? { refresh: presetRefresh } : {}),
      ...(options.presets?.trash ? { trash: options.presets.trash } : {}),
    });
    presetRefresh?.start();
    const assets = new AssetStore(catalog, library);
    await assets.recover();
    const acquisitions = new AcquisitionStore(catalog);
    const evidence = new SourceEvidenceStore(catalog, (identity) => {
      if (identity.owner.kind !== "acquisition")
        throw new CatalogError("NOT_FOUND", "Unsupported source evidence owner");
      acquisitions.intent(identity.owner.acquisitionId);
    });
    const acquisitionImports = new AcquisitionImporter(
      catalog,
      acquisitions,
      assets,
      evidence,
      library,
    );
    const capture = new CaptureSourceRead(assets, acquisitions, evidence);
    const sceneRecords = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
    const nativeExecutable =
      "nativeExecutable" in options ? options.nativeExecutable : process.env.YAP_NATIVE;
    const worker = options.worker ?? mediaWorker({ ...process.env, YAP_NATIVE: nativeExecutable });
    const models = new Models(
      library,
      globalThis.fetch,
      undefined,
      catalog,
      runtimeMaterializer(nativeExecutable),
    );
    const speakerLabels = new SpeakerLabelStore(catalog);
    const speakerRecords = new SpeakerEvidenceStore(
      catalog,
      assetSpeakerOwner(assets, acquisitions),
      (identity) => speakerLabels.remove(identity),
    );
    const alignmentRecords = new AlignmentEvidenceStore(
      catalog,
      assetAlignmentOwner(assets, acquisitions),
    );
    const decoder = await sourcePCMDecoder(worker, nativeExecutable, modelLifetime.signal);
    modelsOwner = models;
    // Lifecycle models are acquired in the background at service startup so the first
    // transcript request never becomes the installer's setup wizard. The manifest owns
    // this opt-in, which makes adding another default model a catalog change rather than
    // another hard-coded startup path.
    if (options.autoPrepareModels !== false) {
      const automaticModels = models.prepareAuto(modelLifetime.signal).catch((error) => {
        if (!modelLifetime.signal.aborted) console.error(error);
      });
      modelPreparations.add(automaticModels);
      void automaticModels.finally(() => {
        modelPreparations.delete(automaticModels);
        admission.progress();
      });
    }
    const transcriptStore = new TranscriptStore(
      catalog,
      library,
      assetTranscriptOwner(assets, acquisitions),
    );
    const importedTranscripts = new ImportedTranscriptStore(
      catalog,
      library,
      (source: ImportedTranscriptSource) => {
        const selected = selectSource(assets, acquisitions, source);
        if (selected.stream.kind !== "audio")
          throw new CatalogError(
            "UNSUPPORTED_MEDIA",
            "Imported transcript requires an audio stream",
          );
      },
    );
    const projects = new ProjectStore(catalog, assets, transcriptStore, acquisitions);
    const files = new ManagedFiles(library, worker);
    const cache = new DerivedCache(catalog, library, (owner) => {
      if (owner.kind === "project") projects.get(owner.projectId);
      else if (owner.kind === "asset") {
        if (!assets.has(owner.assetId))
          throw new CatalogError("NOT_FOUND", "Asset does not exist", { assetId: owner.assetId });
      } else if (owner.kind === "acquisition") acquisitions.get(owner.acquisitionId);
      else throw new CatalogError("NOT_FOUND", "Unsupported derived-file owner");
    });
    await cache.reconcile();
    const workspace = join(library, "render");
    await clearRenderWorkspace(worker, workspace, new AbortController().signal);
    const probe = assetProbe(worker, workspace);
    const targets: JobTargets = {
      pin(target) {
        if (target.kind === "import") assets.intent(target.importId);
        else if (target.kind === "acquisition") {
          if (plans.isTombstoned("acquisition", target.acquisitionId))
            throw new CatalogError("DELETE_IN_PROGRESS", "acquisition deletion is in progress", {
              acquisitionId: target.acquisitionId,
            });
          if (!captureSources.available(target.acquisitionId))
            throw new CatalogError("NOT_FOUND", "Capture source donor is unavailable");
        } else if (target.kind === "asset") {
          if (plans.isTombstoned("asset", target.assetId))
            throw new CatalogError("DELETE_IN_PROGRESS", "asset deletion is in progress", {
              assetId: target.assetId,
            });
          if (!assets.has(target.assetId))
            throw new CatalogError("NOT_FOUND", "Asset does not exist", {
              assetId: target.assetId,
            });
        } else if (target.kind === "project")
          projects.requireRevision(target.projectId, target.revisionId);
        else if (target.kind === "recording" && target.revisionId === null) {
          const recording = captures.get(target.recordingId);
          if (!isSettled(recording.state) || recording.state === "canceled")
            throw new CatalogError(
              "INVALID_STATE",
              "Source-owned work requires a settled available recording",
            );
          return { ...target, revisionId: null };
        } else
          throw new CatalogError("PREREQUISITE_MISSING", "Unsupported project service job target");
        return target;
      },
      isAvailable(target) {
        if (target.kind === "recording") return captures.isAvailable(target.recordingId);
        if (target.kind === "asset")
          return !plans.isTombstoned("asset", target.assetId) && assets.has(target.assetId);
        if (target.kind === "project")
          return projects.hasRevision(target.projectId, target.revisionId);
        if (target.kind !== "import" && target.kind !== "acquisition") return false;
        try {
          targets.pin(target);
          return true;
        } catch (error) {
          if (
            error instanceof CatalogError &&
            (error.code === "NOT_FOUND" || error.code === "DELETE_IN_PROGRESS")
          )
            return false;
          throw error;
        }
      },
      isDeleting: (owner) => {
        if (owner.kind === "recording") return captures.isDeleting(owner.recordingId);
        if (owner.kind === "project") return projects.isDeleting(owner.projectId);
        if (owner.kind === "asset") return plans.isTombstoned("asset", owner.assetId);
        if (owner.kind === "acquisition")
          return plans.isTombstoned("acquisition", owner.acquisitionId);
        return false;
      },
      isCapturing: () => captures.isCapturing(),
    };
    await acquisitionImports.recover(new AbortController().signal);
    await sceneRecords.recoverPending("asset", new AbortController().signal);
    await transcriptStore.recoverPendingAssets(new AbortController().signal);
    let captureCleanup: CaptureCleanup;
    let pointers: PointerPreparation;
    let preview: ProjectPreviewInspection;
    let mediaFrames: MediaFrameInspection;
    let transcripts: TranscriptProcessing;
    let speakers: SpeakerProcessing;
    let alignments: AlignmentProcessing;
    let projectEvidence: ProjectEvidenceInspection;
    let mediaAudio: MediaAudioInspection;
    let preparedAudio: PreparedAudioStore;
    let extractedAudio: AudioExtraction;
    let renderedSpeech: RenderedSpeech;
    let generatedVoice: VoiceGenerationJobs;
    let convertedAssets: AssetConversionJobs;
    let acoustics: AcousticInspection;
    let scenes: SceneProcessing;
    let indexes: IndexProcessing;
    const resumeCaptureSources = () => {
      if (closing) return;
      try {
        captureSources.resume();
      } catch (error) {
        console.error(error);
      }
    };
    const queue = new JobQueue({
      deferExecution: true,
      store: catalog,
      targets,
      providers: { newId: randomUUID },
      onCapacity: () => {
        resumeCaptureSources();
        for (const error of exports?.resumeRecovery() ?? []) console.error(error);
      },
      execute: async ({ job, signal }) => {
        if (job.artifact === "asset-conversion") return convertedAssets.execute({ job, signal });
        if (job.artifact === "voice-generation") return generatedVoice.execute({ job, signal });
        if (job.artifact === "audio-extract") return extractedAudio.execute({ job, signal });
        if (job.artifact === "rendered-speech") return renderedSpeech.execute({ job, signal });
        if (job.artifact === "prepared-audio") return preparedAudio.execute({ job, signal });
        if (job.artifact === "pointer-presentation") return pointers.execute({ job, signal });
        if (
          (job.target.kind === "asset" || job.target.kind === "project") &&
          job.artifact === "screenshot-index"
        )
          return indexes.execute({ job, signal });
        if (job.target.kind === "asset" && job.artifact === "source-scenes")
          return scenes.execute({ job, signal });
        if (
          (job.target.kind === "asset" || job.target.kind === "project") &&
          ["waveform", "spectrum", "acoustic-image", "loudness", "pause"].includes(job.artifact)
        )
          return acoustics.execute({ job, signal });
        if (
          (job.target.kind === "project" || job.target.kind === "asset") &&
          job.artifact === "frame"
        )
          return mediaFrames.execute({ job, signal });
        if (
          (job.target.kind === "asset" || job.target.kind === "project") &&
          ["audio", "audio-file"].includes(job.artifact)
        )
          return mediaAudio.execute({ job, signal });
        if (job.target.kind === "project" && job.artifact === "project.evidence")
          return projectEvidence.execute({ job, signal });
        if (
          (job.target.kind === "asset" && job.artifact === "source-alignment") ||
          (job.target.kind === "project" && job.artifact === "project-alignment")
        )
          return alignments.execute({ job, signal });
        if (job.target.kind === "asset" && job.artifact === "source-speakers")
          return speakers.execute({ job, signal });
        if (job.artifact === "transcript") return transcripts.execute({ job, signal });
        if (job.artifact === "export-media" || job.artifact === "export-recovery")
          return exports!.execute({ job, signal });
        if (job.target.kind === "project" && job.artifact === "preview")
          return preview.execute({ job, signal });
        if (job.artifact === "capture-cleanup") return captureCleanup.execute({ job, signal });
        if (job.target.kind === "acquisition" && job.artifact === "acquisition.import") {
          const acquisition = await acquisitionImports.executeImport(
            job.target.acquisitionId,
            job.attemptId,
            {
              probe,
              exportSource: sourceExporter(worker),
            },
            signal,
          );
          return JSON.stringify({ acquisitionId: acquisition.id });
        }
        if (job.target.kind !== "import" || job.artifact !== "asset.import")
          throw new CatalogError("PREREQUISITE_MISSING", "Unsupported preparation job");
        const asset = await assets.executeImport(job.target.importId, probe, signal, {
          kind: "job",
          id: job.jobId,
        });
        return JSON.stringify({ assetId: asset.id });
      },
    });
    jobs = queue;
    convertedAssets = new AssetConversionJobs({
      assets,
      jobs: queue,
      worker,
      staging: workspace,
      runtime: (signal) => assetConversionRuntime(options.ffmpeg, nativeExecutable, signal),
    });
    captureCleanup = new CaptureCleanup(captures, queue, library, worker);
    const captureSources = new CaptureSources(captures, acquisitions, queue, library, files);
    pointers = new PointerPreparation({
      assets,
      acquisitions,
      evidence,
      jobs: queue,
      cache,
      renderer: projectPointerHistoryRenderer(worker, workspace),
    });
    speakers = new SpeakerProcessing({
      assets,
      acquisitions,
      models,
      jobs: queue,
      evidence: speakerRecords,
      decoder,
      observe: speakerObserver(worker, workspace),
    });
    alignments = new AlignmentProcessing({
      assets,
      acquisitions,
      models,
      jobs: queue,
      evidence: alignmentRecords,
      decoder,
      observe: alignmentObserver(worker, workspace),
      project: {
        resolve(input) {
          const composition = projectComposition(projects, assets, {
            projectId: input.projectId,
            revisionId: input.revisionId,
          });
          // The caller's text aligns against the part of the range inside the revision.
          const admitted = admitProjectRange(composition.model.durationUs, input.range);
          const prepared = preparedAudio.resolve(composition, input.tap, input.preparedResourceId);
          if (!prepared)
            throw new CatalogError("NOT_READY", "Prepared project tap is not ready", {
              projectId: input.projectId,
              revisionId: composition.revisionId,
              preparedResourceId: input.preparedResourceId,
            });
          const asset = assets.get(prepared.audio.assetId),
            stream = asset.streams.find((value) => value.kind === "audio");
          if (!stream)
            throw new CatalogError("UNSUPPORTED_MEDIA", "Prepared project tap has no audio stream");
          if (input.channel >= (stream.channels ?? 0))
            throw new CatalogError("INVALID_PARAMS", "Project alignment channel is unavailable");
          return {
            source: {
              assetId: prepared.audio.assetId,
              streamId: stream.id,
              channel: input.channel,
              sourceRange: admitted.range,
              text: input.text,
              modelId: input.modelId,
            },
            projectId: input.projectId,
            revisionId: composition.revisionId,
            preparedResourceId: prepared.resourceId,
            issues: admitted.issues,
          };
        },
      },
    });
    transcripts = new TranscriptProcessing({
      jobs: queue,
      transcripts: transcriptStore,
      models: models.transcription("parakeet"),
      asset: { assets, acquisitions },
      transcribe: async (request, signal) =>
        nativeResult(
          await worker("speech.transcribe", request, {
            signal,
            timeoutMs: transcriptionDeadlineMs(request.track.available),
          }),
        ) as SpeechTranscriptionReceipt,
    });
    const ensureReviewModel = () => {
      const modelId = "parakeet";
      const current = transcripts.recognitionReadiness();
      if (current.state === "ready" || current.state === "preparing" || current.state === "failed")
        return current;
      let flight = reviewModelPreparations.get(modelId);
      if (!flight) {
        flight = models
          .prepare(modelId, modelLifetime.signal, {})
          .catch((error) => {
            if (!modelLifetime.signal.aborted) console.error(error);
          })
          .finally(() => reviewModelPreparations.delete(modelId));
        reviewModelPreparations.set(modelId, flight);
        modelPreparations.add(flight);
        void flight.finally(() => {
          modelPreparations.delete(flight!);
          admission.progress();
        });
      }
      return transcripts.recognitionReadiness();
    };
    const audioCapabilities = await nativeAudioCapabilities(worker);
    const pictureCapabilities = await nativePictureCapabilities(worker);
    const processingRuntime = await audioProcessingRuntime(
      options.ffmpeg,
      nativeExecutable,
      audioCapabilities.statePreparation,
      modelLifetime.signal,
    );
    const audioRenderer = projectAudioRenderer(
      worker,
      workspace,
      audioCapabilities,
      modelLifetime.signal,
      processingRuntime,
    );
    preparedAudio = new PreparedAudioStore({
      catalog,
      assets,
      projects,
      jobs: queue,
      renderer: audioRenderer,
      probe,
      staging: join(library, "staging", "prepared-audio"),
    });
    await preparedAudio.recover();
    mediaAudio = new MediaAudioInspection({
      assets,
      acquisitions,
      jobs: queue,
      cache,
      project: { projects, renderer: audioRenderer, prepared: preparedAudio },
      sourceRenderer: {
        implementationId: "native-source-audio-v6",
        render: async (request, signal) =>
          withRenderedFile(
            worker,
            { attemptParent: workspace, output: request.output, filename: "audio.wav" },
            signal,
            async (output, execute) =>
              nativeResult(
                await execute(
                  "media.sourceAudio",
                  { ...request, output },
                  {
                    signal,
                    timeoutMs: renderWindowDeadlineMs(request.range),
                  },
                ),
              ),
          ),
      },
    });
    extractedAudio = new AudioExtraction({
      assets,
      acquisitions,
      projects,
      audio: mediaAudio,
      jobs: queue,
      probe,
      staging: join(library, "staging", "audio-extract"),
      converter: {
        implementationId: "native-finite-pcm-v2",
        convert: async ({ input, ...request }, signal) =>
          withRenderedFile(
            worker,
            { attemptParent: workspace, output: request.output, filename: "audio.wav" },
            signal,
            async (output, execute) =>
              nativeResult(
                await execute(
                  "media.convertSelectedAudio",
                  { ...request, output },
                  {
                    signal,
                    timeoutMs: renderWindowDeadlineMs({
                      startUs: 0,
                      endUs: Math.ceil((input.frames * 1000000) / input.sampleRate),
                    }),
                  },
                ),
              ),
          ),
      },
    });
    await extractedAudio.recover();
    renderedSpeech = new RenderedSpeech({
      catalog,
      projects,
      assets,
      jobs: queue,
      extraction: extractedAudio,
      transcripts,
      records: transcriptStore,
    });
    generatedVoice = new VoiceGenerationJobs({
      assets,
      jobs: queue,
      models,
      probe,
      staging: join(library, "staging", "voice-generation"),
      generate: (modelId, request, signal) =>
        voiceRenderer(worker, models, modelId, workspace)(request, signal),
    });
    await generatedVoice.recover();
    acoustics = new AcousticInspection({
      audio: mediaAudio,
      jobs: queue,
      cache,
      loudness: ffmpegLoudnessAnalyzer(options.ffmpeg, nativeExecutable),
      renderer: {
        implementationId: "native-acoustic-image-v2",
        render: async (request, signal) =>
          withRenderedFile(
            worker,
            { attemptParent: workspace, output: request.output, filename: "frame.png" },
            signal,
            async (output, execute) => {
              const bytes = Buffer.from(JSON.stringify({ ...request, output }));
              if (bytes.length > 16 * 1024 * 1024)
                throw new CatalogError("LIMIT_EXCEEDED", "Acoustic measurements exceed 16 MiB");
              const input = output + ".json";
              await writeFile(input, bytes, { flag: "wx", signal });
              return nativeResult(await execute("media.acousticImage", { input }, { signal }));
            },
          ),
      },
    });
    scenes = new SceneProcessing({
      jobs: queue,
      evidence: sceneRecords,
      asset: {
        assets,
        acquisitions,
        implementationId: "native-source-scenes-v4",
        retained: (assetId, generation) =>
          indexes?.retainsSourceScenes(assetId, generation) ?? false,
        sample: async (request, signal) =>
          nativeResult(
            await worker("media.sourceVisualSamples", request, { signal }),
          ) as SourceVisualObservations,
      },
    });
    const sourceEvents = new SourceEvents({
      assets,
      acquisitions,
      capture,
      scenes: new SourceSceneRead({
        assets,
        acquisitions,
        processing: scenes,
        records: sceneRecords,
      }),
    });
    projectEvidence = new ProjectEvidenceInspection({
      projects,
      assets,
      jobs: queue,
      cache,
      transcripts,
      records: transcriptStore,
      events: sourceEvents,
      speakers: {
        resolveMany: (selections, choice) => speakers.resolveMany(selections, choice),
        sourceStatus: (input) => speakers.sourceStatus(input),
        records: speakerRecords,
        labels: (metadata) =>
          new Map(
            speakerLabels.read(metadata).map((binding) => [binding.slot, binding.displayName]),
          ),
      },
    });
    preview = new ProjectPreviewInspection(
      projects,
      assets,
      queue,
      cache,
      projectMovieRenderer(
        worker,
        workspace,
        { preparation: pointers, evidence },
        audioCapabilities,
        modelLifetime.signal,
        pictureCapabilities,
        processingRuntime,
      ),
      preparedAudio,
    );
    const projectPictures = projectFrameRenderer(
      worker,
      workspace,
      {
        preparation: pointers,
        evidence,
      },
      pictureCapabilities,
    );
    mediaFrames = new MediaFrameInspection({
      assets,
      acquisitions,
      jobs: queue,
      cache,
      project: { projects, renderer: projectPictures },
      imageRenderer: {
        implementationId: "native-source-image-v4",
        render: async (request, signal) =>
          withRenderedFile(
            worker,
            { attemptParent: workspace, output: request.output, filename: "frame.png" },
            signal,
            async (output, execute) =>
              nativeResult(await execute("media.sourceImage", { ...request, output }, { signal })),
          ),
      },
      sourceRenderer: {
        implementationId: "native-source-picture-v9-cursor",
        render: async (request, signal) =>
          withRenderedFile(
            worker,
            { attemptParent: workspace, output: request.output, filename: "frame.png" },
            signal,
            async (output, execute) =>
              nativeResult(await execute("media.sourceFrame", { ...request, output }, { signal })),
          ),
      },
      cursorOverlay: async (input, signal) => {
        const startUs = Math.max(0, input.atUs - input.trailUs);
        const page = capture.cursor({
          ...input,
          sourceRange: { startUs, endUs: Math.min(input.atUs + 1, Number.MAX_SAFE_INTEGER) },
          limit: 5000,
        });
        if (page.state !== "ready" || !page.page)
          throw new CatalogError(
            "UNAVAILABLE",
            "Cursor rendering requires captured-video authority",
          );
        if (page.page.nextCursor)
          throw new CatalogError(
            "LIMIT_EXCEEDED",
            "Cursor trail has too many observations; narrow the request",
          );
        const rows = page.page.rows;
        const runs: Array<Array<{ atSourceUs: number; x: number; y: number }>> = [];
        let run: Array<{ atSourceUs: number; x: number; y: number }> = [];
        for (const row of rows) {
          signal.throwIfAborted();
          const observation = row.observation as { x?: number; y?: number; eligibility?: string };
          if (
            observation.eligibility !== "inside" ||
            typeof observation.x !== "number" ||
            typeof observation.y !== "number"
          ) {
            if (run.length) runs.push(run);
            run = [];
            continue;
          }
          run.push({ atSourceUs: Number(row.sourceAtUs), x: observation.x, y: observation.y });
        }
        if (run.length) runs.push(run);
        const pointer = runs.at(-1)?.at(-1) ?? null;
        return { trail: runs, trailUs: input.trailUs, pointer };
      },
    });
    const projectIndex = new ScreenshotIndexStore<ProjectIndexRecords>(
      catalog,
      library,
      projectIndexDomain(
        {
          composition: (identity) => projectComposition(projects, assets, identity),
          source: (selection) => selectSource(assets, acquisitions, selection),
          scenes: sceneRecords,
          isDeleting: (id) => projects.isDeleting(id),
        },
        projectPictures,
      ),
    );
    const sourceIndex = new ScreenshotIndexStore<SourceIndexRecords>(
      catalog,
      library,
      sourceIndexDomain(
        (selection) => selectSource(assets, acquisitions, selection),
        sceneRecords,
        mediaFrames,
      ),
    );
    await sourceIndex.recoverPending("asset", new AbortController().signal);
    await projectIndex.recoverPending("project", new AbortController().signal);
    libraryUsers = new LibraryUsers(captures, {
      asset: (id) => [
        assets.path(id),
        join(library, "transcripts", "assets", id),
        join(library, "transcripts", "imported", id),
        ...sourceIndex.ownedPaths({ kind: "asset", assetId: id }),
        ...cache.ownedPaths({ kind: "asset", assetId: id }),
      ],
      acquisition: (id) => acquisitionImports.managedPaths(id),
      recording: (id) => files.recordingPaths(id),
      project: (id) => [
        ...projectIndex.ownedPaths({ kind: "project", projectId: id }),
        ...cache.ownedPaths({ kind: "project", projectId: id }),
      ],
    });
    indexes = new IndexProcessing({
      jobs: queue,
      project: {
        catalog,
        assets,
        acquisitions,
        projects,
        index: projectIndex,
        scenes,
        records: sceneRecords,
        frames: mediaFrames,
        cache,
      },
      asset: {
        catalog,
        assets,
        acquisitions,
        index: sourceIndex,
        scenes,
        records: sceneRecords,
        frames: mediaFrames,
        cache,
      },
    });
    const indexFrame = (
      input:
        | Parameters<IndexProcessing["frameProject"]>[0]
        | Parameters<IndexProcessing["frameSource"]>[0],
    ) => {
      const frame = "projectId" in input ? indexes.frameProject(input) : indexes.frameSource(input);
      return {
        ...frame,
        published: publishedOutput(
          { generation: frame.generation, issues: frame.published.issues },
          () => frame.published.frame,
        ),
        delivery:
          "projectId" in input
            ? delivery.open({ kind: "project", id: input.projectId }, () =>
                indexes.openReadProject(input),
              )
            : delivery.open({ kind: "asset", id: input.assetId }, () =>
                indexes.openReadSource(input),
              ),
      };
    };
    const frameDelivery = (status: ReturnType<MediaFrameInspection["request"]>) => ({
      ...status,
      published: publishedOutput(status.published, (value) => value.frame),
      delivery: status.published
        ? delivery.open(
            "projectId" in status
              ? { kind: "project", id: status.projectId }
              : { kind: "asset", id: status.assetId },
            () => cache.acquire(status.published!.frame.cacheId),
          )
        : null,
    });
    const projectPackages = new ProjectPackages({
      preparedAudio,
      acquisitions: acquisitionImports,
      sceneRecords,
      scenes,
      speakerRecords,
      speakerLabels,
      speakers,
      alignmentRecords,
      alignments,
      transcriptRecords: transcriptStore,
      importedTranscripts,
      transcripts,
      indexRecords: sourceIndex,
      indexes,
      directory: library,
      projects,
      assets,
      jobs: queue,
      worker,
      delivery,
      projectIndexRecords: projectIndex,
    });
    packages = projectPackages;
    const mediaExports = new MediaExports({
      catalog,
      jobs: queue,
      cache,
      worker,
      files,
      project: { store: projects, assets, preview, audio: mediaAudio, package: projectPackages },
    });
    exports = mediaExports;
    const managedStorage = new ManagedStorage(null, cache, library, (signal) =>
      mediaExports.usage(undefined, signal),
    );
    storage = managedStorage;
    queue.startAdmission((job) => {
      if (job.target.kind === "project") {
        if (job.artifact === "rendered-speech") return renderedSpeech.admit(job);
        if (job.artifact === "audio-file") return mediaAudio.admitExport(job);
        if (job.artifact === "preview") return preview.admit(job);
        if (job.artifact === "frame") return mediaFrames.admit(job);
        if (job.artifact === "screenshot-index") return indexes.admitProject(job);
      }
      return mediaExports.admit(job);
    });
    await transcripts.cleanup(modelLifetime.signal);
    await scenes.cleanup(modelLifetime.signal);
    await speakers.cleanup(modelLifetime.signal);
    await alignments.cleanup(modelLifetime.signal);
    await indexes.cleanup(modelLifetime.signal);
    const libraryDeletion = new LibraryDeletion(
      plans,
      options.deletionFault === undefined ? {} : { fault: options.deletionFault },
    );
    deletion = libraryDeletion;
    libraryDeletion.register(
      projectRetirement({
        catalog: captures,
        store: projects,
        jobs: queue,
        cache,
        files,
        delivery,
        exports: mediaExports,
        index: projectIndex,
        freedBytes: (id: string) =>
          libraryUsers?.usersOf({ kind: "project", id } as never).freesBytes ?? 0,
      }),
    );
    libraryDeletion.register(
      acquisitionRetirement({
        catalog: captures,
        store: acquisitions,
        importer: acquisitionImports,
        jobs: queue,
      }),
    );
    libraryDeletion.register(
      assetRetirement({
        catalog: captures,
        assets,
        users: libraryUsers!,
        transcripts: transcriptStore,
        importedTranscripts,
        scenes: sceneRecords,
        indexes: sourceIndex,
        alignments: alignmentRecords,
        speakers: speakerRecords,
        cache,
        jobs: queue,
        files,
        delivery,
      }),
    );

    const status = (jobId: string) => {
      const value = queue.inspect(jobId);
      const { generation, ...job } = value;
      return {
        ...job,
        published: job.published
          ? {
              ...job.published,
              generation: String(job.published.generation),
              output: job.published.output,
              issues: job.published.issues,
            }
          : job.published,
        attemptGeneration: generation,
        state: mapWorkState(value.state, edgeWorkState),
        jobId,
      };
    };
    /** A lifecycle word that is not a presence fact asks the installed files instead. */
    const modelPresence = (modelId: string, state: string) =>
      state === "absent" || state === "ready" || state === "invalid"
        ? state
        : models.presence(modelId);
    /** The export intent a job belongs to, or null for every other job. */
    const exportOf = (jobId: string) => {
      const job = queue.job(jobId);
      if (
        job.artifact !== "export" &&
        job.artifact !== "export-media" &&
        job.artifact !== "export-recovery"
      )
        return null;
      try {
        return { exportId: JSON.parse(job.input) as string, recovery: false };
      } catch {
        return job.artifact === "export-recovery"
          ? { exportId: job.input.split("/", 1)[0]!, recovery: true }
          : { exportId: job.input, recovery: false };
      }
    };
    const itemStatus = (jobId: string) => {
      const owner = exportOf(jobId);
      return owner ? mediaExports.status(owner.exportId) : status(jobId);
    };

    // Domain owners retain their stored vocabulary. Only values carrying a job identity
    // cross this boundary as WorkState; nested evidence labels remain domain facts.
    const workMapping = {
      ...edgeWorkState,
      ...transientWorkState,
      ...publicationWorkState,
    } as const;
    const domainStates = new Set([
      "recording",
      "paused",
      "finalizing",
      "interrupted",
      "captured",
      "observed",
      "missing",
      "not_applicable",
      "unknown",
      "named",
      "attributed",
      "overlap",
      "closed",
      "settled",
      "conflicted",
      "published",
      "retained",
      "ingest",
      "stopped",
      "available",
      "measured",
      "sampled",
      "skipped",
      "outside_project",
      "on",
      "off",
      "transcribed",
    ]);
    const normalizeWork = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalizeWork);
      if (typeof value === "bigint") return Number(value);
      if (!value || typeof value !== "object") return value;
      const record = value as Record<string, unknown>;
      const mapped = Object.fromEntries(
        Object.entries(record).map(([key, child]) => [key, normalizeWork(child)]),
      );
      if (typeof record.state === "string") {
        const asyncShape =
          !("recordingId" in record || "finalizationError" in record) &&
          ("jobId" in record ||
            [
              "published",
              "reason",
              "retryable",
              "dependencies",
              "context",
              "page",
              "report",
              "refresh",
              "operationId",
              "receivedBytes",
              "availableVersion",
              "delivery",
            ].some((key) => key in record));
        if (asyncShape && !domainStates.has(record.state)) {
          mapped.state = mapWorkState(record.state, workMapping);
          if (!("jobId" in mapped)) mapped.jobId = null;
        }
      }
      return mapped;
    };
    const describeCapture = captureSources.describe.bind(captureSources);
    const handle: LocalHandler = async (request, requestSignal): Promise<OperationResult> => {
      if (closing) return operationError("SERVICE_STOPPED", "Service is closing");
      if (!operationNames.has(request.operation))
        return operationError("UNKNOWN_OPERATION", "Unknown service operation");
      if (appOperations.has(request.operation))
        return operationError(
          "UNKNOWN_OPERATION",
          `${request.operation} is answered by the app on its own socket, not the service`,
        );
      const parsed = admitOperation({ operation: request.operation, params: request.params });
      if (!parsed.ok) return parsed;
      const operation = parsed.data;
      try {
        switch (operation.operation) {
          case "correspondence.prepare": {
            const receipt = admitCorrespondence(operation.params);
            correspondenceReceipts.set(`${receipt.evidenceId}:${receipt.generation}`, receipt);
            return {
              ok: true,
              data: {
                state: "ready",
                evidenceId: receipt.evidenceId,
                generation: receipt.generation,
                published: { generation: receipt.generation, output: receipt },
              },
            };
          }
          case "correspondence.get": {
            if (operation.params.packageHandle)
              return operationError(
                "NOT_READY",
                "Correspondence package reads are not available for service-local receipts",
              );
            const key = `${operation.params.evidenceId}:${operation.params.generation}`;
            const receipt = correspondenceReceipts.get(key);
            if (!receipt)
              return operationError("NOT_FOUND", "Correspondence receipt is not retained");
            const checked = verifyCorrespondenceReceipt(receipt);
            const correspondencePosition =
              operation.params.cursor === undefined
                ? undefined
                : (pageCursor.decode(
                    "correspondence.get",
                    operation.params.cursor,
                    pageFilters(operation.params),
                  ) as {
                    afterAnchor?: unknown;
                  });
            const after = (correspondencePosition?.afterAnchor ?? -1) as number;
            if (
              correspondencePosition &&
              (!Number.isSafeInteger(after) ||
                after < 0 ||
                after >= checked.measurement.anchors.length)
            )
              throw new CatalogError("INVALID_PARAMS", "Invalid correspondence page cursor");
            const limit = operation.params.limit;
            const anchors = checked.measurement.anchors.slice(after + 1, after + 1 + limit);
            const next =
              after + 1 + anchors.length < checked.measurement.anchors.length
                ? after + anchors.length
                : null;
            return {
              ok: true,
              data: {
                state: "ready",
                evidenceId: checked.evidenceId,
                generation: checked.generation,
                verdict: checked.measurement.verdict,
                anchors,
                measurement: { ...checked.measurement, anchors },
                nextCursor:
                  next === null
                    ? null
                    : pageCursor.encode(
                        "correspondence.get",
                        { afterAnchor: next },
                        pageFilters(operation.params),
                      ),
              },
            };
          }
          case "service.health":
            return {
              ok: true,
              data: {
                status: "ready",
                version: options.version ?? null,
                update,
                pid: process.pid,
                socketPath: serviceSocketPath(runtime),
                home: options.home,
                node: process.versions.node,
                uptimeMs: Math.round(performance.now() - started),
                models: models.statuses(),
              },
            };
          case "service.tools":
            return {
              ok: true,
              data: {
                node: { path: process.execPath, version: process.versions.node },
                ffmpeg: await inspectFFmpegTools(options.ffmpeg, requestSignal, nativeExecutable),
              },
            };
          case "recording.delete":
            return {
              ok: true,
              data: await deletion!.delete(
                { kind: "recording", id: operation.params.recordingId },
                { requestId: operation.params.requestId },
              ),
            };
          case "asset.delete":
            return {
              ok: true,
              data: await deletion!.delete(
                { kind: "asset", id: operation.params.assetId },
                {
                  requestId: operation.params.requestId,
                  ...(operation.params.cascade === undefined
                    ? {}
                    : { cascade: operation.params.cascade }),
                },
              ),
            };
          case "recording.cleanup":
            return { ok: true, data: captureCleanup.request(operation.params.recordingId) };
          case "capture.sources":
            return { ok: true, data: await requireCaptureControl().sources() };
          case "capture.status": {
            const status = await requireCaptureControl().status();
            return {
              ok: true,
              data: {
                ...status,
                recording: status.recording ? describeCapture(status.recording) : null,
              },
            };
          }
          case "capture.start":
            return {
              ok: true,
              data: describeCapture(await requireCaptureControl().start(operation.params)),
            };
          case "capture.restart":
            return {
              ok: true,
              data: describeCapture(await requireCaptureControl().restart(operation.params)),
            };
          case "capture.pause":
            return {
              ok: true,
              data: describeCapture(
                await requireCaptureControl().pause(operation.params.recordingId),
              ),
            };
          case "capture.resume":
            return {
              ok: true,
              data: describeCapture(
                await requireCaptureControl().resume(operation.params.recordingId),
              ),
            };
          case "capture.setCamera": {
            const { device, recording } = await requireCaptureControl().setCamera(
              operation.params.recordingId,
              operation.params.on,
            );
            return { ok: true, data: { device, recording: describeCapture(recording) } };
          }
          case "capture.stop":
            return {
              ok: true,
              data: describeCapture(
                await requireCaptureControl().stop(operation.params.recordingId),
              ),
            };
          case "capture.cancel":
            return {
              ok: true,
              data: describeCapture(
                await requireCaptureControl().cancel(operation.params.recordingId),
              ),
            };
          case "recording.get":
            if (operation.params.recordingId === undefined) {
              const latest = captures.latest();
              return latest
                ? { ok: true, data: describeCapture(latest) }
                : operationError(["NOT", "FOUND"].join("_"), "Recording does not exist");
            }
            return { ok: true, data: describeCapture(captures.get(operation.params.recordingId)) };
          case "recording.list": {
            const page = captures.list(operation.params.cursor, operation.params.limit);
            return {
              ok: true,
              data: { ...page, recordings: page.recordings.map(describeCapture) },
            };
          }
          case "index.get": {
            const params = operation.params;
            const normalized =
              params.cursor === undefined
                ? params
                : {
                    ...params,
                    cursor: pageCursor.decode(
                      "index.get",
                      params.cursor,
                      pageFilters(operation.params),
                    ),
                  };
            if ("projectId" in normalized)
              return {
                ok: true,
                data: pageEnvelope(
                  indexes.getProject(normalized as never),
                  "index.get",
                  pageFilters(operation.params),
                ),
              };
            return {
              ok: true,
              data: pageEnvelope(
                indexes.getSource(normalized as never),
                "index.get",
                pageFilters(operation.params),
              ),
            };
          }
          case "face.trajectory.get": {
            const { generation, maxGapUs, prediction, limit, cursor, ...selection } =
              operation.params;
            const trajectoryCursor =
              cursor === undefined
                ? undefined
                : pageCursor.decode("face.trajectory.get", cursor, pageFilters(operation.params));
            const page = indexes.getSource({
              ...selection,
              generation,
              ...(limit === undefined ? {} : { limit }),
              ...(trajectoryCursor === undefined ? {} : { cursor: trajectoryCursor }),
            } as never);
            if (!page.page) return { ok: true, data: { ...page, trajectory: null } };
            const entries = page.page.entries;
            if (entries.length === 0)
              return {
                ok: true,
                data: {
                  state: "ready",
                  generation,
                  trajectory: null,
                  reason: "no_face_observations",
                  nextCursor:
                    page.page.nextCursor === null
                      ? null
                      : pageCursor.encode(
                          "face.trajectory.get",
                          page.page.nextCursor,
                          pageFilters(operation.params),
                        ),
                },
              };
            const observations = entries.map((entry) => entry.frame.faceObservations);
            if (observations.some((value) => value === undefined))
              return {
                ok: true,
                data: {
                  state: "unavailable",
                  reason: "face_observations_unavailable",
                  generation,
                  nextCursor:
                    page.page.nextCursor === null
                      ? null
                      : pageCursor.encode(
                          "face.trajectory.get",
                          page.page.nextCursor,
                          pageFilters(operation.params),
                        ),
                },
              };
            const supportDigest = entries[0]?.frame.supportDigest;
            if (
              !supportDigest ||
              entries.some((entry) => entry.frame.supportDigest !== supportDigest)
            )
              throw new CatalogError(
                "ARTIFACT_CHANGED",
                "Face observations changed source support",
              );
            const trajectory = buildFaceTrajectory({
              source: {
                ...selection,
                generation,
                supportDigest,
              },
              maxGapUs,
              prediction,
              samples: entries.map((entry) => ({
                ordinal: entry.candidate.ordinal,
                atUs: entry.candidate.requestedSourceUs,
                observations: entry.frame.faceObservations!,
              })),
            });
            return {
              ok: true,
              data: {
                state: "ready",
                generation,
                trajectory,
                nextCursor:
                  page.page.nextCursor === null
                    ? null
                    : pageCursor.encode(
                        "face.trajectory.get",
                        page.page.nextCursor,
                        pageFilters(operation.params),
                      ),
              },
            };
          }
          case "index.coverage": {
            const params = operation.params;
            const normalized =
              params.cursor === undefined
                ? params
                : {
                    ...params,
                    cursor: pageCursor.decode(
                      "index.coverage",
                      params.cursor,
                      pageFilters(operation.params),
                    ),
                  };
            const page =
              "projectId" in normalized
                ? indexes.coverageProject(normalized as never)
                : indexes.coverageSource(normalized as never);
            return {
              ok: true,
              data: {
                ...page,
                nextCursor:
                  page.nextCursor === null
                    ? null
                    : pageCursor.encode(
                        "index.coverage",
                        page.nextCursor,
                        pageFilters(operation.params),
                      ),
              },
            };
          }
          case "index.frame": {
            const params = operation.params;
            return {
              ok: true,
              data: indexFrame(params),
            };
          }
          case "index.frames": {
            const params = operation.params;
            const { ordinals, ...reference } = params;
            return {
              ok: true,
              data: {
                ...reference,
                items: ordinals.map((ordinal) => {
                  try {
                    const input = { ...reference, ordinal };
                    return {
                      ordinal,
                      ok: true as const,
                      data: indexFrame(input),
                    };
                  } catch (error) {
                    return { ordinal, ...operationFailure(error) };
                  }
                }),
              },
            };
          }
          case "model.list":
            return {
              ok: true,
              data: (() => {
                const page = models.page({
                  ...(operation.params.cursor === undefined
                    ? {}
                    : { cursor: operation.params.cursor }),
                  ...(operation.params.limit === undefined
                    ? {}
                    : { limit: operation.params.limit }),
                });
                return {
                  ...page,
                  models: page.models.map((model) => ({
                    ...model,
                    ...(model.generationProfile && typeof model.generationProfile === "object"
                      ? {
                          generationProfile: (() => {
                            const { id: profileId, ...profile } = model.generationProfile;
                            return {
                              ...profile,
                              ...(profileId === undefined ? {} : { profileId }),
                            };
                          })(),
                        }
                      : {}),
                  })),
                };
              })(),
            };
          case "preset.list":
            return {
              ok: true,
              data: (() => {
                const page = presets.page({
                  ...(operation.params.cursor === undefined
                    ? {}
                    : { cursor: operation.params.cursor }),
                  ...(operation.params.limit === undefined
                    ? {}
                    : { limit: operation.params.limit }),
                });
                return {
                  ...page,
                  presets: page.presets.map(({ id, ...preset }) => ({ ...preset, presetId: id })),
                  refresh: {
                    ...page.refresh,
                    state: page.refresh.error
                      ? "failed"
                      : page.refresh.checkedAt
                        ? "ready"
                        : "idle",
                    jobId: null,
                  },
                };
              })(),
            };
          case "preset.get":
            return {
              ok: true,
              data: (() => {
                const { id, ...details } = presets.get(operation.params.presetId);
                return {
                  ...details,
                  files: details.files.map(({ bytes, ...file }) => ({ ...file, sizeBytes: bytes })),
                  presetId: id,
                };
              })(),
            };
          case "preset.update":
            return {
              ok: true,
              data: await (async () => {
                const result = await presets.update(
                  operation.params.presetId,
                  operation.params.requestId,
                );
                return {
                  ...result,
                  ...(result.report
                    ? {
                        report: {
                          ...result.report,
                          skipped: result.report.skipped.map(({ id, ...item }) => ({
                            ...item,
                            presetId: id,
                          })),
                        },
                      }
                    : {}),
                  state: "ready",
                  jobId: null,
                };
              })(),
            };
          case "preset.create":
            return {
              ok: true,
              data: await (async () => {
                const { id, ...result } = await presets.create({
                  requestId: operation.params.requestId,
                  name: operation.params.name,
                  ...(operation.params.references === undefined
                    ? {}
                    : { references: operation.params.references }),
                });
                return { ...result, presetId: id };
              })(),
            };
          case "preset.delete":
            return {
              ok: true,
              data: await presets.delete(operation.params.presetId, operation.params.requestId),
            };
          case "model.status": {
            const model = await models.status(operation.params.modelId);
            return {
              ok: true,
              data: {
                modelId: operation.params.modelId,
                purpose: models.list().find((entry) => entry.modelId === operation.params.modelId)
                  ?.purpose,
                presence: modelPresence(operation.params.modelId, model.state),
                jobId: null,
                ...model,
              },
            };
          }
          case "model.prepare": {
            const { modelId } = operation.params;
            const state = await models.status(modelId);
            if (state.state !== "ready" && state.state !== "preparing") {
              const preparing = models
                .prepare(modelId, modelLifetime.signal, operation.params)
                .catch((error) => {
                  if (!modelLifetime.signal.aborted) console.error(error);
                });
              modelPreparations.add(preparing);
              void preparing.finally(() => {
                modelPreparations.delete(preparing);
                admission.progress();
              });
            }
            const model = await models.status(modelId);
            return {
              ok: true,
              data: { jobId: null, presence: modelPresence(modelId, model.state), ...model },
            };
          }
          case "model.remove": {
            const { modelId, requestId } = operation.params;
            // Resolve registration before consulting running work so an unknown identity always
            // has the model-specific NOT_FOUND contract.
            models.presence(modelId);
            if (jobs!.hasRunningModelRequest(modelId))
              throw new CatalogError("MODEL_IN_USE", "A running job is using this model", {
                modelId,
              });
            return { ok: true, data: await models.remove(modelId, requestId) };
          }
          case "alignment.observe": {
            const params = operation.params;
            if ("projectId" in params) {
              const { sourceRange, ...projectParams } = params;
              const status = alignments.prepareProject({ ...projectParams, range: sourceRange });
              return {
                ok: true,
                data: {
                  ...status,
                  tap: params.tap,
                  published: publishedOutput(status.published, (value) => value.evidence),
                },
              };
            }
            const status = alignments.prepareSource(params);
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.evidence),
              },
            };
          }
          case "alignment.get": {
            const params = operation.params;
            if ("projectId" in params) {
              const composition = projectComposition(projects, assets, {
                projectId: params.projectId,
                revisionId: params.revisionId,
              });
              const prepared = preparedAudio.resolve(
                composition,
                params.tap,
                params.preparedResourceId,
              );
              if (!prepared)
                throw new CatalogError("NOT_READY", "Prepared project tap is not ready", {
                  projectId: params.projectId,
                  revisionId: composition.revisionId,
                  preparedResourceId: params.preparedResourceId,
                });
              // The display range is a project read range: clamped to the revision, with its issue.
              const admitted = admitProjectRange(composition.model.durationUs, params.range),
                range = admitted.range;
              const identity = {
                  owner: { kind: "asset" as const, assetId: params.assetId },
                  generation: params.generation,
                  policy: "alignment-v1" as const,
                },
                metadata = alignmentRecords.metadata(identity),
                query = {
                  view: params.view,
                  sourceRange: params.sourceRange,
                  thresholdRMS: params.thresholdRMS,
                  limit: params.limit,
                  cursor:
                    params.cursor === undefined
                      ? undefined
                      : (pageCursor.decode(
                          "alignment.get",
                          params.cursor,
                          pageFilters(operation.params),
                        ) as string),
                },
                sourcePage = new SourceAlignmentRead(
                  alignmentRecords,
                  metadata,
                  JSON.stringify({
                    projectId: params.projectId,
                    revisionId: composition.revisionId,
                    tap: params.tap,
                    preparedResourceId: prepared.resourceId,
                    range,
                    trackIds: params.trackIds ?? null,
                  }),
                ).page(query),
                occurrences = createSourceRangeProjection(composition.model).window({
                  range,
                  ...(params.trackIds === undefined ? {} : { trackIds: params.trackIds }),
                }),
                rows =
                  "rows" in sourcePage
                    ? metadata.owner.assetId === prepared.audio.assetId
                      ? projectTapAlignmentRows(sourcePage.rows, range)
                      : projectAlignmentRows(
                          sourcePage.rows,
                          occurrences.filter(
                            (occurrence) =>
                              occurrence.assetId === metadata.owner.assetId &&
                              occurrence.streamId === metadata.source.streamId &&
                              (occurrence.acquisitionId ?? null) === metadata.source.acquisitionId,
                          ),
                        )
                    : [];
              return {
                ok: true,
                data: {
                  projectId: params.projectId,
                  revisionId: composition.revisionId,
                  preparedResourceId: prepared.resourceId,
                  state: "ready",
                  generation: params.generation,
                  issues: admitted.issues,
                  view: sourcePage.view,
                  rows,
                  nextCursor: sourcePage.nextCursor,
                },
              };
            }
            const { assetId, generation, packageHandle, cursor, ...queryParams } = params;
            const query = {
              ...queryParams,
              ...(cursor === undefined
                ? {}
                : {
                    cursor: pageCursor.decode(
                      "alignment.get",
                      cursor,
                      pageFilters(operation.params),
                    ),
                  }),
            };
            if (packageHandle)
              return {
                ok: true,
                data: pageEnvelope(
                  projectPackages.sourceAlignment(
                    packageHandle,
                    assetId,
                    generation,
                    query as never,
                  ),
                  "alignment.get",
                  pageFilters(operation.params),
                ),
              };
            const identity = {
              owner: { kind: "asset" as const, assetId },
              generation,
              policy: "alignment-v1" as const,
            };
            const metadata = (() => {
              try {
                return alignmentRecords.metadata(identity);
              } catch (error) {
                if (
                  query.view === "raw" &&
                  error instanceof CatalogError &&
                  error.code === "NOT_READY"
                )
                  return alignmentRecords.capturedMetadata(identity);
                throw error;
              }
            })();
            const page = new SourceAlignmentRead(alignmentRecords, metadata).page(query as never);
            return {
              ok: true,
              data: {
                assetId,
                state: "wordCount" in metadata ? "ready" : "captured",
                generation,
                ...page,
                nextCursor:
                  page.nextCursor === null
                    ? null
                    : pageCursor.encode(
                        "alignment.get",
                        page.nextCursor,
                        pageFilters(operation.params),
                      ),
              },
            };
          }
          case "speaker.continuity.prepare": {
            const { candidate, ...request } = operation.params;
            if (!candidate) {
              return {
                ok: true,
                data: {
                  ...request,
                  state: "unavailable",
                  reason: "continuity_candidate_required",
                  retryable: false,
                  receipt: null,
                },
              };
            }
            const receipt = evaluateSpeakerContinuity(candidate);
            if (
              candidate.identity.modelId !== request.modelId ||
              candidate.metrics.expectedSpeakerCount !== request.expectedSpeakerCount
            )
              throw new CatalogError(
                "INVALID_PARAMS",
                "Continuity candidate identity does not match the requested provider",
              );
            continuityReceipts.set(
              `${request.assetId}:${request.streamId}:${request.channel}:${request.modelId}:${candidate.identity.generation}`,
              { receipt, sourceRange: request.sourceRange },
            );
            return {
              ok: true,
              data: {
                ...request,
                state: "ready",
                reason: receipt.status === "accepted" ? null : "continuity_quality_gate",
                retryable: false,
                receipt,
              },
            };
          }
          case "speaker.continuity.get": {
            if (operation.params.packageHandle)
              return operationError(
                "NOT_READY",
                "Continuity package reads are not available for service-local receipts",
              );
            const key = `${operation.params.assetId}:${operation.params.streamId}:${operation.params.channel}:${operation.params.modelId}:${operation.params.generation}`;
            const retained = continuityReceipts.get(key);
            if (retained) {
              if (
                retained.sourceRange.startUs !== operation.params.sourceRange.startUs ||
                retained.sourceRange.endUs !== operation.params.sourceRange.endUs
              )
                throw new CatalogError(
                  "ARTIFACT_CHANGED",
                  "Speaker continuity read changed its observation range",
                );
              return {
                ok: true,
                data: {
                  ...operation.params,
                  state: "ready",
                  reason:
                    retained.receipt.status === "accepted"
                      ? "continuity_not_promoted"
                      : "continuity_quality_gate",
                  retryable: false,
                  receipt: retained.receipt,
                },
              };
            }
            return {
              ok: true,
              data: {
                ...operation.params,
                state: "unavailable",
                reason: "continuity_not_published",
                retryable: false,
                receipt: null,
              },
            };
          }
          case "speaker.observe": {
            const params = operation.params;
            const status = speakers.prepareSource(params);
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.evidence),
              },
            };
          }
          case "speaker.get": {
            if ("projectId" in operation.params) {
              if (operation.params.packageHandle !== undefined)
                return {
                  ok: true,
                  data: pageEnvelope(
                    projectPackages.projectSpeakers(
                      operation.params.packageHandle,
                      (() => {
                        const input = { ...operation.params };
                        delete input.packageHandle;
                        delete input.view;
                        return input;
                      })(),
                    ),
                    "speaker.get",
                    pageFilters(operation.params),
                  ),
                };
              const result = await projectEvidence.speakers(operation.params);
              const labelsByGeneration = new Map<string, Map<number, string>>();
              const rows = result.page?.rows.map((row: any) => {
                const key = `${row.assetId}:${row.generation}`;
                let labels = labelsByGeneration.get(key);
                if (!labels) {
                  labels = new Map(
                    speakerLabels
                      .read({
                        owner: { kind: "asset", assetId: row.assetId },
                        sourceId: row.assetId,
                        generation: row.generation,
                        policy: "speaker-v1",
                      })
                      .map((binding) => [binding.slot, binding.displayName]),
                  );
                  labelsByGeneration.set(key, labels);
                }
                return labels.has(row.slot) ? { ...row, label: labels.get(row.slot)! } : row;
              });
              return {
                ok: true,
                data: pageEnvelope(
                  {
                    ...result,
                    ...(result.page === null || rows === undefined
                      ? {}
                      : { page: { ...result.page, rows } }),
                  },
                  "speaker.get",
                  pageFilters(operation.params),
                ),
              };
            }
            const { sourceRange, view, limit, cursor, packageHandle, ...selection } =
              operation.params;
            const decodedSpeakerCursor =
              cursor === undefined
                ? undefined
                : (pageCursor.decode(
                    "speaker.get",
                    cursor,
                    pageFilters(operation.params),
                  ) as string);
            if (packageHandle !== undefined)
              return {
                ok: true,
                data: pageEnvelope(
                  projectPackages.sourceSpeakers(
                    packageHandle,
                    { ...selection, sourceRange: sourceRange },
                    {
                      ...(sourceRange === undefined ? {} : { sourceRange }),
                      ...(view === undefined ? {} : { view }),
                      ...(limit === undefined ? {} : { limit }),
                      ...(decodedSpeakerCursor === undefined
                        ? {}
                        : { cursor: decodedSpeakerCursor }),
                    },
                  ),
                  "speaker.get",
                  pageFilters(operation.params),
                ),
              };
            const current = speakers.sourceStatus({ ...selection, sourceRange: sourceRange });
            if (!current.published) {
              if (cursor)
                throw new CatalogError(
                  "ARTIFACT_CHANGED",
                  "Speaker observation is no longer published",
                );
              return { ok: true, data: { ...current } };
            }
            const metadata = current.published.evidence;
            const labels = new Map(
              speakerLabels.read(metadata).map((binding) => [binding.slot, binding.displayName]),
            );
            const page = new SourceSpeakerRead(
              speakerRecords,
              metadata,
              JSON.stringify([...labels.entries()]),
            ).page({
              ...(sourceRange === undefined ? {} : { sourceRange }),
              ...(view === undefined ? {} : { view }),
              ...(limit === undefined ? {} : { limit }),
              ...(decodedSpeakerCursor === undefined ? {} : { cursor: decodedSpeakerCursor }),
            });
            const labeledPage =
              view === "scores"
                ? page
                : {
                    ...page,
                    rows: page.rows.map((row) =>
                      "slot" in row && labels.has(row.slot)
                        ? { ...row, label: labels.get(row.slot)! }
                        : row,
                    ),
                  };
            return {
              ok: true,
              data: {
                ...selection,
                state: "ready",
                generation: metadata.generation,
                ...labeledPage,
                nextCursor:
                  labeledPage.nextCursor === null
                    ? null
                    : pageCursor.encode(
                        "speaker.get",
                        labeledPage.nextCursor,
                        pageFilters(operation.params),
                      ),
              },
            };
          }
          case "speaker.bind": {
            const {
              sourceRange,
              generation,
              bindings,
              requestId,
              expectedBindingDigest,
              ...selection
            } = operation.params;
            const current = speakers.sourceStatus({ ...selection, sourceRange: sourceRange });
            if (!current.published || current.published.evidence.generation !== generation)
              throw new CatalogError(
                "ARTIFACT_CHANGED",
                "Speaker generation is no longer published",
              );
            const metadata = current.published.evidence;
            const labels = speakerLabels.bind(metadata, bindings, requestId, expectedBindingDigest);
            return {
              ok: true,
              data: { ...selection, sourceRange, generation, bindings: labels },
            };
          }
          case "join.verify": {
            const composition = projectComposition(projects, assets, operation.params);
            return {
              ok: true,
              data: await verifyJoin(operation.params, {
                composition,
                preparedAudio,
                alignments: alignmentRecords,
                renderedSpeech,
                signal: requestSignal,
              }),
            };
          }
          case "transcript.render.prepare": {
            const status = renderedSpeech.prepare(operation.params);
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.speech),
              },
            };
          }
          case "transcript.render.get": {
            const { cursor, ...params } = operation.params;
            const decoded =
              cursor === undefined
                ? undefined
                : (pageCursor.decode(
                    "transcript.render.get",
                    cursor,
                    pageFilters(operation.params),
                  ) as {
                    generation: string;
                    sourceCursor: unknown;
                  });
            return {
              ok: true,
              data: pageEnvelope(
                renderedSpeech.get({
                  ...params,
                  // The continuation keeps its own generation so a different request refuses.
                  ...(decoded === undefined ? {} : { cursor: decoded }),
                }),
                "transcript.render.get",
                pageFilters(operation.params),
              ),
            };
          }
          case "transcript.import": {
            const source: ImportedTranscriptSource = {
              assetId: operation.params.assetId,
              streamId: operation.params.streamId,
              ...(operation.params.acquisitionId === undefined
                ? {}
                : { acquisitionId: operation.params.acquisitionId }),
            };
            const imported = await importedTranscripts.importPath(
              operation.params.requestId,
              source,
              operation.params.path,
              operation.params.format,
              operation.params.timingPolicy,
              operation.params.timingPolicy === "align"
                ? {
                    modelId: operation.params.modelId ?? "nemo-ctc110",
                    channel: operation.params.channel ?? 0,
                  }
                : undefined,
            );
            const alignment =
              operation.params.timingPolicy === "align"
                ? imported.cues.map((cue) => {
                    const status = alignments.prepareSource({
                      ...source,
                      channel: operation.params.channel ?? 0,
                      sourceRange: cue.source,
                      text: cue.text,
                      modelId: operation.params.modelId ?? "nemo-ctc110",
                    });
                    return { cueId: cue.id, ...status };
                  })
                : undefined;
            return {
              ok: true,
              data: {
                ...importedAlignmentView(
                  imported,
                  alignments,
                  alignmentRecords,
                  operation.params.channel ?? 0,
                  operation.params.modelId ?? "nemo-ctc110",
                ),
                ...(alignment === undefined ? {} : { alignment }),
                published: { generation: imported.generation, issues: [] },
              },
            };
          }
          case "transcript.transcribe": {
            transcripts.prepareSource(operation.params);
            const status = transcripts.sourceStatus(operation.params);
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.transcript),
              },
            };
          }
          case "transcript.disfluency.get": {
            const { generation, range, limit, cursor, ...selection } = operation.params;
            const page = filteredPage("transcript.disfluency.get", {
              cursor,
              limit,
              filters: pageFilters(operation.params),
            });
            const disfluent = (kind: string) => ["filler", "vocalization"].includes(kind);
            const source: ImportedTranscriptSource = {
              assetId: selection.assetId,
              streamId: selection.streamId,
              ...(selection.acquisitionId === undefined
                ? {}
                : { acquisitionId: selection.acquisitionId }),
            };
            const imported =
              generation === undefined
                ? importedTranscripts.find(source)
                : (() => {
                    try {
                      return importedTranscripts.get(source, generation);
                    } catch (error) {
                      if (error instanceof CatalogError && error.code === "NOT_FOUND") return null;
                      throw error;
                    }
                  })();
            if (imported) {
              const rows = imported.cues.flatMap((cue) =>
                cue.words
                  .filter(
                    (word) =>
                      !range ||
                      (word.source.endUs > range.startUs && word.source.startUs < range.endUs),
                  )
                  .filter((word) => disfluent(wordKind(word.text)))
                  .map((word) => ({
                    type: "word" as const,
                    text: word.text,
                    sourceRange: word.source,
                    kind: wordKind(word.text),
                  })),
              );
              return {
                ok: true,
                data: {
                  state: "ready",
                  generation: imported.generation,
                  method: "word-kind-v1",
                  coverage: "complete",
                  ...page.read(imported.generation, () => ({ rows, nextCursor: null })),
                },
              };
            }
            const current = transcripts.sourceStatus({
              ...selection,
              ...(generation ? { generation } : {}),
            });
            if (!current.published) return { ok: true, data: { ...current } };
            const read = new SourceTranscriptRead(transcriptStore, current.published.transcript);
            return {
              ok: true,
              data: {
                state: "ready",
                generation: current.published.transcript.generation,
                method: "word-kind-v1",
                coverage: "complete",
                ...page.read(
                  current.published.transcript.generation,
                  (sourceCursor) =>
                    read.page({
                      range,
                      limit: 1000,
                      ...(sourceCursor === undefined ? {} : { cursor: sourceCursor as never }),
                    }),
                  (row) => row.type === "word" && disfluent(row.kind),
                ),
              },
            };
          }
          case "transcript.get":
          case "transcript.search": {
            const params = operation.params;
            if ("projectId" in params) {
              const normalizedParams = {
                ...params,
                ...(params.speakerGenerations === undefined
                  ? {}
                  : {
                      speakerGenerations: params.speakerGenerations.map((speaker) => ({
                        ...speaker,
                        observationRange:
                          (speaker as { sourceRange?: unknown }).sourceRange ??
                          (speaker as { observationRange?: unknown }).observationRange,
                      })) as never,
                    }),
              };
              const projectParams =
                params.cursor === undefined
                  ? normalizedParams
                  : {
                      ...normalizedParams,
                      cursor: pageCursor.decode(
                        operation.operation,
                        params.cursor,
                        pageFilters(operation.params),
                      ),
                    };
              return {
                ok: true,
                data:
                  "text" in params
                    ? pageEnvelope(
                        await projectEvidence.search(projectParams as never),
                        "transcript.search",
                        pageFilters(operation.params),
                      )
                    : pageEnvelope(
                        await projectEvidence.get(projectParams as never),
                        "transcript.get",
                        pageFilters(operation.params),
                      ),
              };
            }
            const selection = {
              assetId: params.assetId,
              streamId: params.streamId,
              ...(params.acquisitionId === undefined
                ? {}
                : { acquisitionId: params.acquisitionId }),
            };
            const transcriptPosition =
              params.cursor === undefined
                ? undefined
                : (pageCursor.decode(
                    operation.operation,
                    params.cursor,
                    pageFilters(operation.params),
                  ) as {
                    generation?: unknown;
                    sourceCursor?: unknown;
                    speaker?: TranscriptSpeakerCursor;
                  });
            const generation =
              params.generation ?? (transcriptPosition?.generation as string | undefined);
            const sourceParams = params as typeof params & {
              speaker?: TranscriptSpeakerRequest;
              cursor?: { speaker?: TranscriptSpeakerCursor } & Record<string, unknown>;
            };
            // The cursor binds the speaker request as a filter and keeps the binding digest as a pin.
            const cursorSpeaker = transcriptPosition?.speaker;
            const speakerRequest = sourceParams.speaker;
            const importedSource: ImportedTranscriptSource = {
              assetId: selection.assetId,
              streamId: selection.streamId,
              ...(selection.acquisitionId === undefined
                ? {}
                : { acquisitionId: selection.acquisitionId }),
            };
            const imported =
              generation === undefined
                ? importedTranscripts.find(importedSource)
                : (() => {
                    try {
                      return importedTranscripts.get(importedSource, generation);
                    } catch (error) {
                      if (error instanceof CatalogError && error.code === "NOT_FOUND") return null;
                      throw error;
                    }
                  })();
            if (imported) {
              const joined =
                imported.timingPolicy === "align"
                  ? importedAlignmentView(
                      imported,
                      alignments,
                      alignmentRecords,
                      imported.alignment?.channel ?? 0,
                      imported.alignment?.modelId ?? "nemo-ctc110",
                    )
                  : imported;
              if ("text" in params) {
                const terms = params.text
                  .trim()
                  .split(/\s+/)
                  .map((term) => term.toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, ""))
                  .filter(Boolean);
                return {
                  ok: true,
                  data: {
                    state: "ready",
                    generation: imported.generation,
                    origin: imported.origin,
                    entries: joined.cues
                      .filter((cue) => {
                        const words = (
                          cue.words.length
                            ? cue.words.map((word) => word.text)
                            : cue.text.split(/\s+/)
                        ).map((word) =>
                          word.toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, ""),
                        );
                        return (
                          terms.length > 0 &&
                          words.some((_, index) =>
                            terms.every((term, offset) => words[index + offset] === term),
                          )
                        );
                      })
                      .slice(0, params.limit ?? 100)
                      .map((cue) => ({
                        wordIds: cue.words.map((_, index) => `imported:${cue.ordinal}:${index}`),
                        sourceRange: cue.source,
                      })),
                    nextCursor: null,
                  },
                };
              }
              const sourceRange = sourceRangeAsMicroseconds(params.sourceRange);
              const rows = joined.cues
                .filter(
                  (cue) =>
                    !sourceRange ||
                    (cue.source.endUs > sourceRange.startUs &&
                      cue.source.startUs < sourceRange.endUs),
                )
                .slice(0, params.limit ?? 250)
                .map((cue) => ({
                  type: "cue" as const,
                  id: cue.id,
                  ordinal: cue.ordinal,
                  text: cue.text,
                  sourceRange: cue.source,
                  ...(cue.speaker === undefined
                    ? { speaker: { state: "unknown" as const } }
                    : { speaker: { state: "named" as const, name: cue.speaker } }),
                  words: cue.words,
                }));
              return {
                ok: true,
                data: {
                  state: "ready",
                  generation: imported.generation,
                  origin: imported.origin,
                  rows,
                  nextCursor: null,
                },
              };
            }
            const current = transcripts.sourceStatus({
              ...selection,
              ...(generation === undefined ? {} : { generation }),
            });
            if (!current.published) {
              if (params.cursor)
                throw new CatalogError(
                  "ARTIFACT_CHANGED",
                  "Transcript generation is no longer published",
                );
              return { ok: true, data: { ...current } };
            }
            const metadata = current.published.transcript;
            const read = new SourceTranscriptRead(transcriptStore, metadata);
            const sourceCursor = transcriptPosition?.sourceCursor as
              | Record<string, unknown>
              | undefined;
            const { issues, ...page } =
              "text" in params
                ? {
                    ...read.search({
                      text: params.text,
                      cursor: sourceCursor,
                      limit: params.limit,
                    }),
                    issues: [],
                  }
                : read.page({
                    range: sourceRangeAsMicroseconds(params.sourceRange),
                    cursor: sourceCursor,
                    limit: params.limit,
                  });
            let attributedPage = page;
            let pinnedSpeaker: TranscriptSpeakerCursor | undefined;
            if (speakerRequest && "rows" in page) {
              const speakerStatus = speakers.sourceStatus({
                assetId: selection.assetId,
                streamId: speakerRequest.streamId,
                ...(speakerRequest.acquisitionId === undefined
                  ? {}
                  : { acquisitionId: speakerRequest.acquisitionId }),
                channel: speakerRequest.channel,
                modelId: speakerRequest.modelId,
                sourceRange: speakerRequest.sourceRange,
              });
              if (!speakerStatus.published) {
                throw dependencyRefusal(
                  "NOT_READY",
                  "Speaker evidence is not ready for transcript attribution",
                  {},
                  speakerStatus.retryable,
                );
              }
              if (speakerStatus.published.evidence.generation !== speakerRequest.generation)
                throw new CatalogError(
                  "ARTIFACT_CHANGED",
                  "Transcript attribution generation is no longer published",
                );
              const labels = new Map(
                speakerLabels
                  .read(speakerStatus.published.evidence)
                  .map((binding) => [binding.slot, binding.displayName]),
              );
              const bindingDigest = createHash("sha256")
                .update(JSON.stringify([...labels.entries()]))
                .digest("hex");
              if (cursorSpeaker?.bindingDigest && cursorSpeaker.bindingDigest !== bindingDigest)
                throw new CatalogError("ARTIFACT_CHANGED", "Transcript attribution labels changed");
              pinnedSpeaker = { ...speakerRequest, bindingDigest };
              const speakerRead = new SourceSpeakerRead(
                speakerRecords,
                speakerStatus.published.evidence,
                JSON.stringify([...labels.entries()]),
              );
              const turns: { slot: number; sourceRange: SelectionRange }[] = [];
              let speakerCursor: string | undefined;
              do {
                const speakerPage = speakerRead.page({
                  view: "intervals",
                  sourceRange: speakerRequest.sourceRange,
                  limit: 1000,
                  ...(speakerCursor === undefined ? {} : { cursor: speakerCursor }),
                });
                turns.push(
                  ...speakerPage.rows
                    .filter(
                      (row): row is Extract<(typeof speakerPage.rows)[number], { slot: number }> =>
                        "slot" in row,
                    )
                    .map((row) => ({ slot: row.slot, sourceRange: row.sourceRange })),
                );
                speakerCursor = speakerPage.nextCursor ?? undefined;
              } while (speakerCursor);
              const words = page.rows
                .filter((row) => row.type === "word")
                .map((row) => ({ ...row, id: row.wordId }));
              const decorated = attributeTranscriptWords(words, turns, { labels });
              const byId = new Map(decorated.map((word) => [word.id, word.speaker]));
              attributedPage = {
                ...page,
                rows: page.rows.map((row) =>
                  row.type === "word" ? { ...row, speaker: byId.get(row.wordId)! } : row,
                ),
              };
            }
            return {
              ok: true,
              data: {
                ...selection,
                state: "ready",
                generation: metadata.generation,
                issues,
                published: sourceTranscriptPublication(current.published),
                transcript: publicTranscriptMetadata(metadata),
                ...(attributedPage.nextCursor === null
                  ? { nextCursor: null }
                  : {
                      nextCursor: pageCursor.encode(
                        operation.operation,
                        {
                          generation: metadata.generation,
                          sourceCursor: attributedPage.nextCursor,
                          ...(pinnedSpeaker === undefined ? {} : { speaker: pinnedSpeaker }),
                        },
                        pageFilters(operation.params),
                      ),
                    }),
                ...("rows" in attributedPage
                  ? { rows: attributedPage.rows }
                  : { entries: attributedPage.entries }),
              },
            };
          }
          case "transcript.review": {
            const params = operation.params;
            if ("projectId" in params) {
              const normalizedParams = {
                ...params,
                ...(params.speakerGenerations === undefined
                  ? {}
                  : {
                      speakerGenerations: params.speakerGenerations.map((speaker) => ({
                        ...speaker,
                        observationRange:
                          (speaker as { sourceRange?: unknown }).sourceRange ??
                          (speaker as { observationRange?: unknown }).observationRange,
                      })) as never,
                    }),
              };
              const projectParams =
                params.cursor === undefined
                  ? normalizedParams
                  : {
                      ...normalizedParams,
                      cursor: pageCursor.decode(
                        "transcript.review",
                        params.cursor,
                        pageFilters(operation.params),
                      ),
                    };
              const requested = projectEvidence.request({
                ...projectParams,
                prepare: true,
              } as never);
              const pending = requested.dependencies.filter(
                (dependency) =>
                  dependency.state === "unavailable" && dependency.reason === "model_not_prepared",
              );
              if (pending.length) {
                const model = ensureReviewModel();
                return {
                  ok: true,
                  data: {
                    ...requested,
                    state:
                      model.state === "ready"
                        ? "not_ready"
                        : model.state === "failed"
                          ? "failed"
                          : "preparing",
                    model,
                  },
                };
              }
              for (const dependency of requested.dependencies) {
                if (dependency.transcript || dependency.reason === "no_audio") continue;
                transcripts.prepareSource(dependency.selection);
              }
              const ready = projectEvidence.request({ ...projectParams, prepare: true } as never);
              if (!ready.published) return { ok: true, data: { ...ready } };
              return {
                ok: true,
                data: pageEnvelope(
                  await projectEvidence.get(projectParams as never),
                  "transcript.review",
                  pageFilters(operation.params),
                ),
              };
            }
            const selection = {
              assetId: params.assetId,
              streamId: params.streamId,
              ...(params.acquisitionId === undefined
                ? {}
                : { acquisitionId: params.acquisitionId }),
            };
            // Decode before any readiness work so another filter set never reaches a transcript.
            const reviewCursor =
              params.cursor === undefined
                ? undefined
                : pageCursor.decode("transcript.review", params.cursor, pageFilters(params));
            const reviewRange = sourceRangeAsMicroseconds(params.sourceRange);
            const reviewSelection = {
              ...selection,
              ...(reviewRange === undefined ? {} : { sourceRange: reviewRange }),
            };
            let current = transcripts.sourceStatus(reviewSelection);
            if (current.reason === "no_audio") return { ok: true, data: { ...current } };
            if (current.reason === "model_not_prepared") {
              const model = ensureReviewModel();
              return {
                ok: true,
                data: {
                  ...current,
                  state: model.state === "failed" ? "failed" : "preparing",
                  model,
                },
              };
            }
            if (!current.published && current.state === "not_requested") {
              transcripts.prepareSource(reviewSelection);
              current = transcripts.sourceStatus(reviewSelection);
            }
            if (!current.published) return { ok: true, data: { ...current } };
            const metadata = current.published.transcript;
            const read = new SourceTranscriptRead(transcriptStore, metadata);
            const { issues, ...page } = read.page({
              range: reviewRange,
              limit: params.limit,
              ...(reviewCursor === undefined ? {} : { cursor: reviewCursor as never }),
            });
            return {
              ok: true,
              data: {
                ...selection,
                state: "ready",
                generation: metadata.generation,
                issues,
                published: sourceTranscriptPublication(current.published),
                transcript: publicTranscriptMetadata(metadata),
                ...page,
                nextCursor:
                  page.nextCursor === null
                    ? null
                    : pageCursor.encode(
                        "transcript.review",
                        page.nextCursor,
                        pageFilters(operation.params),
                      ),
              },
            };
          }
          case "timeline.events":
          case "cursor.raw": {
            const params = operation.params;
            const method = operation.operation === "timeline.events" ? "events" : "cursor";
            const normalized =
              params.cursor === undefined
                ? params
                : {
                    ...params,
                    cursor: pageCursor.decode(
                      operation.operation,
                      params.cursor,
                      pageFilters(operation.params),
                    ),
                  };
            if ("projectId" in normalized)
              return {
                ok: true,
                data: pageEnvelope(
                  await projectEvidence[method](normalized as never),
                  operation.operation,
                  pageFilters(operation.params),
                ),
              };
            if ("assetId" in params)
              return {
                ok: true,
                data: pageEnvelope(
                  method === "events"
                    ? sourceEvents.events(normalized as never)
                    : capture.cursor(normalized as never),
                  operation.operation,
                  pageFilters(operation.params),
                ),
              };
            return operationError(
              "NOT_READY",
              "This service inspects asset and project capture evidence",
            );
          }
          case "frame.get": {
            const params = operation.params;
            return {
              ok: true,
              data: frameDelivery(mediaFrames.request(params)),
            };
          }
          case "frame.batch": {
            const params = operation.params;
            const identity =
              "projectId" in params
                ? {
                    projectId: params.projectId,
                    revisionId: projects.revision(params.projectId, params.revisionId).revisionId,
                  }
                : {
                    assetId: params.assetId,
                    streamId: params.streamId,
                    ...(params.acquisitionId === undefined
                      ? {}
                      : { acquisitionId: params.acquisitionId }),
                  };
            return {
              ok: true,
              data: {
                ...identity,
                items: params.atUs.map((atUs) => {
                  try {
                    return {
                      atUs,
                      ok: true,
                      data: frameDelivery(
                        mediaFrames.request({
                          ...params,
                          ...identity,
                          atUs,
                        }),
                      ),
                    };
                  } catch (error) {
                    return { atUs, ...operationFailure(error) };
                  }
                }),
              },
            };
          }
          case "cursor.render": {
            const params = operation.params;
            const identity =
              "projectId" in params
                ? {
                    projectId: params.projectId,
                    revisionId: projects.revision(params.projectId, params.revisionId).revisionId,
                  }
                : {
                    assetId: params.assetId,
                    streamId: params.streamId,
                    ...(params.acquisitionId === undefined
                      ? {}
                      : { acquisitionId: params.acquisitionId }),
                  };
            return {
              ok: true,
              data: {
                ...identity,
                trailUs: params.trailUs,
                items: params.atUs.map((atUs) => {
                  try {
                    const input = { ...params, ...identity, atUs, cursorTrailUs: params.trailUs };
                    return {
                      atUs,
                      ok: true,
                      data: frameDelivery(mediaFrames.request(input)),
                    };
                  } catch (error) {
                    return { atUs, ...operationFailure(error) };
                  }
                }),
              },
            };
          }
          case "waveform.get":
          case "spectrogram.get": {
            const spectrum = operation.operation === "spectrogram.get";
            const params = internalAudioSelection(operation.params);
            const status = await acoustics.request(
              spectrum ? { ...params, kind: "spectrum", format: "image" } : params,
            );
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.artifact),
                delivery: status.published
                  ? delivery.open(
                      "projectId" in status
                        ? { kind: "project", id: status.projectId }
                        : { kind: "asset", id: status.assetId },
                      () => cache.acquire(status.published!.artifact.cacheId),
                    )
                  : null,
              },
            };
          }
          case "voice.generate": {
            const status = await generatedVoice.request(operation.params);
            return {
              ok: true,
              data: {
                ...operation.params,
                ...status,
                published: publishedOutput(
                  status.published,
                  (value) => JSON.parse(value.result) as unknown,
                ),
              },
            };
          }
          case "audio.extract": {
            const status = extractedAudio.request(internalAudioSelection(operation.params));
            return {
              ok: true,
              data: {
                ...operation.params,
                ...status,
                published: publishedOutput(
                  status.published,
                  (value) => JSON.parse(value.result) as unknown,
                ),
              },
            };
          }
          case "audio.prepare": {
            const prepared = await preparedAudio.request(operation.params);
            return {
              ok: true,
              data: {
                ...operation.params,
                ...prepared,
                published: publishedOutput(
                  prepared.published,
                  (value) => JSON.parse(value.result) as unknown,
                ),
              },
            };
          }
          case "audio.measure": {
            const measureParams = operation.params;
            const status = await acoustics.request({
              ...internalAudioSelection(measureParams),
              kind: "loudness",
            });
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.artifact),
                delivery: status.published
                  ? delivery.open(
                      "projectId" in status
                        ? { kind: "project", id: status.projectId }
                        : { kind: "asset", id: status.assetId },
                      () => cache.acquire(status.published!.artifact.cacheId),
                    )
                  : null,
              },
            };
          }
          case "audio.pause.get": {
            const { limit, cursor, ...selection } = operation.params;
            // Refuse a foreign continuation before admitting analysis work.
            const page = filteredPage("audio.pause.get", {
              cursor,
              limit,
              filters: pageFilters(operation.params),
            });
            const status = await acoustics.request({
              ...internalAudioSelection(selection),
              kind: "pause",
            });
            const allIntervals =
              status.published?.artifact.analysis.kind === "pause"
                ? status.published.artifact.analysis.intervals
                : [];
            const { rows: intervals, nextCursor } = page.read(
              status.published ? status.published.generation : null,
              () => ({ rows: allIntervals, nextCursor: null }),
            );
            const published = status.published
              ? {
                  ...status.published,
                  artifact: {
                    ...status.published.artifact,
                    analysis: { ...status.published.artifact.analysis, intervals },
                  },
                }
              : null;
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(published, (value) => value.artifact),
                intervals,
                delivery: published
                  ? delivery.open(
                      "projectId" in status
                        ? { kind: "project", id: status.projectId }
                        : { kind: "asset", id: status.assetId },
                      () => cache.acquire(published.artifact.cacheId),
                    )
                  : null,
                nextCursor,
              },
            };
          }
          case "audio.get": {
            const params = operation.params;
            const status = await mediaAudio.request(internalAudioSelection(params));
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.audio),
                delivery: status.published
                  ? delivery.open(
                      "assetId" in params
                        ? { kind: "asset", id: params.assetId }
                        : { kind: "project", id: params.projectId },
                      () => cache.acquire(status.published!.audio.cacheId),
                    )
                  : null,
              },
            };
          }
          case "storage.usage":
            return { ok: true, data: await managedStorage.usage() };
          case "inspect.open": {
            const params = operation.params;
            const project = projects.get(params.projectId);
            const revision = projects.revision(params.projectId, params.revisionId);
            const history = projects.history(params.projectId, null, params.historyLimit ?? 50);
            let native: unknown = { opened: false, reason: "native_app_unavailable" };
            if (controller) {
              const answer = await controller.call("inspect.open", {
                projectId: params.projectId,
                // The preview window is titled by the project's name, not its identifier.
                title: project.title,
                revisionId: revision.revisionId,
                ...(params.range === undefined ? {} : { range: params.range }),
              });
              native = answer.ok ? answer.data : { opened: false, error: answer.error };
            }
            return {
              ok: true,
              data: {
                projectId: project.projectId,
                headRevisionId: project.currentRevisionId,
                revision,
                history: history.revisions.map((item) => ({
                  revisionId: item.revisionId,
                  ordinal: item.ordinal,
                  createdAt: item.createdAt,
                  operation: item.operation,
                })),
                nextCursor: history.nextCursor,
                range: params.range ?? null,
                native,
              },
            };
          }
          case "caption.propose":
            projects.requireRevision(operation.params.projectId, operation.params.revisionId);
            try {
              const {
                projectId,
                revisionId,
                range,
                trackIds,
                sourceGenerations,
                speakerGenerations,
                limit,
                trackId,
                canvas,
                style,
                constraints,
                corrections,
              } = operation.params;
              const transcript = await projectEvidence.get({
                projectId,
                revisionId,
                ...(range === undefined ? {} : { range }),
                ...(trackIds === undefined ? {} : { trackIds }),
                ...(sourceGenerations === undefined ? {} : { sourceGenerations }),
                ...(speakerGenerations === undefined
                  ? {}
                  : {
                      speakerGenerations: speakerGenerations.map(({ sourceRange, ...speaker }) => ({
                        ...speaker,
                        observationRange: sourceRange,
                      })),
                    }),
                limit,
                prepare: false,
              });
              if (transcript.state !== "ready" || !transcript.page) {
                throw new CatalogError(
                  "NOT_READY",
                  "The selected project transcript is not ready",
                  {
                    state: transcript.state,
                    reason: "reason" in transcript ? transcript.reason : null,
                    dependencies: transcript.dependencies,
                  },
                );
              }
              if (transcript.page.nextCursor !== null) {
                throw new CatalogError(
                  "LIMIT_EXCEEDED",
                  "Caption proposals need a complete bounded transcript range; narrow the range or lower the selected track set",
                  { limit: operation.params.limit },
                );
              }
              const rowIndexes = transcript.page.rows.flatMap((row: any, index: number) =>
                row.type === "word" ? [index] : [],
              );
              if (!rowIndexes.length) {
                throw new CatalogError(
                  "NOT_READY",
                  "The selected project transcript contains no word evidence",
                  { state: transcript.state },
                );
              }
              return {
                ok: true,
                data: captionProposals({
                  trackId,
                  canvas,
                  style,
                  constraints,
                  ...(corrections === undefined ? {} : { corrections }),
                  rowIndexes,
                  entry: {
                    state: transcript.state,
                    complete: true,
                    rows: transcript.page.rows,
                    identity: {
                      projectId,
                      revisionId,
                    },
                  },
                }),
              };
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && "message" in error)
                throw new CatalogError(
                  String(error.code),
                  String(error.message),
                  "details" in error && error.details && typeof error.details === "object"
                    ? (error.details as Record<string, unknown>)
                    : {},
                );
              throw error;
            }
          case "layout.diagnostics":
            projects.requireRevision(operation.params.projectId, operation.params.revisionId);
            return {
              ok: true,
              data: (() => {
                const diagnostics = layoutDiagnostics(
                  operation.params.samples.map((sample) => ({
                    ...sample,
                    texts: sample.texts.map(({ textId, ...text }) => ({ ...text, id: textId })),
                  })),
                  operation.params.maxIssueCount ?? 100,
                );
                return {
                  projectId: operation.params.projectId,
                  revisionId: operation.params.revisionId,
                  ...diagnostics,
                  coverage: (() => {
                    const { samples, ...coverage } = diagnostics.coverage;
                    return { ...coverage, sampleCount: samples };
                  })(),
                };
              })(),
            };
          case "project.create":
            return {
              ok: true,
              data: projects.create({
                requestId: operation.params.requestId,
                canvas: operation.params.canvas,
                ...(operation.params.title === undefined ? {} : { title: operation.params.title }),
              }),
            };
          case "project.duplicate":
            return {
              ok: true,
              data: projects.duplicate({
                requestId: operation.params.requestId,
                projectId: operation.params.projectId,
                ...(operation.params.revisionId === undefined
                  ? {}
                  : { revisionId: operation.params.revisionId }),
                ...(operation.params.title === undefined ? {} : { title: operation.params.title }),
              }),
            };
          case "project.delete":
            return {
              ok: true,
              data: await deletion!.delete(
                { kind: "project", id: operation.params.projectId },
                { requestId: operation.params.requestId },
              ),
            };
          case "project.get":
            return { ok: true, data: projects.get(operation.params.projectId) };
          case "project.list":
            return {
              ok: true,
              data: projects.list({
                ...(operation.params.cursor === undefined
                  ? {}
                  : { cursor: operation.params.cursor }),
                ...(operation.params.limit === undefined ? {} : { limit: operation.params.limit }),
              }),
            };
          case "text.seed":
            return {
              ok: true,
              data: projects.seedText(operation.params.projectId, operation.params),
            };
          case "edit.apply":
            return {
              ok: true,
              data: projects.apply(operation.params.projectId, operation.params),
            };
          case "speaker.correct":
            return {
              ok: true,
              data: {
                revision: projects.correctSpeakers(operation.params.projectId, {
                  ...operation.params,
                  corrections: operation.params.corrections.map(
                    ({ correctionId, ...correction }) => ({
                      ...correction,
                      id: correctionId,
                    }),
                  ),
                }),
              },
            };
          case "processing.get":
            return {
              ok: true,
              data: projects.processing(
                operation.params.projectId,
                operation.params.revisionId,
                operation.params.target,
              ),
            };
          case "output.capabilities":
            if (operation.params.kind === "audio")
              return { ok: true, data: audioOutputCapabilities };
            return {
              ok: true,
              data: outputCapabilities(
                nativeResult(await worker("media.outputCapabilities", {})) as Record<
                  string,
                  unknown
                >,
              ),
            };
          case "processing.capabilities":
            return { ok: true, data: preview.capabilities() };
          case "revision.get":
            return {
              ok: true,
              data: {
                projectId: operation.params.projectId,
                revision: projects.revision(
                  operation.params.projectId,
                  operation.params.revisionId,
                ),
              },
            };
          case "revision.history":
            return {
              ok: true,
              data: (() => {
                const page = projects.history(
                  operation.params.projectId,
                  operation.params.cursor,
                  operation.params.limit,
                );
                return {
                  ...page,
                  revisions: page.revisions,
                };
              })(),
            };
          case "edit.undo":
            return {
              ok: true,
              data: projects.undo(operation.params.projectId, operation.params),
            };
          case "edit.restore":
            return {
              ok: true,
              data: projects.restore(operation.params.projectId, operation.params),
            };
          case "acquisition.import": {
            const prepared = await acquisitionImports.prepareImport(
              operation.params.requestId,
              operation.params.path,
            );
            if (closing) throw new CatalogError("SERVICE_STOPPED", "Service is closing", {});
            const job = queue.submit(() => {
              const intent = acquisitions.admitImport(prepared);
              return {
                target: { kind: "acquisition", acquisitionId: intent.acquisitionId },
                artifact: "acquisition.import",
                lane: "heavy",
                input: JSON.stringify(intent.files),
              };
            });
            return { ok: true, data: status(job.jobId) };
          }
          case "acquisition.get":
            return { ok: true, data: acquisitions.get(operation.params.acquisitionId) };
          case "asset.import": {
            const prepared = await assets.prepareImport(
              operation.params.requestId,
              operation.params.path,
            );
            if (closing) throw new CatalogError("SERVICE_STOPPED", "Service is closing", {});
            const job = queue.submit(() => {
              const intent = assets.admitImport(prepared);
              return {
                target: { kind: "import", importId: intent.importId },
                artifact: "asset.import",
                lane: "heavy",
                input: JSON.stringify(intent.source),
              };
            });
            return { ok: true, data: status(job.jobId) };
          }
          case "asset.convert": {
            const converted = await convertedAssets.request(operation.params, requestSignal);
            return {
              ok: true,
              data: {
                ...operation.params,
                ...converted,
                published: publishedOutput(
                  converted.published,
                  (value) => JSON.parse(value.result) as unknown,
                ),
              },
            };
          }
          case "asset.get": {
            const { id, bytes, ...asset } = assets.describe(operation.params.assetId);
            return { ok: true, data: { ...asset, assetId: id, sizeBytes: bytes } };
          }
          case "asset.segments":
            return {
              ok: true,
              data: assets.segments(operation.params.assetId, operation.params.streamId, {
                ...(operation.params.cursor ? { cursor: operation.params.cursor } : {}),
                ...(operation.params.limit === undefined ? {} : { limit: operation.params.limit }),
              }),
            };
          case "asset.origins":
            return {
              ok: true,
              data: assets.origins(operation.params.assetId, {
                ...(operation.params.cursor ? { cursor: operation.params.cursor } : {}),
                ...(operation.params.limit === undefined ? {} : { limit: operation.params.limit }),
              }),
            };
          case "asset.list":
            return {
              ok: true,
              data: (() => {
                const page = assets.list({
                  ...(operation.params.cursor === undefined
                    ? {}
                    : { cursor: operation.params.cursor }),
                  ...(operation.params.limit === undefined
                    ? {}
                    : { limit: operation.params.limit }),
                });
                return {
                  ...page,
                  assets: page.assets.map(({ id, bytes, ...asset }) => ({
                    ...asset,
                    assetId: id,
                    sizeBytes: bytes,
                  })),
                };
              })(),
            };
          case "preview.get": {
            const params = operation.params;
            const status = await preview.request(params);
            return {
              ok: true,
              data: {
                ...status,
                published: publishedOutput(status.published, (value) => value.preview),
                delivery: status.published
                  ? delivery.open({ kind: "project", id: params.projectId }, () =>
                      cache.acquire(status.published!.preview.cacheId),
                    )
                  : null,
              },
            };
          }
          case "package.open":
            return {
              ok: true,
              data: await (async () => {
                const result = await projectPackages.open(
                  operation.params.path,
                  operation.params.requestId,
                );
                const { id, ...rest } = result as { id?: string } & Record<string, unknown>;
                return { ...rest, ...(id === undefined ? {} : { packageId: id }) };
              })(),
            };
          case "package.status":
            return {
              ok: true,
              data: (() => {
                const result = projectPackages.status(operation.params.admissionId) as Record<
                  string,
                  unknown
                >;
                const { id, admissions, ...rest } = result;
                return {
                  ...rest,
                  ...(typeof id === "string" ? { packageId: id } : {}),
                  ...(Array.isArray(admissions)
                    ? {
                        admissions: admissions.map((entry) => {
                          const { id: admissionId, ...admission } = entry as Record<
                            string,
                            unknown
                          >;
                          return {
                            ...admission,
                            ...(typeof admissionId === "string" ? { packageId: admissionId } : {}),
                          };
                        }),
                      }
                    : {}),
                };
              })(),
            };
          case "package.close":
            return {
              ok: true,
              data: await (async () => {
                const result = (await projectPackages.closeAdmission(
                  operation.params.admissionId,
                )) as Record<string, unknown>;
                const { id, ...rest } = result;
                return { ...rest, ...(typeof id === "string" ? { packageId: id } : {}) };
              })(),
            };
          case "package.adopt":
            return {
              ok: true,
              data: projectPackages.adopt(
                operation.params.packageHandle,
                operation.params.requestId,
              ),
            };
          case "export.create":
            return {
              ok: true,
              data: await mediaExports.create({
                ...operation.params,
                exportId: operation.params.requestId,
              } as never),
            };
          case "export.list":
            return { ok: true, data: mediaExports.list(operation.params) };
          case "export.status":
            return {
              ok: true,
              data: mediaExports.publicStatus(operation.params.exportId),
            };
          case "export.recover":
            return {
              ok: true,
              data: await mediaExports.recover(
                operation.params.exportId,
                operation.params.requestId,
              ),
            };
          case "export.cancel":
            mediaExports.cancel(operation.params.exportId);
            return { ok: true, data: mediaExports.status(operation.params.exportId) };
          case "export.abandon":
            await mediaExports.abandon(operation.params.exportId);
            return { ok: true, data: { exportId: operation.params.exportId, abandoned: true } };
          case "artifact.read":
            return {
              ok: true,
              data: delivery.read(
                operation.params.token,
                operation.params.offsetBytes,
                operation.params.maxBytes,
              ),
            };
          case "artifact.renew":
            return {
              ok: true,
              data: delivery.renew(operation.params.token, operation.params.requestId),
            };
          case "artifact.close":
            delivery.close(operation.params.token);
            return { ok: true, data: { token: operation.params.token, closed: true } };
          case "job.get":
            return { ok: true, data: status(operation.params.jobId) };
          case "job.retry": {
            // An export's retry also repairs its own failed prerequisites and honours its fences.
            // Rendered recognition likewise re-runs its failed PCM extraction.
            const owner = exportOf(operation.params.jobId);
            const job = queue.job(operation.params.jobId);
            if (owner && !owner.recovery) await mediaExports.retry(owner.exportId);
            else if (job.artifact === "rendered-speech") renderedSpeech.retryJob(job);
            else queue.retry(operation.params.jobId);
            return { ok: true, data: status(operation.params.jobId) };
          }
          case "job.cancel":
            await queue.drainJob(operation.params.jobId);
            return { ok: true, data: itemStatus(operation.params.jobId) };
          default:
            return operationError(
              "PREREQUISITE_MISSING",
              "Operation is not available in the project service",
            );
        }
      } catch (error) {
        const failure = operationFailure(error);
        if (failure.ok === false && failure.error.code === "MODEL_NOT_PREPARED")
          return {
            ...failure,
            error: {
              ...failure.error,
              details: {
                ...failure.error.details,
                operation: operation.operation,
                selection: operation.params,
              },
            },
          };
        return failure;
      }
    };
    const serve: LocalHandler = (request, signal) => {
      const task = Promise.resolve(handle(request, signal)).then(
        (result) => normalizeWork(result) as OperationResult,
      );
      pending.add(task);
      void task.then(
        () => {
          pending.delete(task);
          admission.progress();
        },
        () => {
          pending.delete(task);
          admission.progress();
        },
      );
      return task;
    };
    function requireCaptureControl(): CaptureService {
      if (!controller)
        throw new CatalogError("PREREQUISITE_MISSING", "No capture controller is connected");
      return captureCoordinator;
    }
    const captureCoordinator = new CaptureService(
      captures,
      library,
      (operation, params, options) =>
        controller
          ? controller.call(operation, params, options)
          : Promise.resolve(
              operationError("PREREQUISITE_MISSING", "No capture controller is connected"),
            ),
      worker,
      console.error,
      () => {
        admission.progress();
        try {
          resumeCaptureSources();
        } finally {
          queue.schedule();
        }
      },
      captureSources,
    );
    captureControl = captureCoordinator;
    deletion!.register(
      recordingRetirement({
        store: captures,
        jobs: queue,
        capture: captureCoordinator,
        delivery,
        files,
        sources: captureSources,
        freedBytes: (id) => libraryUsers?.usersOf({ kind: "recording", id }).freesBytes ?? 0,
      }),
    );
    listenerStarting = listenLocal({
      runtimeDirectory: runtime,
      handler: serve,
      delivery,
      admission,
    });
    if (options.control)
      controller = openControl({
        ...options.control,
        admission,
        dispatch: async (request) => {
          if (closing) return operationError("SERVICE_STOPPED", "Service is closing");
          if (updateControlOperations.has(request.operation)) {
            const parsed = updateControlSchema.safeParse({
              operation: request.operation,
              params: request.params,
            });
            if (!parsed.success)
              return operationError("INVALID_PARAMS", "Invalid private update request");
            const command = parsed.data;
            switch (command.operation) {
              case "update.prepare":
                return admission.prepare();
              case "update.commit":
                return admission.commit(command.params.permitId);
              case "update.release":
                return admission.release(command.params.permitId);
              case "update.report":
                update = command.params.update;
                admission.observe(update.state === "queued" || update.state === "running");
                return { ok: true, data: { reported: true } };
            }
          }
          if (request.operation !== "capture.report") return serve(request, modelLifetime.signal);
          const report = captureReportSchema.safeParse(request.params);
          if (!report.success) return operationError("INVALID_PARAMS", "Invalid capture report");
          try {
            return { ok: true, data: describeCapture(captureCoordinator.report(report.data)) };
          } catch (error) {
            return operationFailure(error);
          }
        },
        onEnd: () => {
          void close();
        },
      });
    reconciliation = closing
      ? Promise.resolve()
      : (async () => {
          await deletion!.resume((error) => console.error(error));
          queue.start();
          await captureCoordinator.reconcileStranded();
        })();
    const listener = await listenerStarting;
    boundListener = listener;
    if (closing) {
      await close();
      throw new CatalogError("SERVICE_STOPPED", "Capture controller closed during startup", {});
    }
    controller?.emit({ event: "started", pid: process.pid, socketPath: listener.socketPath });
    void reconciliation
      .then(() => {
        if (closing) return;
        starting = false;
        admission.progress();
        resumeCaptureSources();
        for (const error of mediaExports.resumeRecovery()) console.error(error);
      })
      .catch((error) => {
        starting = false;
        admission.progress();
        console.error(error);
      });
    return { socketPath: listener.socketPath, assets, captures, libraryUsers, close };
  } catch (error) {
    await close();
    throw error;
  }
}
