import { afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import type { OperationResult } from "@yap/protocol";
import { captureFixture, settleCapture, sourceWorker } from "./project-capture.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
type Item = {
  atUs: number;
  ok: boolean;
  data: {
    state: string;
    jobId: string | null;
    published: { generation: string } | null;
    delivery?: { token: string };
  };
};
function items(reply: OperationResult) {
  if (!reply.ok) throw new Error(JSON.stringify(reply));
  return (reply.data as { items: Item[] }).items;
}

/** A captured take whose evidence carries an inside-the-picture cursor trail. */
async function cursorTake() {
  const samples = [10, 20, 30, 40];
  const overlays: unknown[] = [];
  let failNext = true;
  const f = await captureFixture(cleanups, undefined, async (operation, params, options) => {
    if (operation === "media.sourceVisualSamples") {
      return {
        ok: true,
        data: {
          sourceWidth: 16,
          sourceHeight: 16,
          samples: (params.atSourceUs as number[]).map((at) => ({
            status: "available",
            requestedSourceUs: at,
            actualSourceUs: at,
            width: 8,
            height: 8,
            rgbBase64: Buffer.alloc(8 * 8 * 3).toString("base64"),
          })),
        },
      };
    }
    if (operation === "media.sourceFrame") {
      overlays.push(params.cursorOverlay);
      if (failNext) {
        failNext = false;
        return {
          ok: false,
          error: {
            code: "DECODE_FAILED",
            message: "controlled picture failure",
            retryable: true,
            details: {},
          },
        };
      }
      const asset = params.asset as { assetId: string; streamId: string };
      const at = Number(params.atUs);
      await writeFile(String(params.output), png, { flag: "wx" });
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
            endValue: String(at + 10),
            endTimescale: 1_000_000,
            originUs: 0,
          },
          // The captured display is 16x16; delivered bytes stay a tiny PNG.
          width: 16,
          height: 16,
          sourceWidth: 16,
          sourceHeight: 16,
          decodedSamples: 1,
          readerOpens: 1,
          bytes: png.length,
        },
      };
    }
    const result = await sourceWorker(operation, params, options);
    if (operation !== "media.sourceEvidence" || !result.ok) return result;
    const records = [
      {
        event: "geometry",
        data: {
          epoch: 1,
          sourceUs: 0,
          hostUs: 0,
          geometry: {
            outputWidth: 16,
            outputHeight: 16,
            contentScale: 1,
            scaleFactor: 1,
            contentRect: { x: 0, y: 0, width: 16, height: 16 },
          },
        },
      },
      ...samples.map((sourceUs) => ({
        event: "cursorSample",
        data: {
          sourceUs,
          x: sourceUs / 10,
          y: 2,
          globalX: sourceUs / 10,
          globalY: 2,
          buttons: 0,
          eligibility: "inside",
          geometryEpoch: 1,
        },
      })),
    ];
    const body = records.map((row) => JSON.stringify(row) + "\n").join("");
    await writeFile(String(params.output), body);
    return {
      ok: true,
      data: {
        ...(result.data as Record<string, unknown>),
        cursorSamples: samples.length,
        geometryRecords: 1,
        firstCursorSourceUs: samples[0],
        lastCursorSourceUs: samples.at(-1),
        lastSequence: records.length,
        bytes: Buffer.byteLength(body),
      },
    };
  });
  const take = await settleCapture(f, "cursor-render");
  await expect
    .poll(async () => {
      const job = await f.call("job.get", { jobId: take.job.id });
      return job.ok && (job.data as { state: string }).state;
    })
    .toBe("ready");
  const acquisition = await f.call("acquisition.get", { acquisitionId: take.acquisitionId });
  if (!acquisition.ok) throw new Error(JSON.stringify(acquisition));
  const { id, bindings } = acquisition.data as {
    id: string;
    bindings: { assetId: string; streamId: string }[];
  };
  return {
    ...f,
    overlays,
    selection: {
      assetId: bindings[0]!.assetId,
      streamId: bindings[0]!.streamId,
      acquisitionId: id,
    },
  };
}

