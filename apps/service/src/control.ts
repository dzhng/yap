import { refusedRequest } from "./operation-errors.js";
import type { Readable, Writable } from "node:stream";
import {
  CONTROL_FRAME_BYTES,
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_PENDING_CONTROL_CALLS,
  FrameError,
  JsonLineStream,
  appMessageSchema,
  encodeJsonLine,
  operationError,
  type ControlMessage,
  type ControlResponse,
  type OperationRequest,
  type OperationResult,
  updateControlOperations,
} from "@yap/protocol";

export type ControlChannel = {
  /**
   * Asks the app's native side for one operation, bounded and correlated like its own calls. An
   * operation whose native work outlasts the channel's ordinary deadline states its own.
   */
  call(
    operation: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<OperationResult>;
  emit(message: ControlMessage): void;
  readonly updateBlocked: boolean;
  /** Settles every waiting call and stops reading. The caller owns what happens next. */
  close(): void;
};

function rejection(id: string | null, code: string, message: string): ControlResponse {
  return { id, ...operationError(code, message) };
}

/**
 * The app's inherited pipe, in both directions. The app calls service operations and this service
 * calls the app's native capture session; each side correlates answers by request ID, refuses more
 * than the shared in-flight bound, and settles every waiting call when the channel ends. A call
 * that is never answered fails on its own deadline rather than waiting forever.
 */
export function openControl(options: {
  input: Readable;
  output: Writable;
  dispatch: (request: OperationRequest) => Promise<OperationResult>;
  onEnd: () => void;
  timeoutMs?: number;
  admission?: { refusal(): OperationResult | undefined; progress(): void };
}): ControlChannel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const pending = new Map<string, (result: OperationResult) => void>();
  const stream = new JsonLineStream(CONTROL_FRAME_BYTES);
  let inbound = 0;
  let productInbound = 0;
  let writes = 0;
  let outbound = 0;
  let ended = false;

  // A frame this process cannot encode, and a peer that stopped reading, both have to stay
  // reportable: neither may become an uncaught failure that skips listener cleanup.
  const write = (message: ControlMessage, product = false): boolean => {
    let frame: Buffer;
    try {
      frame = encodeJsonLine(message, CONTROL_FRAME_BYTES);
    } catch (failure) {
      if (failure instanceof FrameError) return false;
      throw failure;
    }
    let owned = product;
    const settleWrite = () => {
      if (!owned) return;
      owned = false;
      writes -= 1;
      options.admission?.progress();
    };
    if (owned) writes += 1;
    try {
      options.output.write(frame, settleWrite);
    } catch {
      settleWrite();
      // The stream is already torn down, so there is nowhere to put this frame. Its error
      // event, or the input reaching EOF, owns closing the channel.
    }
    return true;
  };
  const emit = (message: ControlMessage) => void write(message);
  const oversized = "Response exceeds the control byte limit.";
  const reply = (response: ControlResponse, product = false): void => {
    if (write({ event: "result", response }, product)) return;
    const bounded = rejection(response.id, "LIMIT_EXCEEDED", oversized);
    if (write({ event: "result", response: bounded }, product)) return;
    // Even the bounded form does not fit, so the correlation ID itself is the excess.
    write({ event: "result", response: rejection(null, "LIMIT_EXCEEDED", oversized) }, product);
  };

  const answer = (request: OperationRequest): void => {
    const product = !updateControlOperations.has(request.operation);
    const refusal =
      product && request.operation !== "capture.report" ? options.admission?.refusal() : undefined;
    if (refusal) {
      reply({ id: request.id, ...refusedRequest(refusal, request) });
      return;
    }
    if (inbound >= MAX_PENDING_CONTROL_CALLS) {
      reply({
        id: request.id,
        ...refusedRequest(
          operationError("LIMIT_EXCEEDED", "Too many control requests are already in flight."),
          request,
        ),
      });
      return;
    }
    inbound += 1;
    if (product) productInbound += 1;
    void Promise.resolve()
      .then(() => options.dispatch(request))
      .catch(() => operationError("INTERNAL_ERROR", "Service handler failed"))
      .then((result) => {
        inbound -= 1;
        reply({ id: request.id, ...refusedRequest(result, request) }, product);
        if (product) {
          productInbound -= 1;
          options.admission?.progress();
        }
      });
  };

  const settle = (id: string, result: OperationResult): void => {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    waiting(result);
    options.admission?.progress();
  };

  const dispatch = (value: unknown): void => {
    const parsed = appMessageSchema.safeParse(value);
    if (!parsed.success) {
      const message = value as { request?: { id?: unknown }; response?: { id?: unknown } };
      if (message?.response !== undefined) {
        // An unreadable answer still ends the call it names. Echoing a result back would answer
        // nothing the app asked.
        const id = message.response?.id;
        if (typeof id === "string")
          settle(
            id,
            operationError(
              "CONTROL_RESPONSE_INVALID",
              "The app answered with an unreadable result",
            ),
          );
        return;
      }
      const id = message?.request?.id;
      reply(
        rejection(
          typeof id === "string" && id.length > 0 ? id : null,
          "INVALID_REQUEST",
          "Expected a labelled control request or result.",
        ),
      );
      return;
    }
    if (parsed.data.event === "request") answer(parsed.data.request);
    else if (parsed.data.response.id !== null)
      settle(
        parsed.data.response.id,
        parsed.data.response.ok
          ? { ok: true, data: parsed.data.response.data }
          : { ok: false, error: parsed.data.response.error },
      );
  };

  options.input.on("data", (chunk: Buffer) => {
    for (const outcome of stream.push(chunk)) {
      if (outcome.ok) dispatch(outcome.value);
      else if (outcome.error.code === "FRAME_TOO_LARGE")
        reply(rejection(null, "LIMIT_EXCEEDED", "Control frame exceeds the byte limit."));
      else
        reply(rejection(null, "INVALID_REQUEST", "Expected a labelled control request or result."));
    }
  });

  const close = (): void => {
    if (ended) return;
    ended = true;
    options.input.pause();
    // Settling deletes the entry it answers, which a live Map iteration tolerates.
    for (const id of pending.keys())
      settle(id, operationError("SERVICE_STOPPED", "The control channel closed before an answer"));
    options.onEnd();
  };
  for (const event of ["end", "close", "error"] as const) options.input.on(event, close);
  // A dead reader breaks control output before EOF reaches the input.
  options.output.on("error", close);
  if (
    options.input.readableEnded ||
    options.input.destroyed ||
    options.output.destroyed ||
    options.output.writableEnded
  )
    queueMicrotask(close);

  return {
    emit,
    close,
    get updateBlocked() {
      return productInbound > 0 || pending.size > 0 || writes > 0;
    },
    call: (operation, params, callOptions) =>
      new Promise<OperationResult>((resolve) => {
        if (ended) {
          resolve(operationError("SERVICE_STOPPED", "The control channel is closed"));
          return;
        }
        if (pending.size >= MAX_PENDING_CONTROL_CALLS) {
          resolve(operationError("LIMIT_EXCEEDED", "Too many native calls are already in flight."));
          return;
        }
        outbound += 1;
        const id = `service-${outbound}`;
        const timer = setTimeout(
          () => settle(id, operationError("TIMEOUT", `${operation} did not answer in time`)),
          callOptions?.timeoutMs ?? timeoutMs,
        );
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        if (!write({ event: "call", request: { id, operation, params } }, true))
          settle(
            id,
            operationError("LIMIT_EXCEEDED", `${operation} exceeds the control byte limit`),
          );
      }),
  };
}
