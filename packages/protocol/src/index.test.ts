import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ARTIFACT_CHUNK_BYTES,
  captureDeviceSchema,
  captureSelectionSchema,
  captureReportSchema,
  nativeStartSchema,
  admitOperation,
  operationSchema,
  operationNames,
  appOperations,
  parseRequest,
  responseSchema,
} from "./index.js";

type AppCaptureContract = {
  operations: { name: string; params: Record<string, unknown> }[];
  reports: { id: string; report: unknown }[];
  statuses: { id: string; status: Record<string, unknown> }[];
};

describe("native operation envelope", () => {
  it("rejects an unknown top-level field instead of silently accepting a misspelled request", () => {
    expect(() =>
      parseRequest({ id: "request-1", operation: "system.ping", params: {}, param: {} }),
    ).toThrow();
  });
});

it("keeps app capture controls in the public catalog and decodes lifecycle receipts", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/app-capture-contract.json", import.meta.url), "utf8"),
  ) as AppCaptureContract;

  for (const { name, params } of fixture.operations) {
    expect(operationNames.has(name), `${name} is missing from the public catalog`).toBe(true);
    expect(operationSchema.parse({ operation: name, params })).toMatchObject({ operation: name });
  }

  for (const { id, report: value } of fixture.reports) {
    const report = captureReportSchema.parse(value);
    const response = responseSchema.parse({ id, ok: true, data: report });
    expect(response).toMatchObject({ id, ok: true, data: { state: report.state } });
  }

  // Live camera state crosses the boundary on every status; a peer that omits it is refused.
  for (const { id, status } of fixture.statuses) {
    expect(captureDeviceSchema.parse(status), id).toEqual(status);
    const { camera: _omitted, ...withoutCamera } = status;
    expect(captureDeviceSchema.safeParse(withoutCamera).success, id).toBe(false);
  }
});

it("advertises login-item control as callable public operations", () => {
  for (const [operation, params] of [
    ["login.status", {}],
    ["login.setEnabled", { enabled: true }],
  ] as const) {
    expect(operationNames.has(operation), operation).toBe(true);
    expect(operationSchema.safeParse({ operation, params }).success, operation).toBe(true);
  }
});

it("advertises the account skill lifecycle as callable public operations", () => {
  for (const operation of ["skill.status", "skill.install", "skill.uninstall", "skill.update"]) {
    expect(operationSchema.safeParse({ operation, params: {} }), operation).toMatchObject({
      success: true,
      data: { operation, params: {} },
    });
  }
  expect(
    operationSchema.safeParse({ operation: "skill.status", params: { extra: true } }).success,
  ).toBe(false);
});

it("advertises the app-managed command-line tool as callable public operations", () => {
  for (const operation of ["cli.status", "cli.install", "cli.uninstall"]) {
    expect(operationNames.has(operation), operation).toBe(true);
    expect(operationSchema.safeParse({ operation, params: {} }), operation).toMatchObject({
      success: true,
      data: { operation, params: {} },
    });
    expect(
      operationSchema.safeParse({ operation, params: { extra: true } }).success,
      operation,
    ).toBe(false);
  }
});

it("advertises strict service-routed preset reads", () => {
  expect(operationSchema.parse({ operation: "preset.list", params: {} })).toMatchObject({
    operation: "preset.list",
    params: {},
  });
  expect(
    operationSchema.parse({ operation: "preset.get", params: { id: "studio-podcast" } }),
  ).toMatchObject({
    operation: "preset.get",
    params: { id: "studio-podcast" },
  });
  expect(
    operationSchema.safeParse({ operation: "preset.list", params: { extra: true } }).success,
  ).toBe(false);
  expect(
    operationSchema.safeParse({
      operation: "preset.get",
      params: { id: "studio-podcast", extra: true },
    }).success,
  ).toBe(false);
  expect(operationNames.has("preset.list")).toBe(true);
  expect(operationNames.has("preset.get")).toBe(true);
  expect(appOperations.has("preset.list")).toBe(false);
  expect(appOperations.has("preset.get")).toBe(false);
});

