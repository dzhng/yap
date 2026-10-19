import { expect, test } from "vitest";
// @ts-expect-error The distributed consumer helper is plain JavaScript.
import { repairJoinAndRecheck } from "../../../skills/yap/scripts/join-repair.mjs";

test("join repair applies one explicit edit and rechecks the changed revision", async () => {
  const calls: { operation: string; params: Record<string, unknown> }[] = [];
  const invoke = async (operation: string, params: Record<string, unknown>) => {
    calls.push({ operation, params });
    if (operation === "edit.apply")
      return { revision: { id: "r2" }, edits: [{ operation: "split" }] };
    if (operation === "join.verify") return { revisionId: "r2", phoneticCompleteness: "unknown" };
    throw new Error(`Unexpected operation ${operation}`);
  };
  const result = await repairJoinAndRecheck(
    {
      projectId: "p1",
      revisionId: "r1",
      repair: {
        requestId: "repair-1",
        operations: [{ operation: "split", clipIds: ["clip"], atUs: 500000, scope: "selected" }],
      },
      recheck: {
        preparedResourceId: "audio-1",
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        boundary: { trackId: "audio", projectAtUs: 500000 },
        context: { beforeUs: 100000, afterUs: 100000 },
        expectedText: "A complete question?",
        thresholdRMS: 0.01,
      },
    },
    invoke,
  );
  expect(result).toMatchObject({
    beforeRevisionId: "r1",
    afterRevisionId: "r2",
    recheck: { revisionId: "r2", phoneticCompleteness: "unknown" },
  });
  expect(calls.map(({ operation }) => operation)).toEqual(["edit.apply", "join.verify"]);
  expect(calls[0]?.params).toMatchObject({
    projectId: "p1",
    expectedRevisionId: "r1",
    requestId: "repair-1",
  });
  expect(calls[1]?.params).toMatchObject({ projectId: "p1", revisionId: "r2" });
});

test("join repair refuses a repair that does not advance the pinned revision", async () => {
  await expect(
    repairJoinAndRecheck(
      {
        projectId: "p1",
        revisionId: "r1",
        repair: { requestId: "repair-1", operations: [] },
        recheck: {
          preparedResourceId: "audio-1",
          tap: { target: { kind: "output" }, point: { kind: "processed" } },
          boundary: { trackId: "audio", projectAtUs: 0 },
          context: { beforeUs: 1, afterUs: 1 },
          expectedText: "question",
          thresholdRMS: 0,
        },
      },
      async () => ({ revision: { id: "r1" } }),
    ),
  ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
});

test("join repair can prepare the changed tap with a bounded status poll", async () => {
  const calls: string[] = [];
  let preparationReads = 0;
  const result = await repairJoinAndRecheck(
    {
      projectId: "p1",
      revisionId: "r1",
      repair: { requestId: "repair-1", operations: [{ operation: "split" }] },
      recheck: {
        preparedResourceId: "old-audio",
        prepare: { tap: { target: { kind: "output" }, point: { kind: "processed" } } },
        maxPolls: 2,
        pollMs: 0,
        boundary: { trackId: "audio", projectAtUs: 500000 },
        context: { beforeUs: 1, afterUs: 1 },
        expectedText: "question",
        thresholdRMS: 0,
      },
    },
    async (operation: string, params: Record<string, unknown>) => {
      calls.push(operation);
      if (operation === "edit.apply") return { revision: { id: "r2" } };
      if (operation === "audio.prepare") {
        preparationReads++;
        return preparationReads === 1
          ? { state: "running", jobId: "job" }
          : { state: "ready", published: { output: { resourceId: "new-audio" } } };
      }
      expect(operation).toBe("join.verify");
      expect(params).toMatchObject({ revisionId: "r2", preparedResourceId: "new-audio" });
      return { revisionId: "r2" };
    },
  );
  expect(result.preparation).toMatchObject({ state: "ready" });
  expect(calls).toEqual(["edit.apply", "audio.prepare", "audio.prepare", "join.verify"]);
});
