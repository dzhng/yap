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
  publishedOutput,
  publishedOutputSchema,
  workState,
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
  for (const state of workStateSchema.options) expect(workState(state)).toBe(state);
  expect(workState("processing")).toBe("running");
  expect(() => workState("syncing")).toThrow("Unknown stored work state: syncing");
  expect(() => workState("toString")).toThrow("Unknown stored work state: toString");
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
      id: "parakeet",
      presence: "absent",
    }).presence,
  ).toBe("absent");
  expect(
    jobStatusSchema.parse({
      id: "job",
      state: "ready",
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
