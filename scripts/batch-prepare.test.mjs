import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBatch, prepareBatch } from "../skills/yap/scripts/batch-prepare.mjs";

test("selected imports retain success when a sibling fails and resume without duplicating work", async () => {
  const manifest = createBatch([{ path: "/selected/good.mov" }, { path: "/selected/bad.mov" }]);
  const saved = [];
  let imports = 0;
  const invoke = async (operation, params) => {
    if (operation === "asset.import") {
      assert.ok(saved[0].items.some((item) => item.requestId === params.requestId));
      imports++;
      return params.path.endsWith("good.mov")
        ? {
            jobId: "good-job",
            state: "ready",
            published: { generation: 1, output: { assetId: "good-asset" } },
          }
        : { jobId: "bad-job", state: "failed", errorCode: "DECODE_FAILED", retryable: true };
    }
    assert.equal(operation, "asset.get");
    return { assetId: params.assetId, streams: [{ streamId: "video", mediaKind: "video" }] };
  };
  const result = await prepareBatch(manifest, {
    invoke,
    save: async (state) => saved.push(state),
    pollIntervalMs: 0,
  });
  assert.deepEqual(result.summary, { ready: 1, failed: 1, pending: 0, notRequested: 0 });
  assert.equal(manifest.items[0].asset.assetId, "good-asset");
  assert.equal(manifest.items[1].import.errorCode, "DECODE_FAILED");
  const resumed = JSON.parse(JSON.stringify(manifest));
  await prepareBatch(resumed, { invoke, save: async (state) => saved.push(state) });
  assert.equal(imports, 2);
  assert.deepEqual(resumed.items[0].asset, manifest.items[0].asset);
});

test("model absence is reported once; resume never prepares models or implicitly retries ASR", async () => {
  const manifest = createBatch([
    { path: "/selected/interview.mov", transcriptStreamIds: ["audio"] },
  ]);
  let preparationRequests = 0;
  const invoke = async (operation) => {
    if (operation === "asset.import")
      return {
        jobId: "import",
        state: "ready",
        published: { generation: 1, output: { assetId: "interview" } },
      };
    if (operation === "asset.get")
      return { assetId: "interview", streams: [{ streamId: "audio", mediaKind: "audio" }] };
    assert.equal(operation, "transcript.transcribe");
    preparationRequests++;
    throw Object.assign(new Error("Speech model is absent"), {
      code: "MODEL_NOT_PREPARED",
      retryable: true,
    });
  };
  assert.equal((await prepareBatch(manifest, { invoke })).summary.failed, 1);
  assert.equal((await prepareBatch(manifest, { invoke })).summary.failed, 1);
  assert.equal(preparationRequests, 1);
  await prepareBatch(manifest, { invoke, retryFailed: true });
  assert.equal(preparationRequests, 2);
});

test("unfinished jobs hold concurrency slots across polling budgets and resume", async () => {
  const manifest = createBatch(["a", "b", "c"].map((name) => ({ path: `/selected/${name}.mov` })));
  const imports = [];
  const invoke = async (operation, params) => {
    if (operation === "asset.import") {
      imports.push(params.requestId);
      return { jobId: params.requestId, state: "running", published: null };
    }
    if (operation === "job.get")
      return {
        jobId: params.jobId,
        state: "ready",
        published: { generation: 1, output: { assetId: params.jobId } },
      };
    assert.equal(operation, "asset.get");
    return { assetId: params.assetId, streams: [] };
  };
  const paused = await prepareBatch(manifest, { invoke, concurrency: 2, maxPolls: 0 });
  assert.deepEqual(paused.summary, { ready: 0, failed: 0, pending: 2, notRequested: 1 });
  assert.deepEqual(
    imports,
    manifest.items.slice(0, 2).map((item) => item.requestId),
  );
  const complete = await prepareBatch(manifest, {
    invoke,
    concurrency: 2,
    maxPolls: 1,
    pollIntervalMs: 0,
  });
  assert.deepEqual(complete.summary, { ready: 3, failed: 0, pending: 0, notRequested: 0 });
  assert.deepEqual(
    imports,
    manifest.items.map((item) => item.requestId),
  );
});

