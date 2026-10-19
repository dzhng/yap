// What survives a take that never got to finish.
//
//   bun run lab:recovery [-- --out <directory>] [--microphone]
//
// Each run records this app's own fixture window and then ends it the way a crash would, at a
// different moment each time: before the writer has committed anything, while it is writing, after
// several fragments, while the take is paused, and in the middle of stopping. The app is started
// again after each one, and this reports what the next launch made of what was left — the state
// the take settled in, the duration it kept, and how much of what was recorded is gone.
//
// Every advertised interval is decoded, so nothing is reported as recovered on the strength of a
// file existing. `--microphone` narrates the takes through this Mac's default input and writes a
// clip from the end of each recovered take, which is the only way to judge whether a recovered
// tail ends where it claims to; without it no audio device is opened at all.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import {
  launchReady,
  requireScreenPermission,
  setDefault,
  socketPath,
  temporary,
  waitFor,
} from "./harness.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    microphone: { type: "boolean", default: false },
  },
});
const out = values.out ?? temporary("/tmp/yap-recovery-");
mkdirSync(out, { recursive: true });

requireScreenPermission();

function call(home, operation, params = {}) {
  return callLocal(
    socketPath(home),
    { id: randomUUID(), operation, params },
    { timeoutMs: 30_000 },
  );
}

async function succeeds(home, operation, params) {
  const answer = await call(home, operation, params);
  if (!answer.ok) throw new Error(`${operation}: ${JSON.stringify(answer.error)}`);
  return answer.data;
}

/** A launch of the packaged app showing its own window, which is all these takes ever record. */
async function app(home) {
  const domain = join(home, "scratch-preferences");
  setDefault(domain, "showSettingsAtLaunch", "-bool", "NO");
  setDefault(domain, "countdownBeforeRecording", "-bool", "NO");
  const { instance } = await launchReady(home, {
    YAP_DEFAULTS: domain,
    YAP_FIXTURE_WINDOW: "1",
  });
  const [, windowId] = await instance.waitFor(/capture fixture window=(\d+)/);
  return { instance, source: { kind: "window", id: Number(windowId) } };
}

const seconds = (us) => (us == null ? null : Number((us / 1_000_000).toFixed(3)));

/** What the container itself will decode, rather than what any record claims. */
function decoded(video) {
  if (!existsSync(video)) return { exists: false };
  try {
    const duration = execFileSync(
      "ffprobe",
      // prettier-ignore
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
      { encoding: "utf8" },
    ).trim();
    // Decoding every frame is what separates a playable prefix from a file that merely opens.
    execFileSync("ffmpeg", ["-v", "error", "-i", video, "-f", "null", "-"], { timeout: 120_000 });
    return { exists: true, decodesWholly: true, durationSeconds: Number(duration) };
  } catch (error) {
    return { exists: true, decodesWholly: false, error: String(error.message).slice(0, 200) };
  }
}

/**
 * The moments a take can be lost at. Each says how long to record first and what to do to the app;
 * `pausing` and `stopping` also act on the take through the service before the app dies.
 */
const moments = [
  {
    name: "before-first-fragment",
    recordMs: 150,
    expect: "nothing decodable yet, so the take must say so rather than claim a prefix",
  },
  { name: "while-writing", recordMs: 2_500, expect: "the fragments already written" },
  { name: "after-several-fragments", recordMs: 12_000, expect: "everything but the last fragment" },
  {
    name: "while-paused",
    recordMs: 4_000,
    pause: true,
    expect: "the media up to the pause, with the pause in the journal",
  },
  {
    name: "while-stopping",
    recordMs: 4_000,
    stopFirst: true,
    expect: "a finished take, or one recovered whole",
  },
];

