import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { writeFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonWorker } from "./worker.js";
import { setTimeout as delay } from "node:timers/promises";
import { projectServiceFixture } from "./project-service.fixture.js";
import { publishControlledObservation, speakerSource } from "./speaker.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("public speaker source requests report missing optional preparation without scheduling inference", async () => {
  const requests: string[] = [];
  const f = await projectServiceFixture(cleanup, async (operation) => {
    requests.push(operation);
    if (operation !== "media.probe") throw new Error(operation);
    return {
      ok: true,
      data: {
        originUs: -250000,
        streams: [
          {
            id: "audio",
            kind: "audio",
            codec: "controlled",
            decodable: true,
            channels: 2,
            sampleRate: 16000,
            startUs: 0,
            endUs: 40000000,
            segments: [{ startUs: 0, endUs: 40000000, empty: false }],
          },
        ],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "speaker-source", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const input = {
    assetId: job.published!.output.assetId,
    streamId: "audio",
    channel: 1,
    sourceRange: speakerSource.observationRange,
    modelId: speakerSource.engine.modelId,
  };
  const preparation = await f.call("speaker.observe", input);
  const { sourceRange, ...selection } = input;
  const read = await f.call("speaker.get", { ...selection, sourceRange: sourceRange });
  await writeFile(
    join(f.home, "public-speaker-operands.json"),
    JSON.stringify({ input, preparation, read, requests }),
  );
  expect(preparation).toMatchObject({
    ok: true,
    data: { state: "unavailable", reason: "model_not_prepared", published: null },
  });
  expect(read).toMatchObject({
    ok: true,
    data: { state: "unavailable", reason: "model_not_prepared" },
  });
  expect(requests).toEqual(["media.probe"]);
});

test("public retained speaker pages survive service restart without runtime bytes or native execution", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    if (operation !== "media.probe") throw new Error(operation);
    return {
      ok: true,
      data: {
        originUs: -250000,
        streams: [
          {
            id: "audio",
            kind: "audio",
            codec: "controlled",
            decodable: true,
            channels: 2,
            sampleRate: 16000,
            startUs: 0,
            endUs: 40000000,
            segments: [{ startUs: 0, endUs: 40000000, empty: false }],
          },
        ],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "retained-speaker", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const input = {
    assetId: job.published!.output.assetId,
    streamId: "audio",
    channel: 1,
    sourceRange: speakerSource.observationRange,
    modelId: speakerSource.engine.modelId,
  };
  const published = await publishControlledObservation(f.home, input);
  const { sourceRange, ...selection } = input;
  const query = {
    ...selection,
    sourceRange: speakerSource.observationRange,
    limit: 1,
  };
  const first = await f.call("speaker.get", query);
  if (!first.ok) throw new Error(JSON.stringify(first));
  const cursor = (first.data as { nextCursor: string }).nextCursor;
  const second = await f.call("speaker.get", { ...query, cursor });
  await f.service.close();
  const restarted = await projectServiceFixture(
    cleanup,
    async (operation) => {
      throw new Error(`Unrequested native work ${operation}`);
    },
    f.home,
  );
  const resumed = await restarted.call("speaker.get", { ...query, cursor });
  const prepared = await restarted.call("speaker.observe", input);
  await writeFile(
    join(f.home, "retained-public-pages.json"),
    JSON.stringify({ published, first, second, resumed, prepared }),
  );
  expect(first).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      generation: published.generation,
      rows: [
        {
          ordinal: 0,
          slot: 0,
          identity: "unknown",
          sourceRange: {
            startUs: { numerator: 125, denominator: 2 },
            endUs: { numerator: 2000125, denominator: 2 },
          },
        },
      ],
      nextCursor: expect.any(String),
    },
  });
  expect(second).toMatchObject({
    ok: true,
    data: {
      rows: [
        {
          ordinal: 1,
          slot: 1,
          identity: "unknown",
          sourceRange: {
            startUs: { numerator: 1000125, denominator: 2 },
            endUs: { numerator: 4000125, denominator: 2 },
          },
        },
      ],
      nextCursor: null,
    },
  });
  expect(resumed).toEqual(second);
  expect(prepared).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      published: { output: { source: { pcm: { frameCount: 480000 } } } },
    },
  });
  expect(await restarted.call("speaker.get", { ...query, view: "scores", cursor })).toMatchObject({
    ok: false,
    error: { code: "INVALID_PARAMS" },
  });
});

