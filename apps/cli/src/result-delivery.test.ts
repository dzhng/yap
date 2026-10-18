import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  deliveredResponseSchema,
  responseSchema,
  RESPONSE_FRAME_BYTES,
  operationSchema,
  MCP_RESULT_INLINE_BYTES,
} from "@yap/protocol";
import { z } from "zod";
import { listenLocal, DerivativeDelivery } from "@yap/service";
import { callLocal } from "@yap/client";
import { startProjectService } from "../../service/dist/project-service.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function retainedReceiptFixture() {
  const archive = new URL(
    "../../../specs/done/agent-editing/assets/24y-source-event-duration/sdk-capacity-evidence.tar.gz",
    import.meta.url,
  ).pathname;
  const raw = execFileSync("tar", ["-xOzf", archive, "place-9500.json"], {
    maxBuffer: RESPONSE_FRAME_BYTES,
  });
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "b1a24d32230175990fd97e4e3c939cf002949951b204be73a582184c21bdcdc5",
  );
  const data: unknown = JSON.parse(raw.toString());
  const saved = z
    .object({
      revision: z.object({
        id: z.string(),
        projectId: z.string(),
        createdAt: z.string(),
        ordinal: z.int(),
        document: z.object({ canvas: z.unknown() }),
      }),
      edit: z.object({
        normalized: z.array(
          z.object({ changes: z.array(z.object({ value: z.record(z.string(), z.unknown()) })) }),
        ),
      }),
    })
    .parse(data);
  const operations = saved.edit.normalized.flatMap(({ changes }) =>
    changes.map(({ value }) => {
      const clip = { ...value };
      delete clip.id;
      return { operation: "place", clip };
    }),
  );
  const params = {
    projectId: saved.revision.projectId,
    expectedRevisionId: "retained-before-final-edit",
    requestId: "retained-replay",
    operations,
  };
  const args = { operation: "apply", expectedRevisionId: params.expectedRevisionId, operations };
  const argumentsKey = JSON.stringify(args, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
  const home = await mkdtemp("/tmp/mcp-production-result-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const service = await startProjectService({
    home,
    worker: async (operation) => {
      if (operation === "media.audioCapabilities") return { ok: true, data: {} };
      expect(operation).toBe("storage.clearRenderWorkspace");
      return { ok: true, data: { removed: true } };
    },
  });
  cleanup.push(() => service.close());
  const db = new DatabaseSync(join(home, "library/catalog.sqlite"));
  cleanup.push(async () => db.close());
  // The storage edge supplies the unchanged historical receipt; no media, edit batch or prior history is recreated.
  db.prepare(
    "INSERT INTO projects(projectId,title,createdAt,currentRevisionId,createRequestId,createArguments,createResult) VALUES(?,?,?,?,?,?,?)",
  ).run(
    saved.revision.projectId,
    "Retained receipt",
    saved.revision.createdAt,
    saved.revision.id,
    "fixture",
    "{}",
    "{}",
  );
  db.prepare("INSERT INTO project_requests VALUES(?,?,?,?)").run(
    params.projectId,
    params.requestId,
    argumentsKey,
    raw.toString(),
  );
  const client = new Client({ name: "production-result", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        new URL("../dist/main.js", import.meta.url).pathname,
        "mcp",
        "--socket",
        service.socketPath,
      ],
      stderr: "pipe",
    }),
  );
  return { raw, params, service, db, client };
}
describe("retained production receipt", () => {
  let fixture: Awaited<ReturnType<typeof retainedReceiptFixture>>;
  beforeEach(async () => {
    fixture = await retainedReceiptFixture();
  });
  test("production project service replays the retained receipt through default MCP without new clip authoring", async () => {
    const { raw, params, service, db, client } = fixture;
    const delivered = await client.callTool({ name: "edit.apply", arguments: params });
    const complete = responseSchema.parse(delivered.structuredContent);
    expect(complete.ok).toBe(false);
    if (complete.ok) throw Error("obsolete retained result unexpectedly replayed");
    expect(complete.error.code).toBe("ARTIFACT_CHANGED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_requests").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_revisions").get()).toEqual({ n: 0 });
    const cli = promisify(execFile)(
      process.execPath,
      [
        new URL("../dist/main.js", import.meta.url).pathname,
        "edit.apply",
        "--socket",
        service.socketPath,
        "--params",
        "-",
        "--id",
        "cli",
      ],
      { maxBuffer: RESPONSE_FRAME_BYTES },
    );
    cli.child.stdin?.end(JSON.stringify(params));
    let cliStdout: string;
    try {
      cliStdout = (await cli).stdout;
    } catch (error) {
      cliStdout = (error as { stdout: string }).stdout;
    }
    const ordinary = responseSchema.parse(JSON.parse(cliStdout));
    expect({ id: ordinary.id, ok: ordinary.ok }).toEqual({ id: "cli", ok: false });
    if (ordinary.ok) throw Error("obsolete retained result unexpectedly replayed through CLI");
    expect(ordinary.error.code).toBe("ARTIFACT_CHANGED");
    console.info(
      JSON.stringify({
        authority: "24y/place-9500.json",
        storageEdge:
          "unchanged saved receipt in a synthetic replay row; no new clip edits or historical catalog reuse",
        receiptBytes: raw.length,
        receiptSha256: createHash("sha256").update(raw).digest("hex"),
        defaultSdk: true,
        mcpResultBytes: Buffer.byteLength(JSON.stringify(delivered)),
        exactReceiptBytes: false,
        replayRows: 1,
        authoredRevisions: 0,
      }),
    );
  });
});
test("deferred media metadata leaves its nested lease usable instead of reading or closing it", async () => {
  const home = await mkdtemp("/tmp/mcp-nested-result-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const delivery = new DerivativeDelivery();
  cleanup.push(async () => delivery.dispose());
  const media = Buffer.from("nested media bytes");
  const nested = delivery.open({ kind: "asset", id: "source" }, () => ({
    bytes: media.length,
    read: (buffer, position) => media.copy(buffer, 0, position, position + buffer.length),
    release() {},
  }));
  let reads = 0,
    closes = 0;
  const server = await listenLocal({
    runtimeDirectory: home,
    delivery,
    handler: (request) => {
      const op = operationSchema.parse({ operation: request.operation, params: request.params });
      if (op.operation === "artifact.read") {
        reads++;
        return {
          ok: true,
          data: delivery.read(op.params.token, op.params.offsetBytes, op.params.maxBytes),
        };
      }
      if (op.operation === "artifact.close") {
        closes++;
        delivery.close(op.params.token);
        return { ok: true, data: { closed: true } };
      }
      return {
        ok: true,
        data: {
          state: "ready",
          published: { generation: "1", output: { mediaType: "image/png" }, issues: [] },
          delivery: nested,
          evidence: "x".repeat(MCP_RESULT_INLINE_BYTES),
        },
      };
    },
  });
  cleanup.push(() => server.close());
  const client = new Client({ name: "nested-result", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        new URL("../dist/main.js", import.meta.url).pathname,
        "mcp",
        "--socket",
        server.socketPath,
      ],
      stderr: "pipe",
    }),
  );
  const response = await client.callTool({
    name: "frame.get",
    arguments: { assetId: "source", streamId: "video", atUs: 0 },
  });
  const descriptor = deliveredResponseSchema.parse(response.structuredContent);
  expect(response.content).toHaveLength(1);
  expect({ reads, closes }).toEqual({ reads: 0, closes: 0 });
  const renewed = responseSchema.parse(
    (
      await client.callTool({
        name: "artifact.renew",
        arguments: { token: descriptor.resultDelivery.token },
      })
    ).structuredContent,
  );
  expect(renewed.ok).toBe(true);
  // The outer JSON receipt and nested media remain independent leases.
  await client.callTool({
    name: "artifact.close",
    arguments: { token: descriptor.resultDelivery.token },
  });
  expect(() => delivery.read(descriptor.resultDelivery.token, 0, 1)).toThrow("expired or closed");
  const read = responseSchema.parse(
    (
      await client.callTool({
        name: "artifact.read",
        arguments: { token: nested.token, offsetBytes: 0 },
      })
    ).structuredContent,
  );
  if (!read.ok) throw Error(read.error.message);
  const data = z.object({ data: z.string() }).parse(read.data);
  expect(Buffer.from(data.data, "base64")).toEqual(media);
  expect({ reads, closes }).toEqual({ reads: 1, closes: 1 });
});
test("default MCP preserves a complete large failure and its error outcome", async () => {
  const error = {
    code: "FIXTURE_REFUSAL",
    message: "Complete error evidence",
    retryable: false,
    details: { evidence: "x".repeat(MCP_RESULT_INLINE_BYTES) },
  };
  const home = await mkdtemp("/tmp/mcp-result-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const delivery = new DerivativeDelivery();
  cleanup.push(async () => delivery.dispose());
  const server = await listenLocal({
    runtimeDirectory: home,
    delivery,
    handler: (request) => {
      if (request.operation === "artifact.read") {
        const op = operationSchema.parse({ operation: request.operation, params: request.params });
        if (op.operation !== "artifact.read") throw Error("Expected artifact read");
        return {
          ok: true,
          data: delivery.read(op.params.token, op.params.offsetBytes, op.params.maxBytes),
        };
      }
      if (request.operation === "artifact.close") {
        if (typeof request.params.token !== "string") throw Error("Invalid token");
        delivery.close(request.params.token);
        return { ok: true, data: { closed: true } };
      }
      return { ok: false, error };
    },
  });
  cleanup.push(() => server.close());
  const client = new Client({ name: "retained-result", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        new URL("../dist/main.js", import.meta.url).pathname,
        "mcp",
        "--socket",
        server.socketPath,
      ],
      stderr: "pipe",
    }),
  );
  const result = await client.callTool({
    name: "edit.apply",
    arguments: {
      projectId: "retained",
      expectedRevisionId: "r0",
      requestId: "same",
      operations: [{ operation: "track.add", track: { kind: "video", order: 0 } }],
    },
  });
  const descriptor = deliveredResponseSchema.parse(result.structuredContent);
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(descriptor) }]);
  expect(result.isError).toBe(true);
  const chunks: Buffer[] = [];
  for (let offsetBytes = 0; offsetBytes < descriptor.resultDelivery.sizeBytes;) {
    const read = await client.callTool({
      name: "artifact.read",
      arguments: { token: descriptor.resultDelivery.token, offsetBytes },
    });
    const response = responseSchema.parse(read.structuredContent);
    if (!response.ok) throw Error(response.error.message);
    const chunk = z.object({ data: z.string(), nextOffsetBytes: z.int() }).parse(response.data);
    chunks.push(Buffer.from(chunk.data, "base64"));
    expect(chunk.nextOffsetBytes).toBeGreaterThan(offsetBytes);
    offsetBytes = chunk.nextOffsetBytes;
  }
  const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBe(descriptor.resultDelivery.sizeBytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(descriptor.resultDelivery.sha256);
  const complete = responseSchema.parse(JSON.parse(bytes.toString()));
  expect(complete).toEqual({ id: descriptor.id, ok: false, error });
  const ordinary = await callLocal(server.socketPath, {
    id: "cli",
    operation: "edit.apply",
    params: {},
  });
  expect(ordinary).toEqual({ id: "cli", ok: false, error });
  await client.callTool({
    name: "artifact.close",
    arguments: { token: descriptor.resultDelivery.token },
  });
  expect(() => delivery.read(descriptor.resultDelivery.token, 0, 1)).toThrow("expired or closed");
});
