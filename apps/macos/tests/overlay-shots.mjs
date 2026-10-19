import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { controlsProbe, launchReady, setDefault, temporary, waitFor } from "./harness.mjs";

/**
 * Writes the review copies of the two panels a take puts on screen, into
 * `specs/done/recording-for-ai/assets/recording-overlay` unless `SHOTS` names somewhere else.
 *
 *     MODE=controls|countdown APPEARANCE=light|dark node apps/macos/tests/overlay-shots.mjs
 *
 * Each picture is the panel's own drawing, so nothing is photographed off the screen: the launch
 * records this app's own fixture window, never activates the app, and orders every panel it opens
 * in behind whatever the person at the Mac is doing.
 */
const out =
  process.env.SHOTS ??
  join(import.meta.dirname, "../../../specs/done/recording-for-ai/assets/recording-overlay");
mkdirSync(out, { recursive: true });
const appearance = process.env.APPEARANCE ?? "light";
const mode = process.env.MODE ?? "controls";
const countdownWindow = "Yap Countdown";
const controlsWindow = "Yap Controls";

function find(rows, item) {
  for (const row of rows) {
    if (row.item === item) return row;
    const nested = row.submenu && find(row.submenu, item);
    if (nested) return nested;
  }
  return undefined;
}

const home = temporary("/tmp/scr-shots-");
const domain = join(home, "scratch-preferences");
setDefault(domain, "showSettingsAtLaunch", "-bool", "NO");
setDefault(domain, "countdownBeforeRecording", "-bool", mode === "countdown" ? "YES" : "NO");
const commands = join(home, "controls");
mkdirSync(commands, { recursive: true });
const { instance } = await launchReady(home, {
  YAP_DEFAULTS: domain,
  YAP_FIXTURE_CONTROLS: commands,
  YAP_FIXTURE_WINDOW: "1",
});
await instance.waitFor(/controls probe listening/);
const [, windowId] = await instance.waitFor(/capture fixture window=(\d+)/);
const send = controlsProbe(commands);
await send({ do: "appearance", value: appearance });
// Opening capture refreshes sources; the Window tile exposes its native source chooser.
await waitFor(async () => {
  await send({ do: "open" });
  await send({ do: "choose", item: "source.window" });
  return Boolean(find((await send({ do: "snapshot" })).rows, `source.window.${windowId}`));
}, 20_000);
await send({ do: "choose", item: `source.window.${windowId}` });
// The fixture lists no microphone, so its switch is off and the take records no audio device.

const status = async () => (await send({ do: "snapshot" })).status;
const shoot = async (title, name) => {
  await waitFor(
    async () => (await send({ do: "windows" })).windows.some((w) => w.title === title && w.visible),
    10_000,
  );
  const path = join(out, `${name}.png`);
  const shot = await send({ do: "shot", window: title, path });
  if (!shot.ok) throw new Error(`${name}: ${shot.error}`);
  console.log(`${path} ${shot.width}×${shot.height}`);
};

await send({ do: "choose", item: "capture.startOrStop" });
if (mode === "countdown") {
  await delay(300);
  await shoot(countdownWindow, `${appearance}-countdown-three`);
  await delay(1000);
  await shoot(countdownWindow, `${appearance}-countdown-two`);
  await send({ do: "escape", window: countdownWindow });
  await instance.waitFor(/countdown abandoned/);
} else {
  // Both states are caught at the same point on the clock, so the pair compares.
  await waitFor(async () => (await status()) === "Recording — 0:02", 20_000);
  await shoot(controlsWindow, `${appearance}-recording`);
  await send({ do: "choose", item: "capture.pauseOrResume" });
  await waitFor(async () => (await status()).startsWith("Paused —"), 20_000);
  await shoot(controlsWindow, `${appearance}-paused`);
  await send({ do: "choose", item: "capture.cancel" });
  await delay(1000);
}
instance.kill("SIGTERM");
await instance.exited;
process.exit(0);
