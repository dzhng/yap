import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createCompiler,
  resolveOutputSettings,
  validateComposition,
} from "../../composition/dist/index.js";
import {
  blendPixel,
  blendScenarios,
  compareBlendRaster,
  verifyBlendMovieSupport,
  selectBlendCases,
  verifyBlendReferenceIdentity,
} from "./blend-reference.mjs";
import { verifyPicturePixels } from "./decoded-picture-proof.mjs";

if (process.argv.includes("--help")) {
  console.log(
    "YAP_NATIVE=/absolute/frozen/worker node blend-sheet.mjs EMPTY_OUTPUT_DIRECTORY\nBuild composition first. Exercises authored color/alpha sheets and a vignette through the public compiler and native frame/movie operations; does not exercise CLI admission.",
  );
  process.exit(0);
}
assert.ok(
  process.argv[2] && process.env.YAP_NATIVE,
  "Pass a fresh directory and YAP_NATIVE; use --help",
);
const out = resolve(process.argv[2]),
  run = promisify(execFile);
await mkdir(out);
const tool = join(out, "frame-pixels"),
  reference = join(out, "frame-reference"),
  supportReader = join(out, "support-reader");
for (const [source, executable] of [
  ["FrameImagePixels.swift", tool],
  ["FrameColorReference.swift", reference],
  ["FrameSampleSupport.swift", supportReader],
])
  await run(
    "swiftc",
    ["-parse-as-library", new URL(source, import.meta.url).pathname, "-o", executable],
    { timeout: 120000 },
  );
const width = 128,
  height = 64,
  range = { startUs: 0, endUs: 200000 };
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const linear = (pixel) =>
  pixel
    .slice(0, 3)
    .map((v) => (decode(v / 255) * pixel[3]) / 255)
    .concat(pixel[3] / 255);
const encoded = (pixel) =>
  pixel
    .slice(0, 3)
    .map((v) => Math.round(255 * encode(pixel[3] ? v / pixel[3] : 0)))
    .concat(Math.round(255 * pixel[3]));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const colors = [
  [0, 0, 0],
  [255, 255, 255],
  [128, 128, 128],
  [40, 90, 180],
  [215, 120, 50],
  [60, 180, 120],
  [220, 50, 175],
  [180, 205, 235],
];
const raster = (pixel) =>
  Buffer.from(
    Array.from({ length: width * height }, (_, i) =>
      pixel(i % width, Math.floor(i / width)),
    ).flat(),
  );
