import { afterEach, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectServiceFixture } from "./project-service.fixture.js";
import { operationSchema } from "@yap/protocol";
// @ts-expect-error The distributed consumer helper is plain JavaScript.
import { reviewBundle } from "../../../skills/yap/scripts/review-bundle.mjs";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
test("public revision review distinguishes a pure silence split from a moved join without changing history", async () => {
  const f = await projectServiceFixture(cleanups, async () => ({
    ok: false,
    error: {
      code: "MEDIA_WORKER_UNAVAILABLE",
      message: "Controlled fixture has no native audio renderer",
      retryable: true,
      details: {},
    },
  }));
  const invoke = async (operation: string, params: Record<string, unknown>) => {
    operationSchema.parse({ operation, params });
    const reply = await f.call(operation, params);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
    return reply.data;
  };
  const created = (await invoke("project.create", {
    requestId: "review-create",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  })) as { project: { id: string }; revision: { id: string } };
  const projectId = created.project.id;
  const placed = (await invoke("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.id,
    requestId: "review-place",
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        label: "whole",
        clip: {
          trackId: { label: "audio" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  })) as { revision: { id: string; document: { clips: { id: string }[] } } };
  const split = (await invoke("edit.apply", {
    projectId,
    expectedRevisionId: placed.revision.id,
    requestId: "review-split",
    operations: [
      {
        operation: "split",
        clipIds: [placed.revision.document.clips[0]!.id],
        atUs: 500000,
        scope: "selected",
      },
    ],
  })) as typeof placed;
  for (const revision of [placed.revision, split.revision]) {
    const pending = (await invoke("timeline.events", {
      projectId,
      revisionId: revision.id,
      range: { startUs: 0, endUs: 1000000 },
    })) as { state: string; jobId: string };
    if (pending.state !== "ready") await f.job(pending.jobId, "ready");
  }
  const before = await invoke("revision.history", { projectId });
  const request = {
    projectId,
    revisions: [placed.revision, split.revision].map((revision) => ({
      revisionId: revision.id,
      range: { startUs: 0, endUs: 1000000 },
      extentProvenance: "Explicit controlled silence fixture",
      windows: [
        { range: { startUs: 400000, endUs: 800000 }, reason: "Same selected join context" },
      ],
    })),
    timeline: { frames: 0, maxEventPages: 1 },
    boundaryUs: 100000,
  };
  const identical = await reviewBundle(request, invoke);
  const moved = (await invoke("edit.apply", {
    projectId,
    expectedRevisionId: split.revision.id,
    requestId: "review-move",
    operations: [
      {
        operation: "move",
        clipIds: [split.revision.document.clips[1]!.id],
        atUs: 600000,
        ripple: "none",
        scope: "selected",
      },
    ],
  })) as typeof placed;
  const pending = (await invoke("timeline.events", {
    projectId,
    revisionId: moved.revision.id,
    range: { startUs: 0, endUs: 1000000 },
  })) as { state: string; jobId: string };
  if (pending.state !== "ready") await f.job(pending.jobId, "ready");
  for (const revision of [split.revision, moved.revision]) {
    const selected = (await invoke("timeline.events", {
      projectId,
      revisionId: revision.id,
      range: { startUs: 400000, endUs: 800000 },
    })) as { state: string; jobId: string };
    if (selected.state !== "ready") await f.job(selected.jobId, "ready");
  }
  const historyBeforeReview = await invoke("revision.history", { projectId });
  const changed = await reviewBundle(
    {
      ...request,
      revisions: [split.revision, moved.revision].map((revision) => ({
        revisionId: revision.id,
        range: { startUs: 0, endUs: 1000000 },
        extentProvenance: "Explicit controlled silence fixture",
        windows: [
          { range: { startUs: 400000, endUs: 800000 }, reason: "Same selected join context" },
        ],
      })),
    },
    invoke,
  );
  const after = await invoke("revision.history", { projectId });
  const evidence = process.env.YAP_REVIEW_TEST_OUTPUT;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "public-review.json"),
      JSON.stringify({ before, after, identical, changed }, null, 2) + "\n",
    );
  }
  expect(identical.comparison).toMatchObject({
    state: "complete",
    authoredDocumentChanged: true,
    cutEvidenceChanged: false,
    outputEquivalence: "not_established",
  });
  expect(changed.comparison).toMatchObject({ state: "complete", cutEvidenceChanged: true });
  expect(
    changed.revisions[1].events.rows
      .filter((row: { kind: string }) => row.kind === "cut")
      .map((row: { projectAtUs: number }) => row.projectAtUs),
  ).toEqual([500000, 600000]);
  expect((before as { revisions: unknown[] }).revisions).toHaveLength(3);
  expect((after as { revisions: unknown[] }).revisions).toHaveLength(4);
  expect(after).toEqual(historyBeforeReview);
  expect(await invoke("revision.history", { projectId })).toEqual(after);
  expect(
    changed.revisions[1].windows.every(
      (window: { checks: { sound: string } }) => window.checks.sound === "not_listened",
    ),
  ).toBe(true);
});
