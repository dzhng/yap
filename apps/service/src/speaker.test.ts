import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { selectSpeakerSource } from "@yap/core/source-speakers";
import { nativeOutput, speakerSource } from "./speaker.fixture.js";
import { speakerObserver } from "./speaker.js";
import type { MediaWorker } from "./worker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** `worker` runs the real speaker worker instead of the controlled one, to check the request contract. */
async function fixture(failure = false, worker?: string) {
  const home = await mkdtemp("/tmp/speaker-observer-");
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
  }));
  const selected = selectSpeakerSource(assets, acquisitions, {
    assetId: asset.id,
    streamId: "audio",
    channel: 1,
    sourceRange: speakerSource.observationRange,
    modelId: speakerSource.engine.modelId,
  });
  const workspace = join(home, "render");
  await mkdir(workspace, { mode: 0o700 });
  const entry = worker ?? join(home, "controlled-worker.py"),
    checkpoint = join(home, "model.nemo");
  await writeFile(checkpoint, "controlled checkpoint");
  const raw = nativeOutput();
  if (!worker)
    await writeFile(
      entry,
      `import json,sys,pathlib\nr=json.loads(sys.stdin.readline())\np=r['params']\nraw=${JSON.stringify(raw.nativeReceipt)}\nreport=json.loads(${JSON.stringify(raw.report)})\nreport['pcmSha256']=p['pcmSha256']\nout=pathlib.Path(p['output'])\npathlib.Path(str(out)+'.native-unverified.json').write_text(raw)\n${failure ? "print(json.dumps({'ok':False,'error':{'code':'MODEL_CONTRACT_CHANGED','message':'Controlled native refusal','details':{'rawFile':str(out)+'.native-unverified.json','verified':False},'retryable':False}}))" : "out.write_text(json.dumps(report))\nprint(json.dumps({'ok':True,'data':report}))"}\n`,
    );
  const pcm = Buffer.alloc(480000 * 4);
  for (let frame = 0; frame < 480000; frame++) pcm.writeFloatLE(0.25, frame * 4);
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
        frames: 480000,
        channels: 1,
        channel: 1,
        sourceChannels: 2,
        sourceSampleRate: 16000,
        range: selected.sourceRange,
        sourceOffsetUs: selected.track.sourceOffsetUs,
        recipe: speakerSource.decoder.recipe,
        representation: "float32-le",
        providerVersion: speakerSource.decoder.osBuild,
      },
    };
  };
  const runtime = {
    python: "/usr/bin/python3",
    entry,
    model: home,
    cache: home,
    descriptorDigest: speakerSource.engine.descriptorDigest,
    modelDigest: speakerSource.engine.modelDigest,
    runtimeDigest: speakerSource.engine.runtimeDigest,
    runtimeRevision: "controlled",
    modelRevision: "controlled",
  };
  return {
    home,
    workspace,
    request: {
      selected,
      engine: speakerSource.engine,
      decoder: speakerSource.decoder,
      runtime,
      checkpoint,
    },
    observer: speakerObserver(native, workspace),
    pcmSha256: hash(pcm),
    raw,
  };
}

test("the real speaker worker admits the observer's request and stops only at the model", async () => {
  const f = await fixture(
    false,
    fileURLToPath(new URL("../../../helpers/speaker/worker.py", import.meta.url)),
  );
  const observed = await f.observer(f.request, new AbortController().signal);
  // The controlled checkpoint is not the pinned model; every request field was accepted first.
  expect(observed.failure).toMatchObject({ code: "MODEL_NOT_PREPARED" });
});

test("the offline source observer returns original operands before its render attempt retires", async () => {
  const f = await fixture();
  const observed = await f.observer(f.request, new AbortController().signal);
  await writeFile(
    join(f.home, "observer-operands.json"),
    JSON.stringify({ original: f.raw, observed }),
  );
  expect(observed.pcm).toEqual({ sha256: f.pcmSha256, sampleRate: 16000, frameCount: 480000 });
  expect(observed.operands.nativeReceipt).toBe(f.raw.nativeReceipt);
  expect(JSON.parse(observed.operands.report)).toEqual({
    ...JSON.parse(f.raw.report),
    pcmSha256: f.pcmSha256,
  });
  expect(observed.failure).toBeUndefined();
  expect(await readdir(f.workspace)).toEqual([]);
});

test("original native refusal operands survive cleanup without claiming a completed report", async () => {
  const f = await fixture(true);
  const observed = await f.observer(f.request, new AbortController().signal);
  await writeFile(
    join(f.home, "refusal-operands.json"),
    JSON.stringify({
      original: f.raw,
      observed: {
        ...observed,
        failure: observed.failure && {
          code: observed.failure.code,
          details: observed.failure.details,
        },
      },
    }),
  );
  expect(observed.operands).toEqual({ nativeReceipt: f.raw.nativeReceipt, report: "" });
  expect(observed.failure).toMatchObject({
    code: "MODEL_CONTRACT_CHANGED",
    message: "Controlled native refusal",
    retryable: false,
  });
  expect(await readdir(f.workspace)).toEqual([]);
});
