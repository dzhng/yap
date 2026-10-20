import {
  outputSettingsSchema,
  audioOutputSettingsSchema,
  selectionRangeSchema,
  compositionSchema,
  mediaClipSchema,
  editOperationSchema,
  textSeedCuesSchema,
  captionSidecarRequestSchema,
  processingTargetSchema,
  processingTapSchema,
  timeValueSchema,
} from "@yap/composition";
import { z } from "zod";
import { pictureObservationRequestSchema } from "./picture.js";
import { faceObservationRequestSchema } from "./faces.js";
import {
  correspondenceGetParamsSchema,
  correspondencePrepareParamsSchema,
} from "./correspondence.js";
import { captureSelectionSchema } from "./capture.js";
import { DEFAULT_CALL_TIMEOUT_MS, MEDIA_WORKER_TIMEOUT_MS } from "./framing.js";
import { pageParams } from "./paging.js";

const id = z.string().min(1);
/** The most bytes one artifact.read returns. */
export const ARTIFACT_CHUNK_BYTES = 512 * 1024;
/** Bounded maintenance must not borrow capacity from the deliveries it drains. */
export function isArtifactMaintenance(operation: string): boolean {
  return (
    operation === "artifact.read" ||
    operation === "artifact.renew" ||
    operation === "artifact.close"
  );
}
const time = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.object({ startUs: time, endUs: time }).strict();
const recording = z.object({ recordingId: id }).strict();
const recordingDelete = recording.extend({ cascade: z.boolean().optional() }).strict();
const sourceSelection = mediaClipSchema.pick({
  assetId: true,
  streamId: true,
  acquisitionId: true,
});
const transcriptExecutionSelection = {
  sourceRange: selectionRangeSchema.optional(),
  context: z
    .strictObject({
      beforeUs: z.int().min(0).max(4_000_000),
      afterUs: z.int().min(0).max(4_000_000),
    })
    .optional(),
};
const sourceTranscriptPreparation = sourceSelection
  .extend({ ...transcriptExecutionSelection })
  .strict();
const sourceTranscriptReference = {
  assetId: id,
  streamId: id,
  acquisitionId: id.nullable(),
  generation: id,
  supportDigest: id,
  afterSourceUs: time,
};
const transcriptSpeaker = z
  .strictObject({
    streamId: id,
    acquisitionId: id.optional(),
    channel: z.int().nonnegative(),
    modelId: id,
    sourceRange: selectionRangeSchema,
    generation: id,
  })
  .describe("A generation-pinned speaker observation used only for transcript attribution");
