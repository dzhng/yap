import { randomUUID } from "node:crypto";
import { link, mkdtemp, open, rm, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  callLocal,
  resolveServiceSocket,
  LocalTransportError,
  type ServiceSelection,
} from "@yap/client";
import {
  ARTIFACT_CHUNK_BYTES,
  resultSchema,
  publishedOutputSchema,
  type OperationResponse,
  refusalRetryable,
} from "@yap/protocol";

export const batchReferences = new Map<string, "atUs" | "ordinal">([
  ["frame.batch", "atUs"],
  ["index.frames", "ordinal"],
]);
export const artifactOperations = new Set([
  ...batchReferences.keys(),
  "index.frame",
  "frame.get",
  "audio.measure",
  "audio.pause.get",
  "audio.get",
  "waveform.get",
  "spectrogram.get",
]);

export class ArtifactDeliveryError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.retryable = refusalRetryable(code);
  }
}
const receipt = z.object({
  token: z.string().min(1),
  bytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.int(),
});
const ready = z.object({
  state: z.literal("ready"),
  delivery: receipt,
  published: publishedOutputSchema(
    z.object({
      mediaType: z.enum(["image/png", "audio/wav", "video/mp4", "application/json"]),
    }),
  ),
});
const chunk = z.object({
  data: z.string(),
  offset: z.int().nonnegative(),
  nextOffset: z.int().nonnegative(),
  eof: z.boolean(),
});

type ArtifactType = "image/png" | "audio/wav" | "video/mp4" | "application/json";
type ArtifactInfo = { bytes: number; mediaType: ArtifactType };

// Buffer policies also describe the outcome the MCP framer must admit before consumption.
function bufferedPolicy({ bytes, mediaType }: ArtifactInfo): true | false | ArtifactDeliveryError {
  if (mediaType === "audio/wav" && bytes > 48 * 1024 ** 2) return false;
  if (mediaType === "video/mp4")
    return new ArtifactDeliveryError(
      "INVALID_REQUEST",
      "Playable previews must be streamed to a file",
    );
  if (mediaType === "image/png" && bytes > 32 * 1024 ** 2)
    return new ArtifactDeliveryError(
      "LIMIT_EXCEEDED",
      "Image exceeds its buffered delivery byte limit",
    );
  if (mediaType === "application/json" && bytes > 4 * 1024 ** 2)
    return new ArtifactDeliveryError(
      "LIMIT_EXCEEDED",
      "JSON evidence exceeds its buffered delivery byte limit",
    );
  return true;
}

export function describeArtifact(result: OperationResponse) {
  if (!result.ok) return null;
  const data = result.data as { state?: unknown } | null;
  if (!data || data.state !== "ready") return null;
  const parsed = ready.safeParse(data);
  if (!parsed.success)
    throw new ArtifactDeliveryError("INVALID_RESPONSE", "Ready artifact has no valid delivery");
  const { bytes } = parsed.data.delivery;
  const mediaType: ArtifactType = parsed.data.published.output.mediaType;
  return {
    bytes,
    mediaType,
    delivery: parsed.data.delivery,
    buffered: bufferedPolicy({ bytes, mediaType }),
  };
}

/** Cleanup outlives caller cancellation; expiry is the fallback if the service vanished. */
export async function closeArtifact(socket: string, token: string): Promise<void> {
  await callLocal(
    socket,
    { id: randomUUID(), operation: "artifact.close", params: { token } },
    { timeoutMs: 1000 },
  ).catch(() => undefined);
}

