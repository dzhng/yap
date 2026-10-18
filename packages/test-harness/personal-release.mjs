// The caller journey: inspect one retained capture through its admitted sources, explicitly author
// a project, apply only caller-supplied cut ranges, then export and adopt the relocated project.
//
//   node packages/test-harness/personal-release.mjs --edit-plan <json> [--recording <id>]
//
// The phrase search is evidence only. This harness never deletes a recording, prepares a model,
// or infers edit intent from transcript classifications.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  add,
  compare,
  divide,
  fromTime,
  rational,
  round,
  subtract,
  toTime,
} from "@yap/composition";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    recording: { type: "string" },
    out: { type: "string" },
    cli: { type: "string", default: join(homedir(), ".local", "bin", "yap") },
    phrase: { type: "string", default: "this is free" },
    "edit-plan": { type: "string" },
  },
});
const out = values.out ?? mkdtempSync("/tmp/yap-journey-");
mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, detail) => {
  report.steps.push({ name, at: new Date().toISOString(), ...detail });
  const summary = JSON.stringify(detail);
  console.log(`${name}: ${summary.length > 220 ? summary.slice(0, 220) + "…" : summary}`);
};

function call(operation, params = {}, options = {}) {
  const result = spawnSync(
    values.cli,
    [operation, "--params", JSON.stringify(params), ...(options.args ?? [])],
    { cwd: "/", encoding: "utf8", timeout: options.timeoutMs ?? 200_000 },
  );
  if (result.error) throw result.error;
  const answer = JSON.parse(result.stdout || result.stderr || "{}");
  if (!answer.ok && !options.allowFailure)
    throw new Error(`${operation} failed: ${JSON.stringify(answer.error ?? answer)}`);
  return answer.ok ? answer.data : { error: answer.error };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Media is prepared in the background: the first answer is readiness, not the file. */
async function media(operation, params, file, budgetMs = 600_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const answer = call(operation, params, { args: ["--output", file] });
    const items = answer.items ?? [answer];
    const rejected = items.find((item) => item.ok === false || item.error);
    if (rejected) throw new Error(`${operation} item ${JSON.stringify(rejected)}`);
    if (items.every((item) => (item.data ?? item).state === "ready")) return answer;
    const stopped = items.find((item) =>
      ["failed", "unavailable", "canceled"].includes((item.data ?? item).state),
    );
    if (stopped) throw new Error(`${operation} ${JSON.stringify(stopped)}`);
    if (Date.now() > deadline) throw new Error(`${operation} never became ready`);
    await wait(1000);
  }
}

/** Poll the operation's own readiness contract; model preparation stays explicit. */
async function ready(operation, params, label, budgetMs = 900_000, measureWorker = false) {
  const deadline = Date.now() + budgetMs;
  let peakResidentBytes = 0,
    startedAt;
  for (;;) {
    const status = call(operation, params);
    if (status.state === "ready")
      return { ...status, peakResidentBytes, elapsedMs: startedAt ? Date.now() - startedAt : 0 };
    if (["failed", "unavailable", "canceled", "cleanup_failed", "closed"].includes(status.state))
      throw new Error(`${label} is ${status.state}: ${status.reason ?? "no reason given"}`);
    startedAt ??= Date.now();
    if (measureWorker) peakResidentBytes = Math.max(peakResidentBytes, workerResidentBytes());
    if (Date.now() > deadline) throw new Error(`${label} did not become ready`);
    await wait(500);
  }
}

/** Resident bytes of the media worker, when one is running. */
function workerResidentBytes() {
  const listed = execFileSync("/bin/ps", ["-axo", "rss=,command="], { encoding: "utf8" });
  let peak = 0;
  for (const line of listed.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && match[2].includes("yap-native")) peak = Math.max(peak, Number(match[1]) * 1024);
  }
  return peak;
}

