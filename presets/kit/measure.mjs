#!/usr/bin/env node
// Style profile of one video: shots and cut rhythm, picture levels, palette and loudness over time.
// The same profile describes a preset's reference examples and the export being checked against them.
//   node measure.mjs <video> [--out profile.json] [--sample-every 2] [--scene 0.3]
// Uses ffmpeg/ffprobe from PATH, or YAP_FFMPEG / YAP_FFPROBE (see `yap service.tools`).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ffmpeg = process.env.YAP_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.YAP_FFPROBE ?? "ffprobe";
const big = { maxBuffer: 1 << 28 };

const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function probe(path) {
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], big);
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  const [num, den] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSeconds: round(Number(info.format.duration)),
    video: video && { width: video.width, height: video.height, fps: den ? round(num / den) : null, codec: video.codec_name },
    audio: audio && { sampleRate: Number(audio.sample_rate), channels: audio.channels, codec: audio.codec_name },
  };
}

async function detectCuts(path, threshold) {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", path, "-an", "-vf", `scale=192:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], big);
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => round(Number(m[1])));
}

async function pictureSamples(path, every) {
  const { stdout } = await run(ffmpeg, ["-hide_banner", "-v", "error", "-i", path, "-an", "-vf", `fps=1/${every}:round=down,signalstats,metadata=print:file=-`, "-f", "null", "-"], big);
  const samples = [];
  for (const line of stdout.split("\n")) {
    const frame = line.match(/pts_time:([0-9.]+)/);
    if (frame) samples.push({ t: round(Number(frame[1])) });
    const value = line.match(/lavfi\.signalstats\.(YAVG|YLOW|YHIGH|SATAVG|HUEMED)=([0-9.]+)/);
    if (value && samples.length) samples.at(-1)[value[1].toLowerCase()] = round(Number(value[2]), 1);
  }
  return samples;
}

async function palette(path, every, colors = 8) {
  const dir = mkdtempSync(join(tmpdir(), "preset-palette-"));
  try {
    const png = join(dir, "palette.png");
    await run(ffmpeg, ["-v", "error", "-y", "-i", path, "-an", "-vf", `fps=1/${every},scale=96:-2,palettegen=max_colors=${colors}:reserve_transparent=0:stats_mode=full`, "-frames:v", "1", png], big);
    const { stdout } = await run(ffmpeg, ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { ...big, encoding: "buffer" });
    const seen = new Set();
    for (let o = 0; o + 2 < stdout.length; o += 3)
      seen.add("#" + [stdout[o], stdout[o + 1], stdout[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join(""));
    return [...seen].slice(0, colors);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loudness(path) {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], big);
  const momentary = [];
  for (const m of stderr.matchAll(/t:\s*([0-9.]+)\s+TARGET:[^M]*M:\s*(-?[0-9.]+|-inf)/g)) {
    const t = Number(m[1]);
    if (Math.abs(t - Math.round(t)) < 0.05 && Math.round(t) > (momentary.at(-1)?.t ?? 0))
      momentary.push({ t: Math.round(t), lufs: m[2] === "-inf" ? null : Number(m[2]) });
  }
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const pick = (re) => Number(summary.match(re)?.[1]);
  return { integratedLufs: pick(/I:\s*(-?[0-9.]+) LUFS/), rangeLu: pick(/LRA:\s*([0-9.]+) LU/), truePeakDbfs: pick(/Peak:\s*(-?[0-9.]+) dBFS/), momentary };
}

export async function measureVideo(path, { sampleEverySeconds = 2, sceneThreshold = 0.3 } = {}) {
  const info = await probe(path);
  const [cuts, samples, colors, sound] = await Promise.all([
    info.video ? detectCuts(path, sceneThreshold) : [],
    info.video ? pictureSamples(path, sampleEverySeconds) : [],
    info.video ? palette(path, sampleEverySeconds) : [],
    info.audio ? loudness(path) : null,
  ]);
  const bounds = [0, ...cuts, info.durationSeconds];
  const lengths = bounds.slice(1).map((end, i) => round(end - bounds[i])).filter((d) => d > 0);
  const sorted = [...lengths].sort((a, b) => a - b);
  const cutsPerMinute = [];
  for (let minute = 0; minute * 60 < info.durationSeconds; minute++)
    cutsPerMinute.push(cuts.filter((t) => t >= minute * 60 && t < (minute + 1) * 60).length);
  const levels = (key) => round(samples.reduce((sum, s) => sum + (s[key] ?? 0), 0) / Math.max(1, samples.length), 1);
  return {
    format: 1,
    ...info,
    cuts,
    shots: {
      count: lengths.length,
      medianSeconds: round(median(lengths) ?? 0),
      p25Seconds: quantile(sorted, 0.25),
      p75Seconds: quantile(sorted, 0.75),
      longestSeconds: sorted.at(-1) ?? null,
      cutsPerMinute,
    },
    picture: { sampleEverySeconds, yavg: levels("yavg"), ylow: levels("ylow"), yhigh: levels("yhigh"), satavg: levels("satavg"), samples },
    palette: colors,
    loudness: sound,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const input = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!input) {
    console.error("usage: measure.mjs <video> [--out profile.json] [--sample-every 2] [--scene 0.3]");
    process.exit(2);
  }
  const profile = await measureVideo(input, { sampleEverySeconds: Number(flag("--sample-every", 2)), sceneThreshold: Number(flag("--scene", 0.3)) });
  const text = JSON.stringify(profile, null, 1) + "\n";
  const out = flag("--out");
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
