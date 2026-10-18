import { omit } from "@yap/composition";
import { mkdtemp, writeFile, rename, readFile, rm, open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { AssetStore, compositionAsset } from "./assets.js";
import { pageCursor } from "./page-cursor.js";
import { expectPageTraversal } from "./page-traversal.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "assets-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const catalog = new Catalog(join(root, "catalog.sqlite"));
  cleanups.push(async () => catalog.close());
  const store = new AssetStore(catalog, root);
  await store.recover();
  const admit = async (requestId: string, path: string) => {
    const prepared = await store.prepareImport(requestId, path);
    return catalog.transaction(() => store.admitImport(prepared));
  };
  return { root, catalog, store, admit };
}
const probe = async () => ({
  originUs: 0,
  streams: [
    {
      id: "image:0",
      kind: "image",
      codec: "public.png",
      decodable: true,
      width: 2,
      height: 1,
      orientedWidth: 2,
      orientedHeight: 1,
      orientation: 1,
    },
  ],
});
test("generated assets stay unpublished until their owner's transaction commits", async () => {
  const { root, catalog, store } = await setup();
  const output = join(root, "generated.png");
  await writeFile(output, "generated pixels");
  const staged = await store.stage(output, { kind: "generated", source: "test" }, probe);
  try {
    expect(store.list().assets).toEqual([]);
    expect(() =>
      catalog.transaction(() => {
        staged.publish();
        throw new Error("stale attempt");
      }),
    ).toThrow("stale attempt");
    expect(store.list().assets).toEqual([]);
    const ready = catalog.transaction(() => staged.publish());
    expect(await readFile(store.path(ready.id), "utf8")).toBe("generated pixels");
    expect(store.origins(ready.id).origins).toEqual([{ kind: "generated", source: "test" }]);
  } finally {
    await staged.close();
  }
});