const transcriptSpeakerCursor = transcriptSpeaker.extend({
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const projectTranscriptSpeaker = transcriptSpeaker.extend({ assetId: id });
const continuityDigest = z.string().regex(/^[a-f0-9]{64}$/);
const continuityMetrics = z.strictObject({
  inputFrames: z.int().positive(),
  scoredFrames: z.int().nonnegative(),
  durationUs: z.number().finite().positive(),
  inferenceUs: z.number().finite().nonnegative(),
  peakRssBytes: z.int().nonnegative(),
  expectedSpeakerCount: z.int().positive().max(8),
  observedSpeakerCount: z.int().nonnegative().max(8),
  der: z.number().finite().min(0).max(1),
  identityConfusion: z.number().finite().min(0).max(1),
  overlapRequired: z.boolean(),
  overlapRecall: z.number().finite().min(0).max(1).nullable(),
  stateContinuity: z.boolean(),
});
const continuityCandidate = z.strictObject({
  identity: z.strictObject({
    generation: id,
    sourceDigest: continuityDigest,
    modelId: id,
    modelDigest: continuityDigest,
    runtimeDigest: continuityDigest,
  }),
  metrics: continuityMetrics,
  controls: z.strictObject({
    shortWindow: z.boolean(),
    transport: z.boolean(),
    threeSpeaker: z.boolean(),
    fourSpeakerOverlap: z.boolean(),
  }),
});
const project = z.object({ projectId: id }).strict();
const projectEvidenceParams = pageParams({
  projectId: id,
  revisionId: id.optional(),
  range: range.optional(),
  trackIds: z.array(id).optional(),
});
const projectTranscriptParams = projectEvidenceParams
  .extend({
    cursor: z.string().min(1).optional(),
    sourceGenerations: z
      .array(sourceSelection.extend({ generation: id }).strict())
      .min(1)
      .max(10000)
      .optional(),
    speakerGenerations: z.array(projectTranscriptSpeaker).min(1).max(10000).optional(),
  })
  .strict();
const capturePosition = z.strictObject({
  after: z.tuple([time, time]).nullable(),
  done: z.boolean(),
});
const captureHeads = z.strictObject({
  cursor: capturePosition,
  pause: capturePosition,
  geometry: capturePosition,
  mark: capturePosition,
  interruption: capturePosition,
});
const sourceCaptureParams = (maximum: number, events = false) =>
  pageParams({ sourceRange: range.optional(), ...sourceSelection.shape });
const projectEdit = project.extend({ requestId: id, expectedRevisionId: id });
const exportDestination = {
  requestId: id,
  revisionId: id.optional(),
  directory: z.string().min(1),
  leaf: z.string().min(1),
  overwrite: z.boolean().optional(),
};
const previewParams = project
  .extend({
    revisionId: id.optional(),
    maxLongEdge: z.int().positive().max(8192).nullable().optional(),
    settings: outputSettingsSchema.optional(),
    range: range
      .refine(({ startUs, endUs }) => endUs > startUs, {
        message: "Preview range must be positive",
      })
      .optional(),
  })
  .strict();
const inspectParams = project
  .extend({
    revisionId: id.optional(),
    range: range
      .refine(({ startUs, endUs }) => endUs > startUs, {
        message: "Inspection range must be positive",
      })
      .optional(),
    historyLimit: z.int().min(1).max(100).optional(),
  })
  .strict();
const captionProposalParams = projectTranscriptParams
  .omit({ cursor: true })
  .extend({
    revisionId: id,
    limit: z.int().min(1).max(1000).default(1000),
    trackId: id,
    canvas: z.record(z.string(), z.unknown()),
    style: z.record(z.string(), z.unknown()),
    constraints: z.record(z.string(), z.unknown()),
    corrections: z.array(z.record(z.string(), z.unknown())).max(10000).optional(),
  })
  .strict();
const layoutDiagnosticParams = project
  .extend({
    revisionId: id,
    samples: z
      .array(
        z
          .object({
            atUs: time,
            canvas: z
              .object({ width: z.number().positive(), height: z.number().positive() })
              .strict(),
            texts: z
              .array(
                z
                  .object({
                    id,
                    bounds: z
                      .object({
                        x: z.number(),
                        y: z.number(),
                        width: z.number().nonnegative(),
                        height: z.number().nonnegative(),
                      })
                      .strict(),
                    glyphs: z.array(z.string()).optional(),
                    fallback: z.string().optional(),
                  })
                  .strict(),
              )
              .max(256),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    maxIssueCount: z.int().min(1).max(100).optional(),
  })
  .strict();
const historyParams = <T extends z.ZodRawShape>(target: z.ZodObject<T>) =>
  target
    .extend({
      cursor: z.string().min(1).optional(),
      limit: z.int().min(1).max(1000).default(100),
    })
    .strict();

const maxLongEdge = z.int().min(1).max(8192).optional();
const projectFrameParams = project
  .extend({
    revisionId: id.optional(),
    atUs: time,
    maxLongEdge: maxLongEdge,
    observations: pictureObservationRequestSchema.optional(),
    faceObservations: faceObservationRequestSchema.optional(),
    tap: processingTapSchema.optional(),
  })
  .strict();
const sourceFrameParams = sourceSelection
  .extend({
    atUs: time,
    maxLongEdge: maxLongEdge,
    observations: pictureObservationRequestSchema.optional(),
    faceObservations: faceObservationRequestSchema.optional(),
  })
  .strict();
const frameParams = z.union([
  projectFrameParams,
  sourceFrameParams,
  sourceSelection
    .omit({ acquisitionId: true })
    .extend({
      maxLongEdge: maxLongEdge,
      observations: pictureObservationRequestSchema.optional(),
      faceObservations: faceObservationRequestSchema.optional(),
    })
    .strict(),
]);
const reviewTrailUs = z.int().min(0).max(10_000_000);
const cursorRenderParams = z.union([
  projectFrameParams.extend({
    atUs: z.array(time).min(1).max(8),
    trailUs: reviewTrailUs,
  }),
  sourceFrameParams.extend({
    atUs: z.array(time).min(1).max(8),
    trailUs: reviewTrailUs,
  }),
]);
const transcriptReviewParams = z.union([
  projectTranscriptParams,
  pageParams({
    ...sourceSelection.shape,
    sourceRange: selectionRangeSchema.optional(),
  }),
]);

const audioRange = range.refine(({ startUs, endUs }) => endUs > startUs, {
  message: "Audio range must be positive",
});
const projectAudioParams = project
  .extend({
    revisionId: id.optional(),
    range: audioRange.optional(),
    tap: processingTapSchema.optional(),
  })
  .strict();
const sourceAudioParams = sourceSelection
  .extend({ sourceRange: selectionRangeSchema.optional() })
  .strict();
const extractedAudioRendition = z.strictObject({
  sampleRate: z.int().min(1).max(192000),
  channels: z.union([z.literal(1), z.literal(2)]),
});
const renderedSpeechPreparation = projectAudioParams
  .extend({
    revisionId: id,
    range: audioRange,
    tap: processingTapSchema,
    rendition: extractedAudioRendition,
  })
  .strict();
const audioParams = z.union([projectAudioParams, sourceAudioParams]);
const loudnessFields = {
  channelInterpretation: z.enum(["native", "dual-mono"]).optional(),
  truePeak: z.boolean().optional(),
};
const loudnessParams = z.union([
  projectAudioParams.extend({
    ...loudnessFields,
    preparedResourceId: id.optional(),
  }),
  sourceAudioParams.extend({ ...loudnessFields }),
]);
const waveformFields = {
  bucketFrames: z.int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  format: z.enum(["json", "image"]).optional(),
};
const waveformParams = z.union([
  projectAudioParams.extend(waveformFields),
  sourceAudioParams.extend(waveformFields),
]);

const spectrumFields = {
  fftFrames: z.int().min(16).max(8192).optional(),
  hopFrames: z.int().positive().max(8192).optional(),
};
const spectrogramParams = z.union([
  projectAudioParams.extend(spectrumFields),
  sourceAudioParams.extend(spectrumFields),
]);
const pauseFields = {
  thresholdRMS: z.number().finite().nonnegative().optional(),
  minDurationUs: z.int().positive().optional(),
  channel: z.int().nonnegative().optional(),
};
const pauseParams = z.union([
  pageParams({ ...projectAudioParams.shape, ...pauseFields }),
  pageParams({ ...sourceAudioParams.shape, ...pauseFields }),
]);

const projectIndexParams = projectFrameParams.omit({ atUs: true });
const projectIndexReference = projectIndexParams
  .required()
  .partial({ observations: true, faceObservations: true })
  .extend({ generation: id });
const paged = <T extends z.ZodRawShape, S extends z.ZodRawShape>(
  target: z.ZodObject<T>,
  fields: S,
) => target.extend({ ...fields, cursor: z.string().min(1).optional() }).strict();
// Adapters derive their advertised tools from the same schemas the service validates.
export const operationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("project.create"),
      params: z
        .object({
          requestId: id,
          title: z.string().optional(),
          canvas: compositionSchema.shape.canvas,
        })
        .strict(),
    })
    .strict()
    .describe(
      "Create an empty managed project with an explicit canvas; replay requestId to recover the same project.",
    ),
  z
    .object({ operation: z.literal("project.delete"), params: project.extend({ requestId: id }) })
    .strict()
    .describe(
      "Delete a project and drain its work while preserving original assets. Repeating deletion succeeds; creation retries never recreate it.",
    ),
  z
    .object({
      operation: z.literal("project.duplicate"),
      params: project
        .extend({ requestId: id, revisionId: id.optional(), title: z.string().optional() })
        .strict(),
    })
    .strict()
    .describe(
      "Duplicate a project revision into a new independent project; replay requestId for the same copy, and use revisionId to choose a historical document. This is a project copy, distinct from the clip-level duplicate edit.",
    ),
  z
    .object({ operation: z.literal("project.get"), params: project })
    .strict()
    .describe("Read project metadata and its current revision identity."),
  z
    .object({
      operation: z.literal("project.list"),
      params: pageParams(),
    })
    .strict()
    .describe("Read a bounded page of managed projects, newest first."),
  z
    .object({ operation: z.literal("inspect.open"), params: inspectParams })
    .strict()
    .describe(
      "Open a read-only native inspection session for a pinned project revision. This convenience operation combines revision resolution, bounded revision.history and native preview opening; it returns the resolved revision and app-open acknowledgement without editing, exporting or starting capture.",
    ),
  z
    .object({ operation: z.literal("caption.propose"), params: captionProposalParams })
    .strict()
    .describe(
      "Produce bounded transcript-pinned caption drafts from a pinned project selection. This convenience operation combines a bounded transcript.get with pure caption drafting; it never calls transcript.transcribe, calls text.seed or mutates a project. Narrow the range or track set when the transcript page is not complete.",
    ),
  z
    .object({ operation: z.literal("layout.diagnostics"), params: layoutDiagnosticParams })
    .strict()
    .describe(
      "Report bounded sampled text-layout evidence for a pinned revision. Issues are advisory and never authorize edits or certify continuous readability.",
    ),
  z
    .object({
      operation: z.literal("edit.apply"),
      params: projectEdit.extend({ operations: z.array(editOperationSchema).max(1000) }).strict(),
    })
    .strict()
    .describe(
      "Atomically edit a managed project using revision pinning and replay-safe request identity; returns revision.document as the sole document, plus edit receipts with complete normalized changes and labels.",
    ),
  z
    .object({
      operation: z.literal("speaker.correct"),
      params: project
        .extend({
          requestId: id,
          expectedRevisionId: id,
          corrections: z
            .array(
              z
                .object({
                  id,
                  occurrenceId: id,
                  target: z.union([
                    z.object({ wordIds: z.array(id).min(1) }).strict(),
                    z.object({ range: range }).strict(),
                  ]),
                  value: z.union([
                    z
                      .object({
                        state: z.literal("attributed"),
                        slot: z.int().min(0).max(3),
                        displayName: z.string().trim().min(1).max(128).optional(),
                      })
                      .strict(),
                    z
                      .object({
                        state: z.literal("overlap"),
                        slots: z.array(z.int().min(0).max(3)).min(2).max(4),
                      })
                      .strict(),
                    z.object({ state: z.literal("unknown") }).strict(),
                  ]),
                  provenance: z.string().min(1).max(4096),
                })
                .strict(),
            )
            .min(1)
            .max(1000),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Apply caller-authored speaker-attribution corrections to exact word identities or ranges in one reversible project revision. Retains the base attribution and correction provenance; it never changes acoustic evidence or source media.",
    ),
  z
    .object({
      operation: z.literal("text.seed"),
      params: projectEdit.extend({ cues: textSeedCuesSchema }).strict(),
    })
    .strict()
    .describe(
      "Seed explicitly grouped text clips from pinned transcript generations and occurrence word rows. Supply each cue's source, original occurrence clip ID, exact word ordinals/source ranges, separator, style and project/content/clip anchor domain. Expands one atomic ordinary placement batch; returns revision.document as the sole document, plus edit receipts with normalized edits and labels. Display text remains editable independently of retained transcript origin. Pins retain overlapping estimates and instant points; cues containing only instant observations require caller-authored literal text with an explicit extent instead of inferred dwell. Reuse requestId only for the same pinned request. At most 1000 cues and 10000 total word pins.",
    ),
  z
    .object({
      operation: z.literal("processing.get"),
      params: project.extend({ revisionId: id, target: processingTargetSchema }).strict(),
    })
    .strict()
    .describe(
      "Read one target's authored ordered processing stack at a pinned revision; this does not execute processors.",
    ),
  z
    .object({
      operation: z.literal("output.capabilities"),
      params: z.object({ kind: z.enum(["video", "audio"]).optional() }).strict(),
    })
    .strict()
    .describe(
      "Discover standalone audio formats and rendition limits with kind:audio without initializing a video encoder; omit kind or use kind:video for project movie encoding controls, editable presets, backend capabilities and unsupported combinations. Internal mixing is 48000 Hz stereo; encoded AAC rate/layout is independently selectable. Requested bitrate is not measured file bitrate.",
    ),
  z
    .object({ operation: z.literal("processing.capabilities"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Discover typed processing parameters and distinguish authoring support from actual execution readiness.",
    ),

  z
    .object({
      operation: z.literal("acquisition.import"),
      params: z.object({ requestId: id, path: z.string().min(1) }).strict(),
    })
    .strict()
    .describe(
      "Adopt an explicitly named captured-source directory and its journal through a durable job. Own copied media and evidence independently of the donor. Returns the status of that work with its jobId; follow it with job.get and use job.retry/job.cancel for preparation.",
    ),
  z
    .object({
      operation: z.literal("acquisition.get"),
      params: z.object({ acquisitionId: id }).strict(),
    })
    .strict()
    .describe(
      "Read immutable capture context and asset/stream bindings. Select acquisitionId explicitly on a media clip; omission always uses physical file support.",
    ),

  z
    .object({
      operation: z.literal("asset.import"),
      params: z.object({ requestId: id, path: z.string().min(1) }).strict(),
    })
    .strict()
    .describe(
      "Admit local media, a font file or a bounded 3D .cube LUT as an immutable asset through a durable job. Fonts retain all explicitly named faces without installation or playable streams. LUTs retain byte identity and typed non-playable grid metadata; use processing.set with an explicit LUT asset, colorSpace and interpolation. Replay requestId to recover the same import. Returns the status of that work with its jobId; follow it with job.get, retry failed work with job.retry and cancel with job.cancel.",
    ),
  z
    .object({
      operation: z.literal("asset.convert"),
      params: z
        .object({
          assetId: id,
          streamIds: z.array(z.string().min(1)).min(1).max(2),
          recipe: z.literal("hdr-to-sdr-hable-1000nit-v1"),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Explicitly convert one whole qualified HDR video stream to an immutable SDR ProRes asset; optionally copy one explicitly selected audio stream with unchanged decoded samples and common clock. The frozen recipe and bundled implementation are retained with source/output evidence. Original media stays intact; no placement or automatic conversion. Shared jobs own replay, retry, cancellation and publication. Range and acquisition conversion are unsupported.",
    ),
  z
    .object({ operation: z.literal("asset.get"), params: z.object({ assetId: id }).strict() })
    .strict()
    .describe(
      "Read immutable stream headers with segmentCount; use asset.segments for complete physical timing rows, including empty gaps. Non-timed fontFaces and lut grid metadata remain available. Select a font face by assetId and its exact postScriptName; names are scoped to those immutable bytes, not the installed system fonts.",
    ),
  z
    .object({
      operation: z.literal("asset.delete"),
      params: z.object({ assetId: id, requestId: id, cascade: z.boolean().optional() }).strict(),
    })
    .strict()
    .describe(
      "Delete an asset and its retained evidence after checking library users. Without cascade, an asset used by a project, acquisition or derived asset refuses with IN_USE details; cascade explicitly retires those users. Replay requestId to recover the same result.",
    ),
  z
    .object({
      operation: z.literal("asset.segments"),
      params: pageParams({ assetId: id, streamId: z.string().min(1) }),
    })
    .strict()
    .describe(
      "Read exact physical segment rows in immutable ordinal order, including empty gaps and original media mappings. Use asset.get segmentCount for discovery; follow nextCursor until null. A cursor belongs to its asset and stream. These rows preserve source metadata, not a newly normalized playback timeline.",
    ),
  z
    .object({
      operation: z.literal("asset.origins"),
      params: pageParams({ assetId: id }),
    })
    .strict()
    .describe(
      "Read a bounded page of asset provenance. Follow nextCursor until null; concurrent imports can add origins before the cursor, so restart traversal to refresh history.",
    ),
  z
    .object({
      operation: z.literal("asset.list"),
      params: pageParams(),
    })
    .strict()
    .describe(
      "Read admitted assets newest first with an opaque continuation. streamCount/mediaKinds describe media streams; fontFaceCount identifies non-timed font assets, which have no streams.",
    ),
  z
    .object({ operation: z.literal("job.get"), params: z.object({ jobId: id }).strict() })
    .strict()
    .describe(
      "Read a preparation job's current attempt and published result without restarting it. inputSha256 identifies its frozen internal recipe; the serialized execution input is not returned.",
    ),
  z
    .object({ operation: z.literal("job.retry"), params: z.object({ jobId: id }).strict() })
    .strict()
    .describe(
      "Explicitly retry a failed preparation job with its frozen inputs. Returns the same job status shape as job.get, with inputSha256 instead of internal execution input.",
    ),
  z
    .object({ operation: z.literal("job.cancel"), params: z.object({ jobId: id }).strict() })
    .strict()
    .describe(
      "Cancel a preparation job; occupied resources drain before their execution capacity is reused. Returns the same job status shape as job.get, including inputSha256.",
    ),

  z
    .object({
      operation: z.literal("export.create"),
      params: z.union([
        project
          .extend({
            ...exportDestination,
            kind: z.literal("video"),
            settings: outputSettingsSchema.optional(),
          })
          .strict(),
        project
          .extend({
            ...exportDestination,
            kind: z.literal("audio"),
            settings: audioOutputSettingsSchema.optional(),
          })
          .strict(),
        project.extend({ ...exportDestination, kind: z.literal("processed-package") }).strict(),
        project
          .extend({ ...exportDestination, ...captionSidecarRequestSchema.shape, revisionId: id })
          .strict(),
      ]),
    })
    .strict()
    .describe(
      "Export a pinned revision to an existing absolute directory. Replay is keyed by requestId; pass the returned export id as exportId for status and recovery. A new intent atomically replaces an unchanged file matching a trusted Yap publication receipt; replacing another regular file requires overwrite:true.",
    ),
  z
    .object({
      operation: z.literal("export.list"),
      params: pageParams({ projectId: id.optional(), unfinishedOnly: z.boolean().optional() }),
    })
    .strict()
    .describe(
      "Discover persisted export summaries after restart without starting work. The page limit is 1–1000 (default 100). unfinishedOnly includes uncommitted exports, abandonment and private cleanup. Filter by projectId. The opaque cursor binds the project filter and unfinishedOnly. Pages are newest first. Use export.status for details.",
    ),
  z
    .object({
      operation: z.literal("export.status"),
      params: z.object({ exportId: id }).strict(),
    })
    .strict()
    .describe(
      "Read an export's pinned revision, admitted destination, job, private cleanup state and historical commit receipt without opening the destination. Project package snapshots report project/revision identity and history/resource counts; video snapshots retain output settings. output names a file only once committed.",
    ),
  z
    .object({
      operation: z.literal("export.recover"),
      params: z.object({ requestId: id, exportId: id }).strict(),
    })
    .strict()
    .describe(
      "Queue a fresh observation of uncertain publication evidence. Does not create or replace an external file.",
    ),
  z
    .object({
      operation: z.literal("export.cancel"),
      params: z.object({ exportId: id }).strict(),
    })
    .strict()
    .describe(
      "Cancel this export and its active recovery work. A file already committed remains intact.",
    ),
  z
    .object({
      operation: z.literal("export.abandon"),
      params: z.object({ exportId: id }).strict(),
    })
    .strict()
    .describe(
      "Drain this export and remove its owned private staging and intent. Never deletes the external export. An absent intent is already abandoned.",
    ),
  z
    .object({
      operation: z.literal("package.open"),
      params: z.object({ requestId: id, path: z.string().startsWith("/") }).strict(),
    })
    .strict()
    .describe(
      "Admit a local processed ZIP from an absolute path without symlink components, asynchronously. Poll package.status with the returned admission ID; only ready results contain a process-local packageHandle. Opening twice creates independent lifetimes.",
    ),
  z
    .object({
      operation: z.literal("package.status"),
      params: z.object({ admissionId: id.optional() }).strict(),
    })
    .strict()
    .describe(
      "Read one package admission, or omit admissionId for package recovery, storage status and active admissions (including opens whose reply was lost). Handles expire when closed or the service restarts.",
    ),
  z
    .object({
      operation: z.literal("package.adopt"),
      params: z.object({ packageHandle: id, requestId: id }).strict(),
    })
    .strict()
    .describe(
      "Adopt an opened editable project package into independent durable assets and revisions. Repeat the same requestId and packageHandle to poll the shared preparation job; ready result contains projectId and revisionId; inspect the durable project and its retained history with project.get and revision.history. Closing the package cancels unfinished adoption; a committed project survives package closure. Once adoption is ready, close the package to release its staged copy; an unclosed package holds that space until the service restarts.",
    ),
  z
    .object({
      operation: z.literal("package.close"),
      params: z.object({ admissionId: id }).strict(),
    })
    .strict()
    .describe(
      "Cancel or close a package admission, draining work and revoking its image deliveries before cleanup. Retry explicit cleanup failures with the same admissionId.",
    ),
  z
    .object({
      operation: z.literal("recording.delete"),
      params: recordingDelete.extend({ requestId: id }),
    })
    .strict()
    .describe(
      "Delete a recording after capture has proved the take stopped. Its capture-origin copies and their evidence, assets and managed files are retired with it; a copy used by a project refuses with IN_USE details unless cascade is true, which also retires those projects. Retrying the same requestId returns the saved result.",
    ),
  z
    .object({
      operation: z.literal("storage.usage"),
      params: z.object({}).strict(),
    })
    .strict()
    .describe(
      "Read live logical regular-file byte usage, including unfinished work and pending deletions. Includes all managed storage plus shared database/unattributed bytes; modelBytes counts every regular file under models/, including cache and staging. External exports are excluded; files may change while scanned.",
    ),
  z
    .object({
      operation: z.literal("index.get"),
      params: z.union([
        projectIndexParams.extend({
          ...pageParams().shape,
        }),
        paged(sourceSelection, {
          ...pageParams().shape,
          observations: pictureObservationRequestSchema.optional(),
          faceObservations: faceObservationRequestSchema.optional(),
        }),
      ]),
    })
    .strict()
    .describe(
      "Request a retained screenshot index for a project or selected asset video stream. This convenience operation handles the required scene/index preparation and then returns paged metadata; it does not make a continuous visual-readability claim. Projects select the whole revision and an optional video tap, defaulting to processed output; maxLongEdge controls picture size. Source selectors use assetId/streamId and optional acquisitionId. An empty index may be ready. Project coverage marks only delivered frame visibility as sampled; intervening ranges remain unproven. Continue with the returned cursor to pin identity; use index.frame or index.frames for image bytes. Optional observations participates in index identity and retains the sampled frame measurements; it does not prove intervening pixels.",
    ),
  z
    .object({
      operation: z.literal("face.trajectory.get"),
      params: sourceSelection
        .extend({
          generation: id,
          maxGapUs: z.int().positive().max(1_000_000).optional(),
          prediction: z.enum(["none", "linear"]).optional(),
          ...pageParams().shape,
        })
        .strict(),
    })
    .strict()
    .describe(
      "Read source-bound face trajectory evidence from a retained face-observation index generation. Rows preserve source clock, detector implementation, exact observed boxes, gaps, reset reasons and ambiguity; they never authorize a crop or edit. prediction:linear reports state unavailable until a prediction method is implemented, so inferred boxes are never mislabeled as observations. Continuations pin source identity and index generation.",
    ),
  z
    .object({
      operation: z.literal("index.coverage"),
      params: z.union([
        paged(projectIndexReference, {
          candidateOrdinal: z.int().nonnegative().optional(),
          ...pageParams().shape,
        }),
        paged(sourceSelection, {
          generation: id,
          candidateOrdinal: z.int().nonnegative().optional(),
          ...pageParams().shape,
        }),
      ]),
    })
    .strict()
    .describe(
      "Page source and edited coverage intervals from a published index, optionally for one selected image. Continuations bind the index and candidate filter.",
    ),
  z
    .object({
      operation: z.literal("index.frame"),
      params: z.union([
        projectIndexReference.extend({ ordinal: z.int().nonnegative() }),
        sourceSelection.extend({ generation: id, ordinal: z.int().nonnegative() }).strict(),
      ]),
    })
    .strict()
    .describe(
      "Read one retained selected PNG from a published index reference. Includes requested/actual times and pointing metadata; the CLI and MCP deliver image bytes.",
    ),
  z
    .object({
      operation: z.literal("index.frames"),
      params: z.union([
        projectIndexReference.extend({ ordinals: z.array(z.int().nonnegative()).min(1).max(8) }),
        sourceSelection
          .extend({
            generation: id,
            ordinals: z.array(z.int().nonnegative()).min(1).max(8),
          })
          .strict(),
      ]),
    })
    .strict()
    .describe(
      "Read one to eight retained selected PNGs in order from the same published index. This batch convenience operation is equivalent to repeated index.frame calls while preserving order and per-image errors; duplicates remain ordered.",
    ),

  z
    .strictObject({
      operation: z.literal("transcript.import"),
      params: z
        .object({
          requestId: id,
          assetId: id,
          streamId: id,
          acquisitionId: id.optional(),
          path: z.string().startsWith("/"),
          format: z.enum(["srt", "vtt", "json"]).optional(),
          timingPolicy: z.enum(["supplied", "align"]).default("supplied"),
          modelId: id.optional(),
          channel: z.int().nonnegative().optional(),
        })
        .strict(),
    })
    .describe(
      "Import one local SRT, VTT or supported JSON transcript for an explicitly selected audio asset stream. Preserves raw bytes, parser provenance, cue boundaries, supplied timing, word timing and speaker labels. timingPolicy defaults to supplied; align explicitly requests the existing alignment observer for each cue and keeps supplied evidence beside its derived result.",
    ),
  z
    .strictObject({
      operation: z.literal("correspondence.prepare"),
      params: correspondencePrepareParamsSchema,
    })
    .describe(
      "Admit caller-supplied temporal correspondence measurements between two explicit source or prepared project-tap endpoints. The receipt retains candidates, residuals, coverage, drift and refusals; it never declares an angle, retimes media or edits a project.",
    ),
  z
    .strictObject({
      operation: z.literal("correspondence.get"),
      params: correspondenceGetParamsSchema,
    })
    .describe(
      "Read one immutable temporal correspondence receipt without decoding media or rerunning estimation. Continue with the returned cursor to keep its evidence generation and query pinned.",
    ),
  z
    .strictObject({
      operation: z.literal("alignment.observe"),
      params: z.union([
        sourceSelection
          .extend({
            channel: z.int().nonnegative(),
            sourceRange: selectionRangeSchema,
            text: z
              .string()
              .min(1)
              .max(8192)
              .refine((value) => {
                const words = value.match(/\S+/gu) ?? [];
                return (
                  words.length > 0 &&
                  words.length <= 512 &&
                  words.every((word) => new TextEncoder().encode(word).byteLength <= 1024)
                );
              }),
            modelId: id,
          })
          .strict(),
        z.strictObject({
          projectId: id,
          revisionId: id.optional(),
          preparedResourceId: id,
          tap: processingTapSchema,
          sourceRange: selectionRangeSchema,
          channel: z.int().nonnegative(),
          text: z
            .string()
            .min(1)
            .max(8192)
            .refine((value) => {
              const words = value.match(/\S+/gu) ?? [];
              return (
                words.length > 0 &&
                words.length <= 512 &&
                words.every((word) => new TextEncoder().encode(word).byteLength <= 1024)
              );
            }),
          modelId: id,
        }),
      ]),
    })
    .describe(
      "Explicitly prepare conditional supplied-text alignment over one complete selected source channel on the 16k sample grid, at most25 seconds. Source requests select immutable media directly. Project requests select a pinned, already-prepared processing tap and run alignment on its rendered PCM; a range that runs past the revision aligns the text against the part inside it, shares that applied range's generation and reports range-clamped in the result's issues, and one with no part inside refuses. Models must already be explicitly prepared. Literal text is neither corrected nor expanded. The existing job owns join, cancel, retry and publication; original media remains intact. Provider correspondence is not lexical truth, and native likelihoods are uncalibrated. Published output supplies the retained generation for alignment.get.",
    ),
  z
    .strictObject({
      operation: z.literal("alignment.get"),
      params: z.union([
        z.strictObject({
          assetId: id,
          packageHandle: id.optional(),
          generation: id,
          range: range.optional(),
          view: z.enum(["words", "acoustic", "scores", "raw"]).optional(),
          thresholdRMS: z.number().finite().nonnegative().optional(),
          operand: z.enum(["nativeReceipt", "report", "correspondence"]).optional(),
          ...pageParams().shape,
        }),
        z.strictObject({
          projectId: id,
          revisionId: id.optional(),
          preparedResourceId: id,
          tap: processingTapSchema,
          assetId: id,
          generation: id,
          sourceRange: selectionRangeSchema.optional(),
          range: range.optional(),
          trackIds: z.array(id).optional(),
          view: z.enum(["words", "acoustic", "scores"]).optional(),
          thresholdRMS: z.number().finite().nonnegative().optional(),
          ...pageParams().shape,
        }),
      ]),
    })
    .describe(
      "Read an explicit immutable alignment generation without model or native execution. An asset selector reads retained source evidence. A project selector with a source asset projects those rows through the exact revision map; a selector whose assetId is the prepared tap returned by alignment.observe reads observations measured on that rendered tap and maps its source clock directly to project time without inventing a clip. preparedResourceId pins the project revision and tap; a project range past the revision is clamped to it and reports range-clamped in the result's issues. packageHandle selects published evidence in an open read-only package; its continuation binds that context. Supplied words retain conditional path estimates separately from greedy observed words; repeated correspondence stays unknown and unmatched text stays unmatched. Complete native ceil bounds outside physical support retain null sourceRange/refused_unowned_support, never clamped timing. Scores are complete uncalibrated native cells. Acoustic view requires caller thresholdRMS, labels measured RMS >=threshold active, and never assigns a word or authorizes an edit. Raw view returns original UTF8 operands in bounded base64 chunks, including unpublished managed-library refusals as state:captured with verified:false; those never expose ready rows. Continue while nextCursor exists, including empty pages. Continuations bind the generation, display range, view, operand and threshold.",
    ),
  z
    .strictObject({
      operation: z.literal("speaker.continuity.prepare"),
      params: sourceSelection
        .extend({
          channel: z.int().nonnegative(),
          sourceRange: selectionRangeSchema,
          modelId: id,
          expectedSpeakerCount: z.int().positive().max(8),
          candidate: continuityCandidate.optional(),
        })
        .strict(),
    })
    .describe(
      "Evaluate or prepare one bounded long-form speaker continuity candidate. A candidate retains complete source/model/runtime identity, score extent, frozen control outcomes and quality metrics. Without a measured candidate this operation reports unavailable; it never stretches the bounded 30-second speaker provider, invents identity, or publishes an unverified envelope.",
    ),
  z
    .strictObject({
      operation: z.literal("speaker.continuity.get"),
      params: sourceSelection
        .extend({
          channel: z.int().nonnegative(),
          modelId: id,
          sourceRange: selectionRangeSchema,
          generation: id,
          view: z.literal("receipt").optional(),
          packageHandle: id.optional(),
        })
        .strict(),
    })
    .describe(
      "Read a published long-form speaker continuity receipt by exact source, model and generation identity. Unpublished or refused candidates remain readable as evidence only; no native execution, naming or transcript attribution occurs during a read.",
    ),
  z
    .strictObject({
      operation: z.literal("speaker.observe"),
      params: sourceSelection
        .extend({
          channel: z.int().nonnegative(),
          sourceRange: selectionRangeSchema,
          modelId: id,
        })
        .strict(),
    })
    .describe(
      "Observe one selected source channel over a complete caller-selected support range of 80ms-grid mono16k cells, from 80ms through at most thirty seconds. Each observation is one independent generation; separate windows do not share or imply speaker identity. Joins the same observation; job.retry owns failed/canceled recovery. If the optional model/runtime is unavailable, return retryable MODEL_NOT_PREPARED details; do not acquire it automatically. An admitted native decoder is still required. Never fills holes, mixes channels, infers edits or modifies original media.",
    ),
  z
    .strictObject({
      operation: z.literal("speaker.get"),
      params: z.union([
        projectEvidenceParams
          .extend({
            channel: z.int().nonnegative(),
            modelId: id,
            view: z.literal("intervals").optional(),
            packageHandle: id.optional(),
          })
          .strict(),
        sourceSelection
          .extend({
            channel: z.int().nonnegative(),
            modelId: id,
            sourceRange: selectionRangeSchema,
            packageHandle: id.optional(),
            view: z.enum(["intervals", "scores"]).optional(),
            ...pageParams().shape,
          })
          .strict(),
      ]),
    })
    .describe(
      "Read immutable source observations or their source/project projection without preparing or invoking a model. Project selectors consume retained matching channel/model generations only; no project scores. Optional packageHandle reads the opened immutable package; package project metadata jobs and checkpoints share its bounded context lifetime. sourceRange selects the generation; sourceRange only narrows display. Intervals retain complete exact source ranges, native ordinals and anonymous generation-local slots. Scores retain every original 80ms cell and are uncalibrated, never assignment confidence or silence. Continue while nextCursor exists, including empty pages. Continuations pin the original generation and decoder: a different view, display range or selection refuses with INVALID_PARAMS, and a republished generation or decoder refuses with ARTIFACT_CHANGED. Ready reads need neither the current native executable nor prepared runtime bytes.",
    ),
  z
    .strictObject({
      operation: z.literal("speaker.bind"),
      params: sourceSelection
        .extend({
          requestId: id,
          expectedBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
          channel: z.int().nonnegative(),
          modelId: id,
          sourceRange: selectionRangeSchema,
          generation: id,
          bindings: z
            .array(
              z.strictObject({
                slot: z.int().min(0).max(3),
                displayName: z.string().trim().min(1).max(128),
              }),
            )
            .max(4),
        })
        .strict(),
    })
    .describe(
      "Bind caller-authored display labels to anonymous slots in one retained speaker generation. The generation, source selection, channel and observation range must match published evidence; rebinding replaces the prior names without changing acoustic observations or transcript words. No cross-session identity or automatic naming is performed.",
    ),
  z
    .strictObject({
      operation: z.literal("join.verify"),
      params: project
        .extend({
          revisionId: id,
          preparedResourceId: id,
          tap: processingTapSchema,
          boundary: z.strictObject({ trackId: id, projectAtUs: timeValueSchema }),
          context: z
            .strictObject({
              beforeUs: z.int().min(0).max(4_000_000),
              afterUs: z.int().min(0).max(4_000_000),
            })
            .refine((v) => v.beforeUs + v.afterUs > 0),
          expectedText: z.string().min(1).max(8192),
          thresholdRMS: z.number().finite().nonnegative(),
          candidateOffsetsUs: z.array(z.int().min(-4_000_000).max(4_000_000)).max(16).optional(),
          sourceEvidence: z
            .strictObject({ before: id.optional(), after: id.optional() })
            .optional(),
          renderedAlignmentGeneration: id.optional(),
          renderedSpeechGeneration: z.uuid().optional(),
        })
        .strict(),
    })
    .describe(
      "Read contextual evidence for one explicit audio-track boundary in a pinned revision and prepared tap. Opening, ending and nearby candidate coordinates keep exact source/project mappings. Optional generation pins select already-retained source alignment, prepared-tap alignment and fresh rendered recognition; omitted evidence is reported missing. Source alignment must match each side's asset, stream and acquisition; rendered evidence must match the revision and tap. Return complete bounded alignment rows, acoustic threshold activity, original operand identities, recognition text and missing coverage. Rendered recognition reads at most1000 rows and retains its continuation when incomplete. The expected text is caller-supplied context, never inferred truth. Matching text, source energy and conditional alignment never certify phonetic completeness. This synchronous report performs no inference, model preparation, audio rendering or edit. Prepare padded windows and nearby candidates through ordinary public operations, then explicitly request another report.",
    ),
  z
    .strictObject({
      operation: z.literal("transcript.render.prepare"),
      params: renderedSpeechPreparation,
    })
    .describe(
      "Recognize actual rendered PCM for an explicit project revision, processing tap, range and PCM rendition. This convenience preparation combines immutable audio extraction with fresh Parakeet inference in one project job; it never depends on source transcript readiness or reuses projected source text. A range that runs past the revision is clamped to it, shares the applied range's generation and reports range-clamped in the result's issues; one with no part inside refuses before any job. Missing source support refuses before recognition rather than treating unavailable samples as silence. Published output retains the PCM asset, conversion/origin, exact sample bounds, transcript and fresh generation. Repeat the same request to join/reuse work; models must be prepared through model.prepare. Reads stay offline. Use job.retry for failed/canceled extraction dependencies, or job.cancel to cancel the parent; shared extraction remains independently reusable.",
    ),
  z
    .strictObject({
      operation: z.literal("transcript.render.get"),
      params: project
        .extend({
          revisionId: id,
          generation: id,
          ...pageParams().shape,
        })
        .strict(),
    })
    .describe(
      "Read one retained rendered-speech generation without rendering, inference or model readiness. Rows retain their PCM source range and a distinct exact projectRange mapped from the extraction's actual first sample, not its rounded requested start. Receipt identifies the original revision/tap/range/rendition and immutable PCM asset. Continue with nextCursor, which pins both rendered and PCM transcript generations. transcript.get remains projected source evidence and never aliases this measured output.",
    ),
  z
    .strictObject({
      operation: z.literal("transcript.transcribe"),
      params: sourceTranscriptPreparation,
    })
    .describe(
      "Explicitly request source speech inference. sourceRange selects primary source-clock ownership; one that runs past the source is clamped to it, shares the applied range's generation and reports range-clamped in the result's issues, and one with no part inside is INVALID_RANGE. context adds decode-only outer support, never edits or retimes words. Full support and explicit ranges alike decode in bounded 20-second windows with 4-second internal context and unique shared-context word correspondence. Gaps remain gaps. Local problems never fail the transcript; each is an issue on the published output, and on the word it touches in transcript rows: boundary-unresolved (a seam word with no unique peer, published by the window whose core holds its start), timing-clamped (an estimate past the decoded window, clamped to its edge, original seconds in evidence) and word-dropped (a malformed engine word; its neighbours publish). An output keeps its first 1000 issues; when they end in issues-truncated, the omitted issues appear on no row either, and its count is the only signal. Retained raw evidence keeps every candidate, the original engine values and ownership/merge diagnostics. Models must already be prepared via model.prepare. Repeat identical requests join existing work; read bounded output with its retained generation.",
    ),
  z
    .object({
      operation: z.literal("transcript.get"),
      params: z.union([
        projectTranscriptParams,
        sourceSelection
          .extend({
            speaker: transcriptSpeaker.optional(),
            generation: id.optional(),
            sourceRange: selectionRangeSchema.optional(),
            ...pageParams().shape,
          })
          .strict(),
      ]),
    })
    .strict()
    .describe(
      "Request a project transcript with projectId and optional revisionId, range and trackIds, or a selected asset-stream source transcript. Project rows retain occurrence identity and exact editorial fragments, ordered by project time; query windows do not change editorial partiality. Continue even when a project page is empty if nextCursor exists. Project continuations pin the original revision, source generations and any selected speaker generations/binding digests. Asset ranges use the normalized source clock; acquisitionId omission uses physical support. Reads and search never enqueue transcription or prepare models. Use transcript.transcribe to request inference. generation selects retained source evidence; bounded preparations require that pin (a continuation already pins it). Omitted generation resolves only full-support preparation identity. Project sourceGenerations explicitly select bounded retained dependencies; speakerGenerations joins caller-selected speaker evidence to projected words without inferring identity; omitted selections resolve full-support identities. A ready project may prepare its read-only evidence manifest. Returns readiness until complete, then word and acquisition-gap rows in the selected time domain. issues holds the read's own range admission; a ready source read also carries published { generation, issues }, every issue published with that transcript, including those no row carries (word-dropped, an unpublished boundary peer), and each source dependency of a project read carries its transcript's issues. Unfiltered asset enumeration returns every retained observation, including points at the source end. Explicit source/project interval selections remain half-open. Words keep verbatim text, kind and a per-generation ID. A source read may include a generation-pinned speaker selector; each word is attributed only when one retained turn wholly covers it and no other speaker intersects it. A partial competing turn therefore remains overlap evidence; crossing turns without a complete covering turn and unobserved support remain explicit unknown, while multiple intersecting turns are overlap. The returned continuation pins the speaker binding digest so a rename cannot silently change a page. Without narration it is unavailable:no_narration; unprepared models are a retryable unavailable:model_not_prepared (see model.prepare). Continue with the returned cursor to pin selection, generation and range.",
    ),
  z
    .object({ operation: z.literal("transcript.review"), params: transcriptReviewParams })
    .strict()
    .describe(
      "Review a bounded source or pinned-project transcript in one agent-friendly call. This convenience operation combines transcript.transcribe when retained evidence is missing with transcript.get for the bounded page; it may return pending while transcription runs. A missing parakeet transcription model is prepared automatically, even after model.remove, and the call reports pending meanwhile. If a model or runtime it needs is otherwise unavailable, return retryable MODEL_NOT_PREPARED details so the agent can ask the user before model.prepare. The operation returns readiness, exact transcript rows, generation, continuation and the issues published with the transcript it reads. It never invents words or edits a project.",
    ),
  z
    .object({
      operation: z.literal("transcript.disfluency.get"),
      params: sourceSelection
        .extend({
          generation: id.optional(),
          range: range.optional(),
          ...pageParams().shape,
        })
        .strict(),
    })
    .strict()
    .describe(
      "Read observed filler and vocalization evidence from a pinned source transcript. This filtered convenience read is equivalent to transcript.get plus lexical filtering; it reports only emitted words, preserves transcript generation and coverage, and never invents a missed filler or authorizes an edit.",
    ),
  z
    .object({
      operation: z.literal("transcript.search"),
      params: z.union([
        projectTranscriptParams.extend({ text: z.string().min(1).max(200) }).strict(),
        sourceSelection
          .extend({
            text: z.string().min(1).max(200),
            generation: id.optional(),
            ...pageParams().shape,
          })
          .strict(),
      ]),
    })
    .strict()
    .describe(
      "Search a project, selected source or ready narration transcript for literal, case-folded text over consecutive words, ignoring outer punctuation. This filtered convenience read searches retained transcript evidence without requiring the caller to page every word through transcript.get. Project matches follow consecutive whole words on each selected audio track, may cross contiguous clips, and stop at gaps or partial words. Each match carries all contributing word/clip identities and the widest exact projectRange across its word estimates; simultaneous speakers never form a shared phrase. Source entries carry word IDs and source range; phrases can cross accepted inference seams but stop at unavailable, unobserved or skipped support. Returns readiness like transcript.get until complete. Continue while nextCursor exists, even if entries is empty, to keep the same revision, generation and text.",
    ),
  z
    .object({ operation: z.literal("preset.list"), params: pageParams() })
    .strict()
    .describe(
      "List installed presets. A preset is a style bundle an agent follows to shoot and edit a kind of video. This is unrelated to settings.preset and to the preset field on voice.generate.",
    ),
  z
    .object({
      operation: z.literal("preset.get"),
      params: z.object({ presetId: z.string().min(1) }).strict(),
    })
    .strict()
    .describe(
      "Read one preset by id. A preset is a style bundle an agent follows to shoot and edit a kind of video. This is unrelated to settings.preset and to the preset field on voice.generate.",
    ),
  z
    .object({
      operation: z.literal("preset.update"),
      params: z.object({ presetId: z.string().min(1).optional(), requestId: id }).strict(),
    })
    .strict()
    .describe(
      "Refresh installed presets from the pinned remote source, optionally selecting one preset plus shared kit and authoring packages. An unreachable source is reported in the result and leaves the installed presets unchanged. This is unrelated to settings.preset and to the preset field on voice.generate.",
    ),
  z
    .object({
      operation: z.literal("preset.create"),
      params: z
        .object({
          requestId: id,
          name: z.string().min(1),
          references: z.array(z.string()).optional(),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Create a local preset style bundle from the authoring template. Call it only when the user asked for a preset or confirmed an offer to save a project's style. This is unrelated to settings.preset and to the preset field on voice.generate.",
    ),
  z
    .object({
      operation: z.literal("preset.delete"),
      params: z.object({ presetId: z.string().min(1), requestId: id }).strict(),
    })
    .strict()
    .describe(
      "Move a local preset to the macOS Trash so it can be restored from Finder. This is unrelated to settings.preset and to the preset field on voice.generate.",
    ),
  z
    .object({ operation: z.literal("model.list"), params: pageParams() })
    .strict()
    .describe(
      "Discover immutable registered model IDs, purpose, platform, content identities and preparation requirements without preparing anything. Results are paged newest first with an opaque cursor.",
    ),
  z
    .object({
      operation: z.literal("model.status"),
      params: z.object({ modelId: z.string().min(1) }).strict(),
    })
    .strict()
    .describe(
      "Verify the selected registered model locally without network access. Returns unavailable, running with byte progress and etaMs, ready, failed, or unavailable. While running, poll this operation; etaMs is a measured estimate and may be null before enough bytes arrive.",
    ),
  z
    .object({
      operation: z.literal("model.prepare"),
      params: z
        .object({
          modelId: z.string().min(1),
          runtimeSource: z.string().startsWith("/").optional(),
          modelSource: z.string().startsWith("/").optional(),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Explicitly prepare the selected registered model. Supply absolute runtimeSource and modelSource when model.list marks them required. modelSource admits pinned local files; omission downloads only when the registered acquisition policy permits it. Returns preparation progress; poll model.status. Reuses ready files and joins current preparation. Status and execution never acquire dependencies.",
    ),
  z
    .object({
      operation: z.literal("model.remove"),
      params: z.object({ modelId: id, requestId: id }).strict(),
    })
    .strict()
    .describe(
      "Remove every prepared file for the selected registered model, including its compiler cache and staging bytes. This is for a user who no longer wants the model, such as before uninstalling Yap. A running job that uses the model is a retryable MODEL_IN_USE refusal. Startup does not prepare a removed model again, but Yap always keeps a transcription model: transcript.review prepares parakeet again whenever it needs it. Call model.prepare to acquire any other removed model.",
    ),
  z
    .object({
      operation: z.literal("frame.batch"),
      params: z.union([
        projectFrameParams.extend({ atUs: z.array(time).min(1).max(8) }),
        sourceFrameParams.extend({ atUs: z.array(time).min(1).max(8) }),
      ]),
    })
    .strict()
    .describe(
      "Request one to eight ordered frames pinned to one revision. This batch convenience operation is equivalent to repeated frame.get calls while preserving order, per-item readiness/errors and shared work for duplicates. Poll the returned revision and retry individual failures with job.retry. Optional observations measure the same delivered upright raster; rectangles use delivered top-left pixels and metrics include only fully opaque pixels.",
    ),
  z
    .object({ operation: z.literal("cursor.render"), params: cursorRenderParams })
    .strict()
    .describe(
      "Render one to eight source or pinned-project frames with an explicit capture cursor trail using an ephemeral review plan. This convenience operation combines cursor.raw observations with frame.get delivery and overlays the trail for review; it does not persist a project processing step. Trail duration is 0 through 10 seconds. Reuse per-item readiness/errors and pinned timing. Source selections require captured-video authority for cursor evidence. Use cursor.raw for exact observations and frame.get for clean overlay-free pictures.",
    ),
  z
    .object({
      operation: z.literal("preview.get"),
      params: previewParams,
    })
    .strict()
    .describe(
      "Request a playable MP4 of a pinned project. Projects accept an optional range in project microseconds and an optional maxLongEdge draft bound; omitted range renders the whole project. Returns readiness until complete; pin the returned revision when polling. CLI writes a file; MCP returns a delivery token for artifact.read/close.",
    ),
  z
    .object({
      operation: z.literal("voice.generate"),
      params: z.strictObject({
        modelId: id,
        reference: z.strictObject({
          assetId: id,
          streamId: id,
          origin: z.record(z.string(), z.json()).optional(),
        }),
        referenceText: z.string(),
        text: z.string(),
        preset: id.optional(),
        seed: z.string().optional(),
        generation: z
          .strictObject({
            temperature: z.number().optional(),
            top_k: z.int().optional(),
            top_p: z.number().optional(),
            repetition_penalty: z.number().optional(),
            max_tokens: z.int().optional(),
            lang_code: z.string().optional(),
            stream: z.literal(false).optional(),
          })
          .optional(),
      }),
    })
    .strict()
    .describe(
      "Generate a durable audio asset from an admitted complete mono24k Float32 reference, exact reference transcript and desired text. Inspect model.list for immutable profile defaults and supported settings; preset, when supplied, names that profile. Optionally echo one full reference origin returned by asset.origins or audio.extract; omission selects none. Shared jobs own progress, explicit retry and cancellation. Saved output replays without model readiness, and the result retains reference bytes. No project edit or automatic preparation; ordinary edit.apply owns placement and fit.",
    ),
  z
    .object({
      operation: z.literal("audio.extract"),
      params: z.union([
        sourceAudioParams.extend({
          rendition: extractedAudioRendition,
        }),
        projectAudioParams.extend({
          revisionId: id,
          range: audioRange,
          tap: processingTapSchema,
          rendition: extractedAudioRendition,
        }),
      ]),
    })
    .strict()
    .describe(
      "Retain a raw source selection or pinned project processing tap as an independent Float32 audio asset. Specify rendition sampleRate and mono/stereo channels; omit a source range to acquire the complete source, preserving canonical complete WAV bytes. Return shared job readiness and, when ready, asset/stream, exact frames and typed historical extraction origin. Does not edit the project or retain its donor graph after success; use job.retry and job.cancel for failed or active work.",
    ),
  z
    .object({
      operation: z.literal("audio.prepare"),
      params: project.extend({ revisionId: id, tap: processingTapSchema.optional() }).strict(),
    })
    .strict()
    .describe(
      "Explicitly prepare a complete project processing tap of a pinned revision as a retained lossless 48kHz stereo asset. Omitted tap means processed output; clip/track/group/output and dry/processed/after-step use the same selection meaning as audio.get. Preparation preserves whole processing-state domains, never a cold excerpt, and does not edit the document or current revision. Normalization feasibility and strict measured targets settle before expensive picture encoding. Returns readiness/jobId and a published audio receipt with assetId; use asset.get and ordinary audio/waveform/spectrogram inspection. Repeat the exact selection to reuse work; failed/canceled work requires job.retry, and job.cancel drains an attempt. Only a matching processed-output preparation is reusable by video export; another tap cannot replace the final mix. Unavailable processors or retiming refuse before admission; no model is downloaded.",
    ),
  z
    .object({ operation: z.literal("audio.get"), params: audioParams })
    .strict()
    .describe(
      "Request project WAV audio with projectId, optional revisionId/range and processing tap (defaults to processed output). Clip/track/group taps exclude later parent stages; dry skips the selected target stack while retaining child processing, and after-step includes the named step. Omitted project range uses the full pinned project; project output is 48kHz stereo and ranges retain the absolute sample clock. Or request a WAV from an explicitly selected assetId/streamId with optional acquisitionId and source-time range. Omitted source range extracts the full selected stream at its native supported rate/layout; unavailable support is explicit. CLI streams to a file; MCP embeds small audio and leaves large audio as a renewable artifact.read/close delivery. Pin selection, range and any returned revision while polling.",
    ),
  z
    .object({ operation: z.literal("audio.measure"), params: loudnessParams })
    .strict()
    .describe(
      "Measure the exact selected source PCM or pinned project processing tap without treatment. This convenience operation combines the audio.get selection with loudness analysis; optional preparedResourceId pins an existing prepared project signal. Omitted range means the full selected signal; an explicit smaller range is an excerpt. Returns readiness/jobId then published measurement with exact clock, source/revision/tap, PCM generation, recipe and meter identities, integrated LUFS, loudness range in LU, sample peak in dBFS and true peak in dBTP. Native channel interpretation is default; dual-mono is explicit and requires mono. True-peak libswresample analysis defaults on; false requests sample peak only. Missing support refuses with available/unavailable ranges; authored silence remains signal. Silence/below-gate or insufficient duration returns null loudness with a reason; never use the scanner's empty-gate sentinel as a finite measurement. Pin returned revision/range while polling; explicit job.retry recovers failed work. This does not normalize, edit, acquire tools or choose targets.",
    ),
  z
    .object({
      operation: z.literal("frame.get"),
      params: frameParams,
    })
    .strict()
    .describe(
      "Request a raw PNG/JPEG image with assetId, streamId and optional maxLongEdge; omit atUs and acquisitionId for images. The delivered PNG is upright; its receipt retains source orientation and has no sample clock. Request a selected video source picture with assetId, streamId, optional acquisitionId and source-clock atUs. Physical gaps return unavailable without a synthetic image. Or request a project picture at atUs with optional revisionId, maxLongEdge and video processing tap. Its global sample time can precede the requested time; the receipt separates compiled timing from actual decoded source samples. Project stills use the movie compositor and do not add capture pointer overlays. Pin the returned revision when polling. Optional observations:{} returns full/explicit-region encoded-sRGB luma and RGB histograms, endpoint fractions, alpha/clipping coverage and measured dark-edge candidates. Rectangles address delivered upright top-left pixels; candidates and caller region labels never establish letterboxing, face detection or an automatic grade.",
    ),
  z
    .object({ operation: z.literal("waveform.get"), params: waveformParams })
    .strict()
    .describe(
      "Inspect a selected audio source or project processing tap as per-channel min/max/RMS JSON or a labeled image with format:image. This convenience operation combines the audio.get selection with waveform aggregation. Omit bucketFrames for an automatic overview; set a positive sample count for finer inspection (maximum 4096 buckets). Returned sample bounds and resolution are exact; unavailable support is not proof of silence. CLI writes JSON to --output; MCP returns its JSON text or image. Pin the returned project revision while polling. This measures audio and never edits it.",
    ),
  z
    .object({ operation: z.literal("spectrogram.get"), params: spectrogramParams })
    .strict()
    .describe(
      "Inspect a bounded selected-source or project audio tap as a time/frequency image. This convenience operation combines the audio.get selection with spectrogram analysis. Defaults to fftFrames:1024 and hopFrames:512; FFT must be a power of two, hop no larger than FFT. Narrow the range when the 262144 channel/time/frequency-cell limit is exceeded. Surrounding PCM preserves range/full alignment; unavailable support is distinct from silence. Channels remain separate. Labels report density in dB relative to full-scale squared per Hz, with a fixed display floor; the image cannot establish speech quality. Pin revision while polling.",
    ),
  z
    .object({ operation: z.literal("audio.pause.get"), params: pauseParams })
    .strict()
    .describe(
      "Measure low-energy pause candidates for the selected source or pinned project audio without editing it. This convenience operation combines the audio.get selection with pause detection. Omit detector settings to use the tested RMS technical default; thresholdRMS, minDurationUs and channel override it explicitly. The ready receipt exposes the resolved threshold, window, hop, channel, algorithm and version, and separates unavailable support from measured low energy. Continue with cursor while nextCursor exists; results are evidence only and do not authorize a cut.",
    ),
  z
    .object({
      operation: z.literal("artifact.read"),
      params: z
        .object({
          token: id,
          offsetBytes: time,
          maxBytes: z.int().min(1).max(ARTIFACT_CHUNK_BYTES).default(ARTIFACT_CHUNK_BYTES),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Read a bounded base64 chunk from a media or complete JSON operation-result delivery; retrying an offset returns the same bytes.",
    ),
  z
    .object({
      operation: z.literal("artifact.renew"),
      params: z.object({ token: id, requestId: id }).strict(),
    })
    .strict()
    .describe(
      "Extend a live delivery for an active consumer. Returns the same token and byte count with a new expiry. Expired, closed or deleted deliveries cannot be revived; close when finished.",
    ),
  z
    .object({ operation: z.literal("artifact.close"), params: z.object({ token: id }).strict() })
    .strict()
    .describe("Release a media or operation-result delivery; closing it again succeeds."),
  z
    .object({
      operation: z.literal("timeline.events"),
      params: z.union([projectEvidenceParams, sourceCaptureParams(500, true)]),
    })
    .strict()
    .describe(
      "Read measured source scene changes, captured pause/geometry, show-your-agent marks and explicit capture-end interruption markers for a selected asset stream or project. Marks are returned as active stroke, pin and click rows with retractions applied and points projected through their captured geometry epoch. Source selectors use sourceRange; project selectors use range/revisionId/trackIds. Capture identity requires explicit acquisitionId; missing metadata is unavailable, not an empty success. Timed geometry belongs to captured video; pauses follow each bound timed occurrence. Normal completion contributes no interruption marker. Capture-end markers require trustworthy timed completion; missing, damaged or conflicting termination is explicitly unavailable. These closing boundaries use left support and (start,end] query ownership; ordinary observations stay [start,end). A shorter selected audio stream never relocates the capture endpoint. Video scenes use retained physical picture clocks without requiring capture metadata. Initial reads may be queued during scene preparation; inspect returned dependency/job state and use job.retry for explicit recovery. Project cut rows describe track-local editorial mapping transitions with exact projectAtUs, audio/video mediaKind and nullable before/after sides; they are not measured scene changes or proof of a visible composite change. Continuous pure splits do not create cuts; internal entrances/exits and rate changes do. Cut queries use [start,end), while physical support gaps remain availability evidence. Cut coverage is supplied by the pinned project revision, independently of source cut availability. Preserve first-page coverage and exact projectAtUs values across continuations. Continue while nextCursor exists, even if rows is empty. Adjacent rows with equal atUs form one logical group and may span pages. A cursor pins its target, revision and source/scene generations.",
    ),
  z
    .object({
      operation: z.literal("cursor.raw"),
      params: z.union([projectEvidenceParams, sourceCaptureParams(5000)]),
    })
    .strict()
    .describe(
      "Page raw cursor observations with explicit capture authority. Selected assets use sourceRange and require acquisitionId for captured video; project selectors use range/revisionId/trackIds and return each retained occurrence with exact projectAtUs. Raw coordinates, captureAtUs and integrity receipt remain unchanged; this does not simulate crop/zoom. Missing capture metadata reports unavailable coverage. Keep first-page coverage and continue while nextCursor exists, even on empty pages.",
    ),
  z
    .object({ operation: z.literal("login.status"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Read whether Yap is registered to open at macOS login and whether macOS requires approval.",
    ),
  z
    .object({
      operation: z.literal("login.setEnabled"),
      params: z.object({ enabled: z.boolean() }).strict(),
    })
    .strict()
    .describe(
      "Register or unregister Yap as a macOS login item after the user explicitly confirms the choice.",
    ),
  z
    .object({ operation: z.literal("shortcuts.get"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Read Yap's global shortcuts: for each action its name, keys (as shortcuts.set takes them), label, during (app or recording) and state (active, refused_by_macos).",
    ),
  z
    .object({
      operation: z.literal("shortcuts.set"),
      params: z
        .object({
          bindings: z
            .record(z.string().min(1), z.string().min(1))
            .describe(
              'Action id to keys, e.g. {"capture.startOrStop": "ctrl+cmd+r"}. Modifiers ctrl, option, shift, cmd, then one key: a character the current keyboard layout types, or return, tab, space, delete, escape, forwarddelete, home, end, pageup, pagedown, left, right, up, down, f1–f20, keypad0–keypad9, keypadplus, keypadminus, keypadmultiply, keypaddivide, keypadequals, keypaddecimal, keypadenter, keypadclear, or keyNN for any physical key code. Anything but a function key needs ctrl, option or cmd.',
            ),
        })
        .strict(),
    })
    .strict()
    .describe(
      "Bind the named actions, apply them immediately and persist them; other actions keep their keys. Answers like shortcuts.get, so a refused_by_macos state says another app or macOS holds those keys.",
    ),
  z
    .object({ operation: z.literal("shortcuts.reset"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Put every shortcut back on Yap's default keys, as Settings' Reset All Shortcuts to Defaults does. Answers like shortcuts.get.",
    ),
  z
    .object({ operation: z.literal("update.status"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Read the native updater's availability, automatic-update preference, manual-check readiness and current result without checking the feed.",
    ),
  z
    .object({ operation: z.literal("update.check"), params: z.object({ requestId: id }).strict() })
    .strict()
    .describe(
      "Check immediately and download an available compatible update, even when automatic updates are disabled. Does not change that preference or interrupt work; installation waits for existing idle admission and CLI clients to finish. Follow update.status for progress.",
    ),
  z
    .object({
      operation: z.literal("update.setEnabled"),
      params: z.object({ enabled: z.boolean() }).strict(),
    })
    .strict()
    .describe(
      "Set the native updater's persisted automatic checks/downloads/installation preference. Disabling cancels pending automatic or manual update work before final replacement authorization; after that boundary it applies to the successor.",
    ),
  z
    .object({ operation: z.literal("skill.status"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Read the account-level Yap consumer skill installation, including whether it is managed, current, missing or needs attention and the harness destinations the bundled skills installer discovers.",
    ),
  z
    .object({ operation: z.literal("skill.install"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Start a durable install/replace of the account-level Yap consumer skill through the app's bundled, pinned skills installer, allowing it to discover every supported agent harness. The response is a running status with a jobId; poll skill.status for completion.",
    ),
  z
    .object({ operation: z.literal("skill.uninstall"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Start a durable removal of the account-level Yap consumer skill and its discovered harness links when Yap owns the installation; leaves project-local skills untouched. The response is a running status with a jobId; poll skill.status for completion.",
    ),
  z
    .object({ operation: z.literal("skill.update"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Start a durable refresh of the account-level Yap consumer skill through the app's bundled, pinned skills installer, replacing an existing global Yap skill and verifying all discovered harness destinations. The response is a running status with a jobId; poll skill.status for completion.",
    ),
  z
    .object({ operation: z.literal("cli.status"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Report the app-managed yap command at ~/.local/bin/yap: state (installed, missing, different, unavailable or needs_attention), path, whether it is on PATH, the shell profile Yap edited if any, and any error. unavailable means this app build carries no launcher or runs outside an Applications folder.",
    ),
  z
    .object({ operation: z.literal("cli.install"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Install or refresh ~/.local/bin/yap from the launcher bundled in the running app, replacing a different file there, and add Yap's marked PATH line to the login-shell profile when no startup file already puts ~/.local/bin on PATH. Synchronous; returns cli.status.",
    ),
  z
    .object({ operation: z.literal("cli.uninstall"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Remove ~/.local/bin/yap only while it is identical to the bundled launcher, and remove only Yap's marked PATH block. Synchronous; returns cli.status.",
    ),
  z
    .object({ operation: z.literal("service.health"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Read local service readiness without starting capture. Includes every registered model's purpose and readiness from its preparation receipt; preparing models report receivedBytes, totalBytes and etaMs so an agent can wait without guessing. Use model.status to verify a model's installed bytes; execution verifies them again.",
    ),
  z
    .object({ operation: z.literal("service.tools"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Discover the selected app's Node runtime and verified bundled FFmpeg/ffprobe paths, hashes, version and configuration. Missing or mismatched tools report unavailable without changing native defaults; tool inventory does not imply core operation support.",
    ),
  z
    .object({ operation: z.literal("capture.sources"), params: z.object({}).strict() })
    .strict()
    .describe(
      "List screen sources, microphones and camera discovery identities without activating devices. Camera selection is explicit and never requests permission automatically.",
    ),
  z
    .object({
      operation: z.literal("capture.start"),
      params: captureSelectionSchema.safeExtend({ requestId: id }).strict(),
    })
    .strict()
    .describe("Allocate a take and start capturing it; a repeated request ID replays one take."),
  z
    .object({ operation: z.literal("capture.status"), params: z.object({}).strict() })
    .strict()
    .describe(
      "Read native device state, screen/microphone/camera permission facts and the active or recovering take. A finalizing take can retain finalizationError across service restart; stop explicitly retries failed recovery.",
    ),
  z
    .object({ operation: z.literal("capture.pause"), params: recording })
    .strict()
    .describe("Pause the named take; an already paused take answers with its current state."),
  z
    .object({ operation: z.literal("capture.resume"), params: recording })
    .strict()
    .describe("Resume the named take; an already recording take answers with its current state."),
  z
    .object({
      operation: z.literal("capture.setCamera"),
      params: z.object({ recordingId: id, on: z.boolean() }).strict(),
    })
    .strict()
    .describe(
      "Turn the named live screen take's reserved camera on or off, any number of times. Off time is a gap in the camera source, never a held picture. Setting the current state answers with it. Answers like capture.status.",
    ),
  z
    .object({ operation: z.literal("capture.stop"), params: recording })
    .strict()
    .describe(
      "Begin finalizing the named take or explicitly retry its failed recovery. A finalizing acknowledgment is not completion: inspect recording.get/status, including finalizationError, and await terminal state before importing. A settled take answers with its stored outcome.",
    ),
  z
    .object({ operation: z.literal("capture.cancel"), params: recording })
    .strict()
    .describe(
      "Cancel the named live take. During recovery, abort and drain finalization while retaining ambiguous media and its finalizationError; use stop to retry or explicit library deletion to remove retained bytes. A take that already finished cannot be canceled.",
    ),
  z
    .object({
      operation: z.literal("capture.restart"),
      params: captureSelectionSchema.safeExtend({ recordingId: id, requestId: id }).strict(),
    })
    .strict()
    .describe(
      "Discard the named take and start a distinct new one. Pending recovery returns a retryable refusal and does not start a replacement; inspect the previous take before a new restart request.",
    ),
  z
    .object({
      operation: z.literal("media.list"),
      params: pageParams(),
    })
    .strict()
    .describe(
      "Page through recordings and imported originals newest first with one opaque cursor. Each item names its kind (recording or asset) and id. Capture copies, generated or derived assets, tombstoned items and canceled takes are excluded.",
    ),
  z
    .object({
      operation: z.literal("recording.list"),
      params: pageParams(),
    })
    .strict()
    .describe(
      "Page through discoverable recordings newest first with the shared opaque cursor and 1–1000 limit (default 100).",
    ),
  z
    .object({ operation: z.literal("recording.cleanup"), params: recording })
    .strict()
    .describe(
      "Explicitly reclaim verified publication working files from a settled recording. Returns the status of that work with its jobId; follow it with job.get, job.retry and job.cancel. Unverified media remains retained; recording state and canonical media are unchanged.",
    ),
  z
    .object({
      operation: z.literal("recording.get"),
      params: z.object({ recordingId: id.optional() }).strict(),
    })
    .strict()
    .describe(
      "Read one recording by its stable identity, or omit recordingId to resolve the latest take. Includes unfinished finalizationError and terminal interruptionReason. PUBLICATION_CONFLICT denotes conflicting publication media or proof identities; the code alone does not identify the particular file or establish which streams remain readable.",
    ),
  z
    .object({
      operation: z.literal("recording.prompt"),
      params: z.union([
        z.object({ recordingId: id.optional() }).strict(),
        z.object({ projectId: id }).strict(),
        z.object({ assetId: id }).strict(),
      ]),
    })
    .strict()
    .describe(
      "Return the text a person pastes to hand media to an agent, with the facts it was written from. For a recording (omit recordingId for the latest take) the text describes capture sources, duration or live status, pins/drawings presence and transcript readiness without listing individual evidence. Live, importing and failed-import takes receive a prompt without waiting for completion. A projectId or assetId returns that item's one-line ID handoff.",
    ),
  z
    .object({
      operation: z.literal("revision.get"),
      params: project.extend({ revisionId: id.optional() }).strict(),
    })
    .strict()
    .describe("Read a specified revision, or resolve the current authored project revision once."),
  z
    .object({
      operation: z.literal("revision.history"),
      params: historyParams(project).extend(pageParams().shape),
    })
    .strict()
    .describe("Read a bounded page of history pinned to its initial revision ordinal."),
  z
    .object({ operation: z.literal("edit.undo"), params: projectEdit })
    .strict()
    .describe("Undo the active edit by creating a new revision identity."),
  z
    .object({
      operation: z.literal("edit.restore"),
      params: projectEdit.extend({ targetRevisionId: id }),
    })
    .strict()
    .describe("Restore a historical edit into a new revision identity."),
]);

export type OperationName = z.infer<typeof operationSchema>["operation"];
export const operationNames: ReadonlySet<string> = new Set(
  operationSchema.options.map((option) => option.shape.operation.value),
);

/** Operations that only return retained state or evidence and never change it. */
export const readOnlyOperations: ReadonlySet<OperationName> = new Set<OperationName>([
  "project.get",
  "project.list",
  "inspect.open",
  "caption.propose",
  "layout.diagnostics",
  "processing.get",
  "output.capabilities",
  "processing.capabilities",
  "acquisition.get",
  "asset.get",
  "asset.segments",
  "asset.origins",
  "asset.list",
  "job.get",
  "export.list",
  "export.status",
  "package.status",
  "storage.usage",
  "index.get",
  "face.trajectory.get",
  "index.coverage",
  "index.frame",
  "index.frames",
  "correspondence.get",
  "alignment.get",
  "speaker.continuity.get",
  "speaker.get",
  "join.verify",
  "transcript.render.get",
  "transcript.get",
  "transcript.disfluency.get",
  "transcript.search",
  "preset.list",
  "preset.get",
  "model.list",
  "model.status",
  "preview.get",
  "audio.get",
  "frame.get",
  "waveform.get",
  "spectrogram.get",
  "audio.pause.get",
  "artifact.read",
  "timeline.events",
  "cursor.raw",
  "login.status",
  "shortcuts.get",
  "update.status",
  "skill.status",
  "cli.status",
  "service.health",
  "service.tools",
  "capture.sources",
  "capture.status",
  "recording.list",
  "media.list",
  "recording.get",
  "recording.prompt",
  "revision.get",
  "revision.history",
]);

/** Operations whose repeated input or target state joins existing work or changes nothing. */
export const idempotentOperations: ReadonlySet<OperationName> = new Set<OperationName>([
  "asset.convert", // same source streams and recipe join the same content-addressed conversion job.
  "correspondence.prepare", // the supplied endpoint measurement has one content-addressed receipt.
  "alignment.observe", // same source/project operands join the same retained alignment job.
  "speaker.continuity.prepare", // the same candidate is evaluated into the same receipt.
  "speaker.observe", // same source window/model joins the same speaker evidence job.
  "transcript.render.prepare", // same revision/tap/range/rendition joins the same rendered transcript job.
  "transcript.transcribe", // same source selection and context joins the same transcript job.
  "transcript.review", // review reads or prepares the same bounded transcript selection.
  "frame.batch", // the same frame selection joins the same per-frame deliveries.
  "cursor.render", // the same cursor and frame selection produces the same ephemeral deliveries.
  "voice.generate", // the same reference, text and generation settings join the same asset job.
  "audio.extract", // the same source/tap/rendition joins the same extracted audio job.
  "audio.prepare", // the same project tap joins the same prepared audio job.
  "audio.measure", // the same selected signal joins the same measurement job.
  "job.retry", // retrying a ready or already queued job leaves its target at the same work state.
  "job.cancel", // canceling an already canceled or settled job changes nothing.
  "export.cancel", // canceling an already canceled export is a no-op.
  "export.abandon", // abandoning an already abandoned export is a no-op.
  "package.close", // closing an already closed admission changes nothing.
  "model.prepare", // preparing an already ready model reuses its receipt.
  "artifact.close", // closing an already closed token changes nothing.
  "login.setEnabled", // setting the existing login-item preference changes nothing.
  "update.setEnabled", // setting the existing updater preference changes nothing.
  "shortcuts.set", // setting the existing bindings changes nothing.
  "shortcuts.reset", // restoring the defaults twice leaves the defaults.
  "skill.install", // installing an already installed skill is a no-op.
  "skill.uninstall", // uninstalling an absent skill is a no-op.
  "skill.update", // updating an already current skill is a no-op.
  "cli.install", // installing the matching launcher is a no-op.
  "cli.uninstall", // uninstalling an absent launcher is a no-op.
  "capture.pause", // pausing an already paused take changes nothing.
  "capture.resume", // resuming an already recording take changes nothing.
  "capture.setCamera", // setting the camera to its current state changes nothing.
  "capture.stop", // stopping an already settled take returns its stored outcome.
  "capture.cancel", // canceling an already canceled take changes nothing.
  "recording.cleanup", // cleanup of already reclaimed files changes nothing.
]);

/**
 * Operations the native app owns and answers on its own socket: updating, the installed command
 * and skill, and the login item. They must keep working when the service cannot, since an update
 * is how a broken service gets fixed.
 */
export const appOperations: ReadonlySet<string> = new Set(
  [...operationNames].filter((name) => /^(update|skill|cli|login|shortcuts)\./.test(name)),
);

const nativeCall = DEFAULT_CALL_TIMEOUT_MS;
const workerRun = MEDIA_WORKER_TIMEOUT_MS;
// Drains and scans wait on other work finishing; a retry joins the same in-flight work.
const drain = 180_000;
const waits: Partial<Record<OperationName, number>> = {
  "login.status": nativeCall,
  "login.setEnabled": nativeCall,
  "shortcuts.get": nativeCall,
  "shortcuts.set": nativeCall,
  "shortcuts.reset": nativeCall,
  "update.status": nativeCall,
  "update.check": nativeCall,
  "update.setEnabled": nativeCall,
  "skill.status": nativeCall,
  "skill.install": nativeCall,
  "skill.uninstall": nativeCall,
  "skill.update": nativeCall,
  "cli.status": nativeCall,
  "cli.install": nativeCall,
  "cli.uninstall": nativeCall,
  "capture.sources": nativeCall,
  "capture.status": nativeCall,
  "capture.pause": nativeCall,
  "capture.resume": nativeCall,
  // Turning a camera on opens the device cold, behind any control call already in the queue.
  "capture.setCamera": 2 * nativeCall,
  // Recovery is acknowledged; only native termination and authoritative quiet inspection wait here.
  "capture.cancel": 2 * nativeCall,
  "capture.stop": 2 * nativeCall,
  // An unanswered start can require stop and quiet inspection before recovery acknowledgment.
  "capture.start": 3 * nativeCall,
  "capture.restart": 4 * nativeCall,
  "export.create": workerRun,
  "export.abandon": drain,
  "package.open": drain,
  "package.close": drain,
  "recording.delete": drain,
  "asset.delete": drain,
  "job.cancel": drain,
  "project.delete": drain,
  "storage.usage": drain,
  "preset.update": drain,
};

/** The longest the service waits on one operation's own path before answering it. */
export function operationWaitMs(operation: string): number {
  return waits[operation as OperationName] ?? DEFAULT_CALL_TIMEOUT_MS;
}

/**
 * How long a client waits for one operation's answer. It outlasts every wait the service bounds on
 * that operation's own path, so the service's outcome, including its own timeout, reaches the
 * caller rather than a transport guess about work that is still running.
 */
export function operationDeadlineMs(operation: string): number {
  return operationWaitMs(operation) + 5_000;
}
