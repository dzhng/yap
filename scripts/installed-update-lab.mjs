#!/usr/bin/env node
import { launcherVerdicts } from "./launcher/verdicts.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { releaseSigningInputs, withReleaseIdentity, signReleaseTree } from "./release-signing.mjs";
import { frameworkIdentity } from "./sparkle/framework.mjs";
import { seedSource, populateLibrary, observeLibrary } from "./installed-update-lab/library.mjs";
import { waitForObservation, waitForHealth } from "./installed-update-lab/health.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    app: { type: "string" },
    "sign-update": { type: "string" },
    evidence: { type: "string" },
    "fail-successor-startup": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "node scripts/installed-update-lab.mjs --app <final signed .app> --sign-update <pinned Sparkle bin/sign_update> --evidence <outside-git dir> [--fail-successor-startup]\nRequires approved YAP_RELEASE_* / YAP_SPARKLE_* credential env. Uses retained silent media and production compiled app, service, CLI and patched SDK. Startup-failure case removes only the candidate service entry file, then demonstrates manual reinstall. Deadline: 180 seconds after artifact preparation.",
  );
  process.exit(0);
}
for (const name of ["app", "sign-update", "evidence"])
  assert.ok(values[name], `Missing --${name}; use --help`);
const signing = releaseSigningInputs();
assert.ok(
  !resolve(values.evidence).startsWith(repo + "/") && resolve(values.evidence) !== repo,
  "Evidence must live outside the checkout",
);
mkdirSync(resolve(values.evidence), { recursive: true });
const root = realpathSync(mkdtempSync(join(resolve(values.evidence), "installed-")));
const id = `dev.yap.installed.${randomUUID()}`;
const lockRelative = `Library/Caches/${id}/launch.lock`;
const lockDirectory = join(homedir(), "Library/Caches", id);
const home = join(root, "home"),
  defaults = join(root, "preferences");
const app = join(root, "installed/Yap.app"),
  next = join(root, "candidate/Yap.app");
const launcher = join(root, "yap"),
  plist = (bundle) => join(bundle, "Contents/Info.plist");
