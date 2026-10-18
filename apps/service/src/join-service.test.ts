import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { AlignmentEvidenceStore, assetAlignmentOwner } from "@yap/core/alignment-evidence";
import { selectAlignmentSource } from "@yap/core/source-alignment";
import { alignmentSource, alignmentOutput } from "./alignment.fixture.js";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { projectServiceFixture } from "./project-service.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("join review refuses a foreign prepared tap without inference or authoring another revision", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    throw Error(`Unexpected media execution: ${operation}`);
  });
  const result = await f.call("project.create", {
    requestId: "join-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!result.ok) throw Error(JSON.stringify(result));
  const { project, revision } = result.data as {
    project: { projectId: string };
    revision: { revisionId: string };
  };
  expect(
    await f.call("join.verify", {
      projectId: project.projectId,
      revisionId: revision.revisionId,
      preparedResourceId: "foreign",
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
      boundary: { trackId: "audio", projectAtUs: 0 },
      context: { beforeUs: 100000, afterUs: 100000 },
      expectedText: "A complete question?",
      thresholdRMS: 0.01,
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_CHANGED" } });
  expect(
    await f.call("revision.get", { projectId: project.projectId, revisionId: revision.revisionId }),
  ).toMatchObject({ ok: true, data: { revision: { revisionId: revision.revisionId } } });
});

test.runIf(process.platform === "darwin")(
  "prepared join review keeps opening/ending context and missing recognition honest without media work",
  async () => {
    const { jsonWorker } = await import("./worker.js");
    const native = jsonWorker({
      executable: fileURLToPath(
        new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url),
      ),
      args: [],
    });
    let reviewing = false;
    const home = await realpath(await mkdtemp(join(tmpdir(), "join-service-")));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const f = await projectServiceFixture(
      cleanup,
      async (operation, params, options) => {
        if (reviewing) throw Error(`Review invoked media work: ${operation}`);
        const result = await native(operation, params, options);
        // The shared fixture writes semantic probe data through the real file handoff.
        if (operation === "media.probe" && result.ok) {
          const receipt = result.data as { bytes: number };
          const bytes = Buffer.alloc(receipt.bytes);
          const index = Number(String(params.output).split("/").at(-1)) - 3;
          readSync(options!.descriptors![index]!, bytes, 0, bytes.length, 0);
          return { ok: true, data: JSON.parse(bytes.toString()) };
        }
        return result;
      },
      home,
    );
    async function call<T>(operation: string, params: Record<string, unknown>) {
      const reply = await f.call(operation, params);
      if (!reply.ok) throw Error(JSON.stringify(reply));
      return reply.data as T;
    }
    const created = await call<{
      project: { projectId: string };
      revision: { revisionId: string };
    }>("project.create", {
      requestId: "prepared-join-project",
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const projectId = created.project.projectId;
    const edited = await call<{ revision: { revisionId: string } }>("edit.apply", {
      projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: "join-silence",
      operations: [
        { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
        {
          operation: "place",
          clip: {
            trackId: { label: "audio" },
            source: { kind: "silence" },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ],
    });
    const revisionId = edited.revision.revisionId;
    const selection = {
      projectId,
      revisionId,
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    };
    const pending = await call<{ jobId: string }>("audio.prepare", selection);
    await f.job(pending.jobId, "ready");
    const ready = await call<{ published: { output: { resourceId: string; assetId: string } } }>(
      "audio.prepare",
      selection,
    );
    const saved = await call<{ revision: { document: { tracks: { id: string }[] } } }>(
      "revision.get",
      { projectId, revisionId },
    );
    const input = {
      ...selection,
      preparedResourceId: ready.published.output.resourceId,
      boundary: { trackId: saved.revision.document.tracks[0]!.id, projectAtUs: 0 },
      context: { beforeUs: 100000, afterUs: 100000 },
      expectedText: "A complete question?",
      thresholdRMS: 0.01,
    };
    reviewing = true;
    const opening = await f.call("join.verify", input);
    expect(opening).toMatchObject({
      ok: true,
      data: {
        projectRange: { startUs: 0, endUs: 100000 },
        boundary: { before: null, after: { kind: "silence" } },
        source: { before: { state: "not_applicable" }, after: { state: "not_applicable" } },
        rendered: { alignment: { state: "missing" }, recognition: { state: "missing" } },
        audio: {
          dimensions: { sampleRate: 48000, channels: 2, frameCount: 48000 },
          waveform: { buckets: expect.any(Array) },
          spectrum: { columns: expect.any(Array) },
        },
        phoneticCompleteness: "unknown",
      },
    });
    expect(
      await f.call("join.verify", {
        ...input,
        candidateOffsetsUs: [-50000, 50000, 2000000],
      }),
    ).toMatchObject({
      ok: true,
      data: {
        candidates: [
          { offsetUs: -50000, state: "outside_project" },
          { offsetUs: 50000, state: "observed" },
          { offsetUs: 2000000, state: "outside_project" },
        ],
      },
    });
    expect(
      await f.call("join.verify", {
        ...input,
        boundary: { ...input.boundary, projectAtUs: 1000000 },
      }),
    ).toMatchObject({
      ok: true,
      data: { projectRange: { startUs: 900000, endUs: 1000000 }, boundary: { after: null } },
    });
    expect(
      await f.call("join.verify", { ...input, sourceEvidence: { after: "foreign" } }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await call("revision.get", { projectId, revisionId })).toEqual(saved);
    const assetId = ready.published.output.assetId;
    const library = join(home, "library"),
      catalog = new Catalog(join(library, "catalog.sqlite"));
    const assets = new AssetStore(catalog, library),
      acquisitions = new AcquisitionStore(catalog);
    const streamId = assets.get(assetId).streams.find((stream) => stream.kind === "audio")!.id;
    const selected = selectAlignmentSource(assets, acquisitions, {
      assetId,
      streamId,
      channel: 0,
      sourceRange: alignmentSource.observationRange,
      text: alignmentSource.text,
      modelId: "nemo-ctc110",
    });
    const records = new AlignmentEvidenceStore(catalog, assetAlignmentOwner(assets, acquisitions));
    const staged = records.stage(
      { owner: { kind: "asset", assetId }, generation: "join-g1", policy: "alignment-v1" },
      { ...alignmentSource, streamId, durationUs: 1000000, supportDigest: selected.supportDigest },
      alignmentOutput(),
    );
    try {
      catalog.transaction(() => staged.publish());
    } finally {
      catalog.close();
    }
    const measured = await f.call("join.verify", {
      ...input,
      renderedAlignmentGeneration: "join-g1",
    });
    expect(measured).toMatchObject({
      ok: true,
      data: {
        rendered: {
          alignment: {
            metadata: {
              generation: "join-g1",
              lexicalIdentity: "unknown",
              source: { text: "Hi wrong Hi" },
            },
            coverage: { observed: [{ startUs: 0, endUs: 100000 }], missing: [] },
            words: expect.arrayContaining([
              expect.objectContaining({
                kind: "supplied",
                text: "wrong",
                correspondence: "unmatched",
                timing: null,
              }),
            ]),
            acoustic: expect.arrayContaining([
              expect.objectContaining({
                rms: 0.01,
                activity: "active",
                lexicalIdentity: "unknown",
              }),
            ]),
            phoneticCompleteness: "unknown",
          },
        },
        phoneticCompleteness: "unknown",
      },
    });
    const placed = await call<{ revision: { revisionId: string } }>("edit.apply", {
      projectId,
      expectedRevisionId: revisionId,
      requestId: "join-source",
      operations: [
        { operation: "track.add", track: { kind: "audio", order: 1 }, label: "source" },
        {
          operation: "place",
          clip: {
            trackId: { label: "source" },
            assetId,
            streamId,
            source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ],
    });
    const revised = { ...selection, revisionId: placed.revision.revisionId };
    expect(await f.call("join.verify", { ...input, revisionId: revised.revisionId })).toMatchObject(
      { ok: false, error: { code: "ARTIFACT_CHANGED" } },
    );
    reviewing = false;
    const next = await call<{ jobId: string }>("audio.prepare", revised);
    await f.job(next.jobId, "ready");
    const nextReady = await call<{ published: { output: { resourceId: string } } }>(
      "audio.prepare",
      revised,
    );
    const sourceRevision = await call<{ revision: { document: { tracks: { id: string }[] } } }>(
      "revision.get",
      { projectId, revisionId: revised.revisionId },
    );
    reviewing = true;
    const sourceInput = {
      ...input,
      ...revised,
      preparedResourceId: nextReady.published.output.resourceId,
      boundary: { trackId: sourceRevision.revision.document.tracks[1]!.id, projectAtUs: 50000 },
      sourceEvidence: { before: "join-g1", after: "join-g1" },
    };
    const sourceReview = await f.call("join.verify", sourceInput);
    expect(sourceReview).toMatchObject({
      ok: true,
      data: {
        boundary: {
          before: { assetId, streamId, sourceAtUs: 50000 },
          after: { assetId, streamId, sourceAtUs: 50000 },
        },
        source: {
          before: {
            state: "observed",
            requestedRange: { startUs: 0, endUs: 150000 },
            coverage: {
              observed: [{ startUs: 0, endUs: 100000 }],
              missing: [{ startUs: 100000, endUs: 150000 }],
            },
          },
          after: { state: "observed", metadata: { generation: "join-g1" } },
        },
        rendered: { recognition: { state: "missing" } },
        phoneticCompleteness: "unknown",
      },
    });
  },
);