it("reads authored project revisions while recording identities retain only source lifetime", () => {
  const request = (operation: string, params: Record<string, unknown>) => {
    const wire = parseRequest({ id: "caller", operation, params });
    return operationSchema.safeParse({ operation: wire.operation, params: wire.params });
  };
  expect(request("revision.get", { recordingId: "take", revisionId: "revision" }).success).toBe(
    false,
  );
  expect(request("revision.get", { projectId: "project", revisionId: "revision" })).toMatchObject({
    success: true,
    data: { operation: "revision.get", params: { projectId: "project", revisionId: "revision" } },
  });
  expect(request("recording.delete", { recordingId: "take" })).toMatchObject({
    success: true,
    data: { operation: "recording.delete", params: { recordingId: "take" } },
  });
});

it("advertises feedback review operations with shared selectors and bounded cursor trails", () => {
  expect(
    operationSchema.parse({
      operation: "transcript.review",
      params: { assetId: "a", streamId: "audio", range: { startUs: 0, endUs: 1_000_000 } },
    }).operation,
  ).toBe("transcript.review");
  expect(
    operationSchema.parse({
      operation: "cursor.render",
      params: { projectId: "p", atUs: [0, 1_000_000], trailUs: 600_000 },
    }).operation,
  ).toBe("cursor.render");
  expect(
    operationSchema.safeParse({
      operation: "cursor.render",
      params: { projectId: "p", atUs: [0], trailUs: 10_000_001 },
    }).success,
  ).toBe(false);
});

describe("capture selection", () => {
  const source = { kind: "window", windowId: 7 } as const;
  it("admits an explicitly selected camera as primary video with the shared audio defaults", () => {
    expect(
      operationSchema.parse({
        operation: "capture.start",
        params: { requestId: "camera-take", source: { kind: "camera", deviceId: "camera-2" } },
      }),
    ).toMatchObject({
      operation: "capture.start",
      params: {
        requestId: "camera-take",
        source: { kind: "camera", deviceId: "camera-2" },
        microphone: true,
        systemAudio: false,
      },
    });
  });
  it("records the narrator by default and the machine's own audio only when asked", () => {
    const capture = operationSchema.parse({
      operation: "capture.start",
      params: { requestId: "r", source },
    });
    expect(capture.params).toMatchObject({ microphone: true, systemAudio: false });
    // A caller's explicit refusal is never overridden by the default.
    expect(
      captureSelectionSchema.parse({ source, microphone: false, systemAudio: false }),
    ).toMatchObject({ microphone: false, systemAudio: false });
    // Native is told both, on every start, so no peer restates a default of its own.
    expect(
      nativeStartSchema.parse({ source, recordingId: "r", sourceId: "s", outputDirectory: "/tmp" }),
    ).toMatchObject({ microphone: true, systemAudio: false });
  });
  it("refuses companion camera authority on a primary camera and malformed device identities", () => {
    for (const params of [
      { source: { kind: "camera", deviceId: "primary" }, cameraDeviceId: "companion" },
      { source: { kind: "camera" } },
      { source: { kind: "camera", deviceId: "" } },
      { source: { kind: "camera", deviceId: "c".repeat(257) } },
      { source: { kind: "camera", deviceId: "primary", displayId: 7 } },
    ]) {
      expect(
        operationSchema.safeParse({
          operation: "capture.start",
          params: { requestId: "r", ...params },
        }).success,
      ).toBe(false);
    }
    expect(
      nativeStartSchema.safeParse({
        recordingId: "r",
        sourceId: "s",
        outputDirectory: "/tmp/source",
        source: { kind: "camera", deviceId: "primary" },
        cameraDeviceId: "companion",
        cameraSourceId: "c",
        cameraDirectory: "/tmp/camera",
      }).success,
    ).toBe(false);
  });
  it("refuses allocated companion authority even without a companion device", () => {
    for (const companion of [{ cameraSourceId: "ghost" }, { cameraDirectory: "/tmp/ghost" }]) {
      expect(
        nativeStartSchema.safeParse({
          recordingId: "r",
          sourceId: "s",
          outputDirectory: "/tmp/source",
          source: { kind: "camera", deviceId: "primary" },
          ...companion,
        }).success,
      ).toBe(false);
    }
  });
  it("states a companion camera's start state only beside a companion camera", () => {
    const companion = { source, cameraDeviceId: "camera-1" };
    expect(captureSelectionSchema.parse({ ...companion, cameraAtStart: "off" })).toMatchObject({
      cameraAtStart: "off",
    });
    // Absent keeps today's meaning and is never filled in by admission.
    expect(captureSelectionSchema.parse(companion)).not.toHaveProperty("cameraAtStart");
    for (const selection of [
      { source, cameraAtStart: "off" },
      { source, cameraAtStart: "on" },
      { source: { kind: "camera", deviceId: "primary" }, cameraAtStart: "off" },
      { ...companion, cameraAtStart: "paused" },
    ]) {
      expect(captureSelectionSchema.safeParse(selection).success).toBe(false);
      expect(
        operationSchema.safeParse({
          operation: "capture.start",
          params: { requestId: "r", ...selection },
        }).success,
      ).toBe(false);
    }
  });
  it("shares camera selection fixtures with the native app boundary", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../fixtures/capture-primary-camera.json", import.meta.url), "utf8"),
    );
    expect(captureSelectionSchema.parse(fixture.selection)).toEqual(fixture.selection);
    for (const selection of fixture.invalidSelections)
      expect(captureSelectionSchema.safeParse(selection).success).toBe(false);
  });
});

