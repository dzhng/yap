import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { sample, waveHeader, writeSourceWave } from "./audio-project-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(
  values.out && process.env.YAP_NATIVE,
  "Usage: YAP_NATIVE=WORKER node packages/test-harness/editing/transition-delivery.mjs --out NEW_DIRECTORY",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/yap-transition-delivery-");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  recipe: {
    kind: "crossfade",
    mediaKind: "video",
    projectRange: { startUs: 0, endUs: 1000000 },
    transitionRange: { startUs: 250000, endUs: 750000 },
    sources: "solid red and solid blue caller-authored images",
  },
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const ffmpeg =
  process.env.YAP_FFMPEG ?? join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const runFFmpeg = (args, options) => run(ffmpeg, ["-v", "error", "-nostdin", ...args], options);
const decodeRGB = async (path) =>
  Buffer.from(
    (
      await runFFmpeg(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
        encoding: "buffer",
      })
    ).stdout,
  );
const meanRGB = (bytes) => {
  const mean = [0, 0, 0];
  for (let i = 0; i < bytes.length; i++) mean[i % 3] += bytes[i];
  return mean.map((value) => value / (bytes.length / 3));
};
const blackRatio = (bytes) => {
  let black = 0;
  for (let i = 0; i < bytes.length; i += 3)
    if (bytes[i] < 4 && bytes[i + 1] < 4 && bytes[i + 2] < 4) black++;
  return black / (bytes.length / 3);
};
const distance = (a, b) =>
  Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
