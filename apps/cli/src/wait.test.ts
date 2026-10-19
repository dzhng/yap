import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callLocal } from "@yap/client";
import { Catalog } from "@yap/core/catalog";
import { writeOutputIssues } from "@yap/core/issues";
import { listenLocal } from "@yap/service";
import { responseSchema, type OperationRequest, type OperationResult } from "@yap/protocol";
import { startProjectService } from "../../service/dist/project-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(
  handler: (request: OperationRequest) => OperationResult | Promise<OperationResult>,
) {
  const home = await mkdtemp("/tmp/yap-wait-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const calls: OperationRequest[] = [];
  const service = await listenLocal({
    runtimeDirectory: home,
    handler: (request) => {
      calls.push(request);
      return handler(request);
    },
  });
  cleanups.push(() => service.close());
  const run = (
    operation: string,
    params: Record<string, unknown>,
    args: string[] = [],
    cancelAfterMs?: number,
    nodeArgs: string[] = [],
  ) => {
    const child = spawn(
      process.execPath,
      [
        ...nodeArgs,
        new URL("../dist/main.js", import.meta.url).pathname,
        operation,
        "--socket",
        service.socketPath,
        "--params",
        JSON.stringify(params),
        "--id",
        "wait-case",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let cancel: ReturnType<typeof setTimeout> | undefined;
    child.once("exit", () => {
      if (cancel) clearTimeout(cancel);
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
      if (cancelAfterMs !== undefined && !cancel)
        cancel = setTimeout(() => child.kill("SIGINT"), cancelAfterMs);
    });
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, stdout, stderr }));
      },
    );
  };
  return { home, calls, run, stop: () => service.close() };
}
const job = (state: string, generation = 2) => ({
  id: "job",
  attemptId: `attempt-${generation}`,
  attemptGeneration: generation,
  state,
  target: { kind: "import", id: "admission" },
  published: { generation: "1", attemptId: "older", output: { assetId: "old" }, issues: [] },
});
/** What an import reports: the status of its work, referring to the job that runs it. */
const work = (state: string) => {
  const { id, target: _target, ...rest } = job(state);
  return { ...rest, jobId: id };
};

test("wait submits a mutation once and waits for its current generation instead of accepting retained output", async () => {
  let reads = 0;
  const f = await fixture((request) => {
    if (request.operation === "asset.import") return { ok: true, data: work("queued") };
    expect(request.operation).toBe("job.get");
    return {
      ok: true,
      data:
        ++reads === 1
          ? job("running")
          : {
              ...job("ready"),
              published: {
                generation: "2",
                attemptId: "attempt-2",
                output: { assetId: "new" },
                issues: [],
              },
            },
    };
  });
  const output = await f.run(
    "asset.import",
    { path: "/fixture/source.mov", requestId: "admission" },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code).toBe(0);
  expect(output.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    id: "wait-case",
    ok: true,
    data: {
      state: "ready",
      attemptGeneration: 2,
      published: { output: { assetId: "new" } },
    },
  });
  expect(f.calls.map((request) => request.operation)).toEqual([
    "asset.import",
    "job.get",
    "job.get",
  ]);
  expect(output.stderr).toContain("running");
});

test("pending timeout preserves pinned acknowledgement and current generation, closes unused leases and creates no final file", async () => {
  const f = await fixture((request) => {
    if (request.operation === "frame.get")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          state: "running",
          jobId: "job",
          published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
          delivery: { token: "old-pin", sizeBytes: 1, expiresAtMs: Date.now() + 30000 },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    expect(request.operation).toBe("job.get");
    return {
      ok: true,
      data: { ...job("running"), target: { kind: "project", id: "p", revisionId: "r7" } },
    };
  });
  const destination = `${f.home}/must-not-exist.png`;
  const output = await f.run("frame.get", { projectId: "p", atUs: 7 }, [
    "--wait",
    "--timeout-ms",
    "80",
    "--output",
    destination,
  ]);
  expect(output.code).toBe(2);
  expect(JSON.parse(output.stdout)).toMatchObject({
    ok: true,
    data: { state: "running", published: { generation: "1" } },
    wait: {
      state: "timed_out",
      timeoutMs: 80,
      job: { id: "job", attemptGeneration: 2, attemptId: "attempt-2" },
    },
  });
  expect(f.calls.filter((request) => request.operation === "frame.get")).toHaveLength(1);
  const { stat } = await import("node:fs/promises");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an older ready rendition never becomes the final file while its replacement is still running", async () => {
  const f = await fixture((request) => {
    if (request.operation === "frame.get")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          state: "ready",
          jobId: "job",
          published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
          delivery: { token: "old-pin", sizeBytes: 1, expiresAtMs: Date.now() + 30000 },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    if (request.operation === "artifact.read")
      return { ok: true, data: { data: "eA==", offsetBytes: 0, nextOffsetBytes: 1, eof: true } };
    expect(request.operation).toBe("job.get");
    return {
      ok: true,
      data: { ...job("running"), target: { kind: "project", id: "p", revisionId: "r7" } },
    };
  });
  const destination = `${f.home}/not-the-replacement.png`;
  const output = await f.run("frame.get", { projectId: "p", atUs: 7 }, [
    "--wait",
    "--timeout-ms",
    "80",
    "--output",
    destination,
  ]);
  expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, wait: { state: "timed_out" } });
  expect(output.code).toBe(2);
  expect(f.calls.some((request) => request.operation === "artifact.read")).toBe(false);
  const { stat } = await import("node:fs/promises");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test("wait refuses a changed current job target and preserves the acknowledgement", async () => {
  let reads = 0;
  const f = await fixture((request) => {
    if (request.operation === "asset.import") return { ok: true, data: work("queued") };
    return {
      ok: true,
      data: {
        ...job("running"),
        target: { kind: "import", id: ++reads === 1 ? "admission" : "other" },
      },
    };
  });
  const output = await f.run(
    "asset.import",
    { path: "/fixture/source.mov", requestId: "admission" },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    ok: true,
    data: { target: { kind: "import", id: "admission" } },
    wait: { state: "interrupted", error: { code: "INVALID_RESPONSE" } },
  });
});

test("a prepared-audio dependency finishing does not finish the requested measurement", async () => {
  let reads = 0;
  const f = await fixture((request) => {
    if (request.operation === "audio.measure")
      return {
        ok: true,
        data: {
          assetId: "a",
          streamId: "s",
          state: "running",
          jobId: ++reads === 1 ? "audio-job" : "measurement-job",
          published: null,
        },
      };
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job(request.params.jobId === "audio-job" ? "ready" : "failed"),
          id: request.params.jobId,
          target: { kind: "asset", id: "a" },
        },
      };
    throw new Error(`unexpected ${request.operation}`);
  });
  const output = await f.run("audio.measure", { assetId: "a", streamId: "s" }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { id: "measurement-job", state: "failed" },
    wait: { state: "settled", job: { id: "measurement-job" } },
  });
  expect(f.calls.filter((r) => r.operation === "audio.measure").map((r) => r.params)).toEqual([
    { assetId: "a", streamId: "s" },
    { assetId: "a", streamId: "s" },
  ]);
});

