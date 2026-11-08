import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { nativeResult, mediaWorker } from "../../apps/service/dist/worker.js";
import { startProjectService } from "../../apps/service/dist/project-service.js";
import { withRenderAttempt } from "../../apps/service/dist/render.js";
import { journalRows } from "../../apps/macos/tests/fixtures/generated-capture.mjs";
import { importAcquisition } from "../../apps/macos/tests/fixtures/public-service.mjs";
import { renderFrames } from "../../helpers/mac/Tests/fixtures/render-frames.mjs";
const execute = promisify(execFile);
const native =
  process.env.YAP_NATIVE ??
  new URL("../../helpers/mac/.build/debug/yap-native", import.meta.url).pathname;
async function command(executable, args) {
  return (await execute(executable, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error("Timing lab made no progress");
}
async function decode(file, frames) {
  const raw = file + ".rgb";
  const metadata = JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-show_entries",
      "frame=pts_time",
      "-select_streams",
      "v",
      "-of",
      "json",
      file,
    ]),
  );
  await command("ffmpeg", [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-i",
    file,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-fps_mode",
    "passthrough",
    raw,
  ]);
  const pixels = await readFile(raw),
    size = frames[0].length,
    identities = [];
  for (let offset = 0; offset < pixels.length; offset += size) {
    const errors = frames.map((frame) => {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.abs(frame[i] - pixels[offset + i]);
      return sum / size;
    });
    const best = Math.min(...errors);
    assert.ok(best < 12);
    identities.push(errors.indexOf(best));
  }
  return {
    durationUs: Math.round(Number(metadata.format.duration) * 1e6),
    identities,
    pts: metadata.frames.map((frame) => Math.round(Number(frame.pts_time) * 1e6)),
  };
}
async function compareAudio(movie, wave, expectedFrames) {
  const metadata = JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels",
      "-of",
      "json",
      movie,
    ]),
  );
  assert.deepEqual(metadata.streams, [{ codec_name: "aac", sample_rate: "48000", channels: 2 }]);
  const paths = [];
  for (const [file, suffix] of [
    [movie, ".aac.f32"],
    [wave, ".pcm.f32"],
  ]) {
    const output = file + suffix;
    await command("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "f32le", output]);
    const bytes = await readFile(output);
    paths.push(
      new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    );
  }
  const [actual, expected] = paths;
  assert.equal(expected.length, expectedFrames * 2);
  assert.ok(actual.length >= expected.length && actual.length < expected.length + 2048);
  let squared = 0;
  for (let i = 1000; i < expected.length - 1000; i++) squared += (actual[i] - expected[i]) ** 2;
  const rms = Math.sqrt(squared / (expected.length - 2000));
  assert.ok(rms < 0.01, `Pinned movie AAC differs from retained PCM: ${rms}`);
  return { presentationFrames: expectedFrames, independentlyDecodedFrames: actual.length / 2, rms };
}
test(
  "explicit project movie retains exact pictures, captured audio support and AAC through undo and late cancellation",
  { timeout: 60000 },
  async () => {
    const evidence = process.env.YAP_RENDER_TIMING_EVIDENCE;
    const home = evidence ?? (await mkdtemp(join(tmpdir(), "yap-render-timing-")));
    assert.ok(isAbsolute(home));
    await mkdir(home, { recursive: true });
    assert.deepEqual(await readdir(home), []);
    const source = join(home, "source.mov"),
      frames = renderFrames();
    await writeFile(join(home, "source.rgb"), Buffer.concat(frames));
    await command("ffmpeg", [
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgb24",
      "-video_size",
      "320x180",
      "-framerate",
      "1",
      "-i",
      join(home, "source.rgb"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "2",
      "-an",
      source,
    ]);
    for (const [role, expression] of [
      ["narration", "0.1*sin(2*PI*(170*t+31*t*t))"],
      ["system", "0.1*sin(2*PI*400*t)"],
    ])
      await command("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${expression}:s=48000:d=6`,
        "-c:a",
        "pcm_f32le",
        join(home, role + ".mov"),
      ]);
    const audioBefore = await Promise.all(
      ["narration", "system"].map((role) => readFile(join(home, role + ".mov"))),
    );
    const sourceBefore = await readFile(source);
    const sourceId = randomUUID(),
      donor = join(home, "authored-capture");
    await mkdir(donor);
    await copyFile(source, join(donor, "video.mov"));
    for (const role of ["narration", "system"])
      await copyFile(join(home, `${role}.mov`), join(donor, `${role}.mov`));
    const pause = { kind: "pause", atSourceUs: 3000000, elapsedPauseUs: 60000000 };
    const rows = journalRows({
      sourceId,
      width: 320,
      height: 180,
      samples: [
        {
          sourceUs: 500000,
          x: -10,
          y: -10,
          globalX: -10,
          globalY: -10,
          buttons: 0,
          eligibility: "outside",
          geometryEpoch: 1,
        },
      ],
      pauses: [pause],
    });
    rows[0].data.microphone = true;
    rows[0].data.systemAudio = true;
    rows.splice(
      rows.length - 1,
      0,
      { event: "audioSamples", data: { role: "narration", startUs: 0, endUs: 3250000 } },
      { event: "audioSamples", data: { role: "narration", startUs: 3750000, endUs: 6000000 } },
      { event: "audioSamples", data: { role: "system", startUs: 0, endUs: 6000000 } },
    );
    await writeFile(
      join(donor, "capture.journal.jsonl"),
      rows.map((row, i) => JSON.stringify({ sequence: i + 1, ...row }) + "\n").join(""),
    );
    const gate = Promise.withResolvers(),
      started = Promise.withResolvers();
    const run = mediaWorker({ YAP_NATIVE: native });
    const report = {
      kind: "current project movie numerical and late-publication contract",
      renders: [],
      lifetime: [],
    };
    const lateEntered = Promise.withResolvers(),
      lateRelease = Promise.withResolvers();
    let firstMovie = true,
      armLate = false,
      service;
    const worker = async (operation, params, options) => {
      if (operation === "media.renderCompositionMovie" && firstMovie) {
        firstMovie = false;
        started.resolve();
        await gate.promise;
        assert.ok(params.pointers, "Explicit pointer step must supply its prepared receipt");
        await mkdir(join(home, "refused-attempts"), { mode: 0o700 });
        await assert.rejects(
          withRenderAttempt(
            run,
            join(home, "refused-attempts"),
            options.signal,
            async (directory, execute) =>
              nativeResult(
                await execute(
                  operation,
                  {
                    ...params,
                    output: join(directory, "refused.mp4"),
                    pointers: { ...params.pointers, sha256: "0".repeat(64) },
                  },
                  options,
                ),
              ),
            async () => assert.fail("Corrupt pointer receipt was consumed"),
          ),
          { code: "INVALID_REQUEST" },
        );
        assert.deepEqual(await readdir(join(home, "refused-attempts")), []);
        report.pointerReceiptChecked = true;
      }
      const late = operation === "media.renderCompositionMovie" && armLate;
      if (late) armLate = false;
      const result = await run(operation, params, options);
      if (late) {
        assert.equal(result.ok, true, JSON.stringify(result));
        report.lifetime.push({ kind: "late-job-cancel", actualNativeReply: true, consumed: false });
        lateEntered.resolve();
        await lateRelease.promise;
      }
      return result;
    };
    service = await startProjectService({ home, worker });
    const endpoint = {
      call: (operation, params) =>
        callLocal(service.socketPath, { id: randomUUID(), operation, params }),
    };
    const call = async (operation, params = {}) => {
      const reply = await endpoint.call(operation, params);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.data;
    };
    const completed = (jobId) =>
      until(async () => {
        const job = await call("job.get", { jobId });
        if (["failed", "unavailable", "canceled"].includes(job.state))
          throw Error(JSON.stringify(job));
        return job.state === "ready" && job;
      });
    const preview = async (params) => {
      const admitted = await call("preview.get", params);
      await completed(admitted.jobId);
      if (admitted.delivery) await call("artifact.close", { token: admitted.delivery.token });
      const ready = await call("preview.get", params);
      assert.equal(ready.state, "ready");
      return ready;
    };
    try {
      const { acquisition } = await importAcquisition(endpoint, donor);
      const binding = (role) => {
        const binding = acquisition.bindings.find((binding) => binding.sourceRoles.includes(role));
        assert.ok(binding);
        return {
          assetId: binding.assetId,
          streamId: binding.streamId,
          acquisitionId: acquisition.id,
        };
      };
      const created = await call("project.create", {
        requestId: "timing-project",
        canvas: {
          width: 320,
          height: 180,
          fps: { numerator: 1, denominator: 1 },
          background: "#000000ff",
        },
      });
      const projectId = created.project.projectId;
      const placed = await call("edit.apply", {
        projectId,
        expectedRevisionId: created.revision.revisionId,
        requestId: "tracks",
        operations: [
          ...["video", "narration", "system"].map((role, order) => ({
            operation: "track.add",
            label: role,
            track: { kind: role === "video" ? "video" : "audio", order },
          })),
          ...["video", "narration", "system"].flatMap((role) => [
            {
              operation: "place",
              label: `${role}-clip`,
              clip: {
                trackId: { label: role },
                ...binding(role),
                source: { kind: "range", range: { startUs: 0, endUs: 6000000 } },
                placement: { kind: "project", range: { startUs: 0, endUs: 6000000 } },
              },
            },
            {
              operation: "processing.set",
              target: { kind: "clip", id: { label: `${role}-clip` } },
              steps: [
                {
                  processor:
                    role === "video"
                      ? { type: "pointer", trailUs: 0 }
                      : { type: "gain", gain: 0.5 },
                },
              ],
            },
          ]),
        ],
      });
      const trackIds = ["video", "narration", "system"].map((role) => placed.edit.labels[role]);
      const cut = await call("edit.apply", {
        projectId,
        expectedRevisionId: placed.revision.revisionId,
        requestId: "cut",
        operations: [
          {
            operation: "remove",
            clipIds: ["video", "narration", "system"].map(
              (role) => placed.edit.labels[`${role}-clip`],
            ),
            ranges: [
              { startUs: 2000000, endUs: 3000000 },
              { startUs: 4000000, endUs: 5000000 },
            ],
            ripple: { trackIds },
          },
        ],
      });
      const first = await call("preview.get", { projectId, revisionId: cut.revision.revisionId });
      await started.promise;
      const undo = await call("edit.undo", {
        projectId,
        expectedRevisionId: cut.revision.revisionId,
        requestId: "undo",
      });
      assert.notEqual(undo.id, first.revisionId);
      gate.resolve();
      const save = async (params, expected) => {
        const retained = await preview(params);
        try {
          const video = retained.published.output;
          const file = join(home, `${retained.revisionId}.mp4`);
          await copyFile(video.file, file);
          const decoded = await decode(file, frames);
          assert.deepEqual(decoded, expected);
          assert.ok(video.audio);
          assert.equal(video.audio.frames, (video.durationUs * 48000) / 1000000);
          const pcmPending = await call("audio.get", {
            projectId,
            revisionId: retained.revisionId,
          });
          await completed(pcmPending.jobId);
          if (pcmPending.delivery)
            await call("artifact.close", { token: pcmPending.delivery.token });
          const pcm = await call("audio.get", { projectId, revisionId: retained.revisionId });
          try {
            assert.equal(pcm.published.output.frames, video.audio.frames);
            const audio = await compareAudio(file, pcm.published.output.file, video.audio.frames);
            report.renders.push({
              revisionId: retained.revisionId,
              file: basename(file),
              decoded,
              audio,
            });
          } finally {
            await call("artifact.close", { token: pcm.delivery.token });
          }
          return { retained, file };
        } finally {
          await call("artifact.close", { token: retained.delivery.token });
        }
      };
      const firstSaved = await save(
        { projectId, revisionId: first.revisionId },
        { durationUs: 4000000, identities: [0, 1, 3, 5], pts: [0, 1000000, 2000000, 3000000] },
      );
      const secondSaved = await save(
        { projectId },
        {
          durationUs: 6000000,
          identities: [0, 1, 2, 3, 4, 5],
          pts: [0, 1000000, 2000000, 3000000, 4000000, 5000000],
        },
      );
      assert.equal(secondSaved.retained.revisionId, undo.id);
      const replay = await preview({ projectId, revisionId: first.revisionId });
      try {
        assert.deepEqual(replay.published, firstSaved.retained.published);
        assert.deepEqual(
          await decode(replay.published.output.file, frames),
          report.renders[0].decoded,
        );
      } finally {
        await call("artifact.close", { token: replay.delivery.token });
      }
      assert.deepEqual(await readdir(join(home, "library", "render")), []);
      // A changed explicit revision permits observing late cancellation without reusing a cached movie.
      const next = await call("edit.apply", {
        projectId,
        expectedRevisionId: undo.id,
        requestId: "late-cancel",
        operations: [{ operation: "canvas.set", canvas: { background: "#010101ff" } }],
      });
      armLate = true;
      const pending = await call("preview.get", {
        projectId,
        revisionId: next.revision.revisionId,
      });
      await lateEntered.promise;
      const renderingJob = await call("job.get", { jobId: pending.jobId });
      const canceling = call("job.cancel", { jobId: pending.jobId });
      void canceling.catch(() => {});
      await until(
        async () => (await call("job.get", { jobId: pending.jobId })).state === "canceled",
      );
      lateRelease.resolve();
      await canceling;
      const canceled = await call("preview.get", {
        projectId,
        revisionId: next.revision.revisionId,
      });
      assert.equal(canceled.published, null);
      assert.equal(canceled.state, "idle");
      assert.equal(canceled.jobId, pending.jobId);
      const canceledJob = await call("job.get", { jobId: pending.jobId });
      assert.equal(canceledJob.state, "canceled");
      assert.equal(canceledJob.generation, renderingJob.generation);
      assert.equal(
        report.renders.some((render) => render.revisionId === next.revision.revisionId),
        false,
      );
      assert.deepEqual(await readdir(join(home, "library", "render")), []);
      for (const role of ["narration", "system"]) {
        assert.deepEqual(
          await readFile(join(donor, `${role}.mov`)),
          audioBefore[role === "narration" ? 0 : 1],
        );
        assert.deepEqual(
          await readFile(join(home, `${role}.mov`)),
          audioBefore[role === "narration" ? 0 : 1],
        );
      }
      assert.deepEqual(await readFile(source), sourceBefore);
      assert.deepEqual(await readFile(join(donor, "video.mov")), sourceBefore);
      await writeFile(join(home, "report.json"), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          home,
          renders: report.renders.map((render) => render.decoded),
          lifetime: report.lifetime,
        }),
      );
    } finally {
      gate.resolve();
      lateRelease.resolve();
      await service.close();
      if (!evidence) await rm(home, { recursive: true, force: true });
    }
  },
);