it("artifact reads ask for one bounded chunk at a whole offset", () => {
  const read = (params: Record<string, unknown>) =>
    operationSchema.safeParse({ operation: "artifact.read", params: { token: "t", ...params } });
  expect(read({ offset: 0 })).toMatchObject({
    success: true,
    data: { params: { maxBytes: ARTIFACT_CHUNK_BYTES } },
  });
  for (const [offset, maxBytes] of [
    [-1, 1],
    [0.5, 1],
    [0, 0],
    [0, ARTIFACT_CHUNK_BYTES + 1],
    [0, Number.NaN],
  ])
    expect(read({ offset, maxBytes }).success).toBe(false);
});

it("project indexes use picture taps and retained references across paging and delivery", () => {
  const reference = {
    projectId: "project",
    revisionId: "revision",
    generation: "index",
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    maxLongEdge: 640,
  };
  const requests = [
    { operation: "index.get", params: { projectId: "project" } },
    {
      operation: "index.get",
      params: { projectId: "project", cursor: { ...reference, afterOrdinal: 0 } },
    },
    { operation: "index.retry", params: { projectId: "project", tap: reference.tap } },
    {
      operation: "index.coverage",
      params: { ...reference, cursor: { ...reference, afterSequence: 0, candidateOrdinal: null } },
    },
    { operation: "index.frame", params: { ...reference, ordinal: 0 } },
    { operation: "index.frames", params: { ...reference, ordinals: [1, 0, 1] } },
  ];
  for (const request of requests)
    expect(operationSchema.safeParse(request).success, request.operation).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "index.get",
      params: { projectId: "project", range: { startUs: 0, endUs: 1000 } },
    }).success,
  ).toBe(false);
  const incomplete = { ...reference, tap: undefined };
  expect(
    operationSchema.safeParse({ operation: "index.frame", params: { ...incomplete, ordinal: 0 } })
      .success,
  ).toBe(false);
});

it("retained index requests bound paging, references and media batches", () => {
  const source = { assetId: "asset", streamId: "video" };
  const reference = { ...source, generation: "attempt" };
  expect(operationSchema.safeParse({ operation: "index.get", params: source }).success).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "index.get",
      params: { ...source, limit: 201 },
    }).success,
  ).toBe(false);
  expect(
    operationSchema.safeParse({ operation: "index.frame", params: { ...reference, ordinal: 0 } })
      .success,
  ).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "index.frame",
      params: { ...source, ordinal: 0 },
    }).success,
  ).toBe(false);
  expect(
    operationSchema.safeParse({
      operation: "index.frames",
      params: { ...reference, ordinals: [1, 0, 1] },
    }).success,
  ).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "index.frames",
      params: { ...reference, ordinals: Array(9).fill(0) },
    }).success,
  ).toBe(false);
  expect(
    operationSchema.safeParse({
      operation: "index.coverage",
      params: { ...reference, cursor: { ...reference, afterSequence: 0, candidateOrdinal: null } },
    }).success,
  ).toBe(true);
});