test("portable HDR derivative admission retains its exact conversion clock and original dependency", async () => {
  const { root, catalog, store } = await setup();
  const originalPath = join(root, "original.mov");
  const outputPath = join(root, "derivative.mov");
  await writeFile(originalPath, "immutable original HDR bytes");
  await writeFile(outputPath, "immutable converted SDR bytes");
  const videoProbe =
    (startUs: number, endUs: number, originUs: number, codec: string) => async () => ({
      originUs,
      streams: [
        {
          id: "track:1",
          kind: "video",
          codec,
          decodable: true,
          startUs,
          endUs,
          hasAlpha: false,
          width: 320,
          height: 192,
          samples: {
            count: 3,
            firstPtsUs: startUs,
            lastPtsUs: endUs - 41667,
            minDurationUs: 41667,
            maxDurationUs: 41667,
          },
          segments: [
            { startUs, endUs, empty: false, mediaStartUs: 0, mediaDurationUs: endUs - startUs },
          ],
        },
      ],
    });
  const original = await store.import(
    originalPath,
    { kind: "import" },
    videoProbe(5000, 130000, 0, "hvc1"),
  );
  const derivative = await store.import(
    outputPath,
    { kind: "generated" },
    videoProbe(0, 125000, 5000, "ap4h"),
  );
  const digest = "a".repeat(64);
  const origin = {
    kind: "hdr-conversion",
    recipe: "hdr-to-sdr-hable-1000nit-v1",
    family: "pq",
    implementation: {
      implementationId: "controlled-hdr-v1",
      receiptSha256: digest,
      nativeExecutableSha256: digest,
      ffmpegSha256: digest,
      ffprobeSha256: digest,
    },
    source: {
      assetId: original.id,
      originUs: 0,
      factsSha256: digest,
      video: {
        streamId: "track:1",
        startUs: 5000,
        endUs: 130000,
        mediaStartUs: 0,
        mediaDurationUs: 125000,
        samples: 3,
        presentedTimingSha256: digest,
      },
    },
    output: {
      originUs: 5000,
      factsSha256: digest,
      video: {
        streamId: "track:1",
        startUs: 0,
        endUs: 125000,
        mediaStartUs: 0,
        mediaDurationUs: 125000,
        samples: 3,
        presentedTimingSha256: digest,
      },
    },
    clock: {
      sourceClockAtDerivativeZeroUs: 5000,
      movieTimescale: 48000,
      sourceSupport: { startUs: 5000, endUs: 130000 },
    },
  };
  const staged = await store.stagePortable(
    { asset: derivative, origins: [origin], dependencies: [{ kind: "asset", id: original.id }] },
    outputPath,
    new AbortController().signal,
  );
  try {
    catalog.transaction(() => staged.publish());
    const portable = store.portable(derivative.id);
    expect(portable.origins).toContainEqual(origin);
    expect(portable.dependencies).toEqual([{ kind: "asset", id: original.id }]);
    expect(store.references(original.id)).toContainEqual({ kind: "asset", id: derivative.id });
  } finally {
    await staged.close();
  }
  await expect(
    store
      .stagePortable(
        { asset: derivative, origins: [origin], dependencies: [] },
        outputPath,
        new AbortController().signal,
      )
      .then(async (candidate) => {
        await candidate.close();
        return "admitted";
      }),
  ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  const malformed = {
    ...structuredClone(origin),
    source: {
      ...origin.source,
      audio: {
        ...origin.source.video,
        streamId: "track:2",
        frames: 6000,
        sampleRate: 0,
        channels: 2,
        pcmSha256: digest,
      },
    },
    output: {
      ...origin.output,
      audio: {
        ...origin.output.video,
        streamId: "track:2",
        frames: 6000,
        sampleRate: 0,
        channels: 2,
        pcmSha256: digest,
      },
    },
  };
  await expect(
    store.stagePortable(
      {
        asset: derivative,
        origins: [malformed],
        dependencies: [{ kind: "asset", id: original.id }],
      },
      outputPath,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  const changed = structuredClone(origin);
  changed.output.video.streamId = "track:9";
  await expect(
    store
      .stagePortable(
        {
          asset: derivative,
          origins: [changed],
          dependencies: [{ kind: "asset", id: original.id }],
        },
        outputPath,
        new AbortController().signal,
      )
      .then(async (candidate) => {
        await candidate.close();
        return "admitted";
      }),
  ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
});
test("concurrent large identical imports survive staging-link cleanup", async () => {
  const { root, store } = await setup();
  const source = join(root, "large.png");
  const bytes = Buffer.alloc(32 * 1024 * 1024, 19);
  await writeFile(source, bytes);
  const [first, second] = await Promise.all([
    store.import(source, { kind: "import", source: "first" }, probe),
    store.import(source, { kind: "import", source: "second" }, probe),
  ]);
  expect(second).toEqual(first);
  expect((await readFile(store.path(first.id))).equals(bytes)).toBe(true);
  expect(store.origins(first.id).origins).toEqual([
    { kind: "import", source: "first" },
    { kind: "import", source: "second" },
  ]);
});
test("admission retains immutable bytes after an external rename and deduplicates", async () => {
  const { root, store } = await setup();
  const external = join(root, "external.png");
  await writeFile(external, "original pixels");
  const first = await store.import(external, { kind: "import" }, probe);
  await rename(external, external + ".moved");
  expect(await readFile(store.path(first.id), "utf8")).toBe("original pixels");
  const second = await store.import(external + ".moved", { kind: "import" }, probe);
  expect(second).toEqual(first);
  expect(store.list().assets.map((asset) => asset.id)).toEqual([first.id]);
});

test.each(["png", "other"])(
  "concurrent imports with %s extension preserve identity and provenance",
  async (extension) => {
    const { root, store } = await setup();
    const external = join(root, "same.png");
    await writeFile(external, "same pixels");
    const alternate = join(root, `same.${extension}`);
    await writeFile(alternate, "same pixels");
    const [a, b] = await Promise.all([
      store.import(external, { kind: "import" }, probe),
      store.import(alternate, { kind: "capture", source: "take-one" }, probe),
    ]);
    expect(a).toEqual(b);
    expect(store.list().assets.map((asset) => asset.id)).toEqual([a.id]);
    expect(store.origins(a.id).origins).toEqual([
      { kind: "capture", source: "take-one" },
      { kind: "import" },
    ]);
  },
);

test("canceled and unsupported imports never publish assets, and startup removes unfinished bytes", async () => {
  const { root, store } = await setup();
  const external = join(root, "external.png");
  await writeFile(external, "some pixels");
  const controller = new AbortController();
  await expect(
    store.import(
      external,
      { kind: "import" },
      async () => {
        controller.abort();
        return probe();
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  await expect(
    store.import(external, { kind: "import" }, async () => ({
      originUs: 0,
      streams: [{ id: "data", kind: "unsupported", codec: "x", decodable: false }],
    })),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(store.list().assets).toEqual([]);
  const abandoned = join(root, "staging", "assets", "abandoned");
  const orphan = join(root, "assets", "unpublished");
  await writeFile(abandoned, "unfinished");
  await writeFile(orphan, "finished but no catalog commit");
  await store.recover();
  await expect(readFile(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  const asset = await store.import(external, { kind: "import" }, probe);
  await store.recover();
  expect(await readFile(store.path(asset.id), "utf8")).toBe("some pixels");
});

test("receiving project and retained revision references survive donor release and roll back atomically", async () => {
  const { root, store, catalog } = await setup();
  const external = join(root, "external.png");
  await writeFile(external, "reference pixels");
  const asset = await store.import(external, { kind: "import" }, probe);
  const donor = { kind: "project" as const, id: "donor" };
  const recipient = { kind: "project" as const, id: "recipient" };
  const revision = { kind: "revision" as const, id: "recipient:r0" };
  catalog.transaction(() => {
    store.retain(donor, [asset.id]);
    store.retain(recipient, [asset.id]);
    store.retain(revision, [asset.id]);
  });
  store.release(donor);
  expect(store.references(asset.id)).toEqual([recipient, revision]);
  expect(() =>
    catalog.transaction(() => {
      store.release(recipient);
      store.release(revision);
      throw new Error("abort batch");
    }),
  ).toThrow("abort batch");
  expect(store.references(asset.id)).toEqual([recipient, revision]);
  expect(await readFile(store.path(asset.id), "utf8")).toBe("reference pixels");
});

test("an import receipt replays the admitted snapshot after restart and external deletion", async () => {
  const { root, store, admit } = await setup();
  const external = join(root, "external.png");
  await writeFile(external, "snapshot pixels");
  const intent = await admit("request", external);
  expect(await admit("request", external)).toEqual(intent);
  await expect(store.prepareImport("request", external + ".other")).rejects.toThrowError(
    /another path/,
  );
  const asset = await store.executeImport(intent.importId, probe, new AbortController().signal);
  await rm(external);
  expect(
    await store.executeImport(
      intent.importId,
      async () => {
        throw new Error("must not reprobe");
      },
      new AbortController().signal,
    ),
  ).toEqual(asset);
  expect(store.intent(intent.importId).assetId).toBe(asset.id);
});

test("retry refuses changed source bytes instead of silently changing the frozen import", async () => {
  const { root, store, admit } = await setup();
  const path = join(root, "source.png");
  await writeFile(path, "first bytes");
  const intent = await admit("first", path);
  await writeFile(path, "replacement bytes");
  await expect(
    store.executeImport(intent.importId, probe, new AbortController().signal),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(store.list().assets).toEqual([]);
  const replacement = await admit("new-input", path);
  const asset = await store.executeImport(
    replacement.importId,
    probe,
    new AbortController().signal,
  );
  expect(await readFile(store.path(asset.id), "utf8")).toBe("replacement bytes");
});

test("failed publication rolls back the receipt and recovery removes the linked orphan", async () => {
  const { root, store } = await setup();
  const path = join(root, "source.wav");
  const timedProbe = async () => ({
    originUs: 0,
    streams: [
      {
        id: "audio:0",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 20,
        sampleRate: 48000,
        channels: 1,
        segments: [
          { startUs: 0, endUs: 10, empty: true },
          { startUs: 10, endUs: 20, empty: false, mediaStartUs: 0, mediaDurationUs: 10 },
        ],
      },
    ],
  });
  await writeFile(path, "transaction pixels");
  await expect(
    store.import(
      path,
      { kind: "generated", source: "generation" },
      timedProbe,
      new AbortController().signal,
      () => {
        throw new Error("crash before commit");
      },
    ),
  ).rejects.toThrow("crash before commit");
  expect(store.list().assets).toEqual([]);
  await store.recover();
  const asset = await store.import(path, { kind: "import" }, timedProbe);
  expect(await readFile(store.path(asset.id), "utf8")).toBe("transaction pixels");
  expect(store.get(asset.id).streams).toEqual((await timedProbe()).streams);
  expect(store.origins(asset.id).origins).toEqual([{ kind: "import" }]);
});

test("a source modified during streamed copying cannot become a ready asset", async () => {
  const { root, store } = await setup();
  const path = join(root, "changing.png");
  await writeFile(path, "original pixels");
  const source = await open(path, "r+");
  const before = await source.stat();
  const read = source.read;
  let mutated = false;
  // Hold the first real read's completion until a real same-size source write
  // finishes. This places mutation inside copying without scheduling a watcher.
  const reading = vi
    .spyOn(Object.getPrototypeOf(source), "read")
    .mockImplementationOnce(async function (this: FileHandle, ...args: unknown[]) {
      const result = await Reflect.apply(read, this, args);
      await source.write(Buffer.from("changed!"), 0, 8, 0);
      // Filesystem timestamp granularity must not decide whether the mutation is seen.
      await source.utimes(before.atime, new Date(before.mtimeMs + 1000));
      mutated = true;
      return result;
    });
  try {
    await expect(store.import(path, { kind: "import" }, probe)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    expect(mutated).toBe(true);
    expect(store.list().assets).toEqual([]);
  } finally {
    reading.mockRestore();
    await source.close();
  }
});

test("distinct frozen import paths deduplicate media while preserving both origins", async () => {
  const { root, store, admit } = await setup();
  const firstPath = join(root, "first.png"),
    secondPath = join(root, "second.png");
  await writeFile(firstPath, "shared pixels");
  await writeFile(secondPath, "shared pixels");
  const first = await admit("first", firstPath),
    second = await admit("second", secondPath);
  const a = await store.executeImport(first.importId, probe, new AbortController().signal);
  const b = await store.executeImport(second.importId, probe, new AbortController().signal);
  expect(b.id).toBe(a.id);
  expect(store.origins(a.id).origins).toEqual([
    { kind: "import", source: firstPath },
    { kind: "import", source: secondPath },
  ]);
});

test("additive native response fields do not prevent importing valid known media", async () => {
  const { root, store } = await setup();
  const path = join(root, "source.png");
  await writeFile(path, "future metadata");
  const asset = await store.import(path, { kind: "import" }, async () => {
    const metadata = await probe();
    return {
      ...metadata,
      id: "not-the-asset-identity",
      future: { information: true },
      streams: metadata.streams.map((stream) => ({ ...stream, futureTag: "additive" })),
    };
  });
  expect(asset.id).toMatch(/^[a-f0-9]{64}$/);
  expect(store.get(asset.id).streams).toEqual((await probe()).streams);
});

test("asset lists stay compact while get preserves large source timing metadata", async () => {
  const { root, store } = await setup();
  const path = join(root, "many-edits.mov");
  await writeFile(path, "timed media");
  const segments = Array.from({ length: 5000 }, (_, startUs) => ({
    startUs,
    endUs: startUs + 1,
    empty: false,
    mediaStartUs: startUs,
    mediaDurationUs: 1,
  }));
  const asset = await store.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      { id: "v", kind: "video", codec: "avc1", decodable: true, startUs: 0, endUs: 5000, segments },
    ],
  }));
  expect(store.get(asset.id).streams[0]!.segments).toEqual(segments);
  const page = store.list();
  expect(JSON.stringify(page).length).toBeLessThan(512);
  expect(page.assets).toEqual([
    {
      id: asset.id,
      bytes: asset.bytes,
      createdAt: asset.createdAt,
      fileName: asset.fileName,
      mediaKinds: ["video"],
      streamCount: 1,
      fontFaceCount: 0,
    },
  ]);
});

test("rejected admission rolls back the frozen intent with its caller transaction", async () => {
  const { root, catalog, store, admit } = await setup();
  const path = join(root, "source.png");
  await writeFile(path, "first candidate");
  const prepared = await store.prepareImport("capacity-refusal", path);
  let rejectedId = "";
  expect(() =>
    catalog.transaction(() => {
      rejectedId = store.admitImport(prepared).importId;
      throw new Error("job capacity refused");
    }),
  ).toThrow("job capacity refused");
  expect(() => store.intent(rejectedId)).toThrow("does not exist");
  await writeFile(path, "new candidate after failed admission");
  const accepted = await admit("capacity-refusal", path);
  const asset = await store.executeImport(accepted.importId, probe, new AbortController().signal);
  expect(await readFile(store.path(asset.id), "utf8")).toBe("new candidate after failed admission");
});

test("font assets retain face identities without advertising playable streams", async () => {
  const { root, store } = await setup();
  const path = join(root, "faces.ttc");
  await writeFile(path, "immutable collection bytes");
  const fontFaces = [
    { postScriptName: "Example-Regular", familyName: "Example", styleName: "Regular" },
    { postScriptName: "Example-Bold", familyName: "Example", styleName: "Bold" },
  ];
  const asset = await store.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    fontFaces,
  }));
  expect(store.get(asset.id).fontFaces).toEqual(fontFaces);
  expect(store.list().assets).toEqual([
    {
      id: asset.id,
      bytes: asset.bytes,
      createdAt: asset.createdAt,
      fileName: asset.fileName,
      streamCount: 0,
      mediaKinds: [],
      fontFaceCount: 2,
    },
  ]);
  expect(store.portable(asset.id).asset.fontFaces).toEqual(fontFaces);
  expect(compositionAsset(asset)).toEqual({
    id: asset.id,
    streams: [],
    fontFaces: fontFaces.map((face) => face.postScriptName),
  });
  const recipient = await setup();
  const staged = await recipient.store.stagePortable(
    store.portable(asset.id),
    store.path(asset.id),
    new AbortController().signal,
  );
  recipient.catalog.transaction(() => staged.publish());
  await staged.close();
  expect(recipient.store.get(asset.id)).toEqual(asset);
  const invalidPortable = store.portable(asset.id);
  invalidPortable.asset.fontFaces = [fontFaces[0]!, fontFaces[0]!];
  await expect(
    recipient.store.stagePortable(
      invalidPortable,
      store.path(asset.id),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  expect(await readFile(recipient.store.path(asset.id))).toEqual(
    await readFile(store.path(asset.id)),
  );
  await rename(path, path + ".renamed");
  expect(
    await store.import(path + ".renamed", { kind: "import" }, async () => {
      throw Error("Must reuse immutable identity");
    }),
  ).toEqual(asset);
});

test("font metadata rejects ambiguous identities and cannot smuggle timed streams", async () => {
  const { root, store } = await setup();
  const path = join(root, "invalid-font.ttf");
  await writeFile(path, "invalid font metadata");
  const face = { postScriptName: "Repeated", familyName: "Example" };
  for (const metadata of [
    { originUs: 0, streams: [], fontFaces: [] },
    { originUs: 0, streams: [], fontFaces: [face, face] },
    { originUs: 1, streams: [], fontFaces: [face] },
    { ...(await probe()), fontFaces: [face] },
    { originUs: 0, streams: [] },
  ]) {
    await expect(
      store.import(path, { kind: "import" }, async () => metadata),
    ).rejects.toMatchObject({ code: "INVALID_NATIVE_RESPONSE" });
    expect(store.list().assets).toEqual([]);
  }
});

test("verified byte digest is enforced before both fresh and cached asset publication", async () => {
  const { root, store } = await setup();
  const path = join(root, "verified.png");
  await writeFile(path, "original pixels");
  const { fileIdentity } = await import("./files.js");
  const file = await open(path, "r");
  const stat = await file.stat({ bigint: true });
  await file.close();
  const expected = {
    path,
    bytes: Number(stat.size),
    identity: fileIdentity(stat),
    sha256: "0".repeat(64),
  };
  const observed = vi.fn(probe);
  const publish = vi.fn();
  await expect(
    store.import(
      path,
      { kind: "capture", source: "wrong-proof" },
      observed,
      new AbortController().signal,
      publish,
      expected,
    ),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(store.list().assets).toEqual([]);
  expect(observed).not.toHaveBeenCalled();
  const correct = await store.import(path, { kind: "import" }, probe);
  await expect(
    store.import(
      path,
      { kind: "capture", source: "wrong-proof" },
      observed,
      new AbortController().signal,
      publish,
      expected,
    ),
  ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(store.origins(correct.id).origins).toEqual([{ kind: "import" }]);
  expect(publish).not.toHaveBeenCalled();
  const accepted = await store.import(
    path,
    { kind: "capture", source: "verified" },
    observed,
    new AbortController().signal,
    publish,
    { ...expected, sha256: correct.id },
  );
  expect(accepted.id).toBe(correct.id);
  expect(store.origins(correct.id).origins).toContainEqual({ kind: "capture", source: "verified" });
});

test("sparse admission preserves leading, inter-run and trailing physical gaps at the occupied-run capacity", async () => {
  const { root, store } = await setup();
  const path = join(root, "sparse.mov");
  await writeFile(path, "sparse metadata fixture");
  const runs = 100_000;
  const segments = Array.from({ length: 2 * runs + 1 }, (_, index) => ({
    startUs: index * 100,
    endUs: (index + 1) * 100,
    empty: index % 2 === 0,
    ...(index % 2 ? { mediaStartUs: ((index - 1) / 2) * 100, mediaDurationUs: 100 } : {}),
  }));
  const metadata = {
    originUs: 100001,
    streams: [
      {
        id: "audio:0",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: segments.at(-1)!.endUs,
        sampleRate: 48000,
        channels: 1,
        segments,
      },
    ],
  };
  const asset = await store.import(path, { kind: "import" }, async () => metadata);
  const restored = store.get(asset.id);
  expect(restored.streams[0]!.segments).toEqual(segments);
  expect(compositionAsset(restored).streams[0]).toMatchObject({
    available: segments
      .filter((row) => !row.empty)
      .map(({ startUs, endUs }) => ({ startUs, endUs })),
  });
  const excessive = join(root, "excessive.mov");
  await writeFile(excessive, "different sparse metadata fixture");
  await expect(
    store.import(excessive, { kind: "import" }, async () => ({
      ...metadata,
      streams: [
        { ...metadata.streams[0], segments: [...segments, { startUs: 0, endUs: 1, empty: true }] },
      ],
    })),
  ).rejects.toMatchObject({ code: "INVALID_NATIVE_RESPONSE" });
});

test("public asset headers and immutable ordinal pages preserve complete physical rows", async () => {
  const { root, store } = await setup();
  const path = join(root, "paged.mov");
  await writeFile(path, "paged metadata");
  const segments = [
    { startUs: 0, endUs: 10, empty: true },
    { startUs: 10, endUs: 30, empty: false, mediaStartUs: 0, mediaDurationUs: 20 },
    { startUs: 30, endUs: 40, empty: true },
  ];
  const asset = await store.import(path, { kind: "import" }, async () => ({
    originUs: 100001,
    streams: [
      {
        id: "audio:0",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 40,
        sampleRate: 48000,
        channels: 1,
        segments,
      },
    ],
  }));
  const header = omit(asset.streams[0]!, "segments");
  expect(store.describe(asset.id)).toEqual({
    ...asset,
    streams: [{ ...omit(header, "id"), streamId: header.id, segmentCount: 3 }],
  });
  const first = store.segments(asset.id, "audio:0", { limit: 2 });
  expect(first.segments).toEqual(segments.slice(0, 2).map((row, ordinal) => ({ ordinal, ...row })));
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(store.segments(asset.id, "audio:0", { cursor: first.nextCursor!, limit: 2 })).toEqual({
    assetId: asset.id,
    streamId: "audio:0",
    segments: [{ ordinal: 2, ...segments[2] }],
    nextCursor: null,
  });
  expect(() => store.segments(asset.id, "missing")).toThrow(/Stream does not exist/);
  expect(() => store.segments(asset.id, "audio:0", { cursor: "wrong" })).toThrow(/cursor/);
  expect(() => store.segments(asset.id, "audio:0", { cursor: "wrong" })).toThrow(/cursor/);
  expect(store.get(asset.id)).toEqual(asset);
});

test("asset segment pages conform to the paging contract and bind their asset and stream", async () => {
  const { root, store } = await setup();
  const stream = (id: string, count: number) => ({
    id,
    kind: "audio",
    codec: "pcm",
    decodable: true,
    startUs: 0,
    endUs: count * 10,
    sampleRate: 48000,
    channels: 1,
    segments: Array.from({ length: count }, (_, index) => ({
      startUs: index * 10,
      endUs: (index + 1) * 10,
      empty: index % 2 === 0,
    })),
  });
  const imported = async (name: string) => {
    const path = join(root, name);
    await writeFile(path, name);
    return store.import(path, { kind: "import" }, async () => ({
      originUs: 0,
      streams: [stream("audio:0", 4), stream("audio:1", 4)],
    }));
  };
  const asset = await imported("one.mov"),
    other = await imported("two.mov");
  const { firstCursor } = expectPageTraversal<string>((limit, cursor) => {
    const page = store.segments(asset.id, "audio:0", { limit, ...(cursor ? { cursor } : {}) });
    return { items: page.segments, nextCursor: page.nextCursor };
  });
  for (const [assetId, streamId, cursor] of [
    [asset.id, "audio:0", "garbage"],
    [asset.id, "audio:0", pageCursor.encode("asset.list", { sequence: 1 }, {})],
    [asset.id, "audio:1", firstCursor],
    [other.id, "audio:0", firstCursor],
  ] as const)
    expect(() => store.segments(assetId, streamId, { cursor, limit: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
});

test("portable physical rows commit atomically, preserve optional fields and reject conflicting deduplication", async () => {
  const donor = await setup(),
    receiver = await setup();
  const path = join(donor.root, "source.mov");
  await writeFile(path, "portable physical rows");
  const image = (await probe()).streams[0]!;
  const asset = await donor.store.import(path, { kind: "import" }, async () => ({
    originUs: 100001,
    streams: [
      image,
      { ...image, id: "image:empty", segments: [] },
      {
        id: "audio:0",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 40,
        segments: [
          { startUs: 0, endUs: 10, empty: true },
          { startUs: 10, endUs: 40, empty: false, mediaStartUs: 50, mediaDurationUs: 30 },
        ],
        sampleRate: 48000,
        channels: 1,
      },
    ],
  }));
  const duplicate = donor.store.portable(asset.id);
  duplicate.asset.streams.push({ ...duplicate.asset.streams[2]!, segments: [] });
  await expect(
    receiver.store.stagePortable(
      duplicate,
      donor.store.path(asset.id),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  expect(receiver.store.list().assets).toEqual([]);
  const staged = await receiver.store.stagePortable(
    donor.store.portable(asset.id),
    donor.store.path(asset.id),
    new AbortController().signal,
  );
  expect(() =>
    receiver.catalog.transaction(() => {
      staged.publish();
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(receiver.store.list().assets).toEqual([]);
  receiver.catalog.transaction(() => staged.publish());
  await staged.close();
  expect(receiver.store.get(asset.id)).toEqual(asset);
  expect(
    await receiver.store.import(path, { kind: "import" }, async () => {
      throw new Error("must reuse immutable metadata");
    }),
  ).toEqual(asset);
  const conflicting = donor.store.portable(asset.id);
  conflicting.asset.streams[2]!.segments![1]!.mediaStartUs = 51;
  const changed = await receiver.store.stagePortable(
    conflicting,
    donor.store.path(asset.id),
    new AbortController().signal,
  );
  try {
    expect(() => receiver.catalog.transaction(() => changed.publish())).toThrow(
      /metadata conflicts/,
    );
    expect(receiver.store.get(asset.id)).toEqual(asset);
  } finally {
    await changed.close();
  }
});

test("admission discovery and portable metadata retain one signed origin and fractional support", async () => {
  const { root, store } = await setup();
  const path = join(root, "exact.wav");
  await writeFile(path, "exact physical fixture");
  const half = (numerator: number) => ({ numerator, denominator: 2 });
  const segments = [
    { startUs: half(-3), endUs: 0, empty: true },
    {
      startUs: half(11),
      endUs: half(21),
      empty: false,
      mediaStartUs: half(-1),
      mediaDurationUs: 5,
    },
    { startUs: 0, endUs: half(9), empty: false, mediaStartUs: 0, mediaDurationUs: half(9) },
  ];
  const admitted = await store.import(path, { kind: "import" }, async () => ({
    originUs: half(-7),
    streams: [
      {
        id: "a",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: half(21),
        segments,
        sampleRate: 48000,
        channels: 1,
      },
    ],
  }));
  expect(store.describe(admitted.id)).toMatchObject({
    originUs: half(-7),
    streams: [{ endUs: half(21) }],
  });
  expect(store.segments(admitted.id, "a").segments).toEqual(
    segments.map((segment, ordinal) => ({ ...segment, ordinal })),
  );
  expect(compositionAsset(admitted).streams[0]).toMatchObject({
    bounds: { startUs: 0, endUs: half(21) },
    available: [
      { startUs: 0, endUs: half(9) },
      { startUs: half(11), endUs: half(21) },
    ],
  });
  const receiver = await setup();
  const staged = await receiver.store.stagePortable(
    store.portable(admitted.id),
    store.path(admitted.id),
    new AbortController().signal,
  );
  try {
    expect(staged.publish()).toEqual(admitted);
  } finally {
    await staged.close();
  }
});

test("immutable cube assets retain non-playable LUT metadata through portable adoption", async () => {
  const donor = await setup();
  const source = join(donor.root, "look.cube");
  const bytes = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
  await writeFile(source, bytes);
  const lut = { format: "cube-3d", size: 2, domain: "unit", ordering: "red-fastest" };
  const asset = await donor.store.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    lut,
  }));
  expect(compositionAsset(asset)).toEqual({ id: asset.id, streams: [], lut });
  const recipient = await setup();
  const staged = await recipient.store.stagePortable(
    donor.store.portable(asset.id),
    donor.store.path(asset.id),
    new AbortController().signal,
  );
  recipient.catalog.transaction(() => staged.publish());
  await staged.close();
  expect(recipient.store.get(asset.id).lut).toEqual(lut);
  expect(await readFile(recipient.store.path(asset.id), "utf8")).toBe(bytes);
});
