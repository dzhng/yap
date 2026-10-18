import { resolveOutputSettings } from "../../composition/dist/index.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  linkSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
const native = process.env.YAP_NATIVE;
assert(native);
const scratch = mkdtempSync(join(tmpdir(), "sr-composition-movie-"));
const fractionalTailOnly = process.argv.includes("--fractional-tail");
let sequence = 0;
let completed = false;
function run(command, args, input) {
  const r = spawnSync(command, args, {
    input,
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout;
}
function call(operation, params, expected) {
  const request = JSON.stringify({ id: String(++sequence), operation, params }) + "\n";
  writeFileSync(join(scratch, `request-${sequence}.json`), request);
  const reply = run(native, [], request);
  writeFileSync(join(scratch, `reply-${sequence}.json`), reply);
  const response = JSON.parse(reply);
  if (expected) {
    assert.equal(response.error?.code, expected, JSON.stringify(response));
    return;
  }
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}
function ff(...args) {
  return run("ffmpeg", ["-v", "error", "-nostdin", ...args]);
}
function inspectMovieClock(path) {
  let scale, duration;
  const edits = [];
  const tracks = [];
  function boxes(bytes) {
    for (let i = 0; i + 8 <= bytes.length;) {
      let size = bytes.readUInt32BE(i),
        header = 8;
      const type = bytes.toString("ascii", i + 4, i + 8);
      if (size === 1) {
        size = Number(bytes.readBigUInt64BE(i + 8));
        header = 16;
      }
      if (size === 0) size = bytes.length - i;
      assert(size >= header && i + size <= bytes.length);
      const body = bytes.subarray(i + header, i + size);
      if (["moov", "trak", "edts"].includes(type)) boxes(body);
      if (type === "mvhd") {
        const offset = body[0] ? 20 : 12;
        scale = BigInt(body.readUInt32BE(offset));
        duration = body[0]
          ? body.readBigUInt64BE(offset + 4)
          : BigInt(body.readUInt32BE(offset + 4));
      }
      if (type === "tkhd") {
        const offset = body[0] ? 28 : 20;
        tracks.push(body[0] ? body.readBigUInt64BE(offset) : BigInt(body.readUInt32BE(offset)));
      }
      if (type === "elst") {
        let total = 0n;
        for (let entry = 0; entry < body.readUInt32BE(4); entry++) {
          const offset = 8 + entry * (body[0] ? 20 : 12);
          total += body[0] ? body.readBigUInt64BE(offset) : BigInt(body.readUInt32BE(offset));
        }
        edits.push(total);
      }
      i += size;
    }
  }
  boxes(readFileSync(path));
  const clock = {
    timescale: Number(scale),
    durationTicks: Number(duration),
    editListTicks: edits.map(Number),
    trackTicks: tracks.map(Number),
  };
  writeFileSync(path + ".clock.json", JSON.stringify(clock, null, 2));
  assert(scale && duration && edits.length > 0);
  return clock;
}
function movieClock(path, durationUs) {
  const clock = inspectMovieClock(path);
  assert.equal(
    BigInt(clock.durationTicks) * 1000000n,
    BigInt(durationUs) * BigInt(clock.timescale),
  );
  for (const edit of clock.editListTicks) assert.equal(edit, clock.durationTicks);
  for (const track of clock.trackTicks) assert.equal(track, clock.durationTicks);
  return { ...clock, editLists: clock.editListTicks.length };
}
const checks = [];
try {
  const tone = join(scratch, "tone.wav");
  ff("-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*997*t):s=44100:d=2", "-c:a", "pcm_s16le", tone);
  const picture = join(scratch, "picture.mov");
  copyFileSync(
    new URL("../../../specs/done/agent-editing/assets/00-corpus/a.mov", import.meta.url),
    picture,
  );
  const originalBytes = [picture, tone].map((path) => readFileSync(path));
  const bindings = [],
    assets = [];
  for (const [id, path, kind] of [
    ["picture", picture, "video"],
    ["tone", tone, "audio"],
  ]) {
    const probe = call("media.probe", { path });
    assets.push({
      id,
      streams: probe.streams.map((s) => ({
        id: s.id,
        kind: s.kind,
        ...(s.kind === "video" ? { width: s.orientedWidth, height: s.orientedHeight } : {}),
        bounds: { startUs: s.startUs, endUs: s.endUs },
        available: s.segments
          ?.filter((segment) => !segment.empty)
          .map(({ startUs, endUs }) => ({ startUs, endUs })) ?? [
          { startUs: s.startUs, endUs: s.endUs },
        ],
      })),
    });
    bindings.push({
      assetId: id,
      streamId: probe.streams.find((s) => s.kind === kind).streamId,
      path,
      originUs: probe.originUs,
    });
  }
  const document = {
    canvas: {
      width: 160,
      height: 128,
      fps: { numerator: 20, denominator: 1 },
      background: "#000000ff",
    },
    tracks: [
      { id: "v", kind: "video", order: 0 },
      { id: "a", kind: "audio", order: 0 },
    ],
    groups: [],
    syncGroups: [],
    clips: bindings.map((b, i) => ({
      id: b.assetId,
      assetId: b.assetId,
      streamId: b.streamId,
      trackId: i ? "a" : "v",
      source: {
        kind: "range",
        range: { startUs: i ? 500001 : 0, endUs: i ? 1500001 : 1000000 },
      },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    })),
    processing: [
      {
        target: { kind: "output" },
        steps: [{ id: "gain", enabled: true, processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  };
  const inspector = process.env.YAP_MOVIE_INSPECT ?? join(scratch, "inspect");
  if (!process.env.YAP_MOVIE_INSPECT) {
    run("swiftc", [
      "-parse-as-library",
      new URL("../../../helpers/mac/Tests/MovieTiming/main.swift", import.meta.url).pathname,
      "-o",
      inspector,
    ]);
  }
  const tailControls = run(
    process.env.YAP_COMPOSITION_VIDEO_TESTS ?? join(dirname(native), "YapCompositionVideoTests"),
    ["--audio-tail", join(scratch, "tail-controls")],
  ).toString();
  writeFileSync(join(scratch, "tail-controls.log"), tailControls);
  assert(tailControls.startsWith("PASS"));
  const tailDirectory = join(scratch, "tail-controls");
  const replacements = readdirSync(tailDirectory).filter((name) => name.startsWith(".yap-output-"));
  assert.equal(replacements.length, 1, "Only the unrelated replacement may survive cleanup");
  assert.equal(
    readlinkSync(join(tailDirectory, replacements[0])),
    join(tailDirectory, "replacement-sentinel"),
    "Cleanup must preserve the unrelated replacement symlink",
  );
  const fractionalTail = { startUs: 200000, endUs: 300020 };
  for (const range of fractionalTailOnly
    ? [fractionalTail]
    : [
        fractionalTail,
        { startUs: 0, endUs: 1000000 },
        { startUs: 123457, endUs: 812349 },
        { startUs: 1, endUs: 2 },
      ]) {
    const compiler = createCompiler(validateComposition(document, assets), "movie-fixture");
    const window = compiler.window({
      range,
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const frames = join(scratch, `frames-${sequence}.jsonl`);
    writeFileSync(
      frames,
      [...window.frames()].map((frame) => JSON.stringify(frame) + "\n").join(""),
    );
    const base = {
      frames,
      range,
      canvas: document.canvas,
      settings: resolveOutputSettings(),
      processing: window.processing(),
      assets: bindings,
    };
    const audio = {
      range: {
        start: Math.floor((range.startUs * 48000) / 1000000),
        end: Math.floor((range.endUs * 48000) / 1000000),
      },
      clips: [...window.audio()],
    };
    if (range.startUs === 0) {
      const before = readFileSync(picture);
      const symbolic = join(scratch, "source-symbolic.mp4");
      const hard = join(scratch, "source-hard.mp4");
      symlinkSync(picture, symbolic);
      linkSync(picture, hard);
      for (const output of [picture, symbolic, hard, scratch]) {
        call("media.renderCompositionMovie", { ...base, output, audio }, "INVALID_OUTPUT");
      }
      assert.deepEqual(readFileSync(picture), before, "Movie aliases must preserve source bytes");
      checks.push({
        sourceAliasForms: ["direct", "symbolic", "hard", "directory"],
        sourceUnchanged: true,
      });
      const collisionDirectory = join(scratch, "collision");
      // Keep the observation directory private to this attempt so an unrelated staging
      // directory cannot trigger the publication race observer.
      mkdirSync(collisionDirectory);
      const requestFile = join(collisionDirectory, "request.json");
      writeFileSync(
        requestFile,
        JSON.stringify({ ...base, audio, output: join(collisionDirectory, "occupied.mp4") }),
      );
      const observed = run(
        process.env.YAP_COMPOSITION_VIDEO_TESTS ??
          join(dirname(native), "YapCompositionVideoTests"),
        [requestFile, "media.renderCompositionMovie", "collision"],
      ).toString();
      writeFileSync(join(collisionDirectory, "observer.log"), observed);
      assert(observed.startsWith("PASS"));
      checks.push({ lateCollision: "existing destination bytes preserved, no staging left" });
    }
    const output = join(scratch, `movie-${sequence}.mp4`);
    const result = call("media.renderCompositionMovie", {
      ...base,
      output,
      audio,
    });
    assert.equal(result.durationUs, range.endUs - range.startUs);
    if (audio.range.start === audio.range.end) {
      assert.equal(result.audio, undefined);
      const probe = JSON.parse(
        run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name",
          "-of",
          "json",
          output,
        ]),
      );
      assert.deepEqual(
        probe.streams.map((s) => s.codec_name),
        ["h264"],
      );
      checks.push({
        range,
        frames: 0,
        videoOnly: true,
        clock: movieClock(output, result.durationUs),
      });
      continue;
    }
    assert.equal(result.audio.frames, audio.range.end - audio.range.start);
    const standaloneVideo = call("media.renderCompositionVideo", {
      ...base,
      output: join(scratch, `video-${sequence}.mp4`),
    });
    const compressed = (path) =>
      ff(
        "-i",
        path,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-bsf:v",
        "filter_units=remove_types=6",
        "-f",
        "data",
        "pipe:1",
      );
    assert.deepEqual(
      compressed(output),
      compressed(standaloneVideo.file),
      "Movie picture NAL units must match independent H264 render (excluding encoder SEI timestamps)",
    );
    const standaloneAudio = call("media.mixCompositionAudio", {
      ...audio,
      output: join(scratch, `audio-${sequence}.wav`),
      processing: base.processing,
      assets: bindings,
    });
    const decode = (path) =>
      ff("-i", path, "-map", "0:a:0", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1");
    const reference = decode(standaloneAudio.file),
      decoded = decode(output);
    assert(decoded.length >= reference.length, "AAC must cover the requested PCM samples");
    let error = 0,
      energy = 0;
    for (let i = 2048; i < reference.length / 4 - 2048; i++) {
      const expected = reference.readFloatLE(i * 4),
        actual = decoded.readFloatLE(i * 4);
      error += (actual - expected) ** 2;
      energy += expected ** 2;
    }
    assert(Math.sqrt(error / energy) < 0.08, `AAC signal error ${Math.sqrt(error / energy)}`);
    const probe = JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type,sample_rate,channels,duration,duration_ts,time_base",
        "-of",
        "json",
        output,
      ]),
    );
    if (range === fractionalTail) {
      const raw = join(scratch, "fractional-tail.native.f32");
      const inspection = run(inspector, [output, raw]);
      writeFileSync(join(scratch, "fractional-tail.native.json"), inspection);
      const track = JSON.parse(inspection).tracks.find((value) => value.type === "soun");
      assert.equal(track.decodedFrames, 4800);
      assert.equal(readFileSync(raw).length, 4800 * 2 * 4);
      assert.equal(result.audio.frames, 4800);
    }
    const clock = movieClock(output, result.durationUs);
    assert.equal(
      Number(probe.streams.find((s) => s.codec_type === "video").duration),
      result.durationUs / 1000000,
    );
    assert(Math.abs(Number(probe.format.duration) - result.durationUs / 1000000) <= 1 / 48000);
    assert.deepEqual(probe.streams.map((s) => s.codec_name).sort(), ["aac", "h264"]);
    checks.push({
      range,
      frames: result.audio.frames,
      aacRelativeRmsError: Math.sqrt(error / energy),
      unchangedPictureNALUnits: true,
      clock,
      externalProbe: probe,
    });
    const invalidOutput = join(scratch, `invalid-${sequence}.mp4`);
    call(
      "media.renderCompositionMovie",
      {
        ...base,
        output: invalidOutput,
        audio: {
          ...audio,
          range: { ...audio.range, start: audio.range.start + 1 },
        },
      },
      "INVALID_REQUEST",
    );
    assert(!existsSync(invalidOutput));
    call(
      "media.renderCompositionMovie",
      { ...base, output: invalidOutput, audio: { ...audio, unexpected: true } },
      "INVALID_REQUEST",
    );
    assert(!existsSync(invalidOutput));
  }
  if (!fractionalTailOnly) {
    // Decode through the independent native ledger as well as FFmpeg. A sub-packet
    // AAC movie can have a real native sample even when FFmpeg emits no PCM.
    const isolationSource = join(scratch, "isolation.mov");
    ff(
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.2*sin(2*PI*(1511*t+7*t*t))|0.2*sin(2*PI*(2111*t+11*t*t)):s=48000:d=3",
      "-c:a",
      "pcm_f32le",
      isolationSource,
    );
    const isolationPCM = ff("-i", isolationSource, "-f", "f32le", "pipe:1");
    writeFileSync(join(scratch, "isolation-source.f32"), isolationPCM);
    const isolationProbe = call("media.probe", { path: isolationSource });
    const isolationStream = isolationProbe.streams.find((stream) => stream.kind === "audio");
    for (const [name, selections] of [
      // A 21us project window contains one floored 48kHz cell. That cell must survive
      // native presentation even when an external decoder drops a sub-packet movie.
      ["one-sample", [[300000, 300021]]],
      [
        "cut-isolation",
        [
          [0, 500000],
          [2000000, 2500000],
        ],
      ],
    ]) {
      const poisoned = Buffer.from(isolationPCM);
      const retained = selections.map(([start, end]) => [
        Math.floor((start * 48000) / 1000000),
        Math.floor((end * 48000) / 1000000),
      ]);
      for (let frame = 0; frame < poisoned.length / 8; frame++) {
        if (!retained.some(([start, end]) => start <= frame && frame < end)) {
          poisoned.writeFloatLE(0.9, frame * 8);
          poisoned.writeFloatLE(-0.9, frame * 8 + 4);
        }
      }
      const poisonRaw = join(scratch, `${name}-poison.f32`);
      const poisonSource = join(scratch, `${name}-poison.mov`);
      writeFileSync(poisonRaw, poisoned);
      ff(
        "-f",
        "f32le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        poisonRaw,
        "-c:a",
        "pcm_f32le",
        poisonSource,
      );
      let cursor = 0;
      const clips = selections.map(([startUs, endUs], index) => {
        const start = cursor;
        cursor += endUs - startUs;
        return {
          id: `selection-${index}`,
          assetId: "isolation",
          streamId: isolationStream.id,
          trackId: "a",
          source: { kind: "range", range: { startUs, endUs } },
          placement: { kind: "project", range: { startUs: start, endUs: cursor } },
        };
      });
      const isolationDocument = {
        ...document,
        tracks: [{ id: "a", kind: "audio", order: 0 }],
        clips,
        processing: [],
      };
      const range = { startUs: 0, endUs: cursor };
      const compiler = createCompiler(
        validateComposition(isolationDocument, [
          {
            id: "isolation",
            streams: [
              {
                id: isolationStream.id,
                kind: "audio",
                bounds: { startUs: 0, endUs: 3000000 },
                available: [{ startUs: 0, endUs: 3000000 }],
              },
            ],
          },
        ]),
        name,
      );
      const window = compiler.window({
        range,
        rendition: { sampleRate: 48000, channels: 2 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
      });
      const frames = join(scratch, `${name}-frames.jsonl`);
      writeFileSync(
        frames,
        [...window.frames()].map((frame) => JSON.stringify(frame) + "\n").join(""),
      );
      const audio = {
        range: { start: 0, end: Math.floor((cursor * 48000) / 1000000) },
        clips: [...window.audio()],
      };
      const decoded = [];
      const observations = [];
      for (const [variant, path] of [isolationSource, poisonSource].entries()) {
        const sourceBefore = readFileSync(path);
        const assets = [
          {
            assetId: "isolation",
            streamId: isolationStream.id,
            path,
            originUs: isolationProbe.originUs,
          },
        ];
        const output = join(scratch, `${name}-${variant}.mp4`);
        const receipt = call("media.renderCompositionMovie", {
          output,
          frames,
          range,
          canvas: isolationDocument.canvas,
          settings: resolveOutputSettings(),
          processing: window.processing(),
          assets,
          audio,
        });
        const raw = join(scratch, `${name}-${variant}.native.f32`);
        const inspected = run(inspector, [output, raw]);
        writeFileSync(join(scratch, `${name}-${variant}.native.json`), inspected);
        const av = JSON.parse(inspected);
        const nativePCM = readFileSync(raw);
        const externalPCM = ff("-i", output, "-map", "0:a:0", "-f", "f32le", "pipe:1");
        writeFileSync(join(scratch, `${name}-${variant}.ffmpeg.f32`), externalPCM);
        const reference = call("media.mixCompositionAudio", {
          ...audio,
          assets,
          processing: window.processing(),
          output: join(scratch, `${name}-${variant}.wav`),
        });
        const expected = ff("-i", reference.file, "-f", "f32le", "pipe:1");
        writeFileSync(join(scratch, `${name}-${variant}.reference.f32`), expected);
        const track = av.tracks.find((entry) => entry.type === "soun");
        assert(
          Math.abs(av.durationUs - cursor) < 0.001,
          "Movie presentation keeps the authored microsecond endpoint",
        );
        assert.equal(receipt.audio.frames, audio.range.end);
        assert.equal(track.decodedFrames, receipt.audio.frames);
        assert.equal(track.decodedStartUs, 0);
        assert(Math.abs(track.decodedEndUs - cursor) <= 1000000 / 48000 + 0.001);
        assert.equal(nativePCM.length, expected.length);
        const observation = {
          variant,
          frames: receipt.audio.frames,
          clock: {
            ...inspectMovieClock(output),
            nativeDurationUs: av.durationUs,
            encodedAudio: receipt.encodedAudio,
          },
          av,
          ffmpegFrames: externalPCM.length / 8,
        };
        if (name === "one-sample") {
          observation.nonzeroSample = {
            reference: [expected.readFloatLE(0), expected.readFloatLE(4)],
            native: [nativePCM.readFloatLE(0), nativePCM.readFloatLE(4)],
          };
          const packets = run("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_packets",
            "-of",
            "json",
            output,
          ]);
          writeFileSync(join(scratch, `${name}-${variant}.packets.json`), packets);
          observation.ffmpegPackets = JSON.parse(packets).packets;
          writeFileSync(
            join(scratch, `${name}-${variant}.observations.json`),
            JSON.stringify(observation, null, 2),
          );
          assert.equal(expected.length, 8);
          assert(Math.abs(expected.readFloatLE(0)) > 0.05);
          assert(Math.abs(nativePCM.readFloatLE(0)) > 0.02);
          assert.equal(
            externalPCM.length,
            0,
            "Historical diagnostic: FFmpeg emits no PCM for this sub-packet movie",
          );
        } else {
          const rms = (pcm, shift = 0) => {
            let error = 0,
              count = 0;
            for (let cell = 1000; cell < expected.length / 4 - 1000; cell++) {
              const shifted = cell + shift * 2;
              if (shifted < 0 || shifted >= pcm.length / 4) continue;
              error += (pcm.readFloatLE(shifted * 4) - expected.readFloatLE(cell * 4)) ** 2;
              count++;
            }
            assert(count > 0);
            return Math.sqrt(error / count);
          };
          observation.nativeRms = rms(nativePCM);
          observation.ffmpegRms = rms(externalPCM);
          observation.shiftedRms = [-2112, 2112].map((shift) => ({
            shift,
            rms: rms(externalPCM, shift),
          }));
          writeFileSync(
            join(scratch, `${name}-${variant}.observations.json`),
            JSON.stringify(observation, null, 2),
          );
          assert(observation.nativeRms < 0.01 && observation.ffmpegRms < 0.01);
          for (const shifted of observation.shiftedRms)
            assert(
              shifted.rms > observation.ffmpegRms * 3,
              "AAC priming shifts must be distinguishable",
            );
        }
        assert.deepEqual(
          readFileSync(path),
          sourceBefore,
          "Encoded movie must preserve its selected audio source",
        );
        decoded.push(nativePCM);
        observations.push(observation);
      }
      assert.deepEqual(decoded[0], decoded[1], "Excluded source samples cannot enter encoded AAC");
      checks.push({
        name,
        observations,
        identicalDecodedAAC: true,
        changed: "All excluded source cells replaced by ±0.9",
      });
    }
    const cancelRange = { startUs: 0, endUs: 100000000 };
    const empty = { ...document, tracks: [], clips: [], processing: [] };
    const cancelWindow = createCompiler(validateComposition(empty, []), "cancel").window({
      range: cancelRange,
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const cancelFrames = join(scratch, "cancel-frames.jsonl"),
      cancelRequest = join(scratch, "cancel-request.json");
    writeFileSync(
      cancelFrames,
      [...cancelWindow.frames()].map((frame) => JSON.stringify(frame) + "\n").join(""),
    );
    writeFileSync(
      cancelRequest,
      JSON.stringify({
        output: join(scratch, "cancel.mp4"),
        frames: cancelFrames,
        range: cancelRange,
        canvas: empty.canvas,
        settings: resolveOutputSettings(),
        processing: cancelWindow.processing(),
        assets: [],
        audio: { range: { start: 0, end: 4800000 }, clips: [] },
      }),
    );
    const cancellation = run(
      process.env.YAP_COMPOSITION_VIDEO_TESTS ?? join(dirname(native), "YapCompositionVideoTests"),
      [cancelRequest, "media.renderCompositionMovie"],
    )
      .toString()
      .trim();
    assert(cancellation.startsWith("PASS"));
    checks.push({ cancellation });
    assert(
      readdirSync(scratch).every((name) => !name.startsWith(".yap-output-")),
      "Attempt scratch must be cleaned",
    );
  }
  for (const [index, path] of [picture, tone].entries())
    assert.deepEqual(
      readFileSync(path),
      originalBytes[index],
      "Movie rendering preserves original picture and audio bytes",
    );
  const report = JSON.stringify(
    { nativeProductionEntry: true, liveMediaJourney: false, checks },
    null,
    2,
  );
  writeFileSync(join(scratch, "report.json"), report);
  console.log(report);
  completed = true;
} finally {
  if (!completed || process.env.YAP_KEEP_TEST_FILES) console.error(scratch);
  else rmSync(scratch, { recursive: true, force: true });
}
