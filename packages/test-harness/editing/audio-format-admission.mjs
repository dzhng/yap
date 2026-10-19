import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath, copyFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { waveHeader } from "./audio-project-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out);
const home = await realpath(await mkdtemp("/tmp/yap-format-library-"));
const report = {
  passed: false,
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  trace: [],
  formats: [],
  scope:
    "Public prerecorded asset import and selected PCM against the same worker's pathname baseline; no codec support inferred from probing alone",
};
const service = new JourneyService(home, report),
  call = service.call.bind(service),
  worker = mediaWorker(process.env);
try {
  await service.start();
  const source = new URL(
    "../../../specs/done/agent-editing/assets/00-corpus/a-audio.wav",
    import.meta.url,
  ).pathname;
  for (const [extension, codec] of [
    ["wav", "pcm_f32le"],
    ["aiff", "pcm_s16be"],
    ["m4a", "aac"],
    ["mp3", "libmp3lame"],
    ["flac", "flac"],
  ]) {
    const path = join(out, `source.${extension}`);
    await run(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", source, "-ac", "2", "-c:a", codec, path],
      {
        timeout: 30000,
      },
    );
    const external = join(out, `external.${extension}`);
    await copyFile(path, external);
    const admission = await call(
      "asset.import",
      { path: external, requestId: extension },
      { transport: "mcp" },
    );
    const imported = await poll(
      () => call("job.get", { jobId: admission.jobId }),
      (v) => v.state === "ready",
      `import ${extension}`,
    );
    const asset = await call("asset.get", { assetId: imported.published.output.assetId });
    const stream = asset.streams.find((s) => s.kind === "audio");
    assert(stream);
    await rm(external);
    const segments = await call("asset.segments", {
      assetId: asset.assetId,
      streamId: stream.streamId,
    });
    assert.equal(segments.nextCursor, null);
    const available = segments.segments
      .filter((s) => !s.empty)
      .map((s) => ({ startUs: s.startUs, endUs: s.endUs }));
    const range = { startUs: 500000, endUs: 750000 };
    const baseline = await worker("media.sourceAudio", {
      source: {
        source: path,
        streamId: stream.streamId,
        sourceOffsetUs: -asset.originUs,
        available,
      },
      range,
      output: join(out, `pathname-${extension}.wav`),
    });
    const selection = { assetId: asset.assetId, streamId: stream.streamId, sourceRange: range };
    let inspected;
    const deadline = Date.now() + 30000;
    for (;;) {
      inspected = await call("audio.get", selection);
      if (["ready", "failed", "unavailable"].includes(inspected.state)) break;
      assert(
        Date.now() < deadline,
        `Selected ${extension} audio did not finish: ${JSON.stringify(inspected)}`,
      );
      await new Promise((r) => setTimeout(r, 50));
    }
    const item = {
      extension,
      assetId: asset.assetId,
      sourceSha256: hash(await readFile(path)),
      baseline,
      inspected,
    };
    report.formats.push(item);
    nativeResult(baseline);
    assert.equal(inspected.state, "ready", JSON.stringify(inspected));
    const destination = join(out, `public-${extension}.wav`);
    await call("audio.get", selection, { output: destination, transport: "cli" });
    const a = await readFile(baseline.data.file),
      b = await readFile(destination);
    const ah = waveHeader(a, a.length),
      bh = waveHeader(b, b.length);
    assert.equal(bh.frames, ah.frames);
    assert.deepEqual(b.subarray(bh.offset), a.subarray(ah.offset));
    item.exactPCM = true;
    item.pcmSha256 = hash(b.subarray(bh.offset));
    assert.equal((await call("audio.get", selection, { transport: "mcp" })).state, "ready");
  }
  report.passed = true;
} catch (e) {
  report.failure = { message: e.message, stack: e.stack };
  throw e;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
