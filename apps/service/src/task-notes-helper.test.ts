import { afterEach, expect, test } from "vitest";
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { projectServiceFixture } from "./project-service.fixture.js";
import { operationSchema } from "@yap/protocol";
// @ts-expect-error The distributed consumer helper is plain JavaScript.
import { resumeTaskNotes } from "../../../skills/yap/scripts/task-notes.mjs";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
test("actual public metadata leaves transferred annotations historical without preparing missing evidence", async () => {
  let nativeCalls = 0;
  const f = await projectServiceFixture(cleanups, async (operation) => {
    nativeCalls++;
    throw new Error(`Unexpected native work: ${operation}`);
  });
  const invoke = async (operation: string, params: Record<string, unknown>) => {
    operationSchema.parse({ operation, params });
    const reply = await f.call(operation, params);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
    return reply.data;
  };
  const created = (await invoke("project.create", {
    requestId: "notes-create",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  })) as { project: { projectId: string }; revision: { revisionId: string } };
  const projectId = created.project.projectId;
  const notes = {
    version: 1,
    projectId,
    revisionId: created.revision.revisionId,
    intent: "Inspect the caller-selected first revision",
    candidates: [
      {
        id: "opening",
        decision: "selected",
        rationale: "Caller requested this boundary",
        references: [{ projectId, revisionId: created.revision.revisionId }],
      },
    ],
    unresolved: ["Preview evidence has not been transferred"],
    artifacts: [
      {
        key: "opening",
        relativePath: "opening.png",
        reference: { projectId, revisionId: created.revision.revisionId },
      },
    ],
  };
  const donor = join(f.home, "donor"),
    recipient = join(f.home, "recipient");
  await mkdir(donor);
  await mkdir(recipient);
  await writeFile(join(donor, "notes.json"), JSON.stringify(notes));
  await cp(join(donor, "notes.json"), join(recipient, "notes.json"));
  const notesPath = join(recipient, "notes.json");
  const current = await resumeTaskNotes({ notesPath }, invoke);
  const edited = (await invoke("edit.apply", {
    projectId,
    requestId: "notes-resize",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      {
        operation: "canvas.set",
        canvas: {
          width: 32,
          height: 16,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
      },
    ],
  })) as { revision: { revisionId: string } };
  const before = await invoke("revision.history", { projectId });
  const historical = await resumeTaskNotes({ notesPath }, invoke);
  const after = await invoke("revision.history", { projectId });
  const evidence = process.env.YAP_NOTES_TEST_OUTPUT;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "public-notes.json"),
      JSON.stringify({ notes, current, historical, before, after }, null, 2) + "\n",
    );
  }
  expect(current.stale).toBe(false);
  expect(historical.stale).toBe(true);
  expect(historical.currentRevisionId).toBe(edited.revision.revisionId);
  expect(historical.pinnedRevision).toMatchObject({
    state: "available",
    revisionId: created.revision.revisionId,
  });
  expect(historical.artifacts[0]).toMatchObject({
    state: "missing",
    reason: "not_transferred",
    contentVerification: "not_checked",
  });
  expect(historical.notes).toEqual(notes);
  expect(JSON.parse(await readFile(notesPath, "utf8"))).toEqual(notes);
  expect(after).toEqual(before);
  expect(nativeCalls).toBe(0);
});
