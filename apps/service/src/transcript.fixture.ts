import { createHash } from "node:crypto";
import { lstat, mkdir, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Models, parakeetModel } from "@yap/core/models";
import { Catalog } from "@yap/core/catalog";
import type { SpeechTranscriptionRequest } from "@yap/core/transcript";
import { expect } from "vitest";
import type { MediaWorker } from "./worker.js";

// Sparse sizes and stat-bound receipts exercise actual Models metadata/readiness only.
// These are not model weights; the controlled transcription edge never reads them.
export async function modelMetadata(library: string) {
  const catalog = new Catalog(join(library, "catalog.sqlite"));
  const root = join(library, "models", "parakeet", parakeetModel.revision);
  const files: Record<string, { modifiedNs: string; inode: string }> = {};
  for (const file of parakeetModel.files) {
    const path = join(root, parakeetModel.folderName, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    await truncate(path, file.bytes);
    const info = await lstat(path, { bigint: true });
    files[file.path] = { modifiedNs: String(info.mtimeNs), inode: String(info.ino) };
  }
  const receipt = join(root, "receipt.json");
  await writeFile(
    receipt,
    JSON.stringify({
      modelDigest: new Models(library, globalThis.fetch, undefined, catalog).transcription(
        "parakeet",
      ).modelDigest,
      files,
    }),
  );
  catalog.close();
  return { directory: join(root, parakeetModel.folderName), receipt };
}
export const spoken = [
  { text: "Open", startUs: 200000, endUs: 500000 },
  { text: "the", startUs: 500000, endUs: 700000 },
  { text: "Settings", startUs: 800000, endUs: 1400000 },
  { text: "panel.", startUs: 1500000, endUs: 2000000 },
  { text: "Um,", startUs: 4100000, endUs: 4300000 },
  { text: "press", startUs: 4500000, endUs: 5000000 },
  { text: "record", startUs: 5100000, endUs: 5800000 },
];
/** A controlled native edge: probe two audio streams and transcribe `words`, with raw line issues. */
export function controlledSpeech(
  requests: SpeechTranscriptionRequest[],
  lineIssues: Record<string, unknown>[] = [],
  words: readonly { text: string; startUs: number; endUs: number }[] = spoken,
): MediaWorker {
  return async (operation, params) => {
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 48675,
          streams: [
            {
              id: "track:1",
              kind: "audio",
              codec: "pcm",
              decodable: true,
              startUs: 0,
              endUs: 10000000,
              segments: [
                { startUs: 0, endUs: 3000000, empty: false },
                { startUs: 3000000, endUs: 4000000, empty: true },
                { startUs: 4000000, endUs: 6000000, empty: false },
                { startUs: 6000000, endUs: 10000000, empty: true },
              ],
            },
            {
              id: "audio",
              kind: "audio",
              codec: "pcm",
              decodable: true,
              channels: 2,
              sampleRate: 16000,
              startUs: 0,
              endUs: 40000000,
              segments: [{ startUs: 0, endUs: 40000000, empty: false }],
            },
          ],
        },
      };
    expect(operation).toBe("speech.transcribe");
    const request = params as SpeechTranscriptionRequest;
    requests.push(request);
    const lines = request.track.available.map((source, ordinal) => {
      const lineWords = words
        .filter(
          (word) => word.startUs >= Number(source.startUs) && word.endUs <= Number(source.endUs),
        )
        .map(({ text, ...range }) => ({
          text,
          source: range,
          confidence: 0.9,
          startSeconds: (range.startUs - Number(source.startUs)) / 1e6,
          endSeconds: (range.endUs - Number(source.startUs)) / 1e6,
        }));
      return {
        ordinal,
        source,
        owned: source,
        state: "transcribed" as const,
        words: lineWords,
        ...(ordinal === 0 && lineIssues.length ? { issues: lineIssues } : {}),
      };
    });
    const raw = lines.map((line) => JSON.stringify(line) + "\n").join("");
    await writeFile(request.output, raw);
    return {
      ok: true,
      data: {
        output: {
          file: request.output,
          bytes: Buffer.byteLength(raw),
          sha256: createHash("sha256").update(raw).digest("hex"),
        },
        engine: {
          ...parakeetModel.engine,
          encoderPrecision: "int8",
          computeUnits: "cpuAndNeuralEngine",
        },
        execution: request.execution,
        available: request.track.available,
        segments: lines.map(({ ordinal, source, state, words }) => ({
          ordinal,
          source,
          owned: source,
          state,
          wordCount: words.length,
        })),
        wordCount: words.length,
      },
    };
  };
}
