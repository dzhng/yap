import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { refusalRetryable } from "@yap/protocol";
import { CatalogError } from "./catalog.js";
import { packedSchema } from "./evidence.js";

const identity = z.string().min(1).max(256);
const diagnostic = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const media = z.strictObject({
  bytes: z
    .string()
    .max(19)
    .refine((value) => /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))),
  sha256: hash,
});
const published = z.strictObject({
  kind: z.enum(["primary", "camera"]),
  sourceId: identity,
  sourceDurationUs: z.int().positive(),
  originHostUs: z.int().nonnegative(),
  binding: z
    .strictObject({ recordingId: identity, sourceId: identity, deviceId: identity })
    .optional(),
  diagnostic: diagnostic.optional(),
  journal: z.strictObject({
    file: z.enum(["source.journal.jsonl", "capture.journal.jsonl"]),
    bytes: z.int().positive().max(268_435_456),
    sha256: hash,
    lastSequence: z.int().positive(),
    layout: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  members: z.strictObject({
    "video.mov": media,
    "narration.mov": media.optional(),
    "system.mov": media.optional(),
    "narration.publication.json": media.optional(),
    "system.publication.json": media.optional(),
    "camera.publication.json": media.optional(),
    "camera.mapping.jsonl": media.optional(),
  }),
});
const outcome = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("published"), source: published }),
  z.strictObject({
    state: z.literal("pending"),
    error: diagnostic.strip().transform((error) => ({
      ...error,
      retryable: refusalRetryable(error.code),
    })),
  }),
  z.strictObject({ state: z.literal("unavailable"), error: diagnostic }),
]);
const observation = z.strictObject({
  generation: identity,
  sourceId: identity,
  inputsClosed: z.boolean(),
  primary: outcome.nullable(),
  camera: outcome.nullable(),
});
const recoveryDiagnostic = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
});
const recoveryTrack = z.looseObject({ failure: recoveryDiagnostic.nullable().optional() });
const recoveryCompletion = z
  .looseObject({
    failureCode: z.string().min(1).max(128).nullable().optional(),
    failureMessage: z.string().max(4096).nullable().optional(),
  })
  .refine((value) => value.failureMessage == null || value.failureCode != null);
const recoveryJournal = z.looseObject({
  header: z.unknown().nullable().optional(),
  completion: recoveryCompletion.nullable().optional(),
});
const recoveryReceipt = z.strictObject({
  durationUs: z.int().nonnegative(),
  tracks: z.array(recoveryTrack).optional(),
  journal: recoveryJournal.nullable().optional(),
  journalFailure: recoveryDiagnostic.nullable().optional(),
  cleanupFailure: recoveryDiagnostic.nullable().optional(),
  inputsClosed: z.boolean(),
  sourcePublication: z.unknown().optional(),
});
export type CapturePublishedSource = z.infer<typeof published>;
export type CaptureSourceAuthority = {
  source: CapturePublishedSource;
  receipt: { bytes: string; sha256: string };
};
export type CapturePublication = z.infer<typeof observation>;
export type CaptureSourceOutcome = z.infer<typeof outcome>;
export function readCaptureSourceOutcome(value: unknown): CaptureSourceOutcome | null {
  const parsed = outcome.nullable().safeParse(value);
  if (!parsed.success)
    throw new CatalogError(
      "INVALID_RESPONSE",
      "Source recovery returned an invalid publication outcome",
    );
  return parsed.data;
}
export type RecoveryReceipt = {
  durationUs: number;
  captured: boolean;
  failureCode: string | undefined;
  failureMessage: string | undefined;
  cleanupFailure: { code: string; message: string } | undefined;
  inputsClosed: boolean;
  sourcePublication: unknown;
};
/** Reads the bounded native recovery receipt once; publication validation remains separate. */
export function readRecoveryReceipt(value: unknown): RecoveryReceipt {
  const parsed = recoveryReceipt.safeParse(value);
  if (!parsed.success)
    throw new CatalogError("INVALID_RESPONSE", "Recovery returned an invalid outcome");
  const completion = parsed.data.journal?.completion;
  const roleFailure = parsed.data.tracks
    ?.map((track) => track.failure ?? undefined)
    .find((failure) => failure && failure.code !== "NOT_REQUESTED");
  return {
    durationUs: parsed.data.durationUs,
    captured: Boolean(parsed.data.journal?.header),
    failureCode: completion?.failureCode ?? parsed.data.journalFailure?.code ?? roleFailure?.code,
    failureMessage:
      completion?.failureCode != null
        ? (completion.failureMessage ?? undefined)
        : (parsed.data.journalFailure?.message ?? roleFailure?.message),
    cleanupFailure: parsed.data.cleanupFailure ?? undefined,
    inputsClosed: parsed.data.inputsClosed,
    sourcePublication: parsed.data.sourcePublication,
  };
}
export type CapturePublicationState = {
  observation: CapturePublication;
  authorities: Partial<Record<"primary" | "camera", CapturePublishedSource>>;
};

