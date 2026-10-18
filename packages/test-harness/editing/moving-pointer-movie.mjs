import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  startPublicService,
  importAcquisition,
  until,
} from "../../../apps/macos/tests/fixtures/public-service.mjs";

const run = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = new URL("../../../", import.meta.url).pathname;
const sourceSHA = "c21c9bc0a04591563532d310d366d8a245a77e1386859f7422f80778b23265e0";
const times = [1000000, 1100000, 1200000];
const points = [
  { x: 64, y: 40 },
  { x: 84, y: 44 },
  { x: 84, y: 44 },
];
const width = 320,
  height = 180;

// Existing encoded pointer core criterion, restricted to the authored glyph neighborhood
// because this source has other white text. The complete images remain comparison operands.
function core(bytes, point) {
  let count = 0,
    sumX = 0,
    sumY = 0;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = point.y - 5; y < point.y + 25; y++)
    for (let x = point.x - 5; x < point.x + 25; x++) {
      const offset = (y * width + x) * 4;
      if ([0, 1, 2].every((channel) => bytes[offset + channel] > 220)) {
        count++;
        sumX += x;
        sumY += y;
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    }
  return { count, bounds, centroid: { x: sumX / count, y: sumY / count } };
}
function matchesCore(actual, expected) {
  assert.ok(actual.count > 5, "Movie lost white pointer core");
  assert.deepEqual(actual.bounds, expected.bounds, "Encoded pointer bounds differ");
  assert.ok(
    Math.abs(actual.centroid.x - expected.centroid.x) < 1 &&
      Math.abs(actual.centroid.y - expected.centroid.y) < 1,
    "Encoded pointer core phase differs",
  );
}
function difference(a, b) {
  let changed = 0,
    maximum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    changed += d > 0;
    maximum = Math.max(maximum, d);
  }
  return { changedChannels: changed, maximum };
}

