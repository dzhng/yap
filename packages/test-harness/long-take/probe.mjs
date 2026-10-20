import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const usage = `node packages/test-harness/long-take/probe.mjs --output NEW_SCRATCH_DIRECTORY
  [--hours 1,2.2,12 | --seconds N] [--profiles pcm,cursor-typical,cursor-worst,events,camera,combined-typical,combined-worst]
  [--stroke-seconds 300] [--pcm-hz 94] [--cursor-hz 60] [--camera-hz 30]
  [--budget-seconds 3600] [--build EXISTING_PROBE_BUILD]
Each length has one wall-clock budget including generation and all stages. Progress every 10s.
The report and logs stay in scratch; large generated files are removed after each profile.`;
const options = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, n) =>
    process.argv.slice(2 + n * 2, 4 + n * 2),
  ),
);
if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
const allowed = new Set([
  "--output",
  "--hours",
  "--seconds",
  "--profiles",
  "--stroke-seconds",
  "--pcm-hz",
  "--cursor-hz",
  "--camera-hz",
  "--budget-seconds",
  "--build",
]);
if (!options["--output"] || Object.keys(options).some((k) => !allowed.has(k))) throw Error(usage);
const output = resolve(options["--output"]);
const lengths = options["--seconds"]
  ? [Number(options["--seconds"])]
  : (options["--hours"] ?? "1,2.2,12").split(",").map((n) => Number(n) * 3600);
const profiles = (
  options["--profiles"] ??
  "combined-typical,combined-worst,pcm,cursor-typical,cursor-worst,events,camera"
).split(",");
const rates = ["--pcm-hz", "--cursor-hz", "--camera-hz"].map((key, i) =>
  Number(options[key] ?? [94, 60, 30][i]),
);
const stroke = Number(options["--stroke-seconds"] ?? 300),
  budget = Number(options["--budget-seconds"] ?? 3600);
if (
  ![...lengths, stroke, budget, ...rates].every((n) => Number.isFinite(n) && n > 0) ||
  rates.some((n) => !Number.isInteger(n)) ||
  profiles.some(
    (p) =>
      ![
        "pcm",
        "cursor-typical",
        "cursor-worst",
        "events",
        "camera",
        "combined-typical",
        "combined-worst",
      ].includes(p),
  )
)
  throw Error(usage);
