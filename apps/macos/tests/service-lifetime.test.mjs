import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import {
  alive,
  app,
  exists,
  finderEnvironment,
  launch,
  launchReady,
  socketPath,
  temporary,
  waitFor,
} from "./harness.mjs";

function health(home, id) {
  return callLocal(socketPath(home), { id, operation: "service.health", params: {} });
}

/** Writes a stand-in interpreter whose whole behaviour this test controls. */
function interpreter(script) {
  const path = join(temporary("/tmp/scr-fake-node-"), "node");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A stand-in that passes the version gate and then misbehaves as the service. */
function fakeNode(body, version = 'echo "v24.14.0"; exit 0') {
  return interpreter(`if [ "$1" = "--version" ]; then ${version}; fi\n${body}`);
}

/** A child that ignores SIGTERM, so only real escalation can end it. */
const ignoresTermination = 'trap "" TERM\nwhile :; do /bin/sleep 1; done';

test("ordinary launch owns one service child and answers health without starting capture", async () => {
  const home = temporary("/tmp/scr-app-");
  const { instance, servicePid } = await launchReady(home);
  await instance.waitFor(/service health status=ready/);

  const children = instance.children();
  assert.equal(
    children.length,
    1,
    `Expected exactly one service child, saw ${JSON.stringify(children)}`,
  );
  assert.equal(children[0].pid, servicePid);
  assert.match(children[0].command, /Contents\/Resources\/service\/main\.mjs$/);

  assert.equal(statSync(join(home, "run")).mode & 0o777, 0o700);
  assert.equal(statSync(socketPath(home)).mode & 0o777, 0o600);
  const answer = await health(home, "app-health-1");
  assert.equal(answer.ok, true);
  assert.equal(answer.data.status, "ready");
  assert.equal(answer.data.home, home);
  assert.equal(answer.data.socketPath, socketPath(home));
  assert.equal(answer.data.pid, servicePid);
  // Startup opens the catalog, but it must not allocate a take or capture media.
  assert.equal(exists(join(home, "recordings")), false);
  const latest = await callLocal(socketPath(home), {
    id: "idle-latest",
    operation: "recording.get",
    params: {},
  });
  assert.deepEqual(latest, {
    id: "idle-latest",
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "Recording does not exist",
      retryable: false,
      details: {},
    },
  });
  assert.doesNotMatch(instance.diagnostics, /capture|permission/i);
});

