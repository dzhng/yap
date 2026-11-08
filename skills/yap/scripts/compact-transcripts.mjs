import { createHash } from "node:crypto";
import { launchedAs, runJsonHelper } from "./inspection-artifacts.mjs";

const displayTime = (value) =>
  (typeof value === "number" ? value : value.numerator / value.denominator) / 1_000_000;
const rangeOf = (row) =>
  row.fragments?.length
    ? { startUs: row.fragments[0].project.startUs, endUs: row.fragments.at(-1).project.endUs }
    : row.sourceRange;

function separatedByPause(start, end, pauseUs) {
  const fraction = (value) =>
    typeof value === "number"
      ? [BigInt(value), 1n]
      : [BigInt(value.numerator), BigInt(value.denominator)];
  const [sn, sd] = fraction(start);
  const [en, ed] = fraction(end);
  return sn * ed - en * sd >= BigInt(pauseUs) * sd * ed;
}

function phrases(rows, pauseUs) {
  const result = [];
  let current;
  let previous;
  let currentEnd;
  for (const [index, row] of rows.entries()) {
    if (row.type !== "word") {
      current = previous = undefined;
      continue;
    }
    const range = rangeOf(row);
    if (
      !current ||
      row.segment !== previous.segment ||
      row.clipId !== previous.clipId ||
      row.generation !== previous.generation ||
      row.trackId !== previous.trackId ||
      row.instant ||
      previous.instant ||
      row.partial ||
      previous.partial ||
      row.fragments?.length > 1 ||
      previous.fragments?.length > 1 ||
      separatedByPause(range.startUs, currentEnd, pauseUs)
    ) {
      current = {
        text: row.text,
        rowIndexes: [index],
        displayRangeSeconds: [displayTime(range.startUs), displayTime(range.endUs)],
        speaker: null,
      };
      currentEnd = range.endUs;
      result.push(current);
    } else {
      current.text += ` ${row.text}`;
      current.rowIndexes.push(index);
      current.displayRangeSeconds[1] = Math.max(
        current.displayRangeSeconds[1],
        displayTime(range.endUs),
      );
    }
    if (separatedByPause(range.endUs, currentEnd, 0)) currentEnd = range.endUs;
    previous = row;
  }
  return result;
}

function selectionParams(selection) {
  const params = { ...selection };
  delete params.label;
  if ("projectId" in params) delete params.generation;
  return params;
}

function entryFor(selection, response, retained) {
  const params = selectionParams(selection);
  const project = "projectId" in params;
  const transcript = response.transcript;
  return {
    label: selection.label ?? params.assetId ?? params.projectId,
    selection: params,
    identity: project
      ? { projectId: response.projectId, revisionId: response.revisionId }
      : {
          ...params,
          generation: response.generation,
          supportDigest: transcript?.source.supportDigest,
        },
    durationUs: transcript?.source.durationUs ?? retained?.durationUs ?? null,
    sourceDurations: Array.isArray(response.dependencies)
      ? response.dependencies.map(({ selection, transcript }) => ({
          selection,
          generation: transcript?.generation ?? null,
          durationUs: transcript?.source.durationUs ?? null,
        }))
      : (retained?.sourceDurations ?? []),
    coverage: response.coverage?.occurrences
      ? response.coverage
      : (retained?.coverage ?? response.coverage ?? null),
    state: response.state,
    reason: response.reason ?? null,
    rows: [],
    phrases: [],
  };
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function integer(value, fallback, minimum, maximum, name) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw failure("INVALID_REQUEST", name + " is outside its supported range");
  return number;
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value) + "\n");

