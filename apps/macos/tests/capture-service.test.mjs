import { finishCapture } from "./harness.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import {
  alive,
  launchReady,
  socketPath,
  temporary,
  waitFor,
  requireScreenPermission,
} from "./harness.mjs";

/**
 * Capture through the real app, service and local client. Every take records this app's own
 * fixture window with microphone and system audio off; no other window, display or device is
 * ever selected, and no permission is requested here.
 */
function call(home, operation, params = {}) {
  return callLocal(
    socketPath(home),
    { id: randomUUID(), operation, params },
    { timeoutMs: 30_000 },
  );
}

/**
 * What every take in this file asks for: this app's own fixture window, with the microphone and
 * system audio explicitly refused. No test here relies on a schema default for either, and the
 * app refuses a fixture take that asks for either one, so no check can reach a real audio device.
 */
function silent(requestId, source, extra = {}) {
  return { requestId, source, microphone: false, systemAudio: false, ...extra };
}

async function succeeds(home, operation, params) {
  const answer = await call(home, operation, params);
  assert.equal(answer.ok, true, `${operation}: ${JSON.stringify(answer.error)}`);
  return answer.data;
}

/** An ordinary launch that also opens this app's own window and exposes only that window. */
async function fixtureApp(home, environment = {}) {
  const { instance, servicePid } = await launchReady(home, {
    YAP_FIXTURE_WINDOW: "1",
    ...environment,
  });
  const [, windowId] = await instance.waitFor(/capture fixture window=(\d+)/);
  return { instance, servicePid, source: { kind: "window", windowId: Number(windowId) } };
}

/** A held start waits for this file: `holding` asks a launch to hold, `release` ends the hold. */
function holdRelease(home) {
  return join(home, "release-start");
}
function holding(home) {
  return { YAP_FIXTURE_START_HOLD: holdRelease(home) };
}
function release(home) {
  writeFileSync(holdRelease(home), "");
}

/** The takes the service has allocated a directory for, before any of them has media. */
function takes(home) {
  try {
    return readdirSync(join(home, "library", "recordings"));
  } catch {
    return [];
  }
}

/**
 * Asks for a take and answers only once this app's own capture session has acknowledged that it
 * holds that start pending. The start stays pending until it is released, so what follows acts on
 * a start that is provably in flight rather than on a directory that says nothing about native.
 */
async function heldStart(home, instance, source, requestId) {
  const answer = call(home, "capture.start", silent(requestId, source)).catch((error) => ({
    ok: false,
    error: { code: error.code ?? "CALL_FAILED", message: error.message },
  }));
  const [, recordingId] = await instance.waitFor(
    /capture fixture start held recording=([0-9a-fA-F-]+)/,
  );
  return { recordingId, answer };
}

/** Whether this take's own journal says its capture was finished rather than left running. */
function finalized(home, recordingId) {
  try {
    return journal(home, recordingId).some((record) => record.event === "finished");
  } catch {
    return false;
  }
}

function sourceFiles(home, recordingId) {
  return readdirSync(join(home, "library", "recordings", recordingId, "source")).sort();
}

