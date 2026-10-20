import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startProjectService } from "../../service/dist/project-service.js";
import { operationSchema } from "@yap/protocol";
import ledger from "../../../packages/protocol/dist/refusal-ledger.json" with { type: "json" };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("CLI and MCP preserve the real service's refusal and valid resolving request", async () => {
  const home = await mkdtemp("/tmp/yap-error-envelope-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const service = await startProjectService({
    home,
    autoPrepareModels: false,
    autoTranscribe: false,
  });
  cleanup.push(() => service.close());
  const codes = ledger.codes as Record<string, { retryable: boolean; retryAfterMs?: number }>;
  const entryBefore = codes.NOT_READY!;
  codes.NOT_READY = { ...entryBefore, retryAfterMs: 15000 };
  cleanup.push(async () => {
    codes.NOT_READY = entryBefore;
  });
  const recording = service.captures.allocate().recording;
  const request = { operation: "recording.prompt", params: { recordingId: recording.id } };
  const entry = new URL("../dist/main.js", import.meta.url).pathname;
  let stdout = "";
  try {
    await promisify(execFile)(process.execPath, [
      entry,
      request.operation,
      "--params",
      JSON.stringify(request.params),
      "--socket",
      service.socketPath,
    ]);
    throw new Error("Expected CLI refusal");
  } catch (error) {
    const exit = error as { code: number; stdout: string };
    expect(exit.code).toBe(1);
    stdout = exit.stdout;
  }
  const cli = JSON.parse(stdout);
  expect(cli).toMatchObject({
    ok: false,
    error: { code: "NOT_READY", retryable: true, retryAfterMs: 15000 },
  });
  expect(operationSchema.parse(cli.error.details.retry)).toEqual(request);
  const client = new Client({ name: "error-envelope-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
  const reply = await client.callTool({ name: request.operation, arguments: request.params });
  expect(reply.isError).toBe(true);
  expect(reply.structuredContent).toMatchObject({ ok: false, error: cli.error });
  expect(JSON.parse((reply.content as { text: string }[])[0]!.text)).toMatchObject({
    ok: false,
    error: cli.error,
  });
});
