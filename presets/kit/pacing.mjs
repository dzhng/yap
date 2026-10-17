#!/usr/bin/env node
// Speech pacing of a Yap source transcript as numbers only (never words): words per minute,
// pause lengths and phrase lengths. A teaser and a body differ here even when the cut looks alike.
//   node pacing.mjs <assetId> <streamId> [--yap path] [--words-out words.json]
// Reads every page with `yap transcript.get`; --words-out also saves the word time ranges (no text) for music.mjs.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PAUSE_US = 300_000;
const quantile = (sorted, q) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 100) / 100 : null);

/** ranges: [{ startUs, endUs }] for each spoken word, in order. */
export function pacingOf(ranges) {
  if (ranges.length < 2) return null;
  const gaps = ranges.slice(1).map((w, i) => w.startUs - ranges[i].endUs);
  const pauses = gaps.filter((g) => g >= PAUSE_US).map((g) => g / 1e6).sort((a, b) => a - b);
  const span = (ranges.at(-1).endUs - ranges[0].startUs) / 1e6;
  const phrases = [];
  let length = 1;
  for (const g of gaps) g >= PAUSE_US ? (phrases.push(length), (length = 1)) : length++;
  phrases.push(length);
  phrases.sort((a, b) => a - b);
  return {
    words: ranges.length,
    spanSeconds: Math.round(span * 10) / 10,
    wordsPerMinute: Math.round((ranges.length / span) * 60),
    pausesPerMinute: Math.round((pauses.length / span) * 600) / 10,
    pauseSeconds: { p50: quantile(pauses, 0.5), p90: quantile(pauses, 0.9) },
    wordsPerPhrase: { p50: quantile(phrases, 0.5), p90: quantile(phrases, 0.9) },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [assetId, streamId] = process.argv.slice(2);
  const yap = process.argv.includes("--yap") ? process.argv[process.argv.indexOf("--yap") + 1] : "yap";
  if (!assetId || !streamId) {
    console.error("usage: pacing.mjs <assetId> <streamId> [--yap path]");
    process.exit(2);
  }
  const ranges = [];
  let params = { assetId, streamId };
  for (;;) {
    const reply = JSON.parse(execFileSync(yap, ["transcript.get", "--params", JSON.stringify(params)], { encoding: "utf8", maxBuffer: 1 << 28 }));
    if (!reply.ok || reply.data.state !== "ready") throw new Error(`transcript not ready: ${JSON.stringify(reply).slice(0, 300)}`);
    for (const row of reply.data.page.rows) if (row.type === "word") ranges.push(row.sourceRange);
    if (!reply.data.page.nextCursor) break;
    params = { assetId, streamId, cursor: reply.data.page.nextCursor };
  }
  if (process.argv.includes("--words-out"))
    writeFileSync(process.argv[process.argv.indexOf("--words-out") + 1], JSON.stringify(ranges.map(({ startUs, endUs }) => ({ startUs, endUs }))));
  console.log(JSON.stringify(pacingOf(ranges), null, 1));
}
