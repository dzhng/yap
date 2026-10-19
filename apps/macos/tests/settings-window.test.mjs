import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { controlsProbe, launchReady, setDefault, temporary, waitFor } from "./harness.mjs";

const title = "Yap Settings";

/**
 * An ordinary launch of the packaged app with its own scratch defaults domain, observed through the
 * controls probe. Nothing here requests a permission or records.
 */
async function launchWith(preferences = []) {
  const home = temporary("/tmp/scr-settings-");
  const domain = join(home, "scratch-preferences");
  for (const [key, ...value] of preferences) setDefault(domain, key, ...value);
  const commands = join(home, "controls");
  mkdirSync(commands, { recursive: true });
  const { instance } = await launchReady(home, {
    YAP_DEFAULTS: domain,
    YAP_FIXTURE_CONTROLS: commands,
  });
  await instance.waitFor(/controls probe listening/);
  const send = controlsProbe(commands);
  const settings = async () =>
    (await send({ do: "windows" })).windows.find((window) => window.title === title);
  return { home, instance, send, settings };
}

function find(rows, item) {
  for (const row of rows) {
    if (row.item === item) return row;
    const nested = row.submenu && find(row.submenu, item);
    if (nested) return nested;
  }
  return undefined;
}

test("Settings opens at launch by default", { timeout: 60_000 }, async () => {
  const { instance, settings } = await launchWith();
  const window = await waitFor(async () => (await settings())?.visible && settings(), 20_000);
  assert.equal(window.title, title);
  assert.ok(window.number > 0 && window.width > 0 && window.height > 0, JSON.stringify(window));
  instance.kill("SIGTERM");
  await instance.exited;
});

test(
  "Settings stays closed once turned off, opens from the gear, and capture restores saved choices",
  { timeout: 60_000 },
  async () => {
    const { instance, send, settings } = await launchWith([
      ["showSettingsAtLaunch", "-bool", "NO"],
      ["recording.microphone", "off"],
      ["recording.systemAudio", "-bool", "YES"],
    ]);
    await send({ do: "open" });
    const rows = (await send({ do: "snapshot" })).rows;
    assert.notEqual((await settings())?.visible, true, "no Settings window at launch");

    const item = find(rows, "header.settings");
    assert.equal(item.enabled, true, "Settings gear remains available");
    assert.equal(find(rows, "microphone.toggle").checked, false, "saved microphone choice");
    assert.equal(find(rows, "audio.system").checked, true, "saved system audio choice");

    assert.equal((await send({ do: "choose", item: "header.settings" })).ok, true);
    const opened = await waitFor(async () => (await settings())?.visible && settings(), 20_000);
    assert.equal(opened.title, title);
    instance.kill("SIGTERM");
    await instance.exited;
  },
);

test("shortcut fields apply a live binding and refuse a duplicate in Yap", { timeout: 60_000 }, async () => {
  const { home, instance } = await launchWith();
  const socket = join(home, "run", "app.sock");
  await waitFor(() => existsSync(socket), 20_000);
  const rebound = await callLocal(socket, {
    id: "settings-rebind",
    operation: "shortcuts.set",
    params: {
      bindings: { "capture.startOrStop": { keyCode: 2, modifiers: 2560, label: "⌥⇧D" } },
    },
  });
  assert.equal(rebound.ok, true, JSON.stringify(rebound));
  assert.equal(rebound.data.bindings["capture.startOrStop"].label, "⌥⇧D");

  const duplicate = await callLocal(socket, {
    id: "settings-duplicate",
    operation: "shortcuts.set",
    params: {
      bindings: { "capture.startOrStop": { keyCode: 9, modifiers: 2560, label: "⌥⇧V" } },
    },
  });
  assert.equal(duplicate.ok, false, JSON.stringify(duplicate));
  assert.equal(duplicate.error.code, "DUPLICATE_SHORTCUT");
  instance.kill("SIGTERM");
  await instance.exited;
});
