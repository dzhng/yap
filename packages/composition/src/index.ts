export { lutMetadataSchema } from "./lut.js";
export {
  assetSchema,
  acquisitionContextSchema,
  streamSchema,
  compositionSchema,
  anchorSchema,
  clipSchema,
  mediaClipSchema,
  silenceClipSchema,
  textClipSchema,
  textSourceSchema,
  textStrokeSchema,
  textShadowSchema,
  textBackgroundSchema,
  textHighlightSchema,
  textTimedWordSchema,
  textSeedSchema,
  textSeedCueSchema,
  textSeedCuesSchema,
  fontReferenceSchema,
  clipAssetIds,
  documentAssetIds,
  documentAcquisitionIds,
  isMediaClip,
  rangeSchema,
  fractionSchema,
  signedFractionSchema,
  signedTimeValueSchema,
  timeValueSchema,
  selectionRangeSchema,
  angleGroupSchema,
  angleSegmentSchema,
  synchronizationEvidenceSchema,
} from "./schema.js";
export type {
  Anchor,
  Asset,
  AcquisitionContext,
  Clip,
  MediaClip,
  TextSource,
  TextSeed,
  TextSeedCue,
  Composition,
  Fraction,
  Range,
  SelectionRange,
  TimeValue,
  SignedTimeValue,
  Stream,
  AngleGroup,
  AngleSegment,
  SynchronizationEvidence,
} from "./schema.js";
export type { Rational } from "./rational.js";
export {
  rational,
  compare,
  fromTime,
  timeUs,
  toTime,
  toSignedTime,
  floor,
  ceil,
  round,
  add,
  multiply,
  subtract,
  divide,
} from "./rational.js";

export {
  validateComposition,
  sourceAvailability,
  resolvePlacement,
  placementForRange,
  projectToSource,
  sourceToProject,
} from "./model.js";
export type {
  ExactRange,
  ResolvedPlacement,
  ValidatedComposition,
  SourceOccurrence,
  ProjectOccurrence,
} from "./model.js";
export { applyBatch, editOperationSchema } from "./edits.js";
export type { EditOperation, EditBatchResult, EditChange } from "./edits.js";

export { CompositionError } from "./errors.js";

export { planSubjectFraming, subjectFramingRequestSchema } from "./subject-framing.js";
export type {
  SubjectFramingRequest,
  SubjectFramingPlan,
  SubjectFramingConstraint,
} from "./subject-framing.js";

export {
  getProcessing,
  processingCapabilities,
  type ProcessorImplementations,
} from "./processing.js";
export {
  processingTargetSchema,
  processingStepSchema,
  processingTapSchema,
  isStatefulProcessor,
  stateRecipeSchema,
} from "./schema.js";
export type { ProcessingTarget, ProcessingStep, ProcessingTap } from "./schema.js";

export { createCompiler } from "./compiler.js";
export { compiledFrameSchema, compiledAudioSchema } from "./compiled-records.js";
export type { CompiledFrame, CompiledAudio } from "./compiled-records.js";
export type { ProcessingInstruction } from "./processing-plan.js";
export {
  executionWindowRequestSchema,
  executionWindowManifestSchema,
  requireWindowReady,
} from "./execution-window.js";
export type { CompiledAudioState, ExecutionWindowManifest } from "./execution-window.js";

export { createSourceRangeProjection } from "./source-projection.js";
export type {
  SourceRangeOccurrence,
  SourceWindowOccurrence,
  SourcePointOccurrence,
} from "./source-projection.js";

export { intervalIndex } from "./interval-index.js";

export { createProjectCuts } from "./project-cuts.js";
export type { ProjectCut, ProjectCutSide } from "./project-cuts.js";

export { maximumPointerTrailUs } from "./pointer.js";

export { scalarCurveSchema } from "./schema.js";
export type { ScalarCurve } from "./schema.js";
export type { CompiledScalarCurve } from "./curve.js";
export type { ScalarKernel, SampleScalarPiece, SampleScalarProgram } from "./scalar-program.js";
export type { CompiledProcessingInstruction } from "./temporal-processing.js";

export {
  outputSettingsSchema,
  resolvedOutputSettingsSchema,
  resolveOutputSettings,
  normalizeOutputRequest,
  outputPresets,
} from "./output-settings.js";
export type { OutputSettings, OutputSettingsInput } from "./output-settings.js";
export { outputCapabilities } from "./output-settings.js";

export { sampleAt } from "./sample-clock.js";

export {
  audioOutputSettingsSchema,
  resolvedAudioOutputSettingsSchema,
  resolveAudioOutputSettings,
  normalizeAudioOutputRequest,
  audioOutputCapabilities,
} from "./output-settings.js";
export type { AudioOutputSettings, AudioOutputSettingsInput } from "./output-settings.js";

export { captionSidecar, captionSidecarRequestSchema } from "./caption-sidecars.js";
export type { CaptionSidecarRequest, CaptionCue } from "./caption-sidecars.js";

export { omit } from "./omit.js";
export type { Omitted } from "./omit.js";
export {
  admitMicrosecondRange,
  admitReadRange,
  type MicrosecondRange,
  type WireRange,
} from "./range-admission.js";
export {
  boundedIssues,
  issueCount,
  truncatedIssue,
  issueCodes,
  issueLimit,
  issueSchema,
  issuesSchema,
  normalizationStopReasonSchema,
  normalizationTargetMissSchema,
  type Issue,
  type IssueCode,
} from "./issues.js";
