import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { JourneyService, poll, root } from "./source-evidence-fixture.mjs";
import {
  tutorialInputs,
  identifyFile,
  bindMarkedSpeech,
  sourceRange,
  requireSupport,
} from "./acceptance-inputs.mjs";
const { values } = parseArgs({
  options: {
    case: { type: "string" },
    prepare: { type: "boolean" },
    resume: { type: "boolean" },
    transport: { type: "string", default: "both" },
    out: { type: "string" },
    "media-root": { type: "string" },
  },
});
assert.equal(values.case, "tutorial", "Only the bounded tutorial fixture is defined");
assert.ok(
  values.prepare,
  "Fresh external-caller acceptance is separate; use --prepare for input admission",
);
assert.ok(
  values.out && values["media-root"],
  "Pass --out fresh-directory and --media-root retained-source-directory",
);
assert.ok(["both", "cli", "mcp"].includes(values.transport));
assert.ok(process.env.YAP_NATIVE, "Pin YAP_NATIVE to the compatible frozen native worker");
const out = resolve(values.out);
let prior;
if (values.resume) {
  const bytes = await readFile(join(out, "report.json"));
  prior = JSON.parse(bytes);
  assert.equal(
    prior.scope,
    "preparation only; no fresh external caller or integrated output acceptance",
  );
  assert.ok(
    prior.home.startsWith(join(out, "library-")),
    "Resume requires the same isolated preparation home",
  );
  await writeFile(join(out, `prior-report-${Date.now()}.json`), bytes, { flag: "wx" });
} else await mkdir(out, { recursive: false });
const home = prior?.home ?? (await mkdtemp(join(out, "library-")));
const report = {
  passed: false,
  scope: "preparation only; no fresh external caller or integrated output acceptance",
  performance: "unmeasured",
  trace: [],
  exchanges: [],
  home,
  worker: await identifyFile(process.env.YAP_NATIVE),
  inputs: [],
  bindings: {},
  modelStatus: [],
};
if (prior)
  assert.equal(
    prior.worker.sha256,
    report.worker.sha256,
    "Resume requires the pinned native worker",
  );
const service = new JourneyService(
  home,
  report,
  join(out, "native"),
  new URL("./first-preview-service.mjs", import.meta.url),
);
let ordinal = 0;
const call = (operation, params, options = {}) =>
  service.call(operation, params, {
    transport: values.transport === "both" ? (ordinal++ % 2 ? "mcp" : "cli") : values.transport,
    ...options,
  });