test("model preparation waits through its advertised model.status getter without resubmitting source choices", async () => {
  const f = await fixture((request) => {
    if (request.operation === "model.prepare")
      return { ok: true, data: { modelId: "whisper-tiny", state: "running" } };
    expect(request.operation).toBe("model.status");
    return { ok: true, data: { modelId: "whisper-tiny", state: "ready" } };
  });
  const output = await f.run(
    "model.prepare",
    { modelId: "whisper-tiny", modelSource: "/fixture/model" },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { state: "ready" },
    wait: { state: "settled" },
  });
  expect(f.calls.map((r) => r.params)).toEqual([
    { modelId: "whisper-tiny", modelSource: "/fixture/model" },
    { modelId: "whisper-tiny" },
  ]);
});

test("alignment preparation waits for its admitted job and reuses the same literal request", async () => {
  const params = {
    assetId: "a",
    streamId: "s",
    channel: 0,
    sourceRange: { startUs: 0, endUs: 1000000 },
    text: "Hi, literal text!",
    modelId: "nemo-ctc110",
  };
  let preparations = 0;
  const f = await fixture((request) => {
    if (request.operation === "job.get")
      return { ok: true, data: { ...job("ready"), target: { kind: "asset", id: "a" } } };
    expect(request.operation).toBe("alignment.observe");
    expect(request.params).toEqual(params);
    return {
      ok: true,
      data:
        ++preparations === 1
          ? { state: "running", jobId: "job" }
          : {
              state: "ready",
              published: {
                generation: "1",
                attemptId: "attempt",
                output: { generation: "attempt", source: { text: params.text } },
              },
            },
    };
  });
  const output = await f.run("alignment.observe", params, ["--wait", "--timeout-ms", "1000"]);
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { state: "ready", published: { output: { generation: "attempt" } } },
    wait: { state: "settled" },
  });
  expect(f.calls.map((r) => r.operation)).toEqual([
    "alignment.observe",
    "job.get",
    "alignment.observe",
  ]);
});

test("bounded transcript preparation waits for its admitted generation without resubmitting inference", async () => {
  const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
  const selection = { assetId: "a", streamId: "s", acquisitionId: "acquired" };
  const f = await fixture((request) => {
    if (request.operation === "transcript.transcribe")
      return { ok: true, data: { ...selection, state: "running", jobId: "job" } };
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job("ready"),
          attemptId: generation,
          target: { kind: "asset", id: "a" },
        },
      };
    expect(request.operation).toBe("transcript.get");
    return { ok: true, data: { ...selection, state: "ready", generation, page: { rows: [] } } };
  });
  const output = await f.run(
    "transcript.transcribe",
    {
      ...selection,
      sourceRange: { startUs: 0, endUs: 1000000 },
      context: { beforeUs: 10, afterUs: 20 },
    },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { state: "ready", generation },
    wait: { state: "settled", job: { attemptId: generation } },
  });
  expect(f.calls.map((r) => r.operation)).toEqual([
    "transcript.transcribe",
    "job.get",
    "transcript.get",
  ]);
  expect(f.calls[2]!.params).toEqual({
    ...selection,
    generation,
  });
});

test("a clamped transcript preparation keeps its range-clamped issue through the pinned read", async () => {
  const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
  const selection = { assetId: "a", streamId: "s" };
  const clamp = {
    code: "range-clamped",
    message: "clamped",
    at: { range: { startUs: 0, endUs: 1000 } },
    evidence: {
      requested: { startUs: 0, endUs: 5000 },
      applied: { startUs: 0, endUs: 1000 },
      bounds: { startUs: 0, endUs: 1000 },
    },
  };
  const f = await fixture((request) => {
    if (request.operation === "transcript.transcribe")
      return {
        ok: true,
        data: { ...selection, state: "running", jobId: "job", issues: [clamp] },
      };
    if (request.operation === "job.get")
      return {
        ok: true,
        data: { ...job("ready"), attemptId: generation, target: { kind: "asset", id: "a" } },
      };
    return {
      ok: true,
      data: { ...selection, state: "ready", generation, issues: [], page: { rows: [] } },
    };
  });
  const output = await f.run(
    "transcript.transcribe",
    { ...selection, sourceRange: { startUs: 0, endUs: 5000 } },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).data.issues).toEqual([clamp]);
  expect(output.stderr).toContain("transcript.transcribe: ready (1 issues)");
});

test("a clamp joined to a full read page stays within the issue bound", async () => {
  const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
  const selection = { assetId: "a", streamId: "s" };
  const clamp = { code: "range-clamped", message: "clamped", evidence: {} };
  const word = { code: "timing-clamped", message: "clamped", evidence: {} };
  const full = [
    ...Array.from({ length: 1000 }, () => word),
    { code: "issues-truncated", message: "5 more issues were omitted", evidence: { omitted: 5 } },
  ];
  const f = await fixture((request) => {
    if (request.operation === "transcript.transcribe")
      return {
        ok: true,
        data: { ...selection, state: "running", jobId: "job", issues: [clamp] },
      };
    if (request.operation === "job.get")
      return {
        ok: true,
        data: { ...job("ready"), attemptId: generation, target: { kind: "asset", id: "a" } },
      };
    return {
      ok: true,
      data: { ...selection, state: "ready", generation, issues: full, page: { rows: [] } },
    };
  });
  const output = await f.run(
    "transcript.transcribe",
    { ...selection, sourceRange: { startUs: 0, endUs: 5000 } },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code, output.stdout + output.stderr).toBe(0);
  const issues = JSON.parse(output.stdout).data.issues;
  expect(issues).toHaveLength(1001);
  expect(issues[0]).toEqual(clamp);
  expect(issues.at(-1)).toMatchObject({ code: "issues-truncated", evidence: { omitted: 6 } });
  expect(output.stderr).toContain("transcript.transcribe: ready (1006 issues)");
});

test.each(["running", "ready"])(
  "a %s transcript preparation reports the published transcript's issues once it settles",
  async (acknowledged) => {
    const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
    const selection = { assetId: "a", streamId: "s" };
    // Anchored to no word, so only the publication carries it.
    const dropped = {
      code: "word-dropped",
      message: "dropped",
      at: { range: { startUs: 0, endUs: 1000 } },
      evidence: {},
    };
    const published = { generation: "2", issues: [dropped] };
    const f = await fixture((request) => {
      if (request.operation === "transcript.transcribe")
        return {
          ok: true,
          data: {
            ...selection,
            state: acknowledged,
            jobId: "job",
            issues: [],
            published: acknowledged === "ready" ? { ...published, output: { generation } } : null,
          },
        };
      if (request.operation === "job.get")
        return {
          ok: true,
          data: { ...job("ready"), attemptId: generation, target: { kind: "asset", id: "a" } },
        };
      expect(request.operation).toBe("transcript.get");
      return {
        ok: true,
        data: { ...selection, state: "ready", generation, issues: [], published, page: {} },
      };
    });
    const output = await f.run("transcript.transcribe", selection, [
      "--wait",
      "--timeout-ms",
      "1000",
    ]);
    expect(output.code, output.stdout + output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).data.published.issues).toEqual([dropped]);
    expect(output.stderr).toContain("transcript.transcribe: ready (1 issues)");
  },
);

