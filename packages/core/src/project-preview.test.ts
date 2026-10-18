import { PreparedAudioStore } from "./prepared-audio.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { ProjectPreviewInspection, type ProjectMovieRenderer } from "./project-preview.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const renderer: ProjectMovieRenderer = {
  implementationId: "fixture-movie-v1",
  async render({ window, assets, output, settings }, signal) {
    signal.throwIfAborted();
    const frames = [...window.frames()];
    const bytes = Buffer.from(JSON.stringify({ manifest: window.manifest, frames, assets }));
    await writeFile(output, bytes, { flag: "wx" });
    return {
      file: output,
      settings,
      encodedVideo: {
        profile: settings.video.profile,
        level:
          settings.video.codec === "hevc" || settings.video.level === "auto"
            ? "3.1"
            : settings.video.level,
      },
      mediaType: "video/mp4",
      codec: settings.video.codec,
      durationUs: window.manifest.range.endUs - window.manifest.range.startUs,
      width: window.manifest.canvas.width,
      height: window.manifest.canvas.height,
      frameCount: frames.length,
      bytes: bytes.length,
    };
  },
};
async function fixture(render = renderer) {
  const home = await mkdtemp("/tmp/yap-project-preview-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const projects = projectStoreFixture(catalog, assets, home);
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "project") throw new CatalogError("INVALID_TARGET", "Expected project");
    projects.get(owner.projectId);
  });
  await cache.reconcile();
  let preview!: ProjectPreviewInspection;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind !== "project") throw new Error("Expected project");
        return {
          ...target,
          revisionId: projects.revision(target.projectId, target.revisionId).revisionId,
        };
      },
      isAvailable: (target) => target.kind === "project" && !projects.isDeleting(target.projectId),
      isDeleting: (target) => target.kind === "project" && projects.isDeleting(target.projectId),
      isCapturing: () => false,
    },
    execute: (execution) => preview.execute(execution),
  });
  const prepared = new PreparedAudioStore({
    catalog,
    assets,
    projects,
    jobs,
    staging: join(home, "prepared"),
    renderer: {
      implementationId: "unused",
      render: async () => {
        throw new Error("unused preparation");
      },
    },
    probe: async () => {
      throw new Error("unused preparation");
    },
  });
  preview = new ProjectPreviewInspection(projects, assets, jobs, cache, render, prepared);
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const input = join(home, "source.mov");
  await writeFile(input, "source identity");
  const asset = await assets.import(input, { kind: "import" }, async () => ({
    originUs: 9000,
    streams: [
      {
        id: "track:7",
        kind: "video",
        codec: "h264",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
        width: 160,
        height: 96,
        orientedWidth: 160,
        orientedHeight: 96,
      },
    ],
  }));
  const created = projects.create({
    requestId: "create",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 20, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const placed = projects.apply(projectId, {
    requestId: "place",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "track" },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "track:7",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  return {
    home,
    catalog,
    projects,
    assets,
    asset,
    cache,
    jobs,
    preview,
    projectId,
    placed,
    replaceRenderer(next: ProjectMovieRenderer) {
      preview = new ProjectPreviewInspection(projects, assets, jobs, cache, next, prepared);
      return preview;
    },
  };
}
test("HEVC preview publishes its pinned codec and refuses an H264 substitute", async () => {
  const f = await fixture();
  const input = { projectId: f.projectId, settings: { video: { codec: "hevc" as const } } };
  await f.preview.request(input);
  await f.jobs.idle();
  const ready = await f.preview.request(input);
  expect(ready.state).toBe("ready");
  expect(ready.published!.preview.codec).toBe("hevc");
  const broken = f.replaceRenderer({
    ...renderer,
    implementationId: "substitution-fixture",
    async render(request, signal) {
      return { ...(await renderer.render(request, signal)), codec: "h264" };
    },
  });
  await broken.request(input);
  await f.jobs.idle();
  expect((await broken.request(input)).state).toBe("failed");
});

test("preview resolution is pinned and gives each draft size its own artifact", async () => {
  const requests: (number | null | undefined)[] = [];
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      requests.push(request.maxLongEdge);
      const value = await renderer.render(request, signal);
      return request.maxLongEdge === null ? value : { ...value, width: 80, height: 48 };
    },
  });
  const full = await f.preview.request({ projectId: f.projectId });
  const draft = await f.preview.request({ projectId: f.projectId, maxLongEdge: 80 });
  expect(draft.jobId).not.toBe(full.jobId);
  await f.jobs.idle();
  expect(requests).toEqual([null, 80]);
  expect((await f.preview.request({ projectId: f.projectId, maxLongEdge: 80 })).state).toBe(
    "ready",
  );
});
test("pins an old revision through edits, repeated admission and cache eviction", async () => {
  const started = gate(),
    release = gate();
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      started.resolve();
      await release.promise;
      return renderer.render(request, signal);
    },
  });
  cleanup.push(async () => release.resolve());
  const request = { projectId: f.projectId, range: { startUs: 50001, endUs: 200000 } };
  const first = await f.preview.request(request);
  await started.promise;
  f.projects.apply(f.projectId, {
    requestId: "new-canvas",
    expectedRevisionId: first.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  const pinned = { ...request, revisionId: first.revisionId };
  expect((await f.preview.request(pinned)).jobId).toBe(first.jobId);
  release.resolve();
  await f.jobs.idle();
  const ready = await f.preview.request(pinned);
  expect(ready.state).toBe("ready");
  const preview = ready.published!.preview;
  const content = JSON.parse(await readFile(preview.file, "utf8"));
  expect(content.manifest.revisionId).toBe(first.revisionId);
  expect(content.manifest.canvas.width).toBe(160);
  expect(content.frames.map((frame: { sampleAtUs: number }) => frame.sampleAtUs)).toEqual([
    50000, 100000, 150000,
  ]);
  expect(content.assets).toEqual([
    { assetId: f.asset.id, streamId: "track:7", path: f.assets.path(f.asset.id), originUs: 9000 },
  ]);
  expect(
    content.manifest.requirements.every(
      (r: { implementationId: unknown }) => typeof r.implementationId === "string",
    ),
  ).toBe(true);
  f.cache.remove(preview.cacheId);
  expect((await f.preview.request(pinned)).published).toBeNull();
  await f.jobs.idle();
  const again = await f.preview.request(pinned);
  expect(again.published!.generation).toBeGreaterThan(ready.published!.generation);
  expect(JSON.parse(await readFile(again.published!.preview.file, "utf8"))).toEqual(content);
});

