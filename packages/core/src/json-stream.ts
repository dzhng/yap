import { JSONParser } from "@streamparser/json";

/** Incremental decoding retains semantic values, never a second raw copy of the document. */
export class JsonDocument {
  private readonly parser = new JSONParser({ paths: ["$"], stringBufferSize: 64 * 1024 });
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private result: unknown;
  private completed = false;
  constructor() {
    this.parser.onValue = ({ value }) => {
      this.result = value;
      this.completed = true;
    };
  }
  write(chunk: Uint8Array): void {
    try {
      this.parser.write(this.decoder.decode(chunk, { stream: true }));
    } catch (cause) {
      throw new SyntaxError("Malformed JSON inventory", { cause });
    }
  }
  finish(): unknown {
    try {
      const tail = this.decoder.decode();
      if (tail) this.parser.write(tail);
      if (!this.parser.isEnded) this.parser.end();
      if (!this.completed) throw new SyntaxError("Incomplete JSON inventory");
      return this.result;
    } catch (cause) {
      throw new SyntaxError("Malformed JSON inventory", { cause });
    }
  }
}

/** Callers validate the resulting typed resources; arrays retain their ordinary JSON meaning. */
export function readJsonChunks(chunks: Iterable<Uint8Array>): unknown {
  const document = new JsonDocument();
  for (const chunk of chunks) document.write(chunk);
  return document.finish();
}

/** Emit inventory members independently, without serializing the whole inventory at once. */
function* jsonFragments(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) {
      if (i) yield ",";
      yield* jsonFragments(value[i]);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key) + ":";
      yield* jsonFragments(item);
    }
    yield "}";
  } else yield JSON.stringify(value) ?? "null";
}

/** Ordinary write batches, independent of the inventory's total byte count. */
export function* jsonChunks(value: unknown): Generator<string> {
  let batch = "";
  for (const fragment of jsonFragments(value)) {
    batch += fragment;
    if (batch.length >= 64 * 1024) {
      yield batch;
      batch = "";
    }
  }
  if (batch) yield batch;
}