test("rendered recognition waits on the project attempt and reads its words pinned to the published generation", async () => {
  const params = {
    projectId: "p",
    revisionId: "r",
    range: { startUs: 1000000, endUs: 2000000 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    rendition: { sampleRate: 16000, channels: 1 },
  };
  const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
  const word = { type: "word", text: "hello", projectRange: { startUs: 1000000, endUs: 1200000 } };
  const f = await fixture((request) => {
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job("ready"),
          attemptId: generation,
          target: { kind: "project", id: "p", revisionId: "r" },
        },
      };
    if (request.operation === "transcript.render.get")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r",
          generation,
          kind: "rendered-speech",
          state: "ready",
          issues: [],
          page: { rows: [word], nextCursor: null },
        },
      };
    expect(request.operation).toBe("transcript.render.prepare");
    expect(request.params).toEqual(params);
    return { ok: true, data: { ...params, state: "queued", jobId: "job", published: null } };
  });
  const output = await f.run("transcript.render.prepare", params, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { state: "ready", generation, page: { rows: [word] } },
    wait: { state: "settled", job: { attemptId: generation } },
  });
  expect(f.calls.map((call) => call.operation)).toEqual([
    "transcript.render.prepare",
    "job.get",
    "transcript.render.get",
  ]);
  expect(f.calls[2]!.params).toEqual({ projectId: "p", revisionId: "r", generation });
});

test("a clamped render preparation keeps its range-clamped issue through the pinned words read", async () => {
  const params = {
    projectId: "p",
    revisionId: "r",
    range: { startUs: 0, endUs: 5000 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    rendition: { sampleRate: 16000, channels: 1 },
  };
  const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
  const clamp = { code: "range-clamped", message: "clamped", evidence: {} };
  const f = await fixture((request) => {
    if (request.operation === "transcript.render.get")
      return {
        ok: true,
        data: { projectId: "p", revisionId: "r", generation, state: "ready", issues: [], page: {} },
      };
    return {
      ok: true,
      data: {
        ...params,
        state: "ready",
        jobId: null,
        issues: [clamp],
        published: { generation: "1", attemptId: generation, output: { generation }, issues: [] },
      },
    };
  });
  const output = await f.run("transcript.render.prepare", params, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).data.issues).toEqual([clamp]);
  expect(output.stderr).toContain("transcript.render.prepare: ready (1 issues)");
});

test("an already published render preparation reads its words without waiting on a job", async () => {
  const params = {
    projectId: "p",
    revisionId: "r",
    range: { startUs: 0, endUs: 1000000 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    rendition: { sampleRate: 16000, channels: 1 },
  };
  const generation = "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90";
  const f = await fixture((request) => {
    if (request.operation === "transcript.render.get")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r",
          generation,
          state: "ready",
          issues: [],
          page: { rows: [{ type: "word", text: "hi" }], nextCursor: null },
        },
      };
    expect(request.operation).toBe("transcript.render.prepare");
    return {
      ok: true,
      data: {
        ...params,
        state: "ready",
        jobId: null,
        published: { generation: "1", attemptId: generation, output: { generation }, issues: [] },
      },
    };
  });
  const output = await f.run("transcript.render.prepare", params, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({ data: { page: { rows: [{ text: "hi" }] } } });
  expect(f.calls.map((call) => call.operation)).toEqual([
    "transcript.render.prepare",
    "transcript.render.get",
  ]);
});

test.each(["package.open", "package.status"])(
  "%s observes the process-local admission through package.status",
  async (operation) => {
    let admissions = 0;
    const f = await fixture((request) => {
      if (request.operation === "job.get")
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Context job is not public",
            retryable: false,
            details: {},
          },
        };
      if (request.operation === operation && admissions++ === 0)
        return {
          ok: true,
          data: {
            id: "admission",
            state: "queued",
            jobId: "opaque-context-job",
            packageHandle: null,
            error: null,
          },
        };
      expect(request.operation).toBe("package.status");
      expect(request.params).toEqual({ admissionId: "admission" });
      return {
        ok: true,
        data: {
          id: "admission",
          state: "ready",
          jobId: "opaque-context-job",
          packageHandle: "process-local-handle",
          error: null,
        },
      };
    });
    const output = await f.run(
      operation,
      operation === "package.open"
        ? { path: "/fixture/project.zip" }
        : { admissionId: "admission" },
      ["--wait", "--timeout-ms", "1000"],
    );
    expect(output.code).toBe(0);
    const reply = JSON.parse(output.stdout);
    expect(reply).toMatchObject({
      data: { id: "admission", state: "ready", packageHandle: "process-local-handle" },
      wait: { state: "settled" },
    });
    expect(reply.wait).not.toHaveProperty("job");
    expect(f.calls.map((r) => r.operation)).toEqual([operation, "package.status"]);
  },
);

test("a lost process-local package admission preserves its acknowledgement without claiming rollback", async () => {
  const f = await fixture((request) =>
    request.operation === "package.open"
      ? {
          ok: true,
          data: {
            id: "admission",
            state: "running",
            jobId: "opaque-context-job",
            packageHandle: null,
            error: null,
          },
        }
      : {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Package admission expired or does not exist",
            retryable: false,
            details: {},
          },
        },
  );
  const output = await f.run("package.open", { path: "/fixture/project.zip" }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code).toBe(1);
  const reply = JSON.parse(output.stdout);
  expect(reply).toMatchObject({
    ok: true,
    data: { id: "admission", state: "running", packageHandle: null },
    wait: { state: "interrupted", error: { code: "NOT_FOUND" } },
  });
  expect(reply.wait).not.toHaveProperty("job");
  expect(f.calls.map((r) => r.operation)).toEqual(["package.open", "package.status"]);
});

test.each(["deadline", "foreign"])(
  "package admission %s preserves the admitted identity",
  async (mode) => {
    const admission = {
      id: "admission",
      state: "running",
      jobId: "opaque-context-job",
      packageHandle: null,
      error: null,
    };
    const f = await fixture((request) => ({
      ok: true,
      data:
        request.operation === "package.status" && mode === "foreign"
          ? { ...admission, id: "foreign", state: "ready", packageHandle: "foreign-handle" }
          : admission,
    }));
    const output = await f.run("package.open", { path: "/fixture/project.zip" }, [
      "--wait",
      "--timeout-ms",
      mode === "deadline" ? "240" : "1000",
    ]);
    expect(output.code).toBe(mode === "deadline" ? 2 : 1);
    const reply = JSON.parse(output.stdout);
    expect(reply).toMatchObject({
      data: admission,
      wait: { state: mode === "deadline" ? "timed_out" : "interrupted" },
    });
    if (mode === "foreign") expect(reply.wait.error.code).toBe("INVALID_RESPONSE");
    expect(reply.wait).not.toHaveProperty("job");
    expect(f.calls.filter((r) => r.operation === "package.open")).toHaveLength(1);
    expect(f.calls.filter((r) => r.operation === "package.status").length).toBeGreaterThan(0);
    expect(f.calls.filter((r) => r.operation === "job.get")).toEqual([]);
  },
);

