import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleStills } from "../skills/storyboard/scripts/sample-stills.mjs";

// A stand-in for the yap launcher: answers frame.batch like the service, writing one file per
// requested instant into --output, and counts its calls.
async function fakeYap(t) {
  const directory = await mkdtemp(join(tmpdir(), "yap-storyboard-stills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "yap");
  await writeFile(
    executable,
    `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
let text = "";
process.stdin.on("data", (c) => (text += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const params = JSON.parse(text);
  appendFileSync(${JSON.stringify(join(directory, "calls"))}, args[0] + "\\n");
  const out = args[args.indexOf("--output") + 1];
  mkdirSync(out);
  const items = params.atUs.map((atUs, i) => {
    if (atUs === 6000000) return { ok: false, atUs, error: { code: "FRAME_FAILED" } };
    const file = join(out, String(i + 1).padStart(2, "0") + ".png");
    writeFileSync(file, "png");
    return { ok: true, atUs, data: { state: "ready", output: file, published: { output: {
      width: 960, height: 540, sourceWidth: 3840, sourceHeight: 2160, actualSourceUs: atUs - 1,
      faceObservations: { status: "available", faces: [{ boundingBox: { x: 100, y: 50, width: 25, height: 30 }, confidence: 0.9 }] },
    } } } };
  });
  console.log(JSON.stringify({ ok: true, data: { items } }));
});
`,
    { mode: 0o755 },
  );
  const calls = async () =>
    (await readFile(join(directory, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { directory, executable, calls };
}

test("samples stills in batches of eight with face boxes in source pixels and reuses saved batches", async (t) => {
  const { directory, executable, calls } = await fakeYap(t);
  const request = {
    assetId: "asset-1",
    streamId: "track:1",
    ranges: [{ startUs: 0, endUs: 20_000_000 }],
    stepUs: 2_000_000,
    out: join(directory, "stills"),
    cli: { executable },
  };
  const first = await sampleStills(request);
  assert.equal(first.fetchedBatches, 2);
  const manifest = JSON.parse(await readFile(first.manifest, "utf8"));
  assert.deepEqual(manifest.source, {
    assetId: "asset-1",
    streamId: "track:1",
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(
    manifest.stills.map((still) => still.atUs),
    [0, 2, 4, 8, 10, 12, 14, 16, 18].map((s) => s * 1_000_000),
  );
  assert.deepEqual(manifest.stills[0].faces, [
    { x: 400, y: 200, width: 100, height: 120, confidence: 0.9 },
  ]);
  assert.deepEqual(
    first.issues.map((issue) => [issue.code, issue.evidence.atUs]),
    [["still-unavailable", 6_000_000]],
  );
  assert.equal(await readFile(manifest.stills[0].file, "utf8"), "png");

  const second = await sampleStills(request);
  assert.equal(second.fetchedBatches, 0);
  assert.deepEqual(await calls(), ["frame.batch", "frame.batch"]);
});
