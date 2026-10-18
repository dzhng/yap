import { resolveOutputSettings } from "../../composition/dist/index.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { prepareLayersFixture } from "./layers-fixture.mjs";
import { layerCases } from "./layers-cases.mjs";
import { layerTree, expectedRgba, compareGeometry, compareLandmarks } from "./layers-oracle.mjs";

const out = resolve(process.argv[2] ?? "");
assert.ok(
  process.argv[2] && process.env.YAP_NATIVE,
  "Pass a fresh output directory and YAP_NATIVE",
);
await mkdir(out);
const scratch = join(out, "fixture");
await mkdir(scratch);
const references = join(out, "references");
await mkdir(references);
const { media, pixelTool } = await prepareLayersFixture(scratch, references);
let sequence = 0;
const call = (operation, params) => {
  const run = spawnSync(process.env.YAP_NATIVE, [], {
    input: JSON.stringify({ id: String(++sequence), operation, params }) + "\n",
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};
const probes = new Map();
for (const name of ["screen", "presenter", "plate", "rotated", "narration"]) {
  const response = call("media.probe", { path: media[name].path });
  assert.ok(response.ok, JSON.stringify(response));
  probes.set(name, response.data);
}
const rows = [];
const baselinePixels = new Map();
for (const [width, height] of [
  [160, 96],
  [128, 128],
]) {
  const canvas = { width, height, fps: { numerator: 10, denominator: 1 }, background: "#000000ff" };
  for (const scenario of layerCases(canvas).filter(
    (c) =>
      !process.env.YAP_LAYER_CASE ||
      c.name === process.env.YAP_LAYER_CASE ||
      (process.env.YAP_LAYER_CASE === "explicit-default" && c.name === "baseline"),
  )) {
    const directory = join(out, `${width}x${height}-${scenario.name}`);
    await mkdir(directory);
    const selected = Object.fromEntries(
      ["screen", "presenter"].map((id) => [id, scenario.sources?.[id] ?? id]),
    );
    const assets = [],
      bindings = [],
      surfaces = {};
    for (const id of ["screen", "presenter"]) {
      const name = selected[id],
        probe = probes.get(name),
        stream = probe.streams.find((s) => s.kind === "video");
      assets.push({
        id,
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
      });
      bindings.push({
        assetId: id,
        streamId: stream.id,
        path: media[name].path,
        originUs: probe.originUs,
      });
      surfaces[id] = {
        width: media[name].width,
        height: media[name].height,
        rgba: media[name].rgba,
        encodedProfile: media[name].encodedProfile,
      };
    }
    const target = (name) =>
      name === "output"
        ? { kind: "output" }
        : ["inner", "outer"].includes(name)
          ? { kind: "group", id: name }
          : name.endsWith("Track")
            ? { kind: "track", id: name }
            : { kind: "clip", id: name };
    const processing = Object.entries(scenario.stacks)
      .filter(([name, steps]) => name !== "reversed" && steps.length)
      .map(([name, steps]) => ({
        target: target(name),
        steps: steps.map(({ label, processor, enabled = true }) => ({
          id: `${name}-${label}`,
          processor,
          enabled,
        })),
      }));
    const document = {
      canvas,
      tracks: [
        {
          id: "screenTrack",
          kind: "video",
          order: scenario.stacks.reversed ? 1 : 0,
          parentId: "inner",
        },
        {
          id: "presenterTrack",
          kind: "video",
          order: scenario.stacks.reversed ? 0 : 1,
          parentId: "inner",
        },
      ],
      groups: [
        { id: "inner", kind: "video", order: 0, parentId: "outer" },
        { id: "outer", kind: "video", order: 0 },
      ],
      clips: ["screen", "presenter"].map((id) => ({
        id,
        trackId: `${id}Track`,
        assetId: id,
        streamId: assets.find((a) => a.id === id).streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      })),
      processing,
      syncGroups: [],
    };
    const compiler = createCompiler(validateComposition(document, assets), "authored-layers");
    const oracle = layerTree(canvas, surfaces, scenario.stacks);
    const taps = scenario.taps ? [...oracle.taps.entries()] : [["output/processed", oracle.output]];
    const results = [];
    for (const [tapName, surface] of taps) {
      const [rawName, point] = tapName.split("/"),
        name = rawName.replace("-track", "Track");
      const tap = {
        target: target(name),
        point: point.startsWith("after:")
          ? { kind: "after-step", stepId: `${name}-${point.slice(6)}` }
          : { kind: point },
      };
      const window = compiler.videoWindow({
        range: { startUs: 0, endUs: 1 },
        rendition: { sampleRate: 48000, channels: 2 },
        tap,
      });
      const frame = [...window.frames()][0];
      const output = join(directory, tapName.replaceAll("/", "-").replaceAll(":", "-") + ".png");
      const params = {
        output,
        canvas,
        frame,
        processing: window.processing(),
        assets: bindings,
        profile: "h264-rec709",
        maxLongEdge: Math.max(width, height),
      };
      const receipt = call("media.renderCompositionFrame", params);
      assert.ok(receipt.ok, JSON.stringify(receipt));
      assert.deepEqual(
        receipt.data.pictures.map((p) => [
          p.clipId,
          p.assetId,
          p.streamId,
          p.requestedSourceUs,
          p.actualSourceUs,
          p.status,
        ]),
        frame.layers.map((l) => [
          l.clipId,
          l.assetId,
          l.streamId,
          l.sourceUs,
          l.sourceUs,
          "available",
        ]),
      );
      const rgba = output + ".rgba";
      const normalized = spawnSync(pixelTool, [output, rgba], { encoding: "utf8", timeout: 60000 });
      assert.equal(normalized.status, 0, normalized.stderr);
      const actual = await readFile(rgba),
        expected = expectedRgba(surface);
      if (scenario.name === "baseline")
        baselinePixels.set(`${width}x${height}`, await readFile(output));
      if (scenario.name === "explicit-default")
        assert.deepEqual(
          await readFile(output),
          baselinePixels.get(`${width}x${height}`),
          "Explicit default changed baseline pixels",
        );
      await writeFile(output + ".expected.rgba", expected);
      let verdict;
      try {
        verdict = compareGeometry(actual, expected, width, height);
      } catch (error) {
        await writeFile(
          join(directory, "failure.json"),
          JSON.stringify({ tapName, message: error.message, params }, null, 2),
        );
        throw error;
      }
      results.push({
        tapName,
        receipt: receipt.data,
        normalization: JSON.parse(normalized.stdout),
        verdict,
      });
    }
    if (scenario.name === "rotated-crop") {
      const flat = structuredClone(document);
      flat.groups = [];
      flat.tracks.forEach((track) => {
        delete track.parentId;
      });
      flat.tracks.push({ id: "unused", kind: "video", order: 2 });
      const isolated = createCompiler(validateComposition(flat, assets), "flat-layers").videoWindow(
        {
          range: { startUs: 0, endUs: 1 },
          rendition: { sampleRate: 48000, channels: 2 },
          tap: { target: { kind: "output" }, point: { kind: "processed" } },
        },
      );
      const output = join(directory, "flat-with-unused-track.png");
      const rendered = call("media.renderCompositionFrame", {
        output,
        canvas,
        frame: [...isolated.frames()][0],
        processing: isolated.processing(),
        assets: bindings,
        profile: "h264-rec709",
        maxLongEdge: Math.max(width, height),
      });
      assert.ok(rendered.ok, JSON.stringify(rendered));
      assert.deepEqual(
        await readFile(output),
        await readFile(results[0].receipt.file),
        "Grouping or unused track changed the cropped picture",
      );
    }
    const movies = [];
    if (
      ["presenter", "rotated-crop", "parent-opacity", "output-transparent-margin"].includes(
        scenario.name,
      )
    ) {
      const probe = probes.get("narration"),
        stream = probe.streams.find((s) => s.kind === "audio");
      const movieDocument = structuredClone(document);
      movieDocument.tracks.push({ id: "narration", kind: "audio", order: 0 });
      movieDocument.clips.push({
        id: "narration",
        trackId: "narration",
        assetId: "narration",
        streamId: stream.id,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      });
      const movieAssets = [
        ...assets,
        {
          id: "narration",
          streams: [
            {
              id: stream.id,
              kind: "audio",
              bounds: { startUs: 0, endUs: 1000000 },
              available: [{ startUs: 0, endUs: 1000000 }],
            },
          ],
        },
      ];
      const movieBindings = [
        ...bindings,
        {
          assetId: "narration",
          streamId: stream.id,
          path: media.narration.path,
          originUs: probe.originUs,
        },
      ];
      const movieCompiler = createCompiler(
        validateComposition(movieDocument, movieAssets),
        "layer-movie",
      );
      for (const range of [
        { startUs: 0, endUs: 1000000 },
        { startUs: 123457, endUs: 812349 },
      ]) {
        const window = movieCompiler.window({
          range,
          rendition: { sampleRate: 48000, channels: 2 },
          tap: { target: { kind: "output" }, point: { kind: "processed" } },
        });
        const frames = join(directory, `frames-${range.startUs}.jsonl`);
        const compiled = [...window.frames()];
        await writeFile(frames, compiled.map((f) => JSON.stringify(f) + "\n").join(""));
        const audio = {
          range: {
            start: Math.floor((range.startUs * 48000) / 1000000),
            end: Math.floor((range.endUs * 48000) / 1000000),
          },
          clips: [...window.audio()],
        };
        const base = {
          frames,
          range,
          canvas,
          processing: window.processing(),
          assets: movieBindings,
          settings: resolveOutputSettings(),
        };
        const mixed = call("media.mixCompositionAudio", {
          ...audio,
          processing: base.processing,
          assets: movieBindings,
          output: join(directory, `audio-${range.startUs}.wav`),
        });
        assert.ok(mixed.ok, JSON.stringify(mixed));
        const pcm = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-nostdin",
            "-i",
            mixed.data.file,
            "-f",
            "f32le",
            "-c:a",
            "pcm_f32le",
            "pipe:1",
          ],
          { timeout: 60000 },
        );
        assert.equal(pcm.status, 0, pcm.stderr.toString());
        assert.deepEqual(
          pcm.stdout,
          media.narration.pcm.subarray(audio.range.start * 8, audio.range.end * 8),
          "Visual processing changed narration PCM",
        );
        const movie = call("media.renderCompositionMovie", {
          ...base,
          audio,
          output: join(directory, `movie-${range.startUs}.mp4`),
        });
        if (scenario.movie === "nonopaque") {
          assert.equal(movie.error?.code, "NOT_READY", JSON.stringify(movie));
          movies.push({ range, refusal: movie.error, unaffectedPCM: true });
          continue;
        }
        assert.ok(movie.ok, JSON.stringify(movie));
        assert.equal(movie.data.durationUs, range.endUs - range.startUs);
        const referenceDirectory = join(directory, `movie-${range.startUs}-reference`);
        await mkdir(referenceDirectory);
        const request = join(directory, `movie-${range.startUs}-reference.json`);
        await writeFile(
          request,
          JSON.stringify({
            movie: movie.data.file,
            output: referenceDirectory,
            timesUs: [0, compiled.at(-1).visibleRange.startUs - range.startUs],
          }),
        );
        const sample = spawnSync(join(scratch, "frame-reference"), [request], {
          encoding: "utf8",
          timeout: 60000,
        });
        assert.equal(sample.status, 0, sample.stderr);
        const references = [];
        for (const sampled of JSON.parse(sample.stdout)) {
          assert.equal(sampled.status, "available", sampled.error);
          const rgba = sampled.file + ".rgba";
          const normalized = spawnSync(pixelTool, [sampled.file, rgba], {
            encoding: "utf8",
            timeout: 60000,
          });
          assert.equal(normalized.status, 0, normalized.stderr);
          const decoded = await readFile(rgba),
            expected = expectedRgba(oracle.output);
          const verdict = compareLandmarks(decoded, expected, width, height);
          let sum = 0,
            squares = 0,
            maximum = 0;
          const changed = [];
          for (let pixel = 0; pixel < width * height; pixel++) {
            let pixelMaximum = 0;
            for (let channel = 0; channel < 3; channel++) {
              const error = Math.abs(decoded[pixel * 4 + channel] - expected[pixel * 4 + channel]);
              sum += error;
              squares += error * error;
              maximum = Math.max(maximum, error);
              pixelMaximum = Math.max(pixelMaximum, error);
            }
            if (pixelMaximum > 2)
              changed.push({
                x: pixel % width,
                y: Math.floor(pixel / width),
                maximum: pixelMaximum,
              });
          }
          verdict.codecError = {
            maximum,
            mae: sum / (width * height * 3),
            rmse: Math.sqrt(squares / (width * height * 3)),
            aboveLosslessThreshold: changed.length,
          };
          await writeFile(
            join(directory, `codec-errors-${range.startUs}-${sampled.index}.json`),
            JSON.stringify(changed),
          );
          references.push({ sampled, verdict });
        }
        movies.push({ range, receipt: movie.data, references, unaffectedPCM: true });
      }
    }
    rows.push({ canvas: { width, height }, case: scenario.name, results, movies });
    await writeFile(join(out, "report.json"), JSON.stringify(rows, null, 2));
    console.log(`PASS ${width}x${height} ${scenario.name} (${results.length} taps)`);
  }
}

assert.ok(rows.length > 0, "No authored layer case matched the selector");
