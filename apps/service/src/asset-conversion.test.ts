import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { JobQueue } from "@yap/core/jobs";
import { AssetConversionJobs } from "./asset-conversion.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await realpath(await mkdtemp("/tmp/yap-conversion-jobs-"));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const path = join(home, "source.mov");
  await writeFile(path, "controlled immutable conversion source");
  const asset = await assets.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "video",
        codec: "hvc1",
        decodable: true,
        startUs: 0,
        endUs: 125000,
        segments: [{ startUs: 0, endUs: 125000, empty: false }],
        hasAlpha: false,
        width: 320,
        height: 192,
      },
      {
        id: "track:2",
        kind: "audio",
        codec: "aac ",
        decodable: true,
        startUs: 0,
        endUs: 125000,
        segments: [{ startUs: 0, endUs: 125000, empty: false }],
        sampleRate: 48000,
        channels: 2,
      },
    ],
  }));
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw Error("asset required");
        assets.get(target.id);
        return target;
      },
      isAvailable: (target) => target.kind === "asset" && assets.has(target.id),
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: async ({ signal }) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  });
  cleanup.push(async () => {
    try {
      await jobs.close();
    } finally {
      catalog.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  return { assets, jobs, asset, home };
}

test("conversion admission canonicalizes explicit selection and retains the immutable source for one replayed job", async () => {
  const f = await fixture();
  const runtime = {
    implementationId: "controlled-hdr-runtime",
    receiptSha256: "a".repeat(64),
    nativeExecutableSha256: "b".repeat(64),
    ffmpegSha256: "c".repeat(64),
    ffprobeSha256: "d".repeat(64),
    ffmpeg: "/controlled/ffmpeg",
    ffprobe: "/controlled/ffprobe",
    ownerExecutable: "/controlled/native",
  };
  const owner = new AssetConversionJobs({
    assets: f.assets,
    jobs: f.jobs,
    runtime: async () => runtime,
    worker: async () => {
      throw Error("execution not requested");
    },
    staging: "/controlled/staging",
  });
  const request = {
    assetId: f.asset.id,
    streamIds: ["track:2", "track:1"],
    recipe: "hdr-to-sdr-hable-1000nit-v1" as const,
  };
  const first = await owner.request(request);
  const replay = await owner.request({ ...request, streamIds: ["track:1", "track:2"] });
  expect(first.jobId).toBeTruthy();
  expect(replay.jobId).toBe(first.jobId);
  expect(f.assets.references(f.asset.id)).toContainEqual({ kind: "job-input", id: first.jobId });
  expect(f.jobs.job(first.jobId!).target).toEqual({ kind: "asset", id: f.asset.id });
  const unavailable = new AssetConversionJobs({
    assets: f.assets,
    jobs: f.jobs,
    runtime: async () => undefined,
    worker: async () => {
      throw Error("unavailable runtime must not execute media");
    },
    staging: "/controlled/staging",
  });
  expect((await unavailable.request(request)).jobId).toBe(first.jobId);
  await expect(
    unavailable.execute({ job: f.jobs.job(first.jobId!), signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
  const relocated = new AssetConversionJobs({
    assets: f.assets,
    jobs: f.jobs,
    runtime: async () => ({
      ...runtime,
      ffmpeg: "/relocated/ffmpeg",
      ffprobe: "/relocated/ffprobe",
      ownerExecutable: "/relocated/native",
    }),
    worker: async () => {
      throw Error("relocated verified execution reached");
    },
    staging: f.home,
  });
  expect((await relocated.request(request)).jobId).toBe(first.jobId);
  await expect(
    relocated.execute({ job: f.jobs.job(first.jobId!), signal: new AbortController().signal }),
  ).rejects.toThrow("relocated verified execution reached");
  expect(f.assets.list().assets.map((item) => item.id)).toEqual([f.asset.id]);
});