const reportPath = join(root, "receipt.json");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const report = {
  outcome: "unverified",
  evidence: root,
  fixtureId: id,
  source: { revision: null, runnerSha256: digest(fileURLToPath(import.meta.url)) },
  substitutions: [
    "unique scratch bundle identifier",
    "signed local feed URL",
    "owned account cache lock namespace",
    "A older version metadata in Info.plist/runtime.json",
    "scratch home and defaults",
    "ATS local-network allowance for controlled HTTP feed",
  ],
  scope: {
    liveOptOutAfterStage:
      "Earlier native owner/SDK cancellation proofs; this run checks persisted Off across startup/quit",
    busyOwners: "Earlier barrier proofs; this run exercises an actual old MCP lifetime",
    permissions: "Prior accepted proof; no TCC/Gatekeeper recheck",
    publishedHTTPS: "Root verifies after publication",
  },
  trace: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const trace = (event, details = {}) => {
  report.trace.push({ event, at: new Date().toISOString(), ...details });
  save();
  console.error(`installed-update: ${event}`);
};
let appChild, client, server, deadline, interrupted;
const children = new Set();
let diagnostics = "";
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 ** 2,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
const preferences = (enabled) => {
  run("defaults", ["write", id, "SUEnableAutomaticChecks", "-bool", String(enabled)]);
  forgetLastCheck();
};
const forgetLastCheck = () => {
  try {
    run("defaults", ["delete", id, "SULastCheckTime"], { stdio: "ignore" });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
};
const env = {
  HOME: homedir(),
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: tmpdir(),
  YAP_HOME: home,
  YAP_DEFAULTS: defaults,
  YAP_APP: app,
  YAP_SERVICE_LAUNCH: "1",
};
const spawnOwned = (command, args, options) => {
  const child = spawn(command, args, options);
  children.add(child);
  child.once("error", (error) => {
    interrupted = error;
  });
  child.once("close", () => children.delete(child));
  return child;
};
const wait = (predicate, label, ms = 30_000) =>
  waitForObservation(predicate, label, {
    timeoutMs: ms,
    interrupted: () => interrupted,
    evidence: reportPath,
  });
function launch() {
  appChild = spawnOwned(join(app, "Contents/MacOS/Yap"), [], {
    cwd: "/",
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  appChild.stderr.on("data", (bytes) => {
    diagnostics += bytes;
    writeFileSync(join(root, "app-diagnostics.log"), diagnostics);
  });
  trace("app-started", { pid: appChild.pid });
}
const cli = (operation, params = {}) => {
  const result = spawnSync(
    launcher,
    [operation, "--socket", join(home, "run/service.sock"), "--params", JSON.stringify(params)],
    { cwd: "/", env, encoding: "utf8", timeout: 5000 },
  );
  if (result.error) throw result.error;
  const reply = JSON.parse(result.stdout);
  trace("cli", { operation, status: result.status, reply });
  return reply;
};
const health = (expectedAvailability) =>
  waitForHealth(() => cli("service.health"), wait, expectedAvailability);
async function quit(child = appChild) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await wait(() => child.exitCode !== null || child.signalCode !== null, "ordinary quit");
}
function ownedProcesses() {
  return run("ps", ["-axo", "pid=,command="])
    .split("\n")
    .filter((line) => line.includes(app + "/Contents/") || line.includes(id))
    .map((line) => Number(line.trim().split(/\s/)[0]))
    .filter((pid) => pid !== process.pid);
}
const stop = () => {
  interrupted = new Error("installed update interrupted");
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  report.source.revision = run("git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
  report.platform = {
    macOS: run("sw_vers", ["-productVersion"]).trim(),
    architecture: process.arch,
  };
  const originalApp = realpathSync(values.app),
    finalLauncher = join(originalApp, "Contents/Resources/bin/yap");
  const originalRuntime = JSON.parse(
    readFileSync(join(originalApp, "Contents/Resources/service/runtime.json")),
  );
  report.payloadSource = {
    revision: originalRuntime.revision,
    version: originalRuntime.version,
    catalogFormat: originalRuntime.catalogFormat,
  };
  run("codesign", ["--verify", "--deep", "--strict", originalApp]);
  run("codesign", ["--verify", "--strict", finalLauncher]);
  report.finalLauncher = {
    sha256: digest(finalLauncher),
    signature: spawnSync("codesign", ["-dv", "--verbose=4", finalLauncher], {
      encoding: "utf8",
      timeout: 5000,
    }).stderr,
    scope:
      "Exact final bundled launcher signature/static scope; live launcher uses documented fixture-only namespace substitution",
  };
  report.engine = frameworkIdentity(join(originalApp, "Contents/Frameworks/Sparkle.framework"));
  report.payload = {};
  for (const relative of [
    "Contents/MacOS/Yap",
    "Contents/MacOS/yap-native",
    "Contents/Resources/node/bin/node",
    "Contents/Resources/cli/main.mjs",
    "Contents/Resources/service/main.mjs",
  ])
    report.payload[relative] = digest(join(originalApp, relative));
  const textDigest = (bundle) =>
    createHash("sha256")
      .update(
        run("otool", ["-s", "__TEXT", "__text", join(bundle, "Contents/MacOS/Yap")], {
          maxBuffer: 32 * 1024 ** 2,
        })
          .split("\n")
          .slice(1)
          .join("\n"),
      )
      .digest("hex");
  report.compiledAppTextSha256 = textDigest(originalApp);
  await new Promise((resolveListen, reject) => {
    server = createServer((request, response) => {
      const name =
        request.url === "/appcast.xml"
          ? "appcast.xml"
          : request.url === "/update.zip"
            ? "update.zip"
            : null;
      if (!name || !existsSync(join(root, name))) {
        response.writeHead(404);
        response.end();
        return;
      }
      trace("feed-request", { path: request.url });
      response.setHeader(
        "Content-Type",
        name === "appcast.xml" ? "application/xml" : "application/zip",
      );
      response.end(readFileSync(join(root, name)));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  run("ditto", [originalApp, app]);
  run("ditto", [originalApp, next]);
  const version = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleVersion",
    plist(next),
  ]).trim();
  assert.equal(
    version,
    JSON.parse(readFileSync(join(repo, "apps/macos/package.json"))).version,
    "The supplied app must match the committed release version",
  );
  const catalogFormat = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :YapCatalogFormat",
    plist(next),
  ]).trim();
  for (const [bundle, candidateVersion] of [
    [app, "0.1.2"],
    [next, version],
  ]) {
    for (const [key, type, value] of [
      ["CFBundleIdentifier", "string", id],
      ["CFBundleVersion", "string", candidateVersion],
      ["CFBundleShortVersionString", "string", candidateVersion],
      ["SUFeedURL", "string", `${url}/appcast.xml`],
      ["YapLaunchLockRelativePath", "string", lockRelative],
    ]) {
      run("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist(bundle)]);
      run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plist(bundle)]);
    }
    try {
      run("/usr/libexec/PlistBuddy", ["-c", "Delete :NSAppTransportSecurity", plist(bundle)], {
        stdio: "ignore",
      });
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    run("/usr/libexec/PlistBuddy", ["-c", "Add :NSAppTransportSecurity dict", plist(bundle)]);
    run("/usr/libexec/PlistBuddy", [
      "-c",
      "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true",
      plist(bundle),
    ]);
    const runtime = join(bundle, "Contents/Resources/service/runtime.json");
    const facts = JSON.parse(readFileSync(runtime));
    facts.version = candidateVersion;
    writeFileSync(runtime, JSON.stringify(facts) + "\n");
  }
  if (values["fail-successor-startup"]) {
    rmSync(join(next, "Contents/Resources/service/main.mjs"));
    report.substitutions.push(
      "Controlled successor startup failure: candidate service entry removed before signing",
    );
  }
  const source = readFileSync(join(repo, "scripts/launcher/main.c"), "utf8");
  const fixtureSource = source.replaceAll("com.dzhng.yap", id);
  assert.notEqual(fixtureSource, source);
  const cfile = join(root, "launcher.c");
  writeFileSync(cfile, fixtureSource);
  run("xcrun", [
    "clang",
    launcherVerdicts,
    "-Wall",
    "-Wextra",
    "-Werror",
    "-arch",
    "arm64",
    "-mmacosx-version-min=26.0",
    cfile,
    "-o",
    launcher,
  ]);
  report.fixtureLauncher = {
    sha256: digest(launcher),
    productionSourceSha256: digest(join(repo, "scripts/launcher/main.c")),
    fixtureSourceSha256: digest(cfile),
    substitution: `com.dzhng.yap -> ${id}`,
  };
  await withReleaseIdentity(signing, async ({ keychain, keyFile, identity }) => {
    for (const bundle of [app, next]) signReleaseTree(bundle, identity, keychain);
    signReleaseTree(launcher, identity, keychain);
    run("ditto", ["-c", "-k", "--keepParent", app, join(root, "previous-0.1.2.zip")]);
    run("ditto", ["-c", "-k", "--keepParent", next, join(root, "update.zip")]);
    const attributes = run(values["sign-update"], [
      "--ed-key-file",
      keyFile,
      join(root, "update.zip"),
    ]).trim();
    writeFileSync(
      join(root, "appcast.xml"),
      `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Installed fixture</title><item><title>${version}</title><sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><yapCatalogFormat>${catalogFormat}</yapCatalogFormat><enclosure url="${url}/update.zip" ${attributes} type="application/octet-stream"/></item></channel></rss>`,
    );
    run(values["sign-update"], ["--ed-key-file", keyFile, join(root, "appcast.xml")]);
    run(values["sign-update"], ["--ed-key-file", keyFile, "--verify", join(root, "appcast.xml")]);
  });
  report.fixtureLauncher.sha256 = digest(launcher);
  for (const bundle of [app, next]) assert.equal(textDigest(bundle), report.compiledAppTextSha256);
  report.artifactPayloads = {};
  for (const [label, bundle] of [
    ["A", app],
    ["B", next],
  ]) {
    report.artifactPayloads[label] = {};
    for (const relative of Object.keys(report.payload))
      report.artifactPayloads[label][relative] = existsSync(join(bundle, relative))
        ? digest(join(bundle, relative))
        : null;
  }
  report.artifacts = {
    previous: digest(join(root, "previous-0.1.2.zip")),
    update: digest(join(root, "update.zip")),
    feed: digest(join(root, "appcast.xml")),
    signingCertificateSha256: signing.certificateSha256,
    publicKey: signing.publicKey,
  };
  deadline = setTimeout(stop, 180_000);
  const media = join(repo, "specs/done/recording-for-ai/assets/agent-mcp-journey/source.mov");
  const seeded = await seedSource(home, media);
  run("defaults", ["write", id, "SUEnableAutomaticChecks", "-bool", "false"]);
  launch();
  await health();
  report.library = await populateLibrary(home, seeded, async (...args) => cli(...args));
  report.before = await observeLibrary(home, report.library, async (...args) => cli(...args));
  save();
  await quit();
  preferences(true);
  // A running command holds the launcher's lock for its whole life (an idle `yap mcp` session
  // does not). A bundled media tool reading stdin stays running until the lab ends it.
  client = spawnOwned(
    launcher,
    [
      "ffmpeg",
      "-hide_banner",
      "-f",
      "s16le",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-f",
      "null",
      "-",
    ],
    { cwd: "/", env, stdio: ["pipe", "pipe", "pipe"] },
  );
  client.stderr.on("data", (bytes) =>
    writeFileSync(join(root, "held-cli-stderr.log"), bytes, { flag: "a" }),
  );
  await delay(1000);
  assert.equal(client.exitCode, null, "The lock-holding command must be running");
  trace("old-cli-held", { pid: client.pid });
  launch();
  report.oldHealth = await health();
  const deferred = await wait(
    () => {
      try {
        const state = cli("service.health").data;
        return state?.update?.state === "failed" && state;
      } catch {
        return false;
      }
    },
    "SDK lock defer",
    60_000,
  );
  trace("replacement-deferred", { health: deferred });
  assert.equal(
    run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", plist(app)]).trim(),
    "0.1.2",
  );
  assert.ok(deferred.update.error, "Defer must remain visible to callers");
  // Sparkle logs the installer cause after its generic XPC-cycle failure. Scope
  // the observer to this owned host and SDK so unrelated app logs never enter evidence.
  const sdkDiagnostics = run("/usr/bin/log", [
    "show",
    "--last",
    "5m",
    "--style",
    "compact",
    "--info",
    "--debug",
    "--predicate",
    `processIdentifier == ${appChild.pid} AND subsystem == "org.sparkle-project.Sparkle"`,
  ]);
  writeFileSync(join(root, "sparkle-diagnostics.log"), sdkDiagnostics);
  report.sdkDiagnostics = {
    pid: appChild.pid,
    sha256: digest(join(root, "sparkle-diagnostics.log")),
  };
  assert.match(
    deferred.update.error.message + "\n" + diagnostics + "\n" + sdkDiagnostics,
    /Launch lock is unavailable/,
    "A generic update failure does not prove launch-lock deferral",
  );
  assert.equal(client.exitCode, null, "The old command must still hold its CLI lifetime");
  assert.equal(client.signalCode, null);
  report.deferredLibrary = await observeLibrary(home, report.library, async (...args) =>
    cli(...args),
  );
  save();
  assert.deepEqual(report.deferredLibrary, report.before);
  run("defaults", ["write", id, "SUEnableAutomaticChecks", "-bool", "false"]);
  await quit();
  client.stdin.end();
  await wait(() => client.exitCode !== null || client.signalCode !== null, "old command exit");
  launch();
  const disabled = await health("disabled");
  trace("persisted-off-relaunch", { health: disabled });
  assert.equal(disabled.update.state, "unavailable");
  assert.equal(disabled.update.availability, "disabled");
  const requestsBefore = report.trace.filter((item) => item.event === "feed-request").length;
  await delay(1500);
  assert.equal(report.trace.filter((item) => item.event === "feed-request").length, requestsBefore);
  await quit();
  preferences(true);
  trace("ordinary-relaunch-for-next-sdk-cycle");
  launch();
  await wait(
    () =>
      run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", plist(app)]).trim() ===
      version,
    "actual bundle replacement",
    60_000,
  );
  trace("bundle-replaced", { version });
  run("codesign", ["--verify", "--deep", "--strict", app]);
  for (const [relative, hash] of Object.entries(report.artifactPayloads.B))
    if (hash !== null)
      assert.equal(
        digest(join(app, relative)),
        hash,
        `Installed payload differs from signed B: ${relative}`,
      );
  if (values["fail-successor-startup"]) {
    const failure = spawnSync(launcher, ["service.health"], {
      cwd: "/",
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    if (failure.error) throw failure.error;
    report.successorFailure = { ...JSON.parse(failure.stdout), exitStatus: failure.status };
    save();
    assert.equal(report.successorFailure.ok, false);
    assert.match(report.successorFailure.error.message, /app|service|install|runtime/i);
    for (const pid of ownedProcesses()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await wait(() => ownedProcesses().length === 0, "failed successor quit");
    rmSync(app, { recursive: true });
    run("ditto", ["-x", "-k", join(root, "previous-0.1.2.zip"), dirname(app)]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    run("defaults", ["write", id, "SUEnableAutomaticChecks", "-bool", "false"]);
    launch();
    report.recoveredHealth = await health();
    assert.equal(report.recoveredHealth.version, "0.1.2");
    trace("specific-previous-release-manually-reinstalled");
  } else {
    report.newHealth = await health();
    save();
    assert.equal(report.newHealth.version, version);
    assert.equal(report.newHealth.home, home);
    assert.notEqual(report.newHealth.pid, report.oldHealth.pid);
    assert.equal(
      digest(launcher),
      report.fixtureLauncher.sha256,
      "Stable launcher was not replaced",
    );
    assert.ok(
      ownedProcesses().some((pid) => pid !== appChild.pid),
      "Quiet successor process must be present",
    );
    const status = cli("capture.status");
    report.quietCaptureStatus = status;
    save();
    assert.equal(status.ok, true);
    assert.equal(status.data.device.state, "idle");
    assert.equal(status.data.device.recordingId, null);
    assert.equal(status.data.device.sourceId, null);
  }
  report.after = await observeLibrary(home, report.library, async (...args) => cli(...args));
  save();
  assert.deepEqual(report.after, report.before);
  assert.equal(report.after.originalSha256, seeded.sha256);
  assert.equal(report.after.managedOriginalSha256, seeded.sha256);
  report.outcome = "passed";
  trace("accepted-with-narrow-scope");
} catch (error) {
  report.outcome = "failed";
  report.error = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  interrupted = undefined;
  client?.stdin.end();
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const cleanupErrors = [];
  const signalOwned = (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") cleanupErrors.push(error.message);
    }
  };
  for (const pid of ownedProcesses()) signalOwned(pid, "SIGTERM");
  await delay(1000);
  const survivors = ownedProcesses();
  for (const pid of survivors) signalOwned(pid, "SIGKILL");
  try {
    await wait(() => ownedProcesses().length === 0, "owned-process cleanup", 5000);
  } catch (error) {
    cleanupErrors.push(error.message);
  }
  await new Promise((close) => (server ? server.close(close) : close()));
  try {
    run("defaults", ["delete", id], { stdio: "ignore" });
  } catch (error) {
    if (error.status !== 1) cleanupErrors.push(error.message);
  }
  const remaining = ownedProcesses();
  if (!remaining.length) {
    for (const path of [
      lockDirectory,
      home,
      defaults + ".plist",
      app,
      next,
      launcher,
      join(root, "launcher.c"),
    ]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
  }
  report.cleanup = {
    ownedProcessesRemaining: remaining,
    forcedPids: survivors,
    removedAccountNamespace: lockRelative,
    errors: cleanupErrors,
  };
  if (cleanupErrors.length || remaining.length) {
    report.outcome = "failed";
    process.exitCode = 1;
  }
  save();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  console.error(`installed-update receipt: ${reportPath}`);
}
