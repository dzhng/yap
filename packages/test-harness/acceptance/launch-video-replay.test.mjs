import assert from "node:assert/strict";
import test from "node:test";
import { countSession, editingEnds } from "./launch-video-replay.mjs";

const session = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const bash = (id, command) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const write = (id) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Write", input: { content: "" } }] },
});
const result = (id, content) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const said = (text) => ({ type: "user", message: { content: text } });

test("refusals count tool results by code or message, not files the agent wrote", () => {
  const counts = countSession(
    session(
      bash("a", "yap transcript.review --params '{\"sourceRange\":{}}'"),
      result(
        "a",
        '"errorCode": "TRANSCRIPT_BOUNDARY_DISAGREEMENT" ... TRANSCRIPT_BOUNDARY_DISAGREEMENT',
      ),
      bash("b", "yap audio.measure"),
      result("b", [
        {
          type: "text",
          text: "The complete treated signal misses the requested normalization targets",
        },
      ]),
      write("c"),
      result("c", "TRANSCRIPT_BOUNDARY_DISAGREEMENT in feedback.md"),
    ),
  );
  assert.deepEqual(counts.refusals.seam_disagreement, { results: 1, occurrences: 2 });
  assert.deepEqual(counts.refusals.normalization_unmet, { results: 1, occurrences: 1 });
  assert.equal(counts.effort.chunked_transcription, 1);
  assert.equal(counts.effort.measure_calls, 1);
  assert.equal(counts.ended, false);
});

test("a cross-correlation script counts as correlation, not as RMS outside Yap", () => {
  const counts = countSession(
    session(
      bash(
        "a",
        "cat > /tmp/s-xcorr.mjs <<'EOF'\nconst r=Math.sqrt(e1*e2); x[i]=b.readFloatLE(o)\nEOF\nnode /tmp/s-xcorr.mjs",
      ),
    ),
  );
  assert.equal(counts.effort.cross_correlation, 1);
  assert.equal(counts.effort.rms_outside_yap, 0);
});

test("counting stops where the editing phase ends", () => {
  const counts = countSession(
    session(
      bash("a", "python3 - <<EOF\nfor lag in range(-9,9): pass\nEOF"),
      bash("b", "python3 -c \"a=array.array('h'); print(math.sqrt(sum(x*x for x in a)))\""),
      said(`${editingEnds}, good job`),
      bash("c", "python3 sync/xc.py a b"),
      result("c", "NORMALIZATION_NOT_FEASIBLE"),
    ),
  );
  assert.equal(counts.ended, true);
  assert.equal(counts.effort.cross_correlation, 1);
  assert.equal(counts.effort.rms_outside_yap, 1);
  assert.deepEqual(counts.refusals.normalization_infeasible, { results: 0, occurrences: 0 });
});
