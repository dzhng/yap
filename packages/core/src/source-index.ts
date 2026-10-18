import {
  faceObservationRequestSchema,
  type FaceObservationRequest,
  pictureObservationRequestSchema,
  type NormalizedPictureObservationRequest,
} from "@yap/protocol";
import { sourceIndexQueryRanges } from "./source-index-selection.js";
import {
  signedTimeValueSchema,
  fromTime,
  compare,
  toSignedTime,
  subtract,
  ceil,
} from "@yap/composition";
import { SourceIndexStillness, sourceIndexPoints } from "./source-index-equality.js";
import { z } from "zod";
import { sourceSceneClockSchema } from "./source-scene-chunks.js";
import { isDeepStrictEqual } from "node:util";
import { CatalogError } from "./catalog.js";
import { selectSource, sourceSelectionSchema, type SourceSelection } from "./source-selection.js";
import {
  portableSceneMetadataSchema,
  sourceSceneDescriptor,
  type SceneEvidenceMetadata,
  type SceneEvidenceStore,
} from "./scene-evidence.js";
import {
  sourceFrameUnavailableSchema,
  retainedSourceFrameSchema,
  validateSourceFrameGeometry,
  validatePictureObservations,
  validateFaceObservations,
  type SourceFrameArtifact,
  type SourceFrameUnavailable,
  type MediaFrameInspection,
} from "./frame-inspection.js";
import type { IndexDomain } from "./screenshot-index.js";
import { sourceIndexPolicy, type SourceIndexReason } from "./source-index-selection.js";
import type { TimeRange } from "./presentation-time.js";
import { validateSceneSampleClock, type SourceVisualPoint } from "./source-scenes.js";
export type SourceIndexIdentity = SourceSelection & {
  generation: string;
  scenes: SceneEvidenceMetadata;
  selectionPolicy: string;
  implementationId: string;
  maxLongEdge: number;
  observationRequest?: NormalizedPictureObservationRequest | undefined;
  faceObservationRequest?: FaceObservationRequest | undefined;
};
export type SourceIndexCandidate = {
  ordinal: number;
  requestedSourceUs: number;
  support: TimeRange;
  reasons: SourceIndexReason[];
};
export type SourceIndexCoverage = { source: TimeRange } & (
  | { ordinal: number; state: "available"; equality: "sampled" | "unproven" }
  | { ordinal: null; state: "unavailable"; basis: "support" }
  | {
      ordinal: null;
      state: "unavailable";
      basis: "observation";
      equality: "unproven";
      observation:
        | { kind: "scene"; point: Extract<SourceVisualPoint, { status: "unavailable" }> }
        | { kind: "frame"; frame: SourceFrameUnavailable };
    }
);
export type SourceIndexRecords = {
  identity: SourceIndexIdentity;
  candidate: SourceIndexCandidate;
  frame: Omit<SourceFrameArtifact, "cacheId">;
  coverage: SourceIndexCoverage;
};
const portableTime = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const portableRange = z
  .strictObject({ startUs: portableTime, endUs: portableTime })
  .refine((r) => r.endUs > r.startUs);
export const portableSourceIndexMetadataSchema = sourceSelectionSchema
  .extend({
    generation: z.string().min(1).max(256),
    scenes: portableSceneMetadataSchema,
    selectionPolicy: z.literal(sourceIndexPolicy.id),
    implementationId: z.string().min(1).max(256),
    maxLongEdge: z.int().min(1).max(8192),
    observationRequest: pictureObservationRequestSchema.optional(),
    faceObservationRequest: faceObservationRequestSchema.optional(),
    durationUs: portableTime,
    candidateCount: portableTime.max(25000),
    coverageCount: portableTime.max(25000),
    bytes: portableTime,
  })
  .strict();
