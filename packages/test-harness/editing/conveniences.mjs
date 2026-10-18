import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";
import { writeSourceWave, waveHeader } from "./audio-project-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await mkdtemp(join(tmpdir(), "yap-conveniences-"));
await mkdir(out);
const report = {
  passed: false,
  checks: [],
  trace: [],
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
  runnerSha256: hash(await readFile(new URL(import.meta.url))),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const ref = (label) => ({ label });
const target = (kind, id) => ({ kind, id });
const window = { kind: "project", range: { startUs: 250000, endUs: 750000 } };
const curve = (from, to) => ({
  keys: [
    { at: 250000, value: from, interpolation: "linear" },
    { at: 750000, value: to, interpolation: "hold" },
  ],
});
try {
  await service.start();
  const source = join(out, "source.wav");
  await writeSourceWave(source, { source: 0, seconds: 1 });
  async function admit(path) {
    const pending = await call("asset.import", { requestId: randomUUID(), path });
    await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    return call("asset.get", { assetId: hash(await readFile(path)) });
  }
  const audio = await admit(source);
  const image = await admit(
    join(root, "specs/done/agent-editing/assets/10d-still-image-native/sources/png-6.png"),
  );
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 40,
      height: 64,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  let revisionId = created.revision.revisionId;
  const select = () => ({ projectId, revisionId });
  async function edit(operations, transport = "cli") {
    const result = await call(
      "edit.apply",
      { projectId, expectedRevisionId: revisionId, requestId: randomUUID(), operations },
      { transport },
    );
    revisionId = result.revision.revisionId;
    return result;
  }
  const placed = await edit(
    ["audio", "video"].flatMap((kind, order) => [
      { operation: "track.add", track: { kind, order }, label: kind },
      {
        operation: "place",
        label: `${kind}-clip`,
        clip: {
          trackId: ref(kind),
          assetId: kind === "audio" ? audio.id : image.id,
          streamId: (kind === "audio" ? audio : image).streams[0].streamId,
          source:
            kind === "audio"
              ? { kind: "range", range: { startUs: 0, endUs: 1000000 } }
              : { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ]),
  );
  const audioTarget = target("clip", placed.edit.labels["audio-clip"]);
  const videoTarget = target("clip", placed.edit.labels["video-clip"]);
  async function renderAudio(name, extra = {}) {
    const selection = { ...select(), ...extra };
    await poll(
      () => call("audio.get", selection),
      (v) => v.state === "ready",
      name,
    );
    const file = join(out, name + ".wav");
    await call("audio.get", selection, { output: file });
    const bytes = await readFile(file),
      header = waveHeader(bytes, bytes.length);
    const pcm = bytes.subarray(header.offset);
    report.checks.push({ name, sha256: hash(pcm), frames: pcm.length / 8 });
    return pcm;
  }
  async function picture(name, atUs) {
    const selection = { ...select(), atUs };
    await poll(
      () => call("frame.get", selection),
      (v) => v.state === "ready",
      name,
    );
    const file = join(out, name + ".png");
    await call("frame.get", selection, { output: file });
    const bytes = await readFile(file);
    const mcp = await service.mcp.callTool({ name: "frame.get", arguments: selection });
    assert.equal(mcp.structuredContent.ok, true);
    assert.deepEqual(
      Buffer.from(mcp.content.find((v) => v.type === "image").data, "base64"),
      bytes,
    );
    report.checks.push({ name, sha256: hash(bytes) });
    return bytes;
  }
  const dry = await renderAudio("dry");
  const prior = { processor: { type: "gain", gain: 0.5 }, label: "prior" };
  const faded = await edit(
    [
      { operation: "processing.set", target: audioTarget, steps: [prior] },
      {
        operation: "fade",
        target: audioTarget,
        mediaKind: "audio",
        from: 0,
        to: 1,
        window,
        label: "fade",
      },
      {
        operation: "fade",
        target: videoTarget,
        mediaKind: "video",
        from: 0,
        to: 1,
        window,
        label: "opacity",
      },
    ],
    "mcp",
  );
  const stack = await call("processing.get", { ...select(), target: audioTarget });
  assert.equal(stack.steps[0].id, faded.edit.labels.prior);
  assert.deepEqual(stack.steps[1].processor, { type: "gain", gain: curve(0, 1) });
  const pcm = await renderAudio("fade");
  for (let frame = 0; frame < 48000; frame++)
    for (let channel = 0; channel < 2; channel++) {
      const offset = frame * 8 + channel * 4;
      const gain = frame < 12000 || frame >= 36000 ? 1 : (frame - 12000) / 24000;
      assert.equal(
        pcm.readFloatLE(offset),
        Math.fround(Math.fround(dry.readFloatLE(offset) * 0.5) * Math.fround(gain)),
      );
    }
  const range = { startUs: 333333, endUs: 666667 };
  assert.deepEqual(await renderAudio("range", { range }), pcm.subarray(15999 * 8, 32000 * 8));
  const pictures = [];
  for (let i = 0; i < 8; i++) pictures.push(await picture(`fade-${i}`, i * 125000));
  assert.notDeepEqual(pictures[0], pictures[3]);
  for (let i = 0; i < 8; i++) {
    const value = i < 2 || i >= 6 ? 1 : (i - 2) / 4;
    await edit([
      {
        operation: "processing.set",
        target: videoTarget,
        steps: [{ processor: { type: "opacity", opacity: value } }],
      },
    ]);
    assert.deepEqual(await picture(`static-${i}`, i * 125000), pictures[i]);
  }
  await edit([
    {
      operation: "processing.set",
      target: audioTarget,
      steps: stack.steps.map((s) => ({ ...s, enabled: s.id !== faded.edit.labels.fade })),
    },
  ]);
  const bypass = await renderAudio("bypass");
  for (let offset = 0; offset < bypass.length; offset += 4)
    assert.equal(bypass.readFloatLE(offset), Math.fround(dry.readFloatLE(offset) * 0.5));
  const before = await call("processing.get", { ...select(), target: audioTarget });
  const error = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: revisionId,
      requestId: randomUUID(),
      operations: [
        { operation: "fade", target: audioTarget, mediaKind: "audio", from: 0, to: 1, window },
        { operation: "fade", target: audioTarget, mediaKind: "video", from: 0, to: 1, window },
      ],
    },
    { error: true },
  );
  assert.equal(error.code, "INVALID_EDIT");
  assert.deepEqual(await call("processing.get", { ...select(), target: audioTarget }), before);
  // Two independently faded copies sum as audio, without automatic overlap or normalization.
  await edit([
    { operation: "processing.set", target: audioTarget, steps: [] },
    { operation: "track.add", track: { kind: "audio", order: 2 }, label: "second" },
    {
      operation: "place",
      label: "second-clip",
      clip: {
        trackId: ref("second"),
        assetId: audio.id,
        streamId: audio.streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      },
    },
    { operation: "fade", target: audioTarget, mediaKind: "audio", from: 0, to: 1, window },
    {
      operation: "fade",
      target: { kind: "clip", id: ref("second-clip") },
      mediaKind: "audio",
      from: 1,
      to: 0,
      window,
    },
  ]);
  const crossed = await renderAudio("crossfade");
  for (let frame = 0; frame < 48000; frame++)
    for (let channel = 0; channel < 2; channel++) {
      const offset = frame * 8 + channel * 4,
        sample = dry.readFloatLE(offset);
      const phase = (frame - 12000) / 24000;
      const expected =
        frame < 12000 || frame >= 36000
          ? sample * 2
          : Math.fround(
              Math.fround(sample * Math.fround(phase)) +
                Math.fround(sample * Math.fround(1 - phase)),
            );
      assert.equal(crossed.readFloatLE(offset), expected);
    }
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, out }));
