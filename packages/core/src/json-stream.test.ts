import { expect, test } from "vitest";
import { jsonChunks, readJsonChunks } from "./json-stream.js";

test("metadata JSON survives split UTF-8, escapes and independently serialized inventory entries", () => {
  const value = {
    inventory: [
      { path: 'é/"a', bytes: 43_200_000_000 },
      { path: "b", bytes: 1 },
    ],
    metadata: null,
  };
  const data = Buffer.from([...jsonChunks(value)].join(""));
  expect(readJsonChunks(Array.from(data, (byte) => Uint8Array.of(byte)))).toEqual(value);
  expect(() => readJsonChunks([Uint8Array.of(34, 0xff, 34)])).toThrow();
  for (const text of ['{"inventory":[1,', '{"a":1} {"a":2}', '{"a":"unterminated'])
    expect(() => readJsonChunks([Buffer.from(text)])).toThrow();
});
