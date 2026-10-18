import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createCli } from "./yap-cli.mjs";
import { budget, failure, readTaskFile, runJsonHelper } from "./inspection-artifacts.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && !!value.trim();
const invalid = (message) => {
  throw failure("INVALID_NOTES", message);
};
function reference(value, localArtifact = false) {
  if (!object(value)) invalid("References must retain exact owner identities or receipts");
  if (value.artifactKey !== undefined && !text(value.artifactKey))
    invalid("Task-local artifact keys must be nonempty strings");
  const fields = [
    "projectId",
    "revisionId",
    "clipId",
    "assetId",
    "streamId",
    "acquisitionId",
    "jobId",
    "exportId",
  ];
  if (fields.some((key) => value[key] != null && !text(value[key])))
    invalid("Present identity fields must be nonempty strings");
  const independent = ["assetId", "acquisitionId", "jobId", "exportId"].some((key) =>
    text(value[key]),
  );
  if (value.projectId && !value.revisionId && !independent)
    invalid("Project references require a pinned revision or an independently owned receipt");
  if (value.clipId && (!value.projectId || !value.revisionId))
    invalid("Occurrence references require their project and revision");
  if (value.streamId && !value.assetId) invalid("Source stream references require their asset");
  if (localArtifact && text(value.artifactKey)) return;
  if (!value.projectId && !independent) invalid("Reference has no authoritative owner identity");
}
function validate(notes) {
  if (!object(notes) || notes.version !== 1) invalid("Unsupported task notes version; expected 1");
  if (!text(notes.projectId) || !text(notes.revisionId) || !text(notes.intent))
    invalid("Supply pinned project/revision identities and caller intent");
  if (
    !Array.isArray(notes.candidates) ||
    notes.candidates.length > 128 ||
    !Array.isArray(notes.unresolved) ||
    notes.unresolved.some((value) => !text(value))
  )
    invalid("Supply bounded candidates and unresolved text issues");
  const ids = new Set();
  for (const candidate of notes.candidates) {
    if (
      !text(candidate.id) ||
      ids.has(candidate.id) ||
      !["selected", "rejected"].includes(candidate.decision) ||
      !text(candidate.rationale) ||
      !Array.isArray(candidate.references) ||
      !candidate.references.length ||
      candidate.references.length > 32
    )
      invalid(
        "Candidates require unique IDs, explicit decisions, rationale and bounded exact references",
      );
    ids.add(candidate.id);
    candidate.references.forEach((value) => reference(value, true));
  }
  if (!Array.isArray(notes.artifacts) || notes.artifacts.length > 128)
    invalid("Supply a bounded artifact list");
  const keys = new Set();
  for (const artifact of notes.artifacts) {
    if (
      !text(artifact.key) ||
      keys.has(artifact.key) ||
      (artifact.relativePath !== undefined && !text(artifact.relativePath))
    )
      invalid("Artifacts require unique task-local keys and optional relative transfer paths");
    keys.add(artifact.key);
    reference(artifact.reference);
  }
  return notes;
}
const unavailable = (error) => ({
  state: "unavailable",
  error: { code: error.code ?? "NOTES_REFERENCE_UNAVAILABLE", message: error.message },
});

/** Annotations remain caller-owned historical evidence; resuming never reenacts them. */
export async function resumeTaskNotes(request, invoke = createCli(request.cli)) {
  if (!text(request.notesPath))
    throw failure("INVALID_REQUEST", "Supply an explicitly transferred notesPath");
  const maxBytes = budget(request.maxBytes, 256 * 1024, 1024, 1024 * 1024, "maxBytes");
  const bytes = await readTaskFile(request.notesPath, maxBytes);
  let notes;
  try {
    notes = validate(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw failure(error.code ?? "INVALID_NOTES", error.message);
  }
  const result = {
    version: 1,
    notes,
    notesSha256: createHash("sha256").update(bytes).digest("hex"),
    currentRevisionId: null,
    stale: null,
    current: { state: "unavailable" },
    pinnedRevision: { state: "unavailable" },
    artifacts: [],
    unresolvedArtifactKeys: [],
    checks: {
      contentVerification: "not_checked",
      preparation: "not_requested",
      edits: "not_requested",
    },
  };
  try {
    const current = await invoke("project.get", { projectId: notes.projectId });
    if (
      (current.projectId && current.projectId !== notes.projectId) ||
      !text(current.currentRevisionId)
    )
      throw failure(
        "ARTIFACT_CHANGED",
        "Project metadata does not identify the requested current revision",
      );
    result.current = { state: "available", ...current };
    result.currentRevisionId = current.currentRevisionId;
    result.stale = current.currentRevisionId !== notes.revisionId;
  } catch (error) {
    result.current = unavailable(error);
  }
  try {
    const pinned = await invoke("revision.get", {
      projectId: notes.projectId,
      revisionId: notes.revisionId,
    });
    if (
      pinned.revision?.revisionId !== notes.revisionId ||
      (pinned.projectId && pinned.projectId !== notes.projectId)
    )
      throw failure("ARTIFACT_CHANGED", "Historical revision is unavailable");
    const { revisionId, ordinal, createdAt } = pinned.revision;
    result.pinnedRevision = {
      state: "available",
      revisionId,
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  } catch (error) {
    result.pinnedRevision = unavailable(error);
  }
  let root;
  try {
    root = await realpath(request.artifactRoot ?? dirname(resolve(request.notesPath)));
  } catch (error) {
    root = unavailable(error);
  }
  for (const artifact of notes.artifacts) {
    const entry = { ...artifact, state: "missing", contentVerification: "not_checked" };
    result.artifacts.push(entry);
    if (!artifact.relativePath) {
      entry.reason = "not_transferred";
      continue;
    }
    const path = artifact.relativePath;
    if (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) {
      entry.reason = "outside_transfer_root";
      continue;
    }
    if (typeof root !== "string") {
      entry.reason = "transfer_root_unavailable";
      entry.error = root.error;
      continue;
    }
    try {
      const file = await realpath(resolve(root, path));
      const within = relative(root, file);
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        entry.reason = "outside_transfer_root";
        continue;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        entry.reason = "not_a_file";
        continue;
      }
      entry.state = "present";
      entry.bytes = info.size;
    } catch (error) {
      entry.reason = error.code === "ENOENT" ? "not_transferred" : "file_unavailable";
      entry.error = { code: error.code ?? "FILE_UNAVAILABLE", message: error.message };
    }
  }
  const transferredKeys = new Set(notes.artifacts.map((value) => value.key));
  result.unresolvedArtifactKeys = [
    ...new Set(
      notes.candidates
        .flatMap((value) => value.references)
        .map((value) => value.artifactKey)
        .filter((value) => value && !transferredKeys.has(value)),
    ),
  ];
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * maxBytes)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Notes and resume evidence exceed the output budget");
  return result;
}
if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node task-notes.mjs < request.json\nSupply notesPath, optional artifactRoot/maxBytes/cli. Explicitly copy the notes JSON and selected artifacts beside the project package. Notes syntax: version:1, projectId, revisionId, intent, candidates:[{id,decision:selected|rejected,rationale,references:[exact identity/receipt or {artifactKey}]}], unresolved:[text], artifacts:[{key,relativePath?,reference:exact owner identity/receipt}]. Public identity anchors: pinned projectId/revisionId/clipId, assetId/streamId, acquisitionId, jobId/exportId. Extra receipt fields remain verbatim. Reports current head, historical identity availability and local file presence; never imports, prepares media, retries work, edits or treats annotations as current state. Presence is not content/quality verification.",
    );
  else await runJsonHelper(resumeTaskNotes);
}