function journal(home, recordingId) {
  return readFileSync(
    join(home, "library", "recordings", recordingId, "source/capture.journal.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("records its own window through the service and leaves one inspectable original", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { source } = await fixtureApp(home);

  const sources = await succeeds(home, "capture.sources");
  assert.deepEqual(sources.displays, [], "Fixture mode must expose no display");
  assert.deepEqual(
    sources.windows.map((window) => window.windowId),
    [source.windowId],
    "Fixture mode must expose this app's own window and nothing else",
  );

  const started = await succeeds(home, "capture.start", silent("take-1", source));
  assert.equal(started.state, "recording");
  assert.equal(started.sourceDurationUs, null);
  assert.deepEqual(started.sourceAdmissions, []);
  assert.deepEqual((await succeeds(home, "project.list", {})).projects, []);
  // Source discovery is immediate; a live take has no admitted source yet.
  assert.deepEqual(await succeeds(home, "recording.get"), started);

  await delay(1_200);
  assert.equal(
    (await succeeds(home, "capture.pause", { recordingId: started.recordingId })).state,
    "paused",
  );
  await delay(600);
  assert.equal(
    (await succeeds(home, "capture.resume", { recordingId: started.recordingId })).state,
    "recording",
  );
  await delay(1_200);
  const elapsed = Date.now();
  const stopped = await finishCapture(
    (op, params) => succeeds(home, op, params),
    started.recordingId,
  );
  const records = journal(home, started.recordingId);
  console.log(
    JSON.stringify({
      case: "capture-terminal-reports",
      stopped,
      lifecycle: records.filter((row) => row.event === "lifecycle"),
      clockRows: records.filter((row) =>
        ["origin", "pauseStarted", "pauseEnded"].includes(row.event),
      ),
    }),
  );
  assert.equal(stopped.state, "complete");
  assert.equal(stopped.recordingId, started.recordingId);
  assert.ok(stopped.sourceDurationUs > 1_000_000, `Short take: ${stopped.sourceDurationUs}us`);
  const sourceJournalPath = join(
    home,
    "library",
    "recordings",
    started.recordingId,
    "source",
    "source.journal.jsonl",
  );
  const sourceJournal = readFileSync(sourceJournalPath);
  assert.equal(
    JSON.parse(sourceJournal.toString("utf8").split("\n")[0]).data.sessionID,
    started.sourceId,
  );

  // A take that has ended has no transition left to make, while stopping it again answers with
  // the outcome it already has.
  for (const operation of ["capture.pause", "capture.resume"]) {
    const refused = await call(home, operation, { recordingId: started.recordingId });
    assert.equal(refused.ok, false, `${operation} on a finished take must be refused`);
    assert.equal(refused.error.code, "INVALID_STATE");
    assert.equal(refused.error.details.state, "complete");
  }
  const replay = await succeeds(home, "capture.stop", { recordingId: started.recordingId });
  for (const key of ["recordingId", "sourceId", "state", "sourceDurationUs"])
    assert.equal(replay[key], stopped[key]);

  const admitted = await waitFor(async () => {
    const facts = await succeeds(home, "recording.get", { recordingId: started.recordingId });
    const source = facts.sourceAdmissions.find((value) => value.kind === "primary");
    if (["failed", "unavailable", "canceled"].includes(source?.job?.state))
      throw new Error(JSON.stringify(source));
    return source?.job?.state === "ready" && { facts, source };
  }, 20_000);
  assert.equal(admitted.facts.sourceDurationUs, stopped.sourceDurationUs);
  assert.equal(admitted.source.sourceId, started.sourceId);
  const acquisition = await succeeds(home, "acquisition.get", {
    acquisitionId: admitted.source.acquisitionId,
  });
  assert.equal(acquisition.sourceId, started.sourceId);
  assert.ok(acquisition.bindings.some((binding) => binding.sourceRoles.includes("video")));
  assert.deepEqual((await succeeds(home, "project.list", {})).projects, []);
  assert.deepEqual(sourceFiles(home, started.recordingId), [
    "capture.journal.jsonl",
    "source.journal.jsonl",
    "source.publication.json",
    "video.mov",
  ]);

  assert.deepEqual(
    readFileSync(sourceJournalPath),
    sourceJournal,
    "Readmission and terminal replays preserve the frozen source journal",
  );
  // Native stamps the identity the service allocated, so a source directory names its own take.
  assert.equal(records[0].data.sessionID, started.sourceId);
  assert.equal(records[0].data.microphone, false);
  assert.equal(records[0].data.systemAudio, false);
  const pauses = records.filter((record) => record.event === "pauseEnded");
  assert.equal(pauses.length, 1, "The take must record the pause it was asked for");
  // Paused time is real elapsed time that the media does not contain.
  assert.ok(
    stopped.sourceDurationUs < (elapsed - Date.parse(started.createdAt)) * 1000 - 400_000,
    `Paused time leaked into the source duration: ${stopped.sourceDurationUs}us`,
  );
  const lifecycle = records.filter((record) => record.event === "lifecycle");
  console.log(
    JSON.stringify({
      case: "frozen-source-journal",
      frozenJournal: {
        bytes: sourceJournal.length,
        sha256: createHash("sha256").update(sourceJournal).digest("hex"),
      },
    }),
  );
  for (let index = 1; index < lifecycle.length; index++)
    assert.ok(
      lifecycle[index].sequence > lifecycle[index - 1].sequence,
      "Lifecycle progress stays in the same journal sequence",
    );
  assert.ok(
    lifecycle
      .filter((record) => record.data.state === "finalizing")
      .every((record) => record.data.reason == null),
    "Successful publication progress carries no interruption reason",
  );
  assert.equal(stopped.publication.sourceId, started.sourceId);
  assert.equal(stopped.publication.inputsClosed, true);
  assert.equal(stopped.publication.primary.state, "published");
  const publishedSource = stopped.publication.primary.source;
  assert.equal(publishedSource.sourceId, started.sourceId);
  assert.equal(publishedSource.sourceDurationUs, stopped.sourceDurationUs);
  assert.equal(publishedSource.journal.bytes, sourceJournal.length);
  assert.equal(
    publishedSource.journal.sha256,
    createHash("sha256").update(sourceJournal).digest("hex"),
  );
  const reported = lifecycle.map((row) => row.data.state);
  // Publication reports update authority while remaining finalizing; they are not new state transitions.
  const transitions = reported.filter(
    (state, index) => state !== "finalizing" || reported[index - 1] !== "finalizing",
  );
  assert.deepEqual(transitions, ["recording", "paused", "recording", "finalizing", "complete"]);
});

test("replays a repeated start onto one take and refuses a concurrent second one", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { source } = await fixtureApp(home);
  const request = silent("once", source);
  const started = await succeeds(home, "capture.start", request);
  assert.deepEqual(await succeeds(home, "capture.start", request), started);

  const competing = await call(home, "capture.start", silent("competing", source));
  assert.equal(competing.ok, false);
  assert.equal(competing.error.code, "INVALID_STATE");
  const refused = competing.error.details.recordingId;
  assert.notEqual(refused, started.recordingId);
  // The refused take keeps an honest terminal identity rather than a false recording state.
  const failed = await succeeds(home, "recording.get", { recordingId: refused });
  assert.equal(failed.state, "interrupted");
  assert.equal(failed.sourceDurationUs, null);
  assert.ok(failed.sourceAdmissions.every((source) => source.acquisitionId === null));
  assert.deepEqual(
    readdirSync(join(home, "library", "recordings")).sort(),
    [refused, started.recordingId].sort(),
  );
  await succeeds(home, "capture.stop", { recordingId: started.recordingId });
});

