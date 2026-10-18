import { z } from "zod";
import { voiceReceiptSchema } from "./voice-types.js";
import type { MediaProbe } from "./assets.js";
import {
  add,
  compare,
  fromTime,
  processingTapSchema,
  rangeSchema,
  selectionRangeSchema,
  signedTimeValueSchema,
  subtract,
  timeValueSchema,
  rational,
  multiply,
  type SignedTimeValue,
} from "@yap/composition";

const integer = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sampleRange = z.strictObject({ start: integer, end: integer });
const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const conversionSupport = z.strictObject({
  streamId: id,
  startUs: timeValueSchema,
  endUs: timeValueSchema,
  mediaStartUs: signedTimeValueSchema,
  mediaDurationUs: timeValueSchema,
});
const conversionVideoEvidence = conversionSupport.extend({
  samples: integer.positive(),
  presentedTimingSha256: digest,
});
const conversionAudioEvidence = conversionSupport.extend({
  frames: integer.positive(),
  sampleRate: z.int().positive().max(192000),
  channels: z.union([z.literal(1), z.literal(2)]),
  pcmSha256: digest,
});
const conversionEvidence = z.strictObject({
  originUs: signedTimeValueSchema,
  factsSha256: digest,
  video: conversionVideoEvidence,
  audio: conversionAudioEvidence.optional(),
});
const hdrConversionOriginOperands = z.strictObject({
  kind: z.literal("hdr-conversion"),
  recipe: z.literal("hdr-to-sdr-hable-1000nit-v1"),
  family: z.enum(["pq", "hlg"]),
  implementation: z.strictObject({
    implementationId: z.string().min(1).max(512),
    receiptSha256: digest,
    nativeExecutableSha256: digest,
    ffmpegSha256: digest,
    ffprobeSha256: digest,
  }),
  source: conversionEvidence.extend({ assetId: digest }),
  output: conversionEvidence,
  clock: z.strictObject({
    sourceClockAtDerivativeZeroUs: timeValueSchema,
    movieTimescale: z.int().positive().max(2147483647),
    sourceSupport: selectionRangeSchema,
  }),
});
export const hdrConversionOriginSchema = hdrConversionOriginOperands.refine(
  (value) => {
    const { source, output, clock } = value;
    const offset = fromTime(clock.sourceClockAtDerivativeZeroUs);
    const same = (a: SignedTimeValue, b: SignedTimeValue) =>
      compare(fromTime(a), fromTime(b)) === 0;
    const mapped = (a: SignedTimeValue, b: SignedTimeValue) =>
      compare(subtract(fromTime(a), offset), fromTime(b)) === 0;
    const support = (
      before: z.infer<typeof conversionSupport>,
      after: z.infer<typeof conversionSupport>,
    ) =>
      compare(fromTime(before.endUs), fromTime(before.startUs)) > 0 &&
      compare(
        fromTime(before.mediaDurationUs),
        subtract(fromTime(before.endUs), fromTime(before.startUs)),
      ) === 0 &&
      compare(
        fromTime(after.mediaDurationUs),
        subtract(fromTime(after.endUs), fromTime(after.startUs)),
      ) === 0 &&
      mapped(before.startUs, after.startUs) &&
      mapped(before.endUs, after.endUs);
    if (
      compare(fromTime(output.originUs), add(fromTime(source.originUs), offset)) !== 0 ||
      !support(source.video, output.video) ||
      source.video.samples !== output.video.samples ||
      source.video.presentedTimingSha256 !== output.video.presentedTimingSha256 ||
      !same(output.video.mediaStartUs, 0) ||
      Boolean(source.audio) !== Boolean(output.audio)
    )
      return false;
    let start = source.video.startUs,
      end = source.video.endUs;
    if (source.audio && output.audio) {
      const before = source.audio,
        after = output.audio;
      if (
        before.streamId === source.video.streamId ||
        after.streamId === output.video.streamId ||
        !support(before, after) ||
        before.frames !== after.frames ||
        before.sampleRate !== after.sampleRate ||
        before.channels !== after.channels ||
        before.pcmSha256 !== after.pcmSha256
      )
        return false;
      if (
        compare(
          subtract(fromTime(before.endUs), fromTime(before.startUs)),
          rational(BigInt(before.frames) * 1000000n, BigInt(before.sampleRate)),
        ) !== 0 ||
        multiply(rational(1n, BigInt(before.sampleRate)), rational(BigInt(clock.movieTimescale)))
          .denominator !== 1n
      )
        return false;
      if (compare(fromTime(before.startUs), fromTime(start)) < 0) start = before.startUs;
      if (compare(fromTime(before.endUs), fromTime(end)) > 0) end = before.endUs;
    }
    const operands = [
      source.originUs,
      output.originUs,
      source.video.startUs,
      source.video.endUs,
      output.video.startUs,
      output.video.endUs,
      source.video.mediaStartUs,
      source.video.mediaDurationUs,
      output.video.mediaStartUs,
      output.video.mediaDurationUs,
      ...(source.audio && output.audio
        ? [
            source.audio.startUs,
            source.audio.endUs,
            source.audio.mediaStartUs,
            source.audio.mediaDurationUs,
            output.audio.startUs,
            output.audio.endUs,
            output.audio.mediaStartUs,
            output.audio.mediaDurationUs,
          ]
        : []),
    ];
    return (
      operands.every(
        (value) =>
          multiply(fromTime(value), rational(BigInt(clock.movieTimescale), 1000000n))
            .denominator === 1n,
      ) &&
      same(start, clock.sourceClockAtDerivativeZeroUs) &&
      same(start, clock.sourceSupport.startUs) &&
      same(end, clock.sourceSupport.endUs)
    );
  },
  {
    message: "HDR conversion receipt changed selected support or common clock",
    when: (payload) => hdrConversionOriginOperands.safeParse(payload.value).success,
  },
);
export type HdrConversionOrigin = z.infer<typeof hdrConversionOriginSchema>;

