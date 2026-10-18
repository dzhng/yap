import { createHash } from "node:crypto";
import { inspectTimeline } from "./timeline-inspection.mjs";
import { createCli } from "./yap-cli.mjs";
import { budget, failure, runJsonHelper } from "./inspection-artifacts.mjs";

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const errorFact = (error) => ({
  state: "error",
  error: { code: error.code ?? "REVIEW_FAILED", message: error.message },
});
function range(value) {
  if (
    !Number.isSafeInteger(value?.startUs) ||
    !Number.isSafeInteger(value?.endUs) ||
    value.startUs < 0 ||
    value.endUs <= value.startUs
  )
    throw failure(
      "INVALID_REQUEST",
      "Each revision needs an explicit positive integer selection range",
    );
  return { ...value };
}
function point(value) {
  if (Number.isSafeInteger(value)) return [BigInt(value), 1n];
  if (
    Number.isSafeInteger(value?.numerator) &&
    Number.isSafeInteger(value?.denominator) &&
    value.denominator > 0
  )
    return [BigInt(value.numerator), BigInt(value.denominator)];
  throw failure("INVALID_RESPONSE", "Cut has no supported exact project coordinate");
}
const contains = (at, span) => {
  const [n, d] = point(at);
  return n >= BigInt(span.startUs) * d && n < BigInt(span.endUs) * d;
};
function cutWindow(at, selection, context) {
  const [n, d] = point(at);
  const floor = n / d - (n < 0n && n % d ? 1n : 0n);
  const ceil = floor + (n % d ? 1n : 0n);
  return {
    startUs: Math.max(selection.startUs, Number(floor) - context),
    endUs: Math.min(selection.endUs, Number(ceil) + context),
  };
}
function semanticCut(row) {
  const side = (value) => {
    if (!value) return value;
    const { clipId: _clipId, ...mapping } = value;
    return mapping;
  };
  return { ...row, before: side(row.before), after: side(row.after) };
}

