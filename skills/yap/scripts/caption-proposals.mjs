import { boundedIssues, budget, failure, launchedAs, runJsonHelper } from "./inspection-artifacts.mjs";

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const length = (text) => [...graphemes.segment(text)].length;
const sentenceEnd = /[.!?。！？]["'”’»）)]*$/u;
const time = (value) => {
  const n = typeof value === "number" ? value : value?.numerator;
  const d = typeof value === "number" ? 1 : value?.denominator;
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(d) || d <= 0)
    throw failure(
      "INVALID_REQUEST",
      "Word coordinates must be exact nonnegative rational microseconds",
    );
  return [BigInt(n), BigInt(d)];
};
const gapCompare = (start, end, us) => {
  const [sn, sd] = time(start),
    [en, ed] = time(end);
  const actual = sn * ed - en * sd,
    expected = BigInt(us) * sd * ed;
  return actual < expected ? -1 : actual > expected ? 1 : 0;
};
const gapAtLeast = (start, end, us) => gapCompare(start, end, us) >= 0;
const compare = (a, b) => {
  const [an, ad] = time(a),
    [bn, bd] = time(b);
  return an * bd < bn * ad ? -1 : an * bd > bn * ad ? 1 : 0;
};
const identity = (row) =>
  JSON.stringify([
    row.clipId,
    row.trackId,
    row.assetId,
    row.streamId,
    row.acquisitionId ?? null,
    row.generation,
    row.segment,
  ]);
const start = (row) => row.fragments[0].project.startUs;
const maximumTime = (values) => values.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
const end = (row) => maximumTime(row.fragments.map((fragment) => fragment.project.endUs));
const groupEnd = (words) => maximumTime(words.map((word) => end(word.row)));
function appendLine(currentLines, token, separator, width, hasPrior = false) {
  const current = currentLines.at(-1);
  const candidate = current + (hasPrior ? separator : "") + token;
  const parts = candidate.split("\n");
  if (current && !separator.includes("\n") && length(parts[0]) > width)
    currentLines.push(...((separator.trim() ? separator : "") + token).split("\n"));
  else currentLines.splice(currentLines.length - 1, 1, ...parts);
  const end = currentLines.join("\n").length;
  return [end - token.length, end];
}
const nonempty = (value) => typeof value === "string" && value.length > 0;

