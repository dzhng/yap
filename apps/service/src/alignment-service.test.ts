import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { Models } from "@yap/core/models";
import { ResourceReferences } from "@yap/core/references";
import {
  AlignmentEvidenceStore,
  assetAlignmentOwner,
  alignmentGenerationResource,
} from "@yap/core/alignment-evidence";
import { selectAlignmentSource } from "@yap/core/source-alignment";
import {
  alignmentProbe as probe,
  alignmentSource,
  alignmentOutput,
  publishRetainedAlignment,
} from "./alignment.fixture.js";
import { projectServiceFixture } from "./project-service.fixture.js";
import { jsonWorker } from "./worker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test.runIf(process.platform === "darwin")(
  "alignment package export, immutable open and adoption retain complete original evidence without inference",
  async () => {
    const native = jsonWorker({
      executable: fileURLToPath(
        new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url),
      ),
      args: [],
    });
    const f = await projectServiceFixture(cleanup, async (operation, params, options) => {
      if (operation === "media.probe") return { ok: true, data: probe };
      return native(operation, params, options);
    });
    const imported = await f.call("asset.import", {
      requestId: "portable-alignment",
      path: f.path,
    });
    if (!imported.ok) throw Error(JSON.stringify(imported));
    const assetId = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
      .output.assetId;
    const library = join(f.home, "library"),
      catalog = new Catalog(join(library, "catalog.sqlite"));
    const assets = new AssetStore(catalog, library),
      acquisitions = new AcquisitionStore(catalog),
      selected = selectAlignmentSource(assets, acquisitions, {
        assetId,
        streamId: "a1",
        channel: 0,
        sourceRange: alignmentSource.observationRange,
        text: alignmentSource.text,
        modelId: "nemo-ctc110",
      });
    const source = {
        ...alignmentSource,
        supportDigest: selected.supportDigest,
        engine: new Models(library).alignment("nemo-ctc110").engine,
      },
      operands = alignmentOutput();
    for (const field of ["nativeReceipt", "report"] as const) {
      const value = JSON.parse(operands[field]);
      value.modelSha256 = source.engine.modelSha256;
      operands[field] = JSON.stringify(value);
    }
    operands.report += "\n";
    const records = new AlignmentEvidenceStore(catalog, assetAlignmentOwner(assets, acquisitions)),
      staged = records.stage(
        { owner: { kind: "asset", assetId }, generation: "portable-g1", policy: "alignment-v1" },
        source,
        operands,
      );
    catalog.transaction(() => staged.publish());
    catalog.close();
    const query = {
        assetId,
        generation: "portable-g1",
        view: "acoustic",
        thresholdRMS: 0.1,
        limit: 3,
      },
      original = await f.call("alignment.get", query);
    const created = await f.call("project.create", {
      requestId: "alignment-project",
      canvas: {
        width: 64,
        height: 48,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    if (!created.ok) throw Error(JSON.stringify(created));
    const { project, revision } = created.data as {
      project: { projectId: string };
      revision: { id: string };
    };
    expect(
      await f.call("edit.apply", {
        projectId: project.projectId,
        requestId: "place",
        expectedRevisionId: revision.id,
        operations: [
          { operation: "track.add", label: "sound", track: { kind: "audio", order: 0 } },
          {
            operation: "place",
            clip: {
              trackId: { label: "sound" },
              assetId,
              streamId: "a1",
              source: { kind: "range", range: source.observationRange },
              placement: { kind: "project", range: { startUs: 0, endUs: 200000 } },
            },
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.call("alignment.get", {
        projectId: project.projectId,
        revisionId: revision.id,
        preparedResourceId: "prepared-project-tap",
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        assetId,
        generation: "portable-g1",
        view: "words",
      }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_CHANGED" } });
    const wait = async (
      owner: typeof f,
      operation: string,
      params: Record<string, unknown>,
      state: string,
    ) => {
      let result = await owner.call(operation, params);
      await expect
        .poll(
          async () => {
            result = await owner.call(operation, params);
            if (!result.ok) return JSON.stringify(result);
            const observed = (result.data as Record<string, unknown>).state;
            return ["failed", "canceled", "unavailable"].includes(String(observed))
              ? JSON.stringify(result)
              : observed;
          },
          { timeout: 10000 },
        )
        .toBe(state);
      if (!result.ok) throw Error(JSON.stringify(result));
      return result.data as Record<string, unknown>;
    };
    const exportId = randomUUID();
    expect(
      await f.call("export.create", {
        projectId: project.projectId,
        exportId,
        kind: "processed-package",
        directory: f.home,
        leaf: "alignment.zip",
      }),
    ).toMatchObject({ ok: true });
    await wait(f, "export.status", { exportId }, "ready");
    const target = await projectServiceFixture(cleanup, async (operation, params, options) => {
      if (operation.startsWith("media."))
        throw Error(`Unexpected package inference/decoder ${operation}`);
      return native(operation, params, options);
    });
    const opened = await target.call("package.open", {
      path: await realpath(join(f.home, "alignment.zip")),
    });
    if (!opened.ok) throw Error(JSON.stringify(opened));
    const admissionId = (opened.data as { id: string }).id,
      packageHandle = (await wait(target, "package.status", { admissionId }, "ready"))
        .packageHandle;
    const packaged = await target.call("alignment.get", { ...query, packageHandle });
    if (!original.ok || !packaged.ok) throw Error(JSON.stringify({ original, packaged }));
    const originalPage = original.data as { rows: unknown[]; nextCursor: string },
      portablePage = packaged.data as { rows: unknown[]; nextCursor: string };
    expect(portablePage.rows).toEqual(originalPage.rows);
    expect(
      await target.call("alignment.get", {
        ...query,
        packageHandle,
        cursor: originalPage.nextCursor,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    const continued = await target.call("alignment.get", {
      ...query,
      packageHandle,
      cursor: portablePage.nextCursor,
    });
    expect(continued).toMatchObject({
      ok: true,
      data: {
        rows: [{ activity: "quiet" }, { activity: "quiet" }, { activity: "active" }],
      },
    });
    const raw = await target.call("alignment.get", {
      assetId,
      generation: "portable-g1",
      view: "raw",
      operand: "report",
      packageHandle,
    });
    expect(raw).toMatchObject({
      ok: true,
      data: { bytesBase64: Buffer.from(operands.report).toString("base64") },
    });
    const adopted = await wait(
      target,
      "package.adopt",
      { packageHandle, requestId: "adopt-alignment" },
      "ready",
    );
    expect(
      await target.call("package.adopt", { packageHandle, requestId: "adopt-alignment" }),
    ).toMatchObject({ ok: true, data: { state: "ready", published: adopted.published } });
    await target.call("package.close", { admissionId });
    await target.service.close();
    const restarted = await projectServiceFixture(
      cleanup,
      async (operation) => {
        throw Error(`Retained alignment invokes ${operation}`);
      },
      target.home,
    );
    expect(await restarted.call("alignment.get", query)).toEqual(original);
  },
  30000,
);
test("public alignment preparation refuses unavailable runtime and incomplete support without inference", async () => {
  const requests: string[] = [];
  const f = await projectServiceFixture(cleanup, async (operation) => {
    requests.push(operation);
    if (operation !== "media.probe") throw new Error(operation);
    return { ok: true, data: probe };
  });
  const imported = await f.call("asset.import", { requestId: "alignment", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const input = {
    assetId: job.published!.output.assetId,
    streamId: "a1",
    channel: 0,
    sourceRange: alignmentSource.observationRange,
    text: alignmentSource.text,
    modelId: "nemo-ctc110",
  };
  expect(await f.call("alignment.observe", input)).toMatchObject({
    ok: true,
    data: { state: "unavailable", reason: "model_not_prepared", published: null },
  });
  expect(
    await f.call("alignment.observe", { ...input, sourceRange: { startUs: 0, endUs: 3000000 } }),
  ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE_SUPPORT" } });
  expect(requests).toEqual(["media.probe"]);
});

test("project alignment preparation resolves the project-owned tap before source work", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    if (operation === "media.probe") return { ok: true, data: probe };
    throw new Error(`Unexpected project alignment work ${operation}`);
  });
  const result = await f.call("alignment.observe", {
    projectId: "missing-project",
    revisionId: "missing-revision",
    preparedResourceId: "prepared-project-tap",
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    range: { startUs: 0, endUs: 1_000_000 },
    channel: 0,
    text: "hello world",
    modelId: "nemo-ctc110",
  });
  expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("a project alignment range past the revision is admitted clamped; one wholly past it refuses", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    if (operation === "media.probe") return { ok: true, data: probe };
    throw new Error(`Unexpected project alignment work ${operation}`);
  });
  const imported = await f.call("asset.import", { requestId: "clamped-alignment", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const assetId = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output.assetId;
  const created = await f.call("project.create", {
    requestId: "clamped-alignment-project",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const { project, revision } = created.data as {
    project: { projectId: string };
    revision: { id: string };
  };
  const placed = await f.call("edit.apply", {
    projectId: project.projectId,
    requestId: "place",
    expectedRevisionId: revision.id,
    operations: [
      { operation: "track.add", label: "sound", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "sound" },
          assetId,
          streamId: "a1",
          source: { kind: "range", range: { startUs: 0, endUs: 1_000_000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1_000_000 } },
        },
      },
    ],
  });
  if (!placed.ok) throw new Error(JSON.stringify(placed));
  const request = (range: { startUs: number; endUs: number }) =>
    f.call("alignment.observe", {
      projectId: project.projectId,
      preparedResourceId: "prepared-project-tap",
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
      range,
      channel: 0,
      text: "hello world",
      modelId: "nemo-ctc110",
    });
  // Admission clamps to the revision, so the request reaches the prepared-tap lookup.
  expect(await request({ startUs: 500_000, endUs: 3_000_000 })).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_CHANGED", message: "Pinned prepared signal is no longer referenced" },
  });
  expect(await request({ startUs: 1_000_000, endUs: 3_000_000 })).toMatchObject({
    ok: false,
    error: { code: "INVALID_RANGE" },
  });
});
test("public pinned pages, thresholds and original bytes survive restart without models or native work", async () => {
  const f = await projectServiceFixture(cleanup, async (operation) => {
    if (operation !== "media.probe") throw new Error(operation);
    return { ok: true, data: probe };
  });
  const imported = await f.call("asset.import", { requestId: "retained-alignment", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = await f.job((imported.data as { jobId: string }).jobId, "ready"),
    assetId = job.published!.output.assetId;
  const library = join(f.home, "library"),
    catalog = new Catalog(join(library, "catalog.sqlite"));
  const { evidence, source, values, identity } = publishRetainedAlignment(
    catalog,
    library,
    assetId,
  );
  const failedIdentity = { ...identity, generation: "retained-alignment-failed" };
  const failedOperands = { ...values, report: "{}", correspondence: "" };
  evidence.capture(failedIdentity, source, failedOperands);
  catalog.transaction(() =>
    new ResourceReferences(catalog).retain("alignment-generation", { kind: "asset", id: assetId }, [
      alignmentGenerationResource(failedIdentity),
    ]),
  );
  catalog.close();
  expect(
    await f.call("alignment.get", {
      assetId,
      generation: failedIdentity.generation,
      view: "raw",
      operand: "report",
    }),
  ).toMatchObject({
    ok: true,
    data: {
      state: "captured",
      evidence: { verified: false },
      bytesBase64: Buffer.from("{}").toString("base64"),
    },
  });
  expect(
    await f.call("alignment.get", { assetId, generation: failedIdentity.generation }),
  ).toMatchObject({ ok: false, error: { code: "NOT_READY" } });
  const query = {
    assetId,
    generation: identity.generation,
    view: "acoustic",
    thresholdRMS: 0.1,
    limit: 3,
  };
  const first = await f.call("alignment.get", query);
  expect(first).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      generation: identity.generation,
      rows: [{ activity: "quiet" }, { activity: "quiet" }, { activity: "quiet" }],
      nextCursor: expect.any(String),
    },
  });
  if (!first.ok) throw new Error(JSON.stringify(first));
  const cursor = (first.data as { nextCursor: string }).nextCursor;
  const next = await f.call("alignment.get", { ...query, cursor });
  await f.service.close();
  const restarted = await projectServiceFixture(
    cleanup,
    async (operation) => {
      throw new Error(`Unexpected native work ${operation}`);
    },
    f.home,
  );
  expect(await restarted.call("alignment.get", { ...query, cursor })).toEqual(next);
  expect(
    await restarted.call("alignment.get", { ...query, cursor, thresholdRMS: 0.2 }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  expect(
    await restarted.call("alignment.get", {
      assetId,
      generation: identity.generation,
      view: "raw",
      operand: "report",
    }),
  ).toMatchObject({
    ok: true,
    data: { bytesBase64: Buffer.from(values.report).toString("base64") },
  });
  expect(await restarted.call("alignment.get", { assetId, generation: "other" })).toMatchObject({
    ok: false,
    error: { code: "NOT_READY" },
  });
});