test("package closing remains pending until its process-local owner settles", async () => {
  let reads = 0;
  const f = await fixture(() => ({
    ok: true,
    data: {
      id: "admission",
      state: reads++ === 0 ? "running" : "closed",
      jobId: "opaque-context-job",
      packageHandle: null,
      error: null,
    },
  }));
  const output = await f.run("package.status", { admissionId: "admission" }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { id: "admission", state: "closed" },
    wait: { state: "settled" },
  });
  expect(f.calls.map((r) => r.operation)).toEqual(["package.status", "package.status"]);
});

test("batch wait inspects replacement jobs before accepting retained ready items", async () => {
  const f = await fixture((request) => {
    if (request.operation === "frame.batch")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          items: [
            {
              atUs: 7,
              ok: true,
              data: {
                state: "ready",
                jobId: "job",
                published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
                delivery: { token: "old", sizeBytes: 1, expiresAtMs: Date.now() + 30000 },
              },
            },
            {
              atUs: 9,
              ok: false,
              error: {
                code: "OUT_OF_RANGE",
                message: "unsupported",
                retryable: false,
                details: {},
              },
            },
          ],
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    expect(request.operation).toBe("job.get");
    return {
      ok: true,
      data: { ...job("running"), target: { kind: "project", id: "p", revisionId: "r7" } },
    };
  });
  const output = await f.run("frame.batch", { projectId: "p", atUs: [7, 9] }, [
    "--wait",
    "--timeout-ms",
    "80",
    "--output",
    `${f.home}/no-batch`,
  ]);
  expect(output.code).toBe(2);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: {
      revisionId: "r7",
      items: [{ ok: true }, { ok: false, error: { code: "OUT_OF_RANGE" } }],
    },
    wait: { state: "timed_out" },
  });
  expect(f.calls.some((r) => r.operation === "artifact.read")).toBe(false);
});

test("a changed pinned revision interrupts waiting without delivering another revision", async () => {
  let reads = 0;
  const f = await fixture((request) => {
    if (request.operation === "frame.get")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: ++reads === 1 ? "r7" : "r8",
          state: reads === 1 ? "running" : "ready",
          jobId: "job",
          published: null,
          delivery:
            reads === 1
              ? null
              : { token: "foreign-revision", sizeBytes: 1, expiresAtMs: Date.now() + 30000 },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    return {
      ok: true,
      data: { ...job("ready"), target: { kind: "project", id: "p", revisionId: "r7" } },
    };
  });
  const output = await f.run("frame.get", { projectId: "p", atUs: 7 }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { state: "running" },
    wait: { state: "interrupted", error: { code: "INVALID_RESPONSE" } },
  });
  expect(
    f.calls.filter((r) => r.operation === "frame.get").map((r) => r.params.revisionId),
  ).toEqual([undefined, "r7"]);
});

test("a hung inspection respects the total wait deadline and preserves admitted work", async () => {
  const f = await fixture(async (request) => {
    if (request.operation === "asset.import") return { ok: true, data: work("queued") };
    await new Promise((resolve) => setTimeout(resolve, 160));
    return { ok: true, data: job("running") };
  });
  const output = await f.run(
    "asset.import",
    { requestId: "admission", path: "/fixture/source.mov" },
    ["--wait", "--timeout-ms", "80"],
  );
  expect(output.code).toBe(2);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { state: "queued", jobId: "job" },
    wait: { state: "timed_out" },
  });
  expect(f.calls.filter((r) => r.operation === "asset.import")).toHaveLength(1);
});

test("SIGINT preserves the acknowledged selection and closes leases after cancellation", async () => {
  const f = await fixture(async (request) => {
    if (request.operation === "frame.get")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          state: "running",
          jobId: "job",
          published: null,
          delivery: { token: "unused", sizeBytes: 1, expiresAtMs: Date.now() + 30000 },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    await new Promise((resolve) => setTimeout(resolve, 220));
    return { ok: true, data: job("running") };
  });
  const output = await f.run(
    "frame.get",
    { projectId: "p", atUs: 7 },
    ["--wait", "--timeout-ms", "1000"],
    150,
  );
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { revisionId: "r7", jobId: "job" },
    wait: { state: "interrupted", error: { code: "ABORTED" } },
  });
  expect(
    f.calls.filter((r) => r.operation === "artifact.close").map((r) => r.params.token),
  ).toContain("unused");
});

test("admission timeout reports uncertainty without claiming a mutation was rolled back", async () => {
  const f = await fixture(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
    return { ok: true, data: job("queued") };
  });
  const output = await f.run(
    "asset.import",
    { requestId: "admission", path: "/fixture/source.mov" },
    ["--wait", "--timeout-ms", "80"],
  );
  expect(output.code).toBe(2);
  expect(JSON.parse(output.stdout)).toMatchObject({
    ok: false,
    error: { code: "ABORTED" },
    wait: { state: "timed_out", timeoutMs: 80 },
  });
  expect(f.calls.map((r) => r.operation)).toEqual(["asset.import"]);
});

test("a service disappearing after admission interrupts waiting with durable identity", async () => {
  const f = await fixture(async (request) => {
    if (request.operation === "asset.import") return { ok: true, data: work("queued") };
    void f.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true, data: job("running") };
  });
  const output = await f.run(
    "asset.import",
    { requestId: "admission", path: "/fixture/source.mov" },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    ok: true,
    data: { jobId: "job", state: "queued" },
    wait: {
      state: "interrupted",
      error: { code: expect.stringMatching(/^(CONNECTION_|INVALID_RESPONSE)/) },
    },
  });
  expect(f.calls.filter((r) => r.operation === "asset.import")).toHaveLength(1);
});

test("the wait deadline covers media delivery and never publishes an incomplete destination", async () => {
  const f = await fixture(async (request) => {
    if (request.operation === "audio.measure")
      return {
        ok: true,
        data: {
          assetId: "a",
          streamId: "s",
          state: "ready",
          published: { generation: "1", output: { mediaType: "application/json" }, issues: [] },
          delivery: { token: "measurement", sizeBytes: 2, expiresAtMs: Date.now() + 30000 },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    expect(request.operation).toBe("artifact.read");
    await new Promise((resolve) => setTimeout(resolve, 180));
    return {
      ok: true,
      data: {
        offsetBytes: 0,
        nextOffsetBytes: 2,
        eof: true,
        data: Buffer.from("{}").toString("base64"),
      },
    };
  });
  const destination = `${f.home}/measurement.json`;
  const output = await f.run("audio.measure", { assetId: "a", streamId: "s" }, [
    "--wait",
    "--timeout-ms",
    "80",
    "--output",
    destination,
  ]);
  expect(output.code).toBe(2);
  expect(JSON.parse(output.stdout)).toMatchObject({
    ok: true,
    data: { assetId: "a", state: "ready" },
    wait: { state: "timed_out" },
  });
  const { stat, readdir } = await import("node:fs/promises");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(f.home)).filter((name) => name.startsWith(".yap-media-"))).toEqual([]);
  expect(f.calls.some((r) => r.operation === "artifact.close")).toBe(true);
});

