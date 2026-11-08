import { readFile, mkdir, cp, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { agentResult } from "./agent-result.mjs";
import { deletionFixture, failedJobFixture } from "./fixture.mjs";
import { contracts } from "./contracts.mjs";
import { projectSnapshot } from "./skills.mjs";

async function lines(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function execute(request) {
  if (request.mode === "extract-cli")
    return {
      bundleBase64: execFileSync(
        "unzip",
        ["-p", "/sandbox/release.zip", "Yap.app/Contents/Resources/cli/main.mjs"],
        { maxBuffer: 8 * 1024 * 1024 },
      ).toString("base64"),
    };
  if (request.mode === "contracts") return await contracts();
  await mkdir("/sandbox/home", { recursive: true });
  if (request.fixture?.startsWith("skill-")) {
    await mkdir("/sandbox/work/backups", { recursive: true });
    process.env.TMPDIR = "/sandbox/work/backups";
    process.env.DISABLE_TELEMETRY = "1";
    process.env.NODE_DISABLE_COMPILE_CACHE = "1";
  }
  let fixtureSetup;
  if (request.fixture?.startsWith("skill-") && request.fixture !== "skill-install") {
    await cp("/sandbox/work/.agents/skills/yap", "/sandbox/customized-source", {
      recursive: true,
    });
    await rm("/sandbox/work/.agents/skills/yap", { recursive: true });
    const command = [
      "--yes",
      "skills@1.7.0",
      "add",
      "/sandbox/customized-source",
      "--skill",
      "yap",
      "--agent",
      "codex",
      "claude-code",
      "--yes",
    ];
    fixtureSetup = {
      command: ["npx", ...command],
      stdout: execFileSync("npx", command, { cwd: "/sandbox/work", encoding: "utf8" }),
      exit: 0,
    };
  }
  const beforeProjectFiles = request.fixture
    ? await projectSnapshot("/sandbox/work", 500)
    : undefined;
  const close =
    request.fixture === "failed-job"
      ? await failedJobFixture()
      : await deletionFixture(request.fixture);
  try {
    // Docker isolates runners; its default restrictions prevent nested bwrap namespaces.
    const args =
      request.agent === "codex"
        ? [
            "exec",
            "--ignore-user-config",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            request.judge ? "read-only" : "danger-full-access",
            "--json",
            ...(request.judge ? ["--output-schema", "/sandbox/judge-schema.json"] : []),
            "-",
          ]
        : [
            "-p",
            "--model",
            "opus",
            "--effort",
            "high",
            "--tools",
            request.judge ? "" : "Read,Glob,Grep,Skill,Bash",
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            "Bash",
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--verbose",
            "--output-format",
            "stream-json",
            ...(request.judge
              ? ["--json-schema", await readFile("/sandbox/judge-schema.json", "utf8")]
              : []),
          ];
    const child = spawn(request.agent, args, {
      cwd: "/sandbox/work",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => (stdout += bytes));
    child.stderr.on("data", (bytes) => (stderr += bytes));
    child.stdin.end(request.prompt);
    const exit = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    let result, error;
    try {
      result = agentResult(request.agent, stdout, exit);
    } catch (e) {
      error = e.message;
    }
    return {
      agent: request.agent,
      version: execFileSync(request.agent, ["--version"], { encoding: "utf8" }).trim(),
      platform: process.platform,
      architecture: process.arch,
      exit,
      stdout,
      stderr,
      ...result,
      error,
      cliCalls: await lines("/sandbox/cli-calls.jsonl"),
      serviceCalls: await lines("/sandbox/service-calls.jsonl"),
      beforeProjectFiles,
      fixtureSetup,
      projectFiles: request.fixture ? await projectSnapshot("/sandbox/work", 500) : undefined,
    };
  } finally {
    await close?.();
  }
}
try {
  const request = JSON.parse(await readFile("/sandbox/request.json", "utf8"));
  const result = await execute(request);
  console.log(JSON.stringify(result));
  if (result.error) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