try {
  const plan = await tutorialInputs(root, resolve(values["media-root"]), out);
  report.authorities = plan.authorities;
  report.provenance = plan.provenance;
  if (prior)
    assert.equal(prior.brief.sha256, plan.brief.sha256, "Resume requires the same execution brief");
  await writeFile(join(out, "fixture-brief.md"), await readFile(plan.brief.path));
  report.briefAuthority = plan.brief;
  report.brief = await identifyFile(join(out, "fixture-brief.md"), plan.brief);
  report.references = plan.references;
  report.screenAuthority = plan.screenAuthority;
  await service.start();
  const assets = {};
  for (const input of plan.inputs) {
    const request = prior?.inputs.find((v) => v.key === input.key)?.request ?? {
      requestId: randomUUID(),
      path: input.path,
    };
    assert.equal(request.path, input.path, "Resume must retain the same bound input path");
    const admitted = await call("asset.import", request);
    const ready = await poll(
      () => call("job.get", { jobId: admitted.jobId }),
      (v) => v.state === "ready",
      input.key,
    );
    const asset = await call("asset.get", { assetId: ready.published.output.assetId });
    assert.equal(asset.id, input.sha256, "Admitted media differs from the frozen fixture bytes");
    const streams = [];
    for (const stream of asset.streams) {
      const segments = [];
      let cursor;
      do {
        const page = await call("asset.segments", {
          assetId: asset.id,
          streamId: stream.id,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        segments.push(...page.segments);
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(segments.length, stream.segmentCount);
      streams.push({ ...stream, segments });
    }
    const choices = streams.filter((v) => v.kind === input.kind && v.decodable);
    if (input.kind !== "font")
      assert.equal(choices.length, 1, "Fixture stream choice must be unambiguous");
    else
      assert.ok(
        asset.fontFaces.some((v) => v.postScriptName === "ArialMT"),
        "The pinned font face must exist",
      );
    assets[input.key] = {
      ...asset,
      streams,
      selected: choices[0] ? { assetId: asset.id, streamId: choices[0].id } : null,
    };
    report.inputs.push({ ...input, request, admitted, asset: assets[input.key] });
    const replay = await call("asset.import", request);
    assert.equal(replay.jobId, admitted.jobId, "Exact import replay duplicated work");
  }
  const selected = (key) => assets[key].selected;
  const speech = bindMarkedSpeech(plan.marks, assets.workbenchNarration);
  const speechRows = assets.workbenchNarration.streams.find(
    (v) => v.id === selected("workbenchNarration").streamId,
  ).segments;
  requireSupport(speechRows, speech.contextAssetRange);
  assert.equal(
    assets.workbenchNarration.streams.find((v) => v.kind === "audio").sampleRate,
    plan.marks.binding.sampleRate,
  );
  report.bindings.markedSpeech = {
    source: selected("workbenchNarration"),
    sourceOriginUs: assets.workbenchNarration.originUs,
    ...speech,
    joinRamp: {
      frames: plan.cleanup.rampFrames,
      sampleRate: plan.marks.binding.sampleRate,
      authority:
        report.authorities[
          "specs/done/agent-editing/assets/12e-labeled-cleanup/native-report.json"
        ],
    },
    acceptedMapping: plan.cleanup.mapping,
  };
  const retimed = plan.retime.results.find((v) => v.path === "internal-slower-0.8x.wav");
  const retimeRange = {
    startUs: (retimed.sourceFrames[0] * 1000000) / plan.retime.sampleRate,
    endUs: (retimed.sourceFrames[1] * 1000000) / plan.retime.sampleRate,
  };
  assert.equal(assets.retimeOriginal.originUs, 0);
  assert.equal(
    assets.retimeOriginal.streams.find((v) => v.kind === "audio").sampleRate,
    plan.retime.sampleRate,
  );
  requireSupport(assets.retimeOriginal.streams[0].segments, retimeRange);
  report.bindings.retime = {
    source: selected("retimeOriginal"),
    sourceFrames: retimed.sourceFrames,
    sampleRate: plan.retime.sampleRate,
    assetRange: retimeRange,
    rate: retimed.rate,
    declaredOutput: retimed.declaredOutput,
  };
  report.bindings.interlude = {};
  for (const key of ["camera", "screen", "microphone"]) {
    const source = assets[key],
      range = { startUs: 10000000, endUs: 12000000 };
    requireSupport(source.streams.find((v) => v.id === source.selected.streamId).segments, range);
    report.bindings.interlude[key] = {
      source: source.selected,
      assetRange: range,
      originalMediaRange: {
        startUs: range.startUs + source.originUs,
        endUs: range.endUs + source.originUs,
      },
      sourceOriginUs: source.originUs,
      physicalSynchronization: "unverified",
    };
  }
  const recipe = plan.word.cases.find((v) => v.id === "word"),
    frozenVoice = plan.voice.receipts.find((v) => v.text === "paid");
  report.bindings.voice = {
    context: selected("voiceContext"),
    contextOriginalRange: { startUs: 71500000, endUs: 76500000 },
    replacementInContext: sourceRange(
      { startUs: recipe.replacedTimelineRangeUs[0], endUs: recipe.replacedTimelineRangeUs[1] },
      71500000,
    ),
    recipe,
    request: {
      modelId: frozenVoice.modelId,
      reference: selected("voiceReference"),
      referenceText: frozenVoice.referenceText,
      text: frozenVoice.text,
      seed: frozenVoice.seed,
      generation: frozenVoice.generation,
    },
    status: "new local synthesis not executed",
    referenceTextAuthority: "inherited ASR; existing acceptance scope unchanged",
  };
  report.bindings.pause = {
    source: selected("pauseLoop"),
    durationUs: 600000,
    selection: "accepted 200ms loop; slight seam tolerated",
    gainAndTransitions: "external caller must explicitly choose and record",
  };
  report.bindings.music = {
    source: selected("music"),
    durationUs: 2000000,
    gainKeys: [
      { atUs: 0, gain: 0 },
      { atUs: 500000, gain: 0.125 },
      { atUs: 1500000, gain: 0.125 },
      { atUs: 2000000, gain: 0 },
    ],
  };
  const request = prior?.projectRequest ??
    prior?.exchanges.find((v) => v.request.operation === "project.create")?.request.params ?? {
      requestId: randomUUID(),
      title: "External caller primitive fixture",
      canvas: {
        width: 1280,
        height: 720,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    };
  report.projectRequest = request;
  const created = await call("project.create", request);
  const replay = await call("project.create", request);
  assert.equal(replay.project.projectId, created.project.projectId);
  assert.equal(replay.revision.revisionId, created.revision.revisionId);
  report.project = await call("project.get", { projectId: created.project.projectId });
  assert.equal(report.project.currentRevisionId, created.revision.revisionId);
  report.revision = (
    await call("revision.get", {
      projectId: created.project.projectId,
      revisionId: created.revision.revisionId,
    })
  ).revision;
  assert.deepEqual(report.revision.document.canvas, request.canvas);
  assert.deepEqual(
    report.revision.document.clips,
    [],
    "Preparation must leave the caller an unedited project",
  );
  const models = await call("model.list", {});
  report.models = models;
  for (const model of models)
    report.modelStatus.push({
      modelId: model.modelId,
      ...(await call("model.status", { modelId: model.modelId })),
    });
  report.gaps = [
    "Fresh external-caller discovery/edit/delivery/recovery journey not run",
    "Current isolated models require explicit preparation before model-dependent operations",
    "No canonical current transcript generation admitted; saved marks bind directly to original source",
    "Integrated visual/listening acceptance and physical synchronization remain separate",
  ];
  for (const input of report.inputs) await identifyFile(input.path, input);
  await writeFile(
    join(out, "caller-inputs.json"),
    JSON.stringify(
      {
        scope: report.scope,
        brief: report.brief,
        libraryHome: home,
        projectId: created.project.projectId,
        revisionId: created.revision.revisionId,
        inputs: report.inputs.map(({ key, sha256, bytes, asset }) => ({
          key,
          sha256,
          bytes,
          assetId: asset.id,
          originUs: asset.originUs,
          selected: asset.selected,
          fontFaces: asset.fontFaces,
        })),
        bindings: report.bindings,
        references: report.references,
        modelStatus: report.modelStatus,
        gaps: report.gaps,
      },
      null,
      2,
    ),
  );
  report.nativeOperations = (await readFile(join(out, "native/operations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    !report.nativeOperations.some((v) =>
      /capture|speech|generateVoice|renderComposition|outputCapabilities/.test(v.operation),
    ),
    "Preparation invoked inference, capture or media rendering",
  );
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    passed: report.passed,
    scope: report.scope,
    inputs: join(out, "caller-inputs.json"),
  }),
);
