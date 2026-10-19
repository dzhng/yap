import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { controlsProbe, launchReady, setDefault, temporary, waitFor } from "./harness.mjs";

const countdownWindow = "Yap Countdown";
const controlsWindow = "Yap Controls";
const captureWindow = "Yap Capture";

/**
 * An ordinary launch of the packaged app, observed and driven through its controls probe. Such a
 * launch orders every window and panel it opens in behind everything and never activates the app,
 * so nothing here appears over whoever is at the Mac.
 */
async function launchWith(preferences = [], environment = {}) {
  const home = temporary("/tmp/scr-overlays-");
  const domain = join(home, "scratch-preferences");
  setDefault(domain, "showSettingsAtLaunch", "-bool", "NO");
  for (const [key, ...value] of preferences) setDefault(domain, key, ...value);
  const commands = join(home, "controls");
  mkdirSync(commands, { recursive: true });
  const { instance } = await launchReady(home, {
    YAP_DEFAULTS: domain,
    YAP_FIXTURE_CONTROLS: commands,
    ...environment,
  });
  await instance.waitFor(/controls probe listening/);
  const send = controlsProbe(commands);
  return {
    home,
    instance,
    send,
    rows: async () => (await send({ do: "snapshot" })).rows,
    /** What this app says it is doing, or nothing at all while it sits idle. */
    working: async () => {
      const { status } = await send({ do: "snapshot" });
      return status === "Idle" ? "" : status;
    },
    /** Opens capture until a source is chosen and Start would record it. */
    ready: async () => {
      await waitFor(async () => {
        await send({ do: "open" });
        return find((await send({ do: "snapshot" })).rows, "capture.startOrStop")?.enabled;
      }, 20_000);
    },
    window: async (title) => (await send({ do: "windows" })).windows.find((w) => w.title === title),
    active: async () => (await send({ do: "windows" })).active,
    /** Chooses the row a person would choose, by what that row does. */
    choose: async (item) => {
      const answer = await send({ do: "choose", item });
      assert.equal(answer.ok, true, `${item}: ${answer.error}`);
    },
  };
}

/** One row anywhere in the menu, by what it does. */
function find(rows, item) {
  for (const row of rows) {
    if (row.item === item) return row;
    const nested = row.submenu && find(row.submenu, item);
    if (nested) return nested;
  }
  return undefined;
}

function takes(home) {
  const recordings = join(home, "library", "recordings");
  return existsSync(recordings) ? readdirSync(recordings) : [];
}

test(
  "Escape during the countdown abandons the start and allocates no recording",
  { timeout: 90_000 },
  async () => {
    const app = await launchWith();
    // A display is selected but never recorded: the count is abandoned before capture is asked for.
    await app.ready();
    await app.choose("capture.startOrStop");

    const [, seconds] = await app.instance.waitFor(/countdown (\d+) seconds on display/);
    assert.equal(seconds, "3", "A start counts three seconds down before it records");
    assert.match(
      app.instance.diagnostics,
      /countdown 3 seconds on display .*escape abandons it/,
      "The count holds Escape while it is on screen",
    );
    const counting = await waitFor(
      async () => (await app.window(countdownWindow))?.visible,
      10_000,
    );
    assert.equal(counting, true);
    assert.equal(await app.active(), false, "Counting down never activates this app");

    await app.send({ do: "escape", window: countdownWindow });
    await app.instance.waitFor(/countdown abandoned/);
    assert.notEqual(
      (await app.window(countdownWindow))?.visible,
      true,
      "The count leaves nothing on screen",
    );
    assert.deepEqual(takes(app.home), [], "An abandoned count allocates no take at all");
    assert.equal(await app.working(), "", "Nothing is recording after an abandoned count");
    assert.doesNotMatch(app.instance.diagnostics, /countdown finished/);

    app.instance.kill("SIGTERM");
    await app.instance.exited;
  },
);

test(
  "the menu offers to cancel the count it is running, and does",
  { timeout: 90_000 },
  async () => {
    const app = await launchWith();
    await app.ready();
    assert.equal((await app.window(captureWindow))?.visible, true);
    await app.choose("capture.startOrStop");
    await app.instance.waitFor(/countdown \d+ seconds on display/);
    // The menu hangs from the menu bar, right where the count and then the controls appear.
    assert.notEqual(
      (await app.window(captureWindow))?.visible,
      true,
      "Starting puts the menu away",
    );

    // Escape is not the only way out: a person who reaches for the menu bar instead must find a
    // row that says what pressing it will do, rather than Start doing nothing.
    const counting = find(await app.rows(), "capture.startOrStop");
    assert.equal(counting.title, "Cancel Countdown");
    assert.equal(counting.enabled, true);
    await app.choose("capture.startOrStop");
    await app.instance.waitFor(/countdown abandoned/);
    assert.deepEqual(takes(app.home), [], "An abandoned count allocates no take at all");
    assert.equal(
      find(await app.rows(), "capture.startOrStop").title,
      "Start recording",
      "Once the count is gone the row offers to start again",
    );

    app.instance.kill("SIGTERM");
    await app.instance.exited;
  },
);

test(
  "with the countdown off a take starts at once and carries floating controls until it ends",
  { timeout: 90_000 },
  async () => {
    const app = await launchWith([["countdownBeforeRecording", "-bool", "NO"]], {
      YAP_FIXTURE_WINDOW: "1",
    });
    // Every take here records this app's own fixture window with no audio device of any kind.
    const [, windowId] = await app.instance.waitFor(/capture fixture window=(\d+)/);
    // Opening capture refreshes sources; the Window tile exposes its native source chooser.
    await waitFor(async () => {
      await app.send({ do: "open" });
      await app.send({ do: "choose", item: "source.window" });
      return Boolean(find(await app.rows(), `source.window.${windowId}`));
    }, 20_000);
    await app.choose(`source.window.${windowId}`);
    // The microphone switch starts on; turning it off records no audio device of any kind.
    await app.choose("microphone.toggle");
    assert.equal(find(await app.rows(), "microphone.toggle").checked, false);
    assert.notEqual(
      (await app.window(controlsWindow))?.visible,
      true,
      "An idle app floats no controls",
    );

    assert.equal((await app.window(captureWindow))?.visible, true);
    await app.choose("capture.startOrStop");
    await waitFor(async () => (await app.working()).startsWith("Recording —"), 20_000);
    assert.notEqual(
      (await app.window(captureWindow))?.visible,
      true,
      "Starting puts the menu away, so it never covers the floating controls",
    );
    assert.doesNotMatch(
      app.instance.diagnostics,
      /countdown/,
      "With the countdown off, a start records immediately and shows no count",
    );
    const recording = await waitFor(async () => app.window(controlsWindow), 10_000);
    assert.equal(recording.visible, true);
    assert.ok(recording.width > 0 && recording.height > 0, JSON.stringify(recording));
    assert.match(app.instance.diagnostics, /recording overlay display=\d+ rect=\d+,\d+,\d+,\d+/);

    await app.choose("capture.pauseOrResume");
    await waitFor(async () => (await app.working()).startsWith("Paused —"), 20_000);
    assert.equal(
      (await app.window(controlsWindow))?.visible,
      true,
      "A paused take keeps its controls, or it cannot be resumed from them",
    );

    await app.choose("capture.cancel");
    // A take that ended leaves no controls floating over anyone's screen.
    await waitFor(async () => (await app.window(controlsWindow))?.visible !== true, 20_000);
    assert.doesNotMatch(await app.working(), /^(Recording|Paused) —/);

    app.instance.kill("SIGTERM");
    await app.instance.exited;
  },
);