/** A review selection is caller evidence, never a resolved whole-revision extent. */
export async function reviewBundle(request, invoke = createCli(request.cli), artifacts = {}) {
  if (
    typeof request.projectId !== "string" ||
    !request.projectId ||
    !Array.isArray(request.revisions) ||
    request.revisions.length < 1 ||
    request.revisions.length > 2
  )
    throw failure("INVALID_REQUEST", "Supply a project and one or two revision selections");
  if (request.revisions.length === 2 && request.revisions.some((value) => !value.revisionId))
    throw failure("INVALID_REQUEST", "A revision pair requires both explicit identities");
  const selections = request.revisions.map((value) => {
    if (typeof value.extentProvenance !== "string" || !value.extentProvenance.trim())
      throw failure("INVALID_REQUEST", "Describe the provenance of each selected extent");
    if ((value.windows?.length ?? 0) > 32)
      throw failure("INVALID_REQUEST", "Too many selected windows");
    return {
      ...value,
      range: range(value.range),
      windows: (value.windows ?? []).map((window) => ({
        range: range(window.range),
        reason: window.reason ?? "caller-selected middle/overlay",
      })),
    };
  });
  const budgets = {
    boundaryUs: budget(request.boundaryUs, 1_000_000, 1, 10_000_000, "boundaryUs"),
    contextUs: budget(request.contextUs, 200_000, 1, 5_000_000, "contextUs"),
    maxWindows: budget(request.maxWindows, 8, 1, 16, "maxWindows"),
    maxEventPages: budget(request.maxEventPages, 4, 1, 8, "maxEventPages"),
    maxEvents: budget(request.maxEvents, 128, 1, 500, "maxEvents"),
    maxBytes: budget(request.maxBytes, 32 * 1024 * 1024, 16384, 64 * 1024 * 1024, "maxBytes"),
  };
  const output = {
    version: 1,
    projectId: request.projectId,
    budgets,
    revisions: [],
    comparison: null,
    checks: { sound: "not_listened", pictureQuality: "not_judged" },
  };
  let remainingWindows = budgets.maxWindows;
  for (const selection of selections) {
    const resolved = await invoke("revision.get", {
      projectId: request.projectId,
      ...(selection.revisionId ? { revisionId: selection.revisionId } : {}),
    });
    const revisionId = resolved.revision?.revisionId;
    if (!revisionId || (selection.revisionId && selection.revisionId !== revisionId))
      throw failure("ARTIFACT_CHANGED", "Requested revision is unavailable");
    const identity = { projectId: request.projectId, revisionId };
    const review = {
      ...identity,
      range: selection.range,
      extentProvenance: selection.extentProvenance,
      extentBasis: "caller-selection",
      wholeRevisionExtentVerified: false,
      authoredDocumentSha256: digest(resolved.revision.document),
      events: { rows: [], observations: [], coverage: null, nextCursor: null, complete: false },
      windows: [],
      skipped: [],
      unobserved: [
        {
          kind: "processing-overlay-entrances",
          reason: "No public canonical timing evidence; supply explicit windows",
        },
      ],
    };
    output.revisions.push(review);
    const events = review.events;
    try {
      let cursor;
      for (let page = 0; page < budgets.maxEventPages; page++) {
        const result = await invoke("timeline.events", {
          ...identity,
          range: selection.range,
          limit: budgets.maxEvents - events.rows.length,
          ...(cursor ? { cursor } : {}),
        });
        if (result.revisionId && result.revisionId !== revisionId)
          throw failure("ARTIFACT_CHANGED", "Events returned a different revision");
        // A pending read carries no rows collection; only a returned page can complete the scan.
        const { rows, nextCursor = null, ...facts } = result;
        events.observations.push(facts);
        events.coverage ??= result.coverage;
        events.rows.push(...(rows ?? []));
        if (events.rows.length > budgets.maxEvents)
          throw failure("INVALID_RESPONSE", "Event owner exceeded the row budget");
        cursor = nextCursor;
        events.nextCursor = cursor ?? null;
        events.complete =
          Array.isArray(rows) && !cursor && events.coverage?.cuts?.state === "ready";
        if (!cursor || events.rows.length >= budgets.maxEvents) break;
      }
    } catch (error) {
      events.error = errorFact(error);
      events.complete = false;
    }
    const candidates = [
      {
        range: {
          startUs: selection.range.startUs,
          endUs: Math.min(selection.range.endUs, selection.range.startUs + budgets.boundaryUs),
        },
        origin: { kind: "selection-opening" },
      },
      {
        range: {
          startUs: Math.max(selection.range.startUs, selection.range.endUs - budgets.boundaryUs),
          endUs: selection.range.endUs,
        },
        origin: { kind: "selection-ending" },
      },
    ];
    for (const cut of events.rows.filter((row) => row.kind === "cut")) {
      try {
        if (contains(cut.projectAtUs, selection.range))
          candidates.push({
            range: cutWindow(cut.projectAtUs, selection.range, budgets.contextUs),
            origin: { kind: cut.after?.kind === "text" ? "text-entrance" : "join", cut },
          });
      } catch (error) {
        review.skipped.push({ origin: { kind: "cut", cut }, ...errorFact(error) });
      }
    }
    for (const window of selection.windows)
      candidates.push({ ...window, origin: { kind: "caller-selected", reason: window.reason } });
    const unique = new Map();
    for (const candidate of candidates) {
      const selected = candidate.range;
      if (
        selected.startUs < selection.range.startUs ||
        selected.endUs > selection.range.endUs ||
        selected.endUs - selected.startUs > 60_000_000
      ) {
        review.skipped.push({
          ...candidate,
          reason: "Window is outside selection or exceeds 60 seconds",
        });
        continue;
      }
      const key = `${selected.startUs}:${selected.endUs}`;
      if (unique.has(key)) unique.get(key).origins.push(candidate.origin);
      else unique.set(key, { range: selected, origins: [candidate.origin] });
    }
    for (const window of unique.values()) {
      if (!remainingWindows) {
        review.skipped.push({ ...window, reason: "Total window budget exhausted" });
        continue;
      }
      remainingWindows--;
      const result = { ...window, checks: { sound: "not_listened", pictureQuality: "not_judged" } };
      review.windows.push(result);
      try {
        result.inspection = await inspectTimeline(
          { ...request.timeline, target: identity, range: window.range },
          invoke,
          artifacts,
        );
        result.checks.picture = result.inspection.manifest.frames.map((frame) => ({
          atUs: frame.atUs,
          state: frame.data?.state ?? frame.error?.code ?? "unavailable",
        }));
        result.checks.waveform = result.inspection.manifest.waveform.state;
        result.checks.transcript =
          result.inspection.manifest.transcripts.selections?.[0]?.state ??
          result.inspection.manifest.transcripts.state;
      } catch (error) {
        result.inspection = errorFact(error);
      }
      if (Buffer.byteLength(JSON.stringify(output)) > budgets.maxBytes)
        throw failure("OUTPUT_BUDGET_EXCEEDED", "Review bundle exceeds maxBytes");
    }
  }
  if (output.revisions.length === 2) {
    const [before, after] = output.revisions;
    const comparable =
      before.events.complete &&
      after.events.complete &&
      digest(before.range) === digest(after.range);
    const cuts = (review) =>
      review.events.rows.filter((row) => row.kind === "cut").map(semanticCut);
    output.comparison = {
      state: comparable ? "complete" : "partial",
      authoredDocumentChanged: before.authoredDocumentSha256 !== after.authoredDocumentSha256,
      cutEvidenceChanged: comparable ? digest(cuts(before)) !== digest(cuts(after)) : null,
      outputEquivalence: "not_established",
    };
  }
  if (Buffer.byteLength(JSON.stringify(output)) > budgets.maxBytes)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Review bundle exceeds maxBytes");
  return output;
}
if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node review-bundle.mjs < request.json\nSupply projectId and revisions (one current/explicit revision or an explicit pair), each with range, extentProvenance and optional windows [{range,reason}]. Optional boundaryUs/contextUs/maxWindows/maxEventPages/maxEvents/maxBytes/timeline/cli bound work. Selection opening/ending are not whole-revision extents. Returns exact receipts and existing timeline SVG sheets. No edits, ASR preparation, full render or listening verdict.",
    );
  else await runJsonHelper(reviewBundle);
}