it("package handles do not authorize managed media inspection", () => {
  for (const operation of ["revision.get", "revision.history", "index.get"]) {
    expect(
      operationSchema.safeParse({ operation, params: { packageHandle: "open-1" } }).success,
    ).toBe(false);
    expect(operationSchema.safeParse({ operation, params: { projectId: "project" } }).success).toBe(
      true,
    );
    for (const params of [
      {},
      { packageHandle: "open-1", recordingId: "take" },
      { packageHandle: "open-1", latest: true },
    ])
      expect(operationSchema.safeParse({ operation, params }).success).toBe(false);
  }
  for (const operation of ["index.retry", "recording.delete"])
    expect(
      operationSchema.safeParse({ operation, params: { packageHandle: "open-1", atUs: 0 } })
        .success,
    ).toBe(false);
});

it("arbitrary frame operations require a project or selected asset", () => {
  for (const operation of ["frame.get", "frame.retry", "frame.batch"]) {
    const atUs = operation === "frame.batch" ? [0, 1] : 0;
    expect(
      operationSchema.safeParse({
        operation,
        params: { assetId: "asset", streamId: "video", atUs },
      }).success,
    ).toBe(true);
    expect(
      operationSchema.safeParse({
        operation,
        params: { recordingId: "r", packageHandle: "p", atUs },
      }).success,
    ).toBe(false);
    expect(operationSchema.safeParse({ operation, params: { atUs } }).success).toBe(false);
  }
});

it("audio inspection selects exactly one project or asset stream", () => {
  for (const operation of ["audio.get", "audio.retry"]) {
    const params = { assetId: "asset", streamId: "audio", range: { startUs: 0, endUs: 1000 } };
    expect(operationSchema.parse({ operation, params })).toBeTruthy();
    expect(() =>
      operationSchema.parse({ operation, params: { ...params, recordingId: "library" } }),
    ).toThrow();
  }
});

it("raw cursor target and continuation namespaces are exclusive", () => {
  const fields = { sourceRange: { startUs: 0, endUs: 1000 }, limit: 1 };
  const position = {
    cursor: { after: null, done: false },
    pause: { after: null, done: false },
    geometry: { after: null, done: false },
    interruption: { after: null, done: false },
  };
  const source = { assetId: "asset", streamId: "video", acquisitionId: "capture" };
  expect(
    operationSchema.safeParse({
      operation: "cursor.raw",
      params: { ...source, ...fields, cursor: { reference: "pinned", position } },
    }).success,
  ).toBe(true);
  for (const params of [
    fields,
    { ...fields, recordingId: "library", packageHandle: "package" },
    { ...fields, packageHandle: "package", latest: true },
    { ...fields, packageHandle: "package", revisionId: "r1" },
    { ...fields, packageHandle: "package", cursor: { recordingId: "library", ...position } },
    { ...fields, recordingId: "library", cursor: { packageHandle: "package", ...position } },
    ...["recordingId", "packageHandle"].flatMap((field) => [
      { ...source, ...fields, [field]: "foreign-owner" },
      {
        ...source,
        ...fields,
        cursor: { reference: "pinned", position, [field]: "foreign-owner" },
      },
    ]),
  ])
    expect(operationSchema.safeParse({ operation: "cursor.raw", params }).success).toBe(false);
});

