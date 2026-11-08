import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  add,
  compare,
  fromTime,
  rational,
  selectionRangeSchema,
  signedTimeValueSchema,
  timeValueSchema,
  toTime,
  type SelectionRange,
} from "@yap/composition";
import { CatalogError } from "./catalog.js";
import { foldWord } from "./word-kind.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const alignmentEvidenceSourceSchema = z.strictObject({
  streamId: z.string().min(1),
  acquisitionId: z.string().min(1).nullable(),
  supportDigest: z.string().min(1),
  channel: z.int().nonnegative(),
  originUs: signedTimeValueSchema,
  durationUs: timeValueSchema,
  observationRange: selectionRangeSchema,
  text: z.string().min(1).max(8192),
  pcm: z.strictObject({
    sha256,
    sampleRate: z.literal(16000),
    frameCount: z.int().min(1).max(400000),
  }),
  decoder: z.strictObject({
    recipe: z.literal("source-selected-span-avfoundation-f32-16k-v1"),
    workerSha256: sha256,
    osBuild: z.string().min(1),
  }),
  engine: z.strictObject({
    modelId: z.string().min(1),
    descriptorDigest: sha256,
    modelDigest: sha256,
    modelSha256: sha256,
    runtimeDigest: sha256,
    workerSha256: sha256,
    recipe: z.literal("nemo-auxiliary-ctc110-v1"),
  }),
});
export type AlignmentEvidenceSource = z.infer<typeof alignmentEvidenceSourceSchema>;
export type AlignmentOperands = { nativeReceipt: string; report: string; correspondence: string };
export const alignmentOperandByteLimit = 8 * 1024 * 1024;
export const alignmentDigest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const token = z.int().min(0).max(1023),
  frame = z.int().min(0).max(313);
const span = z
  .object({ token, startFrame: frame, endFrame: frame })
  .refine((v) => v.startFrame < v.endFrame);