/** A reading artifact retains exact service rows; display seconds never authorize edits. */
export async function compactTranscripts(request, invoke) {
  if (
    !Array.isArray(request.selections) ||
    request.selections.length < 1 ||
    request.selections.length > 128
  )
    throw failure("INVALID_REQUEST", "Supply 1 to 128 transcript selections");
  const maxBytes = integer(request.maxBytes, 65536, 1024, 8 * 1024 * 1024, "maxBytes");
  const maxPages = integer(request.maxPages, 8, 1, 64, "maxPages");
  const pauseUs = integer(request.pauseUs, 400_000, 1, 60_000_000, "pauseUs");
  let pageRows = integer(request.pageRows, 100, 1, 1000, "pageRows");
  const digest = createHash("sha256").update(JSON.stringify(request.selections)).digest("hex");
  const resume = request.continuation;
  if (resume && resume.selectionDigest !== digest)
    throw failure("INVALID_PARAMS", "Continuation belongs to different selections");
  if (resume) pageRows = integer(resume.pageRows, pageRows, 1, 1000, "continuation.pageRows");
  let selections = [];
  let index = integer(resume?.index, 0, 0, request.selections.length - 1, "continuation.index");
  let cursor = resume?.cursor;
  let retained = resume?.retained;
  let pagesRead = 0;
  const output = (items, nextIndex, nextCursor, metadata, limitReached) => ({
    version: 1,
    selections: items,
    pagesRead,
    limitReached,
    continuation:
      nextIndex < request.selections.length
        ? {
            selectionDigest: digest,
            index: nextIndex,
            cursor: nextCursor ?? null,
            retained: metadata ?? null,
            pageRows,
          }
        : null,
  });
  while (index < request.selections.length && pagesRead < maxPages) {
    const selection = request.selections[index];
    const params = selectionParams(selection);
    // A continuation repeats the first page's parameters; its cursor already pins the revision.
    if (cursor) params.cursor = cursor;
    else if (retained?.identity.revisionId) params.revisionId = retained.identity.revisionId;
    params.limit = pageRows;
    const response = await invoke("transcript.get", params);
    pagesRead++;
    if (
      response.state === "ready" &&
      (!Array.isArray(response.rows) ||
        !("projectId" in selection ? response.revisionId : response.transcript?.source))
    )
      throw failure("INVALID_RESPONSE", "Ready transcript response lacks pinned page metadata");
    const entry = entryFor(selection, response, retained);
    const expectedGeneration = retained?.identity.generation ?? selection.generation;
    const expectedRevision = retained?.identity.revisionId ?? selection.revisionId;
    if (
      (expectedGeneration && expectedGeneration !== response.generation) ||
      (expectedRevision && expectedRevision !== response.revisionId)
    )
      throw failure("ARTIFACT_CHANGED", "Transcript generation or project revision changed");
    const following = response.state === "ready" ? response.nextCursor : null;
    const prior = selections.at(-1);
    entry.selectionIndex = index;
    entry.rows = [
      ...(prior?.selectionIndex === index ? prior.rows : []),
      ...(response.rows ?? []),
    ];
    entry.phrases = phrases(entry.rows, pauseUs);
    entry.complete = response.state === "ready" && !following;
    const candidate =
      prior?.selectionIndex === index
        ? [...selections.slice(0, -1), entry]
        : [...selections, entry];
    const metadata = { ...entry };
    delete metadata.rows;
    delete metadata.phrases;
    delete metadata.selectionIndex;
    const nextIndex = following ? index : index + 1;
    const proposed = output(
      candidate,
      nextIndex,
      following,
      following ? metadata : undefined,
      "bytes",
    );
    if (bytes(proposed) > maxBytes) {
      // A project checkpoint is opaque. Re-read a smaller page at the SAME cursor;
      // manufacturing a cursor for the last fitting word would skip evidence.
      retained = metadata;
      if (pageRows > 1) {
        pageRows = Math.max(1, Math.floor(pageRows / 2));
        continue;
      }
      let bounded = output(selections, index, cursor, retained, "bytes");
      if (bytes(bounded) > maxBytes && !cursor) {
        retained = { identity: metadata.identity };
        bounded = output(selections, index, cursor, retained, "bytes");
      }
      if (!selections.length || bytes(bounded) > maxBytes)
        throw failure(
          "OUTPUT_BUDGET_EXCEEDED",
          "One verbatim row or its pinned metadata exceeds maxBytes; increase the budget",
        );
      return bounded;
    }
    selections = candidate;
    index = nextIndex;
    cursor = following;
    retained = following ? metadata : undefined;
  }
  const result = output(
    selections,
    index,
    cursor,
    retained,
    index < request.selections.length ? "pages" : "none",
  );
  if (bytes(result) > maxBytes)
    throw failure(
      "OUTPUT_BUDGET_EXCEEDED",
      "Pinned continuation exceeds maxBytes; increase the budget",
    );
  return result;
}

if (launchedAs(import.meta.url, "compact-transcripts.mjs")) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node compact-transcripts.mjs < request.json\nRead-only transcript.get helper. Supply selections (assetId/streamId/acquisitionId or projectId/revisionId), optional labels/generation, maxBytes, maxPages, pageRows, pauseUs, continuation and cli options. Exact rows are edit evidence; phrase seconds are display only.",
    );
  } else {
    await runJsonHelper(compactTranscripts);
  }
}