/** Receipt identity survives operational refusal; its latest verified availability can still change. */
export function readCapturePublication(
  value: unknown,
  allocation: {
    id: string;
    sourceId: string;
    camera: { sourceId: string; deviceId: string } | null;
  },
  previous: CapturePublicationState | null,
): CapturePublicationState {
  const parsed = observation.safeParse(value);
  if (!parsed.success)
    throw new CatalogError(
      "INVALID_PARAMS",
      "Capture publication must be a bounded source observation",
    );
  const current = parsed.data;
  const prior = previous?.observation;
  const authorities = { ...previous?.authorities };
  if (
    current.sourceId !== allocation.sourceId ||
    (prior &&
      (current.generation !== prior.generation || (prior.inputsClosed && !current.inputsClosed)))
  )
    throw new CatalogError(
      "INVALID_STATE",
      "Publication belongs to another take or reopens closed inputs",
    );
  if (
    (!current.inputsClosed && (current.primary !== null || current.camera !== null)) ||
    (allocation.camera === null && current.camera !== null)
  )
    throw new CatalogError("INVALID_STATE", "Source publication requires closed allocated inputs");
  for (const kind of ["primary", "camera"] as const) {
    const source = current[kind];
    const before = prior?.[kind];
    if (before?.state === "unavailable" && !isDeepStrictEqual(before, source))
      throw new CatalogError("INVALID_STATE", "Terminal source unavailability is immutable");
    if (source?.state !== "published") continue;
    const receipt = source.source;
    if (authorities[kind] && !isDeepStrictEqual(authorities[kind], receipt))
      throw new CatalogError("INVALID_STATE", "Published source authority is immutable");
    const expectedId = kind === "primary" ? allocation.sourceId : allocation.camera?.sourceId;
    const expectedBinding =
      kind === "primary" ? undefined : { recordingId: allocation.id, ...allocation.camera! };
    if (
      receipt.kind !== kind ||
      receipt.sourceId !== expectedId ||
      !isDeepStrictEqual(receipt.binding, expectedBinding)
    )
      throw new CatalogError(
        "INVALID_STATE",
        "Published source differs from allocated source/device authority",
      );
    const camera = kind === "camera";
    if (
      receipt.journal.file !== (camera ? "capture.journal.jsonl" : "source.journal.jsonl") ||
      // A companion camera keeps its own schema-1 journal; a primary source's is packed.
      (camera ? receipt.journal.layout !== 1 : !packedSchema(receipt.journal.layout)) ||
      Boolean(receipt.members["camera.publication.json"]) !== camera ||
      Boolean(receipt.members["camera.mapping.jsonl"]) !== camera
    )
      throw new CatalogError(
        "INVALID_STATE",
        "Published source has invalid journal or proof members",
      );
    for (const role of ["narration", "system"] as const)
      if (
        Boolean(receipt.members[`${role}.mov`]) !==
          Boolean(receipt.members[`${role}.publication.json`]) ||
        (camera && receipt.members[`${role}.mov`])
      )
        throw new CatalogError("INVALID_STATE", "Published source has invalid audio members");
    authorities[kind] = receipt;
  }
  return { observation: current, authorities };
}
