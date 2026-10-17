import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

/** Match the same authored codec/clock/PCM/replay fixture on scratch or installed transport. */
export async function verifyVideoDelivery({ call, out, ffmpeg, ffprobe, report, env }) {
  const source = join(root, "specs/done/agent-editing/assets/00-corpus/a.mov");
  report.sourceSha256 = hash(await readFile(source));
  report.ffmpegSha256 = hash(await readFile(ffmpeg));
  report.ffprobeSha256 = hash(await readFile(ffprobe));
  report.operands = {};
  const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  // Stereo Float32 impulses expose channel identity, delay and AAC packet tails.
  const wave = Buffer.alloc(44 + 48000 * 8);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(3, 20);
  wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(48000, 24);
  wave.writeUInt32LE(384000, 28);
  wave.writeUInt16LE(8, 32);
  wave.writeUInt16LE(32, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  wave.writeFloatLE(0.8, 44 + 4800 * 8);
  wave.writeFloatLE(0.4, 44 + 4800 * 8 + 4);
  const audio = join(out, "impulse.wav");
  await writeFile(audio, wave);
  report.audioSha256 = hash(wave);
  report.capabilities = await call("output.capabilities", { kind: "video" });
  const assets = [];
  for (const [path, kind] of [
    [source, "video"],
    [audio, "audio"],
  ]) {
    const imported = await call("asset.import", { requestId: randomUUID(), path });
    const ready = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (v) => v.state === "ready",
      kind,
    );
    const asset = await call("asset.get", { assetId: ready.published.output.assetId });
    assets.push({ asset, stream: asset.streams.find((s) => s.kind === kind) });
  }
  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = project.project.projectId;
  const placed = await call("edit.apply", {
    requestId: randomUUID(),
    projectId,
    expectedRevisionId: project.revision.id,
    operations: assets.flatMap(({ asset, stream }, i) => [
      {
        operation: "track.add",
        label: "track" + i,
        track: { kind: i ? "audio" : "video", order: 0 },
      },
      {
        operation: "place",
        clip: {
          trackId: { label: "track" + i },
          assetId: asset.id,
          streamId: stream.id,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: {
            kind: "project",
            range: { startUs: i ? 250000 : 0, endUs: i ? 1250000 : 1000000 },
          },
        },
      },
    ]),
  });
  const revisionId = placed.revision.id;
  for (const codec of ["h264", "hevc"]) {
    const request = {
      projectId,
      revisionId,
      exportId: randomUUID(),
      kind: "video",
      directory: out,
      leaf: codec + ".mp4",
      settings: { video: { codec } },
    };
    const admitted = await call("export.create", request);
    const receipt = await poll(
      () => call("export.status", { exportId: request.exportId }),
      (v) => v.state === "ready" && !v.cleanupPending,
      codec,
    );
    const path = receipt.output;
    const probe = JSON.parse(
      (
        await run(ffprobe, ["-v", "error", "-show_streams", "-show_frames", "-of", "json", path], {
          timeout: 30000,
          env,
        })
      ).stdout,
    );
    const bytes = Buffer.from(
      (
        await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "pipe:1"], {
          encoding: "buffer",
          timeout: 30000,
          env,
        })
      ).stdout,
    );
    const audioMarkers = [0, 1].map((channel) => {
      let peak = 0,
        position = -1;
      for (let i = 0; i < bytes.length / 8; i++) {
        const value = Math.abs(bytes.readFloatLE(i * 8 + channel * 4));
        if (value > peak) {
          peak = value;
          position = i;
        }
      }
      return { peak, position };
    });
    report.operands[codec] = {
      request,
      admitted,
      receipt,
      probe,
      audioMarkers,
      decodedAudioFrames: bytes.length / 8,
      sha256: hash(await readFile(path)),
    };
    await save();
    const video = probe.streams.find((s) => s.codec_type === "video");
    const encodedAudio = probe.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.codec_name, codec);
    assert.equal(video.profile, codec === "hevc" ? "Main" : "High");
    assert.equal(video.color_primaries, "bt709");
    assert.equal(video.color_transfer, "bt709");
    assert.equal(video.color_space, "bt709");
    assert.equal(Math.round(Number(video.duration) * 1000000), 1250000);
    assert.deepEqual(
      probe.frames
        .filter((f) => f.media_type === "video")
        .map((f) => Math.round(Number(f.best_effort_timestamp_time) * 1000000)),
      Array.from({ length: 10 }, (_, i) => i * 125000),
    );
    assert.equal(encodedAudio.codec_name, "aac");
    assert.equal(encodedAudio.duration_ts, 60000);
    assert.ok(bytes.length / 8 >= 60000 && bytes.length / 8 - 60000 < 1024);
    for (const [channel, marker] of audioMarkers.entries()) {
      assert.ok(marker.peak > (channel ? 0.1 : 0.2));
      assert.ok(Math.abs(marker.position - 16800) <= 2);
    }
    const replay = await call("export.create", request);
    assert.equal(replay.exportId, request.exportId);
    assert.equal(hash(await readFile(path)), report.operands[codec].sha256);
  }
  assert.equal(hash(await readFile(source)), report.sourceSha256);
  report.passed = true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  assert.ok(values.out && process.env.YAP_NATIVE, "Pass --out NEW_DIRECTORY and YAP_NATIVE");
  const out = resolve(values.out);
  await mkdir(out);
  const home = await mkdtemp("/tmp/yap-hevc-public-");
  const ffmpeg = join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
  const ffprobe = join(root, "helpers/ffmpeg/.build/distribution/bin/ffprobe");
  const report = {
    passed: false,
    trace: [],
    exchanges: [],
    nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  };
  const service = new JourneyService(home, report);
  const call = service.call.bind(service);
  const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  try {
    await service.start();
    await verifyVideoDelivery({ call, out, ffmpeg, ffprobe, report });
  } finally {
    try {
      await save();
    } finally {
      try {
        await service.stop();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }
  console.log(JSON.stringify({ passed: report.passed, out, codecs: Object.keys(report.operands) }));
}