test("a preview range past the project's end renders the clamped range and reports range-clamped", async () => {
  const f = await fixture(renderer);
  const clamped = await f.preview.request({
    projectId: f.projectId,
    range: { startUs: 900000, endUs: 1500000 },
  });
  expect(clamped).toMatchObject({
    range: { startUs: 900000, endUs: 1000000 },
    issues: [
      {
        code: "range-clamped",
        evidence: {
          requested: { startUs: 900000, endUs: 1500000 },
          bounds: { startUs: 0, endUs: 1000000 },
        },
      },
    ],
  });
  const applied = await f.preview.request({
    projectId: f.projectId,
    range: { startUs: 900000, endUs: 1000000 },
  });
  expect(applied.jobId).toBe(clamped.jobId);
  expect(applied.issues).toEqual([]);
  await expect(
    f.preview.request({ projectId: f.projectId, range: { startUs: 1000000, endUs: 1500000 } }),
  ).rejects.toMatchObject({ code: "INVALID_RANGE" });
});

test("warm published preview reuses the cached render for its pinned revision", async () => {
  let renders = 0;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      renders++;
      return renderer.render(request, signal);
    },
  });
  const input = { projectId: f.projectId, revisionId: f.placed.revision.revisionId };
  const sourceBefore = await readFile(f.assets.path(f.asset.id));

  const cold = await f.preview.request(input);
  await f.jobs.idle();
  const warm = await f.preview.request(input);

  expect(cold.published).toBeNull();
  expect(warm.state).toBe("ready");
  expect(warm.published?.preview.revisionId).toBe(input.revisionId);
  expect(renders).toBe(1);
  expect(await readFile(f.assets.path(f.asset.id))).toEqual(sourceBefore);
});