test("wait budget validation happens before discovery while ordinary acknowledgements stay unchanged", async () => {
  const f = await fixture(() => ({ ok: true, data: job("queued") }));
  for (const args of [
    ["--wait"],
    ["--timeout-ms", "80"],
    ["--wait", "--timeout-ms", "0"],
    ["--wait", "--timeout-ms", "1.5"],
    ["--wait", "--timeout-ms", "2147483648"],
  ]) {
    const output = await f.run(
      "asset.import",
      { requestId: "admission", path: "/fixture/source.mov" },
      args,
    );
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  }
  expect(f.calls).toEqual([]);
  const ordinary = await f.run("asset.import", {
    requestId: "admission",
    path: "/fixture/source.mov",
  });
  expect(ordinary.code).toBe(0);
  expect(JSON.parse(ordinary.stdout)).toEqual({ id: "wait-case", ok: true, data: job("queued") });
  expect(f.calls.map((r) => r.operation)).toEqual(["asset.import"]);
});

test("a delayed batch delivers only completed items and retains each terminal failure", async () => {
  let reads = 0;
  const f = await fixture((request) => {
    if (request.operation === "frame.batch") {
      const ready = ++reads > 1;
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          items: [
            {
              atUs: 7,
              ok: true,
              data: {
                state: ready ? "ready" : "running",
                jobId: "ready-job",
                published: ready
                  ? { generation: "2", output: { mediaType: "image/png" }, issues: [] }
                  : null,
                delivery: ready
                  ? { token: "ready", sizeBytes: 2, expiresAtMs: Date.now() + 30000 }
                  : null,
              },
            },
            {
              atUs: 9,
              ok: false,
              error: {
                code: "OUT_OF_RANGE",
                message: "unsupported",
                retryable: false,
                details: {},
              },
            },
          ],
        },
      };
    }
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job("ready"),
          id: "ready-job",
          target: { kind: "project", id: "p", revisionId: "r7" },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    expect(request.operation).toBe("artifact.read");
    return {
      ok: true,
      data: {
        offsetBytes: 0,
        nextOffsetBytes: 2,
        eof: true,
        data: Buffer.from("ok").toString("base64"),
      },
    };
  });
  const directory = `${f.home}/completed-batch`;
  const output = await f.run("frame.batch", { projectId: "p", atUs: [7, 9] }, [
    "--wait",
    "--timeout-ms",
    "1000",
    "--output",
    directory,
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: {
      items: [
        { atUs: 7, ok: true, data: { output: `${directory}/01.png` } },
        { atUs: 9, ok: false, error: { code: "OUT_OF_RANGE" } },
      ],
    },
    wait: { state: "settled" },
  });
  const { readdir, readFile } = await import("node:fs/promises");
  expect(await readdir(directory)).toEqual(["01.png"]);
  expect(await readFile(`${directory}/01.png`, "utf8")).toBe("ok");
  expect(f.calls.filter((r) => r.operation.endsWith("retry"))).toEqual([]);
});

test("batch file publication drains a failed disk write without exposing a partial final file", async () => {
  const f = await fixture((request) => {
    if (request.operation === "frame.batch")
      return {
        ok: true,
        data: {
          assetId: "a",
          streamId: "s",
          items: [7, 9].map((atUs) => ({
            atUs,
            ok: true,
            data: {
              state: "ready",
              published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
              delivery: { token: `frame-${atUs}`, sizeBytes: 4, expiresAtMs: Date.now() + 30000 },
            },
          })),
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    expect(request.operation).toBe("artifact.read");
    return {
      ok: true,
      data: {
        offsetBytes: 0,
        nextOffsetBytes: 4,
        eof: true,
        data: Buffer.from("full").toString("base64"),
      },
    };
  });
  const preload = `${f.home}/disk-failure.mjs`;
  // The spawned consumer uses real files; only the external filesystem failure is controlled.
  await writeFile(
    preload,
    `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const probe = await fs.open(${JSON.stringify(`${f.home}/probe`)}, 'wx');
const prototype = Object.getPrototypeOf(probe);
await probe.close();
await fs.rm(${JSON.stringify(`${f.home}/probe`)});
let fail = true;
const directWrite = fs.writeFile;
const handleWrite = prototype.writeFile;
fs.writeFile = async function(path, data, options) {
  if (!fail) return directWrite(path, data, options);
  fail = false;
  await directWrite(path, data.subarray(0, 1), options);
  throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' });
};
prototype.writeFile = async function(data, options) {
  if (!fail) return handleWrite.call(this, data, options);
  fail = false;
  await handleWrite.call(this, data.subarray(0, 1), options);
  throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' });
};
syncBuiltinESMExports();
`,
  );
  const directory = `${f.home}/disk-batch`;
  const output = await f.run(
    "frame.batch",
    { assetId: "a", streamId: "s", atUs: [7, 9] },
    ["--wait", "--timeout-ms", "1000", "--output", directory],
    undefined,
    ["--import", preload],
  );
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: {
      items: [
        { atUs: 7, ok: false, error: { message: "fixture ENOSPC" } },
        { atUs: 9, ok: true, data: { output: `${directory}/02.png` } },
      ],
    },
    wait: { state: "settled" },
  });
  const { readdir, readFile } = await import("node:fs/promises");
  expect(await readdir(directory)).toEqual(["02.png"]);
  expect(await readFile(`${directory}/02.png`, "utf8")).toBe("full");
  expect(
    f.calls.filter((r) => r.operation === "artifact.close").map((r) => r.params.token),
  ).toEqual(["frame-7", "frame-9"]);
});

test("cached failed batch jobs drain every fresh retained lease while another item is pending", async () => {
  let reads = 0;
  const f = await fixture((request) => {
    if (request.operation === "frame.batch") {
      ++reads;
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          items: [7, 9].map((atUs) => ({
            atUs,
            ok: true,
            data: {
              state: atUs === 7 || reads >= 3 ? "ready" : "running",
              jobId: atUs === 7 ? "failed-job" : "ready-job",
              published:
                atUs === 7 || reads >= 3
                  ? {
                      generation: atUs === 7 ? "1" : "2",
                      output: { mediaType: "image/png" },
                      issues: [],
                    }
                  : null,
              delivery:
                atUs === 7 || reads >= 3
                  ? {
                      token: atUs === 7 ? `failed-${reads}` : "ready",
                      sizeBytes: 2,
                      expiresAtMs: Date.now() + 30000,
                    }
                  : null,
            },
          })),
        },
      };
    }
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job(
            request.params.jobId === "failed-job" ? "failed" : reads >= 3 ? "ready" : "running",
          ),
          id: request.params.jobId,
          ...(request.params.jobId === "ready-job"
            ? { published: { generation: "2", output: { assetId: "ready" }, issues: [] } }
            : {}),
          target: { kind: "project", id: "p", revisionId: "r7" },
        },
      };
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    expect(request.operation).toBe("artifact.read");
    expect(request.params.token).toBe("ready");
    return {
      ok: true,
      data: {
        offsetBytes: 0,
        nextOffsetBytes: 2,
        eof: true,
        data: Buffer.from("ok").toString("base64"),
      },
    };
  });
  const directory = `${f.home}/failed-batch`;
  const output = await f.run("frame.batch", { projectId: "p", atUs: [7, 9] }, [
    "--wait",
    "--timeout-ms",
    "1500",
    "--output",
    directory,
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: {
      items: [
        { atUs: 7, ok: true, data: { state: "failed", id: "failed-job" } },
        { atUs: 9, ok: true, data: { output: `${directory}/02.png` } },
      ],
    },
    wait: { state: "settled" },
  });
  expect(
    f.calls.filter((r) => r.operation === "artifact.close").map((r) => r.params.token),
  ).toEqual(["failed-1", "failed-2", "failed-3", "ready"]);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(directory)).toEqual(["02.png"]);
});

