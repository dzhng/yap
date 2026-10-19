import { createCli } from "./yap-cli.mjs";
import { failure, runJsonHelper } from "./inspection-artifacts.mjs";

const active = new Set(["queued", "running"]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertRequest(request) {
  if (!request || typeof request !== "object")
    throw failure("INVALID_REQUEST", "Supply a repair request");
  if (typeof request.projectId !== "string" || !request.projectId)
    throw failure("INVALID_REQUEST", "Supply projectId");
  if (typeof request.revisionId !== "string" || !request.revisionId)
    throw failure("INVALID_REQUEST", "Supply the pinned revisionId");
  if (!request.repair || typeof request.repair !== "object")
    throw failure("INVALID_REQUEST", "Supply one explicit repair");
  if (typeof request.repair.requestId !== "string" || !request.repair.requestId)
    throw failure("INVALID_REQUEST", "Repair requires requestId");
  if (!Array.isArray(request.repair.operations) || request.repair.operations.length > 1000)
    throw failure("INVALID_REQUEST", "Repair operations must be a bounded array");
  if (!request.recheck || typeof request.recheck !== "object")
    throw failure("INVALID_REQUEST", "Supply a changed-output recheck");
  if (typeof request.recheck.preparedResourceId !== "string" || !request.recheck.preparedResourceId)
    throw failure("INVALID_REQUEST", "Recheck requires preparedResourceId");
}

/**
 * Apply one caller-authored repair and immediately re-run join.verify against the
 * resulting revision. This helper never selects a boundary, changes wording,
 * retries failed work, or turns evidence into an edit decision.
 */
export async function repairJoinAndRecheck(request, invoke) {
  assertRequest(request);
  invoke ??= createCli(request.cli);
  const { projectId, revisionId, repair, recheck } = request;
  const edited = await invoke("edit.apply", {
    projectId,
    expectedRevisionId: revisionId,
    requestId: repair.requestId,
    operations: repair.operations,
  });
  const afterRevisionId = edited?.revision?.id;
  if (typeof afterRevisionId !== "string" || afterRevisionId === revisionId)
    throw failure("ARTIFACT_CHANGED", "Repair did not advance the pinned revision");

  let preparedResourceId = recheck.preparedResourceId;
  let preparation = null;
  if (recheck.prepare !== undefined) {
    if (!recheck.prepare || typeof recheck.prepare !== "object")
      throw failure("INVALID_REQUEST", "prepare must be an explicit operation parameter object");
    const params = {
      ...recheck.prepare,
      projectId,
      revisionId: afterRevisionId,
    };
    preparation = await invoke("audio.prepare", params);
    const maxPolls = recheck.maxPolls ?? 20;
    const pollMs = recheck.pollMs ?? 250;
    if (!Number.isSafeInteger(maxPolls) || maxPolls < 0 || maxPolls > 100)
      throw failure("INVALID_REQUEST", "maxPolls is outside its supported range");
    if (!Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > 10_000)
      throw failure("INVALID_REQUEST", "pollMs is outside its supported range");
    for (let i = 0; i < maxPolls && active.has(preparation?.state); i++) {
      await delay(pollMs);
      preparation = await invoke("audio.prepare", params);
    }
    if (active.has(preparation?.state))
      throw failure(
        "NOT_READY",
        "Changed-output audio preparation remains active",
        { preparation },
        true,
      );
    if (preparation?.state === "failed" || preparation?.state === "canceled")
      throw failure("NOT_READY", "Changed-output audio preparation did not publish", {
        preparation,
      });
    const published = preparation?.published?.output;
    if (typeof published?.resourceId !== "string")
      throw failure("INVALID_RESPONSE", "Changed-output preparation has no published resource");
    preparedResourceId = published.resourceId;
  }
  const { prepare: _prepare, maxPolls: _maxPolls, pollMs: _pollMs, ...verification } = recheck;
  const recheckResult = await invoke("join.verify", {
    ...verification,
    projectId,
    revisionId: afterRevisionId,
    preparedResourceId,
  });
  return {
    beforeRevisionId: revisionId,
    afterRevisionId,
    repair: edited,
    ...(preparation === null ? {} : { preparation }),
    recheck: recheckResult,
  };
}

if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node join-repair.mjs < request.json\nSupply projectId, pinned revisionId, one explicit repair {requestId,operations}, and recheck {preparedResourceId,...}. Optional recheck.prepare reparses audio for the changed revision with bounded polls. The helper performs exactly one edit and one join.verify; it never chooses or retries a repair.",
    );
  else await runJsonHelper(repairJoinAndRecheck);
}
