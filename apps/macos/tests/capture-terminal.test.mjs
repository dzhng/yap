import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import { alive, launchReady, socketPath, temporary, waitFor } from "./harness.mjs";

const peer = fileURLToPath(new URL("./fixtures/terminal-peer.mjs", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** A fixture service that holds the app's first finalizing report and answers every other one. */
async function heldReportApp(home) {
  const interpreter = join(home, "node");
  writeFileSync(
    interpreter,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${quote(process.execPath)} --version; fi\nexec ${quote(process.execPath)} ${quote(peer)}\n`,
  );
  chmodSync(interpreter, 0o755);
  const launched = await launchReady(home, {
    YAP_NODE: interpreter,
    YAP_FIXTURE_WINDOW: "1",
  });
  const [, fixtureId] = await launched.instance.waitFor(/capture fixture window=(\d+)/);
  const call = (operation, params = {}) =>
    callLocal(socketPath(home), { id: randomUUID(), operation, params }, { timeoutMs: 25_000 });
  const native = (operation, params = {}) => call("peer.native", { operation, params });
  const take = (name) => ({
    source: { kind: "window", id: Number(fixtureId) },
    microphone: false,
    systemAudio: false,
    recordingId: randomUUID(),
    sourceId: randomUUID(),
    outputDirectory: join(home, name),
  });
  return { ...launched, call, native, take };
}

// The fake service can delay the app's finalizing report while sending a second native call.
// This reaches the actual Controller await point without adding a production test hook.
test(
  "cancel before publication joins finalization and releases only its own take",
  { timeout: 45_000 },
  async () => {
    const home = temporary("/tmp/scr-native-terminal-");
    const { instance, servicePid, call, native, take } = await heldReportApp(home);
    const first = take("first");
    const second = take("second");
    const started = await native("capture.start", first);
    assert.equal(started.ok, true, JSON.stringify(started));
    await delay(250);
    const stopping = native("capture.stop", { recordingId: first.recordingId }).catch((error) => ({
      ok: false,
      error,
    }));
    await waitFor(async () => (await call("peer.status")).data.held, 5_000);
    const canceling = native("capture.cancel", { recordingId: first.recordingId }).catch(
      (error) => ({ ok: false, error }),
    );
    await waitFor(
      async () => (await call("peer.status")).data.pending.includes("capture.cancel"),
      5_000,
    );
    const held = await native("capture.status");
    assert.equal(held.ok, true);
    assert.equal(
      held.data.state,
      "recording",
      "A joined cancel cannot discard while its owner's finalizing report is held",
    );
    assert.equal(held.data.recordingId, first.recordingId);
    const premature = await native("capture.start", second);
    assert.equal(premature.ok, false);
    assert.equal(premature.error.code, "INVALID_STATE");
    await call("peer.release");
    const [stopped, canceled] = await Promise.all([stopping, canceling]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(canceled.ok, true, JSON.stringify(canceled));
    assert.equal(stopped.data.state, "finalizing");
    // Native acknowledges discard with its finalizing event; the service owns canceled state
    // and donor removal. The joined native call must already have released the device.
    assert.equal(canceled.data.state, "finalizing");
    assert.equal(canceled.data.recordingId, stopped.data.recordingId);
    assert.equal(stopped.data.recordingId, first.recordingId);
    assert.equal(stopped.data.sourceId, first.sourceId);
    assert.equal(canceled.data.sourceId, first.sourceId);
    const idle = await native("capture.status");
    assert.equal(idle.ok, true, JSON.stringify(idle));
    assert.equal(idle.data.state, "idle");
    assert.equal(idle.data.recordingId, null);
    assert.equal(idle.data.sourceId, null);
    const firstJournal = join(first.outputDirectory, "capture.journal.jsonl");
    const finalized = readFileSync(firstJournal);
    const replacement = await native("capture.start", second);
    assert.equal(replacement.ok, true, JSON.stringify(replacement));
    await delay(250);
    const running = await native("capture.status");
    assert.equal(running.data.recordingId, second.recordingId);
    assert.equal(running.data.sourceId, second.sourceId);
    assert.equal(running.data.state, "recording");
    assert.deepEqual(
      readFileSync(firstJournal),
      finalized,
      "Old terminal work cannot append after a replacement starts",
    );
    const replacementStopped = await native("capture.stop", { recordingId: second.recordingId });
    assert.equal(replacementStopped.ok, true, JSON.stringify(replacementStopped));
    instance.kill("SIGTERM");
    await instance.exited;
    assert.equal(alive(servicePid), false);
  },
);

test(
  "a quit whose finalizing report goes unanswered still finalizes the take",
  { timeout: 60_000 },
  async () => {
    const home = temporary("/tmp/scr-native-quit-");
    const { instance, native, take } = await heldReportApp(home);
    const quitting = take("quitting");
    const started = await native("capture.start", quitting);
    assert.equal(started.ok, true, JSON.stringify(started));
    await delay(500);
    // The report waits out its own call deadline; the quit must outlast it and still close the
    // writer rather than leave the take for the next launch to recover.
    instance.kill("SIGTERM");
    assert.deepEqual(await instance.exited, { code: 0, signal: null });
    const events = readFileSync(join(quitting.outputDirectory, "capture.journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    assert.ok(events.includes("finished"), `Quit left the take unfinished: ${events.join(", ")}`);
  },
);