test("a failed cursor.render item recovers through job.retry with the jobId it returned", async () => {
  const f = await cursorTake();
  const request = { ...f.selection, atUs: [40], trailUs: 30 };
  const [first] = items(await f.call("cursor.render", request));
  expect(first).toMatchObject({ atUs: 40, ok: true, data: { jobId: expect.any(String) } });
  const jobId = first!.data.jobId!;
  await expect
    .poll(async () => items(await f.call("cursor.render", request))[0]!.data.state)
    .toBe("failed");
  // Reading a failed item reports the same job and does not start another attempt.
  expect(items(await f.call("cursor.render", request))[0]).toMatchObject({
    ok: true,
    data: { state: "failed", jobId, published: null },
  });
  expect(f.overlays).toHaveLength(1);
  expect(await f.call("job.retry", { jobId })).toMatchObject({ ok: true, data: { id: jobId } });
  await expect
    .poll(async () => items(await f.call("cursor.render", request))[0]!.data.state)
    .toBe("ready");
  const [ready] = items(await f.call("cursor.render", request));
  expect(ready).toMatchObject({
    ok: true,
    data: { state: "ready", jobId, published: { generation: expect.any(String) } },
  });
  // The retried attempt re-rendered with the same captured trail.
  expect(f.overlays).toHaveLength(2);
  expect(f.overlays[1]).toEqual(f.overlays[0]);
  expect(f.overlays[1]).toBeTruthy();
  const token = ready!.data.delivery!.token;
  expect(
    await f.call("artifact.read", { token, offsetBytes: 0, maxBytes: png.length }),
  ).toMatchObject({
    ok: true,
    data: { data: png.toString("base64"), eof: true },
  });
  for (const item of items(await f.call("cursor.render", request)).concat(ready!))
    if (item.data.delivery) await f.call("artifact.close", { token: item.data.delivery.token });
});