for (const errorCode of ["CLI_TIMEOUT", "TIMEOUT", "CONNECTION_ERROR", "ABORTED"]) {
  test(`a lost import answer (${errorCode}) reserves its slot and replays the saved identity on resume`, async () => {
    const manifest = createBatch([{ path: "/selected/a.mov" }, { path: "/selected/b.mov" }]);
    const accepted = [];
    let loseAnswer = true;
    const invoke = async (operation, params) => {
      if (operation === "asset.import") {
        accepted.push(params.requestId);
        if (loseAnswer) {
          loseAnswer = false;
          throw Object.assign(new Error("lost answer"), { code: errorCode });
        }
        return {
          jobId: params.requestId,
          state: "ready",
          published: { generation: 1, output: { assetId: params.requestId } },
        };
      }
      assert.equal(operation, "asset.get");
      return { assetId: params.assetId, streams: [] };
    };
    await prepareBatch(manifest, { invoke, concurrency: 1 });
    assert.equal(manifest.items[0].import.state, "uncertain");
    assert.equal(manifest.items[1].import.state, "idle");
    await prepareBatch(manifest, { invoke, concurrency: 1 });
    assert.deepEqual(accepted, [
      manifest.items[0].requestId,
      manifest.items[0].requestId,
      manifest.items[1].requestId,
    ]);
  });
}

test("the executable saves replay identities and preserves source bytes across repeated runs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-batch-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "selected.mov"),
    manifest = join(directory, "batch.json"),
    log = join(directory, "imports.jsonl");
  const executable = join(directory, "yap");
  await writeFile(source, "original source bytes");
  await writeFile(manifest, JSON.stringify({ items: [{ path: source }] }));
  await writeFile(
    executable,
    `#!${process.execPath}
    const fs=require("node:fs");let input="";
    process.stdin.on("data",chunk=>input+=chunk);
    process.stdin.on("end",()=>{
      const params=JSON.parse(input);let data;
      if(process.argv[2]==="asset.import") {
        const saved=JSON.parse(fs.readFileSync(${JSON.stringify(manifest)},"utf8"));
        if(saved.items[0].requestId!==params.requestId)process.exit(2);
        fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(params)+"\\n");
        data={jobId:"import-job",state:"ready",published:{generation:1,output:{assetId:"selected"}}};
      } else if(process.argv[2]==="asset.get")data={assetId:"selected",streams:[]};
      else process.exit(3);
      console.log(JSON.stringify({ok:true,data}));
    });`,
    { mode: 0o755 },
  );
  const script = fileURLToPath(new URL("../skills/yap/scripts/batch-prepare.mjs", import.meta.url));
  const run = () =>
    spawnSync(process.execPath, [script, "--manifest", manifest, "--cli", executable], {
      encoding: "utf8",
      timeout: 5000,
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).summary, {
    ready: 1,
    failed: 0,
    pending: 0,
    notRequested: 0,
  });
  const saved = JSON.parse(await readFile(manifest, "utf8"));
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(source, "utf8"), "original source bytes");
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").map(JSON.parse), [
    { requestId: saved.items[0].requestId, path: source },
  ]);
});

test("the installed helper can be invoked through a symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-batch-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = join(directory, "batch.mjs");
  await symlink(
    fileURLToPath(new URL("../skills/yap/scripts/batch-prepare.mjs", import.meta.url)),
    alias,
  );
  const result = spawnSync(process.execPath, [alias, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node batch-prepare/);
});

test("interrupted transcript admission recovers status without restarting a failed attempt", async () => {
  const manifest = createBatch([
    { path: "/selected/interview.mov", transcriptStreamIds: ["audio"] },
  ]);
  let checkpoint;
  const invoke = async (operation, params) => {
    if (operation === "asset.import")
      return {
        jobId: "import",
        state: "ready",
        published: { generation: 1, output: { assetId: "interview" } },
      };
    if (operation === "asset.get") return { assetId: "interview", streams: [] };
    if (operation === "transcript.transcribe") {
      assert.equal(checkpoint.items[0].transcripts[0].status.state, "uncertain");
      throw Object.assign(new Error("answer lost after admission"), { code: "CLI_TIMEOUT" });
    }
    assert.equal(operation, "transcript.get");
    assert.deepEqual(params, { assetId: "interview", streamId: "audio", limit: 1 });
    return {
      state: "failed",
      jobId: "transcript",
      reason: "ASR_FAILED",
      retryable: true,
      page: null,
    };
  };
  await prepareBatch(manifest, {
    invoke,
    save: async (state) => {
      checkpoint = state;
    },
  });
  const resumed = JSON.parse(JSON.stringify(checkpoint));
  await prepareBatch(resumed, { invoke });
  assert.equal(resumed.items[0].transcripts[0].status.jobId, "transcript");
  assert.equal(resumed.items[0].transcripts[0].status.state, "failed");
});

