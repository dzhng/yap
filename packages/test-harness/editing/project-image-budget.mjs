import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { run } from "./source-evidence-fixture.mjs";

assert.ok(process.env.YAP_NATIVE && process.argv[2], "Pass a frozen worker and evidence JSON path");
const home = await mkdtemp(join(tmpdir(), "image-budget-"));
let report;
try {
  // Two individually legal images exceed the shared budget. Retain peak residency
  // and the remaining allowance reported by pre-decode admission.
  await run("python3", [
    "-c",
    `import struct,zlib,sys
from pathlib import Path
root=Path(sys.argv[1])
def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
def header(w,h):return b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))
c=zlib.compressobj(); data=[]
for y in range(4096):data.append(c.compress(bytes(8192*4+1)))
data.append(c.flush())
(root/'first.png').write_bytes(header(8192,4096)+chunk(b'IDAT',b''.join(data))+chunk(b'IEND',b''))
c=zlib.compressobj(); data=[]
for y in range(8192):data.append(c.compress(bytes(8192*4+1)))
data.append(c.flush())
(root/'second.png').write_bytes(header(8192,8192)+chunk(b'IDAT',b''.join(data))+chunk(b'IEND',b''))
`,
    home,
  ]);
  const assets = [
    { id: "first", streams: [{ id: "image:0", kind: "image", width: 8192, height: 4096 }] },
    { id: "second", streams: [{ id: "image:0", kind: "image", width: 8192, height: 8192 }] },
  ];
  const document = {
    canvas: {
      width: 40,
      height: 64,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
    groups: [],
    processing: [],
    syncGroups: [],
    tracks: assets.map((asset, order) => ({ id: asset.id, kind: "video", order })),
    clips: assets.map((asset) => ({
      id: asset.id,
      trackId: asset.id,
      assetId: asset.id,
      streamId: "image:0",
      source: { kind: "hold", atUs: 0 },
      placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
    })),
  };
  const compiler = createCompiler(validateComposition(document, assets), "budget");
  const window = compiler.videoWindow({
    range: { startUs: 0, endUs: 100000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const params = {
    output: join(home, "result.png"),
    frame: window.frames().next().value,
    canvas: document.canvas,
    profile: "h264-rec709",
    processing: window.processing(),
    assets: assets.map((asset) => ({
      assetId: asset.id,
      streamId: "image:0",
      originUs: 0,
      path: join(home, `${asset.id}.png`),
    })),
  };
  const { spawnSync } = await import("node:child_process");
  function invoke(params) {
    const result = spawnSync("/usr/bin/time", ["-l", process.env.YAP_NATIVE], {
      input:
        JSON.stringify({ id: "budget", operation: "media.renderCompositionFrame", params }) + "\n",
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      reply: JSON.parse(result.stdout),
      peakResidentBytes: Number(result.stderr.match(/(\d+)\s+maximum resident set size/)?.[1]),
    };
  }
  const { reply, peakResidentBytes } = invoke(params);
  report = {
    worker: process.env.YAP_NATIVE,
    reply,
    passed: reply.error?.code === "LIMIT_EXCEEDED" && reply.error.message.includes("33554432"),
    peakResidentBytes,
    firstPixels: 8192 * 4096,
    secondDeclaredPixels: 8192 * 8192,
    aggregateLimit: 8192 * 8192,
  };
  assert.equal(reply.error?.code, "LIMIT_EXCEEDED", JSON.stringify(reply));
  assert.ok(
    reply.error.message.includes("33554432"),
    "Refusal must report only the remaining image decode allowance",
  );
  const repeated = structuredClone(document);
  repeated.tracks = [0, 1, 2].map((i) => ({ id: `copy-${i}`, kind: "video", order: i }));
  repeated.clips = repeated.tracks.map((track) => ({
    ...document.clips[0],
    id: track.id,
    trackId: track.id,
  }));
  const repeatedWindow = createCompiler(
    validateComposition(repeated, assets),
    "repeated",
  ).videoWindow({
    range: { startUs: 0, endUs: 100000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  report.repeated = invoke({
    ...params,
    frame: repeatedWindow.frames().next().value,
    processing: repeatedWindow.processing(),
  });
  report.passed &&= report.repeated.reply.ok === true;
  assert.equal(report.repeated.reply.ok, true, JSON.stringify(report.repeated));
  assert.equal(report.repeated.reply.data.decodedImages, 1);
  assert.equal(report.repeated.reply.data.readerOpens, 1);
  assert.equal(report.repeated.reply.data.pictures.length, 3);
} finally {
  if (report) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  await rm(home, { recursive: true, force: true });
}
