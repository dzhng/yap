import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { JourneyService } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    home: { type: "string" },
    asset: { type: "string" },
    expected: { type: "string" },
  },
});
assert.ok(values.out && values.home && values.asset && values.expected);
const out = resolve(values.out);
await mkdir(out);
const report = { passed: false, trace: [], pages: [] };
const expected = JSON.parse(gunzipSync(await readFile(resolve(values.expected))));
const service = new JourneyService(resolve(values.home), report);
try {
  await service.start();
  const headers = await service.call("asset.get", { assetId: values.asset });
  await writeFile(join(out, "headers.json"), JSON.stringify(headers, null, 2));
  assert.equal(headers.originUs, expected.originUs);
  // The expected file is the stored asset record, whose streams keep their internal `id`.
  assert.deepEqual(
    headers.streams,
    expected.streams.map(({ segments, id, ...stream }) => ({
      ...stream,
      streamId: id,
      segmentCount: segments?.length ?? 0,
    })),
  );
  const started = performance.now();
  for (const stream of expected.streams) {
    let cursor,
      count = 0,
      pageIndex = 0;
    do {
      const transport = pageIndex++ % 2 ? "cli" : "mcp",
        before = performance.now();
      const page = await service.call(
        "asset.segments",
        {
          assetId: values.asset,
          streamId: stream.id,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        },
        { transport },
      );
      report.pages.push({
        streamId: stream.id,
        afterOrdinal: count - 1,
        count: page.segments.length,
        transport,
        milliseconds: performance.now() - before,
      });
      await appendFile(join(out, "pages.jsonl"), JSON.stringify(page) + "\n");
      assert.equal(page.assetId, values.asset);
      assert.equal(page.streamId, stream.id);
      assert.deepEqual(
        page.segments,
        (stream.segments ?? [])
          .slice(count, count + 1000)
          .map((row, i) => ({ ordinal: count + i, ...row })),
      );
      count += page.segments.length;
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(count, stream.segments?.length ?? 0);
  }
  report.traversalSeconds = (performance.now() - started) / 1000;
  report.maximumPageMilliseconds = Math.max(...report.pages.map((page) => page.milliseconds));
  report.clientMaxRSSKiB = process.resourceUsage().maxRSS;
  const invalid = await service.call(
    "asset.segments",
    {
      assetId: values.asset,
      streamId: expected.streams[0].id,
      cursor: "not-a-cursor-this-service-issued",
    },
    { error: true },
  );
  assert.equal(invalid.code, "INVALID_PARAMS");
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
