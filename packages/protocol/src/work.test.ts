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
  jobWorkState,
  mapWorkState,
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