/** Pure drafts: no CLI calls, transcript preparation, project mutation or font-fit claim. */
export function captionProposals(request) {
  const entry = request.entry;
  if (!entry || !Array.isArray(entry.rows) || entry.rows.length > 10000)
    throw failure("INVALID_REQUEST", "Supply one compact transcript entry with at most 10000 rows");
  const { rowIndexes } = request;
  if (
    !Array.isArray(rowIndexes) ||
    !rowIndexes.length ||
    rowIndexes.length > 10000 ||
    rowIndexes.some(
      (index, i) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= entry.rows.length ||
        (i && index <= rowIndexes[i - 1]),
    )
  )
    throw failure("INVALID_REQUEST", "Select explicit distinct row indexes in evidence order");
  const constraints = request.constraints;
  if (!constraints || typeof constraints !== "object")
    throw failure("INVALID_REQUEST", "Supply explicit caption constraints");
  const width = budget(constraints.widthGraphemes, undefined, 1, 8192, "widthGraphemes");
  const maxLines = budget(constraints.maxLines, undefined, 1, 32, "maxLines");
  const minimum = budget(constraints.minDwellUs, undefined, 1, 3600000000, "minDwellUs");
  const maximum = budget(constraints.maxDwellUs, undefined, minimum, 3600000000, "maxDwellUs");
  const maxCps = budget(constraints.maxCps, undefined, 1, 1000, "maxCps");
  const pause = budget(constraints.pauseUs, undefined, 1, 3600000000, "pauseUs");
  if (
    typeof constraints.breakOnPunctuation !== "boolean" ||
    typeof constraints.separator !== "string" ||
    constraints.separator.length > 32
  )
    throw failure(
      "INVALID_REQUEST",
      "Choose punctuation breaking and a separator of at most 32 UTF16 units",
    );
  const { style, canvas } = request;
  if (
    !style ||
    !canvas ||
    !nonempty(request.trackId) ||
    !nonempty(style.font?.assetId) ||
    !nonempty(style.font?.postScriptName)
  )
    throw failure(
      "INVALID_REQUEST",
      "Supply a caption track, exact font asset/face, canvas and text style",
    );
  for (const [name, value, limit] of [
    ["canvas.width", canvas.width, 4096],
    ["canvas.height", canvas.height, 4096],
    ["style.width", style.width, 4096],
    ["style.height", style.height, 4096],
  ])
    budget(value, undefined, 1, limit, name);
  if (
    !Number.isFinite(style.size) ||
    style.size <= 0 ||
    style.size > 512 ||
    !/^#[0-9a-f]{8}$/i.test(style.color) ||
    !["left", "center", "right"].includes(style.alignment) ||
    typeof style.wrap !== "boolean"
  )
    throw failure("INVALID_REQUEST", "Supply an admissible explicit text style");
  const area = constraints.safeArea;
  if (
    !area ||
    [area.x, area.y, area.width, area.height].some((value) => !Number.isFinite(value)) ||
    area.width <= 0 ||
    area.height <= 0
  )
    throw failure("INVALID_REQUEST", "Supply a positive finite safe-area rectangle");
  const issues = [];
  const known = new Set([
    "widthGraphemes",
    "maxLines",
    "minDwellUs",
    "maxDwellUs",
    "maxCps",
    "pauseUs",
    "breakOnPunctuation",
    "separator",
    "safeArea",
  ]);
  for (const key of Object.keys(constraints))
    if (!known.has(key))
      issues.push({
        code: "caption-constraint-unsupported",
        message: `Unsupported constraint ${JSON.stringify(key)} was ignored`,
        evidence: { constraint: key },
      });
  // Without project time or the whole pinned entry no draft can exist, so these refuse.
  if (!entry.identity?.projectId || !entry.identity?.revisionId)
    throw failure(
      "INVALID_REQUEST",
      "Captions need a project transcript entry; read the transcript through the project revision",
    );
  if (entry.state !== "ready" || !entry.complete)
    throw failure(
      "NOT_READY",
      `The transcript entry is ${entry.state === "ready" ? "incomplete" : `"${entry.state}"`}; continue the compact transcript until it is complete and ready`,
    );
  const output = {
    version: 1,
    identity: entry.identity,
    rowIndexes,
    constraints,
    proposals: [],
    issues,
  };
  const corrections = new Map();
  for (const correction of request.corrections ?? []) {
    if (
      !rowIndexes.includes(correction.rowIndex) ||
      corrections.has(correction.rowIndex) ||
      typeof correction.text !== "string" ||
      correction.text.length > 8192
    )
      throw failure(
        "INVALID_REQUEST",
        "Corrections must name unique selected word rows and preserve bounded display text",
      );
    corrections.set(correction.rowIndex, correction.text);
  }
  const selected = rowIndexes.map((index) => {
    const row = entry.rows[index];
    if (
      row.type !== "word" ||
      !nonempty(row.clipId) ||
      !nonempty(row.trackId) ||
      !nonempty(row.assetId) ||
      !nonempty(row.streamId) ||
      !nonempty(row.generation) ||
      !Number.isSafeInteger(row.ordinal) ||
      row.ordinal < 0 ||
      typeof row.text !== "string" ||
      !Array.isArray(row.fragments) ||
      !row.fragments.length
    )
      throw failure(
        "INVALID_REQUEST",
        "Each selected row must be an exact projected word occurrence",
      );
    if (
      !row.sourceRange ||
      (row.instant
        ? compare(row.sourceRange.startUs, row.sourceRange.endUs) !== 0
        : compare(row.sourceRange.startUs, row.sourceRange.endUs) >= 0)
    )
      throw failure(
        "INVALID_REQUEST",
        "Raw word pins must retain positive estimates or exact instant points",
      );
    for (const range of row.fragments.flatMap((fragment) => [fragment.source, fragment.project]))
      if (
        !range ||
        (row.instant
          ? compare(range.startUs, range.endUs) !== 0
          : compare(range.startUs, range.endUs) >= 0)
      )
        throw failure(
          "INVALID_REQUEST",
          "Word support must be positive ranges or exact instant points",
        );
    return { index, row, text: corrections.get(index) ?? row.text };
  });
  const groups = [];
  let current = [],
    currentLines = [""];
  for (const word of selected) {
    const prior = current.at(-1);
    const candidateLines = [...currentLines];
    let range = appendLine(
      candidateLines,
      word.text,
      constraints.separator,
      width,
      current.length > 0,
    );
    const pinsFull = current.length === 1000;
    if (
      prior &&
      (pinsFull ||
        word.index !== prior.index + 1 ||
        identity(word.row) !== identity(prior.row) ||
        word.row.instant ||
        prior.row.instant ||
        word.row.partial ||
        prior.row.partial ||
        word.row.fragments.length > 1 ||
        prior.row.fragments.length > 1 ||
        gapAtLeast(start(word.row), groupEnd(current), pause) ||
        (constraints.breakOnPunctuation && sentenceEnd.test(prior.text)) ||
        candidateLines.length > maxLines ||
        gapCompare(groupEnd([...current, word]), start(current[0].row), maximum) > 0)
    ) {
      groups.push({ words: current, lines: currentLines });
      current = [];
      currentLines = [""];
      range = appendLine(currentLines, word.text, constraints.separator, width);
      if (pinsFull)
        issues.push({
          code: "caption-cue-split",
          message: `A cue reached 1000 word pins, so a new cue starts at row ${word.index}`,
          evidence: { maximumWords: 1000, rowIndex: word.index },
        });
    } else currentLines = candidateLines;
    current.push({ ...word, range });
  }
  if (current.length) groups.push({ words: current, lines: currentLines });
  if (groups.length > 1000)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Proposal exceeds 1000 cues; select fewer rows");
  const rect = {
    x: area.x + (area.width - style.width) / 2,
    y: area.y + area.height - style.height,
    width: style.width,
    height: style.height,
  };
  const safe =
    area.x >= 0 &&
    area.y >= 0 &&
    area.x + area.width <= canvas.width &&
    area.y + area.height <= canvas.height &&
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height;
  for (const { words: group, lines: renderedLines } of groups) {
    const first = group[0].row,
      projectEnd = groupEnd(group);
    const text = renderedLines.join("\n");
    const cueIssues = [];
    const unmet = (evidence, message) =>
      cueIssues.push({ code: "caption-constraint-unmet", message, evidence });
    const cue = { startUs: start(first), endUs: projectEnd };
    if (!safe)
      unmet(
        {
          constraint: "safeArea",
          requested: area,
          measured: rect,
          canvas: { width: canvas.width, height: canvas.height },
        },
        "The caption rectangle or safe area leaves the canvas or each other",
      );
    const widest = Math.max(...renderedLines.map(length));
    if (widest > width)
      unmet(
        { constraint: "widthGraphemes", requested: width, measured: widest },
        `A line is ${widest} graphemes wide; ${width} were requested`,
      );
    if (renderedLines.length > maxLines)
      unmet(
        { constraint: "maxLines", requested: maxLines, measured: renderedLines.length },
        `The text has ${renderedLines.length} lines; at most ${maxLines} were requested`,
      );
    if (!style.wrap && renderedLines.length > 1)
      cueIssues.push({
        code: "caption-wrap-disabled",
        message: "The text breaks across lines while the style turns wrapping off",
        evidence: { lines: renderedLines.length },
      });
    if (!text.trim())
      cueIssues.push({
        code: "caption-text-empty",
        message: "The display text is empty",
        evidence: {},
      });
    if (text.length > 8192)
      cueIssues.push({
        code: "caption-text-too-long",
        message: "The display text exceeds the 8192 UTF-16 units a text clip admits",
        evidence: { maximumUTF16Units: 8192, utf16Units: text.length },
      });
    if (!gapAtLeast(projectEnd, start(first), minimum))
      unmet(
        { constraint: "minDwellUs", requested: minimum, cue },
        "The cue is shorter than the minimum dwell",
      );
    if (gapCompare(projectEnd, start(first), maximum) > 0)
      unmet(
        { constraint: "maxDwellUs", requested: maximum, cue },
        "The cue is longer than the maximum dwell",
      );
    const [en, ed] = time(projectEnd),
      [sn, sd] = time(start(first));
    const readingNumerator = BigInt(length(text.replaceAll("\n", ""))) * 1000000n * ed * sd,
      durationNumerator = en * sd - sn * ed;
    if (first.instant)
      cueIssues.push({
        code: "caption-instant-word",
        message: "An instant word has no dwell or reading speed, so no clip was drafted",
        evidence: { rowIndex: group[0].index },
      });
    else if (readingNumerator > BigInt(maxCps) * durationNumerator) {
      const measured = Number(readingNumerator) / Number(durationNumerator);
      unmet(
        { constraint: "maxCps", requested: maxCps, measured },
        `The cue reads at ${measured} characters per second; at most ${maxCps} were requested`,
      );
    }
    for (const word of group) {
      if (word.row.partial)
        cueIssues.push({
          code: "caption-word-partial",
          message: `Row ${word.index} is only partly inside its clip`,
          evidence: { rowIndex: word.index },
        });
      if (word.row.fragments.length > 1)
        cueIssues.push({
          code: "caption-word-discontinuous",
          message: `Row ${word.index} plays in ${word.row.fragments.length} project fragments`,
          evidence: { rowIndex: word.index, fragments: word.row.fragments.length },
        });
    }
    output.proposals.push({
      rowIndexes: group.map((word) => word.index),
      words: group.map((word) => word.row),
      text,
      projectFragments: group.flatMap((word) =>
        word.row.fragments.map((fragment) => ({ rowIndex: word.index, ...fragment })),
      ),
      clip: first.instant
        ? null
        : {
            trackId: request.trackId,
            source: (() => {
              const { size, ...publicStyle } = style;
              return {
              ...publicStyle,
              sizePx: size,
              kind: "text",
              text,
              ...(style.highlight
                ? {
                    timedWords: group.flatMap(({ row, range }) =>
                      range[0] === range[1]
                        ? []
                        : row.fragments.map(({ source }) => ({ range, sourceRange: source })),
                    ),
                  }
                : {}),
              };
            })(),
            seed: {
              kind: "transcript",
              source: {
                assetId: first.assetId,
                streamId: first.streamId,
                ...(first.acquisitionId ? { acquisitionId: first.acquisitionId } : {}),
              },
              generation: first.generation,
              occurrenceClipId: first.clipId,
              words: group.map(({ row }) => ({
                ordinal: row.ordinal,
                sourceRange: row.sourceRange,
              })),
            },
            placement: {
              kind: "content",
              clipId: first.clipId,
              sourceRange: {
                startUs: first.fragments[0].source.startUs,
                endUs: maximumTime(
                  group.flatMap((word) =>
                    word.row.fragments.map((fragment) => fragment.source.endUs),
                  ),
                ),
              },
            },
          },
      geometry: {
        processor: {
          type: "geometry",
          crop: { x: 0, y: 0, width: style.width, height: style.height },
          rect,
          fit: "contain",
          scale: { x: 1, y: 1 },
          rotationDeg: 0,
          pivot: { x: 0.5, y: 0.5 },
        },
      },
      issues: boundedIssues(cueIssues),
    });
  }
  output.issues = boundedIssues(issues);
  const maxBytes = budget(request.maxBytes, 1024 * 1024, 1024, 8 * 1024 * 1024, "maxBytes");
  if (Buffer.byteLength(JSON.stringify(output) + "\n") > maxBytes)
    throw failure(
      "OUTPUT_BUDGET_EXCEEDED",
      "Pinned caption proposals exceed maxBytes; select fewer rows or increase the budget",
    );
  return output;
}

