#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import appManifest from "../../macos/package.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  artifactFile,
  artifactOperations,
  batchReferences,
  ArtifactDeliveryError,
  consumeBatch,
  closeArtifact,
  publishArtifactFile,
} from "./artifact-delivery.js";
import { waitForWork, waitSucceeded } from "./wait.js";
import { mcpContent, mcpInlineBytes, mcpResult } from "./mcp-result.js";
import { sessionExclusion } from "./installation-lock.js";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  callLocal,
  resolveOperationSocket,
  LocalTransportError,
  type ServiceSelection,
} from "@yap/client";
import {
  operationNames,
  readOnlyOperations,
  idempotentOperations,
  admitOperation,
  operationSchema,
  FrameError,
  REQUEST_FRAME_BYTES,
  parseRequest,
  encodeJsonLine,
  operationError,
  isArtifactMaintenance,
  personalHome,
  type OperationRequest,
  type OperationResponse,
  type OperationWireResponse,
} from "@yap/protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const { version } = appManifest;
const previewOperations = new Set(["preview.get"]);
const skillLifecycleOperations = new Set(["skill.install", "skill.update", "skill.uninstall"]);

function failure(
  id: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Extract<OperationResponse, { ok: false }> {
  return { id, ...operationError(code, message, details) };
}

function capabilities(operation?: string) {
  return operationSchema.options
    .filter(
      (definition) => operation === undefined || definition.shape.operation.value === operation,
    )
    .map((definition) => ({
      name: definition.shape.operation.value,
      description: definition.description ?? "",
      // What a caller must send, so a parameter the service defaults stays optional.
      inputSchema: z.toJSONSchema(definition.shape.params, {
        io: "input",
        reused: "ref",
        override: ({ jsonSchema }) => {
          // Runtime freezing does not make caller-authored inputs read-only.
          delete jsonSchema.readOnly;
        },
      }),
    }));
}

class UsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function errorResult(id: string, error: unknown): Extract<OperationResponse, { ok: false }> {
  if (error instanceof ArtifactDeliveryError) return failure(id, error.code, error.message);
  if (error instanceof UsageError) return failure(id, error.code, error.message, error.details);
  if (error instanceof LocalTransportError) return failure(id, error.code, error.message);
  if (error instanceof FrameError)
    return failure(
      id,
      error.code === "FRAME_TOO_LARGE" ? "LIMIT_EXCEEDED" : "INVALID_RESPONSE",
      error.message,
    );
  return failure(id, "INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request");
}

// Validate before discovery, because discovery can launch the personal app.
function request(id: string, operation: string, params: unknown): OperationRequest {
  if (!operationNames.has(operation))
    throw new UsageError(
      "UNKNOWN_OPERATION",
      `Unknown service operation: ${operation.slice(0, 120)}`,
    );
  const normalizedParams =
    params &&
    typeof params === "object" &&
    !readOnlyOperations.has(operation as never) &&
    !idempotentOperations.has(operation as never) &&
    !("requestId" in params)
      ? { ...(params as Record<string, unknown>), requestId: id }
      : params;
  const sending = parseRequest({ id, operation, params: normalizedParams });
  encodeJsonLine(sending, REQUEST_FRAME_BYTES);
  const admitted = admitOperation({ operation, params: normalizedParams });
  if (!admitted.ok)
    throw new UsageError(admitted.error.code, admitted.error.message, admitted.error.details);
  return sending;
}

// The caller retains this socket for delivery; dispatch must not rediscover or replay.
function invoke(
  selection: ServiceSelection & { socketPath: string },
  sending: OperationRequest,
  deliverResult: number,
): Promise<OperationWireResponse>;
function invoke(
  selection: ServiceSelection & { socketPath: string },
  sending: OperationRequest,
): Promise<OperationResponse>;
async function invoke(
  selection: ServiceSelection & { socketPath: string },
  sending: OperationRequest,
  deliverResult?: number,
): Promise<OperationWireResponse> {
  try {
    if (deliverResult && !isArtifactMaintenance(sending.operation))
      return await callLocal(
        selection.socketPath,
        {
          ...sending,
          resultDelivery: { inlineBytes: deliverResult },
        },
        selection.signal ? { signal: selection.signal } : {},
      );
    return await callLocal(
      selection.socketPath,
      sending,
      selection.signal ? { signal: selection.signal } : {},
    );
  } catch (error) {
    return errorResult(sending.id, error);
  }
}

async function readParams(value: string): Promise<unknown> {
  if (value !== "-") return JSON.parse(value);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > REQUEST_FRAME_BYTES)
      throw new FrameError("FRAME_TOO_LARGE", "JSON input exceeds the request byte limit");
    chunks.push(data);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

async function mcp(selection: ServiceSelection) {
  const exclusion = sessionExclusion(process.env, version);
  // An updated app needs a session of its own version. Once one call finds it, the session
  // leaves after every call still running has its answer, and the agent starts the new one.
  let running = 0;
  let leaving = false;
  const server = new Server({ name: "yap", version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: capabilities().map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema, type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    const id = randomUUID();
    let release: (() => void) | undefined;
    running += 1;
    try {
      release = exclusion.hold();
      const sending = request(id, call.params.name, call.params.arguments ?? {});
      const selected = {
        socketPath: await resolveOperationSocket(sending.operation, {
          ...selection,
          signal: extra.signal,
        }),
        signal: extra.signal,
      };
      const answer = await invoke(selected, sending, mcpInlineBytes(extra.requestId));
      return await mcpResult(selected, sending.operation, answer, extra.requestId, (error) =>
        errorResult(id, error),
      );
    } catch (error) {
      return mcpContent(errorResult(id, error));
    } finally {
      if (release) {
        leaving ||= exclusion.replaced();
        release();
      }
      running -= 1;
      // This answer is written before the next turn; leave once no other call is still running.
      if (leaving && running === 0)
        setImmediate(() => {
          if (running === 0) process.stdout.write("", () => process.exit(0));
        });
    }
  });
  await server.connect(new StdioServerTransport());
}

// Before argument parsing succeeds there is no reliable mode or request identity.
// Usage failures go to stderr so they cannot contaminate an MCP protocol stream.
let errorOutput: NodeJS.WritableStream = process.stderr;
let responseId = "cli";

/**
 * The admin notice the app saved for this version, if any: `notice.json` in the personal root,
 * `{version, message}`, written by the app's `startAdminNotices`. The command line never touches
 * the network for it, and any problem reading it means no notice.
 */
function showAdminNotice() {
  try {
    const saved = JSON.parse(
      readFileSync(join(personalHome(process.env), "notice.json"), "utf8"),
    ) as { version?: unknown; message?: unknown };
    if (saved.version !== version || typeof saved.message !== "string") return;
    // Control characters could steer a terminal; the app already bounds the length.
    const message = saved.message
      .slice(0, 500)
      .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
      .trim();
    if (!message) return;
    // A closed stderr must not turn a notice into a crash.
    process.stderr.once("error", () => {});
    process.stderr.write(`Yap notice: ${message}\n`);
  } catch {}
}

async function main() {
  showAdminNotice();
  const { values, positionals } = parseArgs({
    options: {
      socket: { type: "string" },
      params: { type: "string" },
      output: { type: "string" },
      wait: { type: "boolean" },
      "timeout-ms": { type: "string" },
      "no-wait": { type: "boolean" },
      id: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
    allowPositionals: true,
  });
  errorOutput = positionals[0] === "mcp" ? process.stderr : process.stdout;
  responseId = values.id || randomUUID();
  if (values.version) {
    if (positionals.length || Object.keys(values).length !== 1)
      throw new Error("--version accepts no other arguments");
    process.stdout.write(JSON.stringify({ name: "yap", version }) + "\n");
    return;
  }
  if (values.help || positionals.length === 0) {
    if (positionals.length > 1) throw new Error("Expected one operation name or mcp");
    const operation = positionals[0] === "mcp" ? undefined : positionals[0];
    if (operation !== undefined && !operationNames.has(operation))
      throw new UsageError(
        "UNKNOWN_OPERATION",
        `Unknown service operation: ${operation.slice(0, 120)}`,
      );
    process.stdout.write(
      JSON.stringify(
        {
          version,
          usage:
            "yap <operation> [--socket PATH] [--params JSON|-] [--id ID] [--output FILE|NEW_DIRECTORY] [--wait --timeout-ms MS] | yap mcp [--socket PATH] | yap --version",
          waiting:
            "Skill install/update/uninstall wait by default for up to 120000 ms; use --no-wait for an immediate acknowledgement. Other long-running operations require --wait with a positive --timeout-ms up to 2147483647. One deadline covers discovery, admission, polling and delivery. Polls every 100 ms; never retries failures or resubmits writes. wait metadata distinguishes settled work, timed_out pending work (exit 2), and interrupted waiting (exit 1); success requires the requested output to be ready.",
          service:
            "Without --socket, calls use $YAP_HOME/run/service.sock (default ~/.yap) and launch the personal app once when nothing answers there. A running service has ten seconds to answer; an app that discovery launched has a minute to start serving. --socket connects to that path directly and never launches an app.",
          bundledMedia:
            "The released yap launcher also accepts ffmpeg or ffprobe followed by that tool's own arguments. It runs the selected app's bundled executable under installation exclusion without starting the service; streams and exit status belong to the media tool, not the operation JSON protocol.",
          timeUnits:
            "Microseconds. Endpoints accept integers or exact reduced fractions where the operation's input schema permits them. Ranges are half-open in the selected anchor domain and expectedRevisionId.",
          mutations:
            "When the operation schema accepts requestId, supply a stable value and reuse it with identical arguments after an uncertain write. Supply expectedRevisionId only where its schema requires it.",
          operations: capabilities(operation),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const [operation] = positionals;
  if (positionals.length !== 1 || operation === undefined)
    throw new Error("Expected one operation name or mcp");
  const explicitTimeoutMs =
    values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
  const skillLifecycle = skillLifecycleOperations.has(operation);
  const waitRequested = Boolean(values.wait) || (skillLifecycle && !values["no-wait"]);
  // Only skill lifecycle has a default budget; every other --wait names its own.
  const timeoutMs = explicitTimeoutMs ?? (waitRequested && skillLifecycle ? 120_000 : undefined);
  if (
    (Boolean(values.wait) && Boolean(values["no-wait"])) ||
    (!skillLifecycle && Boolean(values.wait) !== (timeoutMs !== undefined)) ||
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647))
  )
    throw new UsageError(
      "INVALID_REQUEST",
      "--wait requires a positive integer --timeout-ms (at most 2147483647)",
    );
  const controller = new AbortController();
  const selection: ServiceSelection = { socketPath: values.socket };
  if (operation === "mcp") {
    if (
      values.params ||
      values.id ||
      values.output ||
      waitRequested ||
      values["no-wait"] ||
      values["timeout-ms"]
    )
      throw new Error("mcp accepts --socket only");
    // Listing tools describes the registry; only a called tool looks for a service.
    await mcp(selection);
    return;
  }
  if (values.output && !artifactOperations.has(operation) && !previewOperations.has(operation))
    throw new Error("--output applies only to artifact inspection operations");
  const sending = request(responseId, operation, await readParams(values.params ?? "{}"));
  const timer = waitRequested
    ? setTimeout(() => controller.abort("wait_deadline"), timeoutMs!)
    : undefined;
  const abort = () => controller.abort("caller_canceled");
  if (waitRequested) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    selection.signal = controller.signal;
  }
  try {
    const selected = {
      ...selection,
      socketPath: await resolveOperationSocket(operation, selection),
    };
    let result = await invoke(selected, sending);
    if (waitRequested && result.ok)
      result = await waitForWork({
        request: sending,
        initial: result,
        timeoutMs: timeoutMs!,
        signal: controller.signal,
        call: (operation, params) => invoke(selected, request(sending.id, operation, params)),
        close: (token) => closeArtifact(selected.socketPath, token),
        progress: (message) => process.stderr.write(message + "\n"),
      });
    if (waitRequested && !result.ok && controller.signal.aborted)
      result = {
        ...result,
        wait:
          controller.signal.reason === "wait_deadline"
            ? { state: "timed_out", timeoutMs: timeoutMs! }
            : { state: "interrupted", timeoutMs: timeoutMs!, error: result.error },
      };
    const canDeliver = !waitRequested || result.wait?.state === "settled";
    const batchReference = batchReferences.get(operation);
    if (batchReference && canDeliver) {
      let directory: string | undefined;
      let outputError: unknown;
      result = await consumeBatch(
        selected,
        result,
        batchReference,
        async (media, index) => {
          if (outputError) throw outputError;
          if (!directory) {
            try {
              directory = values.output
                ? resolve(values.output)
                : await mkdtemp(join(tmpdir(), "yap-frames-"));
              if (values.output) await mkdir(directory);
            } catch (error) {
              outputError = error;
              throw error;
            }
          }
          const output = join(directory, `${String(index + 1).padStart(2, "0")}.png`);
          await publishArtifactFile(
            { sizeBytes: media.bytes.length, mediaType: media.mediaType },
            [media.bytes],
            output,
            selected.signal,
          );
          return { output };
        },
        (error) => errorResult(sending.id, error).error,
      );
      if (waitRequested && controller.signal.aborted) {
        result = {
          ...result,
          wait:
            controller.signal.reason === "wait_deadline"
              ? {
                  state: "timed_out",
                  timeoutMs: timeoutMs!,
                  ...(result.wait?.job ? { job: result.wait.job } : {}),
                }
              : {
                  state: "interrupted",
                  timeoutMs: timeoutMs!,
                  ...(result.wait?.job ? { job: result.wait.job } : {}),
                  error: {
                    code: "ABORTED",
                    message: "Waiting was interrupted; admitted work is not rolled back",
                    retryable: false,
                    details: {},
                  },
                },
        };
      }
    } else if (
      canDeliver &&
      (artifactOperations.has(operation) || previewOperations.has(operation))
    ) {
      try {
        const media = await artifactFile(selected, result, values.output);
        if (media && result.ok)
          result = {
            ...result,
            data: { ...(result.data as Record<string, unknown>), output: media.output },
          };
      } catch (error) {
        const failure = errorResult(sending.id, error);
        result = waitRequested
          ? {
              ...result,
              wait:
                controller.signal.aborted && controller.signal.reason === "wait_deadline"
                  ? {
                      state: "timed_out",
                      timeoutMs: timeoutMs!,
                      ...(result.wait?.job ? { job: result.wait.job } : {}),
                    }
                  : {
                      state: "interrupted",
                      timeoutMs: timeoutMs!,
                      ...(result.wait?.job ? { job: result.wait.job } : {}),
                      error: failure.error,
                    },
            }
          : failure;
      }
    }
    process.stdout.write(JSON.stringify(result) + "\n");

    if (result.wait?.state === "timed_out") process.exitCode = 2;
    else if (
      !result.ok ||
      (waitRequested && (result.wait?.state === "interrupted" || !waitSucceeded(result)))
    )
      process.exitCode = 1;
  } catch (error) {
    if (!waitRequested || !controller.signal.aborted) throw error;
    const result = errorResult(sending.id, error);
    const wait =
      controller.signal.reason === "wait_deadline"
        ? { state: "timed_out", timeoutMs: timeoutMs! }
        : { state: "interrupted", timeoutMs: timeoutMs!, error: result.error };
    process.stdout.write(JSON.stringify({ ...result, wait }) + "\n");
    process.exitCode = wait.state === "timed_out" ? 2 : 1;
  } finally {
    if (timer) clearTimeout(timer);
    if (waitRequested) {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }
}

try {
  await main();
} catch (error) {
  errorOutput.write(JSON.stringify(errorResult(responseId, error)) + "\n");
  process.exitCode = 1;
}
