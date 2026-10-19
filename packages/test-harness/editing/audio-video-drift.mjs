import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { JourneyService, poll, run, hash } from "./source-evidence-fixture.mjs";
import { digest } from "./audio-project-fixture.mjs";

assert.ok(process.env.YAP_NATIVE, "Use an explicit frozen native worker");
const out = resolve(process.argv[2]);
await mkdir(out);
const home = await mkdtemp(join(tmpdir(), "yap-av-drift-"));
const report = {
  passed: false,
  trace: [],
  scope: "Public CLI/MCP export with decoded A/V markers; timing, not picture or speech quality",
};
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const duration = 15000371,
  edits = 120,
  rate = 48000;
const fps = { numerator: 30000, denominator: 1001 };
const frameUs = (1000000 * fps.denominator) / fps.numerator;
const source = join(out, "markers.mov");
async function ff(args) {
  return run("ffmpeg", ["-v", "error", "-nostdin", ...args], {
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
try {
  // A flash spans 200–300ms; an impulse marks its center. Fractional edit lengths
  // accumulate beyond one picture, exposing per-edit duration rounding.
  await ff([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=32x32:r=30:d=15.034,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,0.2)*lt(t,0.3)'",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(eq(n\\,12000)\\,0.8\\,0):s=48000:d=15.034",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "pcm_s16le",
    source,
  ]);
  report.sourceSha256 = await digest(source);
  report.workerSha256 = hash(await readFile(process.env.YAP_NATIVE));
  await service.start();
  const imported = await call("asset.import", { requestId: "markers", path: source });
  const admission = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (x) => x.state === "ready",
    "import",
  );
  const asset = await call(
    "asset.get",
    { assetId: admission.published.output.assetId },
    { transport: "mcp" },
  );
  const created = await call("project.create", {
    requestId: "drift",
    title: "Thirty-minute A/V edit timing",
    canvas: { width: 32, height: 32, fps, background: "#000000ff" },
  });
  const projectId = created.project.projectId;
  const operations = ["video", "audio"].map((kind) => ({
    operation: "track.add",
    label: kind,
    track: { kind, order: 0 },
  }));
  for (let i = 0; i < edits; i++)
    for (const kind of ["video", "audio"])
      operations.push({
        operation: "place",
        label: `${kind}-${i}`,
        clip: {
          trackId: { label: kind },
          assetId: asset.assetId,
          streamId: asset.streams.find((s) => s.kind === kind && s.decodable).streamId,
          source: { kind: "range", range: { startUs: 0, endUs: duration } },
          placement: {
            kind: "project",
            range: { startUs: i * duration, endUs: (i + 1) * duration },
          },
        },
      });
  const edited = await call("edit.apply", {
    projectId,
    requestId: "repeat-markers",
    expectedRevisionId: created.revision.revisionId,
    operations,
  });
  const exportId = randomUUID();
  await call(
    "export.create",
    {
      projectId,
      revisionId: edited.revision.revisionId,
      kind: "video",
      requestId: exportId,
      directory: out,
      leaf: "long.mp4",
    },
    { transport: "mcp" },
  );
  const deadline = performance.now() + 600000;
  let exported;
  for (;;) {
    exported = await call("export.status", { exportId });
    if (exported.state === "ready") break;
    assert.ok(
      !["failed", "canceled", "unavailable"].includes(exported.state),
      JSON.stringify(exported),
    );
    assert.ok(performance.now() < deadline, "Ten-minute export deadline");
    await delay(1000);
  }
  report.export = exported;
  assert.equal(await digest(exported.output), exported.receipt.sha256);
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time,pkt_duration_time",
      "-of",
      "json",
      exported.output,
    ],
    { timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
  );
  const frames = JSON.parse(stdout).frames;
  await ff([
    "-i",
    exported.output,
    "-map",
    "0:v:0",
    "-vf",
    "scale=1:1:flags=area",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    join(out, "pictures.gray"),
  ]);
  const pixels = await readFile(join(out, "pictures.gray"));
  assert.equal(pixels.length, frames.length);
  const expectedDurationUs = edits * duration;
  assert.equal(frames.length, Math.ceil(expectedDurationUs / frameUs));
  // Preserve real output timestamps; the oracle does not assume decoder frame index is time.
  const flashes = [];
  for (let i = 0; i < pixels.length; i++)
    if (pixels[i] > 200) {
      const first = i;
      while (i + 1 < pixels.length && pixels[i + 1] > 200) i++;
      const start = Number(frames[first].best_effort_timestamp_time) * 1000000;
      const end = Number(frames[i].best_effort_timestamp_time) * 1000000 + frameUs;
      flashes.push({ startUs: start, endUs: end, centerUs: (start + end) / 2 });
    }
  assert.equal(flashes.length, edits);
  const raw = join(out, "audio.f32");
  await ff([
    "-i",
    exported.output,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(rate),
    "-f",
    "f32le",
    raw,
  ]);
  const audio = await open(raw);
  const expectedAudioFrames = Math.floor((expectedDurationUs * rate) / 1000000);
  const decodedAudioFrames = (await audio.stat()).size / 4;
  assert.ok(
    decodedAudioFrames >= expectedAudioFrames && decodedAudioFrames - expectedAudioFrames < 1024,
    "AAC decoded tail must be within one packet of the exact authored PCM count",
  );
  const metadata = JSON.parse(
    (await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", exported.output])).stdout,
  );
  const audioTrack = metadata.streams.find((x) => x.codec_type === "audio");
  const videoTrack = metadata.streams.find((x) => x.codec_type === "video");
  assert.equal(audioTrack.start_time, "0.000000");
  assert.equal(videoTrack.start_time, "0.000000");
  assert.equal(audioTrack.time_base, "1/48000");
  assert.equal(audioTrack.duration_ts, expectedAudioFrames);
  assert.equal(Number(videoTrack.duration) * 1000000, expectedDurationUs);
  report.audioDuration = {
    expectedAudioFrames,
    declaredFrames: audioTrack.duration_ts,
    decodedAudioFrames,
    decoderTailPaddingFrames: decodedAudioFrames - expectedAudioFrames,
  };
  const markers = [];
  try {
    for (let i = 0; i < edits; i++) {
      const expectedUs = i * duration + 250000;
      const expectedSample = Math.floor((i * duration * rate) / 1000000) + 12000;
      const bytes = Buffer.alloc(289 * 4);
      const { bytesRead } = await audio.read(bytes, 0, bytes.length, (expectedSample - 144) * 4);
      assert.equal(bytesRead, bytes.length);
      let peak = 0,
        found = -1;
      for (let n = 0; n < 289; n++)
        if (Math.abs(bytes.readFloatLE(n * 4)) > peak) {
          peak = Math.abs(bytes.readFloatLE(n * 4));
          found = expectedSample - 144 + n;
        }
      assert.ok(
        peak > 0.25 && Math.abs(found - expectedSample) <= 2,
        `Audio marker ${i}: ${found} expected ${expectedSample}, peak ${peak}`,
      );
      const audioUs = (found * 1000000) / rate,
        picture = flashes[i];
      assert.ok(Math.abs(picture.centerUs - expectedUs) <= frameUs, `Video marker ${i} misplaced`);
      assert.ok(Math.abs(audioUs - picture.centerUs) <= frameUs, `A/V drift at edit ${i}`);
      markers.push({
        edit: i,
        expectedUs,
        audioSample: found,
        peak,
        video: picture,
        driftUs: audioUs - picture.centerUs,
      });
    }
  } finally {
    await audio.close();
  }
  report.timing = {
    expectedDurationUs,
    outputFrames: frames.length,
    fps,
    maximumAllowedDriftUs: frameUs,
    maximumObservedDriftUs: Math.max(...markers.map((x) => Math.abs(x.driftUs))),
    markers,
  };
  assert.equal(await digest(source), report.sourceSha256);
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      timing: report.timing && { ...report.timing, markers: report.timing.markers.length },
    },
    null,
    2,
  ),
);
