import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { responseSchema } from "@yap/protocol";
import { startProjectService } from "../../service/dist/project-service.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("CLI and MCP preserve pending, failed and canceled production work without treating ok transport as publication", async () => {
  const home = await mkdtemp("/tmp/yap-published-cli-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "source.png");
  await writeFile(source, "external probe control");
  let announce!: () => void, release!: () => void;
  let entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cancel = false;
  const service = await startProjectService({
    home,
    worker: async (...[operation, , options]) => {
      if (["media.pictureCapabilities", "media.audioCapabilities"].includes(operation))
        return { ok: true, data: {} };
      expect(operation).toBe("media.probe");
      announce();
      if (cancel) {
        options!.signal!.throwIfAborted();
        await once(options!.signal!, "abort");
        options!.signal!.throwIfAborted();
      } else await released;
      return {
        ok: false,
        error: {
          code: "MEDIA_UNAVAILABLE",
          message: "Controlled external probe refusal",
          details: {},
          retryable: true,
        },
      };
    },
  });
  cleanup.push(() => service.close());
  cleanup.push(async () => release());
  const entry = new URL("../dist/main.js", import.meta.url).pathname;
  const cli = async (operation: string, params: Record<string, unknown>) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      entry,
      operation,
      "--socket",
      service.socketPath,
      "--params",
      JSON.stringify(params),
    ]);
    const reply = responseSchema.parse(JSON.parse(stdout));
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw Error(reply.error.message);
    return reply.data as { jobId: string; state: string; published: unknown; attemptId: string };
  };
  const client = new Client({ name: "published-work", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
  const mcp = async (operation: string, params: Record<string, unknown>) => {
    const tool = await client.callTool({ name: operation, arguments: params });
    expect(tool.isError).toBe(false);
    const reply = responseSchema.parse(tool.structuredContent);
    if (!reply.ok) throw Error(reply.error.message);
    expect(tool.content).toEqual([{ type: "text", text: JSON.stringify(reply) }]);
    return reply.data;
  };
  const params = { requestId: "import", path: source };
  const accepted = await cli("asset.import", params);
  expect(accepted.published).toBeNull();
  expect(accepted).not.toHaveProperty("result");
  await entered;
  const running = await cli("job.get", { jobId: accepted.jobId });
  expect(running.state).toBe("running");
  // A replayed import reports the status of the same work, referring to the same job.
  expect(await mcp("asset.import", params)).toMatchObject({
    state: "running",
    jobId: accepted.jobId,
    attemptId: running.attemptId,
  });
  release();
  let failed = await cli("job.get", { jobId: accepted.jobId });
  for (let attempt = 0; attempt < 20 && failed.state === "running"; attempt++)
    failed = await cli("job.get", { jobId: accepted.jobId });
  expect(failed).toMatchObject({ state: "failed", published: null });
  expect(await mcp("job.get", { jobId: accepted.jobId })).toEqual(failed);
  cancel = true;
  entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  await cli("job.retry", { jobId: accepted.jobId });
  await entered;
  const canceled = await mcp("job.cancel", { jobId: accepted.jobId });
  expect(canceled).toMatchObject({ state: "canceled", published: null });
  expect(await cli("job.get", { jobId: accepted.jobId })).toEqual(canceled);
  if (process.env.YAP_CONTRACT_TEST_OUTPUT)
    await writeFile(
      join(process.env.YAP_CONTRACT_TEST_OUTPUT, "publication-cli-mcp.json"),
      JSON.stringify({ params, accepted, running, failed, canceled }, null, 2) + "\n",
    );
});