test("public speaker bindings are pinned to one retained generation and decorate interval rows", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    if (operation !== "media.probe") throw new Error(operation);
    return {
      ok: true,
      data: {
        originUs: -250000,
        streams: [
          {
            id: "audio",
            kind: "audio",
            codec: "controlled",
            decodable: true,
            channels: 2,
            sampleRate: 16000,
            startUs: 0,
            endUs: 40000000,
            segments: [{ startUs: 0, endUs: 40000000, empty: false }],
          },
        ],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "bind-speaker", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const input = {
    assetId: job.published!.output.assetId,
    streamId: "audio",
    channel: 1,
    sourceRange: speakerSource.observationRange,
    modelId: speakerSource.engine.modelId,
  };
  const metadata = await publishControlledObservation(f.home, input);
  const { sourceRange, ...selection } = input;
  const bound = await f.call("speaker.bind", {
    requestId: "speaker-bind-test",
    expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    ...selection,
    sourceRange: sourceRange,
    generation: metadata.generation,
    bindings: [{ slot: 1, displayName: "Ada" }],
  });
  const read = await f.call("speaker.get", { ...selection, sourceRange: sourceRange });
  expect(bound).toMatchObject({ ok: true, data: { bindings: [{ slot: 1, displayName: "Ada" }] } });
  expect(
    await f.call("speaker.bind", {
      requestId: "speaker-bind-test",
      expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      ...selection,
      sourceRange,
      generation: metadata.generation,
      bindings: [{ slot: 1, displayName: "Ada" }],
    }),
  ).toEqual(bound);
  expect(read).toMatchObject({ ok: true });
  if (read.ok) {
    const rows = (read.data as { rows: { slot: number; label?: string }[] }).rows;
    expect(rows.find((row) => row.slot === 1)).toMatchObject({ slot: 1, label: "Ada" });
    expect(rows.find((row) => row.slot === 0)).not.toHaveProperty("label");
    const paged = await f.call("speaker.get", {
      ...selection,
      sourceRange: sourceRange,
      limit: 1,
    });
    expect(paged).toMatchObject({ ok: true });
    const nextCursor = paged.ok ? (paged.data as { nextCursor: string | null }).nextCursor : null;
    if (nextCursor) {
      expect(
        await f.call("speaker.bind", {
          requestId: "speaker-bind-rebind",
          expectedBindingDigest: "10cd50a5442973a6b4d7e8ad52cd4a49fcb98ad0793b7adf06fa912f4b3c22f9",
          ...selection,
          sourceRange: sourceRange,
          generation: metadata.generation,
          bindings: [{ slot: 1, displayName: "Grace" }],
        }),
      ).toMatchObject({ ok: true, data: { bindings: [{ slot: 1, displayName: "Grace" }] } });
      expect(
        await f.call("speaker.get", {
          ...selection,
          sourceRange: sourceRange,
          cursor: nextCursor,
        }),
      ).toMatchObject({ ok: false, error: { code: "ARTIFACT_CHANGED" } });
    }
  }
  expect(
    await f.call("speaker.bind", {
      requestId: "speaker-bind-stale",
      expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      ...selection,
      sourceRange: sourceRange,
      generation: metadata.generation,
      bindings: [],
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_CHANGED" } });
});

test("project speaker rows carry caller labels for their retained generation", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    if (operation !== "media.probe") throw new Error(operation);
    return {
      ok: true,
      data: {
        originUs: -250000,
        streams: [
          {
            id: "audio",
            kind: "audio",
            codec: "controlled",
            decodable: true,
            channels: 2,
            sampleRate: 16000,
            startUs: 0,
            endUs: 40000000,
            segments: [{ startUs: 0, endUs: 40000000, empty: false }],
          },
        ],
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "project-labels", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const input = {
    assetId: job.published!.output.assetId,
    streamId: "audio",
    channel: 1,
    sourceRange: speakerSource.observationRange,
    modelId: speakerSource.engine.modelId,
  };
  const metadata = await publishControlledObservation(f.home, input);
  expect(
    await f.call("speaker.bind", {
      requestId: "speaker-bind-test",
      expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      assetId: input.assetId,
      streamId: input.streamId,
      channel: input.channel,
      modelId: input.modelId,
      sourceRange: input.sourceRange,
      generation: metadata.generation,
      bindings: [{ slot: 1, displayName: "Ada" }],
    }),
  ).toMatchObject({ ok: true });
  const created = await f.call("project.create", {
    requestId: "project-labels-create",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const edited = await f.call("edit.apply", {
    projectId: project.id,
    requestId: "project-labels-place",
    expectedRevisionId: revision.id,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "sound" },
      {
        operation: "place",
        clip: {
          trackId: { label: "sound" },
          assetId: input.assetId,
          streamId: input.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 30000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 30000000 } },
        },
      },
    ],
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited));
  const editedData = edited.data as { revision: { id: string } };
  const query = {
    projectId: project.id,
    revisionId: editedData.revision.id,
    range: { startUs: 0, endUs: 3000000 },
    channel: input.channel,
    modelId: input.modelId,
  };
  let read;
  for (;;) {
    read = await f.call("speaker.get", query);
    if (!read.ok || (read.data as { state?: string }).state === "ready") break;
    await delay(10);
  }
  expect(read).toMatchObject({ ok: true });
  if (read.ok) {
    const data = read.data as { rows: { slot: number; label?: string }[] };
    const rows = data.rows;
    expect(rows.find((row) => row.slot === 1)).toMatchObject({ slot: 1, label: "Ada" });
    expect(rows.find((row) => row.slot === 0)).not.toHaveProperty("label");
  }
});

test.runIf(process.platform === "darwin")(
  "speaker package export, read-only open and adoption preserve exact source evidence without model execution",
  async () => {
    const native = jsonWorker({
      executable:
        process.env.YAP_NATIVE ??
        fileURLToPath(new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url)),
      args: [],
    });
    const f = await projectServiceFixture(cleanup, async (operation, params, options) => {
      if (operation !== "media.probe") return native(operation, params, options);
      return {
        ok: true,
        data: {
          originUs: -250000,
          streams: [
            {
              id: "audio",
              kind: "audio",
              codec: "controlled",
              decodable: true,
              channels: 2,
              sampleRate: 16000,
              startUs: 0,
              endUs: 40000000,
              segments: [{ startUs: 0, endUs: 40000000, empty: false }],
            },
          ],
        },
      };
    });
    const imported = await f.call("asset.import", { requestId: "portable-source", path: f.path });
    if (!imported.ok) throw Error(JSON.stringify(imported));
    const job = await f.job((imported.data as { jobId: string }).jobId, "ready");
    const input = {
      assetId: job.published!.output.assetId,
      streamId: "audio",
      channel: 1,
      sourceRange: speakerSource.observationRange,
      modelId: speakerSource.engine.modelId,
    };
    await publishControlledObservation(f.home, input);
    const { sourceRange, ...selection } = input;
    const query = { ...selection, sourceRange: sourceRange, view: "scores", limit: 1000 };
    const unlabeled = await f.call("speaker.get", query);
    if (!unlabeled.ok) throw Error(JSON.stringify(unlabeled));
    await f.call("speaker.bind", {
      requestId: "speaker-bind-test",
      expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      ...selection,
      sourceRange: sourceRange,
      generation: (unlabeled.data as { generation: string }).generation,
      bindings: [{ slot: 0, displayName: "Ada" }],
    });
    const original = await f.call("speaker.get", query);
    const created = await f.call("project.create", {
      requestId: "portable-speaker-project",
      canvas: {
        width: 64,
        height: 48,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    if (!created.ok) throw Error(JSON.stringify(created));
    const { project, revision } = created.data as {
      project: { id: string };
      revision: { id: string };
    };
    expect(
      await f.call("edit.apply", {
        projectId: project.id,
        requestId: "portable-place",
        expectedRevisionId: revision.id,
        operations: [
          { operation: "track.add", track: { kind: "audio", order: 0 }, label: "sound" },
          {
            operation: "place",
            clip: {
              trackId: { label: "sound" },
              assetId: input.assetId,
              streamId: input.streamId,
              source: { kind: "range", range: { startUs: 0, endUs: 30000000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 60000000 } },
            },
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    const exportId = randomUUID();
    const exporting = await f.call("export.create", {
      projectId: project.id,
      requestId: exportId,
      kind: "processed-package",
      directory: f.home,
      leaf: "speakers.zip",
    });
    expect(exporting).toMatchObject({ ok: true });
    let active = f;
    const ready = async (operation: string, params: Record<string, unknown>, state: string) => {
      const deadline = performance.now() + 10000;
      for (;;) {
        const result = await active.call(operation, params);
        if (!result.ok) throw Error(JSON.stringify(result));
        const data = result.data as Record<string, unknown>;
        if (data.state === state) return data;
        if (
          ["failed", "canceled", "unavailable"].includes(String(data.state)) ||
          performance.now() > deadline
        )
          throw Error(JSON.stringify(result));
        await delay(10);
      }
    };
    const projectQuery = {
      projectId: project.id,
      channel: input.channel,
      modelId: input.modelId,
      range: { startUs: 750000, endUs: 1250000 },
      limit: 1000,
    };
    const projected = await ready("speaker.get", projectQuery, "ready");
    expect(projected).toMatchObject({
      rows: [
        { ordinal: 0, slot: 0, partial: false },
        { ordinal: 1, slot: 1, partial: false },
      ],
    });
    await ready("export.status", { exportId }, "ready");
    const target = await projectServiceFixture(cleanup, async (operation, params, options) => {
      if (operation.startsWith("media."))
        throw Error(`Package preservation cannot execute media: ${operation}`);
      return native(operation, params, options);
    });
    active = target;
    const opened = await target.call("package.open", {
      requestId: "package-open-test",
      path: await realpath(join(f.home, "speakers.zip")),
    });
    if (!opened.ok) throw Error(JSON.stringify(opened));
    const admissionId = (opened.data as { id: string }).id;
    expect(
      await target.call("package.open", {
        requestId: "package-open-test",
        path: await realpath(join(f.home, "speakers.zip")),
      }),
    ).toEqual(opened);
    expect(
      await target.call("package.open", {
        requestId: "package-open-test",
        path: join(f.home, "different-speakers.zip"),
      }),
    ).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
    const admitted = await ready("package.status", { admissionId }, "ready");
    const packageHandle = admitted.packageHandle;
    const portableProjection = await ready(
      "speaker.get",
      { ...projectQuery, packageHandle },
      "ready",
    );
    expect(
      (portableProjection as { rows: { slot: number; label?: string }[] }).rows.find(
        (row) => row.slot === 0,
      ),
    ).toMatchObject({ slot: 0, label: "Ada" });
    expect((portableProjection as { rows: unknown }).rows).toEqual(
      (projected as { rows: unknown }).rows,
    );
    expect(portableProjection.issues).toEqual([]);
    // A range past the project's end reads the clamped range in both owners.
    const pastEnd = { ...projectQuery, range: { startUs: 750000, endUs: 70000000 } };
    const clamp = [
      {
        code: "range-clamped",
        message: expect.any(String),
        at: { range: { startUs: 750000, endUs: 60000000 } },
        evidence: {
          requested: { startUs: 750000, endUs: 70000000 },
          applied: { startUs: 750000, endUs: 60000000 },
          bounds: { startUs: 0, endUs: 60000000 },
        },
      },
    ];
    expect((await ready("speaker.get", { ...pastEnd, packageHandle }, "ready")).issues).toEqual(
      clamp,
    );
    active = f;
    expect((await ready("speaker.get", pastEnd, "ready")).issues).toEqual(clamp);
    active = target;
    expect(projected).toMatchObject({
      rows: [
        { fragments: [{ project: { startUs: 125, endUs: 2000125 } }] },
        { fragments: [{ project: { startUs: 1000125, endUs: 4000125 } }] },
      ],
    });
    const packaged = await target.call("speaker.get", { ...query, packageHandle });
    expect(packaged).toMatchObject(original);
    const packagedIntervals = await target.call("speaker.get", {
      ...query,
      view: "intervals",
      packageHandle,
    });
    if (!packagedIntervals.ok) throw Error(JSON.stringify(packagedIntervals));
    expect(
      (packagedIntervals.data as { rows: { slot: number; label?: string }[] }).rows.find(
        (row) => row.slot === 0,
      ),
    ).toMatchObject({ slot: 0, label: "Ada" });
    const adopted = await ready(
      "package.adopt",
      { packageHandle, requestId: "speaker-adopt" },
      "ready",
    );
    const replayed = await target.call("package.adopt", {
      packageHandle,
      requestId: "speaker-adopt",
    });
    expect(replayed).toMatchObject({
      ok: true,
      data: { state: "ready", published: adopted.published },
    });
    await target.call("package.close", { admissionId });
    await f.service.close();
    await rm(f.home, { recursive: true, force: true });
    await target.service.close();
    const restarted = await projectServiceFixture(
      cleanup,
      async (operation) => {
        throw Error(`Retained read cannot invoke ${operation}`);
      },
      target.home,
    );
    const resumed = await restarted.call("speaker.get", query);
    expect(resumed).toEqual(original);
    await writeFile(
      join(target.home, "portable-speaker-comparison.json"),
      JSON.stringify({ original, packaged, adopted, replayed, resumed }),
    );
  },
  30000,
);

test("public continuity operations preserve explicit unavailable and refusal states", async () => {
  const f = await projectServiceFixture([], async () => ({ ok: true, data: {} }));
  try {
    const common = {
      assetId: "a".repeat(64),
      streamId: "audio",
      channel: 0,
      modelId: "speaker-model",
      sourceRange: { startUs: 0, endUs: 600_000_000 },
    };
    expect(
      await f.call("speaker.continuity.prepare", { ...common, expectedSpeakerCount: 4 }),
    ).toMatchObject({
      ok: true,
      data: { state: "unavailable", reason: "continuity_candidate_required", receipt: null },
    });
    expect(
      await f.call("speaker.continuity.get", {
        assetId: common.assetId,
        streamId: common.streamId,
        channel: common.channel,
        modelId: common.modelId,
        sourceRange: common.sourceRange,
        generation: "attempt-1",
      }),
    ).toMatchObject({
      ok: true,
      data: { state: "unavailable", reason: "continuity_not_published", receipt: null },
    });
  } finally {
    await f.service.close();
  }
});

test("continuity receipts remain readable after a quality refusal", async () => {
  const f = await projectServiceFixture([], async () => ({ ok: true, data: {} }));
  try {
    const common = {
      assetId: "b".repeat(64),
      streamId: "audio",
      channel: 0,
      modelId: "speaker-model",
      sourceRange: { startUs: 0, endUs: 600_000_000 },
    };
    const candidate = {
      identity: {
        generation: "continuity-g1",
        sourceDigest: "1".repeat(64),
        modelId: common.modelId,
        modelDigest: "2".repeat(64),
        runtimeDigest: "3".repeat(64),
      },
      metrics: {
        inputFrames: 9_600_000,
        scoredFrames: 9_600_000,
        durationUs: 600_000_000,
        inferenceUs: 10_000_000,
        peakRssBytes: 2_000_000_000,
        expectedSpeakerCount: 4,
        observedSpeakerCount: 4,
        der: 0.2,
        identityConfusion: 0,
        overlapRequired: true,
        overlapRecall: 0.5749,
        stateContinuity: true,
      },
      controls: {
        shortWindow: true,
        transport: true,
        threeSpeaker: true,
        fourSpeakerOverlap: true,
      },
    };
    const prepared = await f.call("speaker.continuity.prepare", {
      ...common,
      expectedSpeakerCount: 4,
      candidate,
    });
    expect(prepared).toMatchObject({
      ok: true,
      data: { state: "ready", receipt: { status: "refused" } },
    });
    const read = await f.call("speaker.continuity.get", {
      assetId: common.assetId,
      streamId: common.streamId,
      channel: common.channel,
      modelId: common.modelId,
      sourceRange: common.sourceRange,
      generation: candidate.identity.generation,
    });
    expect(read).toMatchObject({
      ok: true,
      data: { state: "ready", receipt: { status: "refused" } },
    });
  } finally {
    await f.service.close();
  }
});
