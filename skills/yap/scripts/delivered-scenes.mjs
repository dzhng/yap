import { createHash } from "node:crypto";
import { readFile as readBytes, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createCli } from "./yap-cli.mjs";
import { budget, failure, runJsonHelper } from "./inspection-artifacts.mjs";

const active = new Set(["queued", "running"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const time = (value, name) => {
  if (Number.isSafeInteger(value)) return value;
  if (
    value &&
    Number.isSafeInteger(value.numerator) &&
    Number.isSafeInteger(value.denominator) &&
    value.denominator > 0
  )
    return value;
  throw failure("INVALID_REQUEST", `${name} must be an integer or positive rational time`);
};
const range = (value, name) => {
  if (
    !value ||
    !Number.isSafeInteger(value.startUs) ||
    !Number.isSafeInteger(value.endUs) ||
    value.startUs < 0 ||
    value.endUs <= value.startUs
  )
    throw failure("INVALID_REQUEST", `${name} must be a positive integer range`);
  return { startUs: value.startUs, endUs: value.endUs };
};
function shifted(value, offset) {
  if (typeof value === "number") return value + offset;
  return {
    numerator: value.numerator + offset * value.denominator,
    denominator: value.denominator,
  };
}
function exactDistance(a, b) {
  const left = typeof a === "number" ? { numerator: a, denominator: 1 } : a;
  const right = typeof b === "number" ? { numerator: b, denominator: 1 } : b;
  return (
    Math.abs(left.numerator * right.denominator - right.numerator * left.denominator) /
    (left.denominator * right.denominator)
  );
}
function eventRows(result) {
  return result.rows ?? [];
}
async function readEvents(invoke, selection, budgets, label) {
  const rows = [];
  const observations = [];
  let cursor;
  let coverage = null;
  let state = "queued";
  for (let page = 0; page < budgets.maxEventPages; page++) {
    const result = await invoke("timeline.events", {
      ...selection,
      limit: Math.min(budgets.maxEvents - rows.length, 500),
      ...(cursor ? { cursor } : {}),
    });
    state = result.state ?? "ready";
    observations.push({
      state,
      ...(result.context ? { context: result.context } : {}),
      ...(result.coverage ? { coverage: result.coverage } : {}),
    });
    coverage ??= result.coverage ?? null;
    if (state !== "ready")
      return {
        state,
        rows,
        coverage,
        observations,
        complete: false,
        reason: result.reason ?? `${label}_${state}`,
      };
    rows.push(...eventRows(result));
    if (rows.length > budgets.maxEvents)
      throw failure("OUTPUT_BUDGET_EXCEEDED", `${label} exceeded maxEvents`);
    cursor = result.nextCursor;
    if (!cursor)
      return { state: "ready", rows, coverage, observations, complete: true, nextCursor: null };
  }
  return {
    state,
    rows,
    coverage,
    observations,
    complete: false,
    nextCursor: cursor ?? null,
    reason: "event_page_budget_exhausted",
  };
}
async function waitJob(invoke, jobId, budgets) {
  if (typeof jobId !== "string" || !jobId)
    throw failure("INVALID_RESPONSE", "Import has no job id");
  let result = await invoke("job.get", { jobId });
  for (let i = 0; i < budgets.polls && active.has(result.state); i++) {
    await delay(budgets.pollMs);
    result = await invoke("job.get", { jobId });
  }
  if (result.state !== "ready")
    throw failure("NOT_READY", `Delivered export import is ${result.state ?? "unavailable"}`);
  const assetId = result.published?.output?.assetId;
  if (typeof assetId !== "string" || !assetId)
    throw failure("INVALID_RESPONSE", "Delivered export import published no asset id");
  return result;
}

/** Match physical scene boundaries in an exported file to authored project joins. */
export function associateDeliveredScenes({
  deliveredRows,
  authoredRows,
  projectStartUs,
  deliveredStartUs,
  joinToleranceUs,
}) {
  const authoredJoins = authoredRows.filter(
    (row) => row?.kind === "cut" && row.mediaKind === "video",
  );
  const matched = new Set();
  const observedTransitions = deliveredRows
    .filter((row) => row?.kind === "scene")
    .map((row) => {
      const deliveredAtUs = time(row.sourceAtUs, "scene sourceAtUs");
      const projectAtUs = shifted(deliveredAtUs, projectStartUs - deliveredStartUs);
      const joins = authoredJoins.filter((join, index) => {
        const distance = exactDistance(projectAtUs, join.projectAtUs);
        if (distance <= joinToleranceUs) {
          matched.add(index);
          return true;
        }
        return false;
      });
      return { deliveredAtUs, projectAtUs, authoredJoins: joins };
    });
  return {
    observedTransitions,
    unmatchedAuthoredJoins: authoredJoins.filter((_, index) => !matched.has(index)),
  };
}

/**
 * Import the committed export bytes as an immutable asset and compare its measured scene rows with
 * the pinned revision's authored video cuts. This reports evidence only; it never edits a project.
 */
export async function deliveredScenes(request, invoke, { readFile = readBytes } = {}) {
  if (!request || typeof request !== "object")
    throw failure("INVALID_REQUEST", "request must be an object");
  if (typeof request.projectId !== "string" || !request.projectId)
    throw failure("INVALID_REQUEST", "projectId is required");
  if (typeof request.exportId !== "string" || !request.exportId)
    throw failure("INVALID_REQUEST", "exportId is required");
  invoke ??= createCli(request.cli);
  const projectRange = range(request.projectRange ?? request.range, "projectRange");
  const deliveredRange = range(
    request.deliveredRange ?? { startUs: 0, endUs: projectRange.endUs - projectRange.startUs },
    "deliveredRange",
  );
  const budgets = {
    maxEventPages: budget(request.maxEventPages, 8, 1, 64, "maxEventPages"),
    maxEvents: budget(request.maxEvents, 500, 1, 5000, "maxEvents"),
    maxBytes: budget(request.maxBytes, 32 * 1024 * 1024, 16384, 128 * 1024 * 1024, "maxBytes"),
    polls: budget(request.polls, 20, 0, 100, "polls"),
    pollMs: budget(request.pollMs, 100, 0, 10_000, "pollMs"),
  };
  const joinToleranceUs = budget(request.joinToleranceUs, 1, 0, 5_000_000, "joinToleranceUs");
  const exportStatus = await invoke("export.status", { exportId: request.exportId });
  if (exportStatus.state !== "ready" || typeof exportStatus.output !== "string")
    throw failure("NOT_READY", `Export ${request.exportId} is not ready`);
  const exportProjectId = exportStatus.snapshot?.projectId ?? exportStatus.projectId;
  if (exportProjectId !== request.projectId)
    throw failure("ARTIFACT_CHANGED", "Export belongs to a different project");
  if (request.revisionId && exportStatus.snapshot?.revisionId !== request.revisionId)
    throw failure("ARTIFACT_CHANGED", "Export belongs to a different revision");
  const before = await stat(exportStatus.output);
  if (!before.isFile() || before.size > budgets.maxBytes)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Export output is not a bounded regular file");
  const bytes = await readFile(exportStatus.output);
  if (!Buffer.isBuffer(bytes) || bytes.length !== before.size)
    throw failure("ARTIFACT_CHANGED", "Export changed while it was being read");
  const after = await stat(exportStatus.output);
  if (after.size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs)
    throw failure("ARTIFACT_CHANGED", "Export changed during scene inspection");
  const file = {
    path: exportStatus.output,
    bytes: bytes.length,
    sha256: digest(bytes),
    dev: before.dev,
    ino: before.ino,
  };
  const imported = await invoke("asset.import", {
    requestId: `delivered-scenes:${request.exportId}`,
    path: exportStatus.output,
  });
  const importedJob = await waitJob(invoke, imported.jobId, budgets);
  const assetId = importedJob.published.output.assetId;
  const asset = await invoke("asset.get", { assetId });
  const video = asset.streams?.find((stream) => stream.kind === "video");
  if (!video) throw failure("UNSUPPORTED_MEDIA", "Committed export has no video stream");
  const deliveredEvents = await readEvents(
    invoke,
    { assetId, streamId: video.id, sourceRange: deliveredRange },
    budgets,
    "delivered scenes",
  );
  const revision = await invoke("revision.get", {
    projectId: request.projectId,
    ...(request.revisionId ? { revisionId: request.revisionId } : {}),
  });
  if (!revision.revision?.id)
    throw failure("ARTIFACT_CHANGED", "Requested revision is unavailable");
  const authoredEvents = await readEvents(
    invoke,
    { projectId: request.projectId, revisionId: revision.revision.id, range: projectRange },
    budgets,
    "authored events",
  );
  const mapping = {
    projectStartUs: projectRange.startUs,
    deliveredStartUs: deliveredRange.startUs,
    projectEndUs: projectRange.endUs,
    deliveredEndUs: deliveredRange.endUs,
  };
  const association =
    deliveredEvents.complete && authoredEvents.complete
      ? associateDeliveredScenes({
          deliveredRows: deliveredEvents.rows,
          authoredRows: authoredEvents.rows,
          ...mapping,
          joinToleranceUs,
        })
      : { observedTransitions: [], unmatchedAuthoredJoins: [] };
  const result = {
    version: 1,
    kind: "delivered-scene-report",
    project: {
      projectId: request.projectId,
      revisionId: revision.revision.id,
      range: projectRange,
    },
    export: {
      exportId: request.exportId,
      state: exportStatus.state,
      snapshot: exportStatus.snapshot ?? null,
      file,
      immutable: true,
    },
    delivered: {
      assetId,
      streamId: video.id,
      range: deliveredRange,
      events: deliveredEvents,
    },
    authored: {
      range: projectRange,
      events: authoredEvents,
      cuts: authoredEvents.rows.filter((row) => row.kind === "cut" && row.mediaKind === "video"),
    },
    mapping: { ...mapping, joinToleranceUs },
    association,
    checks: {
      sourceBytesUnchanged: true,
      deliveredSceneEvidence: deliveredEvents.complete ? "ready" : deliveredEvents.state,
      authoredCutEvidence: authoredEvents.complete ? "ready" : authoredEvents.state,
      editorialDecision: "none",
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > budgets.maxBytes)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Delivered scene report exceeds maxBytes");
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node delivered-scenes.mjs < request.json\nSupply projectId, committed exportId, projectRange and optional revisionId/deliveredRange. The helper imports the exact committed file as an immutable asset, reads existing scene observations and authored video cuts, and returns an evidence-only association report.",
    );
  else await runJsonHelper(deliveredScenes);
}
