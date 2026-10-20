import { expect, test } from "vitest";
import { readImportedTranscript } from "./transcript-import.js";
import { ImportedTranscriptStore } from "./imported-transcript.js";
import { Catalog } from "./catalog.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function* chunks(input: Uint8Array | string) {
  yield typeof input === "string" ? Buffer.from(input) : input;
}
async function parseImportedTranscript(
  input: Uint8Array | string,
  options: Parameters<typeof readImportedTranscript>[1],
) {
  return readImportedTranscript(chunks(input), options);
}

test("parses VTT cues without inventing word timings and preserves source metadata", async () => {
  const raw = Buffer.from(
    "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\n<v Ada>Hello,</v>\n\n2\n00:00:02.400 --> 00:00:03.000\nworld & friends\n",
    "utf8",
  );

  const parsed = await parseImportedTranscript(raw, { format: "vtt" });

  expect(parsed.format).toBe("vtt");
  expect(parsed.timingBasis).toBe("supplied");
  expect(parsed.raw.bytes).toBe(raw.byteLength);
  expect(parsed.raw.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(parsed.cues).toEqual([
    {
      id: "1",
      ordinal: 0,
      text: "Hello,",
      speaker: "Ada",
      source: { startUs: 1_000_000, endUs: 2_500_000 },
      words: [],
    },
    {
      id: "2",
      ordinal: 1,
      text: "world & friends",
      speaker: undefined,
      source: { startUs: 2_400_000, endUs: 3_000_000 },
      words: [],
    },
  ]);
});

test("parses SRT cue timing as supplied cue evidence", async () => {
  const parsed = await parseImportedTranscript("1\n00:00:01,000 --> 00:00:02,500\nHello, world\n", {
    format: "srt",
  });
  expect(parsed.cues[0]).toMatchObject({
    id: "1",
    text: "Hello, world",
    source: { startUs: 1_000_000, endUs: 2_500_000 },
    words: [],
  });
});

test("preserves supplied JSON word timings and speaker labels", async () => {
  const parsed = await parseImportedTranscript(
    JSON.stringify({
      source: { name: "human-caption" },
      cues: [
        {
          id: "cue-a",
          startUs: 0,
          endUs: 2_000_000,
          text: "hello world",
          speaker: "Ada",
          words: [
            { text: "hello", startUs: 0, endUs: 900_000 },
            { text: "world", startUs: 1_000_000, endUs: 2_000_000, confidence: 0.8 },
          ],
        },
      ],
    }),
    { format: "json" },
  );
  expect(parsed.cues[0]).toMatchObject({
    id: "cue-a",
    speaker: "Ada",
    words: [
      { text: "hello", source: { startUs: 0, endUs: 900_000 } },
      { text: "world", source: { startUs: 1_000_000, endUs: 2_000_000 }, confidence: 0.8 },
    ],
  });
});

test("stores an imported generation with replay identity and raw bytes", async () => {
  const home = await mkdtemp("/tmp/yap-import-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const source = { assetId: "a".repeat(64), streamId: "audio:1" };
  const path = join(home, "captions.srt");
  await writeFile(path, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
  const store = new ImportedTranscriptStore(catalog, home, () => {});
  const first = await store.importPath("request-1", source, path);
  const replay = await store.importPath("request-1", source, path);
  expect(replay).toEqual(first);
  expect(first.origin.raw.bytes).toBeGreaterThan(0);
  expect(store.get(source, first.generation).cues[0]?.text).toBe("hello");
  expect(first.timingPolicy).toBe("supplied");
  const portable = store.portableGenerations(source.assetId)[0]!;
  expect(portable.generation).toBe(first.generation);
  expect(store.portableFile(portable).bytes).toBe(first.origin.raw.bytes);
  catalog.close();
  await rm(home, { recursive: true, force: true });
});

test("file import preserves UTF-8 and CRLF across read boundaries without buffering the source", async () => {
  const home = await mkdtemp("/tmp/yap-import-chunks-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  try {
    const source = { assetId: "b".repeat(64), streamId: "audio:1" };
    const path = join(home, "captions.vtt");
    // The accented character begins at the last byte of the first production read.
    const header = "WEBVTT\r\n\r\nNOTE ";
    const raw =
      header +
      "x".repeat(65_535 - Buffer.byteLength(header)) +
      "é\r\n\r\n" +
      "00:00:01.000 --> 00:00:02.000\r\n<v Ada>café</v>\r\n\r\n" +
      "00:00:02.000 --> 00:00:03.000\r\nnext\r\n";
    await writeFile(path, raw);
    const store = new ImportedTranscriptStore(catalog, home, () => {});
    const imported = await store.importPath("split-source", source, path);
    expect(imported.cues).toEqual([
      {
        id: "1",
        ordinal: 0,
        text: "café",
        speaker: "Ada",
        source: { startUs: 1_000_000, endUs: 2_000_000 },
        words: [],
      },
      {
        id: "2",
        ordinal: 1,
        text: "next",
        source: { startUs: 2_000_000, endUs: 3_000_000 },
        words: [],
      },
    ]);
    expect(imported.origin.raw.bytes).toBe(Buffer.byteLength(raw));
  } finally {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});