test("a job for a different selected source cannot settle an acknowledged evidence read", async () => {
  const f = await fixture((request) =>
    request.operation === "audio.measure"
      ? {
          ok: true,
          data: { assetId: "a", streamId: "s", state: "running", jobId: "job", published: null },
        }
      : { ok: true, data: { ...job("ready"), target: { kind: "asset", id: "different" } } },
  );
  const output = await f.run("audio.measure", { assetId: "a", streamId: "s" }, [
    "--wait",
    "--timeout-ms",
    "350",
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { assetId: "a", state: "running" },
    wait: { state: "interrupted", error: { code: "INVALID_RESPONSE" } },
  });
});

test.each(["failed", "canceled"])(
  "a %s current replacement never delivers its older retained publication or retries it",
  async (state) => {
    const f = await fixture((request) => {
      if (request.operation === "frame.get")
        return {
          ok: true,
          data: {
            projectId: "p",
            revisionId: "r7",
            state: "ready",
            jobId: "job",
            published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
            delivery: { token: "old", sizeBytes: 1, expiresAtMs: Date.now() + 30000 },
          },
        };
      if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
      expect(request.operation).toBe("job.get");
      return {
        ok: true,
        data: { ...job(state), target: { kind: "project", id: "p", revisionId: "r7" } },
      };
    });
    const output = await f.run("frame.get", { projectId: "p", atUs: 7 }, [
      "--wait",
      "--timeout-ms",
      "1000",
      "--output",
      `${f.home}/not-ready.png`,
    ]);
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      data: { state, attemptGeneration: 2, published: { generation: "1" } },
      wait: { state: "settled", job: { attemptGeneration: 2 } },
    });
    expect(
      f.calls.filter((r) => r.operation.endsWith("retry") || r.operation === "artifact.read"),
    ).toEqual([]);
  },
);

test("job.retry waits for the shared job and preserves its identity", async () => {
  const f = await fixture((request) => {
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job("ready"),
          published: { generation: "2" },
          jobId: "job",
          target: { kind: "project", id: "p" },
        },
      };
    expect(request.operation).toBe("job.retry");
    return {
      ok: true,
      data: {
        ...job("ready"),
        published: { generation: "2" },
        jobId: "job",
        target: { kind: "project", id: "p" },
      },
    };
  });
  const output = await f.run("job.retry", { jobId: "job" }, ["--wait", "--timeout-ms", "1000"]);
  expect(output.code).toBe(0);
  expect(f.calls.map((r) => r.operation)).toEqual(["job.retry", "job.get"]);
});

test.each(
  ["index.get", "transcript.get", "transcript.search"].flatMap((operation) =>
    [
      { initialReady: true, generation: "attempt-2", code: 0 },
      { initialReady: false, generation: "attempt-2", code: 0 },
      {
        initialReady: false,
        generation: "another-attempt",
        code: 1,
      },
    ].map((scenario) => ({ ...scenario, operation })),
  ),
)(
  "$operation pins completed page identity without unsupported parameters: $initialReady / $generation",
  async ({ initialReady, generation, code, operation }) => {
    let reads = 0;
    const ready = {
      assetId: "a",
      streamId: "s",
      state: "ready",
      generation,
      page:
        operation === "index.get"
          ? { metadata: { generation }, entries: [], nextCursor: null }
          : { transcript: { generation }, rows: [], matches: [], nextCursor: null },
    };
    const f = await fixture((request) => {
      if (request.operation === operation)
        return {
          ok: true,
          data:
            reads++ === 0 && !initialReady
              ? {
                  assetId: "a",
                  streamId: "s",
                  state: "running",
                  jobId: "job",
                  published: null,
                }
              : ready,
        };
      if (request.operation === "job.get")
        return { ok: true, data: { ...job("ready"), target: { kind: "asset", id: "a" } } };
      throw new Error(request.operation);
    });
    const params = {
      assetId: "a",
      streamId: "s",
      ...(operation === "transcript.search" ? { text: "word" } : {}),
    };
    const output = await f.run(operation, params, ["--wait", "--timeout-ms", "1000"]);
    expect(output.code).toBe(code);
    const reply = JSON.parse(output.stdout);
    if (code === 1)
      expect(reply).toMatchObject({
        data: { assetId: "a", state: "running", jobId: "job" },
        wait: {
          state: "interrupted",
          job: { id: "job", attemptGeneration: 2, attemptId: "attempt-2" },
          error: { code: "INVALID_RESPONSE" },
        },
      });
    else {
      expect(reply).toMatchObject({ data: { state: "ready" }, wait: { state: "settled" } });
      if (!initialReady)
        expect(reply.wait.job).toEqual({
          id: "job",
          attemptGeneration: 2,
          attemptId: "attempt-2",
        });
    }
    expect(f.calls.filter((r) => r.operation === operation).at(-1)?.params).not.toHaveProperty(
      "generation",
    );
  },
);

test.each(["export.create", "export.status", "export.recover"])(
  "%s waits for export.status and returns the committed receipt",
  async (operation) => {
    let admissions = 0;
    const f = await fixture((request) => {
      if (request.operation === operation && admissions++ === 0)
        return {
          ok: true,
          data: { exportId: "550e8400-e29b-41d4-a716-446655440000", state: "queued", jobId: "job" },
        };
      if (request.operation === "job.get")
        return { ok: true, data: { ...job("ready"), target: { kind: "project", id: "p" } } };
      expect(request.operation).toBe("export.status");
      return {
        ok: true,
        data: {
          exportId: "550e8400-e29b-41d4-a716-446655440000",
          state: "ready",
          output: "/tmp/final.mp4",
        },
      };
    });
    const output = await f.run(
      operation,
      operation === "export.create"
        ? {
            requestId: "550e8400-e29b-41d4-a716-446655440000",
            projectId: "p",
            kind: "video",
            directory: "/tmp",
            leaf: "final.mp4",
          }
        : { exportId: "550e8400-e29b-41d4-a716-446655440000" },
      ["--wait", "--timeout-ms", "1000"],
    );
    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      data: { state: "ready", output: "/tmp/final.mp4" },
      wait: { state: "settled" },
    });
  },
);