it("transcript pages and searches are bounded and their cursors name the pinned generation", () => {
  const parse = (operation: string, params: Record<string, unknown>) =>
    operationSchema.safeParse({
      operation,
      params: { assetId: "asset", streamId: "audio", ...params },
    });
  expect(parse("transcript.get", {})).toMatchObject({ data: { params: { limit: 250 } } });
  expect(parse("transcript.search", { text: "hello" })).toMatchObject({
    data: { params: { limit: 100 } },
  });
  const position = {
    assetId: "asset",
    streamId: "audio",
    acquisitionId: null,
    generation: "attempt",
    supportDigest: "digest",
  };
  const speaker = {
    streamId: "speaker-audio",
    channel: 0,
    modelId: "parakeet-speaker",
    observationRange: { startUs: 0, endUs: 30_000_000 },
    generation: "speaker-generation",
  };
  const accepted: [string, Record<string, unknown>][] = [
    ["transcript.get", { limit: 1000 }],
    ["transcript.get", { speaker }],
    [
      "transcript.get",
      {
        speaker,
        cursor: {
          ...position,
          afterSourceUs: 0,
          afterOrdinal: null,
          range: null,
          speaker: { ...speaker, bindingDigest: "a".repeat(64) },
        },
      },
    ],
    ["transcript.search", { text: "x".repeat(200), limit: 500 }],
    [
      "transcript.search",
      { text: "hello", cursor: { ...position, afterSourceUs: 0, afterOrdinal: 3, text: "hello" } },
    ],
  ];
  for (const [operation, params] of accepted)
    expect(parse(operation, params).success, JSON.stringify(params)).toBe(true);
  const refused: [string, Record<string, unknown>][] = [
    ["transcript.get", { limit: 1001 }],
    ["transcript.get", { cursor: { ...position, afterSourceUs: 0, afterOrdinal: null } }],
    ["transcript.search", { text: "" }],
    ["transcript.search", { text: "x".repeat(201) }],
    ["transcript.search", { text: "hello", limit: 501 }],
    ["transcript.search", { text: "hello", cursor: { ...position, afterSourceUs: 0 } }],
  ];
  for (const [operation, params] of refused)
    expect(parse(operation, params).success, JSON.stringify(params)).toBe(false);
});

it("project transcript reads admit explicit speaker-generation joins", () => {
  const params = {
    projectId: "project",
    speakerGenerations: [
      {
        assetId: "asset",
        streamId: "speaker-audio",
        channel: 0,
        modelId: "sortformer",
        observationRange: { startUs: 0, endUs: 30_000_000 },
        generation: "speaker-generation",
      },
    ],
  };
  expect(operationSchema.safeParse({ operation: "transcript.get", params }).success).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "transcript.get",
      params: { ...params, speakerGenerations: [{ ...params.speakerGenerations[0], extra: true }] },
    }).success,
  ).toBe(false);
});

it("project exports preserve their target and refuse ambiguous owners", () => {
  const destination = {
    exportId: "67a0c032-a3ee-44b9-81f8-7269f0f3195e",
    directory: "/tmp/exports",
    leaf: "tutorial.mp4",
    kind: "video",
  };
  const params = { ...destination, projectId: "project", revisionId: "revision" };
  expect(operationSchema.parse({ operation: "export.create", params }).params).toEqual(params);
  const portable = { ...params, kind: "processed-package", leaf: "tutorial.zip" };
  expect(operationSchema.parse({ operation: "export.create", params: portable }).params).toEqual(
    portable,
  );
  for (const invalid of [
    { ...params, recordingId: "recording" },
    { ...params, range: { startUs: 0, endUs: 1 } },
    destination,
  ])
    expect(operationSchema.safeParse({ operation: "export.create", params: invalid }).success).toBe(
      false,
    );
});

it("source capture continuations retain every reader head through both public operations", () => {
  const position = {
    cursor: { after: null, done: true },
    pause: { after: [999, 1], done: false },
    geometry: { after: null, done: true },
    interruption: { after: null, done: false },
  };
  for (const operation of ["cursor.raw", "timeline.events"]) {
    const params = {
      assetId: "asset",
      streamId: "track:1",
      acquisitionId: "capture",
      sourceRange: { startUs: 0, endUs: 1000 },
      limit: 1,
      cursor: {
        reference: "pinned",
        position:
          operation === "timeline.events"
            ? {
                capture: position,
                scene: { after: { actualSourceUs: 999, ordinal: 0 }, done: false },
              }
            : position,
      },
    };
    expect(operationSchema.parse({ operation, params })).toEqual({ operation, params });
    expect(
      operationSchema.safeParse({ operation, params: { ...params, revisionId: "fake" } }).success,
    ).toBe(false);
  }
});