async function png(path, rgba) {
  const raw = path + ".raw";
  await writeFile(raw, rgba);
  await run("python3", [
    "-c",
    `import struct,zlib,sys
from pathlib import Path
p=Path(sys.argv[1]); w,h=map(int,sys.argv[2:]); b=p.read_bytes()
def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
rows=b''.join(bytes([0])+b[y*w*4:(y+1)*w*4] for y in range(h))
Path(str(p)[:-4]).write_bytes(b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'sRGB',bytes([0]))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b''))`,
    raw,
    String(width),
    String(height),
  ]);
}
let sequence = 0;
function call(operation, params) {
  const result = spawnSync(process.env.YAP_NATIVE, [], {
    input: JSON.stringify({ id: String(++sequence), operation, params }) + "\n",
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout);
  appendFileSync(join(out, "exchanges.jsonl"), JSON.stringify({ operation, params, reply }) + "\n");
  assert.ok(reply.ok, JSON.stringify(reply));
  return reply.data;
}
async function pixels(path) {
  const raw = path + ".rgba";
  const receipt = JSON.parse((await run(tool, [path, raw], { timeout: 60000 })).stdout);
  assert.deepEqual([receipt.width, receipt.height], [width, height]);
  verifyPicturePixels(receipt);
  return { receipt, bytes: await readFile(raw) };
}

const report = {
  recipe: "W3C separable blend/source-over; premultiplied linear-sRGB operands, encoded sRGB PNG",
  os: (await run("sw_vers", [])).stdout,
  workerSHA256: hash(await readFile(process.env.YAP_NATIVE)),
  referenceSHA256: hash(await readFile(new URL("blend-reference.mjs", import.meta.url))),
  cases: [],
};
const frozenCases = selectBlendCases(
  JSON.parse(
    await readFile(
      new URL(
        "../../../specs/done/video-editing-feedback/assets/24-blend-sheet/report.json",
        import.meta.url,
      ),
    ),
  ).cases,
);
for (const scenario of blendScenarios) {
  const directory = join(out, scenario);
  await mkdir(directory);
  const vignette = scenario === "vignette",
    nested = scenario.endsWith("nested"),
    reversed = scenario.endsWith("reversed");
  const mode = vignette ? "multiply" : scenario.split("-reversed")[0].split("-nested")[0];
  const below = raster((x, y) =>
    vignette
      ? [60 + x, 100 + y, 160 + Math.floor(x / 2), 255]
      : [...colors[Math.floor(x / 16)], [255, 128, 0, 255][Math.floor(y / 16)]],
  );
  const above = raster((x, y) =>
    vignette
      ? Array(3)
          .fill(
            Math.round(
              255 * (1 - 0.65 * Math.min(1, ((x - 63.5) / 64) ** 2 + ((y - 31.5) / 32) ** 2)),
            ),
          )
          .concat(255)
      : [
          ...colors[(Math.floor(x / 16) + 3) % colors.length],
          [255, 128, 255, 0][Math.floor(y / 16)],
        ],
  );
  const operands = reversed ? [above, below] : [below, above];
  const expected = Buffer.alloc(width * height * 4),
    baseline = Buffer.alloc(expected.length);
  for (let at = 0; at < expected.length; at += 4) {
    const b = linear([...operands[0].subarray(at, at + 4)]),
      s = linear([...operands[1].subarray(at, at + 4)]),
      background = [0, 0, 0, 1];
    const parent = nested ? b : blendPixel(b, background, "normal");
    const combined = blendPixel(s, parent, mode);
    expected.set(encoded(nested ? blendPixel(combined, background, "normal") : combined), at);
    const ordinary = blendPixel(s, parent, "normal");
    baseline.set(encoded(nested ? blendPixel(ordinary, background, "normal") : ordinary), at);
  }
  await png(join(directory, "reference.png"), expected);
  verifyBlendReferenceIdentity(
    scenario,
    hash(await readFile(join(directory, "reference.png"))),
    frozenCases,
  );
  await png(join(directory, "normal-before.png"), baseline);
  const assets = ["below", "above"].map((id) => ({
    id,
    streams: [{ id: "image:0", kind: "image", width, height }],
  }));
  const bindings = [];
  for (const [i, asset] of assets.entries()) {
    const path = join(directory, asset.id + ".png");
    await png(path, operands[i]);
    bindings.push({ assetId: asset.id, streamId: "image:0", path, originUs: 0 });
  }
  const document = {
    canvas: { width, height, fps: { numerator: 10, denominator: 1 }, background: "#000000ff" },
    tracks: assets.map((asset, order) => ({
      id: asset.id,
      kind: "video",
      order,
      ...(nested ? { parentId: "inner" } : {}),
    })),
    groups: nested
      ? [
          { id: "inner", kind: "video", order: 0, parentId: "outer" },
          { id: "outer", kind: "video", order: 0 },
        ]
      : [],
    clips: assets.map((asset) => ({
      id: asset.id,
      trackId: asset.id,
      assetId: asset.id,
      streamId: "image:0",
      source: { kind: "hold", atUs: 0 },
      placement: { kind: "project", range },
    })),
    processing: [
      {
        target: { kind: "track", id: "above" },
        steps: [{ id: "combine", enabled: true, processor: { type: "blend", mode } }],
      },
    ],
    syncGroups: [],
  };
  const compiler = createCompiler(validateComposition(document, assets), "blend-sheet");
  const window = compiler.videoWindow({
    range,
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const frames = [...window.frames()],
    processing = window.processing();
  const frameRequest = {
    output: join(directory, "candidate.png"),
    canvas: document.canvas,
    frame: frames[0],
    processing,
    assets: bindings,
    profile: "h264-rec709",
    maxLongEdge: width,
  };
  const originalHashes = await Promise.all(
    bindings.map(async ({ path }) => hash(await readFile(path))),
  );
  const receipt = call("media.renderCompositionFrame", frameRequest);
  const actual = await pixels(receipt.file);
  const row = {
    scenario,
    mode,
    document,
    frameRequest,
    receipt,
    observation: actual.receipt,
    frame: compareBlendRaster(actual.bytes, expected, { width, height, limit: 2 }),
    artifacts: {},
  };
  for (const file of [
    "reference.png",
    "normal-before.png",
    "candidate.png",
    "below.png",
    "above.png",
  ])
    row.artifacts[file] = hash(await readFile(join(directory, file)));
  const records = join(directory, "frames.jsonl");
  await writeFile(records, frames.map((frame) => JSON.stringify(frame) + "\n").join(""));
  const movieRequest = {
    output: join(directory, "candidate.mp4"),
    frames: records,
    range,
    canvas: document.canvas,
    processing,
    assets: bindings,
    settings: resolveOutputSettings({ preset: "sharp" }),
  };
  const movie = call("media.renderCompositionVideo", movieRequest);
  assert.deepEqual(
    await Promise.all(bindings.map(async ({ path }) => hash(await readFile(path)))),
    originalHashes,
    "Native frame/movie operations preserve original operands",
  );
  const supportRequest = join(directory, "movie-support-request.json");
  await writeFile(
    supportRequest,
    JSON.stringify({
      file: movie.file,
      points: [
        { numerator: 0, denominator: 1 },
        { numerator: 100000, denominator: 1 },
      ],
    }),
  );
  row.support = JSON.parse((await run(supportReader, [supportRequest], { timeout: 60000 })).stdout);
  verifyBlendMovieSupport(row.support);
  row.artifacts["candidate.mp4"] = hash(await readFile(movie.file));
  row.artifacts["frames.jsonl"] = hash(await readFile(records));
  const decoded = join(directory, "movie-frames");
  await mkdir(decoded);
  const request = join(directory, "movie-read.json");
  await writeFile(
    request,
    JSON.stringify({ movie: movie.file, output: decoded, timesUs: [0, 100000] }),
  );
  const reads = JSON.parse((await run(reference, [request], { timeout: 60000 })).stdout);
  row.movie = { request: movieRequest, receipt: movie, reads: [] };
  for (const read of reads) {
    assert.equal(read.status, "available", read.error);
    assert.equal((Number(read.actualValue) * 1000000) / read.actualTimescale, read.requestedUs);
    const sample = await pixels(read.file);
    row.movie.reads.push({
      read,
      observation: sample.receipt,
      arithmetic: compareBlendRaster(sample.bytes, expected, {
        width,
        height,
        limit: 8,
        interior: !vignette,
      }),
      frameParity: compareBlendRaster(sample.bytes, actual.bytes, {
        width,
        height,
        limit: 8,
        interior: !vignette,
      }),
    });
  }
  report.cases.push(row);
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    `PASS ${scenario}: frame maximum ${row.frame.maximum}, movie maximum ${Math.max(...row.movie.reads.map((read) => read.arithmetic.maximum))}`,
  );
}
