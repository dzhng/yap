import { MediaFrameInspection } from "@yap/core/frame-inspection";
import { ProjectPackages } from "../../dist/project-packages.js";
import { AcquisitionImporter } from "@yap/core/acquisitions";
import { SourceEvidenceStore } from "@yap/core/evidence";
import { SceneProcessing } from "@yap/core/scene-processing";
import { TranscriptProcessing } from "@yap/core/transcript-processing";
import { IndexProcessing } from "@yap/core/index-processing";
import { sourceIndexDomain } from "@yap/core/source-index";
import { Models } from "@yap/core/models";
import { LibraryDeletion } from "../../dist/library-deletion.js";
import { projectRetirement } from "../../dist/project-retirement.js";
import { DeletionPlans } from "../../../../packages/core/dist/deletion-plans.js";
import { DerivativeDelivery } from "../../dist/delivery.js";
import { ManagedStorage } from "@yap/core/storage";
import { ScreenshotIndexStore } from "@yap/core/screenshot-index";
import { projectIndexDomain } from "@yap/core/project-index";
import { projectComposition } from "@yap/core/project-window";
import { selectSource } from "@yap/core/source-selection";
import { SceneEvidenceStore, assetSceneOwner } from "@yap/core/scene-evidence";
import { SpeakerEvidenceStore, assetSpeakerOwner } from "@yap/core/speaker-evidence";
import { SpeakerProcessing } from "@yap/core/speaker-processing";
import { SpeakerLabelStore } from "@yap/core/speaker-labels";
import { AlignmentEvidenceStore, assetAlignmentOwner } from "@yap/core/alignment-evidence";
import { AlignmentProcessing } from "@yap/core/alignment-processing";
import { PreparedAudioStore } from "@yap/core/prepared-audio";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Catalog, CatalogError } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { ProjectStore } from "@yap/core/projects";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { TranscriptStore } from "@yap/core/transcript";
import { ImportedTranscriptStore } from "@yap/core/imported-transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { JobQueue } from "@yap/core/jobs";
import { DerivedCache } from "@yap/core/cache";
import { ProjectPreviewInspection } from "@yap/core/project-preview";
import { MediaExports } from "../../dist/exports.js";
import { ManagedFiles } from "../../dist/managed-files.js";
import { mediaWorker } from "../../dist/worker.js";
export const nativeBinary =
  process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native");