export const portableSourceIndexRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("entry"),
    candidate: z.strictObject({
      ordinal: portableTime,
      requestedSourceUs: portableTime,
      support: portableRange,
      reasons: z
        .array(
          z.union([
            z.strictObject({
              kind: z.enum(["first", "last", "availability", "coverage"]),
              eventSourceUs: portableTime,
            }),
            z.strictObject({
              kind: z.literal("scene"),
              side: z.enum(["before", "after"]),
              observedSourceUs: portableTime,
              sample: sourceSceneClockSchema,
              originUs: signedTimeValueSchema,
            }),
          ]),
        )
        .max(10000),
    }),
    frame: retainedSourceFrameSchema,
  }),
  z.strictObject({
    kind: z.literal("coverage"),
    coverage: z.union([
      z.strictObject({
        source: portableRange,
        ordinal: portableTime,
        state: z.literal("available"),
        equality: z.enum(["sampled", "unproven"]),
      }),
      z.strictObject({
        source: portableRange,
        ordinal: z.null(),
        state: z.literal("unavailable"),
        basis: z.literal("support"),
      }),
      z.strictObject({
        source: portableRange,
        ordinal: z.null(),
        state: z.literal("unavailable"),
        basis: z.literal("observation"),
        equality: z.literal("unproven"),
        observation: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("frame"), frame: sourceFrameUnavailableSchema }),
          z.strictObject({
            kind: z.literal("scene"),
            point: z.strictObject({
              requestedSourceUs: portableTime,
              status: z.literal("unavailable"),
              reason: z.enum(["outside_support", "empty_edit"]),
              continuousFromPrevious: z.literal(false),
            }),
          }),
        ]),
      }),
    ]),
  }),
]);
const invalid = (message: string): never => {
  throw new CatalogError("INVALID_EVIDENCE", message);
};
/** Raw source index receipts use real asset/stream identity and never pretend to be a recording revision. */
export function sourceIndexDomain(
  source: (selection: SourceSelection) => ReturnType<typeof selectSource>,
  scenes: Pick<SceneEvidenceStore, "metadata" | "sourcePage" | "sourceWindowPage">,
  frames: Pick<MediaFrameInspection, "sourceUnavailable"> | null,
): IndexDomain<SourceIndexRecords> {
  function selected(identity: SourceIndexIdentity) {
    return source({
      assetId: identity.assetId,
      streamId: identity.streamId,
      ...(identity.acquisitionId === undefined ? {} : { acquisitionId: identity.acquisitionId }),
    });
  }
  return {
    owner: (i) => ({ kind: "asset", assetId: i.assetId }),
    pin: (i) => ({
      assetId: i.assetId,
      streamId: i.streamId,
      ...(i.acquisitionId === undefined ? {} : { acquisitionId: i.acquisitionId }),
      generation: i.generation,
      scenes: i.scenes,
      selectionPolicy: i.selectionPolicy,
      implementationId: i.implementationId,
      maxLongEdge: i.maxLongEdge,
      ...(i.observationRequest === undefined ? {} : { observationRequest: i.observationRequest }),
      ...(i.faceObservationRequest === undefined
        ? {}
        : { faceObservationRequest: i.faceObservationRequest }),
    }),
    begin(identity) {
      const source = selected(identity);
      const metadata = scenes.metadata(identity.scenes);
      if (
        source.stream.kind !== "video" ||
        metadata.owner.kind !== "asset" ||
        metadata.owner.assetId !== identity.assetId ||
        !isDeepStrictEqual(metadata, identity.scenes) ||
        !isDeepStrictEqual(metadata.source, sourceSceneDescriptor(source)) ||
        !identity.generation ||
        !identity.selectionPolicy ||
        !identity.implementationId ||
        !Number.isInteger(identity.maxLongEdge) ||
        identity.maxLongEdge < 1 ||
        identity.maxLongEdge > 8192
      )
        invalid("Source index identity does not match published scenes");
      return ceil(fromTime(source.durationUs));
    },
    candidate(identity, candidate, frame, path) {
      const source = selected(identity);
      if (source.stream.kind !== "video")
        throw new CatalogError("INVALID_EVIDENCE", "Source index requires video geometry");
      validateSourceFrameGeometry(frame, source.stream, identity.maxLongEdge);
      validatePictureObservations(frame, identity.observationRequest);
      validateFaceObservations(frame, identity.faceObservationRequest);
      if (
        !Number.isSafeInteger(candidate.requestedSourceUs) ||
        !sourceIndexQueryRanges(source.track.available).some(
          (r) => r.startUs === candidate.support.startUs && r.endUs === candidate.support.endUs,
        ) ||
        candidate.requestedSourceUs < candidate.support.startUs ||
        candidate.requestedSourceUs >= candidate.support.endUs ||
        frame.file !== path ||
        frame.assetId !== identity.assetId ||
        frame.streamId !== identity.streamId ||
        frame.acquisitionId !== identity.acquisitionId ||
        frame.supportDigest !== source.supportDigest ||
        frame.implementationId !== identity.implementationId ||
        compare(
          fromTime(frame.sample.originUs),
          subtract(fromTime(0), fromTime(source.track.sourceOffsetUs)),
        ) !== 0 ||
        frame.maxLongEdge !== identity.maxLongEdge ||
        !isDeepStrictEqual(frame.observationRequest, identity.observationRequest) ||
        !isDeepStrictEqual(frame.faceObservationRequest, identity.faceObservationRequest) ||
        frame.atUs !== candidate.requestedSourceUs ||
        frame.requestedSourceUs !== candidate.requestedSourceUs
      )
        invalid("Selected source image receipt does not match its candidate");
      validateSceneSampleClock(
        frame.sample,
        candidate.requestedSourceUs,
        frame.actualSourceUs,
        toSignedTime(subtract(fromTime(0), fromTime(source.track.sourceOffsetUs))),
      );
    },
    coverage({ identity, candidate, coverage, admission }) {
      if (coverage.state === "available") {
        if (
          !candidate ||
          coverage.source.startUs < candidate.support.startUs ||
          coverage.source.endUs > candidate.support.endUs
        )
          invalid("Available source coverage requires its supported candidate");
      } else {
        if (candidate) invalid("Unavailable index coverage cannot name an image");
        if (coverage.basis === "support") {
          if (
            sourceIndexQueryRanges(selected(identity).track.available).some(
              (r) => r.startUs < coverage.source.endUs && r.endUs > coverage.source.startUs,
            )
          )
            invalid("Support exclusion overlaps available footage");
        } else {
          const observation = coverage.observation;
          const at =
            observation.kind === "scene"
              ? observation.point.requestedSourceUs
              : observation.frame.atUs;
          if (
            !Number.isSafeInteger(at) ||
            at < coverage.source.startUs ||
            at >= coverage.source.endUs
          )
            invalid("Unavailable observation lies outside its index coverage");
          if (observation.kind === "scene") {
            const page = scenes.sourceWindowPage({
              identity: identity.scenes,
              range: { startUs: at, endUs: at + 1 },
              limit: 1,
            });
            if (
              !page.chunks[0]!.coverage.some((point) => isDeepStrictEqual(point, observation.point))
            )
              invalid("Unavailable observation is not in the pinned scene evidence");
          } else {
            const frame = observation.frame;
            const source = selected(identity);
            if (
              !sourceFrameUnavailableSchema.safeParse(frame).success ||
              !isDeepStrictEqual(frame.selection, source.selection) ||
              frame.supportDigest !== source.supportDigest ||
              frame.implementationId !== identity.implementationId ||
              frame.maxLongEdge !== identity.maxLongEdge ||
              !isDeepStrictEqual(frame.observationRequest, identity.observationRequest) ||
              !isDeepStrictEqual(frame.faceObservationRequest, identity.faceObservationRequest) ||
              (admission === "produced" &&
                (!frames ||
                  !isDeepStrictEqual(
                    frame,
                    frames.sourceUnavailable({
                      ...frame.selection,
                      atUs: frame.atUs,
                      maxLongEdge: frame.maxLongEdge,
                      observations: frame.observationRequest,
                      faceObservations: frame.faceObservationRequest,
                    }),
                  )))
            )
              invalid("Unavailable picture observation does not match the selected source request");
          }
        }
      }
      return coverage.source;
    },
    merge(a, b) {
      if (
        a.ordinal !== b.ordinal ||
        a.state !== b.state ||
        a.source.endUs !== b.source.startUs ||
        (a.state === "available" && b.state === "available" && a.equality !== b.equality) ||
        (a.state === "unavailable" &&
          b.state === "unavailable" &&
          (a.basis !== b.basis ||
            (a.basis === "observation" &&
              b.basis === "observation" &&
              !isDeepStrictEqual(a.observation, b.observation))))
      )
        return null;
      return { ...a, source: { startUs: a.source.startUs, endUs: b.source.endUs } };
    },
    finish(identity) {
      selected(identity);
    },
    retained(identity, signal) {
      const proof = new SourceIndexStillness(sourceIndexPoints(scenes, identity, signal));
      return {
        async coverage(frame, coverage) {
          const equality = await proof.equality(frame, coverage.source);
          if (
            coverage.state === "available" &&
            coverage.equality === "sampled" &&
            equality !== "sampled"
          )
            invalid("Sampled source coverage lacks retained stillness evidence");
        },
        close: () => proof.close(),
      };
    },
    isDeleting: () => false,
    retainedFrame: retainedSourceFrameSchema,
  };
}