// Native conformance uses synthetic media and production-written journals, without worker stubs.
test("native dense and change-only journals render the same held pointer through cuts, scenes and reordered clips", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, mkdir, rm, readFile, copyFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash, randomUUID } = await import("node:crypto");
  const { CaptureStore } = await import("@yap/core/capture-store");
  const { AssetStore } = await import("@yap/core/assets");
  const { AcquisitionStore } = await import("@yap/core/acquisitions");
  const { SourceEvidenceStore, recordingEvidenceOwner } = await import("@yap/core/evidence");
  const { CaptureSourceRead } = await import("@yap/core/capture-source-read");
  const { planFrameTrail } = await import("@yap/core/trails");
  const { PresentationEvidence } = await import("@yap/core/presentation-evidence");
  const { PresentationPointerHistory } = await import("@yap/core/presentation-pointer-history");
  const { createCompiler, validateComposition } = await import("@yap/composition");
  const { assetProbe } = await import("./media-probe.js");
  const root = await mkdtemp("/tmp/cursor-hold-render-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const native = new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url).pathname;
  const call = (
    operation: string,
    params: Record<string, unknown>,
    descriptors: readonly number[] = [],
  ) => {
    const reply = JSON.parse(
      execFileSync(native, [], {
        input: JSON.stringify({ id: "cursor-conformance", operation, params }) + "\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe", ...descriptors],
        timeout: 30_000,
      }),
    );
    if (!reply.ok) throw Error(JSON.stringify(reply));
    return reply.data;
  };
  execFileSync(
    new URL("../../../helpers/mac/.build/debug/YapCaptureTests", import.meta.url).pathname,
    [],
    { env: { ...process.env, YAP_CURSOR_HOLD_FIXTURES: root } },
  );
  const video = join(root, "video.mov");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x203040:s=100x80:r=4:d=3",
    "-vf",
    "drawbox=x=4:y=4:w=26:h=16:c=white:t=2,negate=enable='gte(t,1)'",
    "-c:v",
    "libx264",
    video,
  ]);
  let nextId = 0;
  const library = join(root, "library");
  await mkdir(library, { mode: 0o700 });
  const catalog = new CaptureStore(join(library, "catalog.sqlite"), {
    newId: () => String(++nextId),
    now: () => "fixture",
  });
  const recording = catalog.allocate().recording;
  let catalogClosed = false;
  cleanups.push(async () => {
    if (!catalogClosed) catalog.close();
  });
  const assets = new AssetStore(catalog, library);
  await assets.recover();
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const worker: import("./worker.js").MediaWorker = async (op, params, options) => ({
    ok: true,
    data: call(op, params, options?.descriptors),
  });
  const asset = await assets.import(video, { kind: "import" }, assetProbe(worker, workspace));
  const acquisitions = new AcquisitionStore(catalog);
  const evidence = new SourceEvidenceStore(catalog, (identity) => {
    if (identity.owner.kind === "recording") recordingEvidenceOwner(catalog)(identity);
    else acquisitions.intent(identity.owner.id);
  });
  const available = [{ startUs: 0, endUs: 3_000_000 }];
  const rendered: Buffer[][] = [];
  const selections: Array<{ assetId: string; streamId: string; acquisitionId: string }> = [];
  for (const mode of ["dense", "sparse"]) {
    const id = randomUUID();
    acquisitions.admitPortable(id, "cursor-fixture");
    const receipt = call("media.sourceEvidence", {
      directory: join(root, mode),
      output: join(root, `${mode}.jsonl`),
    });
    const metadata = await evidence.ingest({
      owner: { kind: "acquisition", id },
      sourceId: "2",
      generation: "fixture",
      file: receipt.file,
      receipt,
    });
    const recordingMetadata = await evidence.ingest({
      ...metadata,
      owner: { kind: "recording", id: recording.id },
      generation: mode,
      file: receipt.file,
      receipt,
    });
    const journal = await readFile(join(root, mode, "capture.journal.jsonl"));
    acquisitions.publish({
      id,
      sourceId: "2",
      evidence: metadata,
      journal: {
        fileName: `${mode}.jsonl`,
        bytes: journal.length,
        sha256: createHash("sha256").update(journal).digest("hex"),
      },
      bindings: [
        {
          assetId: asset.id,
          streamId: "track:1",
          available,
          sourceRoles: ["video"],
          sourceToAssetOffsetUs: 0,
          supportBasis: "physical",
        },
      ],
    });
    const selection = { assetId: asset.id, streamId: "track:1", acquisitionId: id };
    selections.push(selection);
    const raw = new CaptureSourceRead(assets, acquisitions, evidence).cursor({
      ...selection,
      sourceRange: { startUs: 1_500_000, endUs: 1_600_000 },
      limit: 1,
    });
    expect(raw.page?.rows[0]?.observation).toMatchObject({ x: 42, y: 20 });
    const sourceAsset = { assetId: asset.id, streamId: "track:1", path: video, originUs: 0 };
    const signal = new AbortController().signal;
    const images: Buffer[] = [];
    const render = async (name: string, atUs: number, overlay: unknown) => {
      const output = join(root, `${mode}-${name}.png`);
      call("media.sourceFrame", {
        asset: sourceAsset,
        available,
        atUs,
        output,
        cursorOverlay: overlay,
      });
      images.push(await readFile(output));
      if (process.env.YAP_CURSOR_HOLD_SHOTS) {
        const destination = join(process.env.YAP_CURSOR_HOLD_SHOTS, mode);
        await mkdir(destination, { recursive: true });
        await copyFile(output, join(destination, `${name}.png`));
      }
    };
    // Still selection uses the native decoder for both scene evidence and delivered pixels.
    const kept = { startUs: 1_000_000, endUs: 3_000_000 };
    for (const [name, range] of [
      ["cut-still", kept],
      ["scene-still", available[0]!],
    ] as const) {
      const still = await planFrameTrail(
        { source: video, kept: range, requestedSourceUs: 1_500_000, trailUs: 0 },
        {
          evidence,
          identity: recordingMetadata,
          sample: async (request) => {
            const result = call("media.sourceVisualSamples", {
              asset: sourceAsset,
              available: [range],
              atSourceUs: request.atSourceUs,
            });
            return {
              sourceWidth: result.sourceWidth,
              sourceHeight: result.sourceHeight,
              samples: result.samples.map(
                (s: {
                  requestedSourceUs: number;
                  actualSourceUs: number;
                  width: number;
                  height: number;
                  rgbBase64: string;
                }) => ({ ...s, distanceUs: Math.abs(s.requestedSourceUs - s.actualSourceUs) }),
              ),
            };
          },
        },
        signal,
      );
      expect(still.overlay.pointer).toMatchObject({ x: 42, y: 20 });
      await render(name, 1_500_000, still.overlay);
    }
    const receiptHistory = call("media.presentationEvidence", {
      source: video,
      output: join(root, `${mode}-history.jsonl`),
      plan: [{ source: kept, playback: { startUs: 0, endUs: 2_000_000 } }],
    });
    const presentation = await PresentationEvidence.open(receiptHistory, [kept], signal);
    const history = new PresentationPointerHistory(
      { evidence, identity: metadata, presentation },
      signal,
    );
    try {
      // The composition compiler supplies the actual source clocks for reordered project clips.
      const clips = [2_000_000, 1_000_000].map((startUs, index) => ({
        id: `clip-${index}`,
        trackId: "video",
        ...selection,
        source: { kind: "range", range: { startUs, endUs: startUs + 500_000 } },
        placement: {
          kind: "project",
          range: { startUs: index * 500_000, endUs: (index + 1) * 500_000 },
        },
      }));
      const model = validateComposition(
        {
          canvas: {
            width: 100,
            height: 80,
            fps: { numerator: 2, denominator: 1 },
            background: "#000000ff",
          },
          tracks: [{ id: "video", kind: "video", order: 0 }],
          groups: [],
          syncGroups: [],
          clips,
          processing: [],
        },
        [
          {
            id: asset.id,
            streams: [
              {
                id: "track:1",
                kind: "video",
                width: 100,
                height: 80,
                bounds: available[0],
                available,
              },
            ],
          },
        ],
        [{ id, bindings: [{ assetId: asset.id, streamId: "track:1", available }] }],
      );
      for (const frame of createCompiler(model, "cursor-equivalence").frames({
        startUs: 0,
        endUs: 1_000_000,
      })) {
        const layer = frame.layers[0]!;
        if (layer.kind !== "video") throw Error("Expected video");
        const sampled = await history.sample(0, layer.sourceUs, 0);
        if (sampled.inspection.kind !== "picture") throw Error("Expected picture");
        expect(sampled.inspection.plan.overlay.pointer).toMatchObject({ x: 42, y: 20 });
        await render(
          `project-${frame.index}`,
          Number(layer.sourceUs),
          sampled.inspection.plan.overlay,
        );
      }
    } finally {
      await history.close();
      await presentation.close();
    }
    rendered.push(images);
  }
  expect(rendered[1]).toEqual(rendered[0]);
  // The native mirror admits a time-bounded trail past both former count ceilings.
  const busy = call("media.sourceEvidence", {
    directory: join(root, "busy"),
    output: join(root, "busy.jsonl"),
  });
  const rows = (await readFile(busy.file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const points = rows
    .filter((row) => row.event === "cursorSample")
    .map(({ data }) => ({ atSourceUs: data.sourceUs, x: data.x, y: data.y }));
  expect(points).toHaveLength(6001);
  expect(points.at(-1)).toEqual({ atSourceUs: 3_000_000, x: 0, y: 20 });
  call("media.sourceFrame", {
    asset: { assetId: asset.id, streamId: "track:1", path: video, originUs: 0 },
    available,
    atUs: 2_750_000,
    output: join(root, "dense-trail.png"),
    cursorOverlay: {
      trail: [points.filter((point) => point.atSourceUs <= 2_750_000)],
      trailUs: 3_000_000,
      pointer: null,
    },
  });
  catalog.close();
  catalogClosed = true;
  const { startProjectService } = await import("./project-service.js");
  const { callLocal } = await import("@yap/client");
  const service = await startProjectService({
    home: root,
    nativeExecutable: native,
    autoPrepareModels: false,
  });
  cleanups.push(() => service.close());
  const publicCall = (operation: string, params: Record<string, unknown>) =>
    callLocal(service.socketPath, { id: "held-public", operation, params });
  const publicImages: string[] = [];
  for (const selection of selections) {
    const raw = await publicCall("cursor.raw", {
      ...selection,
      sourceRange: { startUs: 1_505_000, endUs: 1_600_000 },
      limit: 1,
    });
    if (!raw.ok) throw Error(JSON.stringify(raw));
    const page = raw.data as { rows: { observation: { x: number } }[]; nextCursor: string | null };
    expect(page.rows[0]?.observation.x).toBe(42);
    if (page.nextCursor) {
      const next = await publicCall("cursor.raw", {
        ...selection,
        sourceRange: { startUs: 1_505_000, endUs: 1_600_000 },
        limit: 1,
        cursor: page.nextCursor,
      });
      if (!next.ok) throw Error(JSON.stringify(next));
      expect(
        (next.data as { rows: { captureAtUs: number }[] }).rows.every(
          (row) => row.captureAtUs >= 1_505_000,
        ),
      ).toBe(true);
    }
    let item: Item;
    await expect
      .poll(async () => {
        item = items(
          await publicCall("cursor.render", { ...selection, atUs: [1_500_000], trailUs: 0 }),
        )[0]!;
        if (["failed", "unavailable"].includes(item.data.state)) throw Error(JSON.stringify(item));
        return item.data.state;
      })
      .toBe("ready");
    const token = item!.data.delivery!.token;
    const bytes = await publicCall("artifact.read", { token, offsetBytes: 0, maxBytes: 65_536 });
    if (!bytes.ok) throw Error(JSON.stringify(bytes));
    publicImages.push((bytes.data as { data: string }).data);
    await publicCall("artifact.close", { token });
  }
  expect(publicImages[1]).toBe(publicImages[0]);
}, 30_000);

test("cursor.render with zero trail uses the still pointer policy", async () => {
  const f = await cursorTake();
  const [item] = items(await f.call("cursor.render", { ...f.selection, atUs: [40], trailUs: 0 }));
  await expect
    .poll(async () => {
      const result = await f.call("job.get", { jobId: item!.data.jobId });
      if (result.ok && (result.data as { state: string }).state === "failed" && !f.overlays.length)
        throw Error(JSON.stringify(result));
      return f.overlays.length;
    })
    .toBe(1);
  expect(f.overlays[0]).toEqual({ trail: [], trailUs: 0, pointer: { atSourceUs: 40, x: 4, y: 2 } });
});
