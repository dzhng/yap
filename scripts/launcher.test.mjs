import { launcherVerdicts } from "./launcher/verdicts.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("the production launcher refuses bundled entry before loading and holds exclusion until Node exits", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-launcher-"));
  const accountHome = join(scratch, "Account home");
  const lockDirectory = join(accountHome, "Library/Caches/com.dzhng.yap");
  let holder, ownedClosed;
  try {
    mkdirSync(accountHome);
    const accountShim = join(scratch, "account.c");
    writeFileSync(
      accountShim,
      `#include <pwd.h>
struct passwd *fixture_getpwuid(uid_t uid) { static struct passwd account; account.pw_uid=uid; account.pw_dir=${JSON.stringify(accountHome)}; return &account; }
`,
    );
    const launcher = join(scratch, "yap"),
      lockExec = join(scratch, "lock-exec");
    execFileSync("clang", [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Dgetpwuid=fixture_getpwuid",
      "scripts/launcher/main.c",
      launcherVerdicts,
      accountShim,
      "-o",
      launcher,
    ]);
    execFileSync("clang", ["scripts/launcher-lab/lock-exec.c", "-o", lockExec]);
    const app = join(scratch, "Relocated App.app");
    mkdirSync(join(app, "Contents/Resources/node/bin"), { recursive: true });
    mkdirSync(join(app, "Contents/Resources/cli"));
    copyFileSync(process.execPath, join(app, "Contents/Resources/node/bin/node"));
    writeFileSync(
      join(app, "Contents/Resources/cli/main.mjs"),
      `console.log(JSON.stringify({app:process.env.YAP_APP,args:process.argv.slice(2)}));process.stdin.resume();`,
    );
    const env = { ...process.env, HOME: scratch, YAP_APP: app };
    holder = spawn(launcher, ["mcp", "with spaces"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const closed = (ownedClosed = new Promise((resolve) => holder.once("close", resolve)));
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Node entry timed out")), 5000);
      holder.stdout.once("data", (bytes) => {
        clearTimeout(timer);
        resolve(bytes.toString());
      });
    });
    assert.deepEqual(JSON.parse(line), { app, args: ["mcp", "with spaces"] });
    const lock = join(lockDirectory, "launch.lock");
    assert.equal(spawnSync(lockExec, ["exclusive", lock, "/usr/bin/true"]).status, 75);
    holder.stdin.end();
    assert.equal(await closed, 0);
    assert.equal(spawnSync(lockExec, ["exclusive", lock, "/usr/bin/true"]).status, 0);
    holder = spawn(
      lockExec,
      ["exclusive", lock, process.execPath, "-e", "console.log('locked');process.stdin.resume()"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exclusiveClosed = (ownedClosed = new Promise((resolve) => holder.once("close", resolve)));
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const otherHome = join(scratch, "Different HOME");
    mkdirSync(otherHome);
    const denied = spawnSync(launcher, ["--help"], {
      env: { ...env, HOME: otherHome, YAP_APP: join(scratch, "absent.app") },
      encoding: "utf8",
    });
    assert.equal(denied.status, 75);
    assert.deepEqual(JSON.parse(denied.stdout).error, {
      code: "UPDATING",
      message: "Installation is being replaced; retry after the update",
      retryable: true,
      retryAfterMs: 15000,
    });
    holder.kill("SIGKILL");
    await exclusiveClosed;
    holder = undefined;
    const defaultApp = join(otherHome, "Applications/Yap.app");
    mkdirSync(join(otherHome, "Applications"));
    symlinkSync(app, defaultApp);
    const defaultEnv = { ...env, HOME: otherHome };
    delete defaultEnv.YAP_APP;
    const defaultEntry = spawnSync(launcher, ["--help"], {
      env: defaultEnv,
      input: "",
      encoding: "utf8",
    });
    assert.equal(defaultEntry.status, 0, defaultEntry.stderr);
    assert.deepEqual(JSON.parse(defaultEntry.stdout), { app: defaultApp, args: ["--help"] });
    linkSync(lock, join(lockDirectory, "hardlink"));
    const hardlinked = spawnSync(launcher, ["--help"], { env, input: "", encoding: "utf8" });
    assert.equal(hardlinked.status, 74);
    assert.equal(
      JSON.parse(hardlinked.stdout).error.message,
      "Cannot open private installation lock",
    );
  } finally {
    if (holder) {
      holder.kill("SIGKILL");
      await ownedClosed;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the launcher finds the app at YAP_APP, then home Applications, then system Applications", () => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-launcher-lookup-"));
  try {
    const accountHome = join(scratch, "Account home");
    const home = join(scratch, "Home");
    const system = join(scratch, "System Applications");
    mkdirSync(accountHome);
    mkdirSync(join(home, "Applications"), { recursive: true });
    mkdirSync(system);
    const accountShim = join(scratch, "account.c");
    writeFileSync(
      accountShim,
      `#include <pwd.h>
struct passwd *fixture_getpwuid(uid_t uid) { static struct passwd account; account.pw_uid=uid; account.pw_dir=${JSON.stringify(accountHome)}; return &account; }
`,
    );
    const launcher = join(scratch, "yap");
    execFileSync("clang", [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Dgetpwuid=fixture_getpwuid",
      `-DYAP_SYSTEM_APPLICATIONS=${JSON.stringify(system)}`,
      "scripts/launcher/main.c",
      launcherVerdicts,
      accountShim,
      "-o",
      launcher,
    ]);
    const fakeApp = (path) => {
      const bin = join(path, "Contents/Resources/node/bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$YAP_APP" "$0" "$@"\n`, {
        mode: 0o755,
      });
      return path;
    };
    const env = { ...process.env, HOME: home };
    delete env.YAP_APP;
    const entry = (overrides) => {
      const result = spawnSync(launcher, ["--help"], {
        env: { ...env, ...overrides },
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout };
    };
    const entered = (app) => ({
      status: 0,
      stdout: [
        app,
        join(app, "Contents/Resources/node/bin/node"),
        join(app, "Contents/Resources/cli/main.mjs"),
        "--help",
        "",
      ].join("\n"),
    });

    const missing = entry({});
    assert.equal(missing.status, 74);
    assert.deepEqual(JSON.parse(missing.stdout).error, {
      code: "SERVICE_UNAVAILABLE",
      message: "Bundled Node could not start; verify the installed app",
      retryable: true,
    });

    const systemApp = fakeApp(join(system, "Yap.app"));
    assert.deepEqual(entry({}), entered(systemApp));

    const homeApp = fakeApp(join(home, "Applications/Yap.app"));
    assert.deepEqual(entry({}), entered(homeApp));

    const overrideApp = fakeApp(join(scratch, "Override.app"));
    assert.deepEqual(entry({ YAP_APP: overrideApp }), entered(overrideApp));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("bundled media tools preserve arguments, streams and exit status while excluding installation", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-media-launcher-"));
  const accountHome = join(scratch, "Account home");
  let child, closed;
  try {
    mkdirSync(accountHome);
    const accountShim = join(scratch, "account.c");
    writeFileSync(
      accountShim,
      `#include <pwd.h>
struct passwd *fixture_getpwuid(uid_t uid) { static struct passwd account; account.pw_uid=uid; account.pw_dir=${JSON.stringify(accountHome)}; return &account; }
`,
    );
    const launcher = join(scratch, "yap");
    const lockExec = join(scratch, "lock-exec");
    execFileSync("clang", [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Dgetpwuid=fixture_getpwuid",
      "scripts/launcher/main.c",
      launcherVerdicts,
      accountShim,
      "-o",
      launcher,
    ]);
    execFileSync("clang", ["scripts/launcher-lab/lock-exec.c", "-o", lockExec]);
    const app = join(scratch, "Relocated App.app");
    const bin = join(app, "Contents/Resources/ffmpeg/bin");
    mkdirSync(bin, { recursive: true });
    const source = join(scratch, "tool.c");
    writeFileSync(
      source,
      `#include <stdio.h>
int main(int argc, char **argv) {
  for (int i=1; i<argc; ++i) puts(argv[i]);
  fflush(stdout);
  fputs("tool diagnostic\\n", stderr);
  int value;
  while ((value=getchar()) != EOF) putchar(value);
  return 23;
}
`,
    );
    execFileSync("clang", [source, "-o", join(bin, "ffmpeg")]);
    copyFileSync(join(bin, "ffmpeg"), join(bin, "ffprobe"));
    const env = { ...process.env, HOME: scratch, YAP_APP: app };
    const lock = join(accountHome, "Library/Caches/com.dzhng.yap/launch.lock");
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const args = [
        "-filter_complex",
        "drawtext=text='literal $(text) with spaces'",
        "-i",
        "pipe:0",
      ];
      child = spawn(launcher, [tool, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      closed = new Promise((resolve) => child.once("close", resolve));
      let output = "",
        errors = "";
      child.stdout.on("data", (bytes) => {
        output += bytes;
      });
      child.stderr.on("data", (bytes) => {
        errors += bytes;
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Tool entry timed out")), 5000);
        child.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("close", () => {
          clearTimeout(timer);
          reject(new Error("Tool exited before entry"));
        });
      });
      assert.equal(spawnSync(lockExec, ["exclusive", lock, "/usr/bin/true"]).status, 75);
      child.stdin.end("stdin payload\n");
      assert.equal(await closed, 23);
      child = undefined;
      assert.equal(output, args.join("\n") + "\nstdin payload\n");
      assert.equal(errors, "tool diagnostic\n");
      assert.equal(spawnSync(lockExec, ["exclusive", lock, "/usr/bin/true"]).status, 0);
      child = spawn(lockExec, ["exclusive", lock, "/bin/cat"], { stdio: ["pipe", "pipe", "pipe"] });
      closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.write("exclusive owner\n");
      await new Promise((resolve) => child.stdout.once("data", resolve));
      const denied = spawnSync(launcher, [tool, "-version"], { env, encoding: "utf8" });
      assert.equal(denied.status, 75);
      assert.equal(JSON.parse(denied.stdout).error.code, "UPDATING");
      child.stdin.end();
      assert.equal(await closed, 0);
      child = undefined;
    }
  } finally {
    if (child) {
      child.kill("SIGKILL");
      await closed;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("yap mcp holds the installation lock only during a call, and leaves after an update", async (t) => {
  const { bundleNodeEntry } = await import("./node-bundle.mjs");
  const { readFileSync, realpathSync } = await import("node:fs");
  // Short as well as real: a fake service socket lives under this home.
  const scratch = realpathSync(mkdtempSync("/tmp/yap-mcp-lock-"));
  const accountHome = join(scratch, "Account home");
  mkdirSync(accountHome);
  let server, holder;
  t.after(() => {
    server?.kill("SIGKILL");
    holder?.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  });
  const accountShim = join(scratch, "account.c");
  writeFileSync(
    accountShim,
    `#include <pwd.h>
struct passwd *fixture_getpwuid(uid_t uid) { static struct passwd account; account.pw_uid=uid; account.pw_dir=${JSON.stringify(accountHome)}; return &account; }
`,
  );
  const launcher = join(scratch, "yap"),
    lockExec = join(scratch, "lock-exec");
  execFileSync("clang", [
    "-Dgetpwuid=fixture_getpwuid",
    "scripts/launcher/main.c",
    launcherVerdicts,
    accountShim,
    "-o",
    launcher,
  ]);
  execFileSync("clang", ["scripts/launcher-lab/lock-exec.c", "-o", lockExec]);
  const app = join(scratch, "Yap.app");
  mkdirSync(join(app, "Contents/Resources/node/bin"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources/service"), { recursive: true });
  copyFileSync(process.execPath, join(app, "Contents/Resources/node/bin/node"));
  bundleNodeEntry("apps/cli/dist/main.js", join(app, "Contents/Resources/cli/main.mjs"), {
    stdio: "pipe",
  });
  const { version } = JSON.parse(readFileSync("apps/macos/package.json", "utf8"));
  const installed = (value) =>
    writeFileSync(
      join(app, "Contents/Resources/service/runtime.json"),
      JSON.stringify({ version: value }),
    );
  installed(version);
  const lock = join(accountHome, "Library/Caches/com.dzhng.yap/launch.lock");
  const exclusiveFree = () =>
    spawnSync(lockExec, ["exclusive", lock, "/usr/bin/true"]).status === 0;

  server = spawn(launcher, ["mcp"], {
    env: { ...process.env, HOME: scratch, YAP_APP: app },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => server.once("close", resolve));
  let buffered = "";
  const answers = new Map();
  server.stdout.on("data", (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      answers.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const rpc = (method, params) => {
    const id = ++nextId;
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 20_000);
      answers.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return answered;
  };
  const call = async (name = "service.health") => {
    const { result } = await rpc("tools/call", { name, arguments: {} });
    return JSON.parse(result.content[0].text);
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "check", version: "1" },
  });
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  assert.ok(exclusiveFree(), "an idle MCP session must not hold the installation lock");

  holder = spawn(lockExec, ["exclusive", lock, "/bin/cat"], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const during = await call();
  assert.equal(during.error?.code, "UPDATING", JSON.stringify(during));
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("close", resolve));
  holder = undefined;

  const ordinary = await call();
  assert.notEqual(ordinary.error?.code, "UPDATING", JSON.stringify(ordinary));
  assert.equal(
    server.exitCode,
    null,
    "the session stays up while the installed version is its own",
  );

  // A service whose recording.list answers slowly, so one call is still running when another
  // finds the newer version.
  const { createServer } = await import("node:net");
  mkdirSync(join(scratch, ".yap/run"), { recursive: true, mode: 0o700 });
  const service = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffered.slice(0, end));
      const reply = () =>
        socket.end(
          JSON.stringify({ id: request.id, ok: true, data: { operation: request.operation } }) +
            "\n",
        );
      if (request.operation === "recording.list") setTimeout(reply, 1500);
      else reply();
    });
  });
  await new Promise((resolve) => service.listen(join(scratch, ".yap/run/service.sock"), resolve));
  t.after(() => service.close());

  installed("999.0.0");
  const slow = call("recording.list");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const fast = await call();
  assert.equal(fast.ok, true, JSON.stringify(fast));
  assert.deepEqual(await slow, {
    id: (await slow).id,
    ok: true,
    data: { operation: "recording.list" },
  });
  const code = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000)),
  ]);
  assert.equal(code, 0, "the session leaves after its call once a newer version is installed");
});