test("cancellation fences an uncooperative renderer and retry stays on the admitted revision", async () => {
  const started = gate(),
    release = gate();
  let first = true;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      if (first) {
        first = false;
        started.resolve();
        await release.promise;
        return renderer.render(request, new AbortController().signal);
      }
      return renderer.render(request, signal);
    },
  });
  cleanup.push(async () => release.resolve());
  const admitted = await f.preview.request({ projectId: f.projectId });
  await started.promise;
  f.jobs.cancel(admitted.jobId!);
  release.resolve();
  await f.jobs.idle();
  expect(f.cache.bytes).toBe(0);
  expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
  const canceled = await f.preview.request({
    projectId: f.projectId,
    revisionId: admitted.revisionId,
  });
  expect(canceled.published).toBeNull();
  expect(canceled.state).not.toBe("ready");
  f.projects.apply(f.projectId, {
    requestId: "edit",
    expectedRevisionId: admitted.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  await f.preview.retry({ projectId: f.projectId, revisionId: admitted.revisionId });
  await f.jobs.idle();
  const ready = await f.preview.request({
    projectId: f.projectId,
    revisionId: admitted.revisionId,
  });
  expect(ready.published!.preview.width).toBe(160);
  expect(ready.published!.preview.revisionId).toBe(admitted.revisionId);
});

test("deletion denies new previews while the existing queue drains before revision retirement", async () => {
  const started = gate(),
    release = gate();
  const f = await fixture({
    ...renderer,
    async render(request) {
      started.resolve();
      await release.promise;
      return renderer.render(request, new AbortController().signal);
    },
  });
  cleanup.push(async () => release.resolve());
  const admitted = await f.preview.request({ projectId: f.projectId });
  await started.promise;
  const owner = { kind: "project" as const, projectId: f.projectId };
  f.projects.markDeleting(f.projectId);
  const draining = f.jobs.drainOwner(owner);
  await expect(
    f.preview.request({ projectId: f.projectId, revisionId: admitted.revisionId }),
  ).rejects.toThrow(/does not exist/);
  expect(f.assets.references(f.asset.id)).toContainEqual({
    kind: "revision",
    id: admitted.revisionId,
  });
  release.resolve();
  await draining;
  expect(f.cache.bytes).toBe(0);
  expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
  await f.jobs.forgetOwner(owner);
  while (!f.projects.finishDeletionPage(f.projectId)) {
    /* bounded store retirement */
  }
  expect(f.assets.references(f.asset.id)).toEqual([]);
  expect(await readFile(f.assets.path(f.asset.id), "utf8")).toBe("source identity");
});

test("binds supported gain throughout audio routing and output, but refuses unprepared retiming", async () => {
  const f = await fixture();
  expect(f.preview.capabilities()).toEqual(
    expect.arrayContaining(
      [
        { type: "rnnoise", execution: false, implementationId: null },
        {
          type: "pointer",
          targets: ["clip"],
          requiresAcquisition: true,
          execution: false,
          implementationId: null,
        },
        { type: "geometry", execution: true, implementationId: renderer.implementationId },
        { type: "motion-blur", execution: true, implementationId: renderer.implementationId },
        { type: "opacity", execution: true, implementationId: renderer.implementationId },
        { type: "gain", execution: true, implementationId: renderer.implementationId },
      ].map((capability) => expect.objectContaining(capability)),
    ),
  );
  const path = join(f.home, "voice.wav");
  await writeFile(path, "voice identity");
  const audio = await f.assets.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "voice",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
        sampleRate: 48000,
        channels: 2,
      },
    ],
  }));
  const targets = [
    { kind: "clip", id: { label: "voice" } },
    { kind: "track", id: { label: "audio" } },
    { kind: "group", id: { label: "inner" } },
    { kind: "group", id: { label: "outer" } },
    { kind: "output" },
  ];
  const edited = f.projects.apply(f.projectId, {
    requestId: "gain-tree",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      { operation: "group.add", group: { kind: "audio", order: 1 }, label: "outer" },
      {
        operation: "group.add",
        group: { kind: "audio", order: 0, parentId: { label: "outer" } },
        label: "inner",
      },
      {
        operation: "track.add",
        track: { kind: "audio", order: 0, parentId: { label: "inner" } },
        label: "audio",
      },
      {
        operation: "place",
        label: "voice",
        clip: {
          trackId: { label: "audio" },
          assetId: audio.id,
          streamId: "voice",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      ...targets.map((target, i) => ({
        operation: "processing.set",
        target,
        steps: [{ processor: { type: "gain", gain: (i + 1) / 10 } }],
      })),
    ],
  });
  await f.preview.request({ projectId: f.projectId });
  await f.jobs.idle();
  const result = (await f.preview.request({ projectId: f.projectId })).published!.preview;
  const content = JSON.parse(await readFile(result.file, "utf8"));
  expect(
    content.manifest.requirements
      .filter((r: { kind: string }) => r.kind === "processor")
      .map((r: { processor: { gain: number }; implementationId: string }) => [
        r.processor.gain,
        r.implementationId,
      ]),
  ).toEqual([0.1, 0.2, 0.3, 0.4, 0.5].map((gain) => [gain, renderer.implementationId]));
  f.projects.apply(f.projectId, {
    requestId: "stretch",
    expectedRevisionId: edited.revision.revisionId,
    operations: [
      {
        operation: "retime",
        clipIds: [edited.edit.labels.voice],
        durationUs: 2000000,
        ripple: "none",
      },
    ],
  });
  await expect(f.preview.request({ projectId: f.projectId })).rejects.toThrowError(
    expect.objectContaining({
      code: "NOT_READY",
      details: {
        requirements: [expect.objectContaining({ kind: "retime", implementationId: null })],
      },
    }),
  );
});