test("an interrupted transcript admission that never reached the service is requested again", async () => {
  const manifest = createBatch([
    { path: "/selected/interview.mov", transcriptStreamIds: ["audio"] },
  ]);
  let checkpoint;
  let transcribes = 0;
  const invoke = async (operation, params) => {
    if (operation === "asset.import")
      return {
        jobId: "import",
        state: "ready",
        published: { generation: 1, output: { assetId: "interview" } },
      };
    if (operation === "asset.get") return { assetId: "interview", streams: [] };
    if (operation === "transcript.transcribe") {
      if (++transcribes === 1)
        throw Object.assign(new Error("lost before admission"), { code: "CLI_TIMEOUT" });
      return { state: "ready", jobId: "transcript", published: { generation: 1 } };
    }
    assert.equal(operation, "transcript.get");
    return { state: "idle", jobId: null, page: null };
  };
  await prepareBatch(manifest, {
    invoke,
    save: async (state) => {
      checkpoint = state;
    },
  });
  const resumed = JSON.parse(JSON.stringify(checkpoint));
  const result = await prepareBatch(resumed, { invoke });
  assert.equal(transcribes, 2);
  assert.equal(result.summary.ready, 1);
});

test("lowering concurrency on resume drains earlier jobs before admitting a new preparation", async () => {
  const manifest = createBatch([
    { path: "/selected/a.mov", transcriptStreamIds: ["audio"] },
    { path: "/selected/b.mov" },
  ]);
  let transcripts = 0;
  const invoke = async (operation, params) => {
    if (operation === "asset.import")
      return { jobId: params.requestId, state: "running", published: null };
    if (operation === "job.get")
      return {
        jobId: params.jobId,
        state: "ready",
        published: { generation: 1, output: { assetId: params.jobId } },
      };
    if (operation === "asset.get") return { assetId: params.assetId, streams: [] };
    assert.equal(operation, "transcript.transcribe");
    transcripts++;
    return { state: "ready", jobId: "transcript", published: { generation: 1 } };
  };
  await prepareBatch(manifest, { invoke, concurrency: 2, maxPolls: 0 });
  await prepareBatch(manifest, { invoke, concurrency: 1, maxPolls: 1, pollIntervalMs: 0 });
  assert.equal(transcripts, 0);
  const resumed = await prepareBatch(manifest, {
    invoke,
    concurrency: 1,
    maxPolls: 1,
    pollIntervalMs: 0,
  });
  assert.equal(resumed.summary.ready, 2);
  assert.equal(transcripts, 1);
});

test("resuming drains a pending stream before retrying a failed sibling", async () => {
  const manifest = createBatch([
    { path: "/selected/interview.mov", transcriptStreamIds: ["first", "second"] },
  ]);
  const outstanding = new Set();
  let retries = 0;
  const invoke = async (operation, params) => {
    if (operation === "asset.import")
      return {
        state: "ready",
        jobId: "import",
        published: { generation: 1, output: { assetId: "interview" } },
      };
    if (operation === "asset.get") return { assetId: "interview", streams: [] };
    if (operation === "transcript.transcribe") {
      if (params.streamId === "first") return { state: "failed", jobId: "first", retryable: true };
      outstanding.add("second");
      return { state: "running", jobId: "second" };
    }
    if (operation === "job.retry") {
      retries++;
      outstanding.add(params.jobId);
      assert.deepEqual([...outstanding], ["first"]);
      return { state: "queued", jobId: params.jobId };
    }
    assert.equal(operation, "job.get");
    outstanding.delete(params.jobId);
    return { state: "ready", jobId: params.jobId };
  };
  await prepareBatch(manifest, { invoke, concurrency: 1, maxPolls: 0 });
  await prepareBatch(manifest, { invoke, concurrency: 1, maxPolls: 0, retryFailed: true });
  assert.equal(retries, 0);
  assert.deepEqual([...outstanding], ["second"]);
  const completed = await prepareBatch(manifest, {
    invoke,
    concurrency: 1,
    maxPolls: 2,
    pollIntervalMs: 0,
    retryFailed: true,
  });
  assert.equal(completed.summary.ready, 1);
  assert.equal(retries, 1);
  assert.deepEqual([...outstanding], []);
});
