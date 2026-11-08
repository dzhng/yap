import { beforeAll, afterAll, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { fstatSync, writeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { compileCliOwner } from "./cli-owner.fixture.js";
import type { MediaWorker } from "./worker.js";
import { withHdrDerivative } from "./hdr-conversion.js";

let directory: string, parent: string, owner: string, ffprobe: string, ffmpeg: string;
const media = Buffer.from("immutable source bytes");
const sha256 = createHash("sha256").update(media).digest("hex");
beforeAll(async () => {
  directory = await mkdtemp("/tmp/yap-hdr-held-");
  parent = join(directory, "attempts");
  await mkdir(parent, { mode: 0o700 });
  owner = await compileCliOwner(directory);
  ffprobe = join(directory, "ffprobe.cjs");
  ffmpeg = join(directory, "ffmpeg.cjs");
  await writeFile(
    ffprobe,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({streams:[{index:0,id:"0x1",codec_type:"video",color_primaries:"bt2020",color_transfer:"smpte2084",color_space:"bt2020nc",color_range:"tv",pix_fmt:"yuv420p10le"},{index:1,id:"0x2",codec_type:"audio"}]}));',
  );
  await writeFile(
    ffmpeg,
    '#!/usr/bin/env node\nconst fs=require("node:fs");const input=fs.readFileSync(3);if(input.toString()!=="immutable source bytes")process.exit(2);fs.writeSync(Number(process.argv.at(-2)),"converted derivative bytes");',
  );
  await chmod(ffprobe, 0o700);
  await chmod(ffmpeg, 0o700);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function metadata(output: boolean) {
  return {
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "video",
        codec: output ? "ap4h" : "hvc1",
        decodable: true,
        startUs: 0,
        endUs: 125000,
        width: 320,
        height: 192,
        orientedWidth: 320,
        orientedHeight: 192,
        transform: [1, 0, 0, 1, 0, 0],
        hasAlpha: false,
        segments: [
          { startUs: 0, endUs: 125000, empty: false, mediaStartUs: 0, mediaDurationUs: 125000 },
        ],
        colorFormats: [
          {
            colorPrimaries: output ? "ITU_R_709_2" : "ITU_R_2020",
            transferFunction: output ? "ITU_R_709_2" : "SMPTE_ST_2084_PQ",
            ycbcrMatrix: output ? "ITU_R_709_2" : "ITU_R_2020",
            fullRange: null,
            bitsPerComponent: output ? 12 : 10,
            interpretationExtensions: [],
            invalidColorDeclarations: [],
          },
        ],
        codecAtomNames: output ? [[]] : [["hvcC"]],
        samples: {
          count: 3,
          firstPtsUs: 0,
          lastPtsUs: 83333,
          minDurationUs: 41667,
          maxDurationUs: 41667,
          firstTimeUs: 0,
          lastTimeUs: { numerator: 250000, denominator: 3 },
          lastDurationUs: { numerator: 125000, denominator: 3 },
          presentedTimingSha256: "a".repeat(64),
        },
        ...(output
          ? {}
          : {
              compressedVideoInspection: {
                status: "complete",
                packetCount: 3,
                nalTypes: [1, 20],
                configurationNalTypes: [32, 33, 34],
                seiPayloadTypes: [],
                refusals: [],
              },
            }),
      },
    ],
  };
}
const worker: MediaWorker = async (operation, params, options) => {
  if (operation === "storage.clearRenderWorkspace") {
    const held = fstatSync(options!.descriptors![0]!, { bigint: true });
    expect(params.expectedDirectory).toEqual({ dev: String(held.dev), ino: String(held.ino) });
    for (const name of await readdir(parent)) await rm(join(parent, name), { recursive: true });
    return { ok: true, data: { removed: true } };
  }
  expect(operation).toBe("media.probe");
  const bytes = Buffer.from(JSON.stringify(metadata(params.inspectCompressedVideo !== true)));
  const slot = Number(String(params.output).split("/").at(-1));
  writeSync(options!.descriptors![slot - 3]!, bytes, 0, bytes.length, 0);
  return {
    ok: true,
    data: {
      file: params.output,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
};
test("held source identity and fresh clocks admit the derivative only inside the existing attempt", async () => {
  const path = join(directory, "source.mov");
  await writeFile(path, media);
  const file = await open(path, "r");
  try {
    const result = await withHdrDerivative(
      worker,
      {
        attemptParent: parent,
        source: { file, bytes: media.length, sha256 },
        streamId: "track:1",
        ffmpeg,
        ffprobe,
        ownerExecutable: owner,
      },
      new AbortController().signal,
      async (artifact) => {
        expect(await file.stat()).toMatchObject({ size: media.length });
        expect(artifact.evidence.output.video.codec).toBe("ap4h");
        return artifact.sha256;
      },
    );
    expect(result).toBe(createHash("sha256").update("converted derivative bytes").digest("hex"));
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await file.close();
  }
});

test("explicit selected audio survives the held producer and actual decoded-PCM validation", async () => {
  const path = join(directory, "audio-source.mov");
  await writeFile(path, media);
  const file = await open(path, "r");
  const audioWorker: MediaWorker = async (operation, params, options) => {
    if (operation !== "media.probe") return worker(operation, params, options);
    const raw = metadata(params.inspectCompressedVideo !== true);
    const audio = {
      id: "track:2",
      kind: "audio",
      codec: "aac ",
      decodable: true,
      startUs: 0,
      endUs: 125000,
      sampleRate: 48000,
      channels: 2,
      channelLayoutTag: 6619138,
      segments: [
        {
          startUs: 0,
          endUs: 125000,
          empty: false,
          mediaStartUs: { numerator: 64000, denominator: 3 },
          mediaDurationUs: 125000,
        },
      ],
      decodedAudioInspection: {
        sampleRate: 48000,
        channels: 2,
        frames: 6000,
        runs: [{ startUs: 0, endUs: 125000, frames: 6000 }],
        pcmSha256: "c".repeat(64),
        trimming: "decoder-output-attachment-free",
      },
    };
    const bytes = Buffer.from(JSON.stringify({ ...raw, streams: [...raw.streams, audio] }));
    const slot = Number(String(params.output).split("/").at(-1));
    writeSync(options!.descriptors![slot - 3]!, bytes, 0, bytes.length, 0);
    return {
      ok: true,
      data: {
        file: params.output,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };
  try {
    const result = await withHdrDerivative(
      audioWorker,
      {
        attemptParent: parent,
        source: { file, bytes: media.length, sha256 },
        streamId: "track:1",
        audioStreamId: "track:2",
        ffmpeg,
        ffprobe,
        ownerExecutable: owner,
      },
      new AbortController().signal,
      async (artifact) => artifact.evidence.outputAudio!.audio.decodedAudioInspection,
    );
    expect(result).toMatchObject({
      frames: 6000,
      pcmSha256: "c".repeat(64),
      runs: [{ startUs: 0, endUs: 125000, frames: 6000 }],
    });
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await file.close();
  }
});

test("changed immutable bytes and preparation failures never consume or leak an attempt", async () => {
  const path = join(directory, "rejected.mov");
  await writeFile(path, media);
  const file = await open(path, "r");
  let consumed = false;
  const request = {
    attemptParent: parent,
    source: { file, bytes: media.length, sha256 },
    streamId: "track:1",
    ffmpeg,
    ffprobe,
    ownerExecutable: owner,
  };
  try {
    await expect(
      withHdrDerivative(
        worker,
        { ...request, source: { ...request.source, sha256: "0".repeat(64) } },
        new AbortController().signal,
        async () => {
          consumed = true;
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const failing: MediaWorker = async (operation, params, options) =>
      operation === "media.probe"
        ? {
            ok: false,
            error: {
              code: "UNSUPPORTED_MEDIA",
              message: "unreadable fresh source",
              retryable: true,
              details: {},
            },
          }
        : worker(operation, params, options);
    await expect(
      withHdrDerivative(failing, request, new AbortController().signal, async () => {
        consumed = true;
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    expect(consumed).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await file.close();
  }
});

test("source mutation during derivative inspection refuses before consumption", async () => {
  const path = join(directory, "mutated.mov");
  await writeFile(path, media);
  const file = await open(path, "r");
  let consumed = false;
  const mutating: MediaWorker = async (operation, params, options) => {
    if (operation === "media.probe" && !params.inspectCompressedVideo)
      await writeFile(path, Buffer.alloc(media.length));
    return worker(operation, params, options);
  };
  try {
    await expect(
      withHdrDerivative(
        mutating,
        {
          attemptParent: parent,
          source: { file, bytes: media.length, sha256 },
          streamId: "track:1",
          ffmpeg,
          ffprobe,
          ownerExecutable: owner,
        },
        new AbortController().signal,
        async () => {
          consumed = true;
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(consumed).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await file.close();
  }
});

test("canceling held FFprobe preparation drains its child before attempt cleanup", async () => {
  const path = join(directory, "canceled.mov"),
    ready = join(directory, "ready"),
    slow = join(directory, "slow-probe.cjs");
  await writeFile(path, media);
  await writeFile(
    slow,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' +
      JSON.stringify(ready) +
      ",String(process.pid));setInterval(()=>{},1000);",
  );
  await chmod(slow, 0o700);
  const file = await open(path, "r"),
    controller = new AbortController();
  let consumed = false,
    pid: number | undefined;
  const pending = withHdrDerivative(
    worker,
    {
      attemptParent: parent,
      source: { file, bytes: media.length, sha256 },
      streamId: "track:1",
      ffmpeg,
      ffprobe: slow,
      ownerExecutable: owner,
    },
    controller.signal,
    async () => {
      consumed = true;
    },
  ).then(
    () => undefined,
    (error) => error,
  );
  try {
    for (let n = 0; n < 200; n++) {
      try {
        pid = Number(await readFile(ready, "utf8"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(await pending).toMatchObject({ code: "CANCELED" });
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(consumed).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  } finally {
    controller.abort();
    await pending;
    await file.close();
  }
});
