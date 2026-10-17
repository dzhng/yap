import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { prepareLayersFixture } from "./layers-fixture.mjs";
const out = resolve(process.argv[2] ?? "");
const historicalParity = process.argv.includes("--historical-parity");
assert.ok(process.argv[2] && process.env.YAP_NATIVE);
if (historicalParity)
  assert.ok(process.env.YAP_BASELINE_NATIVE, "Historical parity requires the retired worker");
await mkdir(out);
const home = join(out, "fixture"),
  refs = join(out, "references");
await mkdir(home);
await mkdir(refs);
const { media, pixelTool } = await prepareLayersFixture(home, refs);
const run = (binary, args, input) => {
  const r = spawnSync(binary, args, { input, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout;
};
const call = (binary, operation, params) => {
  const r = JSON.parse(
    run(binary, [], JSON.stringify({ id: "display", operation, params }) + "\n"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
};
const oblique = join(home, "oblique.mov");
run(join(home, "orientation-fixture"), [media.screen.path, oblique, "33"]);
const rows = [];
for (const [name, path, width, height, background, extent] of [
  ["identity", media.screen.path, 64, 48, "#000000ff", [64, 48]],
  ["quarter-turn", media.rotated.path, 48, 64, "#000000ff", [48, 64]],
  ["oblique", oblique, 64, 48, "#000000ff", [81, 76]],
  ["white-control", media.plate.path, 64, 48, "#ffffffff", [16, 16]],
]) {
  const directory = join(out, name);
  await mkdir(directory);
  const probe = call(process.env.YAP_NATIVE, "media.probe", { path }),
    stream = probe.streams.find((s) => s.kind === "video");
  assert.deepEqual([stream.orientedWidth, stream.orientedHeight], extent);
  const asset = {
    id: "source",
    streams: [
      {
        id: stream.id,
        kind: "video",
        width: stream.orientedWidth,
        height: stream.orientedHeight,
        pixelBounds: stream.orientedPixelBounds,
        bounds: { startUs: 0, endUs: 1000000 },
        available: [{ startUs: 0, endUs: 1000000 }],
      },
    ],
  };
  const canvas = { width, height, background, fps: { numerator: 10, denominator: 1 } };
  const document = {
    canvas,
    tracks: [{ id: "v", kind: "video", order: 0 }],
    groups: [],
    clips: [
      {
        id: "picture",
        trackId: "v",
        assetId: asset.id,
        streamId: stream.id,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      },
    ],
    processing: [],
    syncGroups: [],
  };
  const window = createCompiler(
    validateComposition(document, [asset]),
    "source-display",
  ).videoWindow({
    range: { startUs: 0, endUs: 1 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const params = {
    canvas,
    frame: [...window.frames()][0],
    processing: window.processing(),
    assets: [{ assetId: "source", streamId: stream.id, path, originUs: probe.originUs }],
    profile: "h264-rec709",
  };
  const pixels = {},
    receipts = {};
  for (const [label, binary] of [
    ...(historicalParity ? [["before", process.env.YAP_BASELINE_NATIVE]] : []),
    ["after", process.env.YAP_NATIVE],
  ]) {
    const request = structuredClone(params);
    request.output = join(directory, label + ".png");
    // Only the frozen historical executable receives its former compiled wire format.
    if (label === "before") {
      delete request.frame.visual;
      request.frame.layers.forEach((l) => {
        delete l.width;
        delete l.height;
        l.placement = "contain";
      });
    }
    receipts[label] = call(binary, "media.renderCompositionFrame", request);
    run(pixelTool, [request.output, request.output + ".rgba"]);
    pixels[label] = await readFile(request.output + ".rgba");
  }
  const changed = [];
  let maximum = 0,
    interiorMaximum = 0,
    interiors = 0;
  if (historicalParity)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        let error = 0,
          uniform = x >= 2 && y >= 2 && x < width - 2 && y < height - 2;
        for (let c = 0; c < 4; c++)
          error = Math.max(error, Math.abs(pixels.before[at + c] - pixels.after[at + c]));
        maximum = Math.max(maximum, error);
        if (error) changed.push({ x, y, error });
        if (uniform)
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
              for (let c = 0; c < 4; c++)
                if (
                  Math.abs(
                    pixels.before[((y + dy) * width + x + dx) * 4 + c] - pixels.before[at + c],
                  ) > 2
                )
                  uniform = false;
        if (uniform) {
          interiors++;
          interiorMaximum = Math.max(interiorMaximum, error);
        }
      }
  const row = {
    name,
    probe,
    receipts,
    historicalParity,
    changed: historicalParity ? changed.length : null,
    maximum: historicalParity ? maximum : null,
    interiors: historicalParity ? interiors : null,
    interiorMaximum: historicalParity ? interiorMaximum : null,
  };
  await writeFile(join(directory, "changed-pixels.json"), JSON.stringify(changed));
  rows.push(row);
  await writeFile(join(out, "report.json"), JSON.stringify(rows, null, 2));
  if (historicalParity && name !== "white-control")
    assert.deepEqual(
      await readFile(receipts.after.file),
      await readFile(receipts.before.file),
      "Source/orientation PNG parity",
    );
  if (name === "white-control") {
    if (historicalParity)
      assert.ok(Math.min(...pixels.before) < 240, "Control did not reproduce incumbent fringe");
    assert.ok(Math.min(...pixels.after) >= 253, "White over white gained a dark fringe");
  }
  if (historicalParity && name === "oblique")
    assert.ok(interiorMaximum <= 2, "Source correction changed a stable interior");
  console.log(
    JSON.stringify({
      name,
      historicalParity,
      changed: row.changed,
      maximum: row.maximum,
      interiors: row.interiors,
      interiorMaximum: row.interiorMaximum,
    }),
  );
}
