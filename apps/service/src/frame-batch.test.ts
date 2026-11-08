import { afterEach, expect, test } from "vitest";
import { writeFile, readFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  faceObservationsSchema,
  pictureObservationsSchema,
  type OperationFailure,
  type OperationResult,
} from "@yap/protocol";
import type { MediaFrameInspection } from "@yap/core/frame-inspection";
import type { SourceSelection } from "@yap/core/source-selection";
import type { DerivativeDelivery } from "./delivery.js";
import { projectServiceFixture } from "./project-service.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
type FrameStatus = Extract<
  ReturnType<MediaFrameInspection["request"]>,
  { assetId: string; atUs: number }
> & {
  delivery: ReturnType<DerivativeDelivery["open"]>;
};
type FrameItem =
  | ({ atUs: number } & OperationFailure)
  | { atUs: number; ok: true; data: FrameStatus };
function batch(reply: OperationResult) {
  expect(reply.ok).toBe(true);
  if (!reply.ok) throw new Error(JSON.stringify(reply));
  return reply.data as SourceSelection & { items: FrameItem[] };
}
async function fixture(home?: string) {
  const observationRequests: unknown[] = [];
  const attempts: number[] = [],
    failures = new Set<number>();
  const f = await projectServiceFixture(
    cleanups,
    async (operation, params) => {
      if (operation === "media.probe")
        return {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              {
                id: "v",
                kind: "video",
                codec: "fixture",
                decodable: true,
                startUs: 0,
                endUs: 1_000_000,
                segments: [{ startUs: 0, endUs: 1_000_000, empty: false }],
                width: 1,
                height: 1,
                orientedWidth: 1,
                orientedHeight: 1,
              },
            ],
          },
        };
      expect(operation).toBe("media.sourceFrame");
      const at = Number(params.atUs);
      observationRequests.push(params.observations);
      attempts.push(at);
      if (failures.has(at))
        return {
          ok: false,
          error: {
            code: "DECODE_FAILED",
            message: "controlled picture failure",
            retryable: true,
            details: {},
          },
        };
      const asset = params.asset as { assetId: string; streamId: string };
      await writeFile(String(params.output), png, { flag: "wx" });
      // This native edge proves service/cache/delivery behavior, not decoded pixel quality.
      return {
        ok: true,
        data: {
          file: params.output,
          mediaType: "image/png",
          assetId: asset.assetId,
          streamId: asset.streamId,
          requestedSourceUs: at,
          actualSourceUs: at,
          sample: {
            value: String(at),
            timescale: 1_000_000,
            endValue: String(at + 100_000),
            endTimescale: 1_000_000,
            originUs: 0,
          },
          width: 1,
          height: 1,
          sourceWidth: 1,
          sourceHeight: 1,
          decodedSamples: 1,
          readerOpens: 1,
          bytes: png.length,
          ...(params.observations ? { observations: whiteObservations(params.observations) } : {}),
          ...(params.faceObservations ? { faceObservations: oneFace } : {}),
        },
      };
    },
    home,
  );
  const imported = await f.call("asset.import", { requestId: "batch-source", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const job = imported.data as { jobId: string };
  const asset = (await f.job(job.jobId, "ready")).published!.output;
  return {
    ...f,
    selection: { assetId: asset.assetId, streamId: "v" },
    attempts,
    failures,
    observationRequests,
  };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, atUs: number[]) {
  let result = batch(await f.call("frame.batch", { ...f.selection, atUs }));
  for (const item of result.items)
    if (item.ok && item.data.jobId) await f.job(item.data.jobId, "ready");
  await closeDeliveries(f, result.items);
  result = batch(await f.call("frame.batch", { ...f.selection, atUs }));
  return result;
}
async function closeDeliveries(f: Awaited<ReturnType<typeof fixture>>, items: FrameItem[]) {
  for (const item of items)
    if (item.ok && item.data.delivery)
      expect(await f.call("artifact.close", { token: item.data.delivery.token })).toMatchObject({
        ok: true,
        data: { closed: true },
      });
}

test("service source batches isolate invalid admission and retain ordered duplicate jobs and complete bytes", async () => {
  const f = await fixture(),
    atUs = [0, 1_000_000, 0, 500_000];
  const result = await ready(f, atUs);
  expect(result.items.map((item) => item.atUs)).toEqual(atUs);
  expect(result.items[1]).toMatchObject({
    atUs: 1_000_000,
    ok: false,
    error: { code: "INVALID_RANGE" },
  });
  const good = result.items.filter((item) => item.ok);
  expect(good.map((item) => item.data.state)).toEqual(["ready", "ready", "ready"]);
  expect(good[0]!.data.published).toEqual(good[1]!.data.published);
  expect(good[0]!.data.jobId).toBe(good[1]!.data.jobId);
  for (const item of good) {
    expect(item.data.published!.output).toMatchObject({
      ...f.selection,
      atUs: item.atUs,
      requestedSourceUs: item.atUs,
      actualSourceUs: item.atUs,
    });
    const part = await f.call("artifact.read", {
      token: item.data.delivery!.token,
      offsetBytes: 0,
    });
    expect(part).toMatchObject({
      ok: true,
      data: {
        offsetBytes: 0,
        nextOffsetBytes: png.length,
        eof: true,
        data: png.toString("base64"),
      },
    });
    expect(await readFile(item.data.published!.output.file)).toEqual(png);
  }
  expect([...f.attempts].sort((a, b) => a - b)).toEqual([0, 500_000]);
  await closeDeliveries(f, result.items);
});

test("service source batches isolate an unreadable cached sibling", async () => {
  const f = await fixture();
  const initial = await ready(f, [0]);
  const first = initial.items[0]!;
  if (!first.ok) throw new Error(JSON.stringify(first));
  const file = first.data.published!.output.file;
  await closeDeliveries(f, initial.items);
  await chmod(file, 0);
  try {
    const result = batch(await f.call("frame.batch", { ...f.selection, atUs: [0, 500_000] }));
    expect(result.items[0]).toMatchObject({
      atUs: 0,
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    const next = result.items[1]!;
    if (!next.ok || !next.data.jobId) throw new Error(JSON.stringify(next));
    await f.job(next.data.jobId, "ready");
    const retained = await ready(f, [500_000]);
    expect(retained.items[0]).toMatchObject({ atUs: 500_000, ok: true, data: { state: "ready" } });
    const item = retained.items[0]!;
    if (!item.ok) throw new Error(JSON.stringify(item));
    expect(await readFile(item.data.published!.output.file)).toEqual(png);
    await closeDeliveries(f, retained.items);
    expect([...f.attempts].sort((a, b) => a - b)).toEqual([0, 500_000]);
  } finally {
    await chmod(file, 0o600);
  }
});

test("service source batches require independent explicit retry of a failed picture", async () => {
  const f = await fixture();
  f.failures.add(500_000);
  const first = batch(await f.call("frame.batch", { ...f.selection, atUs: [0, 500_000] }));
  const good = first.items[0]!,
    bad = first.items[1]!;
  if (!good.ok || !bad.ok) throw new Error(JSON.stringify(first));
  await f.job(good.data.jobId!, "ready");
  const until = Date.now() + 3000;
  for (;;) {
    const reply = await f.call("job.get", { jobId: bad.data.jobId! });
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    if ((reply.data as { state: string }).state === "failed") break;
    if (Date.now() >= until) throw new Error("controlled picture did not fail");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const failed = batch(await f.call("frame.batch", { ...f.selection, atUs: [0, 500_000] }));
  expect(failed.items[1]).toMatchObject({
    ok: true,
    data: { state: "failed", jobId: bad.data.jobId, published: null },
  });
  const published = failed.items[0]!;
  if (!published.ok) throw new Error(JSON.stringify(published));
  expect([...f.attempts].sort((a, b) => a - b)).toEqual([0, 500_000]);
  await closeDeliveries(f, failed.items);
  f.failures.delete(500_000);
  const retry = await f.call("job.retry", { jobId: bad.data.jobId! });
  expect(retry).toMatchObject({ ok: true, data: { id: bad.data.jobId } });
  await f.job(bad.data.jobId!, "ready");
  const final = await ready(f, [0, 500_000]);
  expect(final.items[0]).toMatchObject({ ok: true, data: { published: published.data.published } });
  expect(final.items[1]).toMatchObject({
    ok: true,
    data: { state: "ready", jobId: bad.data.jobId, published: { generation: "2" } },
  });
  for (const item of final.items) {
    if (!item.ok) throw new Error(JSON.stringify(item));
    expect(await readFile(item.data.published!.output.file)).toEqual(png);
  }
  expect([...f.attempts].sort((a, b) => a - b)).toEqual([0, 500_000, 500_000]);
  await closeDeliveries(f, final.items);
});

const oneFace = {
  recipe: "vision-face-rectangles-v1",
  implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
  coordinateSpace: "delivered-top-left-pixels",
  width: 1,
  height: 1,
  status: "available",
  faces: [{ id: "face-0", boundingBox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 }],
};
function whiteObservations(request: unknown) {
  const histogram = Array<number>(256).fill(0);
  histogram[255] = 1;
  const metric = {
    histogram,
    mean: 255,
    minimum: 255,
    maximum: 255,
    darkFraction: 0,
    brightFraction: 1,
  };
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  const measured = (id: string) => ({
    id,
    requestedRect: rect,
    sampledRect: rect,
    state: "measured",
    coverage: {
      requestedPixels: 1,
      rasterPixels: 1,
      opaquePixels: 1,
      transparentPixels: 0,
      partialAlphaPixels: 0,
    },
    channels: { red: metric, green: metric, blue: metric },
    luma: metric,
  });
  const regions = (request as { regions?: { id: string }[] }).regions ?? [];
  return {
    recipe: "profile-managed-srgb-rgba8-rec709-encoded-luma-opaque-only-v1",
    coordinateSpace: "delivered-top-left-pixels",
    lumaWeights: [0.2126, 0.7152, 0.0722],
    alphaInterpretation: "only-alpha-255-contributes-to-color-metrics",
    sourceProfile: { name: "kCGColorSpaceDeviceRGB", sha256: null, iccStatus: "absent" },
    measurementProfile: { name: "kCGColorSpaceSRGB", sha256: "a".repeat(64), iccStatus: "present" },
    width: 1,
    height: 1,
    rgbaSha256: "b".repeat(64),
    request,
    full: measured("full"),
    regions: regions.map((region) => measured(region.id)),
    edgeBands: [],
  };
}

test("public picture observations are retained with selection and create a distinct normalized cache identity", async () => {
  const f = await fixture();
  const plain = await ready(f, [0]);
  const first = plain.items[0]!;
  if (!first.ok) throw new Error(JSON.stringify(first));
  await closeDeliveries(f, plain.items);
  const requested = batch(
    await f.call("frame.batch", { ...f.selection, atUs: [0], observations: {} }),
  );
  const item = requested.items[0]!;
  if (!item.ok || !item.data.jobId) throw new Error(JSON.stringify(item));
  expect(item.data.jobId).not.toBe(first.data.jobId);
  await f.job(item.data.jobId, "ready");
  const normalized = {
    darkAtOrBelow: 5,
    brightAtOrAbove: 250,
    edgeDarkFraction: 0.98,
    edgeOpaqueFraction: 1,
    regions: [],
  };
  const received = batch(
    await f.call("frame.batch", { ...f.selection, atUs: [0], observations: normalized }),
  );
  expect(received.items[0]).toMatchObject({
    ok: true,
    data: {
      jobId: item.data.jobId,
      published: {
        output: {
          ...f.selection,
          atUs: 0,
          observations: { request: normalized, full: { luma: { mean: 255, brightFraction: 1 } } },
        },
      },
    },
  });
  expect(f.observationRequests).toEqual([undefined, normalized]);
  await closeDeliveries(f, received.items);
});

/** Rewrites retained catalog JSON the way 0.1.61 wrote it: faces and regions named after their kind. */
function writeAsBeforeOwnIds(home: string) {
  const old = (text: string) =>
    text
      .replace(/"id":("[^"]*"),"(rect|requestedRect)"/g, '"regionId":$1,"$2"')
      .replaceAll('"id":"face-', '"faceId":"face-')
      .replaceAll('"native-source-picture-v12-ink"', '"native-source-picture-v9-cursor"');
  const db = new DatabaseSync(join(home, "library", "catalog.sqlite"));
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    let rewritten = 0;
    for (const { name } of tables) {
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
        const next: Record<string, unknown> = {};
        for (const column of columns) {
          const value = row[column];
          if (typeof value === "string" && old(value) !== value) next[column] = old(value);
        }
        if (typeof next.input === "string" && columns.includes("inputSha256"))
          next.inputSha256 = createHash("sha256").update(next.input).digest("hex");
        const changed = Object.keys(next);
        if (!changed.length) continue;
        rewritten++;
        // Some catalog tables are WITHOUT ROWID; the complete prior row identifies the record.
        db.prepare(
          `UPDATE "${name}" SET ${changed.map((column) => `"${column}"=?`).join(",")} WHERE ${columns
            .map((column) => `"${column}" IS ?`)
            .join(" AND ")}`,
        ).run(
          ...(changed.map((column) => next[column]) as string[]),
          ...(columns.map((column) => row[column]) as string[]),
        );
      }
    }
    return rewritten;
  } finally {
    db.close();
  }
}

test("source frames retained by 0.1.61 regenerate instead of serving faces and regions named after their kind", async () => {
  const f = await fixture();
  const selections = [
    { faceObservations: {}, observations: {} },
    {
      faceObservations: {},
      observations: { regions: [{ id: "r", rect: { x: 0, y: 0, width: 1, height: 1 } }] },
    },
  ].map((extra) => ({ ...f.selection, atUs: 0, ...extra }));
  const before = new Map<number, string>();
  for (const [index, selection] of selections.entries()) {
    const requested = await f.call("frame.get", selection);
    if (!requested.ok) throw new Error(JSON.stringify(requested));
    const jobId = (requested.data as { jobId: string }).jobId;
    await f.job(jobId, "ready");
    before.set(index, jobId);
  }
  await f.service.close();
  expect(writeAsBeforeOwnIds(f.home)).toBeGreaterThan(0);

  const upgraded = await fixture(f.home);
  for (const [index, selection] of selections.entries()) {
    const reply = await upgraded.call("frame.get", selection);
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    const status = reply.data as FrameStatus;
    // Evidence from the earlier build is stale, never projected under the new public names.
    expect(status.published).toBeNull();
    expect(status.jobId).not.toBe(before.get(index));
    await upgraded.job(status.jobId!, "ready");
    const ready = await upgraded.call("frame.get", selection);
    if (!ready.ok) throw new Error(JSON.stringify(ready));
    const output = (ready.data as FrameStatus).published!.output as {
      observations: unknown;
      faceObservations: unknown;
    };
    expect(pictureObservationsSchema.parse(output.observations)).toBeDefined();
    expect(faceObservationsSchema.parse(output.faceObservations).faces[0]!.id).toBe("face-0");
    const token = (ready.data as FrameStatus).delivery?.token;
    if (token) await upgraded.call("artifact.close", { token });
  }
});
