import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeMusic } from "./music.mjs";

// 12 s of short 1 kHz clicks every 0.5 s (120 BPM), starting at 0.25 s, over a quiet 200 Hz bed.
function clickTrack() {
  const out = join(mkdtempSync(join(tmpdir(), "preset-music-")), "clicks.wav");
  const click = "if(lt(mod(t-0.25+10,0.5),0.03),0.8*sin(2*PI*1000*t),0)";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${click}+0.02*sin(2*PI*200*t)':s=22050:d=12`, out]);
  return out;
}

test("tempo and beat phase come from the onsets", async () => {
  const music = await analyzeMusic(clickTrack());
  assert.ok(Math.abs(music.tempoBpm - 120) <= 2, `${music.tempoBpm}`);
  assert.equal(music.tempoReliable, true, `pulse ${music.pulseStrength}`);
  const phase = (((music.beatOffsetSeconds - 0.25) % 0.5) + 0.5) % 0.5; // distance from the clicks, on the 0.5 s grid
  assert.ok(Math.min(phase, 0.5 - phase) < 0.05, `${music.beatOffsetSeconds}`);
});

test("cuts on the beat and cuts off it are told apart", async () => {
  const music = await analyzeMusic(clickTrack(), { cuts: [2.25, 4.75, 6.5, 9.0] });
  // 2.25 and 4.75 sit on beats; 6.5 and 9.0 fall halfway between.
  assert.equal(music.cutsOnBeat, 0.5);
});

test("the bed level is read from the gaps between speech", async () => {
  const words = [{ startUs: 0, endUs: 6_000_000 }];
  const music = await analyzeMusic(clickTrack(), { words });
  assert.ok(music.gapRmsDbfs != null && music.speechRmsDbfs != null);
  assert.equal(typeof music.bedBelowSpeechDb, "number");
});
