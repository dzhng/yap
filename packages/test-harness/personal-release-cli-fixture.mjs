#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { operationSchema } from "@yap/protocol";

const operation = process.argv[2];
const paramsAt = process.argv.indexOf("--params");
const outputAt = process.argv.indexOf("--output");
const params = paramsAt < 0 ? {} : JSON.parse(process.argv[paramsAt + 1]);
const output = outputAt < 0 ? null : process.argv[outputAt + 1];
const entry = { operation, params, output };
const tracedCalls = () => {
  try {
    return readFileSync(process.env.YAP_CALLER_TRACE, "utf8").trim().split("\n").map(JSON.parse);
  } catch {
    return [];
  }
};
const unavailable = (range, support) => {
  let atUs = range.startUs;
  const gaps = [];
  for (const part of support) {
    if (part.endUs <= atUs) continue;
    if (part.startUs >= range.endUs) break;
    if (part.startUs > atUs)
      gaps.push({ startUs: atUs, endUs: Math.min(part.startUs, range.endUs) });
    atUs = Math.max(atUs, Math.min(part.endUs, range.endUs));
  }
  if (atUs < range.endUs) gaps.push({ startUs: atUs, endUs: range.endUs });
  return gaps;
};

try {
  operationSchema.parse({ operation, params });
} catch (error) {
  entry.response = {
    ok: false,
    error: { code: "INVALID_REQUEST", message: error.message, retryable: false, details: {} },
  };
  appendFileSync(process.env.YAP_CALLER_TRACE, JSON.stringify(entry) + "\n");
  process.stdout.write(JSON.stringify(entry.response));
  process.exitCode = 1;
  process.exit();
}

if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, "controlled CLI fixture output");
}

