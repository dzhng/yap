export const REQUEST_FRAME_BYTES = 1024 * 1024;
export const RESPONSE_FRAME_BYTES = 8 * 1024 * 1024;
export const CONTROL_FRAME_BYTES = 64 * 1024;
// One JSON page leaves room for the response envelope and control framing.
export const RESPONSE_PAGE_BYTES = RESPONSE_FRAME_BYTES - CONTROL_FRAME_BYTES;
// A full result appears once structurally and at most twice as quoted JSON text.
export const MCP_RESULT_INLINE_BYTES = Math.floor((RESPONSE_FRAME_BYTES - CONTROL_FRAME_BYTES) / 3);
export const MAX_PENDING_CONTROL_CALLS = 32;
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;
/** Total time for one native media worker run, including process startup. */
export const MEDIA_WORKER_TIMEOUT_MS = 30_000;

export class FrameError extends Error {
  constructor(
    readonly code: "FRAME_TOO_LARGE" | "MALFORMED_FRAME" | "TRUNCATED_FRAME",
    message: string,
  ) {
    super(message);
  }
}

export function encodeJsonLine(value: unknown, maxBytes: number): Buffer {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (
      item === undefined ||
      ["function", "symbol", "bigint"].includes(typeof item) ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw new FrameError("MALFORMED_FRAME", "Value is not JSON");
    return item;
  });
  if (json === undefined) throw new FrameError("MALFORMED_FRAME", "Value is not JSON");
  if (Buffer.byteLength(json) + 1 > maxBytes)
    throw new FrameError("FRAME_TOO_LARGE", "JSON frame exceeds the byte limit");
  return Buffer.from(json + "\n");
}

export class JsonLineReader {
  private buffer: Buffer = Buffer.alloc(0);
  private bytes = 0;
  private complete = false;
  private value: unknown;
  constructor(private readonly maxBytes: number) {}
  push(chunk: Uint8Array): unknown {
    if (this.complete) throw new FrameError("MALFORMED_FRAME", "Expected exactly one JSON line");
    const size = this.bytes + chunk.byteLength;
    if (size > this.maxBytes)
      throw new FrameError("FRAME_TOO_LARGE", "JSON frame exceeds the byte limit");
    const newline = chunk.indexOf(10);
    if (newline >= 0 && newline !== chunk.byteLength - 1)
      throw new FrameError("MALFORMED_FRAME", "Expected exactly one JSON line");
    if (size > this.buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.maxBytes, Math.max(size, this.buffer.length * 2, 1024)),
      );
      this.buffer.copy(next, 0, 0, this.bytes);
      this.buffer = next;
    }
    this.buffer.set(chunk, this.bytes);
    this.bytes = size;
    if (newline < 0) return undefined;
    try {
      // Decode only a complete frame: multi-byte UTF-8 can cross socket chunks.
      this.value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, size - 1)),
      );
    } catch {
      throw new FrameError("MALFORMED_FRAME", "Invalid UTF-8 or JSON");
    }
    this.complete = true;
    this.buffer = Buffer.alloc(0);
    return this.value;
  }
  finish(): unknown {
    if (!this.complete)
      throw new FrameError("TRUNCATED_FRAME", "Connection ended before the JSON line terminator");
    return this.value;
  }
}

export type JsonLineOutcome = { ok: true; value: unknown } | { ok: false; error: FrameError };

// A long-lived pipe carries many frames, so an unreadable line must not poison the
// rest of the stream: report it and resynchronize at the next terminator.
export class JsonLineStream {
  private pending: Buffer[] = [];
  private bytes = 0;
  private discarding = false;
  constructor(private readonly maxBytes: number) {}
  push(chunk: Uint8Array): JsonLineOutcome[] {
    const outcomes: JsonLineOutcome[] = [];
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let end = rest.indexOf(10); end >= 0; end = rest.indexOf(10)) {
      const line = rest.subarray(0, end);
      rest = rest.subarray(end + 1);
      if (this.discarding) {
        this.reset();
        continue;
      }
      if (this.bytes + line.byteLength + 1 > this.maxBytes) {
        this.reset();
        outcomes.push({ ok: false, error: new FrameError("FRAME_TOO_LARGE", OVERSIZED) });
        continue;
      }
      this.pending.push(Buffer.from(line));
      const complete = Buffer.concat(this.pending);
      this.reset();
      outcomes.push(decodeJsonLine(complete));
    }
    if (this.discarding) return outcomes;
    if (this.bytes + rest.byteLength + 1 > this.maxBytes) {
      this.reset();
      this.discarding = true;
      outcomes.push({ ok: false, error: new FrameError("FRAME_TOO_LARGE", OVERSIZED) });
      return outcomes;
    }
    if (rest.byteLength > 0) {
      this.pending.push(Buffer.from(rest));
      this.bytes += rest.byteLength;
    }
    return outcomes;
  }
  finish(): FrameError | undefined {
    if (this.bytes === 0 && !this.discarding) return undefined;
    this.reset();
    return new FrameError("TRUNCATED_FRAME", "Stream ended before the JSON line terminator");
  }
  private reset(): void {
    this.pending = [];
    this.bytes = 0;
    this.discarding = false;
  }
}

const OVERSIZED = "JSON frame exceeds the byte limit";

function decodeJsonLine(line: Buffer): JsonLineOutcome {
  try {
    // Decode only a complete frame: multi-byte UTF-8 can cross pipe chunks.
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) };
  } catch {
    return { ok: false, error: new FrameError("MALFORMED_FRAME", "Invalid UTF-8 or JSON") };
  }
}
