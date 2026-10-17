import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "@yap/core/catalog";
import { ProjectStore } from "@yap/core/projects";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { DerivedCache } from "@yap/core/cache";
import { temporary, waitFor } from "./harness.mjs";
import {
  startPublicService,
  importAcquisition,
  connectPublicMcp,
} from "./fixtures/public-service.mjs";

const native =
  process.env.YAP_NATIVE ??
  new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url).pathname;
const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], {
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

async function donor(home, durationUs, roles, requested = roles) {
  const source = join(home, `donor-${randomUUID()}`);
  await mkdir(source);
  const sourceId = randomUUID();
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=100x80:r=1:d=${durationUs / 1e6}`,
    "-an",
    "-c:v",
    "libx264",
    join(source, "video.mov"),
  ]);
  for (const [role, frequency] of roles.map((role) => [role, role === "narration" ? 1000 : 400]))
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000:duration=${durationUs / 1e6}`,
      "-c:a",
      "pcm_f32le",
      join(source, `${role}.mov`),
    ]);
  const records = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: sourceId,
        source: { kind: "display", displayID: 1 },
        width: 100,
        height: 80,
        microphone: requested.includes("narration"),
        systemAudio: requested.includes("system"),
      },
    },
    { event: "origin", data: { hostUs: 1000 } },
    ...roles.flatMap((role) =>
      (durationUs === 4000000 && role === "narration"
        ? [
            [0, 2500000],
            [3000000, 4000000],
          ]
        : [[0, durationUs]]
      ).map(([startUs, endUs]) => ({ event: "audioSamples", data: { role, startUs, endUs } })),
    ),
    { event: "finished", data: {} },
  ];
  await writeFile(
    join(source, "capture.journal.jsonl"),
    records.map((row, i) => JSON.stringify({ sequence: i + 1, ...row }) + "\n").join(""),
  );
  return source;
}
function binding(acquisition, role) {
  const value = acquisition.bindings.find((binding) => binding.sourceRoles.includes(role));
  assert.ok(value, `Missing explicitly selected ${role} binding`);
  return { assetId: value.assetId, streamId: value.streamId, acquisitionId: acquisition.id };
}
function publicAudioClient(getService) {
  const request = (operation, params) => getService().call(operation, params);
  const call = async (operation, params = {}) => {
    const reply = await request(operation, params);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const audio = (params, consume) =>
    waitFor(async () => {
      const result = await call("audio.get", params);
      assert.ok(!["failed", "unavailable"].includes(result.state), JSON.stringify(result));
      if (result.state !== "ready") return false;
      try {
        if (consume) await consume(result.published.output);
        return result;
      } finally {
        await call("artifact.close", { token: result.delivery.token });
      }
    }, 20000);
  return { call, request, audio };
}
test("public project audio preserves explicit cuts, captured support, pinned revisions and CLI/MCP bytes", async () => {
  const home = temporary("/tmp/scr-audio-public-");
  const source = await donor(home, 4000000, ["narration", "system"]);
  const hashes = async () =>
    Promise.all(
      ["video.mov", "narration.mov", "system.mov", "capture.journal.jsonl"].map(async (name) =>
        createHash("sha256")
          .update(await readFile(join(source, name)))
          .digest("hex"),
      ),
    );
  const original = await hashes();
  let service = await startPublicService(home, native);
  const { call, audio } = publicAudioClient(() => service);
  try {
    const { acquisition } = await importAcquisition(service, source);
    const created = await call("project.create", {
      requestId: "audio-project",
      canvas: {
        width: 100,
        height: 80,
        fps: { numerator: 1, denominator: 1 },
        background: "#000000ff",
      },
    });
    const projectId = created.project.projectId;
    const placed = await call("edit.apply", {
      projectId,
      requestId: "audio-tracks",
      expectedRevisionId: created.revision.id,
      operations: [
        ...["narration", "system"].map((role, order) => ({
          operation: "track.add",
          label: role,
          track: { kind: "audio", order },
        })),
        ...["narration", "system"].flatMap((role) => [
          {
            operation: "place",
            label: `${role}-clip`,
            clip: {
              trackId: { label: role },
              ...binding(acquisition, role),
              source: { kind: "range", range: { startUs: 0, endUs: 4000000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 4000000 } },
            },
          },
          {
            operation: "processing.set",
            target: { kind: "track", id: { label: role } },
            steps: [{ processor: { type: "gain", gain: 0.5 } }],
          },
        ]),
      ],
    });
    const edited = await call("edit.apply", {
      projectId,
      requestId: "cut",
      expectedRevisionId: placed.revision.id,
      operations: [
        {
          operation: "remove",
          clipIds: [placed.edit.labels["narration-clip"], placed.edit.labels["system-clip"]],
          ranges: [{ startUs: 1000000, endUs: 2000000 }],
          ripple: { trackIds: [placed.edit.labels.narration, placed.edit.labels.system] },
        },
      ],
    });
    const params = {
      projectId,
      revisionId: edited.revision.id,
      range: { startUs: 500000, endUs: 2500000 },
    };
    const ready = await audio(params),
      excerpt = ready.published.output;
    assert.equal(excerpt.frames, 96000);
    assert.equal(excerpt.sampleRate, 48000);
    assert.deepEqual(excerpt.range, params.range);
    assert.deepEqual(excerpt.sampleRange, { start: 24000, end: 120000 });
    const right = edited.revision.document.clips.find(
      (clip) =>
        clip.assetId === binding(acquisition, "narration").assetId &&
        clip.source.range.startUs === 2000000,
    );
    assert.ok(right);
    assert.deepEqual(
      excerpt.unavailable.filter((item) => item.ranges.length),
      [{ clipId: right.id, ranges: [{ start: 72000, end: 96000 }] }],
    );
    const output = join(home, "excerpt.wav");
    const delivered = spawnSync(
      process.execPath,
      [
        cli,
        "audio.get",
        "--socket",
        service.socket,
        "--params",
        JSON.stringify(params),
        "--output",
        output,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
    const wave = await readFile(output);
    assert.equal(wave.subarray(0, 4).toString(), "RIFF");
    const client = await connectPublicMcp(service.socket, "audio-proof");
    try {
      const result = await client.callTool({ name: "audio.get", arguments: params });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.data.published, ready.published);
      const content = result.content.find((item) => item.type === "audio");
      assert.equal(content.mimeType, "audio/wav");
      assert.deepEqual(Buffer.from(content.data, "base64"), wave);
    } finally {
      await client.close();
    }
    const pcm = ffmpeg(["-i", output, "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"]);
    assert.equal(pcm.length, 96000 * 4);
    const amplitude = (second, frequency) => {
      const start = Math.round(second * 48000),
        count = 4800;
      let real = 0,
        imaginary = 0;
      for (let i = 0; i < count; i++) {
        const sample = pcm.readFloatLE((start + i) * 4),
          angle = (2 * Math.PI * frequency * i) / 48000;
        real += sample * Math.cos(angle);
        imaginary += sample * Math.sin(angle);
      }
      return (2 * Math.hypot(real, imaginary)) / count;
    };
    assert.ok(amplitude(0.2, 1000) > 0.055);
    assert.ok(amplitude(1.2, 1000) < 0.001);
    assert.ok(amplitude(1.2, 400) > 0.055);
    assert.ok(amplitude(1.7, 1000) > 0.055);

    assert.deepEqual((await audio(params)).published, ready.published);
    const historical = await audio({ ...params, revisionId: placed.revision.id });
    assert.notEqual(historical.jobId, ready.jobId);
    assert.equal(historical.published.output.revisionId, placed.revision.id);
    assert.deepEqual(
      historical.published.output.unavailable.filter((item) => item.ranges.length),
      [],
    );
    assert.deepEqual((await audio({ projectId, range: params.range })).published, ready.published);
    await service.close();
    const library = join(home, "library"),
      catalog = new Catalog(join(library, "catalog.sqlite"));
    try {
      const assets = new AssetStore(catalog, library),
        acquisitions = new AcquisitionStore(catalog);
      const projects = new ProjectStore(
        catalog,
        assets,
        new TranscriptStore(catalog, library, assetTranscriptOwner(assets, acquisitions)),
        acquisitions,
      );
      const cache = new DerivedCache(
        catalog,
        library,
        (owner) => {
          if (owner.kind === "project") projects.get(owner.projectId);
          else if (owner.kind === "asset") assert.ok(assets.has(owner.assetId));
          else acquisitions.get(owner.acquisitionId);
        },
        1,
      );
      await cache.reconcile();
      assert.equal(cache.acquire(excerpt.cacheId), null);
    } finally {
      catalog.close();
    }
    service = await startPublicService(home, native);
    const regenerated = await audio(params, async (value) => {
      assert.deepEqual(await readFile(value.file), wave);
    });
    assert.equal(regenerated.jobId, ready.jobId);
    assert.equal(regenerated.published.generation, ready.published.generation + 1);
    assert.equal(regenerated.revisionId, edited.revision.id);
    assert.deepEqual(await hashes(), original);
  } finally {
    await service.close();
  }
});

test("public selected audio preserves unity and explicit missing-stream refusal without implicit projects", async () => {
  const home = temporary("/tmp/scr-audio-absence-"),
    service = await startPublicService(home, native);
  const { request, call, audio } = publicAudioClient(() => service);
  try {
    for (const role of ["narration", "system"])
      for (const missingRequested of [false, true]) {
        const source = await donor(
          home,
          1000000,
          [role],
          missingRequested ? ["narration", "system"] : [role],
        );
        const { acquisition } = await importAcquisition(service, source);
        const selection = binding(acquisition, role);
        const samples = (path) =>
          ffmpeg(["-i", path, "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"]);
        await audio({ ...selection, range: { startUs: 0, endUs: 1000000 } }, async (value) => {
          assert.deepEqual(samples(value.file), samples(join(source, `${role}.mov`)));
        });
        const absent = role === "narration" ? "system" : "narration";
        assert.equal(
          acquisition.evidence.receipt.header[
            absent === "narration" ? "microphone" : "systemAudio"
          ],
          missingRequested,
        );
        assert.equal(
          acquisition.bindings.some((binding) => binding.sourceRoles.includes(absent)),
          false,
        );
        const refused = await request("audio.get", {
          ...selection,
          streamId: "missing",
          range: { startUs: 0, endUs: 1000000 },
        });
        assert.equal(refused.ok, false);
        assert.equal(refused.error.code, "UNSUPPORTED_MEDIA");
      }
    assert.deepEqual((await call("project.list", {})).projects, []);
  } finally {
    await service.close();
  }
});

test("public source audio keeps native failure until explicit retry after restoring exact registered bytes", async () => {
  const home = temporary("/tmp/scr-audio-retry-"),
    source = join(home, "tone.mov");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000:duration=1",
    "-c:a",
    "pcm_f32le",
    source,
  ]);
  const original = await readFile(source),
    service = await startPublicService(home, native);
  const { call, audio } = publicAudioClient(() => service);
  let hidden, registered;
  try {
    const imported = await call("asset.import", { requestId: "retry-source", path: source });
    const job = await waitFor(async () => {
      const job = await call("job.get", { jobId: imported.jobId });
      if (["failed", "canceled", "unavailable"].includes(job.state))
        throw Error(JSON.stringify(job));
      return job.state === "ready" && job;
    }, 20000);
    const asset = await call("asset.get", { assetId: job.published.output.assetId });
    const stream = asset.streams.find((stream) => stream.kind === "audio");
    assert.ok(stream);
    registered = join(home, "library", "assets", asset.fileName);
    hidden = registered + ".held";
    await rename(registered, hidden);
    const params = {
      assetId: asset.id,
      streamId: stream.id,
      range: { startUs: 0, endUs: 1000000 },
    };
    const failed = await waitFor(async () => {
      const status = await call("audio.get", params);
      assert.notEqual(status.state, "ready");
      return status.state === "failed" && status;
    }, 20000);
    assert.equal(failed.published, null);
    assert.equal(failed.retryable, true);
    assert.ok(failed.reason);
    await rename(hidden, registered);
    hidden = undefined;
    assert.deepEqual(await readFile(registered), original);
    for (let i = 0; i < 3; i++) assert.deepEqual(await call("audio.get", params), failed);
    const retry = await call("job.retry", params);
    assert.equal(retry.jobId, failed.jobId);
    assert.notEqual(retry.state, "failed");
    const samples = (path) =>
      ffmpeg(["-i", path, "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"]);
    const result = await audio(params, async (value) => {
      assert.deepEqual(samples(value.file), samples(source));
    });
    assert.equal(result.jobId, failed.jobId);
    assert.equal(result.published.generation, 2);
    assert.equal(result.published.output.frames, 48000);
    assert.deepEqual(await readFile(registered), original);
    const repeated = await call("job.retry", params);
    assert.deepEqual(repeated.published, result.published);
    await call("artifact.close", { token: repeated.delivery.token });
  } finally {
    try {
      if (hidden) await rename(hidden, registered);
    } finally {
      await service.close();
    }
  }
});