const nativeSchema = z.object({
  pcmSha256: sha256,
  modelSha256: sha256,
  sourceFrames: z.int().min(1).max(400000),
  shape: z.tuple([z.int().min(1).max(313), z.literal(1025)]),
  untrimmedShape: z.tuple([z.literal(1), z.int().min(1).max(400), z.literal(1025)]),
  dtype: z.literal("<f4"),
  bytesBase64: z.string().max((313 * 1025 * 4 * 4) / 3 + 8),
  blankId: z.literal(1024),
  vocabulary: z.array(z.string().max(1024)).length(1024),
  text: z.string().min(1).max(8192),
  tokenIds: z.array(token).max(8192),
  frameSamples: z.literal(1280),
  sampleRate: z.literal(16000),
});
const candidateSchema = z.object({
  text: z.string(),
  ids: z.array(token).max(8192),
  status: z.enum(["forced_path_observation", "refused"]),
  assignmentConfidence: z.null(),
  reason: z.string().max(65536).optional(),
  path: z.array(z.int().min(0).max(1024)).max(313).optional(),
  frameLogScores: z.array(z.number().finite()).max(313).nullable().optional(),
  spans: z
    .array(span.extend({ nativeMeanTokenProbability: z.number().finite() }))
    .max(313)
    .optional(),
  nativePathMeanLogScore: z.number().finite().nullable().optional(),
  nativeNonblankMeanLogScore: z.number().finite().nullable().optional(),
});
const acousticCell = z.object({
  startSample: z.int().nonnegative().max(400000),
  endSample: z.int().positive().max(400000),
  rms: z.number().finite().nonnegative(),
  peak: z.number().finite().nonnegative(),
});
const reportSchema = z.object({
  pcmSha256: sha256,
  modelSha256: sha256,
  sourceFrames: z.int(),
  sampleRate: z.literal(16000),
  frameSamples: z.literal(1280),
  shape: nativeSchema.shape.shape,
  blankId: z.literal(1024),
  vocabulary: nativeSchema.shape.vocabulary,
  greedyTokens: z.array(span).max(313),
  candidate: candidateSchema,
  acoustic: z.object({
    resolutionSamples: z.literal(160),
    cells: z.array(acousticCell).min(1).max(2500),
    observedLowerDecileRMS: z.number().finite().nonnegative(),
    noiseFloorInterpretation: z.string().min(1).max(1024),
  }),
});
const correspondenceSide = z.object({
  indices: z.array(z.int().nonnegative().max(511)).max(512),
  omissionPossible: z.boolean(),
});
const correspondenceSchema = z.strictObject({
  optimum: z.int().nonnegative().max(512),
  left: z.array(correspondenceSide).max(512),
  right: z.array(correspondenceSide).max(512),
});
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
function admitted<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(label);
  return parsed.data;
}
function decode(v: string): unknown {
  if (Buffer.byteLength(v) > alignmentOperandByteLimit)
    invalid("Alignment operand exceeds the byte limit");
  try {
    return JSON.parse(v);
  } catch {
    return invalid("Invalid alignment operand JSON");
  }
}
export type AlignmentTiming = {
  startFrame: number;
  endFrame: number;
  sourceRange: SelectionRange | null;
  physicalAdmission: "within_source_support" | "refused_unowned_support";
  interpretation: "conditional_supplied_path" | "greedy_observation" | "native_score_cell";
};
export type AlignmentWord = {
  kind: "supplied" | "observed";
  ordinal: number;
  text: string;
  correspondence: "matched" | "unmatched" | "observed_extra" | "unknown";
  possibleIndices: number[];
  omissionPossible: boolean;
  lexicalIdentity: "unknown";
  timing: AlignmentTiming | null;
  timingReason?: "provider_refused" | "supplied_grouping_mismatch";
  nativeTokens: number[];
  nativeTokenizationUnknown: boolean | null;
  assignmentConfidence: null;
};
export type AlignmentAcoustic = {
  ordinal: number;
  startSample: number;
  endSample: number;
  rms: number;
  peak: number;
  sourceRange: SelectionRange;
};
export type AlignmentScore = AlignmentTiming & {
  ordinal: number;
  values: number[];
  meaning: "uncalibrated";
};
/** Literal token pieces retain their character overlap and native frame operands. */
export function alignmentWords(
  tokens: readonly z.infer<typeof span>[],
  vocabulary: readonly string[],
) {
  let text = "";
  const chunks = tokens.map((t) => {
    const charStart = text.length;
    text += vocabulary[t.token]!.replaceAll("▁", " ");
    return { ...t, charStart, charEnd: text.length };
  });
  return [...text.matchAll(/\S+/gu)].map((m) => {
    const selected = chunks.filter(
      (t) => t.charStart < m.index + m[0].length && t.charEnd > m.index,
    );
    return {
      text: m[0],
      tokens: selected,
      startFrame: Math.min(...selected.map((t) => t.startFrame)),
      endFrame: Math.max(...selected.map((t) => t.endFrame)),
    };
  });
}
/** Pure parsing for service correspondence; publication also validates the complete matrix/path. */
export function alignmentCorrespondenceInput(
  operands: Pick<AlignmentOperands, "nativeReceipt" | "report">,
) {
  const native = admitted(
      nativeSchema,
      decode(operands.nativeReceipt),
      "Invalid native alignment matrix operand",
    ),
    report = admitted(
      reportSchema,
      decode(operands.report),
      "Invalid native alignment report operand",
    );
  return {
    supplied: (native.text.match(/\S+/gu) ?? []).map(foldWord),
    observed: alignmentWords(report.greedyTokens, native.vocabulary).map((v) => foldWord(v.text)),
  };
}
/** Native paths are conditional estimates. Physical admission never alters their cell bounds. */
export function alignmentOperandRows(
  inputSource: AlignmentEvidenceSource,
  operands: AlignmentOperands,
) {
  const source = admitted(
      alignmentEvidenceSourceSchema,
      inputSource,
      "Invalid alignment source operand",
    ),
    native = admitted(
      nativeSchema,
      decode(operands.nativeReceipt),
      "Invalid native alignment matrix operand",
    ),
    report = admitted(
      reportSchema,
      decode(operands.report),
      "Invalid native alignment report operand",
    ),
    mapping = admitted(
      correspondenceSchema,
      decode(operands.correspondence),
      "Invalid native alignment correspondence operand",
    );
  const frameCount = native.shape[0],
    frames = source.pcm.frameCount;
  if (
    native.text !== source.text ||
    report.candidate.text !== source.text ||
    native.pcmSha256 !== source.pcm.sha256 ||
    report.pcmSha256 !== source.pcm.sha256 ||
    native.modelSha256 !== source.engine.modelSha256 ||
    report.modelSha256 !== source.engine.modelSha256 ||
    native.sourceFrames !== frames ||
    report.sourceFrames !== frames ||
    frameCount !== Math.ceil(frames / 1280) ||
    native.untrimmedShape[1] < frameCount ||
    !isDeepStrictEqual(native.shape, report.shape) ||
    !isDeepStrictEqual(native.vocabulary, report.vocabulary) ||
    !isDeepStrictEqual(native.tokenIds, report.candidate.ids)
  )
    invalid("Alignment source/provider pin differs");
  const start = fromTime(source.observationRange.startUs),
    end = fromTime(source.observationRange.endUs);
  if (compare(add(start, rational(BigInt(frames) * 1000000n, 16000n)), end) !== 0)
    invalid("Alignment PCM range differs from its sample count");
  const matrix = Buffer.from(native.bytesBase64, "base64");
  if (matrix.length !== frameCount * 1025 * 4 || matrix.toString("base64") !== native.bytesBase64)
    invalid("Alignment matrix bytes differ from native axes");
  const values = Array.from({ length: frameCount }, (_, f) =>
    Array.from({ length: 1025 }, (_, t) => matrix.readFloatLE((f * 1025 + t) * 4)),
  );
  if (values.some((row) => row.some((v) => !Number.isFinite(v))))
    invalid("Nonfinite alignment matrix");
  const greedy: z.infer<typeof span>[] = [];
  let previous = -1;
  for (const [f, row] of values.entries()) {
    let selected = 0;
    for (let t = 1; t < row.length; t++) if (row[t]! > row[selected]!) selected = t;
    if (selected !== 1024) {
      if (selected === previous) greedy.at(-1)!.endFrame = f + 1;
      else greedy.push({ token: selected, startFrame: f, endFrame: f + 1 });
    }
    previous = selected;
  }
  if (!isDeepStrictEqual(greedy, report.greedyTokens))
    invalid("Greedy tokens differ from complete native matrix");
  const supplied = source.text.match(/\S+/gu) ?? [],
    observed = alignmentWords(greedy, native.vocabulary);
  if (
    supplied.length > 512 ||
    observed.length > 512 ||
    supplied.some((v) => Buffer.byteLength(v) > 1024) ||
    observed.some((v) => Buffer.byteLength(v.text) > 1024) ||
    mapping.left.length !== supplied.length ||
    mapping.right.length !== observed.length
  )
    invalid("Alignment correspondence operand count differs");
  for (const [side, other, words, others] of [
    [mapping.left, mapping.right, supplied, observed.map((v) => v.text)],
    [mapping.right, mapping.left, observed.map((v) => v.text), supplied],
  ] as const) {
    for (const [i, item] of side.entries()) {
      if (
        item.indices.some(
          (j, k) =>
            j >= other.length ||
            (k > 0 && j <= item.indices[k - 1]!) ||
            !other[j]!.indices.includes(i) ||
            !foldWord(words[i]!) ||
            foldWord(words[i]!) !== foldWord(others[j]!),
        )
      )
        invalid("Alignment correspondence pairs differ");
    }
  }
  const timing = (
    a: number,
    b: number,
    interpretation: AlignmentTiming["interpretation"],
  ): AlignmentTiming => ({
    startFrame: a,
    endFrame: b,
    sourceRange:
      b * 1280 <= frames
        ? {
            startUs: toTime(add(start, rational(BigInt(a) * 80000n))),
            endUs: toTime(add(start, rational(BigInt(b) * 80000n))),
          }
        : null,
    physicalAdmission: b * 1280 <= frames ? "within_source_support" : "refused_unowned_support",
    interpretation,
  });
  let groups: ReturnType<typeof alignmentWords> | null = null;
  const candidate = report.candidate;
  if (candidate.status === "forced_path_observation") {
    if (
      !candidate.path ||
      !candidate.frameLogScores ||
      !candidate.spans ||
      candidate.path.length !== frameCount ||
      candidate.frameLogScores.length !== frameCount
    )
      invalid("Incomplete conditional path");
    const spans: { token: number; startFrame: number; endFrame: number }[] = [];
    const ids: number[] = [];
    let last = -1;
    for (const [f, t] of candidate.path.entries()) {
      if (candidate.frameLogScores[f] !== values[f]![t])
        invalid("Conditional path score differs from native cell");
      if (t !== 1024) {
        if (t === last) spans.at(-1)!.endFrame = f + 1;
        else {
          spans.push({ token: t, startFrame: f, endFrame: f + 1 });
          ids.push(t);
        }
      }
      last = t;
    }
    if (
      !isDeepStrictEqual(ids, native.tokenIds) ||
      !isDeepStrictEqual(
        spans,
        candidate.spans.map(({ token, startFrame, endFrame }) => ({ token, startFrame, endFrame })),
      )
    )
      invalid("Native conditional path differs from supplied tokens");
    for (const item of candidate.spans) {
      const mean =
        candidate.frameLogScores
          .slice(item.startFrame, item.endFrame)
          .reduce((a, b) => a + Math.exp(b), 0) /
        (item.endFrame - item.startFrame);
      if (Math.abs(mean - item.nativeMeanTokenProbability) > 1e-6)
        invalid("Native conditional path probability differs");
    }
    groups = alignmentWords(candidate.spans, native.vocabulary);
  }
  const status = (
    v: z.infer<typeof correspondenceSide>,
    other: z.infer<typeof correspondenceSide>[],
    absent: "unmatched" | "observed_extra",
  ): AlignmentWord["correspondence"] =>
    !v.indices.length
      ? absent
      : v.indices.length === 1 &&
          !v.omissionPossible &&
          other[v.indices[0]!]!.indices.length === 1 &&
          !other[v.indices[0]!]!.omissionPossible
        ? "matched"
        : "unknown";
  const words: AlignmentWord[] = [
    ...supplied.map((text, ordinal) => {
      const item = groups?.length === supplied.length ? groups[ordinal] : null;
      return {
        kind: "supplied" as const,
        ordinal,
        text,
        correspondence: status(mapping.left[ordinal]!, mapping.right, "unmatched"),
        possibleIndices: mapping.left[ordinal]!.indices,
        omissionPossible: mapping.left[ordinal]!.omissionPossible,
        lexicalIdentity: "unknown" as const,
        timing: item ? timing(item.startFrame, item.endFrame, "conditional_supplied_path") : null,
        ...(!item
          ? {
              timingReason: groups
                ? ("supplied_grouping_mismatch" as const)
                : ("provider_refused" as const),
            }
          : {}),
        nativeTokens: item?.tokens.map((t) => t.token) ?? [],
        nativeTokenizationUnknown: item?.tokens.some((t) => t.token === 0) ?? null,
        assignmentConfidence: null,
      };
    }),
    ...observed.map((item, ordinal) => ({
      kind: "observed" as const,
      ordinal,
      text: item.text,
      correspondence: status(mapping.right[ordinal]!, mapping.left, "observed_extra"),
      possibleIndices: mapping.right[ordinal]!.indices,
      omissionPossible: mapping.right[ordinal]!.omissionPossible,
      lexicalIdentity: "unknown" as const,
      timing: timing(item.startFrame, item.endFrame, "greedy_observation"),
      nativeTokens: item.tokens.map((t) => t.token),
      nativeTokenizationUnknown: item.tokens.some((t) => t.token === 0),
      assignmentConfidence: null,
    })),
  ];
  if (report.acoustic.cells.length !== Math.ceil(frames / 160))
    invalid("Acoustic cells do not cover selected PCM");
  const acoustic: AlignmentAcoustic[] = report.acoustic.cells.map((cell, ordinal) => {
    if (
      cell.startSample !== ordinal * 160 ||
      cell.endSample !== Math.min((ordinal + 1) * 160, frames) ||
      cell.rms > cell.peak * (1 + 1e-12) + 1e-12
    )
      invalid("Acoustic cells differ from complete support");
    return {
      ...cell,
      ordinal,
      sourceRange: {
        startUs: toTime(add(start, rational(BigInt(cell.startSample) * 1000000n, 16000n))),
        endUs: toTime(add(start, rational(BigInt(cell.endSample) * 1000000n, 16000n))),
      },
    };
  });
  const lowerDecile = acoustic.map((v) => v.rms).toSorted((a, b) => a - b)[
    Math.floor((acoustic.length - 1) / 10)
  ]!;
  if (lowerDecile !== report.acoustic.observedLowerDecileRMS)
    invalid("Measured acoustic context differs");
  const scores: AlignmentScore[] = values.map((row, ordinal) => ({
    ...timing(ordinal, ordinal + 1, "native_score_cell"),
    ordinal,
    values: row,
    meaning: "uncalibrated",
  }));
  return {
    words,
    acoustic,
    scores,
    matrixSha256: alignmentDigest(matrix),
    observedLowerDecileRMS: lowerDecile,
    conditionalStatus: candidate.status,
    correspondenceOptimum: mapping.optimum,
  };
}