if (launchedAs(import.meta.url, "caption-proposals.mjs")) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node caption-proposals.mjs < request.json\nPure caption drafts from one complete pinned compact-transcript entry, explicit rowIndexes/corrections, caption track, canvas, text style and constraints. Constraints: widthGraphemes, maxLines, minDwellUs/maxDwellUs, maxCps, pauseUs, breakOnPunctuation, separator, safeArea {x,y,width,height}; optional maxBytes. Returns ordinary text clip/geometry drafts and exact word pins/fragments, with Yap issues at two levels: the output's issues (unsupported constraints, cues split at the 1000-word seed pin limit) and each proposal's (caption-constraint-unmet naming the request key with requested/measured values, wrapping off, empty or over-long text, instant, partial or discontinuous words), each list bounded at 1000. A source-only entry refuses INVALID_REQUEST; an incomplete or unready one refuses NOT_READY. Explicit style.highlight {activeColor,inactiveColor} emits corrected display UTF16 timedWords mapped to retained source fragments; empty corrections have no run. Instant points retain evidence with clip:null and caption-instant-word. Never calls CLI, transcribes or applies edits. Drafts are never pixel-checked: glyph fit, clipping and legibility need explicit application and actual frame.get inspection.",
    );
  else await runJsonHelper(captionProposals);
}
