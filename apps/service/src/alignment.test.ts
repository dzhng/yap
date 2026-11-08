import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { selectAlignmentSource } from "@yap/core/source-alignment";
import { alignmentSource } from "./alignment.fixture.js";
import { alignmentObserver } from "./alignment.js";
import type { MediaWorker } from "./worker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("the real alignment worker admits the observer's request and stops only at the model", async () => {
  const home = await mkdtemp("/tmp/alignment-observer-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const source = join(home, "source.wav");
  await writeFile(source, "immutable controlled source");
  const asset = await assets.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "audio",
        kind: "audio",
        codec: "controlled",
        decodable: true,
        channels: 1,
        sampleRate: 16000,
        startUs: 0,
        endUs: 2000000,
        segments: [{ startUs: 0, endUs: 2000000, empty: false }],
      },
    ],
  }));
  const selected = selectAlignmentSource(assets, acquisitions, {
    assetId: asset.id,
    streamId: "audio",
    channel: 0,
    sourceRange: { startUs: 0, endUs: 100000 },
    text: "blue seven blue",
    modelId: alignmentSource.engine.modelId,
  });
  const frames = selected.expectedPCM.frames;
  const pcm = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) pcm.writeFloatLE(0.25, frame * 4);
  const workspace = join(home, "render");
  await mkdir(workspace, { mode: 0o700 });
  const native: MediaWorker = async (operation, params) => {
    if (operation === "storage.clearRenderWorkspace") {
      const parent = params.parent as { name: string };
      await rm(join(workspace, parent.name), { recursive: true, force: true });
      return { ok: true, data: { removed: true } };
    }
    if (operation !== "media.sourceChannelPCM") throw new Error(operation);
    await writeFile(String(params.output), pcm, { flag: "wx" });
    return {
      ok: true,
      data: {
        file: params.output,
        bytes: pcm.length,
        sha256: hash(pcm),
        sampleRate: 16000,
        frames,
        channels: 1,
        channel: 0,
        sourceChannels: 1,
        sourceSampleRate: 16000,
        range: selected.sourceRange,
        sourceOffsetUs: selected.track.sourceOffsetUs,
        recipe: alignmentSource.decoder.recipe,
        representation: "float32-le",
        providerVersion: alignmentSource.decoder.osBuild,
      },
    };
  };
  const checkpoint = join(home, "model.nemo");
  await writeFile(checkpoint, "controlled checkpoint");
  const observed = await alignmentObserver(native, workspace)(
    {
      selected,
      engine: alignmentSource.engine,
      decoder: alignmentSource.decoder,
      runtime: {
        python: "/usr/bin/python3",
        entry: fileURLToPath(new URL("../../../helpers/alignment/worker.py", import.meta.url)),
        model: home,
        cache: home,
        descriptorDigest: alignmentSource.engine.descriptorDigest,
        modelDigest: alignmentSource.engine.modelDigest,
        runtimeDigest: alignmentSource.engine.runtimeDigest,
        runtimeRevision: "controlled",
        modelRevision: "controlled",
      },
      checkpoint,
    },
    new AbortController().signal,
  );
  // The controlled checkpoint is not the pinned model; every request field was accepted first.
  expect(observed.failure).toMatchObject({ code: "MODEL_HASH_MISMATCH" });
  expect(observed.pcm).toEqual({ sha256: hash(pcm), sampleRate: 16000, frameCount: frames });
});
