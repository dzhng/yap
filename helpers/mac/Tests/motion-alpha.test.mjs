import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCompiler, validateComposition } from "../../../packages/composition/dist/index.js";

const native =
  process.env.YAP_NATIVE ?? new URL("../.build/debug/yap-native", import.meta.url).pathname;
const ffmpeg =
  process.env.YAP_FFMPEG ??
  new URL("../../ffmpeg/.build/distribution/bin/ffmpeg", import.meta.url).pathname;
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(executable, args, input) {
  const result = spawnSync(executable, args, { input, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test("finite ProRes alpha motion preserves edges, orientation and off-grid phase on both backgrounds", (t) => {
  const retained = process.env.YAP_ALPHA_EVIDENCE;
  const directory = retained ?? mkdtempSync(join(tmpdir(), "yap-alpha-"));
  if (retained) mkdirSync(directory);
  else t.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = {
    nativeSha256: hash(native),
    ffmpegSha256: hash(ffmpeg),
    exchanges: [],
    comparisons: [],
    passed: false,
  };
  const save = () =>
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const call = (operation, params, success = true) => {
    const request = { id: String(report.exchanges.length + 1), operation, params };
    const reply = JSON.parse(run(native, [], JSON.stringify(request) + "\n"));
    report.exchanges.push({ request, reply });
    save();
    assert.equal(reply.ok, success, JSON.stringify(reply));
    return success ? reply.data : reply.error;
  };
  const width = 64,
    height = 48,
    frames = [];
  for (let n = 0; n < 4; n++) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 9; y < 30; y++)
      for (let x = 5 + n * 8; x < 24 + n * 8; x++) {
        const i = (y * width + x) * 4;
        pixels[i] = 255;
        pixels[i + 3] = x === 5 + n * 8 || y === 9 ? 64 : 128;
      }
    for (let y = 9; y < 15; y++)
      for (let x = 5 + n * 8; x < 11 + n * 8; x++) {
        const i = (y * width + x) * 4;
        pixels[i] = 0;
        pixels[i + 2] = 255;
        pixels[i + 3] = 255;
      }
    frames.push(pixels);
  }
  const raw = join(directory, "source.rgba"),
    movie = join(directory, "alpha.mov");
  writeFileSync(raw, Buffer.concat(frames));
  // Frame properties and the MOV color atom must both describe the actual YUV conversion.
  run(ffmpeg, [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    "64x48",
    "-framerate",
    "4",
    "-i",
    raw,
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4",
    "-alpha_bits",
    "16",
    "-movflags",
    "+write_colr",
    movie,
  ]);
  const variants = [
    { name: "ordinary", path: movie, turns: "none", phases: [0, 1, 2, 3] },
    { name: "rotation", path: join(directory, "rotation.mov"), turns: "ccw", phases: [1] },
    { name: "mirror", path: join(directory, "mirror.mov"), turns: "mirror", phases: [1] },
  ];
  run(ffmpeg, [
    "-v",
    "error",
    "-display_rotation",
    "90",
    "-i",
    movie,
    "-c",
    "copy",
    "-movflags",
    "+write_colr",
    variants[1].path,
  ]);
  run(ffmpeg, [
    "-v",
    "error",
    "-display_hflip",
    "-i",
    movie,
    "-c",
    "copy",
    "-movflags",
    "+write_colr",
    variants[2].path,
  ]);
  for (const variant of variants) {
    const before = hash(variant.path),
      probe = call("media.probe", { path: variant.path });
    const stream = probe.streams.find((s) => s.kind === "video");
    assert.equal(stream.codec, "ap4h");
    assert.equal(stream.colorPrimaries, "ITU_R_709_2");
    assert.equal(stream.transferFunction, "ITU_R_709_2");
    assert.equal(stream.ycbcrMatrix, "ITU_R_709_2");
    assert.equal(stream.samples.count, 4);
    assert.equal(stream.endUs, 1000000);
    const w = stream.orientedWidth,
      h = stream.orientedHeight;
    for (const n of variant.phases) {
      const transformed = Buffer.alloc(w * h * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const dx = variant.turns === "ccw" ? y : variant.turns === "mirror" ? width - 1 - x : x;
          const dy = variant.turns === "ccw" ? width - 1 - x : y;
          frames[n].copy(
            transformed,
            (dy * w + dx) * 4,
            (y * width + x) * 4,
            (y * width + x) * 4 + 4,
          );
        }
      const still = join(directory, `${variant.name}-${n}.png`);
      run(
        ffmpeg,
        [
          "-v",
          "error",
          "-f",
          "rawvideo",
          "-pixel_format",
          "rgba",
          "-video_size",
          `${w}x${h}`,
          "-i",
          "pipe:0",
          "-frames:v",
          "1",
          still,
        ],
        transformed,
      );
      for (const [background, color] of [
        ["dark", "#000000ff"],
        ["light", "#ffffffff"],
      ]) {
        const outputs = [];
        for (const kind of ["still", "movie"]) {
          const moving = kind === "movie",
            sid = moving ? stream.id : "image:0";
          const selected = {
            id: sid,
            kind: moving ? "video" : "image",
            width: w,
            height: h,
            ...(moving
              ? {
                  bounds: { startUs: stream.startUs, endUs: stream.endUs },
                  available: stream.segments
                    .filter((s) => !s.empty)
                    .map(({ startUs, endUs }) => ({ startUs, endUs })),
                }
              : {}),
          };
          const canvas = {
            width: w,
            height: h,
            fps: { numerator: 4, denominator: 1 },
            background: color,
          };
          const document = {
            canvas,
            tracks: [{ id: "v", kind: "video", order: 0 }],
            groups: [],
            syncGroups: [],
            processing: [],
            clips: [
              {
                id: "c",
                assetId: "a",
                streamId: sid,
                trackId: "v",
                source: moving
                  ? { kind: "range", range: { startUs: 0, endUs: 1000000 } }
                  : { kind: "hold", atUs: 0 },
                placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
              },
            ],
          };
          const compiler = createCompiler(
            validateComposition(document, [{ id: "a", streams: [selected] }]),
            "alpha-proof",
          );
          const at = n === 3 ? 999999 : n * 250000 + 1;
          const window = compiler.videoWindow({
            range: { startUs: at, endUs: at + 1 },
            rendition: { sampleRate: 48000, channels: 2 },
            tap: { target: { kind: "output" }, point: { kind: "processed" } },
          });
          const output = join(directory, `${variant.name}-${n}-${background}-${kind}.png`);
          const receipt = call("media.renderCompositionFrame", {
            output,
            frame: window.frames().next().value,
            canvas,
            profile: "h264-rec709",
            processing: window.processing(),
            assets: [
              {
                assetId: "a",
                streamId: sid,
                path: moving ? variant.path : still,
                originUs: moving ? probe.originUs : 0,
              },
            ],
          });
          if (moving) assert.equal(receipt.pictures[0].actualSourceUs, n * 250000);
          outputs.push(output);
        }
        const decoded = outputs.map((file) =>
          run(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]),
        );
        assert.equal(decoded[0].length, w * h * 4);
        assert.equal(decoded[1].length, decoded[0].length);
        const sourceX = 10 + n * 8;
        const markerX =
          variant.turns === "ccw" ? 20 : variant.turns === "mirror" ? width - 1 - sourceX : sourceX;
        const markerY = variant.turns === "ccw" ? width - 1 - sourceX : 20;
        const expected = background === "dark" ? [188, 0, 0, 255] : [255, 187, 187, 255];
        for (const pixels of decoded) {
          const marker = pixels.subarray(
            (markerY * w + markerX) * 4,
            (markerY * w + markerX) * 4 + 4,
          );
          expected.forEach((value, channel) =>
            assert.ok(
              Math.abs(marker[channel] - value) <= 1,
              `Known half-alpha marker differs: ${[...marker]}`,
            ),
          );
          assert.deepEqual(
            [...pixels.subarray(0, 4)],
            background === "dark" ? [0, 0, 0, 255] : [255, 255, 255, 255],
          );
        }
        let maximum = 0,
          sum = 0;
        for (let i = 0; i < decoded[0].length; i++) {
          const delta = Math.abs(decoded[0][i] - decoded[1][i]);
          maximum = Math.max(maximum, delta);
          sum += delta;
        }
        report.comparisons.push({
          variant: variant.name,
          phase: n,
          background,
          outputs,
          maximum,
          mae: sum / decoded[0].length,
        });
        save();
        assert.ok(
          maximum <= 2,
          `alpha/color/phase mismatch ${JSON.stringify(report.comparisons.at(-1))}`,
        );
        if (retained)
          run(ffmpeg, [
            "-v",
            "error",
            "-i",
            outputs[0],
            "-i",
            outputs[1],
            "-filter_complex",
            "[0:v][1:v]hstack,scale=iw*4:ih*4:flags=neighbor",
            join(directory, `${variant.name}-${n}-${background}-pair.png`),
          ]);
      }
    }
    assert.equal(hash(variant.path), before);
    const error = call(
      "media.sourceFrame",
      {
        asset: { assetId: "a", streamId: stream.id, path: variant.path, originUs: probe.originUs },
        available: [{ startUs: 0, endUs: 1000000 }],
        atUs: 1000000,
        output: join(directory, `${variant.name}-beyond.png`),
      },
      false,
    );
    assert.equal(error.code, "UNAVAILABLE_SUPPORT");
  }
  report.passed = true;
  save();
});