/** One transport validator for buffered model content and streamed playable files. */
async function consumeArtifact<T>(
  selection: ServiceSelection,
  result: OperationResponse,
  consume: (info: ArtifactInfo, chunks: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T | null> {
  const description = describeArtifact(result);
  if (!description) return null;
  const { token, bytes } = description.delivery;
  let expiresAt = description.delivery.expiresAt;
  const { mediaType } = description;
  const socket = await resolveServiceSocket(selection);
  async function* chunks() {
    let offset = 0;
    while (offset < bytes) {
      if (Date.now() >= expiresAt)
        throw new ArtifactDeliveryError("ARTIFACT_EXPIRED", "Media delivery expired");
      if (expiresAt - Date.now() < 5000) {
        const renewal = await callLocal(
          socket,
          { id: randomUUID(), operation: "artifact.renew", params: { token } },
          selection.signal ? { signal: selection.signal } : {},
        );
        if (!renewal.ok) throw new ArtifactDeliveryError(renewal.error.code, renewal.error.message);
        const renewed = receipt.safeParse(renewal.data);
        if (
          !renewed.success ||
          renewed.data.token !== token ||
          renewed.data.bytes !== bytes ||
          renewed.data.expiresAt <= expiresAt
        )
          throw new ArtifactDeliveryError(
            "INVALID_RESPONSE",
            "Media renewal changed its identity or failed to extend the lease",
          );
        expiresAt = renewed.data.expiresAt;
      }
      const response = await callLocal(
        socket,
        {
          id: randomUUID(),
          operation: "artifact.read",
          params: { token, offset, maxBytes: Math.min(ARTIFACT_CHUNK_BYTES, bytes - offset) },
        },
        selection.signal ? { signal: selection.signal } : {},
      );
      if (!response.ok)
        throw new ArtifactDeliveryError(response.error.code, response.error.message);
      const parsedChunk = chunk.safeParse(response.data);
      if (!parsedChunk.success)
        throw new ArtifactDeliveryError("INVALID_RESPONSE", "Malformed media chunk");
      const part = parsedChunk.data;
      const decoded = Buffer.from(part.data, "base64");
      if (
        part.offset !== offset ||
        decoded.length < 1 ||
        decoded.length > ARTIFACT_CHUNK_BYTES ||
        part.nextOffset !== offset + decoded.length ||
        part.nextOffset > bytes ||
        part.eof !== (part.nextOffset === bytes) ||
        decoded.toString("base64") !== part.data
      )
        throw new ArtifactDeliveryError(
          "INVALID_RESPONSE",
          "Media chunk does not advance within the delivery",
        );
      offset = part.nextOffset;
      yield decoded;
    }
  }
  try {
    return await consume({ bytes, mediaType }, chunks());
  } finally {
    // Expiry releases the same pin if the service disappeared or the caller was canceled.
    await closeArtifact(socket, token);
  }
}

function validateJson(bytes: Buffer): void {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ArtifactDeliveryError("INVALID_RESPONSE", "Evidence is not valid UTF-8 JSON");
  }
}

export async function artifactBytes(
  selection: ServiceSelection,
  result: OperationResponse,
): Promise<{ bytes: Buffer; mediaType: "image/png" | "audio/wav" | "application/json" } | null> {
  const description = describeArtifact(result);
  // Large audio remains renewable instead of becoming one huge message.
  if (description?.buffered === false) return null;
  return consumeArtifact(selection, result, async ({ bytes, mediaType }, chunks) => {
    const buffered = bufferedPolicy({ bytes, mediaType });
    if (mediaType === "video/mp4" || buffered instanceof ArtifactDeliveryError) throw buffered;
    const output = Buffer.alloc(bytes);
    let offset = 0;
    for await (const chunk of chunks) {
      chunk.copy(output, offset);
      offset += chunk.length;
    }
    if (mediaType === "application/json") validateJson(output);
    return { bytes: output, mediaType };
  });
}

/** Single and batch delivery publish complete files without replacing existing destinations. */
export async function publishArtifactFile(
  info: ArtifactInfo,
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  destination: string,
  signal?: AbortSignal,
): Promise<ArtifactInfo & { output: string }> {
  if (info.mediaType === "application/json" && info.bytes > 16 * 1024 ** 2)
    throw new ArtifactDeliveryError(
      "LIMIT_EXCEEDED",
      "JSON evidence exceeds its file validation byte limit",
    );
  const output = resolve(destination);
  const staging = await mkdtemp(join(dirname(output), ".yap-media-"));
  try {
    const file = await open(join(staging, "media"), "wx", 0o600);
    try {
      for await (const part of chunks) await file.writeFile(part);
      await file.sync();
    } finally {
      await file.close();
    }
    if (info.mediaType === "application/json") validateJson(await readFile(join(staging, "media")));
    if (signal?.aborted)
      throw new LocalTransportError("ABORTED", "Media delivery canceled before publication");
    await link(join(staging, "media"), output);
    return { ...info, output };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function artifactFile(
  selection: ServiceSelection,
  result: OperationResponse,
  destination?: string,
): Promise<(ArtifactInfo & { output: string }) | null> {
  let ownedDirectory: string | undefined;
  try {
    return await consumeArtifact(selection, result, async (info, chunks) => {
      const names = {
        "image/png": "frame.png",
        "audio/wav": "excerpt.wav",
        "video/mp4": "preview.mp4",
        "application/json": "evidence.json",
      };
      const output = destination
        ? resolve(destination)
        : join(
            (ownedDirectory = await mkdtemp(join(tmpdir(), "yap-media-"))),
            names[info.mediaType],
          );
      return publishArtifactFile(info, chunks, output, selection.signal);
    });
  } catch (error) {
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
    throw error;
  }
}

const projectBatch = <T extends z.ZodRawShape>(fields: T) =>
  z.looseObject({
    ...fields,
    projectId: z.string(),
    recordingId: z.never().optional(),
    packageHandle: z.never().optional(),
  });
const sourceBatch = <T extends z.ZodRawShape>(fields: T) =>
  z.looseObject({
    ...fields,
    assetId: z.string(),
    streamId: z.string(),
    acquisitionId: z.string().optional(),
    projectId: z.never().optional(),
    recordingId: z.never().optional(),
    packageHandle: z.never().optional(),
  });
const indexItems = z
  .array(z.intersection(resultSchema, z.object({ ordinal: z.int().nonnegative() })))
  .min(1)
  .max(8);
const frameItems = z
  .array(z.intersection(resultSchema, z.object({ atUs: z.number() })))
  .min(1)
  .max(8);
const batchResponse = {
  atUs: z.union([
    projectBatch({ revisionId: z.string(), items: frameItems }),
    sourceBatch({ items: frameItems }),
  ]),
  ordinal: z.union([
    projectBatch({ revisionId: z.string(), generation: z.string(), items: indexItems }),
    sourceBatch({ generation: z.string(), items: indexItems }),
  ]),
};

export function describeBatch(
  result: Extract<OperationResponse, { ok: true }>,
  reference: keyof typeof batchResponse,
) {
  const parsed = batchResponse[reference].safeParse(result.data);
  if (!parsed.success)
    throw new ArtifactDeliveryError(
      "INVALID_RESPONSE",
      "Batch response does not match its request",
    );
  return parsed.data;
}

// Drain every ready item's lease even when another read or output write fails.
export async function consumeBatch(
  selection: ServiceSelection,
  result: OperationResponse,
  reference: keyof typeof batchResponse,
  consume: (
    media: NonNullable<Awaited<ReturnType<typeof artifactBytes>>>,
    index: number,
  ) => Promise<Record<string, unknown>>,
  errorDetails: (error: unknown) => Extract<OperationResponse, { ok: false }>["error"],
): Promise<OperationResponse> {
  if (!result.ok) return result;
  const batch = describeBatch(result, reference);
  const items = [];
  for (const [index, item] of batch.items.entries()) {
    try {
      const media = await artifactBytes(selection, { ...item, id: result.id });
      items.push(
        media && item.ok
          ? {
              ...item,
              data: { ...(item.data as Record<string, unknown>), ...(await consume(media, index)) },
            }
          : item,
      );
    } catch (error) {
      const identity = "ordinal" in item ? { ordinal: item.ordinal } : { atUs: item.atUs };
      items.push({ ...identity, ok: false, error: errorDetails(error) });
    }
  }
  return { ...result, data: { ...batch, items } };
}
