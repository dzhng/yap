import { mkdtemp, writeFile, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonDescriptor } from "./json-stream.js";
import { boundSourceEvidenceResponse } from "./capture-source-read.js";
import { JOURNAL_RECORD_BYTES, RESPONSE_PAGE_BYTES } from "@yap/protocol";
import { expect, test, vi } from "vitest";
import { fstatSync } from "node:fs";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fstatSync: vi.fn(fs.fstatSync) };
});
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

test("JSON descriptor parsing rejects malformed JSON and nonregular descriptors", async () => {
  const root = await mkdtemp("/tmp/json-descriptor-");
  try {
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, '{"broken":');
    const malformedFile = await open(malformed, "r");
    try {
      expect(() => readJsonDescriptor(malformedFile.fd)).toThrow(SyntaxError);
    } finally {
      await malformedFile.close();
    }

    const changedFile = await open(root, "r");
    try {
      expect(() => readJsonDescriptor(changedFile.fd)).toThrow(SyntaxError);
    } finally {
      await changedFile.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changing JSON inventory keeps its size-change diagnostic", async () => {
  const root = await mkdtemp("/tmp/json-changing-");
  const path = join(root, "inventory.json");
  await writeFile(path, "{}");
  const file = await open(path, "r");
  const stat = fstatSync(file.fd);
  vi.mocked(fstatSync)
    .mockReturnValueOnce(stat)
    .mockReturnValueOnce({ ...stat, size: stat.size + 1 });
  try {
    expect(() => readJsonDescriptor(file.fd)).toThrow(
      new SyntaxError("JSON inventory changed during read"),
    );
  } finally {
    vi.mocked(fstatSync).mockClear();
    await file.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("transport pages admit a maximum journal record and respect envelope headroom", () => {
  expect(() =>
    boundSourceEvidenceResponse({ rows: [{ content: "x".repeat(JOURNAL_RECORD_BYTES) }] }),
  ).not.toThrow();
  const page = { content: "x".repeat(RESPONSE_PAGE_BYTES - 100) };
  expect(() => boundSourceEvidenceResponse(page)).not.toThrow();
  expect(() => boundSourceEvidenceResponse({ ...page, extra: "x".repeat(100) })).toThrowError(
    expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
  );
});
