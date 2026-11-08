#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { credentials } from "./auth.mjs";
import { runContainer } from "./container.mjs";
import { releaseCli } from "./release.mjs";
import { judgePrompt, parseJudgment } from "./judgment.mjs";
import { skillCaseFiles } from "./runtime/skills.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "..");
const image = "yap-evals:local";
const cases = JSON.parse(await readFile(join(directory, "cases.json"), "utf8"));
const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    agents: { type: "string", default: "codex,claude" },
    judge: { type: "string", default: "codex" },
    cases: { type: "string" },
    repeats: { type: "string", default: "2" },
    timeout: { type: "string", default: "180" },
    output: { type: "string" },
    cli: { type: "string" },
    release: { type: "string", default: "latest" },
    "contracts-only": { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Usage: node evals/run.mjs [options]
  --agents codex,claude   Runner CLIs (default: both)
  --judge codex|claude    Separate judge CLI (default: codex)
  --cases ID,...         Selected cases (${cases.map((c) => c.id).join(", ")})
  --repeats N            Fresh trials per agent/case (default: 2)
  --timeout SECONDS      Per-container deadline (default: 180)
  --output DIRECTORY     New report directory (default: evals/results/<run-id>)
  --release TAG          Verified GitHub release (default: latest stable)
  --cli BUNDLE.mjs       Use a local standalone CLI bundle instead of a release
  --contracts-only      Run offline fixture controls without model calls or auth
  -h, --help             Show this usage
Requires Node 24, Docker and tar. Model trials reuse existing CLI sign-ins or
OPENAI_API_KEY / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN. No login is changed.
Model calls are billable according to the selected provider/account.`);
  process.exit(0);
}
const agents = values.agents.split(",");
if ([...agents, values.judge].some((agent) => !["codex", "claude"].includes(agent)))
  throw new Error("Agents and judge must be codex or claude");
const repeats = Number(values.repeats),
  timeoutMs = Number(values.timeout) * 1000;
if (
  !Number.isSafeInteger(repeats) ||
  repeats < 1 ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1
)
  throw new Error("Repeats and timeout must be positive integers");
const selected = values.cases ? cases.filter((c) => values.cases.split(",").includes(c.id)) : cases;
if (!selected.length || values.cases?.split(",").some((id) => !cases.some((c) => c.id === id)))
  throw new Error("Unknown or empty case selection");
const output = resolve(
  values.output ??
    join(
      directory,
      "results",
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
    ),
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const summary = {
  startedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  agents,
  cases: selected.map((testCase) => testCase.id),
  judge: values.judge,
  repeats,
  plannedTrials: values["contracts-only"] ? 0 : selected.length * agents.length * repeats,
  results: [],
};
async function saveSummary() {
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}
async function skillFiles() {
  const source = join(root, "skills/yap");
  const files = {};
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[relative(source, path)] = await readFile(path);
    }
  return files;
}
try {
  const skill = await skillFiles();
  const readme = await readFile(join(root, "README.md"));
  summary.inputs = Object.fromEntries(
    Object.entries({
      ...skill,
      "README.md": readme,
      "cases.json": await readFile(join(directory, "cases.json")),
    }).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]),
  );
  summary.sourceDirty = !!execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const auth = {};
  if (!values["contracts-only"])
    for (const agent of new Set([...agents, values.judge])) auth[agent] = await credentials(agent);
  console.log(`Building eval image; artifacts: ${output}`);
  const build = spawn(
    "docker",
    [
      "build",
      "--iidfile",
      join(output, "image.id"),
      "--tag",
      image,
      "--file",
      join(directory, "Dockerfile"),
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buildLog = "";
  build.stdout.on("data", (b) => (buildLog += b));
  build.stderr.on("data", (b) => (buildLog += b));
  const buildExit = await new Promise((resolve, reject) => {
    build.once("exit", resolve);
    build.once("error", reject);
  });
  await writeFile(join(output, "build.log"), buildLog);
  if (buildExit !== 0) throw new Error("Eval image build failed; see build.log");
  summary.image = (await readFile(join(output, "image.id"), "utf8")).trim();
  const cli = values.cli
    ? { bundle: await readFile(resolve(values.cli)), receipt: { source: resolve(values.cli) } }
    : await releaseCli({
        tag: values.release,
        cache: join(directory, ".cache"),
        image: summary.image,
      });
  summary.cli = { ...cli.receipt, sha256: createHash("sha256").update(cli.bundle).digest("hex") };
  const controls = await runContainer({
    image: summary.image,
    network: false,
    timeoutMs,
    request: { mode: "contracts" },
    files: { "cli/main.mjs": cli.bundle },
  });
  await writeFile(join(output, "contracts.json"), JSON.stringify(controls, null, 2) + "\n");
  if (controls.error || controls.passed !== 6)
    throw new Error("Portable CLI fixture controls failed; see contracts.json");
  console.log("Portable fixture controls: 6 passed");
  for (const testCase of values["contracts-only"] ? [] : selected)
    for (const agent of agents)
      for (let trial = 1; trial <= repeats; trial++) {
        const name = `${testCase.id}-${agent}-${trial}`;
        console.log(`Running ${name}`);
        const target = testCase.readme
          ? "work/skills/yap"
          : `work/${agent === "codex" ? ".agents" : ".claude"}/skills/yap`;
        const files = Object.fromEntries(
          Object.entries(skill).map(([path, bytes]) => [`${target}/${path}`, bytes]),
        );
        if (testCase.readme) files["work/README.md"] = readme;
        if (testCase.fixture?.startsWith("skill-"))
          Object.assign(files, skillCaseFiles(skill, testCase.fixture));
        if (testCase.readme) {
          const prefix = testCase.fixture?.startsWith("skill-")
            ? "work/upstream/skills/yap/"
            : "work/skills/yap/";
          files["work/SOURCE.json"] = JSON.stringify({
            kind: "complete controlled consumer-source mirror; acquisition only",
            sourceRevision: summary.sourceRevision,
            sourceDirty: summary.sourceDirty,
            files: Object.fromEntries(
              Object.entries(files)
                .filter(([path]) => path.startsWith(prefix))
                .map(([path, bytes]) => [
                  path.slice(prefix.length),
                  createHash("sha256").update(bytes).digest("hex"),
                ]),
            ),
          });
        }
        if (testCase.fixture?.startsWith("update-health-"))
          files["work/health.json"] = JSON.stringify({
            fixtureOnly: true,
            schemaStatus: "controlled service.health projection; native execution unverified",
            version: "fixture-version",
            status: "ready",
            update: testCase.fixture.endsWith("waiting")
              ? {
                  state: "queued",
                  jobId: null,
                  availability: "available",
                  availableVersion: "fixture-next",
                  blockers: ["capture", "delivery"],
                  error: null,
                }
              : {
                  state: "unavailable",
                  jobId: null,
                  availability: "disabled",
                  availableVersion: null,
                  blockers: [],
                  error: null,
                },
          });
        if (testCase.cli) files["cli/main.mjs"] = cli.bundle;
        const artifact = await runContainer({
          image: summary.image,
          timeoutMs,
          auth: auth[agent],
          files,
          request: { agent, prompt: testCase.prompt, fixture: testCase.fixture },
        });
        await writeFile(
          join(output, `${name}.runner.json`),
          JSON.stringify(artifact, null, 2) + "\n",
        );
        if (artifact.error) throw new Error(`${name}: ${artifact.error}`);
        const judged = await runContainer({
          image: summary.image,
          timeoutMs,
          auth: auth[values.judge],
          files: { "judge-schema.json": await readFile(join(directory, "judge-schema.json")) },
          request: { agent: values.judge, judge: true, prompt: judgePrompt(testCase, artifact) },
        });
        await writeFile(join(output, `${name}.judge.json`), JSON.stringify(judged, null, 2) + "\n");
        if (judged.error) throw new Error(`${name} judge: ${judged.error}`);
        const verdict = parseJudgment(judged);
        summary.results.push({ case: testCase.id, agent, trial, ...verdict });
        await saveSummary();
        console.log(`${name}: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.evidence.join(" ")}`);
      }
  summary.completedAt = new Date().toISOString();
  await saveSummary();
  const passed = summary.results.filter((r) => r.pass).length;
  console.log(`Finished: ${passed}/${summary.results.length} agent trials passed. ${output}`);
  if (passed !== summary.results.length) process.exitCode = 1;
} catch (error) {
  summary.error = error.message;
  await saveSummary();
  console.error(error.message);
  process.exitCode = 1;
}