/** Continue a readiness result without losing its pinned generation. */
function pages(operation, params, first, take = (page) => page.rows ?? page.entries ?? []) {
  const page = first.page ?? first;
  const all = [...take(page)];
  let cursor = page.nextCursor;
  const seen = new Set();
  while (cursor) {
    const identity = JSON.stringify(cursor);
    if (seen.has(identity)) throw new Error(`${operation} continuation repeated its cursor`);
    seen.add(identity);
    const next = call(operation, { ...params, cursor });
    if (next.state !== "ready" || next.generation !== first.generation)
      throw new Error(`${operation} continuation changed readiness or generation`);
    const nextPage = next.page ?? next;
    all.push(...take(nextPage));
    cursor = nextPage.nextCursor;
  }
  return all;
}

const sourceClockUs = (assetUs, offset) => subtract(fromTime(assetUs), fromTime(offset));
const projectUs = (assetUs, offset, timelineStart) =>
  toTime(subtract(sourceClockUs(assetUs, offset), timelineStart));
const supportsRange = (ranges, selected) =>
  ranges.some(
    (range) =>
      compare(fromTime(range.startUs), fromTime(selected.startUs)) <= 0 &&
      compare(fromTime(selected.endUs), fromTime(range.endUs)) <= 0,
  );

const main = async () => {
  if (!values["edit-plan"])
    throw new Error(
      "An explicit edit plan is required: pass --edit-plan with caller-selected ranges",
    );
  const editPlan = JSON.parse(readFileSync(values["edit-plan"], "utf8"));
  if (
    !editPlan ||
    typeof editPlan !== "object" ||
    !Array.isArray(editPlan.cuts) ||
    editPlan.cuts.length === 0 ||
    editPlan.cuts.some(
      (cut) =>
        !cut ||
        typeof cut !== "object" ||
        cut.intent !== "remove" ||
        !Number.isSafeInteger(cut.sourceRange?.startUs) ||
        !Number.isSafeInteger(cut.sourceRange?.endUs) ||
        cut.sourceRange.startUs < 0 ||
        cut.sourceRange.endUs <= cut.sourceRange.startUs,
    )
  )
    throw new Error("The explicit edit plan must contain caller-selected remove ranges");
  const recordingId = values.recording ?? call("recording.get")?.recordingId;
  if (!recordingId) throw new Error("No recording to inspect; record a take first");
  const recording = call("recording.get", { recordingId });
  step("recording", {
    recordingId,
    state: recording.state,
    sourceAdmissions: recording.sourceAdmissions?.map(({ kind, sourceId, acquisitionId, job }) => ({
      kind,
      sourceId,
      acquisitionId,
      jobState: job?.state ?? null,
    })),
  });

  const primaryAdmissions =
    recording.sourceAdmissions?.filter((admission) => admission.kind === "primary") ?? [];
  if (primaryAdmissions.length !== 1)
    throw new Error("Choose a capture with exactly one primary source admission");
  const primary = primaryAdmissions[0];
  if (!primary?.acquisitionId || !primary.job?.jobId)
    throw new Error("The settled primary capture has no admitted source job");
  const sourceJob = await ready(
    "job.get",
    { jobId: primary.job.jobId },
    "primary source admission",
  );
  if (sourceJob.state !== "ready") throw new Error("Primary source admission is not ready");
  const acquisition = call("acquisition.get", { acquisitionId: primary.acquisitionId });
  const videoBindings = acquisition.bindings.filter((binding) =>
    binding.sourceRoles.includes("video"),
  );
  const narrationBindings = acquisition.bindings.filter((binding) =>
    binding.sourceRoles.includes("narration"),
  );
  if (videoBindings.length !== 1 || narrationBindings.length !== 1)
    throw new Error("The primary capture must admit exactly one video and narration stream");
  const [videoBinding] = videoBindings;
  const [narrationBinding] = narrationBindings;
  const videoSelection = {
    assetId: videoBinding.assetId,
    streamId: videoBinding.streamId,
    acquisitionId: acquisition.id,
  };
  const narrationSelection = {
    assetId: narrationBinding.assetId,
    streamId: narrationBinding.streamId,
    acquisitionId: acquisition.id,
  };
  const [videoAsset, audioAsset] = [
    call("asset.get", { assetId: videoBinding.assetId }),
    call("asset.get", { assetId: narrationBinding.assetId }),
  ];
  const videoStream = videoAsset.streams.find((stream) => stream.id === videoBinding.streamId);
  const audioStream = audioAsset.streams.find((stream) => stream.id === narrationBinding.streamId);
  if (videoStream?.kind !== "video" || audioStream?.kind !== "audio")
    throw new Error("Selected capture bindings do not resolve to a video and audio stream");
  if (!videoBinding.available.length || !narrationBinding.available.length)
    throw new Error("Selected capture bindings contain no available source ranges");
  step("selected source", {
    acquisitionId: acquisition.id,
    video: videoSelection,
    narration: narrationSelection,
    sourceToAssetOffsetUs: {
      video: videoBinding.sourceToAssetOffsetUs,
      narration: narrationBinding.sourceToAssetOffsetUs,
    },
  });

  const commonStarts = [videoBinding, narrationBinding].flatMap((binding) =>
    binding.available.map((range) => sourceClockUs(range.startUs, binding.sourceToAssetOffsetUs)),
  );
  const timelineStart = commonStarts.reduce((earliest, value) =>
    compare(value, earliest) < 0 ? value : earliest,
  );
  const projectRange = (range, binding) => ({
    startUs: projectUs(range.startUs, binding.sourceToAssetOffsetUs, timelineStart),
    endUs: projectUs(range.endUs, binding.sourceToAssetOffsetUs, timelineStart),
  });
  const projectEnd = Math.max(
    ...[videoBinding, narrationBinding].flatMap((binding) =>
      binding.available.map((range) =>
        round(subtract(sourceClockUs(range.endUs, binding.sourceToAssetOffsetUs), timelineStart)),
      ),
    ),
  );
  for (const cut of editPlan.cuts)
    if (!supportsRange(narrationBinding.available, cut.sourceRange))
      throw new Error("An explicit caller-selected cut range is outside narration support");
  const plannedProjectRanges = editPlan.cuts
    .map((cut) => ({
      sourceRange: cut.sourceRange,
      projectRange: {
        // edit.remove accepts integer microseconds; convert exact rational capture offsets once.
        startUs: round(
          subtract(
            sourceClockUs(cut.sourceRange.startUs, narrationBinding.sourceToAssetOffsetUs),
            timelineStart,
          ),
        ),
        endUs: round(
          subtract(
            sourceClockUs(cut.sourceRange.endUs, narrationBinding.sourceToAssetOffsetUs),
            timelineStart,
          ),
        ),
      },
    }))
    .sort((left, right) => left.projectRange.startUs - right.projectRange.startUs);
  if (
    plannedProjectRanges.some(
      ({ projectRange }) =>
        projectRange.startUs < 0 ||
        projectRange.endUs > projectEnd ||
        projectRange.endUs <= projectRange.startUs,
    ) ||
    plannedProjectRanges.some(
      ({ projectRange }, index) =>
        index > 0 && plannedProjectRanges[index - 1].projectRange.endUs > projectRange.startUs,
    )
  )
    throw new Error("Explicit cut ranges must map to disjoint, non-empty project ranges");
  const removedUs = plannedProjectRanges.reduce(
    (total, { projectRange }) => total + projectRange.endUs - projectRange.startUs,
    0,
  );
  if (removedUs >= projectEnd)
    throw new Error("Explicit cuts would remove the entire project timeline");
  const retainedVideoStarts = videoBinding.available.flatMap((range) => {
    const { startUs, endUs } = projectRange(range, videoBinding);
    let cursor = startUs;
    const retained = [];
    for (const { projectRange: cut } of plannedProjectRanges) {
      if (cut.endUs <= cursor || cut.startUs >= endUs) continue;
      if (cut.startUs > cursor) retained.push(cursor);
      cursor = Math.max(cursor, cut.endUs);
    }
    if (cursor < endUs) retained.push(cursor);
    return retained.map(
      (startUs) =>
        startUs -
        plannedProjectRanges
          .filter((cut) => cut.projectRange.endUs <= startUs)
          .reduce((total, cut) => total + cut.projectRange.endUs - cut.projectRange.startUs, 0),
    );
  });
  if (!retainedVideoStarts.length)
    throw new Error("Explicit cuts would remove every available video frame");
  const firstVisibleVideoStart = Math.min(...retainedVideoStarts);

  const transcriptStartedAt = Date.now();
  call("transcript.transcribe", narrationSelection);
  const transcriptFirst = await ready(
    "transcript.get",
    { ...narrationSelection, limit: 250 },
    "selected-source transcript",
    900_000,
    true,
  );
  const rows = pages("transcript.get", { ...narrationSelection, limit: 1000 }, transcriptFirst);
  const words = rows.filter((row) => row.type === "word");
  const fillers = words.filter((word) => word.kind === "filler");
  const transcriptMetadata = transcriptFirst.page.transcript;
  const engine = transcriptMetadata.engine;
  const narrationDurationUs = round(
    narrationBinding.available.reduce(
      (duration, range) => add(duration, subtract(fromTime(range.endUs), fromTime(range.startUs))),
      rational(0n),
    ),
  );
  writeFileSync(join(out, "source-transcript.json"), JSON.stringify(rows, null, 2) + "\n");
  step("source transcript", {
    generation: transcriptFirst.generation,
    elapsedMs: Date.now() - transcriptStartedAt,
    peakResidentBytes: transcriptFirst.peakResidentBytes,
    timesRealTime: (Date.now() - transcriptStartedAt) / (narrationDurationUs / 1000),
    engine: {
      runtime: engine.runtime,
      model: engine.model,
      encoderPrecision: engine.encoderPrecision,
    },
    words: words.length,
    fillers: fillers.map((word) => [word.id, word.text, word.sourceRange.startUs]),
    gaps: rows.filter((row) => row.type === "gap").map((row) => row.sourceRange),
    text: words.map((word) => word.text).join(" "),
  });

  const sourceIndexFirst = await ready(
    "index.get",
    { ...videoSelection, limit: 1 },
    "selected-source screenshot index",
  );
  const selected = pages("index.get", { ...videoSelection, limit: 200 }, sourceIndexFirst);
  step("source screenshot index", {
    generation: sourceIndexFirst.generation,
    selected: selected.length,
    reasons: selected.flatMap(
      (entry) => entry.candidate?.reasons?.map((reason) => reason.kind) ?? [],
    ),
  });
  if (selected.length) {
    const ordinals = selected.slice(0, 2).map((entry) => entry.ordinal ?? entry.candidate.ordinal);
    await media(
      "index.frames",
      { ...videoSelection, generation: sourceIndexFirst.generation, ordinals },
      join(out, "index-frame"),
    );
    step("index images", { ordinals, files: `${out}/index-frame*` });
  }

  const sourceSupport = videoBinding.available[0];
  const sourceFrameAtUs = round(
    divide(add(fromTime(sourceSupport.startUs), fromTime(sourceSupport.endUs)), rational(2n)),
  );
  await media(
    "frame.batch",
    { ...videoSelection, atUs: [sourceFrameAtUs] },
    join(out, "supported-source-frame"),
  );
  step("arbitrary source frame", { atUs: sourceFrameAtUs });

  const found = call("transcript.search", {
    ...narrationSelection,
    text: values.phrase,
    limit: 100,
  });
  const phrase = found.page?.entries?.[0];
  step("phrase search evidence", { phrase: values.phrase, entry: phrase ?? null });

  const canvas = {
    width: Math.min(4096, Math.max(1, Math.round(videoStream.width))),
    height: Math.min(4096, Math.max(1, Math.round(videoStream.height))),
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const created = call("project.create", {
    requestId: randomUUID(),
    title: "Personal release caller project",
    canvas,
  });
  const projectId = created.project.projectId;
  const videoTrack = "picture";
  const audioTrack = "narration";
  const placements = [
    { operation: "track.add", label: videoTrack, track: { kind: "video", order: 0 } },
    { operation: "track.add", label: audioTrack, track: { kind: "audio", order: 0 } },
  ];
  const placementLabels = [];
  for (const [kind, binding, selection, track] of [
    ["picture", videoBinding, videoSelection, videoTrack],
    ["narration", narrationBinding, narrationSelection, audioTrack],
  ])
    for (const [index, range] of binding.available.entries()) {
      const label = `${kind}-${index}`;
      placementLabels.push(label);
      placements.push({
        operation: "place",
        label,
        clip: {
          ...selection,
          trackId: { label: track },
          source: { kind: "range", range },
          placement: { kind: "project", range: projectRange(range, binding) },
        },
      });
    }
  const placed = call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.revisionId,
    operations: placements,
  });
  let revisionId = placed.revision.revisionId;
  const projectClips = placementLabels.map((label) => placed.edit.labels[label]);
  const videoTrackId = placed.edit.labels[videoTrack];
  const audioTrackId = placed.edit.labels[audioTrack];
  const originalRevisionId = revisionId;
  const edit = call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: revisionId,
    operations: [
      {
        operation: "remove",
        clipIds: projectClips,
        ranges: plannedProjectRanges.map(({ projectRange }) => projectRange),
        scope: "selected",
        ripple: { trackIds: [videoTrackId, audioTrackId] },
      },
    ],
  });
  revisionId = edit.revision.revisionId;
  step("explicit project cuts", {
    projectId,
    revisionId,
    sourceRanges: plannedProjectRanges.map(({ sourceRange, projectRange }) => ({
      sourceRange,
      projectRange,
    })),
    sourceToAssetOffsetUs: narrationBinding.sourceToAssetOffsetUs,
  });
  const stale = call(
    "edit.apply",
    {
      projectId,
      requestId: randomUUID(),
      expectedRevisionId: originalRevisionId,
      operations: [
        {
          operation: "remove",
          clipIds: projectClips,
          ranges: plannedProjectRanges.map(({ projectRange }) => projectRange),
          scope: "selected",
          ripple: { trackIds: [videoTrackId, audioTrackId] },
        },
      ],
    },
    { allowFailure: true },
  );
  if (stale.error?.code !== "STALE_REVISION")
    throw new Error(`Stale edit was not refused: ${JSON.stringify(stale)}`);
  step("stale edit refused", { code: stale.error.code });

  const projectTranscriptFirst = await ready(
    "transcript.get",
    { projectId, revisionId, trackIds: [audioTrackId], limit: 250 },
    "project transcript",
    900_000,
    true,
  );
  const projectRows = pages(
    "transcript.get",
    { projectId, revisionId, trackIds: [audioTrackId], limit: 1000 },
    projectTranscriptFirst,
  );
  writeFileSync(join(out, "project-transcript.json"), JSON.stringify(projectRows, null, 2) + "\n");
  const projectPhrase = call("transcript.search", {
    projectId,
    revisionId,
    trackIds: [audioTrackId],
    text: values.phrase,
    limit: 100,
  });
  step("project transcript evidence", {
    generation: projectTranscriptFirst.generation,
    words: projectRows.filter((row) => row.type === "word").length,
    phrase: values.phrase,
    matches: projectPhrase.page?.entries ?? [],
  });

  const projectIndexFirst = await ready(
    "index.get",
    { projectId, revisionId, limit: 1 },
    "project screenshot index",
  );
  const projectIndex = pages("index.get", { projectId, revisionId, limit: 200 }, projectIndexFirst);
  step("project screenshot index", {
    generation: projectIndexFirst.generation,
    selected: projectIndex.length,
  });
  if (projectIndex.length) {
    const ordinals = projectIndex
      .slice(0, 2)
      .map((entry) => entry.ordinal ?? entry.candidate.ordinal);
    await media(
      "index.frames",
      {
        projectId,
        revisionId,
        generation: projectIndexFirst.generation,
        maxLongEdge: projectIndexFirst.page.metadata.maxLongEdge,
        tap: projectIndexFirst.page.metadata.tap,
        ordinals,
      },
      join(out, "project-index-frame"),
    );
    step("project index images", { ordinals });
  }
  const projectDurationAfterCuts = projectEnd - removedUs;
  const projectSampleAtUs = projectIndex[0]?.candidate?.sampleAtUs ?? firstVisibleVideoStart;
  await media(
    "frame.batch",
    { projectId, revisionId, atUs: [projectSampleAtUs] },
    join(out, "project-frame"),
  );
  step("project frame", { atUs: projectSampleAtUs });

  const clips = [];
  for (const [index, cut] of plannedProjectRanges.entries()) {
    const paddedStartUs = round(subtract(fromTime(cut.sourceRange.startUs), fromTime(1_500_000)));
    const paddedEndUs = round(add(fromTime(cut.sourceRange.endUs), fromTime(1_500_000)));
    const sourceBounds = {
      startUs: Math.max(0, paddedStartUs),
      endUs: Math.min(round(fromTime(audioStream.bounds.endUs)), paddedEndUs),
    };
    const beforeCut = await media(
      "audio.get",
      { ...narrationSelection, range: sourceBounds },
      join(out, `before-cut-${index}.wav`),
    );
    const removedBeforeUs = plannedProjectRanges
      .filter((prior) => prior.projectRange.endUs <= cut.projectRange.startUs)
      .reduce((total, prior) => total + prior.projectRange.endUs - prior.projectRange.startUs, 0);
    const projectBounds = {
      startUs: Math.max(0, cut.projectRange.startUs - removedBeforeUs - 1_500_000),
      endUs: Math.min(
        projectDurationAfterCuts,
        cut.projectRange.endUs - removedBeforeUs + 1_500_000,
      ),
    };
    await media(
      "audio.get",
      { projectId, revisionId, range: projectBounds },
      join(out, `after-cut-${index}.wav`),
    );
    clips.push({
      source: sourceBounds,
      sourceUnavailable: beforeCut.published?.output?.unavailable ?? null,
      project: projectBounds,
    });
  }
  step("audio clips around explicit cuts", { clips });

  const history = call("revision.history", { projectId, limit: 50 });
  const undone = call("edit.undo", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: revisionId,
  });
  step("undo", {
    historyEntries: (history.entries ?? history.revisions ?? []).length,
    now: undone.id,
  });
  const restored = call("edit.restore", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: undone.id,
    targetRevisionId: revisionId,
  });
  revisionId = restored.id;
  step("restore", { now: revisionId });

  const preview = await media(
    "preview.get",
    { projectId, revisionId },
    join(out, "preview.mp4"),
    600_000,
  );
  step("preview", { projectId, revisionId, file: join(out, "preview.mp4"), state: preview.state });

  const exports = {};
  for (const [kind, leaf] of [
    ["video", "demo.mp4"],
    ["processed-package", "demo.zip"],
  ]) {
    const exportId = randomUUID();
    call("export.create", {
      projectId,
      requestId: exportId,
      kind,
      revisionId,
      directory: out,
      leaf,
    });
    const deadline = Date.now() + 900_000;
    for (;;) {
      const status = call("export.status", { exportId });
      if (status.state === "ready") {
        exports[kind] = { exportId, output: status.output };
        break;
      }
      if (["failed", "unavailable", "canceled"].includes(status.state))
        throw new Error(`${kind} export ${status.state}: ${status.reason}`);
      if (Date.now() > deadline) throw new Error(`${kind} export never became ready`);
      await wait(1000);
    }
    step(`export ${kind}`, exports[kind]);
  }

  // Relocation: adoption gives the moved package a fresh durable project identity.
  // Opening a package refuses symlinked path components, and /tmp is one.
  const moved = join(realpathSync(mkdtempSync("/tmp/yap-moved-")), "relocated.zip");
  renameSync(exports["processed-package"].output, moved);
  const admission = call("package.open", { path: moved });
  // Whatever happens from here, the service must not be left holding this package open with its
  // extracted copy on disk: it is the person's own service, not one a run can walk away from.
  const closeAdmission = () => {
    try {
      call("package.close", { admissionId: admission.id }, { allowFailure: true });
    } catch {
      // Already closed, or the service is gone with it.
    }
  };
  process.once("exit", closeAdmission);
  try {
    const opened = await ready(
      "package.status",
      { admissionId: admission.id },
      "package open",
      300_000,
    );
    const adopted = await ready(
      "package.adopt",
      { packageHandle: opened.packageHandle, requestId: randomUUID() },
      "package adoption",
      900_000,
    );
    const adoptedProjectId = adopted.projectId;
    const adoptedRevisionId = adopted.revisionId;
    if (!adoptedProjectId || !adoptedRevisionId)
      throw new Error("Package adoption did not return a project and revision");
    const adoptedProject = call("project.get", { projectId: adoptedProjectId });
    if (adoptedProject.currentRevisionId !== adoptedRevisionId)
      throw new Error("Adopted project head differs from the adopted revision");
    const adoptedTranscriptFirst = await ready(
      "transcript.get",
      { projectId: adoptedProjectId, revisionId: adoptedRevisionId, limit: 250 },
      "adopted project transcript",
    );
    const adoptedRows = pages(
      "transcript.get",
      { projectId: adoptedProjectId, revisionId: adoptedRevisionId, limit: 1000 },
      adoptedTranscriptFirst,
    );
    if (JSON.stringify(adoptedRows) !== JSON.stringify(projectRows))
      throw new Error("Adopted transcript differs from the exported project");
    const adoptedIndex = await ready(
      "index.get",
      { projectId: adoptedProjectId, revisionId: adoptedRevisionId, limit: 1 },
      "adopted project index",
    );
    const adoptedOrdinals = pages(
      "index.get",
      { projectId: adoptedProjectId, revisionId: adoptedRevisionId, limit: 200 },
      adoptedIndex,
    )
      .slice(0, 2)
      .map((entry) => entry.ordinal ?? entry.candidate.ordinal);
    if (adoptedOrdinals.length)
      await media(
        "index.frames",
        {
          projectId: adoptedProjectId,
          revisionId: adoptedRevisionId,
          generation: adoptedIndex.generation,
          maxLongEdge: adoptedIndex.page.metadata.maxLongEdge,
          tap: adoptedIndex.page.metadata.tap,
          ordinals: adoptedOrdinals,
        },
        join(out, "adopted-index-frame"),
      );
    await media(
      "frame.batch",
      { projectId: adoptedProjectId, revisionId: adoptedRevisionId, atUs: [projectSampleAtUs] },
      join(out, "adopted-project-frame"),
    );
    step("relocated package", {
      path: moved,
      projectId: adoptedProjectId,
      revisionId: adoptedRevisionId,
      transcriptRows: adoptedRows.length,
      indexOrdinals: adoptedOrdinals,
      projectFrameAtUs: projectSampleAtUs,
    });
  } finally {
    closeAdmission();
    process.removeListener("exit", closeAdmission);
    rmSync(dirname(moved), { recursive: true, force: true });
  }

  step("storage", call("storage.usage", {}));
  report.finishedAt = new Date().toISOString();
  report.out = out;
  writeFileSync(join(out, "journey.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`\nEvidence in ${out}`);
  console.log(
    "Caller journey completed. Review journey.json for the operation and evidence record.",
  );
};

main().catch((error) => {
  report.failure = String(error?.message ?? error);
  writeFileSync(join(out, "journey.json"), JSON.stringify(report, null, 2) + "\n");
  console.error(`\nJourney stopped: ${report.failure}\nPartial evidence in ${out}`);
  process.exitCode = 1;
});