const videoBinding = {
  assetId: "video-asset",
  streamId: "video-stream",
  available: [
    { startUs: 0, endUs: 2000000 },
    { startUs: 6000000, endUs: 8000000 },
  ],
  sourceRoles: ["video"],
  sourceToAssetOffsetUs: 0,
  supportBasis: "physical",
};
const narrationBinding = {
  assetId: "audio-asset",
  streamId: "audio-stream",
  available: [
    { startUs: 0, endUs: 4000000 },
    { startUs: 5000000, endUs: 7900000 },
  ],
  sourceRoles: ["narration"],
  sourceToAssetOffsetUs: -100000,
  supportBasis: "captured-audio",
};
const rows = [
  {
    type: "word",
    id: "word-phrase",
    text: "free",
    kind: "word",
    sourceRange: { startUs: 1000000, endUs: 1200000 },
  },
  {
    type: "word",
    id: "word-filler",
    text: "um",
    kind: "filler",
    sourceRange: { startUs: 5000000, endUs: 5200000 },
  },
];
const readyTranscript = {
  state: "ready",
  generation: "transcript-generation",
  page: {
    rows,
    nextCursor: null,
    transcript: {
      engine: { runtime: "controlled", model: "fixture", encoderPrecision: "int8" },
    },
  },
};
let data;
switch (operation) {
  case "recording.latest":
    data = { recordingId: "fixture-recording" };
    break;
  case "recording.get":
    data = {
      recordingId: params.recordingId,
      state: "complete",
      sourceDurationUs: 8000000,
      sourceAdmissions: [
        {
          kind: "primary",
          sourceId: "fixture-source",
          acquisitionId: "fixture-acquisition",
          job: { jobId: "fixture-source-job", state: "ready" },
        },
      ],
    };
    break;
  case "job.get": {
    const prior = tracedCalls().filter((item) => item.operation === "job.get").length;
    data = {
      jobId: params.jobId,
      state: prior === 0 ? (process.env.YAP_CALLER_JOB_STATE ?? "ready") : "failed",
      reason: prior === 0 ? "fixture terminal job state" : "unexpected repeat poll",
      result: { acquisitionId: "fixture-acquisition" },
    };
    break;
  }
  case "acquisition.get":
    data = {
      id: params.acquisitionId,
      sourceId: "fixture-source",
      evidence: { receipt: { sourceId: "fixture-source" } },
      journal: { fileName: "capture.journal.jsonl", bytes: 0, sha256: "0".repeat(64) },
      bindings: [videoBinding, narrationBinding],
    };
    break;
  case "asset.get":
    data = {
      assetId: params.assetId,
      streams: [
        params.assetId === "video-asset"
          ? {
              id: "video-stream",
              kind: "video",
              width: 640,
              height: 360,
              bounds: { startUs: 0, endUs: 8000000 },
              available: [
                { startUs: 0, endUs: 2000000 },
                { startUs: 6000000, endUs: 8000000 },
              ],
            }
          : {
              id: "audio-stream",
              kind: "audio",
              sampleRate: 48000,
              channels: 1,
              bounds: { startUs: 0, endUs: 7900000 },
              available: [{ startUs: 0, endUs: 7900000 }],
            },
      ],
    };
    break;
  case "transcript.transcribe":
    data = { ...params, state: "ready" };
    break;
  case "transcript.get":
    data = readyTranscript;
    if (process.env.YAP_CALLER_REPEAT_CURSOR) {
      const prior = tracedCalls().filter((item) => item.operation === operation).length;
      if (prior >= 2) {
        entry.response = {
          ok: false,
          error: {
            code: "FIXTURE_REPEAT_POLL",
            message: "Caller did not stop at the repeated continuation",
            retryable: false,
            details: {},
          },
        };
        appendFileSync(process.env.YAP_CALLER_TRACE, JSON.stringify(entry) + "\n");
        process.stdout.write(JSON.stringify(entry.response));
        process.exit(0);
      }
      data = {
        ...data,
        page: {
          ...data.page,
          nextCursor: {
            assetId: "audio-asset",
            streamId: "audio-stream",
            acquisitionId: "fixture-acquisition",
            generation: "transcript-generation",
            supportDigest: "fixture-support",
            afterSourceUs: 5200000,
            afterOrdinal: 1,
            range: null,
          },
        },
      };
    }
    break;
  case "transcript.search":
    data = {
      state: "ready",
      generation: "transcript-generation",
      page: {
        entries: [
          {
            wordIds: ["word-phrase"],
            sourceRange: { startUs: 1000000, endUs: 1200000 },
            projectRange: { startUs: 900000, endUs: 1100000 },
          },
        ],
        nextCursor: null,
      },
    };
    break;
  case "index.get":
    data = {
      state: "ready",
      generation: params.projectId ? "project-index-generation" : "source-index-generation",
      page: {
        entries: [{ ordinal: 1, candidate: { ordinal: 1, sampleAtUs: 1000000, reasons: [] } }],
        nextCursor: null,
        metadata: {
          candidateCount: 1,
          maxLongEdge: 1600,
          tap: { target: { kind: "output" }, point: { kind: "processed" } },
        },
      },
    };
    break;
  case "project.create":
    data = {
      project: { projectId: "fixture-project" },
      revision: { id: "revision-0", ordinal: 0, document: { tracks: [], clips: [] } },
    };
    break;
  case "edit.apply": {
    const previous = readFileSync(process.env.YAP_CALLER_TRACE, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    if (
      params.operations.some((item) => item.operation === "remove") &&
      previous.some(
        (item) =>
          item.operation === "edit.apply" &&
          item.params.expectedRevisionId === params.expectedRevisionId &&
          item.params.operations.some((operation) => operation.operation === "remove"),
      )
    ) {
      entry.response = {
        ok: false,
        error: {
          code: "STALE_REVISION",
          message: "Revision changed",
          retryable: false,
          details: {},
        },
      };
      appendFileSync(process.env.YAP_CALLER_TRACE, JSON.stringify(entry) + "\n");
      process.stdout.write(JSON.stringify(entry.response));
      process.exit(0);
    }
    const labels = Object.fromEntries(
      params.operations
        .filter((item) => item.label)
        .map((item) => [item.label, `id-${item.label}`]),
    );
    data = {
      revision: {
        id: params.operations.some((item) => item.operation === "remove")
          ? "revision-cut"
          : "revision-placed",
        ordinal: 1,
        document: { tracks: [], clips: [] },
      },
      edit: { labels, createdIds: [], removedIds: [] },
    };
    break;
  }
  case "revision.history":
    data = { revisions: [], entries: [], nextCursor: null };
    break;
  case "edit.undo":
    data = { id: "revision-undone", ordinal: 2, document: { tracks: [], clips: [] } };
    break;
  case "edit.restore":
    data = { id: "revision-restored", ordinal: 3, document: { tracks: [], clips: [] } };
    break;
  case "index.frames":
  case "preview.get":
    data = { state: "ready", published: null };
    break;
  case "audio.get":
    data = {
      state: "ready",
      published: {
        generation: "audio-generation",
        output: {
          range: params.range,
          unavailable: params.assetId ? unavailable(params.range, narrationBinding.available) : [],
        },
      },
    };
    break;
  case "frame.batch": {
    const previousFrames = tracedCalls().filter((item) => item.operation === "frame.batch").length;
    if (
      (process.env.YAP_CALLER_FRAME_ITEM_ERROR ||
        (!params.projectId &&
          params.atUs.some(
            (atUs) =>
              !videoBinding.available.some((range) => range.startUs <= atUs && atUs < range.endUs),
          ))) &&
      previousFrames === 0
    ) {
      data = {
        items: [
          {
            atUs: params.atUs[0],
            ok: false,
            error: {
              code: "FRAME_ITEM_ERROR",
              message: "Fixture frame sample is outside supported media",
              retryable: false,
              details: {},
            },
          },
        ],
      };
    } else if (process.env.YAP_CALLER_FRAME_ITEM_ERROR && previousFrames > 0) {
      data = { state: "failed", reason: "unexpected repeat poll" };
    } else {
      data = {
        items: params.atUs.map((atUs) => ({
          atUs,
          ok: true,
          data: { state: "ready", published: null },
        })),
      };
    }
    break;
  }
  case "export.create":
    mkdirSync(params.directory, { recursive: true });
    writeFileSync(join(params.directory, params.leaf), "controlled package fixture");
    data = { exportId: params.exportId, state: "queued" };
    break;
  case "export.status": {
    const creation = readFileSync(process.env.YAP_CALLER_TRACE, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .findLast(
        (item) => item.operation === "export.create" && item.params.exportId === params.exportId,
      );
    data = {
      exportId: params.exportId,
      state: "ready",
      jobId: null,
      output: join(creation.params.directory, creation.params.leaf),
      receipt: {},
    };
    break;
  }
  case "package.open":
    data = { id: "fixture-admission" };
    break;
  case "package.status": {
    const prior = tracedCalls().filter((item) => item.operation === "package.status").length;
    const state = process.env.YAP_CALLER_PACKAGE_STATE;
    data =
      state && prior === 0
        ? { id: params.admissionId, state, error: { message: "fixture package status" } }
        : prior > 0
          ? { id: params.admissionId, state: "failed", reason: "unexpected repeat poll" }
          : { id: params.admissionId, state: "ready", packageHandle: "fixture-handle" };
    break;
  }
  case "package.adopt":
    data = { state: "ready", projectId: "adopted-project", revisionId: "adopted-revision" };
    break;
  case "package.close":
    data = { admissionId: params.admissionId, closed: true };
    break;
  case "project.get":
    data = { project: { projectId: params.projectId }, currentRevisionId: "adopted-revision" };
    break;
  case "storage.usage":
    data = { bytes: 0 };
    break;
  default:
    data = {};
}

process.stdout.write(JSON.stringify({ ok: true, data }));
entry.response = { ok: true, data };
appendFileSync(process.env.YAP_CALLER_TRACE, JSON.stringify(entry) + "\n");