it("caption sidecar export requires pinned revision and explicit unique placements without media settings", () => {
  const params = {
    kind: "srt",
    projectId: "p",
    revisionId: "r",
    placementIds: ["caption"],
    exportId: "11111111-1111-4111-8111-111111111111",
    directory: "/tmp",
    leaf: "selected.srt",
  };
  expect(operationSchema.safeParse({ operation: "export.create", params }).success).toBe(true);
  expect(
    operationSchema.safeParse({ operation: "export.create", params: { ...params, kind: "vtt" } })
      .success,
  ).toBe(true);
  for (const invalid of [
    { ...params, revisionId: undefined },
    { ...params, placementIds: [] },
    { ...params, placementIds: ["caption", "caption"] },
    { ...params, settings: {} },
  ]) {
    expect(operationSchema.safeParse({ operation: "export.create", params: invalid }).success).toBe(
      false,
    );
  }
});

it("loudness admission keeps source/project selectors exclusive and channel interpretation explicit", () => {
  const source = {
    assetId: "a",
    streamId: "mono",
    acquisitionId: "capture",
    channelInterpretation: "dual-mono",
    truePeak: false,
  };
  expect(operationSchema.safeParse({ operation: "audio.measure", params: source }).success).toBe(
    true,
  );
  expect(
    operationSchema.safeParse({
      operation: "audio.measure",
      params: {
        projectId: "p",
        revisionId: "r",
        preparedResourceId: "exact",
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
      },
    }).success,
  ).toBe(true);
  for (const extra of [
    { projectId: "p" },
    { channelInterpretation: "stereo" },
    { targetLufs: -14 },
  ])
    expect(
      operationSchema.safeParse({ operation: "audio.measure", params: { ...source, ...extra } })
        .success,
    ).toBe(false);
});

it("pause evidence accepts source and project selections with optional detector overrides", () => {
  expect(
    operationSchema.safeParse({
      operation: "audio.pause.get",
      params: { assetId: "asset", streamId: "audio", thresholdRMS: 0.01, minDurationUs: 300_000 },
    }).success,
  ).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "audio.pause.get",
      params: {
        projectId: "project",
        revisionId: "revision",
        range: { startUs: 0, endUs: 1_000_000 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        cursor: { offset: 100 },
        limit: 50,
      },
    }).success,
  ).toBe(true);
});

it("transcript import defaults to supplied timing and accepts explicit alignment", () => {
  expect(
    operationSchema.safeParse({
      operation: "transcript.import",
      params: {
        requestId: "request",
        assetId: "asset",
        streamId: "audio",
        path: "/tmp/captions.srt",
      },
    }).success,
  ).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "transcript.import",
      params: {
        requestId: "request-align",
        assetId: "asset",
        streamId: "audio",
        path: "/tmp/captions.srt",
        timingPolicy: "align",
        modelId: "nemo-ctc110",
      },
    }).success,
  ).toBe(true);
});

it("admits project alignment reads only with an explicit prepared tap identity", () => {
  const request = {
    operation: "alignment.get",
    params: {
      projectId: "project",
      revisionId: "revision",
      preparedResourceId: "prepared",
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
      assetId: "a".repeat(64),
      generation: "generation",
      view: "words",
    },
  };
  expect(operationSchema.safeParse(request).success).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "alignment.get",
      params: { ...request.params, projectId: undefined },
    }).success,
  ).toBe(false);
});

it("admits alignment preparation over a pinned project tap", () => {
  expect(
    operationSchema.safeParse({
      operation: "alignment.observe",
      params: {
        projectId: "project",
        revisionId: "revision",
        preparedResourceId: "prepared",
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        range: { startUs: 0, endUs: 1_000_000 },
        channel: 0,
        text: "hello world",
        modelId: "nemo-ctc110",
      },
    }),
  ).toMatchObject({
    success: true,
  });
});

it("admits generation-pinned caller speaker label bindings", () => {
  expect(
    operationSchema.safeParse({
      operation: "speaker.bind",
      params: {
        assetId: "a".repeat(64),
        streamId: "audio",
        channel: 0,
        modelId: "speaker-model",
        observationRange: { startUs: 0, endUs: 30000000 },
        generation: "speaker-generation",
        bindings: [{ slot: 0, displayName: "Ada" }],
      },
    }).success,
  ).toBe(true);
});