test("a source this app may not capture fails the start and settles that take", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { source } = await fixtureApp(home);
  const refused = await call(
    home,
    "capture.start",
    silent("other-window", { kind: "window", windowId: source.windowId + 1 }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "SOURCE_UNAVAILABLE");
  const settled = await succeeds(home, "recording.get", {
    recordingId: refused.error.details.recordingId,
  });
  assert.equal(settled.state, "interrupted");
  assert.equal(settled.interruptionReason, "SOURCE_UNAVAILABLE");
  assert.equal(settled.sourceDurationUs, null);
  // Nothing was captured, so the device is idle, free for the next take, and holds no clock.
  const { device, recording } = await succeeds(home, "capture.status");
  assert.equal(recording, null);
  assert.deepEqual(
    {
      state: device.state,
      recordingId: device.recordingId,
      sourceId: device.sourceId,
      elapsedUs: device.elapsedUs,
    },
    { state: "idle", recordingId: null, sourceId: null, elapsedUs: null },
  );
  // The app states its live camera on every status answer; no take holds one here.
  assert.equal(device.camera, null);
  assert.equal(
    device.permissions.screen,
    true,
    "These checks ran, so this build holds screen recording permission",
  );
});

test("cancel discards only its own take's media and restart names a new one", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { source } = await fixtureApp(home);
  const kept = await succeeds(home, "capture.start", silent("kept", source));
  await delay(1_200);
  await finishCapture((op, params) => succeeds(home, op, params), kept.recordingId);
  const keptSource = join(home, "library", "recordings", kept.recordingId, "source");
  const keptBytes = sourceFiles(home, kept.recordingId).map((file) => ({
    file,
    bytes: readFileSync(join(keptSource, file)),
  }));

  const discarded = await succeeds(home, "capture.start", silent("discarded", source));
  await delay(600);
  const restarted = await succeeds(
    home,
    "capture.restart",
    silent("restarted", source, { recordingId: discarded.recordingId }),
  );
  assert.notEqual(restarted.recordingId, discarded.recordingId);
  assert.equal(restarted.state, "recording");
  assert.deepEqual(
    readdirSync(join(home, "library", "recordings")).sort(),
    [kept.recordingId, restarted.recordingId].sort(),
  );

  await delay(600);
  const canceled = await succeeds(home, "capture.cancel", { recordingId: restarted.recordingId });
  assert.equal(canceled.state, "canceled");
  assert.deepEqual(readdirSync(join(home, "library", "recordings")), [kept.recordingId]);
  // Only the finished take remains discoverable, and it kept its own media.
  assert.equal((await succeeds(home, "recording.get")).recordingId, kept.recordingId);
  assert.deepEqual(sourceFiles(home, kept.recordingId), [
    "capture.journal.jsonl",
    "source.journal.jsonl",
    "source.publication.json",
    "video.mov",
  ]);
  for (const { file, bytes } of keptBytes)
    assert.deepEqual(
      readFileSync(join(keptSource, file)),
      bytes,
      `Cancellation preserves kept source member ${file}`,
    );
});

