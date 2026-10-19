import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import {
  controlsProbe,
  launchReady,
  requireScreenPermission,
  setDefault,
  socketPath,
  temporary,
  waitFor,
} from "./harness.mjs";

/**
 * The count belongs to the display being recorded.
 *
 * On one screen that is the only display there is, so this says nothing; with two it is the whole
 * question. Each display is selected in turn and a start is begun, and the count has to appear on
 * the one that start would record. Nothing is ever recorded here: every start is abandoned while
 * the count is still on screen, which allocates no take at all.
 */
test("the count appears on the display a take would record", { timeout: 120_000 }, async (t) => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-countdown-display-");
  const domain = join(home, "scratch-preferences");
  setDefault(domain, "showSettingsAtLaunch", "-bool", "NO");
  const commands = join(home, "controls");
  mkdirSync(commands, { recursive: true });
  const { instance } = await launchReady(home, {
    YAP_DEFAULTS: domain,
    YAP_FIXTURE_CONTROLS: commands,
  });
  await instance.waitFor(/controls probe listening/);
  const send = controlsProbe(commands);
  const call = (operation, params = {}) =>
    callLocal(socketPath(home), { id: randomUUID(), operation, params }, { timeoutMs: 30_000 });

  const sources = await call("capture.sources");
  assert.equal(sources.ok, true, JSON.stringify(sources.error));
  const displays = sources.data.displays;
  if (displays.length < 2) {
    instance.kill("SIGTERM");
    await instance.exited;
    t.skip(
      `This Mac is showing ${displays.length} display, so which one the count lands on is not a question here`,
    );
    return;
  }

  try {
    for (const display of displays) {
      await send({ do: "open" });
      await send({ do: "choose", item: `source.display.${display.id}` });
      await waitFor(async () => {
        const rows = (await send({ do: "snapshot" })).rows;
        return rows.some((row) => row.title?.includes(display.name));
      }, 20_000);
      const before = instance.diagnostics.length;
      await send({ do: "choose", item: "capture.startOrStop" });
      const [, counted] = await waitFor(async () => {
        const said = instance.diagnostics.slice(before);
        return said.match(/countdown \d+ seconds on display (\d+)/);
      }, 20_000);
      assert.equal(
        Number(counted),
        display.id,
        `A take of ${display.name} (${display.id}) counted down on display ${counted}`,
      );
      t.diagnostic(`${display.name}: counted on display ${counted}`);
      // Abandoned while it counts, so nothing is ever recorded of either screen.
      await send({ do: "escape", window: "Yap Countdown" });
      await instance.waitFor(/countdown abandoned/);
    }
    const recordings = (await call("recording.list", { limit: 5 })).data;
    assert.deepEqual(recordings.recordings, [], "An abandoned count allocates no take at all");
  } finally {
    instance.kill("SIGTERM");
    await instance.exited;
  }
});
