// Counts the launch-video baseline's product refusals and effort signals in a Claude Code session
// transcript (JSONL), up to the message that ends the editing phase. Refusals match tool results
// only; effort signals match the agent's shell commands. Usage:
//   node launch-video-replay.mjs <session.jsonl>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const editingEnds = "I already launched with the video you exported";

/** By code or message text: an issue written into a file the agent authored is not a refusal. */
export const refusals = {
  seam_disagreement:
    /TRANSCRIPT_BOUNDARY_DISAGREEMENT|has no unique mandatory shared-context correspondence/g,
  speech_timing_overrun: /INVALID_SPEECH_TIMING|exceeds (?:its |the )?(?:decoded )?interval/g,
  normalization_infeasible:
    /NORMALIZATION_NOT_FEASIBLE|Gain-only treatment cannot meet the requested range or peak ceiling/g,
  normalization_unmet: /NORMALIZATION_TARGETS_UNMET|misses the requested normalization targets/g,
  curve_clock_error: /Processing curve must match its clock/g,
  source_bounds_error: /Selected range exceeds source bounds/g,
  render_range_job_fail: /Rendering requires a nonempty range within the pinned project/g,
};

const decodesPcm =
  /frombuffer|array\.array\(|array\('[hf]'\)|struct\.unpack|readFloatLE|readInt16LE/;
const correlates = /\bfor lag\b|correlat|\bxc(?:orr)?\.(?:py|m?js)\b/i;
export const effort = {
  transcript_calls: (command) => /\btranscript\.(?:prepare|review)\b/.test(command),
  chunked_transcription: (command) =>
    /\btranscript\.(?:prepare|review)\b/.test(command) && /sourceRange/.test(command),
  measure_calls: (command) => /\baudio\.measure\b/.test(command),
  cross_correlation: (command) => correlates.test(command),
  // A correlation score also uses sqrt; only level arithmetic counts here.
  rms_outside_yap: (command) =>
    decodesPcm.test(command) && /sqrt/.test(command) && !correlates.test(command),
};

const texts = (content) =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((block) => block.type === "text").map((block) => block.text)
      : [];

export function countSession(jsonl) {
  const counts = {
    refusals: Object.fromEntries(
      Object.keys(refusals).map((key) => [key, { results: 0, occurrences: 0 }]),
    ),
    effort: Object.fromEntries(Object.keys(effort).map((key) => [key, 0])),
    ended: false,
  };
  const tools = new Map();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    const content = entry.message?.content;
    if (entry.type === "user" && texts(content).some((text) => text.includes(editingEnds))) {
      counts.ended = true;
      break;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (entry.type === "assistant" && block.type === "tool_use") {
        tools.set(block.id, block.name);
        if (block.name !== "Bash") continue;
        const command = block.input?.command ?? "";
        for (const [key, test] of Object.entries(effort)) if (test(command)) counts.effort[key]++;
      }
      if (entry.type === "user" && block.type === "tool_result") {
        if (/^(?:Write|Edit|Read|NotebookEdit)$/.test(tools.get(block.tool_use_id) ?? "")) continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((part) => part.text ?? "").join("\n");
        for (const [key, pattern] of Object.entries(refusals)) {
          const found = text.match(pattern)?.length ?? 0;
          if (!found) continue;
          counts.refusals[key].results++;
          counts.refusals[key].occurrences += found;
        }
      }
    }
  }
  return counts;
}

export function report(counts) {
  const rows = [
    "  signature                  results  occurrences",
    ...Object.entries(counts.refusals).map(
      ([key, value]) =>
        `  ${key.padEnd(26)} ${String(value.results).padStart(7)}  ${value.occurrences}`,
    ),
    "  effort signal              commands",
    ...Object.entries(counts.effort).map(
      ([key, value]) => `  ${key.padEnd(26)} ${String(value).padStart(8)}`,
    ),
  ];
  if (!counts.ended) rows.push(`  (the session never reached "${editingEnds}")`);
  return rows.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: launch-video-replay.mjs <session.jsonl>");
  console.log(report(countSession(readFileSync(process.argv[2], "utf8"))));
}