test("a service killed mid-capture leaves a take the next service reconciles from its media", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, servicePid, source } = await fixtureApp(home);
  const started = await succeeds(home, "capture.start", silent("orphan", source));
  await delay(1_800);
  process.kill(servicePid, "SIGKILL");
  await instance.waitFor(/service failed code=SERVICE_STOPPED/);
  // Native owns the media, so it finalizes the take into its own journal rather than capturing on
  // unindexed. Nothing restarts the service.
  await waitFor(
    () => journal(home, started.recordingId).some((record) => record.event === "finished"),
    10_000,
    () => "Native never finalized the take its service abandoned",
  );
  assert.deepEqual(instance.children(), []);
  instance.kill("SIGTERM");
  await instance.exited;

  await fixtureApp(home);
  const reconciled = await waitFor(
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
  assert.equal(reconciled.state, "interrupted");
  assert.equal(reconciled.interruptionReason, "CAPTURE_INTERRUPTED");
  assert.ok(reconciled.sourceDurationUs > 0, "The recovered prefix must carry its own duration");
  assert.ok(
    reconciled.sourceAdmissions.some(
      (source) => source.kind === "primary" && source.sourceId === started.sourceId,
    ),
  );
});

test("a take killed as it stops is recovered from the media it had already written", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, source } = await fixtureApp(home);
  const started = await succeeds(home, "capture.start", silent("stopping", source));
  await delay(1_800);
  // Stop and kill at the same moment: the take is somewhere between the order to finish and the
  // finished media, which is the window a person hits by force quitting as they end a recording.
  const stopping = call(home, "capture.stop", { recordingId: started.recordingId }).catch(
    (error) => ({ ok: false, error }),
  );
  instance.kill("SIGKILL");
  await instance.exited;
  await stopping;

  await fixtureApp(home);
  const reconciled = await waitFor(
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
  // Whichever side of the finish it died on, the take says what it is and keeps what it has: a
  // complete take, or an interrupted one whose recovered prefix is its own duration.
  assert.ok(
    ["complete", "interrupted"].includes(reconciled.state),
    `A stopped take must settle, got ${reconciled.state}`,
  );
  assert.ok(
    reconciled.sourceDurationUs > 0,
    "A take that had written media must not lose all of it to the kill",
  );
  assert.ok(
    reconciled.sourceAdmissions.some(
      (source) => source.kind === "primary" && source.sourceId === started.sourceId,
    ),
  );
});

