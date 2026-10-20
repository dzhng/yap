import { expect, it } from "vitest";
import { JsonLineReader, JsonLineStream, encodeJsonLine, type JsonLineOutcome } from "./framing.js";
import { JOURNAL_RECORD_BYTES } from "./requirements.js";

it("decodes a UTF-8 character split across incoming chunks without replacing it", () => {
  const frame = encodeJsonLine({ text: "A🙂B" }, 100);
  const split = frame.indexOf(Buffer.from("🙂")) + 2;
  const reader = new JsonLineReader(100);
  reader.push(frame.subarray(0, split));
  reader.push(frame.subarray(split));
  expect(reader.finish()).toEqual({ text: "A🙂B" });
});

it("rejects undefined request fields instead of silently deleting them on the wire", () => {
  expect(() =>
    encodeJsonLine({ operation: "edit.cut", params: { expectedRevisionId: undefined } }, 1000),
  ).toThrow();
});

function read(stream: JsonLineStream, ...chunks: (string | Buffer)[]): JsonLineOutcome[] {
  return chunks.flatMap((chunk) =>
    stream.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
  );
}

it("reassembles a pipe frame split across chunks and keeps later frames separate", () => {
  const stream = new JsonLineStream(1024);
  expect(read(stream, '{"event":"star')).toEqual([]);
  expect(read(stream, 'ted","pid":7}\n{"event":"r')).toEqual([
    { ok: true, value: { event: "started", pid: 7 } },
  ]);
  expect(read(stream, 'esult"}\n{"a":1}\n')).toEqual([
    { ok: true, value: { event: "result" } },
    { ok: true, value: { a: 1 } },
  ]);
});

it("decodes a UTF-8 character split across pipe chunks without replacing it", () => {
  const stream = new JsonLineStream(1024);
  const encoded = Buffer.from('{"message":"naïve"}\n');
  const split = encoded.indexOf(0xc3) + 1;
  expect(read(stream, encoded.subarray(0, split), encoded.subarray(split))).toEqual([
    { ok: true, value: { message: "naïve" } },
  ]);
});

it("reports an unreadable frame and still delivers the next one", () => {
  const stream = new JsonLineStream(1024);
  const outcomes = read(stream, '{\n{"ok":true}\n');
  expect(outcomes[0]).toMatchObject({ ok: false, error: { code: "MALFORMED_FRAME" } });
  expect(outcomes[1]).toEqual({ ok: true, value: { ok: true } });
});

it("reports an oversized frame once and resynchronizes at the next terminator", () => {
  const stream = new JsonLineStream(64);
  const outcomes = read(stream, `{"padding":"${"x".repeat(200)}`, `"}\n{"next":true}\n`);
  expect(outcomes).toEqual([
    { ok: false, error: expect.objectContaining({ code: "FRAME_TOO_LARGE" }) },
    { ok: true, value: { next: true } },
  ]);
});

it("reports a stream that ends mid-frame instead of silently dropping it", () => {
  const stream = new JsonLineStream(1024);
  expect(stream.finish()).toBeUndefined();
  read(stream, '{"partial":');
  expect(stream.finish()).toMatchObject({ code: "TRUNCATED_FRAME" });
});

it("admits the derived record bound across small chunks and rejects one extra UTF-8 byte", () => {
  const value = "é".repeat((JOURNAL_RECORD_BYTES - 2) / 2);
  const frame = Buffer.from(JSON.stringify(value) + "\n");
  const stream = new JsonLineStream(JOURNAL_RECORD_BYTES + 1);
  const outcomes: JsonLineOutcome[] = [];
  for (let start = 0; start < frame.length; start += 16384)
    outcomes.push(...stream.push(frame.subarray(start, start + 16384)));
  expect(outcomes).toEqual([{ ok: true, value }]);
  expect(stream.finish()).toBeUndefined();
  const oversized = new JsonLineStream(JOURNAL_RECORD_BYTES + 1);
  expect(read(oversized, JSON.stringify(value + "x") + "\n")).toEqual([
    { ok: false, error: expect.objectContaining({ code: "FRAME_TOO_LARGE" }) },
  ]);
});
