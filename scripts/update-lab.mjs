#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { frameworkIdentity } from "./sparkle/framework.mjs";
import { appcast } from "./release-info.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    framework: { type: "string" },
    "host-controlled-installation": { type: "boolean", default: false },
    "retain-public-fixtures": { type: "boolean", default: false },
  },
});
const scenario = positionals[0];
if (
  ![
    "stopped-launch",
    "hold",
    "crash",
    "incompatible",
    "install",
    "format-route",
    "disable-quit",
    "busy-quit",
    "unconfirmed-crash",
    "stalled-helper-crash",
    "cancel-install",
    "authorized-channel-loss",
    "mcp-lock",
    "stalled-timeout",
    "install-skip",
    "disable-extract-quit",
    "unsigned-feed",
    "tampered-feed",
    "missing-format",
    "malformed-format",
    "bad-archive-signature",
    "missing-signature",
    "corrupt-archive",
    "equal",
    "older",
  ].includes(scenario)
)
  throw new Error("Select a scenario from scripts/update-lab.test.mjs");
const distribution = join(tmpdir(), "yap-sparkle-2.10.0.tar.xz");
const digest = "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c";
const commands = new Set();
let interrupted;
let cleaning = false;
const endAt = Date.now() + 60_000;
function killCommand(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function run(command, args) {
  if (interrupted && !cleaning) throw interrupted;
  const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  commands.add(child);
  let stdout = "",
    stderr = "",
    spawnError;
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  child.once("error", (error) => {
    spawnError = error;
  });
  const timer = setTimeout(
    () => killCommand(child),
    cleaning ? 5000 : Math.max(1, Math.min(20_000, endAt - Date.now())),
  );
  try {
    await new Promise((resolveClose, reject) =>
      child.once("close", (code, signal) => {
        if (spawnError) reject(spawnError);
        else if (code !== 0)
          reject(
            Object.assign(
              interrupted && !cleaning
                ? interrupted
                : new Error(`${command} exited ${signal ?? code}: ${stderr}`),
              { status: code },
            ),
          );
        else resolveClose();
      }),
    );
    if (interrupted && !cleaning) throw interrupted;
    return stdout;
  } finally {
    clearTimeout(timer);
    commands.delete(child);
  }
}
const root = mkdtempSync(join(tmpdir(), "yap-update-lab-"));
const frameworkRoot = join(root, "sparkle");
const id = `dev.yap.update-lab.${randomUUID()}`;
const lockDirectory = join(homedir(), "Library", "Caches", id);
const lockPath = join(lockDirectory, "launch.lock");
const eventsPath = join(root, "events.jsonl");
const events = () =>
  existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyPath = join(root, "key");
let child;
let client;
let clientDone;
let server;
let stderr = "";
const receipt = {
  scenario,
  evidence: root,
  source: {
    revision: null,
    runnerSha256: createHash("sha256").update(readFileSync("scripts/update-lab.mjs")).digest("hex"),
    appSourceSha256: createHash("sha256")
      .update(readFileSync("scripts/update-lab/main.m"))
      .digest("hex"),
    frameworkIdentitySha256: createHash("sha256")
      .update(readFileSync("scripts/sparkle/framework.mjs"))
      .digest("hex"),
  },
  inputs: {
    hostControlledInstallation: values["host-controlled-installation"],
    retainedPublicFixtures: values["retain-public-fixtures"],
    executionContext: { YAP_HOME: join(root, "home"), YAP_DEFAULTS: `${id}.settings` },
    publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  },
  sparkle: { version: "2.10.0", distributionSha256: digest },
};
let childDone = false;
let childCompletion;

const interrupt = () => {
  interrupted = new Error("updater lab interrupted");
  for (const command of commands) killCommand(command);
};
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
const deadline = setTimeout(() => {
  interrupted = new Error("updater lab exceeded its 60-second deadline");
  for (const command of commands) killCommand(command);
}, 60_000);
const cleanupFailure = (error) => {
  console.error(error.message);
  process.exitCode = 1;
};
console.error(`update-lab: ${root}`);
try {
  receipt.platform = (await run("sw_vers", ["-productVersion"])).trim();
  receipt.architecture = process.arch;
  receipt.source.revision = (await run("git", ["rev-parse", "HEAD"])).trim();
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });
  if (!existsSync(distribution)) {
    const incoming = `${distribution}.${randomUUID()}`;
    try {
      await run("curl", [
        "-fL",
        "https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz",
        "-o",
        incoming,
      ]);
      assert.equal(createHash("sha256").update(readFileSync(incoming)).digest("hex"), digest);
      renameSync(incoming, distribution);
    } finally {
      rmSync(incoming, { force: true });
    }
  }
  assert.equal(createHash("sha256").update(readFileSync(distribution)).digest("hex"), digest);
  if (interrupted) throw interrupted;
  mkdirSync(frameworkRoot);
  await run("tar", ["-xf", distribution, "-C", frameworkRoot]);
  if (values.framework) {
    const framework = join(frameworkRoot, "Sparkle.framework");
    rmSync(framework, { recursive: true });
    await run("ditto", [values.framework, framework]);
    receipt.sparkle.engine = "provided-framework";
    receipt.sparkle.frameworkSha256 = frameworkIdentity(framework).sha256;
  } else receipt.sparkle.engine = "upstream";
  writeFileSync(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    { mode: 0o600 },
  );
  const publicBytes = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  let archiveRequests = 0;
  server = createServer((req, res) => {
    const path = req.url === "/appcast.xml" ? join(root, "appcast.xml") : join(root, "update.zip");
    if (req.url !== "/appcast.xml") archiveRequests++;
    res.setHeader(
      "Content-Type",
      req.url === "/appcast.xml" ? "application/xml" : "application/zip",
    );
    res.end(readFileSync(path));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(Number(positionals[1] ?? 0), "127.0.0.1", resolveListen);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  receipt.inputs.fixtureURL = url;
  const executable = join(root, "UpdateLab");
  await run("clang", [
    "-fobjc-arc",
    "-framework",
    "Cocoa",
    "-F",
    frameworkRoot,
    "-framework",
    "Sparkle",
    "-Wl,-rpath,@executable_path/../Frameworks",
    "scripts/update-lab/main.m",
    "-o",
    executable,
  ]);
  const app = join(root, "installed", "UpdateLab.app");
  const next = join(root, "candidate", "UpdateLab.app");
  const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  async function build(path, version) {
    mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(path, "Contents", "Frameworks"), { recursive: true });
    await run("ditto", [executable, join(path, "Contents", "MacOS", "UpdateLab")]);
    await run("ditto", [
      join(frameworkRoot, "Sparkle.framework"),
      join(path, "Contents", "Frameworks", "Sparkle.framework"),
    ]);
    const fields = {
      LabScenario: scenario,
      LabRoot: root,
      LabHostControlsInstallation: values["host-controlled-installation"],
      CFBundleIdentifier: id,
      CFBundleExecutable: "UpdateLab",
      CFBundleName: "UpdateLab",
      CFBundlePackageType: "APPL",
      CFBundleVersion: version,
      CFBundleShortVersionString: version,
      LSUIElement: true,
      SUFeedURL: `${url}/appcast.xml`,
      SUPublicEDKey: publicBytes,
      SUEnableAutomaticChecks: true,
      SUAutomaticallyUpdate: false,
      SUAllowsAutomaticUpdates: false,
      SURequireSignedFeed: true,
      SUVerifyUpdateBeforeExtraction: true,
      SUSignedFeedFailureExpirationInterval: 0,
      YapLaunchLockRelativePath: `Library/Caches/${id}/launch.lock`,
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    };
    const plist = (obj) =>
      "<dict>" +
      Object.entries(obj)
        .map(
          ([k, v]) =>
            `<key>${k}</key>${typeof v === "boolean" ? `<${v}/>` : typeof v === "object" ? plist(v) : typeof v === "number" ? `<integer>${v}</integer>` : `<string>${xml(v)}</string>`}`,
        )
        .join("") +
      "</dict>";
    writeFileSync(
      join(path, "Contents", "Info.plist"),
      `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${plist(fields)}</plist>`,
    );
    await run("codesign", ["--force", "--deep", "--sign", "-", path]);
  }
  const candidateVersion =
    scenario === "equal" ? "0.1.0" : scenario === "older" ? "0.0.9" : "0.1.1";
  await build(app, "0.1.0");
  await build(next, candidateVersion);
  if (values["retain-public-fixtures"]) {
    await run("ditto", ["-c", "-k", "--keepParent", app, join(root, "old.zip")]);
    receipt.inputs.oldArchiveSha256 = createHash("sha256")
      .update(readFileSync(join(root, "old.zip")))
      .digest("hex");
  }
  await run("ditto", ["-c", "-k", "--keepParent", next, join(root, "update.zip")]);
  let attrs = (
    await run(join(frameworkRoot, "bin", "sign_update"), [
      "--ed-key-file",
      keyPath,
      join(root, "update.zip"),
    ])
  ).trim();
  if (scenario === "missing-signature") attrs = attrs.replace(/sparkle:edSignature="[^"]+"/, "");
  if (scenario === "bad-archive-signature")
    attrs = attrs.replace(
      /sparkle:edSignature="[^"]+"/,
      'sparkle:edSignature="' + Buffer.alloc(64).toString("base64") + '"',
    );
  const format =
    scenario === "incompatible" ? "24" : scenario === "malformed-format" ? "23x" : "23";
  const formatElement =
    scenario === "missing-format" ? "" : `<yapCatalogFormat>${format}</yapCatalogFormat>`;
  writeFileSync(
    join(root, "appcast.xml"),
    scenario === "format-route"
      ? // The release feed for a candidate writing format 24 and opening 22 onward, read by an
        // app on 0.1.0 that wrote format 23.
        appcast({
          facts: { version: candidateVersion, catalogFormat: 24, minimumCatalogFormat: 22 },
          title: "Lab",
          enclosure: `<enclosure url="${url}/update.zip" ${attrs} type="application/octet-stream"/>`,
          formatSince: { 22: "0.0.1", 23: "0.1.0", 24: "0.1.1" },
        })
      : `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Lab</title><item><title>0.1.1</title><sparkle:version>${candidateVersion}</sparkle:version><sparkle:shortVersionString>${candidateVersion}</sparkle:shortVersionString>${formatElement}<enclosure url="${url}/update.zip" ${attrs} type="application/octet-stream"/></item></channel></rss>`,
  );
  if (scenario !== "unsigned-feed")
    await run(join(frameworkRoot, "bin", "sign_update"), [
      "--ed-key-file",
      keyPath,
      join(root, "appcast.xml"),
    ]);
  if (scenario === "tampered-feed")
    writeFileSync(
      join(root, "appcast.xml"),
      readFileSync(join(root, "appcast.xml"), "utf8").replace(
        "<title>Lab</title>",
        "<title>Tampered</title>",
      ),
    );
  if (scenario === "corrupt-archive") writeFileSync(join(root, "update.zip"), Buffer.alloc(1024));
  receipt.inputs.appcastSha256 = createHash("sha256")
    .update(readFileSync(join(root, "appcast.xml")))
    .digest("hex");
  receipt.inputs.archiveSha256 = createHash("sha256")
    .update(readFileSync(join(root, "update.zip")))
    .digest("hex");
  const wait = async (predicate, label, timeout = 45_000, allowExit = false) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (interrupted) throw interrupted;
      if (await predicate()) return;
      if (childDone && !allowExit)
        throw new Error(`fixture exited ${child.signalCode ?? child.exitCode}; evidence ${root}`);
      await delay(50);
    }
    throw new Error(`${label} timed out; evidence ${root}; events ${JSON.stringify(events())}`);
  };
  const command = (value) => writeFileSync(join(root, "command"), value);
  if (interrupted) throw interrupted;
  if (scenario === "stopped-launch") writeFileSync(join(root, "stop"), "stop");
  child = spawn(join(app, "Contents", "MacOS", "UpdateLab"), [], {
    env: { ...process.env, ...receipt.inputs.executionContext, YAP_UPDATE_LAB: root },
    stdio: ["ignore", "ignore", "pipe"],
  });
  childCompletion = new Promise((resolveExit) => {
    child.once("exit", () => {
      childDone = true;
      resolveExit();
    });
    child.once("error", (error) => {
      interrupted = error;
      childDone = true;
      resolveExit();
    });
  });
  child.stderr.on("data", (b) => (stderr += b));
  writeFileSync(join(root, "pid"), String(child.pid));
  await wait(() => events().some((e) => e.event === "launch"), "launch");
  command("check");
  if (scenario === "stopped-launch") await wait(() => childDone, "stopped launch");
  else if (["incompatible", "missing-format", "malformed-format"].includes(scenario))
    await wait(() => events().some((e) => e.event === "candidate"), "candidate");
  else if (
    [
      "unsigned-feed",
      "tampered-feed",
      "bad-archive-signature",
      "missing-signature",
      "corrupt-archive",
      "equal",
      "older",
    ].includes(scenario)
  )
    await wait(() => events().some((e) => e.event === "cycle"), "refusal");
  else if (scenario === "disable-extract-quit") {
    await wait(() => childDone, "extraction quit");
    await delay(2000);
  } else {
    await wait(() => events().some((e) => e.event === "ready"), "preparation");
    if (scenario === "hold") await wait(() => false, "held fixture");
    else if (scenario === "install" || scenario === "format-route") {
      command("install");
      await wait(
        async () =>
          (
            await run("/usr/libexec/PlistBuddy", [
              "-c",
              "Print :CFBundleVersion",
              join(app, "Contents", "Info.plist"),
            ])
          ).trim() === "0.1.1",
        "replacement",
        45_000,
        true,
      );
      await wait(
        () => events().some((e) => e.event === "launch" && e.version === "0.1.1"),
        "relaunch",
        45_000,
        true,
      );
    } else if (scenario === "stalled-timeout") {
      command("install");
      await wait(() => events().some((e) => e.event === "stalled"), "stalled host");
      await delay(22_000);
      const helper = join(root, "lock-exec");
      await run("clang", [
        "-Wall",
        "-Wextra",
        "-Werror",
        "scripts/launcher-lab/lock-exec.c",
        "-o",
        helper,
      ]);
      try {
        await run(helper, ["shared", lockPath, "/usr/bin/true"]);
        receipt.inputs.pausedLockStatus = 0;
      } catch (error) {
        if (error.status !== 75) throw error;
        receipt.inputs.pausedLockStatus = error.status;
      }
      child.kill("SIGCONT");
      await wait(() => events().some((e) => e.event === "cycle"), "timeout cancellation");
    } else if (scenario === "stalled-helper-crash") {
      command("install");
      await wait(() => events().some((e) => e.event === "stalled"), "stalled host");
      const installers = (await run("pgrep", ["-fl", `${root}|${id}`]))
        .trim()
        .split("\n")
        .filter((line) => /\/Autoupdate(?: |$)/.test(line));
      assert.equal(installers.length, 1, JSON.stringify(installers));
      const installerPid = Number(installers[0].split(" ")[0]);
      receipt.inputs.installerCrash = { pid: installerPid, signal: "SIGKILL" };
      process.kill(installerPid, "SIGKILL");
      await wait(
        () => {
          try {
            process.kill(installerPid, 0);
            return false;
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        },
        "crashed installer",
        5000,
      );
      child.kill("SIGCONT");
      await wait(() => events().some((e) => e.event === "cycle"), "failed cycle");
    } else if (scenario === "install-skip") {
      command(scenario);
      await wait(() => events().some((e) => e.event === "cycle"), "queued cancellation", 5000);
    } else if (scenario === "mcp-lock") {
      const helper = join(root, "lock-exec");
      const cli = join(root, "cli.mjs");
      await run("clang", [
        "-Wall",
        "-Wextra",
        "-Werror",
        "scripts/launcher-lab/lock-exec.c",
        "-o",
        helper,
      ]);
      await run("bun", ["scripts/launcher-lab/build-cli.mjs", process.cwd(), cli]);
      client = spawn(helper, ["shared", lockPath, process.execPath, cli, "mcp"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      clientDone = new Promise((resolve) => client.once("close", resolve));
      let output = "";
      let clientError;
      let tools;
      client.once("error", (error) => {
        clientError = error;
      });
      client.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      client.stdout.on("data", (bytes) => {
        output += bytes;
        for (const line of output.split("\n")) {
          try {
            const message = JSON.parse(line);
            if (message.id === 2) tools = message.result?.tools?.map((tool) => tool.name);
          } catch {}
        }
      });
      client.stdin.on("error", (error) => {
        clientError = error;
      });
      client.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "updater-lock-proof", version: "1" },
          },
        }) + "\n",
      );
      client.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
      client.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
      );
      await wait(
        () => {
          if (clientError) throw clientError;
          return tools;
        },
        "live MCP tools",
        5000,
      );
      receipt.inputs.client = {
        tools,
        cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
        lockSourceSha256: createHash("sha256")
          .update(readFileSync("scripts/launcher-lab/lock-exec.c"))
          .digest("hex"),
        nodeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      };
      command("install");
      await wait(() => events().some((e) => e.event === "cycle"), "lock refusal", 5000);
      assert.equal(client.exitCode, null, "MCP client unexpectedly exited");
      command("probe-lock");
      await wait(() => events().some((e) => e.event === "lockProbe"), "usable host");
    } else if (scenario === "authorized-channel-loss") {
      command("install");
      await wait(
        () => events().some((e) => e.event === "channelInvalidated"),
        "invalidated channel",
      );
      await wait(() => events().some((e) => e.event === "cycle"), "failed cycle");
      // The pinned helper cancels a live host after 20s; keep the host alive
      // past that boundary, then observe the kernel lock rather than inferring
      // cleanup from the earlier failed SDK cycle.
      await delay(22_000);
      command("probe-lock");
      await wait(() => events().some((e) => e.event === "lockProbe"), "lock probe");
    } else if (scenario === "cancel-install") {
      command("install");
      await wait(() => events().some((e) => e.event === "installProgress"), "held exclusion");
      command("disable");
      await wait(() => events().some((e) => e.event === "cycle"), "cancelled cycle", 5000);
      command("quit");
      await wait(() => childDone, "quit");
    } else if (scenario === "unconfirmed-crash") {
      command("install");
      await wait(() => events().some((e) => e.event === "installProgress"), "held exclusion");
      child.kill("SIGKILL");
      await wait(() => childDone, "crashed host", 5000, true);
      await delay(2000);
    } else if (scenario === "busy-quit") {
      command("quit");
      await wait(() => childDone, "quit");
      await delay(2000);
    } else {
      command("disable");
      await wait(() => events().some((e) => e.event === "dismiss"), "cancel");
      command("quit");
      await wait(() => childDone, "quit");
      await delay(500);
    }
  }
  const installedVersion = (
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleVersion",
      join(app, "Contents", "Info.plist"),
    ])
  ).trim();
  const verdict =
    installedVersion !== "0.1.0" && !["install", "format-route"].includes(scenario)
      ? "rejected"
      : "observed";
  const report = {
    scenario,
    verdict,
    installedVersion,
    archiveRequests,
    events: events(),
    evidence: root,
    stderr,
    ...receipt,
  };
  if (verdict === "rejected") process.exitCode = 1;
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = {
    ...receipt,
    verdict: "failed",
    error: error.message,
    evidence: root,
    events: events(),
    stderr,
  };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  cleaning = true;
  writeFileSync(join(root, "stop"), "stop");
  clearTimeout(deadline);
  process.removeListener("SIGTERM", interrupt);
  process.removeListener("SIGINT", interrupt);
  rmSync(keyPath, { force: true });
  if (client) {
    client.kill("SIGKILL");
    await clientDone;
  }
  if (child && !childDone) child.kill("SIGKILL");
  // Kill relaunch producers first; persistent stop intent also covers launches
  // already queued to LaunchServices before the producer died.
  let helperScanFailed = false;
  const reapUntil = Date.now() + 5000;
  for (;;) {
    let owned = [];
    try {
      owned = (await run("pgrep", ["-fl", `${root}|${id}`]))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = /^(\d+) (.+)$/.exec(line);
          return {
            pid: Number(match[1]),
            app: match[2].includes("UpdateLab.app/Contents/MacOS/UpdateLab"),
          };
        })
        .sort((a, b) => Number(a.app) - Number(b.app));
    } catch (error) {
      if (error.status !== 1) {
        cleanupFailure(error);
        helperScanFailed = true;
      }
    }
    if (!owned.length) break;
    for (const item of owned) {
      try {
        process.kill(item.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") cleanupFailure(error);
      }
    }
    if (Date.now() >= reapUntil) {
      helperScanFailed = true;
      cleanupFailure(new Error("owned updater helpers did not stop; scratch binaries retained"));
      break;
    }
    await delay(25);
  }
  if (childCompletion) await childCompletion;
  if (server?.listening) await new Promise((r) => server.close(r));
  if (!helperScanFailed)
    for (const path of [
      "installed",
      "candidate",
      "sparkle",
      "UpdateLab",
      ...(!values["retain-public-fixtures"] ? ["update.zip"] : []),
      "command",
      "pid",
      "cli.mjs",
      "lock-exec",
    ])
      rmSync(join(root, path), { force: true, recursive: true });
  if (!helperScanFailed)
    rmSync(join(homedir(), "Library", "Caches", id), { recursive: true, force: true });
  try {
    await run("defaults", ["delete", id]);
  } catch (error) {
    if (error.status !== 1) cleanupFailure(error);
  }
}
