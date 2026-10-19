import { finishCapture } from "./harness.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import {
  launchReady,
  requireScreenPermission,
  setDefault,
  socketPath,
  temporary,
} from "./harness.mjs";

/**
 * A take of a whole display must not record the recorder. This records the display twice, with the
 * floating controls left in a different place each time, and reads the frames back: if those
 * controls were in the take, the part of the picture each one covered would differ completely
 * between the two. It runs once as shipped, with no capture seeing the controls, and once with
 * screenshots allowed to see them, which must not let them into the take. Every take here is a few seconds long and lives in a scratch home the harness
 * deletes; nothing is activated and nothing is clicked.
 */
const seconds = 2.5;
/** Where the controls are left for each take, in screen points, far enough apart not to overlap. */
const origins = ["{48, 132}", "{48, 432}"];

function call(home, operation, params = {}) {
  return callLocal(
    socketPath(home),
    { id: randomUUID(), operation, params },
    { timeoutMs: 30_000 },
  );
}

async function succeeds(home, operation, params) {
  const answer = await call(home, operation, params);
  assert.equal(answer.ok, true, `${operation}: ${JSON.stringify(answer.error)}`);
  return answer.data;
}

/** One take of a whole display, with this app's own floating controls on screen throughout. */
async function displayTake(origin) {
  const home = temporary("/tmp/scr-exclusion-");
  const domain = join(home, "scratch-preferences");
  setDefault(domain, "showSettingsAtLaunch", "-bool", "NO");
  // The count is off so the take starts at once, and the controls go where this take wants them.
  setDefault(domain, "countdownBeforeRecording", "-bool", "NO");
  setDefault(domain, "overlayOrigin", "-string", origin);
  const { instance } = await launchReady(home, { YAP_DEFAULTS: domain });
  const sources = await succeeds(home, "capture.sources");
  const display = sources.displays[0];
  const started = await succeeds(home, "capture.start", {
    requestId: randomUUID(),
    source: { kind: "display", id: display.id },
    microphone: false,
    systemAudio: false,
  });
  const [, onDisplay, x, y, width, height] = await instance.waitFor(
    /recording overlay display=(\d+) rect=(\d+),(\d+),(\d+),(\d+)/,
  );
  assert.equal(
    Number(onDisplay),
    display.id,
    "The controls have to be on the display this take records, or this proves nothing",
  );
  await delay(seconds * 1000);
  await finishCapture((op, params) => succeeds(home, op, params), started.id);
  instance.kill("SIGTERM");
  await instance.exited;
  return {
    video: join(home, "library", "recordings", started.id, "source", "video.mov"),
    display,
    controls: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
  };
}

/** One decoded frame from near the end of a take, as plain RGB. */
function frame(video) {
  const size = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      video,
    ],
    { encoding: "utf8", timeout: 30_000 },
  )
    .trim()
    .split(",")
    .map(Number);
  const pixels = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-sseof",
      "-0.5",
      "-i",
      video,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const [width, height] = size;
  assert.equal(pixels.length, width * height * 3, `decoded ${width}×${height} frame`);
  return { pixels, width, height };
}

/** How far apart two frames are, per colour channel, inside one rectangle of the picture. */
function difference(first, second, rect) {
  let total = 0;
  let counted = 0;
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      const at = (y * first.width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        total += Math.abs(first.pixels[at + channel] - second.pixels[at + channel]);
        counted += 1;
      }
    }
  }
  return counted === 0 ? 0 : total / counted;
}

test(
  "a display take leaves out this app's own floating controls",
  { timeout: 180_000 },
  async (t) => {
    requireScreenPermission();
    const takes = [];
    for (const origin of origins) takes.push(await displayTake(origin));
    const frames = takes.map((take) => frame(take.video));
    assert.equal(frames[0].width, frames[1].width);
    assert.equal(frames[0].height, frames[1].height);
    assert.notDeepEqual(
      takes[0].controls,
      takes[1].controls,
      "The two takes must have had the controls in different places",
    );

    // The take is the display scaled to the recorded picture, so a rectangle of screen points
    // becomes the same rectangle of frame pixels.
    const scale = frames[0].width / takes[0].display.width;
    // That only holds while a display take is the whole display at its own pixels: the source
    // this app offers and the picture it records have to be the same rectangle.
    assert.ok(
      Number.isInteger(scale) && scale >= 1,
      `A display take must not rescale it, got ${scale}x`,
    );
    assert.equal(
      frames[0].height,
      takes[0].display.height * scale,
      "A display take must keep the display's shape",
    );
    const whole = { left: 0, top: 0, right: frames[0].width, bottom: frames[0].height };
    const between = difference(frames[0], frames[1], whole);
    // This compares how much the picture changed where the controls were against how much it
    // changed everywhere, so it only means something while the screen behind them is reasonably
    // still. On a desktop with a video or a scrolling terminal on it, everything differs by more
    // than a leaked overlay would, and the comparison would pass while proving nothing.
    if (between > 8) {
      t.skip(
        `The screen was changing too much between takes to prove anything: ${between.toFixed(2)} ` +
          "mean difference across the whole picture",
      );
      return;
    }
    for (const [index, take] of takes.entries()) {
      const { x, y, width, height } = take.controls;
      const rect = {
        left: Math.max(0, Math.floor(x * scale)),
        top: Math.max(0, Math.floor(y * scale)),
        right: Math.min(frames[0].width, Math.ceil((x + width) * scale)),
        bottom: Math.min(frames[0].height, Math.ceil((y + height) * scale)),
      };
      assert.ok(rect.right > rect.left && rect.bottom > rect.top, JSON.stringify(rect));
      const covered = difference(frames[0], frames[1], rect);
      t.diagnostic(
        `controls ${index} at ${x},${y} ${width}×${height}: ${covered.toFixed(2)} difference there, ` +
          `${between.toFixed(2)} across the whole picture`,
      );
      // Where the controls sat in one take and not the other, the two takes differ no more than
      // the screen as a whole does: the controls were never in either recording.
      assert.ok(
        covered < between + 3,
        `The floating controls appear in the take: ${covered.toFixed(2)} difference where they were, ` +
          `against ${between.toFixed(2)} across the whole picture`,
      );
    }
  },
);
