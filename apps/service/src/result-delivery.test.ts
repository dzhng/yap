import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { listenLocal } from "./index.js";
import { DerivativeDelivery } from "./delivery.js";
import { callLocal } from "@yap/client";
import {
  type OperationRequest,
  type OperationResult,
  operationSchema,
  RESPONSE_FRAME_BYTES,
} from "@yap/protocol";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { ProjectStore } from "@yap/core/projects";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { join } from "node:path";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
async function fixture(
  handler: (
    request: OperationRequest,
    signal: AbortSignal,
  ) => OperationResult | Promise<OperationResult> = () => ({
    ok: true,
    data: "complete".repeat(100),
  }),
) {
  const home = await mkdtemp("/tmp/result-delivery-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const delivery = new DerivativeDelivery();
  cleanup.push(async () => delivery.dispose());
  const server = await listenLocal({
    runtimeDirectory: home,
    delivery,
    handler: (request, signal) => {
      const parsed = operationSchema.safeParse({
        operation: request.operation,
        params: request.params,
      });
      if (parsed.success) {
        const op = parsed.data;
        if (op.operation === "artifact.read")
          return {
            ok: true,
            data: delivery.read(op.params.token, op.params.offset, op.params.maxBytes),
          };
        if (op.operation === "artifact.renew")
          return { ok: true, data: delivery.renew(op.params.token) };
        if (op.operation === "artifact.close") {
          delivery.close(op.params.token);
          return { ok: true, data: { closed: true } };
        }
      }
      return handler(request, signal);
    },
  });
  cleanup.push(() => server.close());
  const ask = (id: string) =>
    callLocal(server.socketPath, {
      id,
      operation: "fixture",
      params: {},
      resultDelivery: { inlineBytes: 100 },
    });
  return { home, delivery, server, ask };
}
test("opted socket replies retain the complete operation bytes in ordinary artifact reads", async () => {
  const home = await mkdtemp("/tmp/result-delivery-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const delivery = new DerivativeDelivery();
  cleanup.push(async () => delivery.dispose());
  const data = { text: "large reply".repeat(100) };
  const server = await listenLocal({
    runtimeDirectory: home,
    delivery,
    handler: () => ({ ok: true, data }),
  });
  cleanup.push(() => server.close());
  const request = {
    id: "result",
    operation: "fixture",
    params: {},
    resultDelivery: { inlineBytes: 100 },
  };
  const response = await callLocal(server.socketPath, request);
  expect(response).toHaveProperty("resultDelivery");
  if (!("resultDelivery" in response)) throw Error("Missing result delivery");
  const bytes = Buffer.from(delivery.read(response.resultDelivery.token, 0, 4096).data, "base64");
  expect(bytes).toEqual(Buffer.from(JSON.stringify({ id: "result", ok: true, data })));
  expect(response.resultDelivery.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
});
test("full result capacity refuses before dispatch while maintenance drains the same slots", async () => {
  let mutations = 0;
  const f = await fixture(() => ({
    ok: true,
    data: { mutation: ++mutations, text: "reply".repeat(100) },
  }));
  const tokens: string[] = [];
  for (let n = 0; n < 32; n++) {
    const response = await f.ask(String(n));
    if (!("resultDelivery" in response)) throw Error("Missing delivery");
    tokens.push(response.resultDelivery.token);
  }
  const refused = await f.ask("refused");
  expect(mutations).toBe(32);
  expect(refused).toMatchObject({
    ok: false,
    error: { code: "CAPACITY_EXCEEDED", retryable: true },
  });
  const request = (operation: string, params: Record<string, unknown>) =>
    callLocal(f.server.socketPath, {
      id: "maintenance",
      operation,
      params,
      resultDelivery: { inlineBytes: 1 },
    });
  expect(await request("artifact.read", { token: tokens[0], offset: 0 })).toMatchObject({
    ok: true,
    data: { offset: 0, eof: true },
  });
  expect(await request("artifact.renew", { token: tokens[0] })).toMatchObject({
    ok: true,
    data: { token: tokens[0] },
  });
  expect(await request("artifact.close", { token: tokens[0] })).toEqual({
    id: "maintenance",
    ok: true,
    data: { closed: true },
  });
  const next = await f.ask("next");
  if (!("resultDelivery" in next)) throw Error("Missing next delivery");
  const result = JSON.parse(
    Buffer.from(f.delivery.read(next.resultDelivery.token, 0, 4096).data, "base64").toString(),
  );
  expect(result.data.mutation).toBe(33);
});
test("error snapshots retain the exact error, and expired or restarted leases cannot revive", async () => {
  const error = {
    code: "FIXTURE_REFUSAL",
    message: "complete failure",
    retryable: false,
    details: { evidence: "details".repeat(100) },
  };
  const f = await fixture(() => ({ ok: false, error }));
  vi.useFakeTimers();
  const response = await f.ask("error");
  if (!("resultDelivery" in response)) throw Error("Missing error delivery");
  expect(response.ok).toBe(false);
  expect(
    JSON.parse(
      Buffer.from(
        f.delivery.read(response.resultDelivery.token, 0, 4096).data,
        "base64",
      ).toString(),
    ),
  ).toEqual({ id: "error", ok: false, error });
  await vi.advanceTimersByTimeAsync(30_001);
  expect(() => f.delivery.renew(response.resultDelivery.token)).toThrow("expired or closed");
  const next = await f.ask("after-expiry");
  if (!("resultDelivery" in next)) throw Error("Missing replacement");
  f.delivery.dispose();
  const restarted = new DerivativeDelivery();
  expect(() => restarted.read(next.resultDelivery.token, 0, 1)).toThrow("expired or closed");
  restarted.dispose();
});
test("lost result publication releases capacity without rolling back or repeating a committed edit", async () => {
  let entered!: () => void;
  const committed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let projects!: ProjectStore;
  const f = await fixture(async (request, signal) => {
    const op = operationSchema.parse({ operation: request.operation, params: request.params });
    if (op.operation !== "edit.apply" || !("projectId" in op.params))
      throw Error("Expected project edit");
    const data = projects.apply(op.params.projectId, op.params);
    if (request.id === "lost") {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    return { ok: true, data };
  });
  const catalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanup.push(async () => catalog.close());
  const assets = new AssetStore(catalog, f.home),
    acquisitions = new AcquisitionStore(catalog);
  projects = new ProjectStore(
    catalog,
    assets,
    new TranscriptStore(catalog, f.home, assetTranscriptOwner(assets, acquisitions)),
    acquisitions,
  );
  const made = projects.create({
    requestId: "create",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const request = {
    id: "lost",
    operation: "edit.apply",
    params: {
      projectId: made.project.projectId,
      expectedRevisionId: made.revision.id,
      requestId: "one-edit",
      operations: [{ operation: "track.add", track: { kind: "video", order: 0 } }],
    },
    resultDelivery: { inlineBytes: 100 },
  };
  const controller = new AbortController();
  const lost = callLocal(f.server.socketPath, request, { signal: controller.signal });
  const failed = expect(lost).rejects.toMatchObject({ code: "ABORTED" });
  await committed;
  controller.abort();
  await failed;
  const replay = await callLocal(f.server.socketPath, { ...request, id: "replay" });
  if (!("resultDelivery" in replay)) throw Error("Missing replay delivery");
  const result = JSON.parse(
    Buffer.from(f.delivery.read(replay.resultDelivery.token, 0, 4096).data, "base64").toString(),
  );
  expect(result.data.revision.ordinal).toBe(1);
  expect(result.data.revision.document.tracks).toMatchObject([{ kind: "video", order: 0 }]);
  expect(projects.history(made.project.projectId).revisions.map((r) => r.ordinal)).toEqual([0, 1]);
  f.delivery.close(replay.resultDelivery.token);
  const releases: (() => void)[] = [];
  for (let n = 0; n < 32; n++) releases.push(f.delivery.reserve());
  for (const release of releases) release();
});
test("a complete response beyond the existing byte limit is refused rather than retained", async () => {
  const f = await fixture(() => ({ ok: true, data: "x".repeat(RESPONSE_FRAME_BYTES) }));
  expect(await f.ask("oversized")).toMatchObject({
    ok: false,
    error: { code: "LIMIT_EXCEEDED", message: "Response exceeds the transport byte limit" },
  });
  const releases: (() => void)[] = [];
  for (let n = 0; n < 32; n++) releases.push(f.delivery.reserve());
  for (const release of releases) release();
});

test("ordinary opted replies release their borrowed capacity instead of accumulating leases", async () => {
  let large = false;
  const f = await fixture(() => ({ ok: true, data: large ? "complete".repeat(100) : "small" }));
  for (let n = 0; n < 34; n++)
    expect(await f.ask(String(n))).toEqual({ id: String(n), ok: true, data: "small" });
  large = true;
  for (let n = 0; n < 32; n++) expect(await f.ask(String(n))).toHaveProperty("resultDelivery");
});
