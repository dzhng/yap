import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { acquisitionDonor, poll, run } from "./source-evidence-fixture.mjs";
import {
  writeSourceWave,
  decodedHash,
  sourcePeriod,
  periodicHash,
  digest,
  waveHeader,
} from "./audio-project-fixture.mjs";

export async function maskedProject({ home, out, call }) {
  const bindings = [],
    originals = [];
  for (const poison of [false, true]) {
    const name = poison ? "poison" : "clean",
      wav = join(home, `${name}.wav`),
      path = join(out, `${name}.mov`);
    await writeSourceWave(wav, { source: 0, rate: 44100, seconds: 1, poison });
    await run("ffmpeg", ["-v", "error", "-nostdin", "-i", wav, "-c:a", "alac", path], {
      timeout: 30000,
    });
    const decoded = await decodedHash(path);
    assert.equal(decoded.frames, 44100);
    assert.equal(decoded.sha256, periodicHash(sourcePeriod(0, 44100, poison), 1));
    originals.push({ path, sha256: await digest(path) });
    const donor = join(home, `${name}-capture`);
    await acquisitionDonor(donor, path, [
      { startUs: 0, endUs: 400000 },
      { startUs: 600000, endUs: 1000000 },
    ]);
    const pending = await call("acquisition.import", { requestId: `${name}-capture`, path: donor });
    const job = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "ready",
      "capture context",
    );
    const acquired = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
    const binding = acquired.bindings.find((b) => b.sourceRoles.includes("narration"));
    assert.ok(binding);
    bindings.push({
      assetId: binding.assetId,
      streamId: binding.streamId,
      acquisitionId: acquired.id,
    });
  }
  bindings.push({ assetId: bindings[1].assetId, streamId: bindings[1].streamId });
  const created = await call("project.create", {
    requestId: "poison-project",
    title: "Excluded admitted PCM independence",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const operations = [];
  for (const [index, binding] of bindings.entries()) {
    const label = `track-${index}`;
    operations.push(
      { operation: "track.add", label, track: { kind: "audio", order: index } },
      {
        operation: "place",
        label: `clip-${index}`,
        clip: {
          trackId: { label },
          ...binding,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: `clip-${index}` } },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      },
    );
  }
  const edited = await call("edit.apply", {
    projectId: created.project.projectId,
    requestId: "masked-clips",
    expectedRevisionId: created.revision.revisionId,
    operations,
  });
  const results = [];
  for (let index = 0; index < 3; index++) {
    const params = {
      projectId: created.project.projectId,
      revisionId: edited.revision.revisionId,
      tap: {
        target: { kind: "clip", id: edited.edit.labels[`clip-${index}`] },
        point: { kind: "processed" },
      },
    };
    const ready = await poll(
      () => call("audio.get", params, { transport: "mcp" }),
      (v) => v.state === "ready",
      "masked project tap",
    );
    const path = join(out, `masked-${index}.wav`);
    await call("audio.get", params, { output: path });
    const bytes = await readFile(path),
      header = waveHeader(bytes, bytes.length);
    assert.equal(header.frames, 48000);
    results.push({ pcm: bytes.subarray(header.offset), receipt: ready.published.output });
    assert.deepEqual(ready.published.output.unavailable, [
      {
        clipId: edited.edit.labels[`clip-${index}`],
        ranges: index < 2 ? [{ start: 19200, end: 28800 }] : [],
      },
    ]);
    await call("artifact.close", { token: ready.delivery.token }, { transport: "mcp" });
  }
  assert.deepEqual(
    results[0].pcm,
    results[1].pcm,
    "Excluded source poison must not affect retained neighbors through resampling",
  );
  for (const result of results.slice(0, 2)) {
    assert.ok(
      result.pcm.subarray(19200 * 8, 28800 * 8).every((byte) => byte === 0),
      "Unavailable interval zero",
    );
    assert.ok(
      result.pcm.subarray(0, 19200 * 8).some((byte) => byte !== 0),
      "Retained source exists",
    );
  }
  assert.ok(!results[1].pcm.equals(results[2].pcm), "Physical poison negative control must differ");
  assert.ok(
    results[2].pcm.subarray(19200 * 8, 28800 * 8).some((byte) => byte !== 0),
    "Physical admission contains excluded poison",
  );
  for (const original of originals) assert.equal(await digest(original.path), original.sha256);
  return {
    boundary:
      "Synthetic capture journals around admitted actual ALAC bytes; no physical capture claim. Real 44.1-to-48 kHz conversion and public processed clip taps.",
    originals,
    receipts: results.map((r) => r.receipt),
    maskedPcmEqual: true,
    physicalPoisonDiffers: true,
  };
}
