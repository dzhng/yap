import { getSystemErrorMap } from "node:util";
import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceSelection } from "@yap/client";
import {
  CONTROL_FRAME_BYTES,
  MCP_RESULT_INLINE_BYTES,
  RESPONSE_FRAME_BYTES,
  type OperationResponse,
  type OperationWireResponse,
} from "@yap/protocol";
import {
  artifactOperations,
  batchReferences,
  artifactBytes,
  ArtifactDeliveryError,
  consumeBatch,
  describeArtifact,
  describeBatch,
} from "./artifact-delivery.js";

type Failure = Extract<OperationResponse, { ok: false }>;
type Content = CallToolResult["content"];
export function mcpContent(result: OperationWireResponse, media: Content = []): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }, ...media],
    structuredContent: result,
    isError: !result.ok,
  };
}
function wireBytes(requestId: RequestId, result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify({ result, jsonrpc: "2.0", id: requestId }) + "\n");
}
export function mcpInlineBytes(requestId: RequestId): number {
  return Math.min(
    MCP_RESULT_INLINE_BYTES,
    Math.max(
      1,
      Math.floor(
        (RESPONSE_FRAME_BYTES -
          CONTROL_FRAME_BYTES -
          wireBytes(requestId, mcpContent({ id: "", ok: true, data: null }))) /
          3,
      ),
    ),
  );
}
// Metadata appears structurally and as JSON inside the first text block.
function metadataBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(json)) - 2;
}
function add(...bytes: number[]): number {
  let total = 0;
  for (const value of bytes) {
    if (value > RESPONSE_FRAME_BYTES - total) return RESPONSE_FRAME_BYTES + 1;
    total += value;
  }
  return total;
}
function mediaContent(mediaType: string, data: string, batch = false): Content[number] {
  return !batch && mediaType === "application/json"
    ? { type: "text", text: data }
    : { type: batch || mediaType === "image/png" ? "image" : "audio", data, mimeType: mediaType };
}
function attachment(info: NonNullable<ReturnType<typeof describeArtifact>>, batch = false) {
  return {
    block: mediaContent(info.mediaType, "", batch),
    bytes:
      !batch && info.mediaType === "application/json"
        ? add(info.sizeBytes, info.sizeBytes)
        : info.sizeBytes > RESPONSE_FRAME_BYTES
          ? RESPONSE_FRAME_BYTES + 1
          : 4 * Math.ceil(info.sizeBytes / 3),
  };
}

/** Construct and admit the complete SDK envelope before consuming any lease. */
export async function mcpResult(
  selection: ServiceSelection & { socketPath: string },
  operation: string,
  answer: OperationWireResponse,
  requestId: RequestId,
  failure: (error: unknown) => Failure,
): Promise<CallToolResult> {
  if ("resultDelivery" in answer || !answer.ok) return mcpContent(answer);
  const reference = batchReferences.get(operation);
  if (!reference && !artifactOperations.has(operation)) return mcpContent(answer);
  // Node's pipe errors use syscall + finite libuv code + selected path, optionally
  // a local-address suffix. Fixed read/renew/transport messages are shorter than
  // the service-capacity diagnostic. This bounds owned errors, not foreign peer bodies.
  const code = [...getSystemErrorMap().values()].reduce(
    (longest, [name]) => (name.length > longest.length ? name : longest),
    "",
  );
  const lateFailures = [
    "Local service request capacity is full; retry after existing work finishes",
    `connect ${code} ${selection.socketPath} - Local (undefined:undefined)`,
  ].map((message) => failure(new ArtifactDeliveryError("UNCORRELATED_RESPONSE", message)));
  let bound: number;
  try {
    if (reference) {
      const batch = describeBatch(answer, reference);
      bound = wireBytes(requestId, mcpContent({ ...answer, data: { ...batch, items: [] } }));
      for (const [index, item] of batch.items.entries()) {
        const identity = "ordinal" in item ? { ordinal: item.ordinal } : { atUs: item.atUs };
        const refused = (error: unknown) => ({
          ...identity,
          ok: false,
          error: failure(error).error,
        });
        let cost = metadataBytes(item);
        try {
          const info = describeArtifact({ ...item, id: answer.id });
          if (info?.buffered instanceof ArtifactDeliveryError)
            cost = metadataBytes(refused(info.buffered));
          else if (info?.buffered) {
            const media = attachment(info, true);
            cost = Math.max(
              add(
                metadataBytes({
                  ...item,
                  data: {
                    ...(item.ok ? (item.data as Record<string, unknown>) : {}),
                    contentIndex: 8,
                  },
                }),
                1,
                Buffer.byteLength(JSON.stringify(media.block)),
                media.bytes,
              ),
              ...lateFailures.map((result) =>
                metadataBytes({ ...identity, ok: false, error: result.error }),
              ),
            );
          }
        } catch (error) {
          cost = metadataBytes(refused(error));
        }
        bound = add(bound, cost, index ? 2 : 0);
      }
    } else {
      const info = describeArtifact(answer);
      if (!info || info.buffered === false) return mcpContent(answer);
      if (info.buffered instanceof ArtifactDeliveryError)
        bound = wireBytes(requestId, mcpContent(failure(info.buffered)));
      else {
        const media = attachment(info);
        bound = Math.max(
          add(wireBytes(requestId, mcpContent(answer, [media.block])), media.bytes),
          ...lateFailures.map((result) => wireBytes(requestId, mcpContent(result))),
        );
      }
    }
  } catch (error) {
    return mcpContent(failure(error));
  }
  if (bound > RESPONSE_FRAME_BYTES) return mcpContent(answer);
  let result: OperationResponse = answer;
  const media: Content = [];
  try {
    if (reference)
      result = await consumeBatch(
        selection,
        result,
        reference,
        async (item) => {
          media.push(mediaContent(item.mediaType, item.bytes.toString("base64"), true));
          return { contentIndex: media.length };
        },
        (error) => failure(error).error,
      );
    else {
      const item = await artifactBytes(selection, result);
      if (item)
        media.push(
          mediaContent(
            item.mediaType,
            item.bytes.toString(item.mediaType === "application/json" ? "utf8" : "base64"),
          ),
        );
    }
  } catch (error) {
    result = failure(error);
  }
  return mcpContent(result, media);
}
