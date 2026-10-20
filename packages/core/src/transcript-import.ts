import { JsonDocument } from "./json-stream.js";
import { createHash } from "node:crypto";
import { CatalogError } from "./catalog.js";

export type ImportedFormat = "srt" | "vtt" | "json";
export type ImportedRange = { startUs: number; endUs: number };
export type ImportedWord = {
  text: string;
  source: ImportedRange;
  confidence?: number;
};
export type ImportedCue = {
  id: string;
  ordinal: number;
  text: string;
  speaker?: string;
  settings?: string;
  source: ImportedRange;
  words: ImportedWord[];
};
export type ImportedTranscript = {
  format: ImportedFormat;
  parser: { name: string; version: string };
  timingBasis: "supplied";
  raw: { bytes: number; sha256: string };
  metadata: Record<string, unknown>;
  cues: ImportedCue[];
};

const parserVersion = "transcript-import-v1";

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new CatalogError("INVALID_PARAMS", message, details);
}

function range(startUs: number, endUs: number): ImportedRange {
  if (
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs
  )
    invalid("Transcript timing must be a non-empty non-negative range", { startUs, endUs });
  return { startUs, endUs };
}

function timestamp(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) invalid("Transcript timestamp is invalid", { value });
    const micros = Math.round(value * 1_000_000);
    if (!Number.isSafeInteger(micros))
      invalid("Transcript timestamp is outside the supported range", { value });
    return micros;
  }
  if (typeof value !== "string") invalid("Transcript timestamp must be a string or number");
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3,6})$/);
  if (!match) invalid("Transcript timestamp is invalid", { value });
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4]!.padEnd(6, "0").slice(0, 6);
  if (minutes > 59 || seconds > 59) invalid("Transcript timestamp is invalid", { value });
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000_000 + Number(fraction);
}

function parseTiming(line: string): { source: ImportedRange; settings?: string } {
  const match = line.match(/^\s*(.*?)\s*-->\s*(.*?)(?:\s+.*)?$/);
  if (!match) invalid("Transcript cue timing is malformed", { line });
  const endAndSettings = match[2]!.trim().split(/\s+/, 2);
  return {
    source: range(timestamp(match[1]), timestamp(endAndSettings[0])),
    ...(endAndSettings[1] === undefined ? {} : { settings: endAndSettings[1] }),
  };
}

function extractSpeaker(text: string): { text: string; speaker?: string } {
  const match = text.match(/^\s*<v\s+([^>]+)>([\s\S]*)<\/v>\s*$/i);
  if (!match) return { text };
  const speaker = match[1]!.trim();
  if (!speaker) return { text: match[2]!.trim() };
  return { text: match[2]!.trim(), speaker };
}

function cue(
  id: string,
  ordinal: number,
  source: ImportedRange,
  text: string,
  speaker?: string,
  settings?: string,
): ImportedCue {
  const extracted = extractSpeaker(text);
  return {
    id,
    ordinal,
    text: extracted.text,
    ...(speaker === undefined
      ? extracted.speaker === undefined
        ? {}
        : { speaker: extracted.speaker }
      : { speaker }),
    ...(settings === undefined ? {} : { settings }),
    source,
    words: [],
  };
}

/** Only the current cue is buffered; the semantic cue inventory is the retained result. */
class TextCues {
  readonly cues: ImportedCue[] = [];
  private block: string[] = [];
  private header = false;
  constructor(private readonly format: "srt" | "vtt") {}
  line(line: string) {
    if (!this.header) {
      this.header = true;
      line = line.replace(/^\uFEFF/, "");
      if (this.format === "vtt") {
        if (!/^WEBVTT(?:\s|$)/.test(line)) invalid("VTT input must begin with WEBVTT");
        return;
      }
    }
    if (line.trim()) this.block.push(line);
    else this.flush();
  }
  private flush() {
    const lines = this.block;
    this.block = [];
    if (
      !lines.length ||
      (this.format === "vtt" && /^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0]!.trim()))
    )
      return;
    let first = lines[0]!.trim(),
      index = 1,
      id = String(this.cues.length + 1);
    if (!first.includes("-->")) {
      id = first;
      first = lines[index++]?.trim() ?? "";
    }
    const timed = parseTiming(first);
    const textLines = lines.slice(index);
    if (!textLines.length) invalid("Transcript cue has no text", { id });
    const text = textLines.join("\n");
    this.cues.push(
      this.format === "vtt"
        ? cue(id, this.cues.length, timed.source, text, undefined, timed.settings)
        : { id, ordinal: this.cues.length, text, source: timed.source, words: [] },
    );
  }
  finish() {
    this.flush();
    if (!this.cues.length) invalid("Transcript contains no cues");
    return { cues: this.cues, metadata: {} };
  }
}

function objectRange(value: Record<string, unknown>, label: string): ImportedRange {
  const start = value.startUs ?? value.start;
  const end = value.endUs ?? value.end;
  if (start === undefined || end === undefined) invalid(`JSON ${label} is missing timing`);
  return range(
    value.startUs !== undefined ? Number(start) : timestamp(start),
    value.endUs !== undefined ? Number(end) : timestamp(end),
  );
}