test("a take killed before any media is decodable stays terminal with no admitted source", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, source } = await fixtureApp(home);
  const started = await succeeds(home, "capture.start", silent("doomed", source));
  // Killed before the writer's first fragment, so nothing it wrote can be decoded.
  instance.kill("SIGKILL");
  await instance.exited;

  await fixtureApp(home);
  const settled = await waitFor(
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
  const sourceDirectory = join(home, "library", "recordings", started.recordingId, "source");
  const retainedJournal = journal(home, started.recordingId);
  console.log(
    JSON.stringify({
      case: "undecodable-container",
      settled,
      journalHeader: retainedJournal.find((row) => row.event === "header"),
      journalCompletion: retainedJournal.filter((row) => ["finished", "error"].includes(row.event)),
      containerMembers: sourceFiles(home, started.recordingId).map((file) => ({
        file,
        bytes: statSync(join(sourceDirectory, file)).size,
      })),
    }),
  );
  assert.equal(settled.state, "interrupted");
  assert.equal(settled.interruptionReason, "DECODE_FAILED");
  assert.ok(
    settled.interruptionMessage?.trim().length > 0,
    "The specific decode failure retains its explanation",
  );
  assert.equal(settled.sourceDurationUs, null);
  assert.ok(settled.sourceAdmissions.every((source) => source.acquisitionId === null));
});

test("a normal quit during capture finalizes the take before the app exits", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, servicePid, source } = await fixtureApp(home);
  const started = await succeeds(home, "capture.start", silent("quit", source));
  await delay(1_500);
  instance.kill("SIGTERM");
  assert.deepEqual(await instance.exited, { code: 0, signal: null });
  assert.equal(alive(servicePid), false);

  await fixtureApp(home);
  // Quit finalized it, so the next service has nothing to reconcile and the take is complete.
  const finished = await waitFor(
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
  assert.equal(finished.state, "complete");
  assert.ok(finished.sourceDurationUs > 1_000_000, `Short take: ${finished.sourceDurationUs}us`);
  assert.ok(
    finished.sourceAdmissions.some(
      (source) => source.kind === "primary" && source.sourceId === started.sourceId,
    ),
  );
});

test("a service lost while a take is starting finalizes it instead of capturing on", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, servicePid, source } = await fixtureApp(home, holding(home));
  const { recordingId } = await heldStart(home, instance, source, "lost-while-starting");
  process.kill(servicePid, "SIGKILL");
  await instance.waitFor(/service failed code=SERVICE_STOPPED/);
  // The library disappears while this app is provably still holding that start.
  await instance.waitFor(/service lost with a start in flight/);
  release(home);

  // The start lands with no library left to index or control it, so the app finishes that take
  // into its own journal rather than leaving the device capturing.
  await waitFor(
    () => finalized(home, recordingId),
    15_000,
    () => "A start that outlived its service left the device capturing",
  );
  assert.deepEqual(instance.children(), []);
  assert.equal(instance.running, true, "The app must survive its service");
  instance.kill("SIGTERM");
  await instance.exited;

  await fixtureApp(home);
  const settled = await waitFor(
    async () => {
      const facts = await succeeds(home, "recording.get", { recordingId });
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
  assert.equal(settled.state, "interrupted");
  assert.equal(
    (await succeeds(home, "capture.status")).device.state,
    "idle",
    "The device must be free for the next take",
  );
});

test("a normal quit while a take is starting finalizes it before the app exits", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, servicePid, source } = await fixtureApp(home, holding(home));
  const { recordingId } = await heldStart(home, instance, source, "quit-while-starting");
  instance.kill("SIGTERM");
  // The quit reaches the take it has already asked for while that start is still held.
  await instance.waitFor(/quit waiting for a start in flight/);
  release(home);

  assert.deepEqual(await instance.exited, { code: 0, signal: null });
  assert.equal(alive(servicePid), false);
  // Quit owns the start it already asked for: the take is finished before the app is gone.
  assert.equal(
    finalized(home, recordingId),
    true,
    "The quit abandoned a take whose start was still running",
  );
});

