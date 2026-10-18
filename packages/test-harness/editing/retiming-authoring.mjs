import { authorAcceptedRetime } from "./accepted-retime-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";
import { compositionAsset } from "../../core/dist/assets.js";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    renderer: { type: "string" },
    "public-audio": { type: "boolean" },
  },
});
assert(values.out && process.env.YAP_NATIVE);
assert(
  !(values.renderer && values["public-audio"]),
  "Choose direct native or public audio execution",
);
const rendersAudio = Boolean(values.renderer || values["public-audio"]);
const out = resolve(values.out),
  home = await realpath(await mkdtemp("/tmp/sr-retime-authoring-"));
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  cases: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  scope: values["public-audio"]
    ? "Public integer-duration authoring and delivered audio.get PCM against accepted A-D files."
    : "Public integer-duration authoring and compiler plans; native rendering is a separate prerequisite entry, not public capability adoption.",
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const accepted = join(root, "specs/done/agent-editing/assets/13a-corrected-selections");
const source = join(out, "original.wav");
await copyFile(join(accepted, "original.wav"), source);
const frozen = JSON.parse(await readFile(join(accepted, "report.json"), "utf8"));
const listening = JSON.parse(await readFile(join(accepted, "listening.json"), "utf8"));
assert.equal(hash(await readFile(source)), frozen.sourceSha256);
if (values.renderer) report.rendererSha256 = hash(await readFile(resolve(values.renderer)));
const stereo = (mono) => {
  const result = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i += 4) {
    mono.copy(result, i * 2, i, i + 4);
    mono.copy(result, i * 2 + 4, i, i + 4);
  }
  return result;
};
async function pcm(path) {
  const info = readAudioWaveFile(path),
    bytes = await readFile(path);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  return bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
}
try {
  if (rendersAudio) {
    const capabilities = nativeResult(await mediaWorker()("media.audioCapabilities", {}));
    assert.equal(typeof capabilities.retime, "string");
    report.retimeImplementationId = capabilities.retime;
  }
  await service.start();
  const imported = await call("asset.import", { requestId: "source", path: source });
  const job = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  const stream = asset.streams.find((v) => v.kind === "audio");
  assert(stream);
  const timing = await call("asset.segments", { assetId: asset.id, streamId: stream.id });
  assert.equal(timing.nextCursor, null);
  const modelAsset = compositionAsset({
    ...asset,
    streams: [{ ...stream, segments: timing.segments }],
  });
  for (const candidate of frozen.results) {
    const name = candidate.path.replace(/\.wav$/, ""),
      directory = join(out, name);
    await mkdir(directory);
    const made = await call("project.create", {
      requestId: name,
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const projectId = made.project.projectId;
    let revision = made.revision;
    const edit = async (id, operations, transport = "cli") => {
      const result = await call(
        "edit.apply",
        {
          projectId,
          expectedRevisionId: revision.revisionId,
          requestId: name + "/" + id,
          operations,
        },
        { transport },
      );
      revision = result.revision;
      return result;
    };
    const { selected, startUs, durationUs } = await authorAcceptedRetime({
      edit,
      asset,
      streamId: stream.id,
      candidate,
    });
    const base = revision;
    const compile = (value, range) => {
      const model = validateComposition(value.document, [modelAsset]);
      return createCompiler(model, value.id).audioWindow({
        range: range ?? { startUs: 0, endUs: model.durationUs },
        rendition: { sampleRate: 48000, channels: 2 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
      });
    };
    const full = compile(base),
      selectedClip = [...full.audio()].find((v) => v.clipId === selected.id);
    assert(selectedClip);
    const context = selectedClip.context;
    assert.equal(context.length, 1);
    assert.equal(
      context[0].sampleRange.end - context[0].sampleRange.start,
      candidate.declaredOutput.frames,
    );
    const splitAt = Math.floor(startUs + durationUs / 2);
    await edit("pure-split", [
      { operation: "split", clipIds: [selected.id], atUs: splitAt, scope: "selected" },
    ]);
    const split = compile(revision);
    const pieces = [...split.audio()].filter((v) =>
      v.context.some((c) => c.sampleRange.start === context[0].sampleRange.start),
    );
    assert.equal(pieces.length, 2);
    for (const piece of pieces) assert.deepEqual(piece.context, context);
    const range = { startUs: splitAt + 1000, endUs: splitAt + 21000 };
    const short = compile(revision, range);
    assert.deepEqual([...short.audio()][0].context, context);
    const left = compile(revision, { startUs: 0, endUs: splitAt });
    const right = compile(revision, { startUs: splitAt, endUs: split.manifest.range.endUs });
    const plans = {};
    for (const [variant, window] of Object.entries({ full, split, short, left, right })) {
      const output = join(directory, variant + ".wav"),
        path = join(directory, variant + ".json");
      const plan = {
        ...(report.retimeImplementationId
          ? { retimeImplementationId: report.retimeImplementationId }
          : {}),
        output,
        range: window.manifest.sampleRange,
        clips: [...window.audio()],
        processing: window.processing(),
        assets: [
          { assetId: asset.id, streamId: stream.id, path: source, originUs: asset.originUs },
        ],
      };
      await writeFile(path, JSON.stringify(plan, null, 2));
      plans[variant] = { path, sampleRange: plan.range };
      if (values.renderer) {
        const result = await run(resolve(values.renderer), [path], {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        });
        plans[variant].receipt = JSON.parse(result.stdout);
        plans[variant].sha256 = hash(await readFile(output));
      } else if (values["public-audio"]) {
        const selection = {
          projectId,
          revisionId: variant === "full" ? base.id : revision.revisionId,
          range: window.manifest.range,
        };
        plans[variant].receipt = await poll(
          () => call("audio.get", selection, { transport: "mcp" }),
          (v) => v.state === "ready",
          name + "/" + variant,
        );
        const attachment = report.exchanges.at(-1).response.content.find((v) => v.type === "audio");
        assert(attachment, "Ready MCP audio must include its playable attachment");
        await call("audio.get", selection, { output });
        plans[variant].sha256 = hash(await readFile(output));
        assert.equal(hash(Buffer.from(attachment.data, "base64")), plans[variant].sha256);
      }
    }
    if (rendersAudio) {
      const acceptedWave = await readFile(join(accepted, candidate.path));
      assert.equal(
        hash(acceptedWave),
        listening.candidates.find((v) => v.path === candidate.path).sha256,
      );
      const expected = stereo(acceptedWave.subarray(44));
      const actual = await pcm(join(directory, "full.wav"));
      assert.deepEqual(actual, expected);
      assert.deepEqual(await pcm(join(directory, "split.wav")), actual);
      assert.deepEqual(
        Buffer.concat([
          await pcm(join(directory, "left.wav")),
          await pcm(join(directory, "right.wav")),
        ]),
        actual,
      );
      const samples = short.manifest.sampleRange;
      assert.deepEqual(
        await pcm(join(directory, "short.wav")),
        actual.subarray(samples.start * 8, samples.end * 8),
      );
    }
    report.cases.push({
      name,
      durationUs,
      context,
      plans,
      publicRevision: base.id,
      exactAcceptedSampleCount: true,
      pureSplitKeepsFullRun: true,
      shortQueryKeepsFullRun: true,
      nativePCMVerified: Boolean(values.renderer),
      publicPCMVerified: Boolean(values["public-audio"]),
    });
  }
  report.passed = true;
} finally {
  await service.stop();
  const { exchanges, ...summary } = report;
  await writeFile(join(out, "exchanges.json"), JSON.stringify(exchanges, null, 2));
  await writeFile(join(out, "report.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, out }));