test.each(["export.recover", "export.status"])(
  "%s waits for nested recovery instead of the failed publication job",
  async (operation) => {
    let admissions = 0,
      polls = 0;
    const exportId = "550e8400-e29b-41d4-a716-446655440000";
    const base = {
      exportId,
      projectId: "p",
      jobId: "publication-job",
      snapshot: { revisionId: "r5" },
      destination: { directory: "/tmp", leaf: "final.mp4" },
    };
    const receipt = { leaf: "final.mp4", bytes: 2, sha256: "a".repeat(64) };
    const f = await fixture((request) => {
      if (request.operation === operation && admissions++ === 0)
        return {
          ok: true,
          data: {
            ...base,
            state: "failed",
            cleanupPending: true,
            receipt: null,
            output: null,
            recovery: { jobId: "recovery-job", state: "queued", published: null },
          },
        };
      if (request.operation === "job.get")
        return {
          ok: true,
          data: {
            ...job(
              request.params.jobId === "publication-job"
                ? "failed"
                : ++polls === 1
                  ? "running"
                  : "ready",
            ),
            id: request.params.jobId,
            target: { kind: "project", id: "p", revisionId: "r5" },
          },
        };
      expect(request.operation).toBe("export.status");
      expect(request.params).toEqual({ exportId });
      return {
        ok: true,
        data: {
          ...base,
          state: "ready",
          cleanupPending: false,
          receipt,
          output: "/tmp/final.mp4",
          recovery: { jobId: "recovery-job", state: "ready", published: { generation: "2" } },
        },
      };
    });
    const output = await f.run(operation, { exportId }, ["--wait", "--timeout-ms", "1500"]);
    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      data: { ...base, state: "ready", receipt, output: "/tmp/final.mp4" },
      wait: {
        state: "settled",
        job: { id: "recovery-job", attemptGeneration: 2, attemptId: "attempt-2" },
      },
    });
    expect(f.calls.filter((r) => r.operation === "job.get").map((r) => r.params.jobId)).toEqual([
      "recovery-job",
      "recovery-job",
      "recovery-job",
    ]);
    expect(f.calls.filter((r) => r.operation === "export.status").at(-1)?.params).toEqual({
      exportId,
    });
    if (operation !== "export.status")
      expect(f.calls.filter((r) => r.operation === operation)).toHaveLength(1);
  },
);

test.each([
  { state: "failed", exposedState: "failed" },
  { state: "canceled", exposedState: "idle" },
])(
  "terminal $state recovery / $exposedState status preserves export history and exits unsuccessfully",
  async ({ state, exposedState }) => {
    const exportId = "550e8400-e29b-41d4-a716-446655440000";
    const receipt = { leaf: "final.mp4", sizeBytes: 2, sha256: "a".repeat(64) };
    const base = {
      exportId,
      projectId: "p",
      jobId: "publication-job",
      state: "ready",
      cleanupPending: true,
      receipt,
      output: "/tmp/final.mp4",
      destination: { directory: "/tmp", leaf: "final.mp4" },
    };
    const f = await fixture((request) => {
      if (request.operation === "export.recover")
        return {
          ok: true,
          data: { ...base, recovery: { jobId: "recovery-job", state: "queued", published: null } },
        };
      if (request.operation === "job.get")
        return {
          ok: true,
          data: {
            ...job(state),
            id: "recovery-job",
            target: { kind: "project", id: "p", revisionId: "r5" },
          },
        };
      expect(request.operation).toBe("export.status");
      return {
        ok: true,
        data: {
          ...base,
          recovery: { jobId: "recovery-job", state: exposedState, published: null },
        },
      };
    });
    const output = await f.run("export.recover", { exportId, requestId: "recover-terminal" }, [
      "--wait",
      "--timeout-ms",
      "1000",
    ]);
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      data: { ...base, recovery: { jobId: "recovery-job", state: exposedState, published: null } },
      wait: {
        state: "settled",
        job: { id: "recovery-job", attemptGeneration: 2, attemptId: "attempt-2" },
      },
    });
    expect(f.calls.map((r) => r.operation)).toEqual([
      "export.recover",
      "job.get",
      "export.status",
      "job.get",
    ]);
    expect(f.calls.filter((r) => r.operation === "job.get").map((r) => r.params.jobId)).toEqual([
      "recovery-job",
      "recovery-job",
    ]);
  },
);

test("terminal export getter refresh still refuses a concurrent recovery retry", async () => {
  const exportId = "550e8400-e29b-41d4-a716-446655440000";
  let inspections = 0;
  const base = {
    exportId,
    projectId: "p",
    jobId: "publication-job",
    state: "failed",
    cleanupPending: true,
    receipt: null,
    output: null,
  };
  const f = await fixture((request) => {
    if (request.operation === "job.get")
      return {
        ok: true,
        data: {
          ...job("failed", ++inspections === 1 ? 2 : 3),
          id: "recovery-job",
          target: { kind: "project", id: "p", revisionId: "r5" },
        },
      };
    return {
      ok: true,
      data: {
        ...base,
        recovery: {
          jobId: "recovery-job",
          state: request.operation === "export.recover" ? "queued" : "failed",
          published: null,
        },
      },
    };
  });
  const output = await f.run("export.recover", { exportId, requestId: "recover-interrupted" }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { ...base, recovery: { jobId: "recovery-job", state: "failed" } },
    wait: {
      state: "interrupted",
      job: { id: "recovery-job", attemptGeneration: 2, attemptId: "attempt-2" },
      error: { code: "INVALID_RESPONSE" },
    },
  });
  expect(f.calls.map((r) => r.operation)).toEqual([
    "export.recover",
    "job.get",
    "export.status",
    "job.get",
  ]);
});

// A take keeps its own capture lifecycle (`captureReportSchema`): finalizing, then complete or
// interrupted.
test.each([
  ["capture.stop", "complete", 0],
  ["recording.get", "complete", 0],
  ["capture.stop", "interrupted", 1],
])("%s waits through finalizing for recording.get to say %s", async (operation, settled, code) => {
  let admissions = 0;
  const f = await fixture((request) => {
    if (request.operation === operation && admissions++ === 0)
      return { ok: true, data: { recordingId: "recording", state: "finalizing" } };
    expect(request.operation).toBe("recording.get");
    return {
      ok: true,
      data: { recordingId: "recording", state: settled, sourceDurationUs: 42 },
    };
  });
  const output = await f.run(operation, { recordingId: "recording" }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code).toBe(code);
  expect(JSON.parse(output.stdout)).toMatchObject({
    data: { recordingId: "recording", state: settled },
    wait: { state: "settled" },
  });
  expect(f.calls.map((r) => r.operation)).toEqual([operation, "recording.get"]);
});

test("capture.stop --wait settles on a take whose finalization failed", async () => {
  let admissions = 0;
  const failed = {
    recordingId: "recording",
    state: "finalizing",
    finalizationError: { code: "RECOVERY_FAILED", message: "media unreadable", retryable: true },
  };
  const f = await fixture((request) => {
    if (request.operation === "capture.stop" && admissions++ === 0)
      return { ok: true, data: { recordingId: "recording", state: "finalizing" } };
    return { ok: true, data: failed };
  });
  // The take stays finalizing until a caller retries, so waiting longer cannot change it.
  const output = await f.run("capture.stop", { recordingId: "recording" }, [
    "--wait",
    "--timeout-ms",
    "5000",
  ]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stdout)).toMatchObject({ data: failed, wait: { state: "settled" } });
});