test("a native probe run owns no service and leaves the personal root untouched", async () => {
  const home = temporary("/tmp/scr-app-");
  const probe = spawnSync(app, ["--probe", "preflight"], {
    cwd: "/",
    env: { ...finderEnvironment, YAP_HOME: home },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(Object.keys(JSON.parse(probe.stdout)).sort(), ["microphone", "screen"]);
  assert.deepEqual(readdirSync(home), []);
});

test("an argument that names no probe is an ordinary launch", async () => {
  const home = temporary("/tmp/scr-app-");
  const { instance } = await launchReady(home, {}, ["-NSDocumentRevisionsDebugMode", "YES"]);
  await instance.waitFor(/service health status=ready/);
});

test("normal quit stops the service and removes its socket within the deadline", async () => {
  const home = temporary("/tmp/scr-app-");
  const { instance, servicePid } = await launchReady(home);
  instance.kill("SIGTERM");
  assert.deepEqual(await instance.exited, { code: 0, signal: null });
  assert.equal(alive(servicePid), false);
  assert.equal(exists(socketPath(home)), false);
});

test("abrupt app death closes the service through control-pipe EOF", async () => {
  const home = temporary("/tmp/scr-app-");
  const { instance, servicePid } = await launchReady(home);
  instance.kill("SIGKILL");
  await instance.exited;
  await waitFor(
    () => !alive(servicePid),
    10_000,
    () => `Service ${servicePid} outlived its app`,
  );
  await waitFor(
    () => !exists(socketPath(home)),
    5_000,
    () => "Service left its socket behind",
  );
});

test("a killed service is reported once, never restarted, and its path is reclaimed on relaunch", async () => {
  const home = temporary("/tmp/scr-app-");
  const first = await launchReady(home);
  process.kill(first.servicePid, "SIGKILL");
  await first.instance.waitFor(/service failed code=SERVICE_STOPPED/);
  await delay(1_500);
  assert.equal(first.instance.running, true, "The app must survive its service");
  assert.deepEqual(first.instance.children(), [], "A dead service must not be restarted");
  // A killed listener cannot unlink its own path; the leftover is what relaunch reclaims.
  assert.equal(statSync(socketPath(home)).isSocket(), true);

  first.instance.kill("SIGTERM");
  await first.instance.exited;
  const second = await launchReady(home);
  assert.equal((await health(home, "after-reclaim")).data.pid, second.servicePid);
});

test("a second owner reports the conflict and leaves the live socket and its owner alone", async () => {
  const home = temporary("/tmp/scr-app-");
  const owner = await launchReady(home);
  const before = statSync(socketPath(home));

  const intruder = launch(home);
  const [, code] = await intruder.waitFor(/service failed code=(\w+)/);
  assert.equal(code, "SOCKET_IN_USE");
  assert.equal(intruder.running, true, "A failed start must stay visible, not exit silently");
  // The app reports the refusal, then ends the child, escalating to SIGKILL after its 2 s signal
  // deadline; the child can still be exiting when the report lands.
  await waitFor(
    () => intruder.children().length === 0,
    3_000,
    () => `The refused service lingered: ${JSON.stringify(intruder.children())}`,
  );

  assert.equal(statSync(socketPath(home)).ino, before.ino, "The live socket was replaced");
  assert.equal(alive(owner.servicePid), true);
  assert.equal((await health(home, "owner-still-serving")).data.pid, owner.servicePid);
});

test("normal quit ends a ready child that honours neither EOF nor SIGTERM", async () => {
  const home = temporary("/tmp/scr-app-");
  // Announces a listener, then reads nothing and refuses to die politely.
  const deaf = fakeNode(
    `echo "{\\"event\\":\\"started\\",\\"pid\\":$$,\\"socketPath\\":\\"${socketPath(home)}\\"}"\n${ignoresTermination}`,
  );
  const instance = launch(home, { YAP_NODE: deaf });
  const [, pid] = await instance.waitFor(/service ready pid=(\d+)/);
  const started = Date.now();
  instance.kill("SIGTERM");
  await instance.exited;
  const elapsed = Date.now() - started;
  // The quit budget is EOF, then SIGTERM, then SIGKILL — bounded, and against this
  // child's PID alone. Blocking on a child that never reads would exceed it.
  assert.ok(elapsed < 12_000, `Quit outran its bounded budget, took ${elapsed}ms`);
  await waitFor(
    () => !alive(Number(pid)),
    5_000,
    () => `The deaf service ${pid} outlived its app`,
  );
});

test("a missing interpreter is a reported startup failure, not a hidden retry", async () => {
  const home = temporary("/tmp/scr-app-");
  const instance = launch(home, { YAP_NODE: "/nonexistent/node" });
  const [line] = await instance.waitFor(/service failed code=NODE_UNAVAILABLE message=(.*)/);
  assert.match(line, /YAP_NODE/);
  await delay(1_000);
  assert.equal(instance.running, true);
  assert.deepEqual(instance.children(), []);
  assert.equal(exists(socketPath(home)), false);
});

test("unreadable control output fails the start and ends a child that ignores SIGTERM", async () => {
  const home = temporary("/tmp/scr-app-");
  const instance = launch(home, {
    YAP_NODE: fakeNode(`echo 'not a control message'\n${ignoresTermination}`),
  });
  await instance.waitFor(/service failed code=CONTROL_PROTOCOL/);
  // A terminal failure that only asks politely leaves a live child holding the runtime
  // directory, so the cleanup has to escalate within its own bounded deadline.
  await waitFor(
    () => instance.children().length === 0,
    5_000,
    () => "The faulty child was left running",
  );
  assert.equal(instance.running, true);
});

test("oversized control output fails the start", async () => {
  const home = temporary("/tmp/scr-app-");
  const oversized = "/usr/bin/head -c 70000 /dev/zero | /usr/bin/tr '\\0' 'x'\necho\nexec sleep 60";
  const instance = launch(home, { YAP_NODE: fakeNode(oversized) });
  await instance.waitFor(/service failed code=CONTROL_LIMIT_EXCEEDED/);
  await waitFor(
    () => instance.children().length === 0,
    5_000,
    () => "The faulty child was left running",
  );
});

test("one startup budget covers a slow interpreter probe and a silent service", async () => {
  const home = temporary("/tmp/scr-app-");
  const started = Date.now();
  const slowToAnswer = fakeNode("exec sleep 60", '/bin/sleep 1; echo "v24.14.0"; exit 0');
  const instance = launch(home, { YAP_NODE: slowToAnswer });
  await instance.waitFor(/service failed code=SERVICE_TIMEOUT/, 25_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 10_000, `The startup budget must not be cut short, took ${elapsed}ms`);
  // The budget is one deadline over resolution and readiness together. Restarting it
  // after the probe would push this report past the interpreter's own delay.
  assert.ok(elapsed < 13_000, `Startup outran its one budget, took ${elapsed}ms`);
  await waitFor(
    () => instance.children().length === 0,
    5_000,
    () => "The silent child was left running",
  );
  assert.equal(instance.running, true);
});

test("an interpreter that never answers is abandoned inside the startup budget", async () => {
  const home = temporary("/tmp/scr-app-");
  const started = Date.now();
  const instance = launch(home, { YAP_NODE: interpreter(ignoresTermination) });
  await instance.waitFor(/service failed code=NODE_UNAVAILABLE/, 15_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `A hung candidate consumed the whole budget, took ${elapsed}ms`);
  await waitFor(
    () => instance.children().length === 0,
    5_000,
    () => "The hung version probe was left running",
  );
  assert.equal(instance.running, true);
  assert.equal(exists(socketPath(home)), false);
});

test("an interpreter that answers endlessly is abandoned rather than buffered", async () => {
  const home = temporary("/tmp/scr-app-");
  const flooding = `trap "" TERM\nwhile :; do /usr/bin/head -c 200000 /dev/zero | /usr/bin/tr '\\0' 'x'; done`;
  const instance = launch(home, { YAP_NODE: interpreter(flooding) });
  await instance.waitFor(/service failed code=NODE_UNAVAILABLE/, 15_000);
  await waitFor(
    () => instance.children().length === 0,
    5_000,
    () => "The flooding version probe was left running",
  );
  assert.equal(instance.running, true);
});

test("simultaneous launches against one home leave exactly one owner", async () => {
  const home = temporary("/tmp/scr-app-");
  const instances = [launch(home), launch(home), launch(home)];
  const outcomes = await Promise.all(
    instances.map((instance) => instance.waitFor(/service (?:ready pid=(\d+)|failed code=(\w+))/)),
  );
  const owners = outcomes.filter((match) => match[1]).map((match) => Number(match[1]));
  const refused = outcomes.filter((match) => match[2]).map((match) => match[2]);
  assert.equal(
    owners.length,
    1,
    `Expected one owner, saw ${JSON.stringify(outcomes.map((m) => m[0]))}`,
  );
  assert.deepEqual(refused, ["SOCKET_IN_USE", "SOCKET_IN_USE"]);
  assert.equal(statSync(socketPath(home)).isSocket(), true);
  assert.equal((await health(home, "sole-owner")).data.pid, owners[0]);
});

test("quitting during interpreter validation reaps the owned probe", async () => {
  const home = temporary("/tmp/scr-app-");
  const executable = interpreter(ignoresTermination);
  const instance = launch(home, { YAP_NODE: executable });
  const probe = await waitFor(
    () => instance.children().find((child) => child.command.includes(executable)),
    3_000,
  );
  try {
    instance.kill("SIGTERM");
    await instance.exited;
    assert.equal(alive(probe.pid), false, "Quit left the interpreter probe running");
  } finally {
    if (alive(probe.pid)) process.kill(probe.pid, "SIGKILL");
  }
});
