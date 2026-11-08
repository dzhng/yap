import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import {
  controlsProbe,
  launchReady,
  socketPath,
  temporary,
  waitFor,
  requireScreenPermission,
} from "./harness.mjs";

/**
 * Capture-view observations while public service calls control the own-window fixture.
 * Every take here records this app's own capture-fixture window with the microphone and system
 * audio explicitly off; no other window, display or audio device is ever selected.
 */
/** Ordinary app launch with an own-window fixture and capture-view observations. */
async function controlledApp(home) {
  const commands = join(home, "controls");
  mkdirSync(commands, { recursive: true });
  const { instance } = await launchReady(home, {
    YAP_FIXTURE_WINDOW: "1",
    YAP_FIXTURE_CONTROLS: commands,
  });
  const [, windowId] = await instance.waitFor(/capture fixture window=(\d+)/);
  await instance.waitFor(/controls probe listening/);
  const send = controlsProbe(commands);
  const controls = { instance, windowId: Number(windowId), send };
  // Opening capture refreshes sources; the Window tile exposes its native source chooser.
  await waitFor(async () => {
    await send({ do: "open" });
    await send({ do: "choose", item: "source.window" });
    return Boolean(find((await send({ do: "snapshot" })).rows, `source.window.${windowId}`));
  }, 20_000);
  return controls;
}

function find(rows, item) {
  for (const row of rows) {
    if (row.item === item) return row;
    const nested = row.submenu && find(row.submenu, item);
    if (nested) return nested;
  }
  return undefined;
}

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

test("external controls update capture with actual source, audio and clock", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-controls-external-");
  const controls = await controlledApp(home);
  const windowId = controls.windowId;
  const started = await succeeds(home, "capture.start", {
    requestId: randomUUID(),
    source: { kind: "window", id: windowId },
    microphone: false,
    systemAudio: false,
  });
  // Snapshot reads the current native view without requesting another source refresh.
  const snapshot = () => controls.send({ do: "snapshot" });
  await waitFor(async () => (await snapshot()).status.startsWith("Recording —"), 20_000);
  const seconds = (title) => {
    const parts = title.split(" — ")[1].split(":").map(Number);
    return parts.reduce((value, part) => value * 60 + part, 0);
  };
  await waitFor(async () => seconds((await snapshot()).status) >= 1, 20_000);
  const active = (await snapshot()).rows;
  assert.equal(find(active, `source.window.${windowId}`).checked, true);
  assert.equal(find(active, "microphone.toggle").checked, false);
  assert.equal(find(active, "audio.system").checked, false);
  for (const item of ["source.device", "microphone.toggle", "audio.system"]) {
    assert.equal(find(active, item).enabled, false, `${item} stays fixed during the take`);
  }
  await succeeds(home, "capture.pause", { recordingId: started.id });
  await waitFor(async () => (await snapshot()).status.startsWith("Paused —"), 20_000);
  const paused = (await snapshot()).status;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await snapshot()).status, paused);
  await succeeds(home, "capture.resume", { recordingId: started.id });
  await waitFor(async () => (await snapshot()).status.startsWith("Recording —"), 20_000);
  await waitFor(async () => seconds((await snapshot()).status) > seconds(paused), 20_000);
  await succeeds(home, "capture.stop", { recordingId: started.id });
  // A finished take returns the native start control to its idle action.
  await waitFor(
    async () => find((await snapshot()).rows, "capture.startOrStop").title === "Start recording",
    20_000,
  );
});

test("a take the person finishes hands its whole prompt to the clipboard with the notice", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-controls-prompt-");
  const controls = await controlledApp(home);
  const snapshot = () => controls.send({ do: "snapshot" });
  const clipboard = async () => (await controls.send({ do: "pasteboard" })).text;
  const take = async (stop) => {
    const started = await succeeds(home, "capture.start", {
      requestId: randomUUID(),
      source: { kind: "window", id: controls.windowId },
      microphone: false,
      systemAudio: false,
    });
    await waitFor(async () => /^Recording — 0:0[1-9]/.test((await snapshot()).status), 20_000);
    await stop(started.id);
    await waitFor(
      async () =>
        (await succeeds(home, "recording.get", { recordingId: started.id })).state === "complete",
      30_000,
    );
    return started.id;
  };

  // An agent that stops a take through the service already has it; the clipboard stays theirs.
  await take((recordingId) => succeeds(home, "capture.stop", { recordingId }));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await clipboard(), null);

  // Stopped from the menu, the take's prompt arrives once it is whole, with the notice up.
  const finished = await take(async () => {
    await controls.send({ do: "open" });
    assert.equal((await controls.send({ do: "choose", item: "capture.startOrStop" })).ok, true);
  });
  await waitFor(async () => (await clipboard())?.includes(finished), 20_000);
  const text = await clipboard();
  assert.match(text, /^I recorded my screen/);
  assert.match(text, new RegExp(`Recording: ${finished} \\(0:0\\d, screen`));
  const notice = (await controls.send({ do: "windows" })).windows.find(
    (window) => window.title === "Yap Paste Notice",
  );
  assert.equal(notice?.visible, true);
});