const makeSolid = async (name, color) => {
  const path = join(out, `${name}.png`);
  await runFFmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=64x48`, "-frames:v", "1", path]);
  return path;
};
try {
  await service.start();
  const importImage = async (path) => {
    const imported = await call("asset.import", { requestId: randomUUID(), path });
    const ready = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      "image import",
    );
    return call("asset.get", { assetId: ready.published.output.assetId }, { transport: "mcp" });
  };
  const red = await importImage(await makeSolid("red", "red"));
  const blue = await importImage(await makeSolid("blue", "blue"));
  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const edited = await call("edit.apply", {
    projectId: project.project.projectId,
    expectedRevisionId: project.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "red-track", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "blue-track", track: { kind: "video", order: 1 } },
      {
        operation: "place",
        label: "red",
        clip: {
          trackId: { label: "red-track" },
          assetId: red.id,
          streamId: red.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      {
        operation: "place",
        label: "blue",
        clip: {
          trackId: { label: "blue-track" },
          assetId: blue.id,
          streamId: blue.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      {
        operation: "transition",
        kind: "crossfade",
        targets: [
          { kind: "clip", id: { label: "red" } },
          { kind: "clip", id: { label: "blue" } },
        ],
        mediaKind: "video",
        window: { kind: "project", range: { startUs: 250000, endUs: 750000 } },
      },
    ],
  });
  report.project = { projectId: project.project.projectId, revisionId: edited.revision.revisionId };
  const samples = {};
  for (const atUs of [100000, 500000, 900000]) {
    const request = {
      projectId: project.project.projectId,
      revisionId: edited.revision.revisionId,
      atUs,
      maxLongEdge: 64,
    };
    const ready = await poll(
      () => call("frame.get", request),
      (value) => value.state === "ready",
      `frame ${atUs}`,
    );
    const file = join(out, `frame-${atUs}.png`);
    await call("frame.get", request, { output: file });
    samples[atUs] = {
      meanRGB: meanRGB(await decodeRGB(file)),
      output: {
        implementationId: ready.published.output.implementationId,
        frame: ready.published.output.frame,
      },
    };
  }
  report.samples = samples;
  const edge = samples[100000].meanRGB;
  assert.ok(
    distance(edge, samples[900000].meanRGB) <= 1,
    "outside the transition window, delivery stays on the same top blue layer",
  );
  assert.ok(
    samples[500000].meanRGB[0] > 20 && samples[500000].meanRGB[2] > 100,
    "midpoint contains both explicit transition sources",
  );
  assert.ok(
    distance(samples[500000].meanRGB, edge) > 20,
    "midpoint delivery changes from the outside-window control",
  );
  assert.ok(
    samples[500000].meanRGB[1] < 10,
    "solid-color crossfade does not invent a green channel",
  );
  const preview = join(out, "crossfade-preview.mp4");
  const previewResult = await poll(
    () =>
      call(
        "preview.get",
        {
          projectId: project.project.projectId,
          revisionId: edited.revision.revisionId,
          range: { startUs: 0, endUs: 1000000 },
        },
        { output: preview },
      ),
    (value) => value.state === "ready",
    "crossfade preview",
  );
  const movie = await decodeRGB(preview);
  assert.equal(movie.length, 4 * 64 * 48 * 3, "preview contains the four declared project frames");
  report.preview = { receipt: previewResult.published.output, frames: 4, rgbSha256: hash(movie) };
  const pulseResults = {};
  for (const kind of ["dip", "flash"]) {
    const pulseProject = await call("project.create", {
      requestId: randomUUID(),
      canvas: {
        width: 64,
        height: 48,
        fps: { numerator: 4, denominator: 1 },
        background: "#000000ff",
      },
    });
    const pulseEdited = await call("edit.apply", {
      projectId: pulseProject.project.projectId,
      expectedRevisionId: pulseProject.revision.revisionId,
      requestId: randomUUID(),
      operations: [
        { operation: "track.add", label: "pulse-track", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "pulse",
          clip: {
            trackId: { label: "pulse-track" },
            assetId: red.id,
            streamId: red.streams[0].streamId,
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
        {
          operation: "transition",
          kind,
          targets: [{ kind: "clip", id: { label: "pulse" } }],
          mediaKind: "video",
          window: { kind: "project", range: { startUs: 250000, endUs: 750000 } },
        },
      ],
    });
    const pulseSamples = {};
    for (const atUs of [100000, 500000, 900000]) {
      const request = {
        projectId: pulseProject.project.projectId,
        revisionId: pulseEdited.revision.revisionId,
        atUs,
        maxLongEdge: 64,
      };
      const ready = await poll(
        () => call("frame.get", request),
        (value) => value.state === "ready",
        `${kind} frame ${atUs}`,
      );
      const file = join(out, `${kind}-frame-${atUs}.png`);
      await call("frame.get", request, { output: file });
      pulseSamples[atUs] = {
        meanRGB: meanRGB(await decodeRGB(file)),
        output: {
          implementationId: ready.published.output.implementationId,
          frame: ready.published.output.frame,
        },
      };
    }
    assert.ok(distance(pulseSamples[100000].meanRGB, [255, 0, 0]) <= 1);
    assert.ok(distance(pulseSamples[900000].meanRGB, [255, 0, 0]) <= 1);
    assert.ok(pulseSamples[500000].meanRGB.every((value) => value <= 2));
    const pulsePreview = join(out, `${kind}-preview.mp4`);
    const pulsePreviewResult = await poll(
      () =>
        call(
          "preview.get",
          {
            projectId: pulseProject.project.projectId,
            revisionId: pulseEdited.revision.revisionId,
            range: { startUs: 0, endUs: 1000000 },
          },
          { output: pulsePreview },
        ),
      (value) => value.state === "ready",
      `${kind} preview`,
    );
    assert.equal((await decodeRGB(pulsePreview)).length, 4 * 64 * 48 * 3);
    pulseResults[kind] = {
      samples: pulseSamples,
      preview: { receipt: pulsePreviewResult.published.output, frames: 4 },
    };
  }
  report.pulses = pulseResults;

  const movingAssets = [
    await importImage(join(root, "specs/done/ffmpeg-parity/evidence/motion-alpha/alpha.mov")),
    await importImage(join(root, "specs/done/ffmpeg-parity/evidence/motion-alpha/mirror.mov")),
  ];
  const movingProject = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const movingEdited = await call("edit.apply", {
    projectId: movingProject.project.projectId,
    expectedRevisionId: movingProject.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "moving-a-track", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "moving-b-track", track: { kind: "video", order: 1 } },
      ...movingAssets.map((asset, index) => ({
        operation: "place",
        label: `moving-${index}`,
        clip: {
          trackId: { label: index === 0 ? "moving-a-track" : "moving-b-track" },
          assetId: asset.id,
          streamId: asset.streams.find((stream) => stream.kind === "video").streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      })),
      {
        operation: "transition",
        kind: "crossfade",
        targets: [
          { kind: "clip", id: { label: "moving-0" } },
          { kind: "clip", id: { label: "moving-1" } },
        ],
        mediaKind: "video",
        window: { kind: "project", range: { startUs: 250000, endUs: 750000 } },
      },
    ],
  });
  const movingSamples = {};
  for (const atUs of [100000, 500000, 900000]) {
    const request = {
      projectId: movingProject.project.projectId,
      revisionId: movingEdited.revision.revisionId,
      atUs,
      maxLongEdge: 64,
    };
    const ready = await poll(
      () => call("frame.get", request),
      (value) => value.state === "ready",
      `moving frame ${atUs}`,
    );
    const file = join(out, `moving-frame-${atUs}.png`);
    await call("frame.get", request, { output: file });
    const bytes = await decodeRGB(file);
    movingSamples[atUs] = {
      meanRGB: meanRGB(bytes),
      blackRatio: blackRatio(bytes),
      output: {
        implementationId: ready.published.output.implementationId,
        frame: ready.published.output.frame,
      },
    };
    assert.ok(
      movingSamples[atUs].blackRatio < 0.98,
      "moving crossfade must not expose a black gap",
    );
  }
  assert.ok(
    distance(movingSamples[500000].meanRGB, movingSamples[100000].meanRGB) > 0.5,
    "moving crossfade midpoint must differ from its outside-window control",
  );
  report.moving = { sources: movingAssets.map((asset) => asset.id), samples: movingSamples };
  const audioSourcePaths = [join(out, "audio-a.wav"), join(out, "audio-b.wav")];
  await writeSourceWave(audioSourcePaths[0], { source: 0, seconds: 1 });
  await writeSourceWave(audioSourcePaths[1], { source: 1, seconds: 1 });
  const importAudio = async (path, requestId) => {
    const imported = await call("asset.import", { requestId, path });
    const ready = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      `${requestId} import`,
    );
    return call("asset.get", { assetId: ready.published.output.assetId }, { transport: "mcp" });
  };
  const audioAssets = [
    await importAudio(audioSourcePaths[0], "audio-a"),
    await importAudio(audioSourcePaths[1], "audio-b"),
  ];
  const audioProject = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const audioEdited = await call("edit.apply", {
    projectId: audioProject.project.projectId,
    expectedRevisionId: audioProject.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "audio-a-track", track: { kind: "audio", order: 0 } },
      { operation: "track.add", label: "audio-b-track", track: { kind: "audio", order: 1 } },
      ...audioAssets.map((asset, index) => ({
        operation: "place",
        label: `audio-${index}`,
        clip: {
          trackId: { label: index === 0 ? "audio-a-track" : "audio-b-track" },
          assetId: asset.id,
          streamId: asset.streams.find((stream) => stream.kind === "audio").streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      })),
      {
        operation: "transition",
        kind: "crossfade",
        targets: [
          { kind: "clip", id: { label: "audio-0" } },
          { kind: "clip", id: { label: "audio-1" } },
        ],
        mediaKind: "audio",
        window: { kind: "project", range: { startUs: 250000, endUs: 750000 } },
      },
    ],
  });
  const audioFile = join(out, "crossfade.wav");
  const audioReady = await poll(
    () =>
      call(
        "audio.get",
        { projectId: audioProject.project.projectId, revisionId: audioEdited.revision.revisionId },
        { output: audioFile },
      ),
    (value) => value.state === "ready",
    "audio crossfade",
  );
  const audioBytes = await readFile(audioFile);
  const audioHeader = waveHeader(audioBytes, audioBytes.length);
  const audioPcm = audioBytes.subarray(audioHeader.offset);
  const audioSamples = {};
  for (const atUs of [100000, 500000, 900000]) {
    const frame = Math.floor((atUs * 48000) / 1000000);
    const offset = frame * 8;
    const actual = [audioPcm.readFloatLE(offset), audioPcm.readFloatLE(offset + 4)];
    const phase = Math.min(1, Math.max(0, (atUs - 250000) / 500000));
    const expected = [0, 1].map((channel) =>
      Math.fround(
        phase === 0 || phase === 1
          ? sample(0, frame, channel) / 32768 + sample(1, frame, channel) / 32768
          : Math.fround((sample(0, frame, channel) / 32768) * Math.fround(1 - phase)) +
              Math.fround((sample(1, frame, channel) / 32768) * Math.fround(phase)),
      ),
    );
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) < 1 / 32768));
    audioSamples[atUs] = { actual, expected, frame };
  }
  report.audio = {
    receipt: audioReady.published.output,
    samples: audioSamples,
    sourceFrames: audioHeader.frames,
  };
  report.checks.push(
    "public CLI/MCP asset import and transition authoring",
    "native frame delivery keeps outside-window controls and mixes both explicit sources at midpoint",
    "native preview delivery contains the declared four project frames",
    "native dip and flash picture pulses reach the black midpoint and restore the source",
    "native moving crossfade keeps a non-black perimeter and changes at its midpoint",
    "native audio crossfade delivery matches the independent two-source PCM oracle",
  );
  report.passed = true;
} finally {
  await save();
  await service.stop();
  await rm(home, { recursive: true, force: true });
}
await save();
console.log(
  JSON.stringify({ passed: report.passed, out, checks: report.checks, samples: report.samples }),
);