const runs = [];
for (const moment of moments) {
  const home = temporary("/tmp/scr-recovery-");
  const first = await app(home);
  const started = await succeeds(home, "capture.start", {
    requestId: randomUUID(),
    source: first.source,
    microphone: values.microphone,
    systemAudio: false,
  });
  await delay(moment.recordMs);
  if (moment.pause) {
    await succeeds(home, "capture.pause", { recordingId: started.recordingId });
    await delay(500);
  }
  // A stop and a kill at the same moment: the take is between the order to finish and the
  // finished media, which is where a force quit at the end of a recording lands.
  const stopping = moment.stopFirst
    ? call(home, "capture.stop", { recordingId: started.recordingId }).catch(() => undefined)
    : undefined;
  first.instance.kill("SIGKILL");
  await first.instance.exited;
  await stopping;

  const source = join(home, "library", "recordings", started.recordingId, "source");
  const second = await app(home);
  const recovered = await waitFor(
    async () => {
      const facts = await succeeds(home, "recording.get", { recordingId: started.recordingId });
      return (
        ["complete", "interrupted", "canceled"].includes(facts.state) &&
        (facts.sourceDurationUs === null ||
          facts.sourceAdmissions.some((source) => source.kind === "primary")) &&
        facts
      );
    },
    20_000,
    () => "Recovered recording/source facts did not settle",
  );
  second.instance.kill("SIGTERM");
  await second.instance.exited;

  const video = decoded(join(source, "video.mov"));
  const narration = values.microphone ? decoded(join(source, "narration.mov")) : undefined;
  if (values.microphone && narration?.decodesWholly) {
    // The last two seconds of what was kept: a tail that stops mid-word is the failure this can
    // only be heard, not measured.
    const tail = join(out, `${moment.name}-tail.wav`);
    const from = Math.max(0, (narration.durationSeconds ?? 0) - 2);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      String(from),
      "-i",
      join(source, "narration.mov"),
      "-y",
      tail,
    ]);
  }
  runs.push({
    moment: moment.name,
    expected: moment.expect,
    recordedForSeconds: moment.recordMs / 1000,
    state: recovered.state,
    interruptionReason: recovered.interruptionReason,
    keptSeconds: seconds(recovered.sourceDurationUs),
    // What the take was recorded for, less what it kept: the window a person lost.
    lostSeconds: recovered.sourceDurationUs
      ? Number((moment.recordMs / 1000 - recovered.sourceDurationUs / 1_000_000).toFixed(3))
      : null,
    sourceAdmissions: recovered.sourceAdmissions,
    video,
    narration,
  });
  console.log(
    `${moment.name}: ${recovered.state}` +
      `${recovered.interruptionReason ? ` (${recovered.interruptionReason})` : ""}` +
      `, kept ${runs.at(-1).keptSeconds ?? "nothing"}s of ${moment.recordMs / 1000}s` +
      `, video ${video.decodesWholly ? "decodes whole" : video.exists ? "will not decode" : "absent"}`,
  );
}

const report = {
  at: new Date().toISOString(),
  microphone: values.microphone,
  runs,
  // A kill before anything was committed may honestly recover nothing; every other moment must
  // keep what it had, and nothing may be advertised that will not decode.
  everyAdvertisedPrefixDecodes: runs.every((run) => !run.keptSeconds || run.video.decodesWholly),
  // The loss a take takes is bounded by the fragment it was in the middle of writing. The target
  // is five seconds after the first committed checkpoint; a kill before that one may keep nothing,
  // which this counts separately rather than scoring as a five-second loss.
  worstLostSeconds: Math.max(...runs.map((run) => run.lostSeconds ?? 0)),
  lostEverything: runs.filter((run) => !run.keptSeconds).map((run) => run.moment),
  targetLostSeconds: 5,
};
report.meetsLossTarget = report.worstLostSeconds <= report.targetLostSeconds;
writeFileSync(join(out, "recovery.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `\nworst loss ${report.worstLostSeconds}s against a ${report.targetLostSeconds}s target` +
    `${report.lostEverything.length ? `; kept nothing at all: ${report.lostEverything.join(", ")}` : ""}`,
);
console.log(join(out, "recovery.json"));
if (values.microphone)
  console.log("Listen to the *-tail.wav clips: a recovered tail must not stop mid-word.");
process.exit(report.everyAdvertisedPrefixDecodes && report.meetsLossTarget ? 0 : 1);
