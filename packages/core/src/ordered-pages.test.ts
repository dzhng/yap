import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  OrderedPages,
  readOrderedPageManifest,
  writeOrderedPages,
  type OrderedPageCodec,
} from "./ordered-pages.js";

test("portable pages advance through a complete 7,416,000-byte row without making large batches", async () => {
  const root = await mkdtemp("/tmp/portable-record-");
  try {
    const schema = z.strictObject({ key: z.number(), content: z.string() });
    const codec: OrderedPageCodec<z.infer<typeof schema>, null> = {
      metadata: z.null(),
      orders: { rows: 1 },
      decode: (row) => schema.parse(row),
      key: (row) => [row.key],
    };
    const allowance = 7_416_000;
    const overhead = Buffer.byteLength(JSON.stringify({ key: 1, content: "" }));
    const content =
      '"'.repeat(Math.floor((allowance - overhead) / 2)) + "x".repeat((allowance - overhead) % 2);
    const rows = [
      { key: 1, content },
      { key: 2, content: "next" },
    ];
    expect(Buffer.byteLength(JSON.stringify(rows[0]))).toBe(allowance);
    const directory = join(root, "pages");
    await writeOrderedPages(directory, null, codec, () => [rows]);
    const manifest = readOrderedPageManifest(directory);
    expect(manifest.indexes.rows!.map((page) => [page.rows, page.bytes])).toEqual([
      [1, allowance + 2],
      [1, Buffer.byteLength(JSON.stringify([rows[1]]))],
    ]);
    expect((await readFile(join(directory, "1.json"))).length).toBe(allowance + 2);
    const reader = new OrderedPages(directory, codec);
    expect(reader.read({ index: "rows", limit: 1 })).toEqual([rows[0]]);
    expect(reader.read({ index: "rows", lower: { key: [1], inclusive: false }, limit: 1 })).toEqual(
      [rows[1]],
    );
    await expect(
      writeOrderedPages(join(root, "oversized"), null, codec, () => [
        [{ key: 1, content: content + "x" }],
      ]),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