test("changed execution implementation never reuses a prior published movie", async () => {
  const f = await fixture();
  const first = await f.preview.request({ projectId: f.projectId });
  await f.jobs.idle();
  const old = (await f.preview.request({ projectId: f.projectId })).published!.preview;
  const next = f.replaceRenderer({ ...renderer, implementationId: "fixture-movie-v2" });
  const changed = await next.request({ projectId: f.projectId });
  expect(changed.jobId).not.toBe(first.jobId);
  expect(changed.published).toBeNull();
  await f.jobs.idle();
  const ready = (await next.request({ projectId: f.projectId })).published!.preview;
  expect(ready.cacheId).not.toBe(old.cacheId);
  expect(ready.implementationId).toBe("fixture-movie-v2");
  expect(JSON.parse(await readFile(ready.file, "utf8")).manifest.requirements).toEqual([
    { kind: "executor", mediaKind: "audio", implementationId: "fixture-movie-v2" },
    { kind: "executor", mediaKind: "video", implementationId: "fixture-movie-v2" },
  ]);
});

test.each(["bytes", "width", "durationUs"] as const)(
  "refuses an unrelated %s receipt and removes its reserved output",
  async (field) => {
    const f = await fixture({
      ...renderer,
      async render(request, signal) {
        const movie = await renderer.render(request, signal);
        return { ...movie, [field]: movie[field] + 1 };
      },
    });
    await f.preview.request({ projectId: f.projectId });
    await f.jobs.idle();
    const result = await f.preview.request({ projectId: f.projectId });
    expect(result.state).toBe("failed");
    expect(result.published).toBeNull();
    expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
  },
);

test("equivalent settings reuse the movie while meaningful changes pin distinct work", async () => {
  const f = await fixture();
  const a = await f.preview.request({ projectId: f.projectId });
  const b = await f.preview.request({ projectId: f.projectId, settings: a.settings });
  expect(b.jobId).toBe(a.jobId);
  const changed = await f.preview.request({
    projectId: f.projectId,
    settings: { video: { keyframeInterval: 15 } },
  });
  expect(changed.jobId).not.toBe(a.jobId);
  await f.jobs.idle();
  expect((await f.preview.request({ projectId: f.projectId })).published?.preview.settings).toEqual(
    a.settings,
  );
  expect(
    (await f.preview.request({ projectId: f.projectId, settings: changed.settings })).published
      ?.preview.settings.video.keyframeInterval,
  ).toBe(15);
});

async function addRetimedAudio(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.home, "retimed.wav");
  await writeFile(path, "retimed identity");
  const audio = await f.assets.import(path, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "voice",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
        sampleRate: 48000,
        channels: 2,
      },
    ],
  }));
  return f.projects.apply(f.projectId, {
    requestId: "retimed-audio",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 1 }, label: "voice" },
      {
        operation: "place",
        clip: {
          trackId: { label: "voice" },
          assetId: audio.id,
          streamId: "voice",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
        },
      },
    ],
  });
}

