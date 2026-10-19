import { expect, test } from "vitest";
import { z } from "zod";
import type { Issue } from "@yap/composition";
import {
  asyncWorkSchema,
  cliStatusSchema,
  modelStatusSchema,
  skillStatusSchema,
  jobStatusSchema,
  artifactStatusSchema,
  artifactWorkState,
  evidenceWorkState,
  exportWorkState,
  jobWorkState,
  mapWorkState,
  markedWorkState,
  modelWorkState,
  packageWorkState,
  storedWork,
  publishedOutput,
  publishedOutputSchema,
  workStateSchema,
} from "./work.js";

const truncated: Issue = {
  code: "issues-truncated",
  message: "2 more issues were omitted",
  evidence: { omitted: 2 },
};

test("a published output always carries its issues, empty when clean", () => {
  const schema = publishedOutputSchema(z.object({ assetId: z.string() }));
  for (const issues of [[], [truncated]]) {
    const published = publishedOutput(
      { generation: 3, attemptId: "attempt", issues, assetId: "asset" },
      ({ assetId }) => ({ assetId }),
    );
    expect(published).toEqual({
      generation: "3",
      attemptId: "attempt",
      output: { assetId: "asset" },
      issues,
    });
    expect(schema.parse(published)).toEqual(published);
  }
  expect(
    schema.safeParse({ generation: "3", attemptId: "attempt", output: { assetId: "asset" } })
      .success,
  ).toBe(false);
});

test("WorkState is the only protocol async vocabulary", () => {
  expect(workStateSchema.options).toEqual([
    "idle",
    "queued",
    "running",
    "ready",
    "failed",
    "unavailable",
    "canceled",
  ]);
  expect(asyncWorkSchema.parse({ state: "running", jobId: "job-1" })).toEqual({
    state: "running",
    jobId: "job-1",
  });
  expect(mapWorkState("not_requested", { not_requested: "idle" })).toBe("idle");
  expect(() => mapWorkState("unknown", {})).toThrow("Unknown stored work state");
  expect(jobWorkState.waiting).toBe("queued");
});

test("status facts stay separate from WorkState", () => {
  expect(
    skillStatusSchema.parse({ state: "unavailable", jobId: null, installation: "unmanaged" }),
  ).toEqual({
    state: "unavailable",
    jobId: null,
    installation: "unmanaged",
  });
  expect(
    cliStatusSchema.parse({
      state: "unavailable",
      jobId: null,
      installation: "different",
      path: "/tmp/yap",
      onPath: false,
    }).installation,
  ).toBe("different");
  expect(
    modelStatusSchema.parse({
      state: "unavailable",
      jobId: null,
      modelId: "parakeet",
      presence: "absent",
    }).presence,
  ).toBe("absent");
  expect(
    jobStatusSchema.parse({
      state: "ready",
      jobId: "job",
      attemptId: "attempt",
      attemptGeneration: 1,
      target: {},
      retryable: true,
    }).state,
  ).toBe("ready");
  expect(artifactStatusSchema.parse({ state: "idle", jobId: null, retryable: true }).state).toBe(
    "idle",
  );
});

test("only a record its owner marked maps to WorkState, through spreads and never into JSON", () => {
  const status = storedWork({ state: "processing" as const, jobId: "job-1" });
  expect(markedWorkState(status)).toBe("running");
  // Test equality elsewhere ignores the mark by this name.
  expect(Object.getOwnPropertySymbols(status).map((key) => key.description)).toEqual([
    "storedWork",
  ]);
  expect(markedWorkState({ ...status, reason: null })).toBe("running");
  expect(markedWorkState({ state: "processing", jobId: "job-1" })).toBeUndefined();
  expect(JSON.parse(JSON.stringify(status))).toEqual({ state: "processing", jobId: "job-1" });
  expect(() => markedWorkState({ ...status, state: "syncing" })).toThrow(
    "Unknown stored work state: syncing",
  );
});

test("owners that share a stored word mean the same lifecycle by it", () => {
  const owners = [
    jobWorkState,
    artifactWorkState,
    modelWorkState,
    packageWorkState,
    exportWorkState,
    evidenceWorkState,
  ] as Record<string, string>[];
  for (const table of owners)
    for (const [word, state] of Object.entries(table))
      for (const other of owners)
        if (word in other) expect([word, other[word]]).toEqual([word, state]);
});