function parseJson(value: unknown): { cues: ImportedCue[]; metadata: Record<string, unknown> } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { cues?: unknown }).cues))
    invalid("Transcript JSON must contain a cues array");
  const cues = (value as { cues: unknown[] }).cues.map((entry, ordinal) => {
    if (!entry || typeof entry !== "object") invalid("Transcript JSON cue is invalid", { ordinal });
    const item = entry as Record<string, unknown>;
    const text = item.text;
    if (typeof text !== "string" || !text.trim())
      invalid("Transcript JSON cue text is invalid", { ordinal });
    const words = item.words;
    if (words !== undefined && !Array.isArray(words))
      invalid("Transcript JSON cue words are invalid", { ordinal });
    const parsedWords = (words ?? []).map((word, wordOrdinal) => {
      if (!word || typeof word !== "object")
        invalid("Transcript JSON word is invalid", { ordinal, wordOrdinal });
      const w = word as Record<string, unknown>;
      if (typeof w.text !== "string" || !w.text.trim())
        invalid("Transcript JSON word text is invalid", { ordinal, wordOrdinal });
      const result: ImportedWord = { text: w.text, source: objectRange(w, "word") };
      if (w.confidence !== undefined) {
        if (
          typeof w.confidence !== "number" ||
          !Number.isFinite(w.confidence) ||
          w.confidence < 0 ||
          w.confidence > 1
        )
          invalid("Transcript JSON word confidence is invalid", { ordinal, wordOrdinal });
        result.confidence = w.confidence;
      }
      return result;
    });
    const source = objectRange(item, "cue");
    for (const word of parsedWords)
      if (word.source.startUs < source.startUs || word.source.endUs > source.endUs)
        invalid("Transcript JSON word falls outside its cue", { ordinal });
    const id = item.id === undefined ? String(ordinal + 1) : String(item.id);
    const speaker = item.speaker;
    if (speaker !== undefined && typeof speaker !== "string")
      invalid("Transcript JSON speaker is invalid", { ordinal });
    return {
      id,
      ordinal,
      text,
      ...(speaker === undefined ? {} : { speaker }),
      source,
      words: parsedWords,
    };
  });
  const metadata = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "cues"),
  );
  if (!cues.length) invalid("Transcript JSON contains no cues");
  return { cues, metadata };
}

class ImportedTranscriptReader {
  private readonly hash = createHash("sha256");
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private bytes = 0;
  private prefix = "";
  private format: ImportedFormat | undefined;
  private json: JsonDocument | undefined;
  private text: TextCues | undefined;
  private pending = "";
  private afterCR = false;
  constructor(options: { format?: ImportedFormat }) {
    this.format = options.format;
  }
  write(bytes: Uint8Array) {
    this.hash.update(bytes);
    this.bytes += bytes.byteLength;
    try {
      this.decoded(this.decoder.decode(bytes, { stream: true }));
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      invalid("Transcript input is not valid UTF-8 or JSON");
    }
  }
  private decoded(value: string, end = false) {
    if (!this.json && !this.text) {
      this.prefix += value;
      const trimmed = this.prefix.trimStart();
      if (!this.format) {
        if ((!trimmed && !end) || ("WEBVTT".startsWith(trimmed) && trimmed.length < 6 && !end))
          return;
        this.format = trimmed.startsWith("WEBVTT")
          ? "vtt"
          : trimmed.startsWith("{")
            ? "json"
            : "srt";
      }
      if (this.format === "json") this.json = new JsonDocument();
      else this.text = new TextCues(this.format);
      value = this.prefix;
      this.prefix = "";
    }
    if (this.json) {
      this.json.write(Buffer.from(value));
      return;
    }
    for (const character of value) {
      if (character === "\n" && this.afterCR) {
        this.afterCR = false;
        continue;
      }
      this.afterCR = character === "\r";
      if (character === "\r" || character === "\n") {
        this.text!.line(this.pending);
        this.pending = "";
      } else this.pending += character;
    }
  }
  finish(): ImportedTranscript {
    try {
      this.decoded(this.decoder.decode(), true);
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      invalid("Transcript input is not valid UTF-8 or JSON");
    }
    let parsed;
    try {
      if (this.json) parsed = parseJson(this.json.finish());
      else {
        if (this.pending) this.text!.line(this.pending);
        parsed = this.text!.finish();
      }
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      invalid("Transcript JSON is malformed");
    }
    return {
      format: this.format!,
      parser: { name: "yap-transcript-import", version: parserVersion },
      timingBasis: "supplied",
      raw: { bytes: this.bytes, sha256: this.hash.digest("hex") },
      ...parsed,
    };
  }
}

/** Original bytes stream into one parser shared by import and portable adoption. */
export async function readImportedTranscript(
  chunks: AsyncIterable<Uint8Array>,
  options: { format?: ImportedFormat } = {},
): Promise<ImportedTranscript> {
  const reader = new ImportedTranscriptReader(options);
  for await (const chunk of chunks) reader.write(chunk);
  return reader.finish();
}
