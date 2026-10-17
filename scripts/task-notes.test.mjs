import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resumeTaskNotes } from "../skills/yap/scripts/task-notes.mjs";
const notes = {
  version: 1,
  projectId: "project",
  revisionId: "chosen",
  intent: "Review caller-selected joins",
  candidates: [
    {
      id: "join-a",
      decision: "selected",
      rationale: "Caller requested this join",
      references: [
        { projectId: "project", revisionId: "chosen", clipId: "left" },
        { artifactKey: "picture" },
      ],
    },
    {
      id: "take-b",
      decision: "rejected",
      rationale: "Caller retained the first occurrence",
      references: [{ assetId: "source", streamId: "v", acquisitionId: "capture" }],
    },
  ],
  unresolved: ["Sound still needs actual listening"],
  artifacts: [
    {
      key: "picture",
      relativePath: "join.png",
      reference: { projectId: "project", revisionId: "chosen", jobId: "frame-job", generation: 2 },
    },
  ],
};
test("transferred notes keep caller decisions historical and missing artifacts missing without preparation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const donor = join(directory, "donor"),
    recipient = join(directory, "recipient");
  await mkdir(donor);
  await mkdir(recipient);
  await writeFile(join(donor, "notes.json"), JSON.stringify(notes));
  await writeFile(join(donor, "join.png"), "controlled task artifact");
  await cp(join(donor, "notes.json"), join(recipient, "notes.json"));
  const calls = [];
  let head = "chosen";
  const invoke = async (operation, params) => {
    calls.push({ operation, params });
    if (operation === "project.get") return { projectId: "project", currentRevisionId: head };
    assert.equal(operation, "revision.get");
    assert.equal(params.revisionId, "chosen");
    return { projectId: "project", revision: { id: "chosen", ordinal: 1 } };
  };
  const first = await resumeTaskNotes({ notesPath: join(recipient, "notes.json") }, invoke);
  assert.equal(first.stale, false);
  assert.equal(first.artifacts[0].state, "missing");
  head = "later";
  const historical = await resumeTaskNotes({ notesPath: join(recipient, "notes.json") }, invoke);
  assert.equal(historical.stale, true);
  assert.equal(historical.currentRevisionId, "later");
  assert.deepEqual(historical.notes, notes);
  assert.equal(historical.notesSha256, first.notesSha256);
  assert.equal(historical.artifacts[0].state, "missing");
  assert.deepEqual(JSON.parse(await readFile(join(recipient, "notes.json"), "utf8")), notes);
  await cp(join(donor, "join.png"), join(recipient, "join.png"));
  const transferred = await resumeTaskNotes({ notesPath: join(recipient, "notes.json") }, invoke);
  assert.equal(transferred.artifacts[0].state, "present");
  assert.equal(transferred.artifacts[0].contentVerification, "not_checked");
  assert.deepEqual(transferred.notes.candidates[0].references, notes.candidates[0].references);
  assert.ok(calls.every((c) => ["project.get", "revision.get"].includes(c.operation)));
});

test("escaped files and unavailable historical identities stay explicit, and unsupported notes never dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-unavailable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "notes.json");
  const input = {
    ...notes,
    artifacts: [{ ...notes.artifacts[0], relativePath: "../outside.png" }],
    candidates: [
      ...notes.candidates,
      {
        id: "untransferred",
        decision: "selected",
        rationale: "Caller selected an unavailable preview",
        references: [{ artifactKey: "absent-preview" }],
      },
    ],
  };
  await writeFile(path, JSON.stringify(input));
  const result = await resumeTaskNotes({ notesPath: path }, async () => {
    throw Object.assign(new Error("Not imported in this library"), { code: "NOT_FOUND" });
  });
  assert.equal(result.stale, null);
  assert.equal(result.current.state, "unavailable");
  assert.equal(result.pinnedRevision.error.code, "NOT_FOUND");
  assert.equal(result.artifacts[0].state, "missing");
  assert.equal(result.artifacts[0].reason, "outside_transfer_root");
  assert.deepEqual(result.unresolvedArtifactKeys, ["absent-preview"]);
  assert.deepEqual(result.notes, input);
  await writeFile(path, JSON.stringify({ ...input, version: 2 }));
  let calls = 0;
  await assert.rejects(
    resumeTaskNotes({ notesPath: path }, async () => {
      calls++;
    }),
    { code: "INVALID_NOTES" },
  );
  assert.equal(calls, 0);
});

