import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureVideo } from "./measure.mjs";

// Three 2 s shots (dark grey, mid grey with a red cast, bright cream) over a −20 dBFS sine,
// so cuts, luma, saturation and loudness each have a known answer.
function synthetic() {
  const dir = mkdtempSync(join(tmpdir(), "preset-measure-"));
  const out = join(dir, "three-shots.mp4");
  const shot = (color) => `color=c=${color}:s=320x180:r=24:d=2`;
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", shot("0x202020"),
    "-f", "lavfi", "-i", shot("0x904040"),
    "-f", "lavfi", "-i", shot("0xF4EEDC"),
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6,volume=0.1",
    "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out,
  ]);
  return out;
}

test("a profile finds every cut and the shots between them", async () => {
  const profile = await measureVideo(synthetic(), { sampleEverySeconds: 0.5 });
  assert.equal(profile.video.width, 320);
  assert.ok(Math.abs(profile.durationSeconds - 6) < 0.1);
  assert.deepEqual(profile.cuts.map((t) => Math.round(t)), [2, 4]);
  assert.equal(profile.shots.count, 3);
  assert.ok(Math.abs(profile.shots.medianSeconds - 2) < 0.1);
});

test("a profile reports picture and sound levels a grade or mix can be judged against", async () => {
  const profile = await measureVideo(synthetic(), { sampleEverySeconds: 0.5 });
  const [dark, red, cream] = [0.5, 2.5, 4.5].map((t) => profile.picture.samples.find((s) => s.t === t));
  assert.ok(dark.yavg < 50 && cream.yavg > 200, "luma follows each shot");
  assert.ok(red.satavg > dark.satavg && red.satavg > cream.satavg, "saturation follows each shot");
  assert.ok(profile.palette.length >= 3, "palette lists each flat colour");
  // ffmpeg's sine source has amplitude 1/8; ×0.1 gives a 0.0125 peak. A 440 Hz tone is
  // unweighted by K-weighting, so loudness = −0.691 + 10·log10(0.0125²/2) ≈ −41.8 LUFS.
  const expected = -0.691 + 10 * Math.log10(0.0125 ** 2 / 2);
  assert.ok(Math.abs(profile.loudness.integratedLufs - expected) < 1, `${profile.loudness.integratedLufs}`);
  assert.ok(profile.loudness.momentary.length >= 5, "one loudness reading per second");
});

test("10-bit footage measures on the same 0–255 scale as 8-bit footage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preset-measure-10bit-"));
  const tenBit = join(dir, "grey.mov");
  const eightBit = join(dir, "grey.mp4");
  const grey = ["-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=24:d=1"];
  execFileSync("ffmpeg", ["-v", "error", "-y", ...grey, "-c:v", "prores_ks", "-pix_fmt", "yuv422p10le", tenBit]);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...grey, "-c:v", "libx264", "-pix_fmt", "yuv420p", eightBit]);
  const [ten, eight] = await Promise.all([tenBit, eightBit].map((path) => measureVideo(path, { sampleEverySeconds: 0.5 })));
  assert.ok(ten.picture.yavg <= 255, `10-bit luma ${ten.picture.yavg} is off the 8-bit scale`);
  assert.ok(Math.abs(ten.picture.yavg - eight.picture.yavg) < 3, `${ten.picture.yavg} vs ${eight.picture.yavg}`);
});