await mkdir(output, { recursive: true });
// Refuse reuse of measured results; fixture generation must never overwrite retained inputs.
try {
  await stat(join(output, "report.json"));
  throw Error("Output already contains a report");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const build = resolve(options["--build"] ?? join(output, "build"));
const report = {
  command: process.argv,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0].model,
  },
  rates: { pcmHz: rates[0], cursorHz: rates[1], cameraHz: rates[2] },
  strokeSeconds: stroke,
  budgetSecondsPerLength: budget,
  results: [],
};
async function execute(command, args, log, timeoutMs) {
  console.error(`START ${command} ${args.join(" ")}`);
  const child = spawn("/usr/bin/time", ["-l", command, ...args], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const started = performance.now();
  let stdout = "",
    stderr = "",
    stopped = false;
  let killFallback;
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
    if (!String(b).includes("maximum resident")) process.stderr.write(b);
  });
  const heartbeat = setInterval(
    () => console.error(`RUNNING ${log}: ${((performance.now() - started) / 1000).toFixed(1)}s`),
    10000,
  );
  const timer = setTimeout(
    () => {
      stopped = true;
      // Leave time(1) alive to collect the worker's peak RSS, including at the stop point.
      try {
        execFileSync("/usr/bin/pkill", ["-KILL", "-P", String(child.pid)]);
      } catch {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      // A compiler can leave grandchildren holding pipes after its direct child exits.
      killFallback = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000);
    },
    Math.max(1, timeoutMs),
  );
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  clearInterval(heartbeat);
  clearTimeout(timer);
  clearTimeout(killFallback);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  const wallSeconds = (performance.now() - started) / 1000;
  await writeFile(log, stdout + stderr);
  const match = stderr.match(/(\d+)\s+maximum resident set size/);
  let result;
  try {
    result = JSON.parse(stdout.trim().split("\n").at(-1));
  } catch {
    result = {
      status: stopped ? "stopped" : code === 0 ? "pass" : "fail",
      message: stderr.slice(-2000),
    };
  }
  return {
    ...result,
    status: stopped ? "stopped" : result.status,
    exitCode: code,
    wallSeconds,
    lastProgress: stderr
      .split("\n")
      .filter((line) => /^(generated|streamed|validated|indexed) /.test(line))
      .at(-1),
    peakRSSBytes: match ? Number(match[1]) : null,
    command: [command, ...args],
    log,
  };
}
async function fileStats(file) {
  let bytes = 0,
    lines = 0,
    tail = 0,
    maxLineBytes = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length;
      let offset = 0,
        end;
      while ((end = chunk.indexOf(10, offset)) >= 0) {
        maxLineBytes = Math.max(maxLineBytes, tail + end - offset);
        lines++;
        tail = 0;
        offset = end + 1;
      }
      tail += chunk.length - offset;
    }
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  return { bytes, lines, maxLineBytes, unterminatedBytes: tail };
}
await mkdir(build, { recursive: true });
if (!options["--build"]) {
  for (const name of ["YapMedia", "YapCapture"]) {
    const folder = join(repo, "helpers/mac/Sources", name);
    const sources = (await readdir(folder))
      .filter((f) => f.endsWith(".swift"))
      .sort()
      .map((f) => join(folder, f));
    const result = await execute(
      "swiftc",
      [
        "-O",
        "-enable-testing",
        "-swift-version",
        "6",
        "-package-name",
        "YapNative",
        "-emit-library",
        "-emit-module",
        "-module-name",
        name,
        "-emit-module-path",
        join(build, `${name}.swiftmodule`),
        "-I",
        build,
        "-L",
        build,
        ...(name === "YapCapture" ? ["-lYapMedia"] : []),
        "-o",
        join(build, `lib${name}.dylib`),
        ...sources,
      ],
      join(build, `${name}.log`),
      180000,
    );
    if (result.status !== "pass") throw Error(`Build failed: ${result.log}`);
  }
  const result = await execute(
    "swiftc",
    [
      "-O",
      "-swift-version",
      "6",
      "-package-name",
      "YapNative",
      "-parse-as-library",
      "-I",
      build,
      "-L",
      build,
      "-lYapCapture",
      "-lYapMedia",
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      build,
      "-o",
      join(build, "long-take"),
      join(here, "Main.swift"),
      join(repo, "helpers/mac/Sources/YapWire/SourceEvidenceExport.swift"),
    ],
    join(build, "driver.log"),
    180000,
  );
  if (result.status !== "pass") throw Error(`Build failed: ${result.log}`);
}
for (const seconds of lengths) {
  const deadline = performance.now() + budget * 1000;
  for (const profile of profiles) {
    const label = `${seconds / 3600}h-${profile}`;
    const folder = join(output, label),
      sourceFolder = join(folder, "source");
    await mkdir(folder, { recursive: false });
    for (const stage of ["generate", "stream", "publish", "export", "ts-read", "ingest"]) {
      const row = { seconds, profile, stage };
      if (performance.now() >= deadline) {
        report.results.push({
          ...row,
          status: "skipped",
          message: "Per-length wall budget exhausted",
        });
        continue;
      }
      if (
        ["ts-read", "ingest"].includes(stage) &&
        !report.results.some(
          (r) =>
            r.seconds === seconds &&
            r.profile === profile &&
            r.stage === "export" &&
            r.status === "pass",
        )
      ) {
        report.results.push({
          ...row,
          status: "blocked",
          message: "Production export produced no admitted input",
        });
        continue;
      }
      const command = ["ts-read", "ingest"].includes(stage)
        ? process.execPath
        : join(build, "long-take");
      const args =
        stage === "generate"
          ? [
              "generate",
              sourceFolder,
              profile,
              String(seconds),
              String(stroke),
              ...rates.map(String),
            ]
          : stage === "export"
            ? ["export", sourceFolder, join(folder, "evidence.jsonl"), join(folder, "receipt.json")]
            : stage === "publish"
              ? ["publish", sourceFolder, String(Math.round(seconds * 1e6))]
              : ["ts-read", "ingest"].includes(stage)
                ? [join(here, "ts-stage.mjs"), stage, folder]
                : ["stream", sourceFolder];
      const result = await execute(
        command,
        args,
        join(folder, `${stage}.log`),
        deadline - performance.now(),
      );
      if (stage === "generate" || stage === "export" || result.status === "stopped") {
        result.files = {};
        for (const [key, path] of [
          ["journal", join(sourceFolder, "capture.journal.jsonl")],
          ["cameraMapping", join(sourceFolder, "camera.mapping.jsonl")],
          ["evidence", join(folder, "evidence.jsonl")],
        ]) {
          const stats = await fileStats(path);
          if (stats) result.files[key] = stats;
        }
        if (result.status === "stopped" && stage === "generate") {
          result.observedBytesPerSecond =
            Object.values(result.files).reduce((n, f) => n + f.bytes, 0) / result.wallSeconds;
        }
      }
      report.results.push({ ...row, ...result });
      await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      console.error(
        `END ${label}/${stage} ${result.status} ${result.wallSeconds.toFixed(3)}s RSS=${result.peakRSSBytes ?? "?"} ${result.code ?? ""} ${result.message ?? ""}`,
      );
      // Incomplete generated journals cannot be used to claim whole-length stage costs.
      if (stage === "generate" && result.status !== "pass") break;
    }
    // Large files have no durable role; the report/logs carry the measurements, not the fixtures.
    await rm(sourceFolder, { recursive: true, force: true });
    await rm(join(folder, "evidence.jsonl"), { force: true });
    await rm(join(folder, "catalog.sqlite"), { force: true });
  }
}
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.error(`REPORT ${join(output, "report.json")}`);