test("a task-local artifact key cannot make an unpinned occurrence authoritative", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-unpinned-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.json");
  await writeFile(
    notesPath,
    JSON.stringify({
      ...notes,
      candidates: [
        {
          ...notes.candidates[0],
          references: [{ artifactKey: "picture", clipId: "unscoped-occurrence" }],
        },
      ],
    }),
  );
  let dispatches = 0;
  await assert.rejects(
    resumeTaskNotes({ notesPath }, async () => {
      dispatches++;
      return {};
    }),
    { code: "INVALID_NOTES" },
  );
  assert.equal(dispatches, 0);
});

test("a fabricated media identity cannot stand in for an owner receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-no-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.json");
  await writeFile(
    notesPath,
    JSON.stringify({
      ...notes,
      artifacts: [{ ...notes.artifacts[0], reference: { renderId: "no-public-owner" } }],
    }),
  );
  await assert.rejects(
    resumeTaskNotes({ notesPath }, async () => ({})),
    { code: "INVALID_NOTES" },
  );
});

test("standalone acquisitions retain their independently owned immutable identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-acquisition-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.json"),
    input = {
      ...notes,
      candidates: [
        { ...notes.candidates[0], references: [{ acquisitionId: "multi-binding-capture" }] },
      ],
    };
  await writeFile(notesPath, JSON.stringify(input));
  const result = await resumeTaskNotes({ notesPath }, async () => {
    throw Object.assign(new Error("Not imported"), { code: "NOT_FOUND" });
  });
  assert.deepEqual(result.notes, input);
  assert.equal(result.current.state, "unavailable");
});

test("nullable absent fields in source and unavailable-frame receipts stay verbatim without becoming anchors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-null-fields-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.json"),
    input = {
      ...notes,
      candidates: [
        {
          ...notes.candidates[0],
          references: [
            {
              assetId: "physical",
              streamId: "audio",
              acquisitionId: null,
              generation: "source-generation",
              supportDigest: "physical-support",
            },
            {
              assetId: "physical",
              streamId: "video",
              jobId: null,
              state: "unavailable",
              reason: "physical_gap",
            },
          ],
        },
      ],
    };
  await writeFile(notesPath, JSON.stringify(input));
  const result = await resumeTaskNotes({ notesPath }, async () => {
    throw new Error("No project here");
  });
  assert.deepEqual(result.notes, input);
});

test("an export owner receipt preserves its nested pinned snapshot without inventing a top-level revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-notes-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notesPath = join(directory, "notes.json"),
    receipt = {
      exportId: "owned-export",
      projectId: "project",
      snapshot: { revisionId: "chosen", documentHash: "immutable-document" },
      jobId: null,
      output: null,
      state: "queued",
      reason: "not_prepared",
    };
  const input = { ...notes, artifacts: [{ ...notes.artifacts[0], reference: receipt }] };
  await writeFile(notesPath, JSON.stringify(input));
  const result = await resumeTaskNotes({ notesPath }, async () => {
    throw new Error("No preparation allowed");
  });
  assert.deepEqual(result.notes.artifacts[0].reference, receipt);
  assert.equal(result.artifacts[0].state, "missing");
  assert.ok(!("revisionId" in result.artifacts[0].reference));
});

test(
  "a named pipe cannot block the explicitly regular notes-file read",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yap-notes-pipe-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const notesPath = join(directory, "notes.pipe");
    const made = spawnSync("mkfifo", [notesPath], { encoding: "utf8", timeout: 1500 });
    assert.equal(made.status, 0, made.stderr);
    const helper = fileURLToPath(new URL("../skills/yap/scripts/task-notes.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [helper], {
      input: JSON.stringify({ notesPath }),
      encoding: "utf8",
      timeout: 1500,
    });
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, "OUTPUT_BUDGET_EXCEEDED");
  },
);
