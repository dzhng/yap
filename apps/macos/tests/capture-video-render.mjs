import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { temporary } from "./harness.mjs";
import {
  startPublicService,
  importAcquisition,
  publicCommand,
  until,
} from "./fixtures/public-service.mjs";
import { renderPlan } from "@yap/core/presentation-time";
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

// Explicit retained paused-capture donor; this gate never records another take.
test(
  "retained paused capture renders explicit source intervals through current projects",
  { timeout: 60000 },
  async () => {
    assert.ok(
      process.env.YAP_CAPTURE_RENDER_SOURCE,
      "Name the retained paused-capture source directory",
    );
    const donor = resolve(process.env.YAP_CAPTURE_RENDER_SOURCE),
      source = join(donor, "video.mov");
    const before = await hash(source),
      journalBefore = await hash(join(donor, "capture.journal.jsonl"));
    const sourceMetadata = JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=width,height,codec_type,time_base,duration_ts",
        "-of",
        "json",
        source,
      ]),
    );
    assert.equal(sourceMetadata.streams.length, 1);
    const video = sourceMetadata.streams[0],
      end = Math.round(Number(sourceMetadata.format.duration) * 1e6);
    const [numerator, denominator] = video.time_base.split("/").map(BigInt);
    assert.equal(BigInt(video.duration_ts) * numerator * 1_000_000n, BigInt(end) * denominator);
    const home = temporary("/tmp/yap-render-capture-");
    const service = await startPublicService(home, process.env.YAP_NATIVE);
    const call = async (operation, params) => {
      const reply = await service.call(operation, params);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.data;
    };
    try {
      const { acquisition } = await importAcquisition(service, donor);
      assert.ok(
        acquisition.evidence.receipt.pauseEvents > 0,
        "Retained donor must contain the pause fixture",
      );
      const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
      assert.ok(binding);
      const results = [];
      for (const [name, spans] of [
        ["full-original", [{ startUs: 0, endUs: end }]],
        [
          "cut",
          [
            { startUs: 10001, endUs: Math.floor(end / 3) },
            { startUs: Math.floor(end / 2) + 7, endUs: end - 10001 },
          ],
        ],
      ]) {
        const plan = renderPlan({ spans });
        const created = await call("project.create", {
          requestId: randomUUID(),
          canvas: {
            width: video.width,
            height: video.height,
            fps: { numerator: 30, denominator: 1 },
            background: "#000000ff",
          },
        });
        const projectId = created.project.projectId;
        const authored = await call("edit.apply", {
          projectId,
          requestId: randomUUID(),
          expectedRevisionId: created.revision.revisionId,
          operations: [
            { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
            ...plan.map(({ source, playback }) => ({
              operation: "place",
              clip: {
                assetId: binding.assetId,
                streamId: binding.streamId,
                acquisitionId: acquisition.id,
                trackId: { label: "video" },
                source: { kind: "range", range: source },
                placement: { kind: "project", range: playback },
              },
            })),
          ],
        });
        const params = { projectId, revisionId: authored.revision.revisionId };
        const ready = await until(async () => {
          const status = await call("preview.get", params);
          assert.ok(!["failed", "unavailable"].includes(status.state), JSON.stringify(status));
          if (status.state !== "ready") return false;
          await call("artifact.close", { token: status.delivery.token });
          return status;
        }, "Retained capture preview");
        const output = join(home, `${name}.mp4`);
        const delivered = publicCommand(service.socket, "preview.get", params, [
          "--output",
          output,
        ]);
        assert.deepEqual(delivered.published, ready.published);
        const receipt = ready.published.output;
        const metadata = JSON.parse(
          run("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=width,height,codec_type,nb_read_frames",
            "-count_frames",
            "-of",
            "json",
            output,
          ]),
        );
        run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
        assert.equal(
          Math.round(Number(metadata.format.duration) * 1e6),
          plan.at(-1).playback.endUs,
        );
        assert.equal(metadata.streams.length, 1);
        assert.equal(metadata.streams[0].codec_type, "video");
        assert.ok(Number(metadata.streams[0].nb_read_frames) > 0);
        assert.equal(Number(metadata.streams[0].nb_read_frames), receipt.frameCount);
        assert.equal(metadata.streams[0].width, receipt.width);
        assert.equal(metadata.streams[0].height, receipt.height);
        assert.equal(await hash(source), before);
        assert.equal(await hash(join(donor, "capture.journal.jsonl")), journalBefore);
        results.push({ name, plan, receipt, metadata });
      }
      if (process.env.YAP_CAPTURE_RENDER_EVIDENCE)
        await writeFile(
          process.env.YAP_CAPTURE_RENDER_EVIDENCE,
          JSON.stringify(
            {
              sourceMetadata,
              results,
              sourceHash: before,
              journalHash: journalBefore,
              sourceUnchanged: true,
              authoredFPS: 30,
              capture: "retained donor; no new recording",
            },
            null,
            2,
          ),
        );
    } finally {
      await service.close();
    }
  },
);
