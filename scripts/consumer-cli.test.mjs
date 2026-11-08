import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumerVerdictsSource, consumerVerdictsPath } from "./consumer-verdicts.mjs";
import { createCli } from "../skills/yap/scripts/yap-cli.mjs";
import { startProjectService } from "../apps/service/dist/project-service.js";
import {
  operationSchema,
  refusalRetryable,
  refusalRetryAfterMs,
} from "../packages/protocol/dist/index.js";

test("preserves a non-retryable service refusal without inventing a resolving call", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "yap-retry-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = await startProjectService({
    home,
    autoPrepareModels: false,
    autoTranscribe: false,
  });
  t.after(() => service.close());
  await assert.rejects(
    createCli({
      executable: new URL("../apps/cli/dist/main.js", import.meta.url).pathname,
      socket: service.socketPath,
    })("job.get", { jobId: "missing" }),
    (error) => {
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, { jobId: "missing" });
      return true;
    },
  );
});

async function fixture(t, body) {
  const directory = await mkdtemp(join(tmpdir(), "yap-consumer-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "yap");
  await writeFile(executable, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return executable;
}

test("preserves a failed CLI envelope even when the process exits nonzero", async (t) => {
  const executable = await fixture(
    t,
    `
    console.log(JSON.stringify({ok:false,error:{code:"MODEL_NOT_PREPARED",message:"prepare explicitly",retryable:true,retryAfterMs:15000,details:{modelId:"parakeet",retry:{operation:"model.status",params:{modelId:"parakeet"}}}}}));
    process.exitCode=1;
  `,
  );
  await assert.rejects(createCli({ executable })("transcript.retry", {}), (error) => {
    assert.equal(error.code, "MODEL_NOT_PREPARED");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 15000);
    assert.deepEqual(error.details, {
      modelId: "parakeet",
      retry: { operation: "model.status", params: { modelId: "parakeet" } },
    });
    operationSchema.parse(error.details.retry);
    return true;
  });
});

test("passes literal parameters on stdin and the explicit socket without shell expansion", async (t) => {
  const executable = await fixture(
    t,
    `
    let bytes="";
    process.stdin.on("data", chunk => bytes+=chunk);
    process.stdin.on("end", () => console.log(JSON.stringify({ok:true,data:{args:process.argv.slice(2),params:JSON.parse(bytes)}})));
  `,
  );
  const params = { path: "/tmp/literal $(touch nope) `quoted` file.mov" };
  const data = await createCli({ executable, socket: "/tmp/socket with spaces" })(
    "asset.import",
    params,
  );
  assert.deepEqual(data, {
    args: ["asset.import", "--params", "-", "--socket", "/tmp/socket with spaces"],
    params,
  });
});

test("terminates excessive diagnostics and a non-answering CLI within bounded work", async (t) => {
  const noisy = await fixture(
    t,
    `process.stderr.write("x".repeat(256)); setInterval(()=>{},1000);`,
  );
  await assert.rejects(createCli({ executable: noisy, maxBytes: 32 })("asset.get", {}), {
    code: "LIMIT_EXCEEDED",
  });
  const silent = await fixture(t, `setInterval(()=>{},1000);`);
  await assert.rejects(createCli({ executable: silent, timeoutMs: 200 })("asset.get", {}), {
    code: "CLI_TIMEOUT",
  });
});

test("a descendant retaining output pipes cannot extend the CLI deadline", async (t) => {
  const executable = await fixture(
    t,
    `
    const {spawn} = require("node:child_process");
    const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});
    require("node:fs").writeFileSync(process.argv[1]+".child",String(child.pid));
    child.unref();
    setInterval(()=>{},1000);
  `,
  );
  const start = Date.now();
  try {
    await assert.rejects(createCli({ executable, timeoutMs: 200 })("asset.get", {}), {
      code: "CLI_TIMEOUT",
    });
    assert.ok(Date.now() - start < 1000, "inherited pipes extended the deadline");
  } finally {
    const pid = Number(await readFile(executable + ".child", "utf8"));
    process.kill(pid, "SIGKILL");
  }
});

test("shipped consumer refusal verdicts match the authoritative ledger", async () => {
  assert.equal(await readFile(consumerVerdictsPath, "utf8"), consumerVerdictsSource());
});

test("local consumer refusals use the ledger for cancellation, launch, output and response failures", async (t) => {
  const executable = await fixture(t, `console.log("not-json");`);
  const canceled = new AbortController();
  canceled.abort();
  for (const [code, call] of [
    [
      "CANCELED",
      () => createCli({ executable })("service.health", {}, { signal: canceled.signal }),
    ],
    [
      "CLI_UNAVAILABLE",
      () => createCli({ executable: executable + ".missing" })("service.health", {}),
    ],
    ["LIMIT_EXCEEDED", () => createCli({ executable, maxBytes: 1 })("service.health", {})],
    ["INVALID_CLI_RESPONSE", () => createCli({ executable })("service.health", {})],
  ]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, refusalRetryable(code));
      assert.equal(error.retryAfterMs, refusalRetryAfterMs(code));
      return true;
    });
  }
});
