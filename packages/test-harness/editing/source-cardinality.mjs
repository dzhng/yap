import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { profileLimits } from "./service-cpu-profile.mjs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JourneyService, hash, root, run } from "./source-evidence-fixture.mjs";
import {
  cardinalityOracle,
  leadingEmpty,
  occurrences,
  prepareCardinality,
  range,
  rowLimit,
} from "./source-cardinality-fixture.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    phase: { type: "string", default: "verify" },
    prepared: { type: "string" },
    "wrong-clock": { type: "boolean", default: false },
  },
});
assert(values.out, "Use one retained output directory for prepare, verify and measure phases");
assert(["prepare", "verify", "measure", "profile"].includes(values.phase));
assert(!values["wrong-clock"] || values.phase === "verify");
const profiling = values.phase === "profile";
const measuring = values.phase === "measure";
const timed = profiling || measuring;
assert(
  profiling === Boolean(values.prepared),
  "Only profile uses an existing --prepared evidence directory",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const report = {
  passed: false,
  phase: values.phase,
  wrongClock: values["wrong-clock"],
  scope: measuring
    ? "Frozen-runtime cached source-cardinality reproduction; not a current-build regression or general scale claim"
    : "Frozen-runtime source-cardinality preparation/correctness; current-build regression and cached p95 remain separate",
  controls: {
    occurrences,
    leadingEmpty,
    rowLimit,
    range,
    cardinalities: [512, 1024],
    warmCollectionsPerArm: 20,
    p95BudgetMs: 250,
    coldMeaning:
      "First collection per arm after service restart; retained manifests may already exist from correctness verification",
  },
  trace: [],
  collections: [],
};
const name = values["wrong-clock"] ? "wrong-clock" : values.phase;
const save = () => writeFile(join(out, `${name}-report.json`), JSON.stringify(report, null, 2));
if (profiling) {
  report.scope =
    "Frozen-runtime service-owner CPU attribution, one retained-catalog read per arm; no current-build, latency SLA or source-cardinality causality claim";
  report.controls = {
    occurrences,
    leadingEmpty,
    rowLimit,
    range,
    cardinalities: [512, 1024],
    collectionsPerArm: 1,
    expectedPageRows: [0, 43, 43, 43, 43, 43, 35],
    limits: profileLimits,
  };
}
const fixtureFile = join(profiling ? resolve(values.prepared) : out, "fixture.json");
const configuration = join(out, `${name}-service.json`);
const operationsFile = join(out, `${name}-native.jsonl`);
const prepared =
  values.phase === "prepare" ? null : JSON.parse(await readFile(fixtureFile, "utf8"));
const home = prepared?.home ?? (await realpath(await mkdtemp("/tmp/sr-source-cardinality-")));
report.home = home;
await writeFile(operationsFile, "");
await writeFile(
  configuration,
  JSON.stringify({
    sources: [],
    allowedOperations:
      values.phase === "prepare"
        ? [
            "media.probe",
            "media.sourceEvidence",
            "storage.clearRenderWorkspace",
            "media.audioCapabilities",
          ]
        : profiling
          ? ["storage.clearRenderWorkspace"]
          : ["storage.clearRenderWorkspace", "media.audioCapabilities"],
    operationsFile,
    ...(profiling ? { cpuProfile: { directory: out } } : {}),
  }),
);
let processObserver;
const processLog = join(out, "measure-processes.jsonl");
if (measuring) {
  const observer = join(out, "measure-process-observer.mjs");
  await writeFile(processLog, "");
  await writeFile(
    observer,
    `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';
const file=process.env.YAP_CARDINALITY_PROCESS_LOG;const log=value=>appendFileSync(file,JSON.stringify(value)+'\\n');
const observer=${JSON.stringify(observer)};const closed=[];
const options=value=>({...value,env:{...(value.env??process.env),YAP_CARDINALITY_PROCESS_LOG:file,NODE_OPTIONS:[value.env?.NODE_OPTIONS??process.env.NODE_OPTIONS??'', '--import='+observer].filter(Boolean).join(' ')}});
const observe=(child,kind)=>{log({event:'spawn',kind,parentPid:process.pid,pid:child.pid});closed.push(new Promise(done=>child.once('close',(code,signal)=>{log({event:'close',kind,parentPid:process.pid,pid:child.pid,code,signal});done();})));return child;};
const spawn=childProcess.spawn;childProcess.spawn=function(command,args,value={}){const mcp=command===process.execPath&&args?.includes('mcp');const child=spawn.call(this,command,args,mcp?options(value):value);return mcp?observe(child,'mcp'):child;};
const fork=childProcess.fork;childProcess.fork=function(entry,args,value={}){return observe(fork.call(this,entry,args,options(value)),'source');};syncBuiltinESMExports();
process.on('exit',code=>log({event:'node-exit',pid:process.pid,code}));
export const settled=()=>Promise.all(closed);
`,
  );
  process.env.YAP_CARDINALITY_PROCESS_LOG = processLog;
  processObserver = await import(observer);
}
const service = new JourneyService(
  home,
  report,
  configuration,
  new URL("./evidence-service.mjs", import.meta.url),
);
const call = (operation, params, options = {}) =>
  service.call(operation, params, { transport: "mcp", ...options });
let client, watchdog, softDeadline, armDeadline, armHardDeadline, activeProfileArm;
let overallEndsAt = Infinity,
  profileStopAttempted = false,
  closingTransports;
const abort = new AbortController();
const closeTransports = () =>
  (closingTransports ??= Promise.allSettled([client?.close(), service.mcp?.close()]));
const abortProfile = (error) => {
  abort.abort(error);
  void closeTransports();
};
const hardStop = (error) => {
  abortProfile(error);
  const child = service.child;
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};
const recordProfile = (value) => {
  if (value && !report.profiles.some((profile) => profile.arm === value.arm))
    report.profiles.push(value);
  if (value?.arm === activeProfileArm) activeProfileArm = undefined;
};
async function profileContext(stage) {
  const snapshot = (await run("ps", ["-axo", "pid,ppid,etime,pcpu,rss,command"], { timeout: 2000 }))
    .stdout;
  const file = join(out, `profile-${stage}-processes.txt`);
  await writeFile(file, snapshot);
  report.contexts ??= [];
  report.contexts.push({
    stage,
    at: new Date().toISOString(),
    file,
    sha256: hash(snapshot),
    meaning:
      "Raw context, not proof of whole-host isolation; execution requires separate coordinated preflight",
  });
}
function cpuRequest(action, arm, reason) {
  const id = randomUUID(),
    type = `cpu.${action}`;
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer);
      service.child.off("message", received);
      service.child.off("exit", exited);
      if (error) reject(error);
      else resolve(result);
    };
    const received = (message) => {
      if (message.id === id && message.type === type)
        finish(message.error ? new Error(message.error) : null, message.result);
    };
    const exited = () => finish(new Error("Profile service exited before its acknowledgment"));
    const timer = setTimeout(
      () => finish(new Error("CPU profiler control deadline")),
      Math.max(1, Math.min(profileLimits.controlMs, overallEndsAt - performance.now())),
    );
    service.child.on("message", received);
    service.child.once("exit", exited);
    service.child.send({ id, type, arm, reason }, (error) => {
      if (error) finish(error);
    });
  });
}
try {
  assert.equal(
    hash(await readFile(process.env.YAP_NATIVE)),
    profiling
      ? "e19816c06483af71ca3f04796fcab21841acd2bb1caa2a4778cdb508e2205dba"
      : "0a9cd72a62af990a2bccef585184df0a2bbc36220a2fc258e0198ee43d726928",
  );
  report.runtime = {
    node: process.version,
    nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
    gitHead: (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
    files: {},
  };
  for (const file of [
    "packages/core/dist/project-evidence.js",
    "packages/core/dist/capture-source-read.js",
    "packages/core/dist/source-selection.js",
    "packages/core/dist/project-events.js",
    "packages/test-harness/editing/source-cardinality.mjs",
    "packages/test-harness/editing/source-cardinality-fixture.mjs",
    ...(profiling
      ? [
          "packages/test-harness/editing/service-cpu-profile.mjs",
          "packages/test-harness/editing/evidence-service.mjs",
          "packages/test-harness/editing/source-evidence-fixture.mjs",
        ]
      : []),
  ])
    report.runtime.files[file] = hash(await readFile(join(root, file)));
  report.runtime.resolvedModules = [];
  for (const [importer, specifier, expected] of [
    [
      "apps/service/dist/project-service.js",
      "@yap/core/project-evidence",
      "packages/core/dist/project-evidence.js",
    ],
    ["apps/service/dist/worker.js", "@yap/protocol", "packages/protocol/dist/index.js"],
    [
      "packages/core/dist/project-evidence.js",
      "@yap/composition",
      "packages/composition/dist/index.js",
    ],
    ["apps/cli/dist/main.js", "@yap/client", "packages/client/dist/index.js"],
    ["packages/client/dist/index.js", "@yap/protocol", "packages/protocol/dist/index.js"],
    [
      "packages/test-harness/editing/source-evidence-fixture.mjs",
      "@yap/protocol",
      "packages/protocol/dist/index.js",
    ],
  ]) {
    const path = await realpath(createRequire(join(root, importer)).resolve(specifier));
    assert.equal(
      path,
      await realpath(join(root, expected)),
      "A workspace import escaped the isolated build",
    );
    report.runtime.resolvedModules.push({
      importer,
      specifier,
      path,
      sha256: hash(await readFile(path)),
    });
  }
  if (profiling) {
    const retained = resolve(values.prepared);
    const manifest = JSON.parse(
      await readFile(
        join(root, "specs/done/agent-editing/assets/24z-source-cardinality/manifest.json"),
        "utf8",
      ),
    );
    for (const file of ["fixture.json", "build-identity.json", "measure-report.json"])
      assert.equal(
        hash(await readFile(join(retained, file))),
        manifest.files[`cohort/${file}`].sha256,
        "Retained seed evidence changed",
      );
    const seed = JSON.parse(await readFile(join(retained, "measure-report.json"), "utf8"));
    assert.equal(
      seed.runtime.nativeSha256,
      "45cbe7b92819efa15a1b5d4a974cdcbd26cac6301c041bf6e5818e50f7cf5773",
    );
    assert.equal(home, seed.home);
    assert.notEqual(
      await realpath(process.env.YAP_NATIVE),
      "/private/tmp/yap-03d-native-build/debug/yap-native",
    );
    const identity = JSON.parse(await readFile(join(retained, "build-identity.json"), "utf8"));
    const prefixes = [
      "packages/core/",
      "packages/composition/",
      "packages/protocol/",
      "packages/client/",
      "apps/service/",
      "apps/cli/",
    ];
    const matched = {};
    const imports = new Map();
    for (const [field, count] of [
      ["sourceFiles", 176],
      ["builtFiles", 174],
    ]) {
      const files = Object.entries(identity[field]).filter(([file]) =>
        prefixes.some((prefix) => file.startsWith(prefix)),
      );
      assert.equal(files.length, count);
      for (const [file, sha256] of files) {
        const bytes = await readFile(join(root, file));
        assert.equal(hash(bytes), sha256, `${file} differs from the retained query implementation`);
        if (field === "builtFiles")
          for (const match of bytes
            .toString()
            .matchAll(/(?:from\s*|import\s*\(\s*)["'](@yap\/[^"']+)["']/g)) {
            const path = await realpath(createRequire(join(root, file)).resolve(match[1]));
            assert(
              path.startsWith((await realpath(root)) + "/"),
              "Workspace import escaped the profile checkout",
            );
            assert.equal(
              hash(await readFile(path)),
              identity.builtFiles[path.slice((await realpath(root)).length + 1)],
            );
            imports.set(`${file}:${match[1]}`, {
              importer: file,
              specifier: match[1],
              path,
              sha256: hash(await readFile(path)),
            });
          }
      }
      matched[field] = count;
    }
    report.provenance = {
      retained,
      home,
      seedNativeSha256: seed.runtime.nativeSha256,
      profileNativePath: await realpath(process.env.YAP_NATIVE),
      profileNativeSha256: report.runtime.nativeSha256,
      matched,
      imports: [...imports.values()],
    };
    report.profiles = [];
    report.runtime.sdkLifecycle = {};
    for (const module of [
      "@modelcontextprotocol/sdk/client/stdio.js",
      "@modelcontextprotocol/sdk/shared/protocol.js",
    ]) {
      const file = new URL(import.meta.resolve(module));
      report.runtime.sdkLifecycle[module] = {
        file: file.pathname,
        sha256: hash(await readFile(file)),
      };
    }
    report.profileAttribution =
      "One read per arm, with fresh revision-context initialization and no warmup; service CPU deltas include inspector control and sampling overhead. No latency SLA or cardinality-causality claim.";
    await writeFile(join(out, "profile-attempt.json"), JSON.stringify(report.provenance, null, 2), {
      flag: "wx",
    });
    await profileContext("before");
    overallEndsAt = performance.now() + profileLimits.overallMs;
    softDeadline = setTimeout(
      () => abortProfile(new Error("Overall profile deadline: reserved flush/shutdown interval")),
      profileLimits.overallMs - profileLimits.controlMs - profileLimits.shutdownMs,
    );
    watchdog = setTimeout(() => {
      hardStop(new Error("Overall profile hard cap"));
    }, profileLimits.overallMs);
  }
  await service.start();
  if (profiling)
    service.child.on("message", (message) => {
      if (message.type === "cpu.guard") {
        recordProfile(message.profile);
        abortProfile(new Error(`Service CPU-profile guard: ${message.reason}`));
      }
    });
  if (values.phase === "prepare") {
    const started = performance.now();
    const fixture = await prepareCardinality(home, out, call);
    report.setupMs = performance.now() - started;
    await writeFile(fixtureFile, JSON.stringify({ home, ...fixture }, null, 2));
    report.passed = true;
  } else {
    // This separate client intentionally uses the SDK's unconfigured default receive bound.
    client = new Client({ name: "source-cardinality-default-client", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "apps/cli/dist/main.js"), "mcp", "--socket", service.socketPath],
        stderr: "pipe",
      }),
    );
    const sdk = await readFile(
      new URL(import.meta.resolve("@modelcontextprotocol/sdk/shared/stdio.js")),
      "utf8",
    );
    report.defaultClient = {
      configured: false,
      maxBufferBytes: STDIO_DEFAULT_MAX_BUFFER_SIZE,
      sdkReadBufferSha256: hash(sdk),
    };
    const rss = async () => {
      const bytes =
        Number((await run("ps", ["-o", "rss=", "-p", String(service.child.pid)])).stdout.trim()) *
        1024;
      assert(Number.isFinite(bytes) && bytes > 0);
      return bytes;
    };
    report.baselineRssBytes = await rss();
    const expected = new Map(
      prepared.arms.map((arm) => [arm.cardinality, cardinalityOracle(prepared, arm)]),
    );
    if (values["wrong-clock"]) expected.get(512).rows[0].projectAtUs++;
    const collect = async (arm, label, transport = "mcp") => {
      const oracle = expected.get(arm.cardinality),
        rows = [],
        pages = [],
        seen = new Set();
      let cursor;
      const nativeBefore = await readFile(operationsFile, "utf8");
      if (profiling) {
        armDeadline = setTimeout(
          () => abortProfile(new Error("Arm profile deadline: reserved flush interval")),
          profileLimits.armMs - profileLimits.controlMs,
        );
        armHardDeadline = setTimeout(
          () => hardStop(new Error("Arm profile hard cap")),
          profileLimits.armMs,
        );
        activeProfileArm = arm.cardinality;
        profileStopAttempted = false;
        const started = await cpuRequest("start", arm.cardinality);
        assert.equal(started.pid, service.child.pid);
      }
      const started = timed ? performance.now() : undefined;
      do {
        const params = {
          projectId: arm.projectId,
          revisionId: arm.revisionId,
          range,
          limit: rowLimit - rows.length,
          ...(cursor ? { cursor } : {}),
        };
        const pageAt = performance.now();
        let response, delivered;
        const deadline = pageAt + 180000;
        let requests = 0;
        for (;;) {
          if (transport === "mcp") {
            delivered = profiling
              ? await client.callTool({ name: "cursor.raw", arguments: params }, undefined, {
                  signal: abort.signal,
                })
              : await client.callTool({ name: "cursor.raw", arguments: params });
            assert.equal(
              delivered.structuredContent?.ok,
              true,
              delivered.isError ? JSON.stringify(delivered) : "MCP success required",
            );
            response = delivered.structuredContent.data;
          } else response = await call("cursor.raw", params, { transport });
          requests++;
          if (response.state === "ready") break;
          assert(
            !profiling && !measuring,
            "Cached collection requires ready evidence; no query-time preparation polling is permitted",
          );
          assert(
            ["queued", "running"].includes(response.state),
            `Evidence preparation: ${response.state} (${response.reason})`,
          );
          assert(performance.now() < deadline, "Project evidence preparation deadline");
          await delay(100);
        }
        const next = response.page.nextCursor;
        assert(next, "The first 250 of 1024 occurrences must retain a continuation");
        assert(!seen.has(next.checkpointId), "A continuation repeated its checkpoint");
        seen.add(next.checkpointId);
        if (cursor)
          assert.deepEqual(
            { ...next, checkpointId: cursor.checkpointId },
            cursor,
            "Continuation changed its pinned query",
          );
        rows.push(...response.page.rows);
        pages.push({
          params,
          response,
          requests,
          ...(timed ? { latencyMs: performance.now() - pageAt } : {}),
          delivered,
        });
        cursor = next;
        assert(
          pages.length <= (profiling ? 7 : occurrences),
          "Continuation exceeded its page bound",
        );
        if (profiling && rows.length < rowLimit)
          assert(pages.length < 7, "Profile would require an eighth page");
      } while (rows.length < rowLimit);
      const totalMs = timed ? performance.now() - started : undefined;
      if (profiling) {
        profileStopAttempted = true;
        recordProfile(await cpuRequest("stop", arm.cardinality, "complete"));
        clearTimeout(armDeadline);
        clearTimeout(armHardDeadline);
        abort.signal.throwIfAborted();
        assert.deepEqual(
          pages.map(({ response }) => response.page.rows.length),
          report.controls.expectedPageRows,
        );
      }
      const nativeAfter = await readFile(operationsFile, "utf8");
      assert.equal(nativeAfter, nativeBefore, "A collection invoked native work");
      const nativeCallBoundary = {
        before: {
          bytes: Buffer.byteLength(nativeBefore),
          sha256: hash(nativeBefore),
          count: nativeBefore.trim().split("\n").filter(Boolean).length,
        },
        after: {
          bytes: Buffer.byteLength(nativeAfter),
          sha256: hash(nativeAfter),
          count: nativeAfter.trim().split("\n").filter(Boolean).length,
        },
        invocationsDuringRead: 0,
      };
      // Retain complete comparison operands before checking them, outside collection timing.
      if (label !== "warm")
        await writeFile(
          join(out, `${name}-${arm.cardinality}-${label}-${transport}-operands.json`),
          JSON.stringify({ expected: oracle, actual: pages }),
        );
      // Time delivery of the whole prefix; oracle comparisons, serialization telemetry and file IO are outside it.
      for (const page of pages) {
        const { response, delivered, params } = page;
        assert.equal(response.projectId, arm.projectId);
        assert.equal(response.revisionId, arm.revisionId);
        assert.deepEqual(
          response.dependencies,
          params.cursor ? { manifestId: params.cursor.manifestId } : oracle.dependencies,
        );
        assert.deepEqual(
          response.coverage,
          params.cursor
            ? { manifestId: response.page.nextCursor.manifestId }
            : { manifestId: response.page.nextCursor.manifestId, occurrences: oracle.coverage },
        );
        page.dataBytes = Buffer.byteLength(JSON.stringify(response));
        if (delivered) {
          assert.equal(delivered.content.length, 1);
          assert.equal(delivered.content[0].type, "text");
          assert.deepEqual(
            JSON.parse(delivered.content[0].text),
            delivered.structuredContent,
            "MCP text and structured bodies must agree",
          );
          page.mcpResultBytes = Buffer.byteLength(JSON.stringify(delivered));
        }
        delete page.delivered;
        if (label === "warm" || profiling)
          assert.equal(page.requests, 1, "A warm collection must use already prepared evidence");
      }
      if (values["wrong-clock"])
        await writeFile(
          join(out, "wrong-clock-rows.json"),
          JSON.stringify({ actual: rows, expected: oracle.rows }),
        );
      assert.deepEqual(
        rows,
        oracle.rows,
        "Authored source and project clocks, observations and occurrence identities must match",
      );
      assert(
        pages.some(({ response }) => response.page.rows.length === 0),
        "Leading empty occurrences must exercise an empty continuation",
      );
      const result = {
        cardinality: arm.cardinality,
        nativeCallBoundary,
        label,
        transport,
        ...(timed ? { totalMs } : {}),
        pageCount: pages.length,
        rowsSha256: hash(JSON.stringify(rows)),
        nextCursor: cursor,
        pages: pages.map(({ response, ...page }) => ({
          ...page,
          rows: response.page.rows.length,
          cursor: response.page.nextCursor,
        })),
        rssBytes: await rss(),
      };
      // One phase-local selection reader shares asset metadata while resolving every acquisition.
      if (pages.every((page) => page.requests === 1)) {
        const phases = 1 + 2 * pages.length;
        result.staticDependencyWork = {
          basis:
            "Ready request plus both sides of each nonterminal checkpoint publication resolve all N selections. Each synchronous phase fetches acquisition rows together and decodes each distinct acquisition on use, sharing one complete asset read. No state survives an await. Other catalog work excluded; this is code-derived work, not observed SQL or timing attribution.",
          phases,
          sourceResolutions: arm.cardinality * phases,
          acquisitionMetadataRowsDecoded: arm.cardinality * phases,
          acquisitionMetadataQueries: phases,
          assetMetadataGets: phases,
          assetPathHeaderReads: 0,
        };
      }
      report.collections.push(result);
      if (label !== "warm") {
        await writeFile(
          join(out, `${name}-${arm.cardinality}-${label}-${transport}-pages.json`),
          JSON.stringify(pages),
        );
        const files = new Set(
          pages.flatMap(({ response }) => [
            response.page.nextCursor.manifestId,
            response.page.nextCursor.checkpointId,
          ]),
        );
        const checkpoints = [];
        for (const id of files) {
          const bytes = await readFile(join(home, "library/cache/derived", `${id}.cache`));
          await writeFile(join(out, `${id}.cache.json`), bytes);
          checkpoints.push({ id, bytes: bytes.length, sha256: hash(bytes) });
        }
        result.cacheFiles = checkpoints;
        // A fresh UUID alone is not progress: persisted traversal state must also change.
        const positions = await Promise.all(
          pages.map(({ response }) =>
            readFile(
              join(home, "library/cache/derived", `${response.page.nextCursor.checkpointId}.cache`),
              "utf8",
            ),
          ),
        );
        assert.equal(
          new Set(positions.map(hash)).size,
          positions.length,
          "Checkpoint traversal repeated without progress",
        );
      }
      return { result, rows, pages };
    };
    const cold = new Map();
    for (const arm of prepared.arms)
      cold.set(arm.cardinality, await collect(arm, profiling ? "profile" : "cold"));
    if (measuring) {
      for (let repeat = 0; repeat < report.controls.warmCollectionsPerArm; repeat++) {
        const order = repeat % 2 ? [...prepared.arms].reverse() : prepared.arms;
        for (const arm of order) {
          const { result } = await collect(arm, "warm");
          result.repeat = repeat;
        }
        console.log(`Completed warm pair ${repeat + 1}/${report.controls.warmCollectionsPerArm}`);
        await save();
      }
      report.arms = prepared.arms.map(({ cardinality }) => {
        const collections = report.collections.filter(
          (c) => c.cardinality === cardinality && c.label === "warm",
        );
        const times = collections.map((c) => c.totalMs).sort((a, b) => a - b);
        return {
          cardinality,
          p95Ms: times[Math.ceil(times.length * 0.95) - 1],
          minMs: times[0],
          maxMs: times.at(-1),
          sampledRssBytes: collections.map((c) => c.rssBytes),
          memoryMeaning:
            "Descriptive post-collection service RSS in one shared process; no duration ratio gate or per-arm attribution",
        };
      });
    } else if (!profiling) {
      for (const arm of prepared.arms) {
        const mcp = cold.get(arm.cardinality);
        const cli = await collect(arm, "parity", "cli");
        assert.deepEqual(cli.rows, mcp.rows);
        // Manifest identity is stable; newly published continuation checkpoint IDs are intentionally fresh.
        const comparable = (pages) =>
          pages.map(({ response }) => ({
            ...response,
            page: {
              ...response.page,
              nextCursor: { ...response.page.nextCursor, checkpointId: "fresh" },
            },
          }));
        assert.deepEqual(comparable(cli.pages), comparable(mcp.pages));
        const cursor = mcp.pages[0].response.page.nextCursor;
        const refusal = await call(
          "cursor.raw",
          {
            projectId: arm.projectId,
            revisionId: arm.revisionId,
            range: { ...range, startUs: 1 },
            cursor,
          },
          { error: true },
        );
        assert.equal(refusal.code, "ARTIFACT_CHANGED");
      }
      report.pinnedRefusal = "ARTIFACT_CHANGED for changed full-window query";
    }
    if (profiling)
      assert.deepEqual(
        report.profiles.map(({ arm, reason }) => ({ arm, reason })),
        [
          { arm: 512, reason: "complete" },
          { arm: 1024, reason: "complete" },
        ],
      );
    report.passed = report.arms ? report.arms.every((arm) => arm.p95Ms <= 250) : true;
    if (!report.passed)
      throw new Error(
        "Complete cached 250-row collection exceeded unchanged 250ms p95 budget; retain and profile existing owner",
      );
  }
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await save();
  clearTimeout(armDeadline);
  clearTimeout(softDeadline);
  if (
    profiling &&
    activeProfileArm !== undefined &&
    !profileStopAttempted &&
    service.child?.connected &&
    performance.now() < overallEndsAt
  ) {
    profileStopAttempted = true;
    try {
      recordProfile(await cpuRequest("stop", activeProfileArm, "interrupted"));
    } catch (error) {
      report.profileFlushError = error.message;
    }
  }
  if (profiling) {
    const transports = await closeTransports();
    const serviceResult = await Promise.allSettled([service.stop()]);
    report.shutdownErrors = [...transports, ...serviceResult]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason.message);
    if (report.shutdownErrors.length) {
      report.passed = false;
      process.exitCode = 1;
    }
  } else {
    const closed = await Promise.allSettled([client?.close(), service.stop()]);
    report.shutdownErrors = closed
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason.message);
    if (report.shutdownErrors.length) {
      report.passed = false;
      process.exitCode = 1;
    }
  }
  if (processObserver) {
    await processObserver.settled();
    report.processEvents = (await readFile(processLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    try {
      const children = report.processEvents.filter((event) => event.event === "spawn");
      assert.deepEqual(children.map((event) => event.kind).sort(), ["mcp", "mcp", "source"]);
      for (const child of children) {
        assert(
          report.processEvents.some(
            (event) => event.event === "node-exit" && event.pid === child.pid && event.code === 0,
          ),
          `Missing actual Node exit ${child.pid}`,
        );
        assert(
          report.processEvents.some(
            (event) =>
              event.event === "close" &&
              event.pid === child.pid &&
              event.code === 0 &&
              event.signal === null,
          ),
          `Missing actual OS close ${child.pid}`,
        );
      }
    } catch (error) {
      report.passed = false;
      report.processObservationError = error.message;
      process.exitCode = 1;
    }
  }
  clearTimeout(watchdog);
  clearTimeout(armHardDeadline);
  if (profiling && report.contexts?.length) {
    try {
      await profileContext("after");
    } catch (error) {
      report.contextError = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  report.nativeOperations = (await readFile(operationsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  if (values.phase !== "prepare")
    assert.deepEqual(
      report.nativeOperations.filter(
        ({ operation }) =>
          ![
            "storage.clearRenderWorkspace",
            ...(profiling ? [] : ["media.audioCapabilities"]),
          ].includes(operation),
      ),
      [],
      "No query-time native work",
    );
  await writeFile(join(out, `${name}-service.log`), service.logs.join(""));
  await save();
}
console.log(out);
