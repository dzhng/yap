import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { poll, root } from "./source-evidence-fixture.mjs";

/** The expected cuts come from the placement requests, never a returned composition. */
export async function reorderQuery({ service, save, result, apply, selection, authored, asset }) {
  const client = new Client({ name: "scale-reorder-query", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "apps/cli/dist/main.js"), "mcp", "--socket", service.socketPath],
        stderr: "pipe",
      }),
    );
    const range = { startUs: 6499899678, endUs: 7199000000 };
    const query = async (revisionId) => {
      const rows = [];
      let cursor,
        calls = 0;
      do {
        const page = await poll(
          async () => {
            const reply = await client.callTool({
              name: "timeline.events",
              arguments: {
                projectId: selection.projectId,
                revisionId,
                range,
                limit: 250 - rows.length,
                ...(cursor ? { cursor } : {}),
              },
            });
            assert.equal(reply.structuredContent?.ok, true, JSON.stringify(reply));
            return reply.structuredContent.data;
          },
          (v) => v.state === "ready",
          "reorder cut page",
        );
        rows.push(...page.page.rows);
        cursor = page.page.nextCursor;
        assert.ok(++calls <= 100, "Bounded source paging must make progress toward 250 rows");
      } while (rows.length < 250 && cursor);
      assert.equal(rows.length, 250);
      return { rows, calls };
    };
    const expected = (clips) =>
      clips
        .flatMap((clip) => {
          const side = (sourceAtUs) => ({
            clipId: clip.clipId,
            kind: "range",
            assetId: asset.id,
            streamId: asset.streams[0].streamId,
            sourceAtUs,
            rate: 1,
          });
          return [
            {
              kind: "cut",
              projectAtUs: clip.startUs,
              trackId: clip.trackId,
              trackRank: clip.trackRank,
              mediaKind: "audio",
              before: null,
              after: side(0),
            },
            {
              kind: "cut",
              projectAtUs: clip.endUs,
              trackId: clip.trackId,
              trackRank: clip.trackRank,
              mediaKind: "audio",
              before: side(clip.endUs - clip.startUs),
              after: null,
            },
          ];
        })
        .filter((row) => row.projectAtUs >= range.startUs && row.projectAtUs < range.endUs)
        .sort((a, b) => a.projectAtUs - b.projectAtUs || a.trackRank - b.trackRank)
        .slice(0, 250);
    const beforeExpected = expected(authored);
    const before = await query(selection.revisionId);
    await save("reorder-before.json", { expected: beforeExpected, actual: before });
    assert.deepEqual(before.rows, beforeExpected);
    // Different tracks leave both intermediate moves valid, without ripple or temporary clips.
    const left = authored[9032],
      right = authored[9067];
    assert.equal(left.endUs - left.startUs, right.endUs - right.startUs);
    const changed = authored.map((clip) =>
      clip === left
        ? { ...clip, startUs: right.startUs, endUs: right.endUs }
        : clip === right
          ? { ...clip, startUs: left.startUs, endUs: left.endUs }
          : clip,
    );
    const afterExpected = expected(changed);
    const moved = await apply(
      [
        {
          operation: "move",
          clipIds: [left.clipId],
          atUs: right.startUs,
          ripple: "none",
          scope: "selected",
        },
        {
          operation: "move",
          clipIds: [right.clipId],
          atUs: left.startUs,
          ripple: "none",
          scope: "selected",
        },
      ],
      "reorder",
    );
    const after = await query(moved.revision.revisionId);
    await save("reorder-after.json", { expected: afterExpected, actual: after });
    assert.deepEqual(after.rows, afterExpected);
    const old = await query(selection.revisionId);
    await save("reorder-pinned-old.json", { expected: beforeExpected, actual: old });
    assert.deepEqual(old.rows, beforeExpected);
    // Bounded private controls demonstrate that stale data and wrong authored time both fail.
    assert.throws(() => assert.deepEqual(before.rows, afterExpected), { code: "ERR_ASSERTION" });
    const wrongPosition = structuredClone(after.rows);
    wrongPosition.find((row) => row.after?.clipId === left.clipId).projectAtUs++;
    await save("reorder-negative-controls.json", {
      stale: before.rows,
      wrongPosition,
      expected: afterExpected,
    });
    assert.throws(() => assert.deepEqual(wrongPosition, afterExpected), { code: "ERR_ASSERTION" });
    const samples = [];
    for (let n = 0; n < 20; n++) {
      const started = performance.now();
      const repeated = await query(moved.revision.revisionId);
      samples.push(performance.now() - started);
      assert.deepEqual(repeated.rows, afterExpected);
    }
    const p95Ms = [...samples].sort((a, b) => a - b)[18];
    const undone = await service.call("edit.undo", {
      projectId: selection.projectId,
      expectedRevisionId: moved.revision.revisionId,
      requestId: "reorder-undo",
    });
    const restored = await query(undone.id);
    await save("reorder-undo.json", { expected: beforeExpected, actual: restored });
    assert.deepEqual(restored.rows, beforeExpected);
    result.inspection = {
      samples,
      p95Ms,
      rows: 250,
      callsPerSample: after.calls,
      withinBudget: p95Ms <= 250,
      defaultMcpReceiveBuffer: true,
    };
    result.reorder = {
      range,
      before: selection.revisionId,
      after: moved.revision.revisionId,
      undo: undone.id,
      clips: [left, right],
      staleRevisionControlRejected: true,
      wrongPositionControlRejected: true,
    };
  } finally {
    await client.close();
  }
}
