import { afterEach, expect, it } from "vitest";
import { callLocal } from "@yap/client";
import { operationSchema, refusalRetryable } from "@yap/protocol";
import { CatalogError } from "@yap/core/catalog";
import { operationFailure, refusedRequest } from "./operation-errors.js";
import { projectServiceControlFixture } from "./project-service.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("does not advertise a non-retryable refusal's own request as a resolving call", async () => {
  const f = await projectServiceControlFixture(cleanup, async () => ({ ok: true, data: {} }));
  for (const send of [
    () =>
      callLocal(f.service.socketPath, {
        id: "missing",
        operation: "job.get",
        params: { jobId: "missing" },
      }),
    () => f.control("job.get", { jobId: "missing" }),
  ]) {
    const result = await send();
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND", retryable: false } });
    if (result.ok) throw new Error("Expected refusal");
    expect(result.error.details).not.toHaveProperty("retry");
  }
});

it("advertises only valid, safe refused requests through socket and control adapters", async () => {
  const f = await projectServiceControlFixture(cleanup, async () => ({ ok: true, data: {} }));
  const recording = f.service.captures.allocate().recording;
  const requests = [
    { operation: "recording.prompt", params: { recordingId: recording.id }, safe: true },
    { operation: "job.get", params: { jobId: "missing" }, safe: true },
    {
      operation: "project.duplicate",
      params: { projectId: "missing", requestId: "duplicate-missing" },
      safe: true,
    },
    { operation: "job.retry", params: { jobId: "missing" }, safe: false },
    {
      operation: "project.duplicate",
      params: { projectId: "missing", requestId: "" },
      safe: false,
    },
    { operation: "job.get", params: {}, safe: false },
    { operation: "unknown", params: {}, safe: false },
  ];
  for (const { safe, ...request } of requests) {
    for (const send of [
      () => callLocal(f.service.socketPath, { id: "retry-fixture", ...request }),
      () => f.control(request.operation, request.params),
    ]) {
      const result = await send();
      expect(result.ok, JSON.stringify({ request, result })).toBe(false);
      if (result.ok) throw new Error("Expected refusal");
      expect(result.error.retryable).toBe(refusalRetryable(result.error.code));
      if (safe && result.error.retryable) {
        expect(result.error.details.retry).toEqual(operationSchema.parse(request));
        expect(operationSchema.parse(result.error.details.retry)).toEqual(
          operationSchema.parse(request),
        );
      } else expect(result.error.details).not.toHaveProperty("retry");
    }
  }
});

it.each(["NOT_READY", "NOT_FOUND"])(
  "keeps an owner's explicit resolving request for %s",
  (code) => {
    const retry = { operation: "model.status", params: { modelId: "parakeet" } };
    const result = refusedRequest(
      operationFailure(new CatalogError(code, "Still preparing", { modelId: "parakeet" }, retry)),
      { id: "fixture", operation: "job.get", params: { jobId: "missing" } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected refusal");
    expect(result.error.details).toEqual({ modelId: "parakeet", retry });
    expect(operationSchema.parse(result.error.details.retry)).toEqual(retry);
  },
);
