// Does the sound of a take stay with its picture?
//
//   bun run lab:av-sync -- [--recording <id>] [--home <directory>] [--out <directory>]
//
// The take must be of the workbench page with its clapper running and system audio on: every
// fifteen seconds the page flashes a bar white and clicks at the same moment. This finds each
// flash in the video and each click in the system track, pairs them, and reports how far apart
// they are — and, which is the actual question, whether that distance changes across the take.
//
// The offset itself carries a browser's own output latency and this Mac's, so it is reported
// rather than judged. Drift is what a person notices and what the target names: audio that starts
// with the picture and ends a frame and a half late is a take nobody can cut.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    recording: { type: "string" },
    home: { type: "string", default: join(homedir(), ".yap") },
    out: { type: "string" },
    /** How far apart a flash and a click may be and still be the same clap. */
    pairMs: { type: "string", default: "400" },
  },
});

const cli = join(homedir(), ".local", "bin", "yap");
const home = resolve(values.home);
const call = (operation, params = {}) => {
  const answer = JSON.parse(
    execFileSync(
      cli,
      [operation, "--socket", join(home, "run/service.sock"), "--params", JSON.stringify(params)],
      {
        encoding: "utf8",
        cwd: "/",
        timeout: 120_000,
        env: { ...process.env, YAP_HOME: home },
      },
    ),
  );
  if (!answer.ok) throw new Error(`${operation}: ${JSON.stringify(answer.error)}`);
  return answer.data;
};

const recordingId = values.recording ?? call("recording.get").recordingId;
const recording = call("recording.get", { recordingId });
const source = join(home, "library", "recordings", recordingId, "source");
const video = join(source, "video.mov");
const system = join(source, "system.mov");
if (!existsSync(system))
  throw new Error(
    `This take has no system audio, so there is no clap to hear: ${recordingId}. ` +
      "Record the workbench with Include System Audio on.",
  );
const out = values.out ?? join(values.home, "av-sync");
mkdirSync(out, { recursive: true });

/** Where each track's first sample sits in the take's own clock. */
function trackOrigins() {
  const rows = readFileSync(join(source, "capture.journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const origins = {};
  for (const row of rows)
    if (row.event === "trackStarted") origins[row.data.role] = row.data.firstSourceUs;
  return origins;
}
const origins = trackOrigins();

// ---- the clicks -------------------------------------------------------------------------------

const rate = 48_000;
const raw = join(out, "system.f32");
execFileSync("ffmpeg", [
  // prettier-ignore
  "-v",
  "error",
  "-i",
  system,
  "-ac",
  "1",
  "-ar",
  String(rate),
  "-f",
  "f32le",
  "-y",
  raw,
]);
const samples = new Float32Array(readFileSync(raw).buffer);
/**
 * A click is a sudden arrival, so this looks for the sample where loudness jumps rather than for
 * loudness itself: a voice in the same track is louder overall but never arrives this fast.
 */
function clickTimes() {
  const window = rate / 1000; // one millisecond
  const frames = Math.floor(samples.length / window);
  const energy = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let peak = 0;
    for (let at = frame * window; at < (frame + 1) * window; at++)
      peak = Math.max(peak, Math.abs(samples[at]));
    energy[frame] = peak;
  }
  const sorted = Float64Array.from(energy).sort();
  const quiet = sorted[Math.floor(sorted.length * 0.5)];
  const loud = sorted[Math.floor(sorted.length * 0.999)];
  const onset = Math.max(quiet * 8, loud * 0.35);
  const found = [];
  for (let frame = 5; frame < frames; frame++) {
    if (energy[frame] < onset) continue;
    // The rise itself: quiet five milliseconds ago, loud now, and nothing already counted nearby.
    if (energy[frame - 5] > onset / 3) continue;
    if (found.length && frame - found.at(-1) < 1_000) continue;
    found.push(frame);
  }
  return found.map((frame) => origins.system + Math.round(frame * 1_000));
}

// ---- the flashes ------------------------------------------------------------------------------

/**
 * The flash is the whole bar going white for a tenth of a second, which moves the frame's own
 * average brightness more than anything else on this page does. ffmpeg reports that average per
 * frame; a flash is a frame brighter than the ones around it.
 */
function flashTimes() {
  const report = join(out, "brightness.txt");
  execFileSync(
    "ffmpeg",
    // prettier-ignore
    ["-v", "error", "-i", video, "-vf", "scale=160:-2,signalstats,metadata=print:file=" + report,
      "-f", "null", "-"],
    { timeout: 900_000 },
  );
  const lines = readFileSync(report, "utf8").split("\n");
  const frames = [];
  let time;
  for (const line of lines) {
    const stamp = line.match(/^frame:\d+\s+pts:\d+\s+pts_time:([\d.]+)/);
    if (stamp) time = Number(stamp[1]);
    const average = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (average && time !== undefined) frames.push({ time, brightness: Number(average[1]) });
  }
  if (frames.length < 2) throw new Error("The video reported no frames to measure");
  const values = frames.map((frame) => frame.brightness).sort((a, b) => a - b);
  const ordinary = values[Math.floor(values.length * 0.5)];
  const brightest = values.at(-1);
  const lit = ordinary + (brightest - ordinary) * 0.5;
  const found = [];
  for (const [index, frame] of frames.entries()) {
    if (frame.brightness < lit) continue;
    if (index && frames[index - 1].brightness >= lit) continue;
    found.push(Math.round(frame.time * 1_000_000) + origins.video);
  }
  return found;
}

const clicks = clickTimes();
const flashes = flashTimes();

// ---- pairing ----------------------------------------------------------------------------------

const pairMs = Number(values.pairMs);
const claps = [];
for (const flash of flashes) {
  const click = clicks.find((value) => Math.abs(value - flash) <= pairMs * 1_000);
  if (click === undefined) continue;
  claps.push({
    flashUs: flash,
    clickUs: click,
    // Positive means the sound arrived after the picture.
    offsetMs: Number(((click - flash) / 1_000).toFixed(1)),
    atSeconds: Number((flash / 1_000_000).toFixed(2)),
  });
}
if (claps.length < 2)
  throw new Error(
    `Found ${flashes.length} flashes and ${clicks.length} clicks but paired ${claps.length}. ` +
      "Was the clapper running, with system audio on, for the whole take?",
  );

const offsets = claps.map((clap) => clap.offsetMs);
const drift = Math.max(...offsets) - Math.min(...offsets);
const first = offsets[0];
const last = offsets.at(-1);
const report = {
  recordingId,
  takeSeconds: Number(((recording.sourceDurationUs ?? 0) / 1_000_000).toFixed(2)),
  claps: claps.length,
  flashes: flashes.length,
  clicks: clicks.length,
  // What a browser and this Mac add between asking for a sound and hearing it. Constant across a
  // take, and not what any of this is about.
  offsetMs: { first, last, median: offsets.slice().sort((a, b) => a - b)[offsets.length >> 1] },
  // The measurement: how far the sound moved against the picture from one end to the other.
  driftMs: Number(drift.toFixed(1)),
  endToEndMs: Number((last - first).toFixed(1)),
  targetDriftMs: 50,
  meetsTarget: drift <= 50,
  pauses: recording.pauses ?? null,
  detail: claps,
};
writeFileSync(join(out, "av-sync.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    { ...report, detail: `${claps.length} claps, see ${join(out, "av-sync.json")}` },
    null,
    2,
  ),
);
process.exit(report.meetsTarget ? 0 : 1);