test("batch media delivery timeout reclassifies settled wait while keeping completed item facts", async () => {
  const f = await fixture(async (request) => {
    if (request.operation === "frame.batch")
      return {
        ok: true,
        data: {
          projectId: "p",
          revisionId: "r7",
          items: [
            {
              atUs: 7,
              ok: true,
              data: {
                state: "ready",
                published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
                delivery: { token: "slow", sizeBytes: 2, expiresAtMs: Date.now() + 30000 },
              },
            },
          ],
        },
      };
    if (request.operation === "artifact.read") {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        ok: true,
        data: {
          offsetBytes: 0,
          nextOffsetBytes: 2,
          eof: true,
          data: Buffer.from("ok").toString("base64"),
        },
      };
    }
    if (request.operation === "artifact.close") return { ok: true, data: { closed: true } };
    throw new Error(request.operation);
  });
  const output = await f.run("frame.batch", { projectId: "p", atUs: [7] }, [
    "--wait",
    "--timeout-ms",
    "80",
    "--output",
    `${f.home}/batch`,
  ]);
  expect(output.code).toBe(2);
  expect(JSON.parse(output.stdout)).toMatchObject({
    wait: { state: "timed_out" },
    data: { items: [{ atUs: 7 }] },
  });
});

test("one published output reports the same issues through the service, CLI --wait and MCP", async () => {
  const home = await mkdtemp("/tmp/yap-wait-issues-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "source.png");
  await writeFile(path, "image bytes");
  const service = await startProjectService({
    home,
    autoPrepareModels: false,
    worker: async (operation, params, options) => {
      if (["media.pictureCapabilities", "media.audioCapabilities"].includes(operation))
        return { ok: true, data: {} };
      if (operation === "storage.clearRenderWorkspace")
        return { ok: true, data: { removed: true } };
      expect(operation).toBe("media.probe");
      // The native probe hands its answer back through the descriptor named by its output path.
      const answer = Buffer.from(
        JSON.stringify({
          originUs: 0,
          streams: [
            {
              id: "image",
              kind: "image",
              codec: "png",
              decodable: true,
              width: 2,
              height: 1,
              orientedWidth: 2,
              orientedHeight: 1,
            },
          ],
        }),
      );
      const descriptor = Number(String(params.output).split("/").at(-1)) - 3;
      writeSync(options!.descriptors![descriptor]!, answer, 0, answer.length, 0);
      return {
        ok: true,
        data: {
          file: params.output,
          bytes: answer.length,
          sha256: createHash("sha256").update(answer).digest("hex"),
        },
      };
    },
  });
  cleanups.push(() => service.close());
  const params = { requestId: "issues", path };
  const handler = async (operation: string, values: Record<string, unknown>) => {
    const reply = await callLocal(service.socketPath, { id: "parity", operation, params: values });
    if (!reply.ok) throw Error(reply.error.message);
    return reply.data as {
      jobId?: string;
      state: string;
      published: { generation: string; attemptId: string; issues: unknown } | null;
    };
  };
  let ready = await handler("asset.import", params);
  const jobId = ready.jobId;
  for (let poll = 0; ["queued", "running"].includes(ready.state) && poll < 300; poll++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    ready = await handler("job.get", { jobId });
  }
  expect(ready.published?.issues).toEqual([]);

  // An image import reports no issues, so its publication's issue rows are written through storage.
  const issue: Parameters<typeof writeOutputIssues>[2][number] = {
    code: "issues-truncated",
    message: "1 more issue was omitted",
    evidence: { omitted: 1 },
  };
  const store = new Catalog(join(home, "library", "catalog.sqlite"));
  store.transaction(() =>
    writeOutputIssues(
      store,
      {
        outputKind: "artifact",
        outputId: ready.published!.attemptId,
        generation: Number(ready.published!.generation),
      },
      [issue],
    ),
  );
  store.close();

  const served = await handler("asset.import", params);
  expect(served.published?.issues).toEqual([issue]);

  const entry = new URL("../dist/main.js", import.meta.url).pathname;
  const cli = await promisify(execFile)(process.execPath, [
    entry,
    "asset.import",
    "--socket",
    service.socketPath,
    "--params",
    JSON.stringify(params),
    "--wait",
    "--timeout-ms",
    "5000",
  ]);
  expect(cli.stdout.trim().split("\n")).toHaveLength(1);
  const waited = JSON.parse(cli.stdout) as { ok: boolean; data: typeof served };
  expect(waited).toMatchObject({ ok: true, wait: { state: "settled" } });
  expect(waited.data.published?.issues).toEqual(served.published?.issues);
  expect(cli.stderr.trim().split("\n").at(-1)).toMatch(
    /^asset\.import: ready \(1 issues\) \(\S+, attempt 1\)$/,
  );

  const client = new Client({ name: "issue-parity", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
  const tool = await client.callTool({ name: "asset.import", arguments: params });
  expect(tool.isError).toBe(false);
  const reply = responseSchema.parse(tool.structuredContent);
  if (!reply.ok) throw Error(reply.error.message);
  expect((reply.data as typeof served).published?.issues).toEqual(served.published?.issues);
});

test("a ready read counts its admission issues beside its published issues", async () => {
  const clamp = { code: "range-clamped", message: "clamped", evidence: {} };
  const published = { code: "issues-truncated", message: "truncated", evidence: { omitted: 1 } };
  const f = await fixture(() => ({
    ok: true,
    data: {
      assetId: "a",
      streamId: "s",
      state: "ready",
      issues: [clamp],
      published: { generation: "1", output: {}, issues: [published] },
    },
  }));
  const output = await f.run(
    "audio.get",
    { assetId: "a", streamId: "s", sourceRange: { startUs: 0, endUs: 2 } },
    ["--wait", "--timeout-ms", "1000"],
  );
  // The stub serves no delivery; the progress line is the claim here.
  expect(output.stderr.split("\n")).toContain("audio.get: ready (2 issues)");
});

test("a ready project read counts the issues of the source generations it names", async () => {
  const dropped = { code: "word-dropped", message: "dropped", evidence: {} };
  const f = await fixture(() => ({
    ok: true,
    data: {
      projectId: "p",
      revisionId: "r",
      state: "ready",
      issues: [],
      dependencies: [
        { selection: { assetId: "a", streamId: "s" }, issues: [dropped] },
        { selection: { assetId: "b", streamId: "s" }, issues: [] },
      ],
      page: { rows: [], nextCursor: null },
    },
  }));
  const output = await f.run("transcript.get", { projectId: "p" }, [
    "--wait",
    "--timeout-ms",
    "1000",
  ]);
  expect(output.code, output.stdout + output.stderr).toBe(0);
  expect(output.stderr.split("\n")).toContain("transcript.get: ready (1 issues)");
});

test("the ready marker counts the issues a truncation entry stands for", async () => {
  const f = await fixture(async () => ({
    ok: true,
    data: {
      assetId: "a",
      streamId: "s",
      state: "ready",
      issues: [],
      published: {
        generation: "1",
        output: {},
        issues: [
          { code: "range-clamped", message: "m", evidence: {} },
          { code: "issues-truncated", message: "m", evidence: { omitted: 41 } },
        ],
      },
    },
  }));
  const output = await f.run(
    "audio.get",
    { assetId: "a", streamId: "s", sourceRange: { startUs: 0, endUs: 2 } },
    ["--wait", "--timeout-ms", "1000"],
  );
  expect(output.stderr.split("\n")).toContain("audio.get: ready (42 issues)");
});