/** Fresh-fact digests remain evidence; selected clock/count bindings must also
 * agree with the independently retained ordinary asset metadata. */
export function hdrConversionEvidenceMatchesMetadata(
  facts: HdrConversionOrigin["output"],
  metadata: MediaProbe,
) {
  const same = (a: Parameters<typeof fromTime>[0], b: Parameters<typeof fromTime>[0]) =>
    compare(fromTime(a), fromTime(b)) === 0;
  const video = metadata.streams.find((item) => item.id === facts.video.streamId);
  const occupiedMatches = (
    stream: MediaProbe["streams"][number],
    expected: typeof facts.video | NonNullable<typeof facts.audio>,
  ) => {
    const occupied = stream.segments?.filter((segment) => !segment.empty);
    const segment = occupied?.[0];
    return (
      occupied?.length === 1 &&
      segment !== undefined &&
      segment.mediaStartUs !== undefined &&
      segment.mediaDurationUs !== undefined &&
      same(segment.startUs, expected.startUs) &&
      same(segment.endUs, expected.endUs) &&
      same(segment.mediaStartUs, expected.mediaStartUs) &&
      same(segment.mediaDurationUs, expected.mediaDurationUs)
    );
  };
  if (
    !same(facts.originUs, metadata.originUs) ||
    video?.kind !== "video" ||
    video.startUs === undefined ||
    video.endUs === undefined ||
    !same(video.startUs, facts.video.startUs) ||
    !same(video.endUs, facts.video.endUs) ||
    video.samples?.count !== facts.video.samples ||
    !occupiedMatches(video, facts.video)
  )
    return false;
  if (facts.audio) {
    const audio = metadata.streams.find((item) => item.id === facts.audio!.streamId);
    if (
      audio?.kind !== "audio" ||
      audio.startUs === undefined ||
      audio.endUs === undefined ||
      !same(audio.startUs, facts.audio.startUs) ||
      !same(audio.endUs, facts.audio.endUs) ||
      audio.sampleRate !== facts.audio.sampleRate ||
      audio.channels !== facts.audio.channels ||
      !occupiedMatches(audio, facts.audio)
    )
      return false;
  }
  return true;
}
export const audioRenditionSchema = z.strictObject({
  sampleRate: z.int().min(1).max(192000),
  channels: z.union([z.literal(1), z.literal(2)]),
});
export const audioDimensionsSchema = audioRenditionSchema.extend({
  frames: integer.positive(),
});
export const extractionOriginSchema = z.strictObject({
  kind: z.literal("extraction"),
  selection: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("source"),
      assetId: id,
      streamId: id,
      acquisitionId: id.optional(),
      range: selectionRangeSchema,
      sampleRange,
      supportDigest: id,
      unavailable: z.array(selectionRangeSchema),
    }),
    z.strictObject({
      kind: z.literal("project"),
      projectId: id,
      revisionId: id,
      range: rangeSchema,
      sampleRange,
      tap: processingTapSchema,
      processingSha256: z.string().regex(/^[a-f0-9]{64}$/),
      unavailable: z.array(z.strictObject({ clipId: id, ranges: z.array(sampleRange) })),
    }),
  ]),
  selectionImplementationId: id,
  input: audioDimensionsSchema,
  output: audioDimensionsSchema,
  conversion: z.strictObject({
    implementationId: id,
    channelPolicy: z.enum(["preserve", "duplicate", "equal-weight-double-rounded-float32"]),
    contextPolicy: z.enum(["complete-selected-pcm-zero-origin", "complete-source"]),
  }),
});
export const generatedVoiceOriginSchema = z.strictObject({
  kind: z.literal("voice-generation"),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelId: id,
  reference: z.strictObject({
    assetId: id,
    streamId: id,
    originSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  }),
  receipt: voiceReceiptSchema.omit({ file: true }),
});
export const assetOriginSchema = z.union([
  z.strictObject({
    kind: z.enum(["import", "capture", "generated"]),
    source: z.string().optional(),
  }),
  extractionOriginSchema,
  generatedVoiceOriginSchema,
  hdrConversionOriginSchema,
]);
export type AssetProvenance = z.infer<typeof assetOriginSchema>;
export type ExtractionOrigin = z.infer<typeof extractionOriginSchema>;
