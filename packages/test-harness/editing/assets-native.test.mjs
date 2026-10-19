import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, copyFile, rename, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Catalog } from "../../core/dist/catalog.js";
import { AssetStore } from "../../core/dist/assets.js";
import { selectSourceMetadata } from "../../core/dist/source-selection.js";
import { ceil, fromTime } from "../../composition/dist/index.js";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";

const corpus = new URL("../../../specs/done/agent-editing/assets/00-corpus/", import.meta.url);
const worker = mediaWorker();
const probe = async (path, signal) =>
  nativeResult(await worker("media.probe", { path }, { signal }));
async function sourceFrame(asset, streamId, path, output, maxLongEdge) {
  const { track } = selectSourceMetadata(asset, path, undefined, { assetId: asset.id, streamId });
  return nativeResult(
    await worker("media.sourceFrame", {
      asset: { assetId: asset.id, streamId, path, originUs: asset.originUs },
      available: track.available,
      atUs: ceil(fromTime(track.available[0].startUs)),
      output,
      ...(maxLongEdge === undefined ? {} : { maxLongEdge }),
    }),
  );
}
function encode(args) {
  const result = spawnSync(
    process.env.FFMPEG ?? "ffmpeg",
    ["-v", "error", "-nostdin", "-y", ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "yap-asset-native-"));
  const catalog = new Catalog(join(directory, "catalog.sqlite"));
  const assets = new AssetStore(catalog, directory);
  await assets.recover();
  t.after(async () => {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, assets };
}
test("owned imports decode after rename and preserve VFR and orientation", async (t) => {
  const { directory, assets } = await fixture(t);
  for (const name of ["a.mov", "orientation.mov", "timestamp-gap.mov"]) {
    const external = join(directory, name);
    await copyFile(new URL(name, corpus), external);
    const asset = await assets.import(external, { kind: "import" }, probe);
    await rename(external, join(directory, "renamed-" + name));
    const stream = asset.streams.find((s) => s.kind === "video");
    const output = join(directory, name + ".png");
    const decoded = await sourceFrame(asset, stream.id, assets.path(asset.id), output, 1024);
    assert.equal(decoded.width, name === "orientation.mov" ? 96 : 160);
    assert.equal(decoded.height, name === "orientation.mov" ? 160 : 96);
    if (name === "timestamp-gap.mov") {
      assert.equal(stream.samples.minDurationUs, 250_000);
      assert.equal(stream.samples.maxDurationUs, 750_000);
      assert.equal(stream.samples.count, 6);
    }
    const reference = join(directory, name + ".reference.png");
    await sourceFrame(asset, stream.id, join(directory, "renamed-" + name), reference, 1024);
    assert.deepEqual(await readFile(output), await readFile(reference));
    if (name === "orientation.mov") {
      const pixels = spawnSync(
        process.env.FFMPEG ?? "ffmpeg",
        ["-v", "error", "-i", output, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
        { timeout: 30_000 },
      );
      assert.equal(pixels.status, 0, pixels.stderr.toString());
      const rgb = (x, y) => [...pixels.stdout.subarray((y * 96 + x) * 3, (y * 96 + x) * 3 + 3)];
      const red = rgb(4, 155),
        green = rgb(90, 4);
      // Orientation landmarks tolerate native color conversion; exact color belongs to render gates.
      assert.ok(red[0] > 200 && red[1] < 80 && red[2] < 80, `bottom-left red: ${red}`);
      assert.ok(green[1] > 200 && green[0] < 80 && green[2] < 140, `top-right green: ${green}`);
    }
    if (name === "orientation.mov" && process.env.ASSET_EVIDENCE_DIR) {
      await mkdir(process.env.ASSET_EVIDENCE_DIR, { recursive: true });
      await copyFile(output, join(process.env.ASSET_EVIDENCE_DIR, "owned-orientation.png"));
      await copyFile(reference, join(process.env.ASSET_EVIDENCE_DIR, "source-orientation.png"));
    }
  }
});
test("baseline audio formats admit owned bytes and actually decode PCM", async (t) => {
  const { directory, assets } = await fixture(t);
  for (const [extension, codec] of [
    ["wav", "pcm_s16le"],
    ["aiff", "pcm_s16be"],
    ["m4a", "aac"],
    ["mp3", "libmp3lame"],
  ]) {
    const external = join(directory, "audio." + extension);
    encode(["-i", new URL("a-audio.wav", corpus).pathname, "-c:a", codec, external]);
    const asset = await assets.import(external, { kind: "import" }, probe);
    await rm(external);
    const stream = asset.streams.find((s) => s.kind === "audio");
    assert.equal(stream.channels, 1);
    assert.equal(stream.sampleRate, 48000);
    const range = {
      startUs: stream.startUs,
      endUs: Math.min(stream.endUs, stream.startUs + 500_000),
    };
    const { track } = selectSourceMetadata(asset, assets.path(asset.id), undefined, {
      assetId: asset.id,
      streamId: stream.id,
    });
    const audio = nativeResult(
      await worker("media.sourceAudio", {
        source: track,
        range,
        output: join(directory, extension + ".wav"),
      }),
    );
    assert.equal(audio.frames, 24000);
    assert.equal(audio.sampleRate, 48000);
    assert.ok((await readFile(audio.file)).length > 48000);
  }
});
test("PNG, JPEG, H264 MP4 and HEVC MP4 admit without replacing original bytes", async (t) => {
  const { directory, assets } = await fixture(t);
  const png = join(directory, "still.png");
  await copyFile(new URL("still-alpha.png", corpus), png);
  const jpeg = join(directory, "still.jpg");
  encode(["-i", png, "-frames:v", "1", jpeg]);
  const mp4 = join(directory, "h264.mp4");
  encode(["-i", new URL("a.mov", corpus).pathname, "-c", "copy", mp4]);
  const hevc = join(directory, "hevc.mp4");
  encode([
    "-i",
    new URL("a.mov", corpus).pathname,
    "-an",
    "-c:v",
    "hevc_videotoolbox",
    "-tag:v",
    "hvc1",
    hevc,
  ]);
  for (const external of [png, jpeg, mp4, hevc]) {
    const before = await readFile(external);
    const asset = await assets.import(external, { kind: "import" }, probe);
    await rm(external);
    assert.deepEqual(await readFile(assets.path(asset.id)), before);
    assert.equal(asset.streams[0].decodable, true);
    if (asset.streams[0].kind === "video") {
      await sourceFrame(
        asset,
        asset.streams[0].id,
        assets.path(asset.id),
        join(directory, asset.id + ".png"),
      );
    }
  }
});

test("an actual unsupported FFV1 stream is reported and never published", async (t) => {
  const { directory, assets } = await fixture(t);
  const external = join(directory, "unsupported.avi");
  encode(["-i", new URL("a.mov", corpus).pathname, "-an", "-c:v", "ffv1", external]);
  await assert.rejects(assets.import(external, { kind: "import" }, probe), (error) => {
    assert.equal(error.code, "UNSUPPORTED_MEDIA");
    assert.equal(error.details.streams[0].codec, "FFV1");
    assert.equal(error.details.streams[0].decodable, false);
    assert.deepEqual(Object.keys(error.details.streams[0]).sort(), [
      "codec",
      "decodable",
      "id",
      "kind",
    ]);
    return true;
  });
  assert.deepEqual(assets.list().assets, []);
  assert.ok((await readFile(external)).length > 0);
});