test(
  "current movie moves an authored pointer while holding the same source picture",
  { timeout: 120000 },
  async () => {
    assert.ok(process.env.YAP_NATIVE, "Pin the current worker explicitly");
    const retained = process.env.YAP_POINTER_MOVIE_EVIDENCE;
    const out = retained
      ? resolve(retained)
      : await mkdtemp(join(tmpdir(), "pointer-movie-output-"));
    await mkdir(out, { recursive: true, mode: 0o700 });
    assert.deepEqual(await readdir(out), []);
    const home = await mkdtemp(join(tmpdir(), "sr-pointer-movie-"));
    const report = {
      passed: false,
      requests: [],
      commands: [],
      sourceSHA,
      times,
      points,
      control: null,
    };
    let service;
    const leases = new Set();
    const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2));
    const command = async (executable, args) => {
      const record = { executable, args, start: new Date().toISOString() };
      report.commands.push(record);
      try {
        const result = await run(executable, args, { timeout: 30000, maxBuffer: 8 * 1024 ** 2 });
        record.stdout = result.stdout;
        record.stderr = result.stderr;
        record.exit = 0;
        return result.stdout;
      } catch (error) {
        record.exit = error.code;
        record.stdout = error.stdout;
        record.stderr = error.stderr;
        throw error;
      } finally {
        record.end = new Date().toISOString();
        await save("report.json", report);
      }
    };
    const call = async (operation, params) => {
      const reply = await service.call(operation, params);
      report.requests.push({ operation, params: structuredClone(params), reply });
      await save("report.json", report);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      if (reply.data.delivery) leases.add(reply.data.delivery.token);
      return reply.data;
    };
    const close = async (token) => {
      await call("artifact.close", { token });
      leases.delete(token);
    };
    const ready = async (operation, params) => {
      const first = await call(operation, params);
      if (first.delivery) await close(first.delivery.token);
      if (first.jobId)
        await until(
          async () => {
            const job = await call("job.get", { jobId: first.jobId });
            assert.ok(
              !["failed", "canceled", "unavailable"].includes(job.state),
              JSON.stringify(job),
            );
            return job.state === "ready";
          },
          `${operation} did not become ready`,
          15000,
        );
      const result = await call(operation, params);
      assert.equal(result.state, "ready");
      assert.ok(result.delivery);
      return result;
    };
    try {
      const inputs = join(out, "inputs");
      await mkdir(inputs);
      const prefix = "default-gate-recovery-e9090034/retained-generated-render-timing/";
      await command("tar", [
        "-xzf",
        join(
          root,
          "specs/done/agent-editing/assets/23-owner-fixture-ports/default-gate-recovery-evidence.tar.gz",
        ),
        "-C",
        inputs,
        prefix + "authored-capture/video.mov",
        prefix + "source.rgb",
      ]);
      const source = join(inputs, prefix, "authored-capture/video.mov");
      const sourceBytes = await readFile(source);
      assert.equal(sha(sourceBytes), sourceSHA);
      const sourceRGB = await readFile(join(inputs, prefix, "source.rgb"));
      assert.equal(sourceRGB.length, width * height * 3 * 6);
      report.sourceRGBSHA = sha(sourceRGB);
      report.workerSHA = sha(await readFile(process.env.YAP_NATIVE));
      const donor = join(home, "donor");
      await mkdir(donor, { mode: 0o700 });
      await copyFile(source, join(donor, "video.mov"));
      const rows = [
        {
          event: "header",
          data: {
            schemaVersion: 1,
            sessionID: "authored-moving-pointer",
            source: { kind: "window", windowID: 7 },
            width,
            height,
            microphone: false,
            systemAudio: false,
          },
        },
        { event: "origin", data: { hostUs: 1000000 } },
        {
          event: "geometry",
          data: {
            epoch: 1,
            hostUs: 1000000,
            sourceUs: 0,
            geometry: {
              outputWidth: width,
              outputHeight: height,
              contentScale: 1,
              scaleFactor: 1,
              contentRect: { x: 0, y: 0, width, height },
            },
          },
        },
        {
          event: "cursorSamples",
          data: {
            samples: points.slice(0, 2).map((point, i) => ({
              sourceUs: times[i],
              ...point,
              globalX: point.x,
              globalY: point.y,
              buttons: 0,
              eligibility: "inside",
              geometryEpoch: 1,
            })),
          },
        },
        { event: "finished", data: { state: "complete", durationUs: 6000000 } },
        { event: "lifecycle", data: { state: "complete" } },
      ];
      const journal = rows
        .map((row, i) => JSON.stringify({ ...row, sequence: i + 1 }) + "\n")
        .join("");
      await writeFile(join(donor, "capture.journal.jsonl"), journal);
      await writeFile(join(out, "authored-journal.jsonl"), journal);
      const pixels = join(out, "frame-pixels");
      await command("swiftc", [
        "-parse-as-library",
        join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
        "-o",
        pixels,
      ]);
      const normalized = async (file) => {
        const raw = file + ".rgba";
        const receipt = JSON.parse(await command(pixels, [file, raw]));
        await save(file.slice(out.length + 1) + ".pixels.json", receipt);
        assert.deepEqual([receipt.width, receipt.height], [width, height]);
        const bytes = await readFile(raw);
        assert.equal(bytes.length, width * height * 4);
        return bytes;
      };
      service = await startPublicService(home, process.env.YAP_NATIVE);
      const imported = await importAcquisition(
        { call: async (op, params) => ({ ok: true, data: await call(op, params) }) },
        donor,
      );
      report.acquisition = imported;
      const binding = imported.acquisition.bindings.find((item) =>
        item.sourceRoles.includes("video"),
      );
      assert.ok(binding);
      assert.equal(binding.assetId, sourceSHA);
      const asset = await call("asset.get", { assetId: binding.assetId });
      const managedSource = join(home, "library/assets", asset.fileName);
      report.admittedSourceSHA = sha(await readFile(managedSource));
      assert.equal(report.admittedSourceSHA, sourceSHA);
      const created = await call("project.create", {
        requestId: "moving-pointer-project",
        canvas: {
          width,
          height,
          fps: { numerator: 10, denominator: 1 },
          background: "#000000ff",
        },
      });
      const projectId = created.project.projectId;
      const clean = await call("edit.apply", {
        projectId,
        expectedRevisionId: created.revision.revisionId,
        requestId: "video",
        operations: [
          { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
          {
            operation: "place",
            label: "clip",
            clip: {
              assetId: binding.assetId,
              streamId: binding.streamId,
              acquisitionId: imported.acquisition.id,
              trackId: { label: "video" },
              source: { kind: "range", range: { startUs: 0, endUs: 6000000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 6000000 } },
            },
          },
        ],
      });
      const range = { startUs: 1000000, endUs: 1300000 };
      const capture = async (name, revisionId) => {
        const selection = { projectId, revisionId };
        const receipt = await ready("preview.get", { ...selection, range });
        const movie = join(out, name + ".mp4");
        try {
          await copyFile(receipt.published.output.file, movie);
        } finally {
          await close(receipt.delivery.token);
        }
        await save(name + "-receipt.json", receipt);
        const frameMeta = JSON.parse(
          await command("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:frame=pts_time",
            "-of",
            "json",
            movie,
          ]),
        );
        await command("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-i",
          movie,
          "-fps_mode",
          "passthrough",
          join(out, name + "-%02d.png"),
          "-map",
          "0:v:0",
          "-pix_fmt",
          "rgb24",
          "-fps_mode",
          "passthrough",
          "-f",
          "rawvideo",
          join(out, name + ".rgb"),
        ]);
        const samples = [];
        const rawRGB = await readFile(join(out, name + ".rgb"));
        assert.equal(rawRGB.length, width * height * 3 * times.length);
        for (let i = 0; i < times.length; i++) {
          const png = join(out, `${name}-frame-${i}.png`);
          const frame = await ready("frame.get", {
            ...selection,
            atUs: times[i],
            maxLongEdge: width,
          });
          try {
            await copyFile(frame.published.output.file, png);
          } finally {
            await close(frame.delivery.token);
          }
          await save(`${name}-frame-${i}-receipt.json`, frame);
          const decoded = join(out, `${name}-${String(i + 1).padStart(2, "0")}.png`);
          const movieRGBA = await normalized(decoded),
            frameRGBA = await normalized(png);
          samples.push({ png, decoded, movieRGBA, frameRGBA, frame });
        }
        const summary = {
          revisionId,
          receipt,
          frameMeta,
          samples: samples.map((sample, i) => ({
            atUs: times[i],
            movieCore: core(sample.movieRGBA, points[i]),
            pngCore: core(sample.frameRGBA, points[i]),
            fullMoviePNGDifference: difference(sample.movieRGBA, sample.frameRGBA),
            movieRGBA: sha(sample.movieRGBA),
            pngRGBA: sha(sample.frameRGBA),
          })),
        };
        await save(name + "-operands.json", summary);
        return { samples, summary, rawRGB };
      };
      const a = await capture("clean", clean.revision.revisionId);
      // A missing-pointer movie must fail the exact same visual predicate, without another render.
      assert.throws(
        () =>
          matchesCore(core(a.samples[0].movieRGBA, points[0]), {
            bounds: [65, 43, 69, 52],
            centroid: { x: 66, y: 46 },
          }),
        /Movie lost white pointer core/,
      );
      report.control = {
        kind: "missing-pointer",
        rejected: true,
        operand: "clean-01.png",
        expected: "Movie lost white pointer core",
      };
      await save("report.json", report);
      const pointed = await call("edit.apply", {
        projectId,
        expectedRevisionId: clean.revision.revisionId,
        requestId: "pointer",
        operations: [
          {
            operation: "processing.set",
            target: { kind: "clip", id: clean.edit.labels.clip },
            steps: [{ processor: { type: "pointer", trailUs: 0 } }],
          },
        ],
      });
      const b = await capture("pointer", pointed.revision.revisionId);
      for (const item of [a, b]) {
        assert.equal(Math.round(Number(item.summary.frameMeta.format.duration) * 1e6), 300000);
        assert.deepEqual(
          item.summary.frameMeta.frames.map((frame) => Math.round(Number(frame.pts_time) * 1e6)),
          [0, 100000, 200000],
        );
        assert.equal(item.summary.receipt.published.output.frameCount, 3);
        for (const [i, sample] of item.samples.entries()) {
          const frame = sample.frame.published.output;
          assert.equal(frame.frame.sampleAtUs, times[i]);
          assert.equal(frame.pictures[0].requestedSourceUs, times[i]);
          const physical = frame.pictures[0];
          assert.equal(physical.actualSourceUs, 1000000);
          assert.equal(physical.assetId, sourceSHA);
          assert.equal(Number(physical.sample.value) / physical.sample.timescale, 1);
          assert.equal(physical.sample.originUs, 0);
          report.physical ??= [];
          report.physical.push(physical);
          const errors = Array.from({ length: 6 }, (_, index) => {
            let total = 0;
            for (let p = 0; p < width * height; p++)
              for (let c = 0; c < 3; c++)
                total += Math.abs(
                  item.rawRGB[i * width * height * 3 + p * 3 + c] -
                    sourceRGB[index * width * height * 3 + p * 3 + c],
                );
            return total / (width * height * 3);
          });
          assert.equal(errors.indexOf(Math.min(...errors)), 1);
          assert.ok(Math.min(...errors) < 12, "Movie source picture membership changed");
        }
      }
      report.comparison = [];
      for (let i = 0; i < 3; i++) {
        const expected = core(b.samples[i].frameRGBA, points[i]);
        assert.ok(expected.count > 5, "Single frame lost pointer core");
        // Unit-scale hotspot bounds from the retained pointer execution reference.
        assert.deepEqual(expected.bounds, [
          points[i].x + 1,
          points[i].y + 3,
          points[i].x + 5,
          points[i].y + 12,
        ]);
        matchesCore(core(b.samples[i].movieRGBA, points[i]), expected);
        assert.equal(
          core(a.samples[i].movieRGBA, points[i]).count,
          0,
          "Clean movie gained a pointer",
        );
        assert.ok(!b.samples[i].frameRGBA.equals(a.samples[i].frameRGBA));
        report.comparison.push({
          atUs: times[i],
          completeCleanPointerMovieDifference: difference(
            a.samples[i].movieRGBA,
            b.samples[i].movieRGBA,
          ),
          completeCleanPointerPNGDifference: difference(
            a.samples[i].frameRGBA,
            b.samples[i].frameRGBA,
          ),
        });
      }
      assert.deepEqual(b.summary.samples[1].pngCore, b.summary.samples[2].pngCore);
      assert.ok(
        b.samples[1].frameRGBA.equals(b.samples[2].frameRGBA),
        "Held source and pointer changed in unencoded frame",
      );
      assert.equal(sha(await readFile(source)), sourceSHA);
      assert.equal(sha(await readFile(join(donor, "video.mov"))), sourceSHA);
      report.finalAdmittedSourceSHA = sha(await readFile(managedSource));
      assert.equal(report.finalAdmittedSourceSHA, sourceSHA);
      report.passed = true;
    } catch (error) {
      report.failure = { message: error.message, stack: error.stack };
      throw error;
    } finally {
      try {
        if (service) {
          try {
            for (const token of leases) await close(token);
          } finally {
            await service.close();
            report.serviceClosed = true;
          }
        }
      } finally {
        await save("report.json", report);
        await rm(home, { recursive: true, force: true });
        if (!retained) await rm(out, { recursive: true, force: true });
      }
    }
  },
);
