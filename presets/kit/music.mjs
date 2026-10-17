#!/usr/bin/env node
// Music and rhythm of a video's soundtrack as numbers: tempo, beat phase, how many cuts land on a beat,
// how far a music bed sits under speech, and tonal brightness. Never stores or reproduces audio.
//   node music.mjs <media> [--profile profile.json] [--from s --to s] [--words words.json] [--out music.json]
// --profile supplies cuts (from measure.mjs); --words supplies [{startUs,endUs}] speech ranges (pacing.mjs --words-out).
// pulseStrength is on-beat onset energy over average onset energy. Speech alone measures about 1.25, so a
// tempo is only reported as reliable at 1.5 or above; below that the track has no steady beat to cut to.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const ffmpeg = process.env.YAP_FFMPEG ?? "ffmpeg";
const RATE = 11025, HOP = 256; // ~23 ms analysis frames
const round = (v, p = 2) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);

async function pcm(path, from, to) {
  const range = [...(from != null ? ["-ss", String(from)] : []), ...(to != null ? ["-to", String(to)] : [])];
  const { stdout } = await run(ffmpeg, ["-v", "error", ...range, "-i", path, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 30 });
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4);
}

function onsetEnvelope(samples) {
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) e += samples[i] * samples[i];
    energy[f] = Math.log1p(1000 * e);
  }
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);
  return flux;
}

function tempoOf(flux) {
  const fps = RATE / HOP;
  let best = { lag: 0, score: -Infinity };
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let score = 0;
    for (let f = 0; f + lag * 2 < flux.length; f++) {
      const a = Math.round(f + lag), b = Math.round(f + 2 * lag);
      score += flux[f] * (flux[a] + 0.5 * flux[b]);
    }
    // Half and double tempos score alike on a steady pulse; a log-normal prior around 120 BPM
    // (one octave wide) picks the likelier one without hiding a genuinely slow or fast track.
    score *= Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (score > best.score) best = { lag, score, bpm };
  }
  let phase = { offset: 0, sum: -Infinity };
  for (let o = 0; o < best.lag; o++) {
    let sum = 0;
    for (let f = o; f < flux.length; f += best.lag) sum += flux[Math.round(f)] ?? 0;
    if (sum > phase.sum) phase = { offset: o, sum };
  }
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const onBeat = phase.sum / Math.max(1, Math.floor(flux.length / best.lag));
  return { bpm: best.bpm, offsetSeconds: (phase.offset * HOP) / RATE, strength: mean > 0 ? onBeat / mean : 0 };
}

const rmsDb = (samples, ranges) => {
  let e = 0, n = 0;
  for (const [a, b] of ranges)
    for (let i = Math.max(0, Math.floor(a * RATE)); i < Math.min(samples.length, Math.floor(b * RATE)); i++) (e += samples[i] * samples[i]), n++;
  return n > RATE * 0.5 ? 10 * Math.log10(e / n + 1e-12) : null;
};

async function brightness(path, from, to) {
  const range = [...(from != null ? ["-ss", String(from)] : []), ...(to != null ? ["-to", String(to)] : [])];
  const { stdout } = await run(ffmpeg, ["-v", "error", ...range, "-i", path, "-vn", "-ac", "1", "-af", "aspectralstats=measure=centroid,ametadata=print:file=-", "-f", "null", "-"], { maxBuffer: 1 << 28 });
  const values = [...stdout.matchAll(/centroid=([0-9.]+)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
  values.sort((a, b) => a - b);
  return values.length ? Math.round(values[values.length >> 1]) : null;
}

export async function analyzeMusic(path, { from, to, cuts = [], words = [] } = {}) {
  const samples = await pcm(path, from, to);
  const flux = onsetEnvelope(samples);
  const { bpm, offsetSeconds, strength } = tempoOf(flux);
  const beat = 60 / bpm, start = from ?? 0;
  const local = cuts.map((t) => t - start).filter((t) => t >= 0 && t <= samples.length / RATE);
  const onBeat = local.filter((t) => {
    const d = (((t - offsetSeconds) % beat) + beat) % beat;
    return Math.min(d, beat - d) <= 0.08;
  });
  const speech = words.map((w) => [w.startUs / 1e6 - start, w.endUs / 1e6 - start]);
  const gaps = [];
  let cursor = 0;
  for (const [a, b] of speech) {
    if (a - cursor > 0.4) gaps.push([cursor + 0.1, a - 0.1]);
    cursor = Math.max(cursor, b);
  }
  if (samples.length / RATE - cursor > 0.4) gaps.push([cursor + 0.1, samples.length / RATE]);
  const speechDb = speech.length ? rmsDb(samples, speech) : null;
  const gapDb = speech.length ? rmsDb(samples, gaps) : null;
  return {
    format: 1,
    from: from ?? 0,
    seconds: round(samples.length / RATE),
    tempoBpm: bpm,
    beatOffsetSeconds: round(offsetSeconds, 3),
    pulseStrength: round(strength),
    tempoReliable: strength >= 1.5,
    cutsChecked: local.length,
    cutsOnBeat: local.length ? round(onBeat.length / local.length) : null,
    speechRmsDbfs: round(speechDb, 1),
    gapRmsDbfs: round(gapDb, 1),
    bedBelowSpeechDb: speechDb != null && gapDb != null ? round(speechDb - gapDb, 1) : null,
    medianCentroidHz: await brightness(path, from, to),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  if (!args[0] || args[0].startsWith("--")) {
    console.error("usage: music.mjs <media> [--profile profile.json] [--from s --to s] [--words words.json] [--out music.json]");
    process.exit(2);
  }
  const num = (v) => (v == null ? undefined : Number(v));
  const result = await analyzeMusic(args[0], {
    from: num(flag("--from")),
    to: num(flag("--to")),
    cuts: flag("--profile") ? JSON.parse(readFileSync(flag("--profile"), "utf8")).cuts : [],
    words: flag("--words") ? JSON.parse(readFileSync(flag("--words"), "utf8")) : [],
  });
  const text = JSON.stringify(result, null, 1) + "\n";
  flag("--out") ? writeFileSync(flag("--out"), text) : process.stdout.write(text);
}