test("the fixture records no audio device, whether one is asked for or merely defaulted", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { source } = await fixtureApp(home);
  // Both of these are refused by this app before any capture request is built, so neither reaches
  // an audio device and neither can prompt for one.
  for (const params of [
    { requestId: "asked", source, microphone: true, systemAudio: false },
    { requestId: "defaulted", source },
  ]) {
    const refused = await call(home, "capture.start", params);
    assert.equal(refused.ok, false, `${params.requestId} must not start`);
    assert.equal(refused.error.code, "INVALID_REQUEST");
    const settled = await succeeds(home, "recording.get", {
      recordingId: refused.error.details.recordingId,
    });
    assert.equal(settled.state, "interrupted");
    assert.equal(settled.sourceDurationUs, null);
  }
  const status = await succeeds(home, "capture.status");
  assert.equal(status.device.state, "idle", "The device must be free for the next take");
  // The silent take this file always asks for is the one the fixture accepts.
  const started = await succeeds(home, "capture.start", silent("silent", source));
  assert.equal(started.state, "recording");
  await succeeds(home, "capture.stop", { recordingId: started.recordingId });
});

test("a start whose answer is lost replays onto its own take instead of starting a second one", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-capture-");
  const { instance, source } = await fixtureApp(home, holding(home));
  const request = silent("held", source);
  const { recordingId, answer } = await heldStart(home, instance, source, request.requestId);
  // Nothing about this start is answered while it is held, so the service hears only its deadline.
  const timedOut = await answer;
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, "TIMEOUT");
  assert.equal(timedOut.error.details.recordingId, recordingId);
  assert.equal(timedOut.error.details.state, "preparing");

  const replayed = await call(home, "capture.start", request);
  // The replay names the same take and leaves it alone: its start is unproved, not refused, and
  // the device is never asked to start it a second time.
  assert.equal(replayed.ok, false);
  assert.equal(replayed.error.code, "UNRESOLVED_START");
  assert.equal(replayed.error.retryable, true);
  assert.equal(replayed.error.details.recordingId, recordingId);
  const unsettled = await succeeds(home, "recording.get", { recordingId });
  assert.equal(unsettled.state, "preparing");
  assert.equal(unsettled.interruptionReason, null);
  assert.deepEqual(takes(home), [recordingId]);

  release(home);
  // Released, the start lands and the stop the service sent at its deadline ends it. Native
  // closes that take's media and reports how it ended; the catalog stores that report rather
  // than authoring a recovery of its own. Whether a frame arrived before the stop is the device's
  // answer, so the outcome is checked against the take's own journal, not assumed here.
  const ended = await waitFor(
    async () => {
      const facts = await succeeds(home, "recording.get", { recordingId });
      return ["complete", "interrupted"].includes(facts.state) && facts;
    },
    20_000,
    () => "The held start never finished its own take",
  );
  assert.ok(finalized(home, recordingId), "The take's journal records its capture as finished");
  const terminal = journal(home, recordingId)
    .filter((record) => record.event === "lifecycle")
    .at(-1).data;
  assert.equal(ended.state, terminal.state, "The stored outcome is the one native journaled");
  if (terminal.state === "interrupted") assert.equal(ended.interruptionReason, terminal.reason);
  instance.kill("SIGTERM");
  await instance.exited;

  await fixtureApp(home);
  const settled = await waitFor(
    async () => {
      const facts = await succeeds(home, "recording.get", { recordingId });
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
  assert.equal(settled.state, ended.state, "A restart keeps the outcome native reported");
  assert.equal(settled.interruptionReason, ended.interruptionReason);
  // The receipt outlived the service that wrote it: the same request still names that one take.
  assert.deepEqual(await succeeds(home, "capture.start", request), settled);
  assert.deepEqual(takes(home), [recordingId]);
});