export const native = mediaWorker({ YAP_NATIVE: nativeBinary });
export const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
export async function until(run) {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await run();
    if (value) return value;
    assert.ok(Date.now() < end, "Owner did not settle within 15s");
    await delay(10);
  }
}
export async function fixture(
  t,
  {
    render,
    sourceSample,
    sourceFrame,
    projectFrame,
    transcriptionModels,
    transcribe,
    wrap = (value) => value,
    admission = true,
    existing,
  } = {},
) {
  const home = existing?.home ?? (await mkdtemp("/tmp/yap-project-export-")),
    output = existing?.output ?? (await mkdtemp("/tmp/yap-project-destination-"));
  const lifetime = existing?.lifetime ?? { closers: [] };
  if (!existing)
    t.after(async () => {
      for (const close of [...lifetime.closers].reverse()) await close();
      await rm(home, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    });
  const catalog = new Catalog(join(home, "catalog.sqlite")),
    assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const transcriptRecords = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  const importedTranscripts = new ImportedTranscriptStore(catalog, home, (source) => {
    if (selectSource(assets, acquisitions, source).stream.kind !== "audio")
      throw new CatalogError("UNSUPPORTED_MEDIA", "Imported transcript requires an audio stream");
  });
  const projects = new ProjectStore(catalog, assets, transcriptRecords, acquisitions),
    cache = new DerivedCache(catalog, home, (owner) => {
      if (owner.kind === "asset") assets.get(owner.id);
      else {
        assert.equal(owner.kind, "project");
        projects.get(owner.id);
      }
    });
  await cache.reconcile();
  let frames,
    indexes,
    transcripts,
    speakers,
    sceneProcessing,
    preview,
    exports,
    recoverOnCapacity = false;
  const recoveryErrors = [];
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    onCapacity: () => {
      if (recoverOnCapacity) recoveryErrors.push(...exports.resumeRecovery());
    },
    targets: {
      pin(target) {
        if (target.kind === "asset") {
          assets.get(target.id);
          return target;
        }
        assert.equal(target.kind, "project");
        return {
          ...target,
          revisionId: projects.revision(target.id, target.revisionId).id,
        };
      },
      isAvailable: (target) =>
        (target.kind === "asset" && assets.has(target.id)) ||
        (target.kind === "project" && !projects.isDeleting(target.id)),
      isDeleting: (owner) => owner.kind === "project" && projects.isDeleting(owner.id),
      isCapturing: () => false,
    },
    execute: (execution) =>
      execution.job.artifact === "frame"
        ? frames.execute(execution)
        : execution.job.artifact === "screenshot-index"
          ? indexes.execute(execution)
          : execution.job.artifact === "transcript"
            ? transcripts.execute(execution)
            : execution.job.artifact === "source-scenes"
              ? sceneProcessing.execute(execution)
              : execution.job.artifact === "source-speakers"
                ? speakers.execute(execution)
                : execution.job.artifact === "preview"
                  ? preview.execute(execution)
                  : exports.execute(execution),
  });
  const ordinary = async ({ window, output, settings }, signal) => {
    signal.throwIfAborted();
    const frames = [...window.frames()];
    const data = Buffer.from(JSON.stringify({ manifest: window.manifest, frames }));
    await writeFile(output, data, { flag: "wx" });
    return {
      file: output,
      settings,
      encodedVideo: {
        profile: settings.video.profile,
        level: settings.video.level === "auto" ? "3.1" : settings.video.level,
      },
      mediaType: "video/mp4",
      codec: "h264",
      durationUs: window.manifest.range.endUs - window.manifest.range.startUs,
      width: window.manifest.canvas.width,
      height: window.manifest.canvas.height,
      frameCount: frames.length,
      bytes: data.length,
    };
  };
  const worker = wrap(native),
    files = new ManagedFiles(home, worker);
  const binding = {
    implementationId: "project-owner-fixture-v1",
    render: render ? (request, signal) => render(request, signal, ordinary) : ordinary,
  };
  const prepared = new PreparedAudioStore({
    catalog,
    assets,
    projects,
    jobs,
    staging: join(home, "prepared"),
    renderer: {
      implementationId: "unused",
      render: async () => {
        throw new Error("unused preparation");
      },
    },
    probe: async () => {
      throw new Error("unused preparation");
    },
  });
  preview = new ProjectPreviewInspection(projects, assets, jobs, cache, binding, prepared);
  const domain = { store: projects, assets, preview };
  exports = new MediaExports({
    catalog,
    jobs,
    cache,
    worker,
    files,
    project: domain,
  });
  const scenes = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
  const projectRenderer = {
    implementationId: "package-fixture-project-frame",
    render:
      projectFrame ??
      (async () => {
        throw new Error("Project frame rendering was not requested");
      }),
  };
  const index = new ScreenshotIndexStore(
    catalog,
    home,
    projectIndexDomain(
      {
        composition: (identity) => projectComposition(projects, assets, identity),
        source: (selection) => selectSource(assets, acquisitions, selection),
        scenes,
        isDeleting: (id) => projects.isDeleting(id),
      },
      projectRenderer,
    ),
  );
  const delivery = new DerivativeDelivery();
  const evidence = new SourceEvidenceStore(catalog, (identity) => {
    assert.equal(identity.owner.kind, "acquisition");
    acquisitions.intent(identity.owner.id);
  });
  const acquisitionImports = new AcquisitionImporter(catalog, acquisitions, assets, evidence, home);
  sceneProcessing = new SceneProcessing({
    jobs,
    evidence: scenes,
    asset: {
      assets,
      acquisitions,
      implementationId: "package-fixture-scenes",
      sample:
        sourceSample ??
        (async () => {
          throw new Error("Scene rendering was not requested");
        }),
    },
  });
  const models = new Models(home, globalThis.fetch, undefined, catalog);
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
  const alignments = new AlignmentProcessing({
    assets,
    acquisitions,
    models,
    jobs,
    evidence: alignmentRecords,
    decoder: null,
    observe: async () => {
      throw new Error("Alignment observation was not requested");
    },
  });
  speakers = new SpeakerProcessing({
    assets,
    acquisitions,
    models,
    jobs,
    evidence: speakerRecords,
    decoder: null,
    observe: async () => {
      throw new Error("Speaker observation was not requested");
    },
  });
  transcripts = new TranscriptProcessing({
    jobs,
    transcripts: transcriptRecords,
    models: transcriptionModels ?? models.transcription("parakeet"),
    asset: { assets, acquisitions },
    transcribe:
      transcribe ??
      (async () => {
        throw new Error("Transcription was not requested");
      }),
  });
  frames = new MediaFrameInspection({
    assets,
    acquisitions,
    jobs,
    cache,
    project: { projects, renderer: projectRenderer },
    sourceRenderer: {
      implementationId: "package-fixture-frame",
      render:
        sourceFrame ??
        (async () => {
          throw new Error("Source frame rendering was not requested");
        }),
    },
  });
  const sourceIndex = new ScreenshotIndexStore(
    catalog,
    home,
    sourceIndexDomain((selection) => selectSource(assets, acquisitions, selection), scenes, frames),
  );
  indexes = new IndexProcessing({
    jobs,
    project: {
      catalog,
      assets,
      acquisitions,
      projects,
      scenes: sceneProcessing,
      records: scenes,
      frames,
      cache,
      index,
    },
    asset: {
      catalog,
      assets,
      acquisitions,
      scenes: sceneProcessing,
      records: scenes,
      frames,
      cache,
      index: sourceIndex,
    },
  });
  const packages = new ProjectPackages({
    directory: home,
    projects,
    assets,
    acquisitions: acquisitionImports,
    preparedAudio: prepared,
    sceneRecords: scenes,
    scenes: sceneProcessing,
    transcriptRecords,
    importedTranscripts,
    transcripts,
    speakerRecords,
    speakerLabels,
    speakers,
    alignmentRecords,
    alignments,
    indexRecords: sourceIndex,
    indexes,
    projectIndexRecords: index,
    jobs,
    worker,
    delivery,
  });
  domain.package = packages;
  const deletion = new LibraryDeletion(new DeletionPlans(catalog));
  deletion.register(
    projectRetirement({
      catalog,
      store: projects,
      jobs,
      cache,
      files,
      delivery,
      exports,
      index,
      freedBytes: () => 0,
    }),
  );
  const storage = new ManagedStorage(null, cache, home, (signal) =>
    exports.usage(undefined, signal),
  );
  if (admission) jobs.startAdmission((job) => exports.admit(job));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await storage.close();
    await deletion.close();
    await exports.close();
    await jobs.close();
    await packages.close();
    delivery.dispose();
    catalog.close();
  };
  lifetime.closers.push(close);
  let asset, projectId, placed;
  if (existing) {
    asset = assets.get(existing.asset.id);
    projectId = existing.projectId;
    placed = {
      revision: projects.revision(projectId, existing.placed.revision.id),
    };
  } else {
    const path = join(home, "input.mov");
    await writeFile(path, "source identity");
    asset = await assets.import(path, { kind: "import" }, async () => ({
      originUs: 0,
      streams: [
        {
          id: "video",
          kind: "video",
          codec: "h264",
          decodable: true,
          startUs: 0,
          endUs: 1000000,
          segments: [{ startUs: 0, endUs: 1000000, empty: false }],
          width: 160,
          height: 96,
          orientedWidth: 160,
          orientedHeight: 96,
        },
      ],
    }));
    const initial = projects.create({
      requestId: "create",
      canvas: {
        width: 160,
        height: 96,
        fps: { numerator: 20, denominator: 1 },
        background: "#000000ff",
      },
    });
    projectId = initial.project.id;
    placed = projects.apply(projectId, {
      requestId: "place",
      expectedRevisionId: initial.revision.id,
      operations: [
        {
          operation: "track.add",
          track: { kind: "video", order: 0 },
          label: "track",
        },
        {
          operation: "place",
          clip: {
            trackId: { label: "track" },
            assetId: asset.id,
            streamId: "video",
            source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
            placement: {
              kind: "project",
              range: { startUs: 0, endUs: 1000000 },
            },
          },
        },
      ],
    });
  }
  return {
    lifetime,
    close,
    home,
    output,
    catalog,
    assets,
    asset,
    projects,
    projectId,
    placed,
    jobs,
    cache,
    get preview() {
      return preview;
    },
    exports,
    binding,
    deletion,
    storage,
    packages,
    acquisitions,
    acquisitionImports,
    scenes,
    sceneProcessing,
    transcripts,
    transcriptRecords,
    speakerRecords,
    speakers,
    sourceIndex,
    frames,
    projectIndex: index,
    indexes,
    replaceRenderer(implementationId) {
      preview = new ProjectPreviewInspection(
        projects,
        assets,
        jobs,
        cache,
        {
          ...binding,
          implementationId,
        },
        prepared,
      );
      domain.preview = preview;
    },
    recoveryErrors,
    startRecovery() {
      recoverOnCapacity = true;
      return exports.resumeRecovery();
    },
    request: () => ({
      kind: "video",
      projectId,
      exportId: randomUUID(),
      directory: output,
      leaf: randomUUID() + ".mp4",
    }),
  };
}