test("native retiming rejection leaves no preview job or cache entry", async () => {
  const f = await fixture({
    ...renderer,
    retime: "retime-fixture",
    async validateAudio() {
      throw new CatalogError("NOT_READY", "unsupported physical retained context");
    },
  });
  await addRetimedAudio(f);
  await expect(f.preview.request({ projectId: f.projectId })).rejects.toThrow(
    "unsupported physical retained context",
  );
  expect(f.catalog.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
  expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
});

test("preflight pins the revision and callback rollback leaves admission reusable", async () => {
  const started = gate(),
    release = gate();
  let rejectNew = false;
  const f = await fixture({
    ...renderer,
    retime: "retime-fixture",
    async validateAudio() {
      if (rejectNew) throw new Error("unexpected new preflight");
      started.resolve();
      await release.promise;
    },
  });
  cleanup.push(async () => release.resolve());
  const retimed = await addRetimedAudio(f);
  const pending = f.preview.prepare({ projectId: f.projectId });
  await started.promise;
  f.projects.apply(f.projectId, {
    requestId: "edit-during-preflight",
    expectedRevisionId: retimed.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  release.resolve();
  const prepared = await pending;
  expect(prepared.snapshot.revisionId).toBe(retimed.revision.revisionId);
  expect(prepared.snapshot.retimeImplementationId).toBe("retime-fixture");
  expect(() =>
    prepared.submit(() => {
      throw new Error("export intent rejected");
    }),
  ).toThrow("export intent rejected");
  expect(f.catalog.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
  const pinned = structuredClone(prepared.snapshot);
  prepared.snapshot.revisionId = f.projects.revision(f.projectId).revisionId;
  prepared.snapshot.range.endUs = 1000000;
  const admitted = prepared.submit();
  admitted.range.endUs = 1000000;
  admitted.settings.video.keyframeInterval = 24;
  const repeated = prepared.submit();
  expect(repeated.jobId).toBe(admitted.jobId);
  expect(repeated.range).toEqual(pinned.range);
  expect(repeated.settings).toEqual(pinned.settings);
  await f.jobs.idle();
  rejectNew = true;
  const ready = await f.preview.request(pinned);
  expect(ready.jobId).toBe(admitted.jobId);
  const content = JSON.parse(await readFile(ready.published!.preview.file, "utf8"));
  expect(content.manifest.revisionId).toBe(retimed.revision.revisionId);
  expect(content.manifest.canvas.width).toBe(160);
});

test.each(["close", "delete"] as const)(
  "%s during preflight prevents new admission",
  async (action) => {
    const started = gate(),
      release = gate();
    const f = await fixture({
      ...renderer,
      retime: "retime-fixture",
      async validateAudio() {
        started.resolve();
        await release.promise;
      },
    });
    cleanup.push(async () => release.resolve());
    await addRetimedAudio(f);
    const pending = f.preview.request({ projectId: f.projectId });
    await started.promise;
    if (action === "close") await f.jobs.close();
    else f.projects.markDeleting(f.projectId);
    release.resolve();
    await expect(pending).rejects.toMatchObject({
      code: action === "close" ? "SERVICE_STOPPED" : "NOT_FOUND",
    });
    expect(f.catalog.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
  },
);

test("retiming recipe changes invalidate produced previews and refuse old export pins", async () => {
  const f = await fixture({ ...renderer, retime: "retime-v1", async validateAudio() {} });
  await addRetimedAudio(f);
  const prepared = await f.preview.prepare({ projectId: f.projectId });
  const first = prepared.submit();
  await f.jobs.idle();
  const next = f.replaceRenderer({ ...renderer, retime: "retime-v2", async validateAudio() {} });
  await expect(next.request(prepared.snapshot)).rejects.toMatchObject({
    code: "NOT_READY",
    retryable: true,
  });
  const second = await next.request({ projectId: f.projectId });
  expect(second.jobId).not.toBe(first.jobId);
  expect(second.published).toBeNull();
  await f.jobs.idle();
  const ready = await next.request({ projectId: f.projectId });
  const content = JSON.parse(await readFile(ready.published!.preview.file, "utf8"));
  expect(
    content.manifest.requirements.filter((item: { kind: string }) => item.kind === "retime"),
  ).toEqual([expect.objectContaining({ implementationId: "retime-v2" })]);
});

test("failed preview output is reclaimed and requires explicit same-revision retry", async () => {
  let fail = true;
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      const movie = await renderer.render(request, signal);
      if (fail) throw new Error("controlled encoder interruption");
      return movie;
    },
  });
  const input = { projectId: f.projectId, revisionId: f.placed.revision.revisionId };
  const admitted = await f.preview.request(input);
  await f.jobs.idle();
  const failed = await f.preview.request(input);
  expect(failed).toMatchObject({
    state: "failed",
    jobId: admitted.jobId,
    published: null,
    retryable: true,
  });
  expect(f.cache.bytes).toBe(0);
  expect(await readdir(join(f.home, "cache", "derived"))).toEqual([]);
  fail = false;
  expect(await f.preview.request(input)).toEqual(failed);
  const retried = await f.preview.retry(input);
  expect(retried.jobId).toBe(admitted.jobId);
  await f.jobs.idle();
  const ready = await f.preview.request(input);
  expect(ready).toMatchObject({
    state: "ready",
    revisionId: input.revisionId,
    jobId: admitted.jobId,
    published: { generation: 2 },
  });
  expect(ready.published!.preview.bytes).toBe(
    (await readFile(ready.published!.preview.file)).length,
  );
  expect(
    JSON.parse(await readFile(ready.published!.preview.file, "utf8")).manifest.canvas,
  ).toMatchObject({ width: 160, height: 96 });
});

test("a movie whose text fell back to another face publishes with font issues", async () => {
  let fallbacks: (clipId: string) => unknown[] = () => [];
  let clipId = "";
  const f = await fixture({
    ...renderer,
    async render(request, signal) {
      return { ...(await renderer.render(request, signal)), textFallbacks: fallbacks(clipId) };
    },
  });
  const fontPath = join(f.home, "pinned.ttf");
  await writeFile(fontPath, "pinned font bytes");
  const font = await f.assets.import(fontPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    fontFaces: [{ postScriptName: "Pinned", familyName: "Pinned" }],
  }));
  const placed = f.projects.apply(f.projectId, {
    requestId: "caption",
    expectedRevisionId: f.projects.revision(f.projectId).revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "captions" },
      {
        operation: "place",
        label: "caption",
        clip: {
          trackId: { label: "captions" },
          source: {
            kind: "text",
            text: "A\u{1F600}",
            font: { assetId: font.id, postScriptName: "Pinned" },
            width: 160,
            height: 40,
            size: 20,
            color: "#ffffffff",
            alignment: "left",
            wrap: true,
          },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  clipId = placed.edit.labels["caption"]!;
  fallbacks = (id) => [
    { clipId: id, face: "AppleColorEmoji", substituted: [0x1f600], missing: [] },
  ];
  await f.preview.request({ projectId: f.projectId });
  await f.jobs.idle();
  const ready = await f.preview.request({ projectId: f.projectId });
  expect(ready.reason).toBeNull();
  expect(ready.state).toBe("ready");
  expect(ready.published!.issues).toEqual([
    {
      code: "font-substituted",
      message: expect.stringContaining("U+1F600"),
      evidence: {
        clipId,
        requested: { assetId: font.id, postScriptName: "Pinned" },
        used: "AppleColorEmoji",
        codePoints: [0x1f600],
      },
    },
  ]);

  // A report for a clip the movie has no text for is a malformed receipt, not an issue.
  fallbacks = () => [
    {
      clipId: f.placed.edit.labels["clip"]!,
      face: "LastResort",
      substituted: [],
      missing: [0xffff],
    },
  ];
  const other = f.replaceRenderer({
    ...renderer,
    implementationId: "fixture-movie-unknown-clip",
    async render(request, signal) {
      return { ...(await renderer.render(request, signal)), textFallbacks: fallbacks(clipId) };
    },
  });
  await other.request({ projectId: f.projectId });
  await f.jobs.idle();
  expect(await other.request({ projectId: f.projectId })).toMatchObject({
    state: "failed",
    published: null,
  });
});
