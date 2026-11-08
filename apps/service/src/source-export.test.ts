import { omit } from "@yap/composition";
import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { chmod, mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity } from "@yap/core/files";
import { sourceExporter } from "./source-export.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("source exporter preserves retryable access failures and definitive identity conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-export-access-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const path = join(source, "narration.mov");
  await writeFile(path, "immutable input");
  const file = await open(path);
  const stat = await file.stat({ bigint: true });
  await file.close();
  const canonical = { narration: { path, bytes: Number(stat.size), identity: fileIdentity(stat) } };
  const exportSource = sourceExporter(async () => ({ ok: true, data: { marker: "verified" } }));
  const run = () =>
    exportSource(source, join(root, "out.jsonl"), new AbortController().signal, canonical);
  await chmod(path, 0);
  try {
    await expect(run()).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: true });
  } finally {
    await chmod(path, 0o600);
  }
  // chmod changes ctime: an already admitted descriptor identity must still refuse it.
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED", retryable: true });
  const restored = await open(path);
  canonical.narration.identity = fileIdentity(await restored.stat({ bigint: true }));
  await restored.close();
  await expect(run()).resolves.toMatchObject({ marker: "verified" });
  await writeFile(path, "changed identity");
  await expect(run()).rejects.toMatchObject({ code: "SOURCE_CHANGED", retryable: true });
});

test("video-only capture authority receives byte- and duration-scaled verification time", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-export-authority-"));
  roots.push(root);
  const directory = join(root, "source");
  await mkdir(directory);
  await writeFile(join(directory, "capture.journal.jsonl"), "journal");
  const path = join(directory, "video.mov");
  const sourceAuthority = {
    source: {
      kind: "primary" as const,
      sourceId: "source",
      sourceDurationUs: 1000000,
      originHostUs: 0,
      diagnostic: { code: "CAPTURE_RECOVERED", message: "Recovered" },
      journal: {
        file: "source.journal.jsonl" as const,
        bytes: 7,
        sha256: "a".repeat(64),
        lastSequence: 1,
        layout: 2 as const,
      },
      members: { "video.mov": { bytes: "0", sha256: "b".repeat(64) } },
    },
    receipt: { bytes: "100", sha256: "c".repeat(64) },
  };
  const budgets: number[] = [];
  const exportSource = sourceExporter(async (_operation, params, options) => {
    const budget =
      typeof options?.timeoutMs === "function"
        ? options.timeoutMs()
        : (options?.timeoutMs ?? 30000);
    if (params.sourceAuthority) budgets.push(budget);
    expect(budget).toBeGreaterThan(0);
    return { ok: true, data: { marker: "verified" } };
  });
  for (const bytes of [4096, 2 ** 30]) {
    const file = await open(path, "w+");
    // Sparse bytes expose scaling without allocating or decoding a large fixture.
    await file.truncate(bytes);
    const stat = await file.stat({ bigint: true });
    await file.close();
    const canonical = { video: { path, bytes, identity: fileIdentity(stat) } };
    sourceAuthority.source.members["video.mov"].bytes = String(bytes);
    await expect(
      exportSource(directory, join(root, "legacy.jsonl"), new AbortController().signal, canonical),
    ).resolves.toMatchObject({ marker: "verified" });
    await expect(
      exportSource(
        directory,
        join(root, "capture.jsonl"),
        new AbortController().signal,
        canonical,
        [],
        sourceAuthority,
      ),
    ).resolves.toMatchObject({ marker: "verified" });
  }
  expect(budgets[1]).toBeGreaterThan(budgets[0]!);
});

test("canonical video metadata requires current alpha facts without inventing source corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-export-video-facts-"));
  roots.push(root);
  const path = join(root, "video.mov");
  await writeFile(path, "retained canonical bytes");
  const file = await open(path);
  const stat = await file.stat({ bigint: true });
  await file.close();
  const actual = {
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "video" as const,
        codec: "avc1",
        decodable: true,
        hasAlpha: false,
        startUs: 0,
        endUs: 1000000,
        segments: [
          { startUs: 0, endUs: 1000000, empty: false, mediaStartUs: 0, mediaDurationUs: 1000000 },
        ],
      },
    ],
  };
  let emitAlpha = true;
  const exportSource = sourceExporter(async (operation, params, options) => {
    if (operation === "media.probe") {
      const report = emitAlpha
        ? actual
        : {
            ...actual,
            streams: actual.streams.map((stream) => omit(stream, "hasAlpha")),
          };
      const bytes = Buffer.from(JSON.stringify(report));
      writeSync(options!.descriptors![1]!, bytes, 0, bytes.length, 0);
      return {
        ok: true,
        data: {
          file: params.output,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      };
    }
    return { ok: true, data: { marker: "verified" } };
  });
  const run = (
    metadata:
      | typeof actual
      | { originUs: number; streams: Omit<(typeof actual.streams)[0], "hasAlpha">[] },
  ) =>
    exportSource(root, join(root, "out.jsonl"), new AbortController().signal, {
      video: { path, bytes: Number(stat.size), identity: fileIdentity(stat), metadata },
    });
  const oldStream = omit(actual.streams[0]!, "hasAlpha");
  await expect(run({ originUs: 0, streams: [oldStream] })).rejects.toMatchObject({
    code: "PREREQUISITE_MISSING",
    retryable: true,
  });
  await expect(run(actual)).resolves.toMatchObject({ marker: "verified" });
  emitAlpha = false;
  await expect(run(actual)).rejects.toMatchObject({
    code: "PREREQUISITE_MISSING",
    retryable: true,
  });
  emitAlpha = true;
  await expect(
    run({ ...actual, streams: [{ ...actual.streams[0]!, hasAlpha: true }] }),
  ).rejects.toMatchObject({
    code: "INVALID_PACKAGE",
    retryable: false,
  });
});