it("rejects unknown fields on speaker label bindings", () => {
  expect(
    operationSchema.safeParse({
      operation: "speaker.bind",
      params: {
        assetId: "a".repeat(64),
        streamId: "audio",
        channel: 0,
        modelId: "speaker-model",
        observationRange: { startUs: 0, endUs: 30000000 },
        generation: "speaker-generation",
        bindings: [{ slot: 0, displayName: "Ada", inferred: true }],
      },
    }).success,
  ).toBe(false);
});

it("admits long-form continuity preparation and exact receipt reads", () => {
  const common = {
    assetId: "a".repeat(64),
    streamId: "audio",
    channel: 0,
    modelId: "speaker-model",
    sourceRange: { startUs: 0, endUs: 600_000_000 },
  };
  expect(
    operationSchema.safeParse({
      operation: "speaker.continuity.prepare",
      params: { ...common, expectedSpeakerCount: 4 },
    }).success,
  ).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "speaker.continuity.get",
      params: {
        assetId: common.assetId,
        streamId: common.streamId,
        channel: common.channel,
        modelId: common.modelId,
        observationRange: common.sourceRange,
        generation: "attempt-1",
      },
    }).success,
  ).toBe(true);
});

it("ordinary project index references remain usable without face observations", () => {
  const reference = {
    projectId: "p",
    revisionId: "r",
    generation: "g",
    maxLongEdge: 1600,
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  };
  for (const request of [
    { operation: "index.frame", params: { ...reference, ordinal: 0 } },
    {
      operation: "index.get",
      params: { projectId: "p", cursor: { ...reference, afterOrdinal: 0 } },
    },
  ])
    expect(operationSchema.parse(request).params).toMatchObject(request.params);
});

describe("invalid params", () => {
  it("name every rejected field so a caller can fix the request in one step", () => {
    expect(
      admitOperation({
        operation: "export.create",
        params: {
          projectId: "p",
          exportId: "not-a-uuid",
          directory: "/tmp",
          leaf: "a.mp4",
          kind: "video",
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        details: {
          invalid: expect.arrayContaining([{ path: "params.exportId", message: "Invalid UUID" }]),
        },
      },
    });
    expect(admitOperation({ operation: "service.health", params: {} })).toEqual({
      ok: true,
      data: { operation: "service.health", params: {} },
    });
  });
});

it("admits exact, caller-authored speaker corrections", () => {
  expect(
    operationSchema.parse({
      operation: "speaker.correct",
      params: {
        projectId: "p",
        requestId: "r",
        expectedRevisionId: "rev",
        corrections: [
          {
            id: "fix",
            occurrenceId: "clip",
            target: { wordIds: ["w1"] },
            value: { state: "overlap", slots: [0, 1] },
            provenance: "human review",
          },
        ],
      },
    }),
  ).toMatchObject({ operation: "speaker.correct" });
});

it("admits the read-only review workflow operations", () => {
  expect(
    operationSchema.parse({
      operation: "inspect.open",
      params: { projectId: "p", revisionId: "r", range: { startUs: 0, endUs: 10 } },
    }).operation,
  ).toBe("inspect.open");
  expect(
    operationSchema.parse({
      operation: "caption.propose",
      params: {
        projectId: "p",
        revisionId: "r",
        range: { startUs: 0, endUs: 10 },
        trackId: "track",
        canvas: { width: 100, height: 100 },
        style: { font: { assetId: "font", postScriptName: "Fixture" } },
        constraints: {
          widthGraphemes: 30,
          maxLines: 2,
          minDwellUs: 1,
          maxDwellUs: 100,
          maxCps: 30,
          pauseUs: 1,
          breakOnPunctuation: true,
          separator: " ",
          safeArea: { x: 0, y: 0, width: 100, height: 100 },
        },
      },
    }).operation,
  ).toBe("caption.propose");
  expect(
    operationSchema.parse({
      operation: "layout.diagnostics",
      params: {
        projectId: "p",
        revisionId: "r",
        samples: [{ atUs: 0, canvas: { width: 100, height: 100 }, texts: [] }],
      },
    }).operation,
  ).toBe("layout.diagnostics");
});
