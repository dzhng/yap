import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CaptureStore } from "./capture-store.js";
import { Catalog, CatalogError } from "./catalog.js";
import { portHistoricalSpeechRaw } from "../../test-harness/speech/reference-raw.mjs";
import {
  TranscriptStore,
  speechExecution,
  recordingTranscript,
  recordingTranscriptOwner,
  type TranscriptIdentity,
  type TranscriptSource,
  type SpeechTranscriptionRequest,
  type SpeechTranscriptionReceipt,
} from "./transcript.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const pins = {
  runtime: "FluidAudio",
  runtimeVersion: "0.15.7",
  runtimeRevision: "runtime-pin",
  decoder: "parakeet-tdt-batch",
  model: "model",
  modelRevision: "model-pin",
  modelDigest: "a".repeat(64),
};
const source: TranscriptSource = {
  kind: "asset",
  streamId: "track:7",
  durationUs: 1000,
  acquisitionId: "context-a",
  supportDigest: "b".repeat(64),
};
const recordingSource: TranscriptSource = {
  kind: "recording",
  sourceGeneration: "captured",
  durationUs: 1000,
};
const asset: TranscriptIdentity = {
  owner: { kind: "asset", id: "same-owner" },
  sourceId: "same-owner",
  generation: "same-attempt",
};
const recording: TranscriptIdentity = {
  owner: { kind: "recording", id: "same-owner" },
  sourceId: "capture-source",
  generation: "same-attempt",
};
const raw =
  JSON.stringify({
    ordinal: 0,
    source: { startUs: 100, endUs: 900 },
    owned: { startUs: 100, endUs: 900 },
    state: "transcribed",
    words: [{ text: "kept", source: { startUs: 200, endUs: 400 }, confidence: 0.75 }],
  }) + "\n";
async function fixture() {
  const home = await mkdtemp("/tmp/transcript-owners-");
  let catalog = new Catalog(join(home, "catalog.sqlite"));
  const authoritative = new Map([
    ["asset", { sourceId: asset.sourceId, source }],
    ["recording", { sourceId: recording.sourceId, source: recordingSource }],
  ]);
  const validate = (identity: TranscriptIdentity, selected: TranscriptSource) => {
    const current = authoritative.get(identity.owner.kind);
    if (
      !current ||
      current.sourceId !== identity.sourceId ||
      JSON.stringify(current.source) !== JSON.stringify(selected)
    )
      throw new CatalogError("UNAVAILABLE", "Owner/source changed");
  };
  let store = new TranscriptStore(catalog, home, validate);
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  async function input(identity: TranscriptIdentity, selected: TranscriptSource) {
    const output = await store.reserve(identity);
    await writeFile(output, raw);
    const request: SpeechTranscriptionRequest = {
      execution: speechExecution(),
      models: { directory: join(home, "models"), files: [] },
      track: {
        source: join(home, "immutable.mov"),
        sourceOffsetUs: selected.kind === "asset" ? -250000 : 0,
        ...(selected.kind === "asset" ? { streamId: selected.streamId } : {}),
        available: [{ startUs: 100, endUs: 900 }],
      },
      output,
    };
    const receipt: SpeechTranscriptionReceipt = {
      output: {
        file: output,
        bytes: Buffer.byteLength(raw),
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
      engine: { ...pins, encoderPrecision: "int8", computeUnits: "cpuAndNeuralEngine" },
      segments: [
        {
          ordinal: 0,
          source: { startUs: 100, endUs: 900 },
          owned: { startUs: 100, endUs: 900 },
          state: "transcribed",
          wordCount: 1,
        },
      ],
      execution: request.execution,
      wordCount: 1,
      available: request.track.available,
    };
    return {
      identity,
      source: selected,
      request,
      receipt,
      pins,
      signal: new AbortController().signal,
    };
  }
  return {
    home,
    get store() {
      return store;
    },
    get catalog() {
      return catalog;
    },
    input,
    authoritative,
    restart() {
      catalog.close();
      catalog = new Catalog(join(home, "catalog.sqlite"));
      store = new TranscriptStore(catalog, home, validate);
    },
  };
}

test("raw transcript ownership is mandatory even when its receipt declares it", async () => {
  const f = await fixture();
  const input = await f.input(asset, source);
  const line = JSON.parse(raw);
  delete line.owned;
  const missingOwnership = JSON.stringify(line) + "\n";
  await writeFile(input.request.output, missingOwnership);
  input.receipt.output.bytes = Buffer.byteLength(missingOwnership);
  input.receipt.output.sha256 = createHash("sha256").update(missingOwnership).digest("hex");
  await expect(f.store.ingest(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(f.store.wordRecords(asset, { limit: 10 })).toEqual([]);
});

test("recording and asset owners with the same ID/generation retain separate files and rows", async () => {
  const f = await fixture();
  const recordingInput = await f.input(recording, recordingSource);
  const assetInput = await f.input(asset, source);
  const recorded = (await f.store.ingest(recordingInput)).transcript;
  const selected = (await f.store.ingest(assetInput)).transcript;
  expect(selected.owner).toEqual(asset.owner);
  expect(selected.source).toEqual(source);
  expect(selected.track.sourceOffsetUs).toBe(-250000);
  expect(selected.track.streamId).toBe("track:7");
  expect(recordingTranscript(recorded)).toMatchObject({
    recordingId: "same-owner",
    sourceId: "capture-source",
    sourceGeneration: "captured",
    narration: { source: recordingInput.request.track.source, sourceOffsetUs: 0 },
  });
  expect(() => recordingTranscript(selected)).toThrow(
    "Recording transcript requires a recording source",
  );
  expect(f.store.wordRecords(asset, { limit: 10 })).toEqual(
    f.store.wordRecords(recording, { limit: 10 }),
  );
  expect(f.store.gapRecords(asset, { limit: 10 })).toEqual([
    { startUs: 0, endUs: 100, reason: "not_acquired" },
    { startUs: 900, endUs: 1000, reason: "not_acquired" },
  ]);
  await f.store.purge(asset.owner, new AbortController().signal);
  expect(f.store.wordRecords(asset, { limit: 10 })).toEqual([]);
  expect(f.store.wordRecords(recording, { limit: 10 }).map((word) => word.text)).toEqual(["kept"]);
  await expect(readFile(assetInput.request.output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(recordingInput.request.output, "utf8")).toBe(raw);
});

test.each(["owner", "source", "descriptor"])(
  "changed %s authority cannot publish indexed transcript rows",
  async (change) => {
    const f = await fixture();
    const input = await f.input(asset, source);
    // The initial ownership check has run; real file ingestion is now asynchronous.
    const pending = f.store.ingest(input);
    if (change === "owner") f.authoritative.delete("asset");
    else if (change === "source") f.authoritative.set("asset", { sourceId: "changed", source });
    else
      f.authoritative.set("asset", {
        sourceId: asset.sourceId,
        source: { ...source, durationUs: 999 },
      });
    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.catalog.catalog.prepare("SELECT state FROM transcript_generations").all()).toEqual([
      { state: "ingesting" },
    ]);
    await f.store.reclaim(asset.owner, () => false, new AbortController().signal);
    expect(
      f.catalog.catalog.prepare("SELECT generation FROM transcript_generations").all(),
    ).toEqual([]);
    expect(f.store.wordRecords(asset, { limit: 10 })).toEqual([]);
    await expect(readFile(input.request.output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("canceling ingestion leaves no complete generation and reclamation removes the attempt", async () => {
  const f = await fixture();
  const input = await f.input(asset, source);
  const controller = new AbortController();
  const pending = f.store.ingest({ ...input, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(f.catalog.catalog.prepare("SELECT state FROM transcript_generations").all()).toEqual([
    { state: "ingesting" },
  ]);
  await f.store.reclaim(asset.owner, () => false, new AbortController().signal);
  expect(f.catalog.catalog.prepare("SELECT generation FROM transcript_generations").all()).toEqual(
    [],
  );
  await expect(readFile(input.request.output)).rejects.toMatchObject({ code: "ENOENT" });
});

test("restart reclamation protects retained generations and the other owner namespace", async () => {
  const f = await fixture();
  const recordingInput = await f.input(recording, recordingSource);
  await f.store.ingest(recordingInput);
  for (const generation of ["retained", "obsolete", "row-only", "file-only"]) {
    const input = await f.input({ ...asset, generation }, source);
    if (generation !== "file-only") await f.store.ingest(input);
    if (generation === "row-only") await rm(join(input.request.output, ".."), { recursive: true });
  }
  f.restart();
  await f.store.reclaim(
    asset.owner,
    (generation) => generation === "retained",
    new AbortController().signal,
  );
  expect(await readdir(join(f.home, "transcripts", "assets", "same-owner"))).toEqual(["retained"]);
  expect(
    f.catalog.catalog
      .prepare("SELECT ownerKind,generation FROM transcript_generations ORDER BY ownerKind")
      .all(),
  ).toEqual([
    { ownerKind: "asset", generation: "retained" },
    { ownerKind: "recording", generation: "same-attempt" },
  ]);
  expect(
    f.store
      .wordRecords({ ...asset, generation: "retained" }, { limit: 10 })
      .map((word) => word.text),
  ).toEqual(["kept"]);
  expect(await readFile(recordingInput.request.output, "utf8")).toBe(raw);
});

const staleRewrites = {
  recipe: (row: { execution: string; engine: string }) => ({
    ...row,
    execution: JSON.stringify({ ...JSON.parse(row.execution), recipe: "foreign-recipe-v0" }),
  }),
  policy: (row: { execution: string; engine: string }) => ({
    ...row,
    engine: JSON.stringify({ ...JSON.parse(row.engine), policy: "transcript-v0" }),
  }),
  unreadable: (row: { execution: string; engine: string }) => ({
    ...row,
    execution: JSON.stringify({ recipe: 7 }),
  }),
};
test.each(Object.keys(staleRewrites) as (keyof typeof staleRewrites)[])(
  "a retained generation with a %s that is not current is stale: reads and inventories skip it without a schema error",
  async (kind) => {
    const f = await fixture();
    const portable = {
      owner: { kind: "asset" as const, id: "c".repeat(64) },
      sourceId: "c".repeat(64),
    };
    const portableSource = { ...source, acquisitionId: randomUUID() };
    f.authoritative.set("asset", { sourceId: portable.sourceId, source: portableSource });
    const [currentId, oldId] = [randomUUID(), randomUUID()];
    const { transcript: current } = await f.store.ingest(
      await f.input({ ...portable, generation: currentId }, portableSource),
    );
    await f.store.ingest(await f.input({ ...portable, generation: oldId }, portableSource));
    const row = f.catalog.catalog
      .prepare("SELECT execution,engine FROM transcript_generations WHERE generation=?")
      .get(oldId) as { execution: string; engine: string };
    const rewritten = staleRewrites[kind](row);
    f.catalog.catalog
      .prepare("UPDATE transcript_generations SET execution=?,engine=? WHERE generation=?")
      .run(rewritten.execution, rewritten.engine, oldId);
    const old = { owner: portable.owner, generation: oldId };
    expect(() => f.store.retainedGeneration(old)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND", details: { generation: oldId, stale: true } }),
    );
    expect(f.store.isStale(old)).toBe(true);
    expect(f.store.isStale(current)).toBe(false);
    expect(f.store.retainedGeneration(current).generation).toBe(currentId);
    const inventory = f.store.portableGenerations(portable.owner.id);
    expect(inventory.generations.map((value) => value.generation)).toEqual([currentId]);
    expect(inventory.stale).toEqual([oldId]);
    if (kind !== "unreadable")
      expect(f.store.retainedGeneration(old, { historical: true })).toMatchObject(
        kind === "recipe"
          ? { execution: { recipe: "foreign-recipe-v0" } }
          : { engine: { policy: "transcript-v0" } },
      );
    else
      expect(() => f.store.retainedGeneration(old, { historical: true })).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    await f.store.reclaim(
      portable.owner,
      (generation) => !f.store.isStale({ owner: portable.owner, generation }),
      new AbortController().signal,
    );
    expect(
      f.catalog.catalog.prepare("SELECT generation FROM transcript_generations").all(),
    ).toEqual([{ generation: currentId }]);
  },
);

test("a replay admits retained evidence under its historical recipe and never relabels it", async () => {
  const f = await fixture();
  const input = await f.input(asset, source);
  const historical = { ...input.request.execution, recipe: "source-windows-historical-v1" };
  const { transcript: replay } = await f.store.ingest({
    ...input,
    request: { ...input.request, execution: historical },
    receipt: { ...input.receipt, execution: historical },
  });
  expect(replay.execution.recipe).toBe("source-windows-historical-v1");
  expect(f.store.wordRecords(asset, { limit: 10 }).map((word) => word.text)).toEqual(["kept"]);
  expect(f.store.isStale(asset)).toBe(true);
});

test("the retained native recording transcript preserves every inherited word and portable metadata", async () => {
  const home = await mkdtemp("/tmp/transcript-recording-parity-");
  const library = new CaptureStore(join(home, "catalog.sqlite"), {
    now: () => "fixture",
    newId: randomUUID,
  });
  cleanup.push(async () => {
    library.close();
    await rm(home, { recursive: true, force: true });
  });
  const evidence = new URL(
    "../../../specs/done/agent-editing/assets/10b-native-selection/",
    import.meta.url,
  );
  const nativeRaw = await readFile(new URL("full-narration-raw.jsonl", evidence));
  const manifest = JSON.parse(await readFile(new URL("full-narration.json", evidence), "utf8"));
  const nativeRequest = JSON.parse(
    await readFile(new URL("full-narration-request.json", evidence), "utf8"),
  );
  const nativeReply = JSON.parse(
    await readFile(new URL("full-narration-response.json", evidence), "utf8"),
  );
  const retained = JSON.parse(
    await readFile(
      new URL(
        "../../../specs/done/agent-editing/assets/12-speech/transcript.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { id: string; text: string; sourceRange: { startUs: number; endUs: number } }[];
  const { id: recordingId, sourceId } = library.allocate().recording;
  library.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "retained native fixture",
    sourceDurationUs: 134025574,
  });
  const store = new TranscriptStore(library, home, recordingTranscriptOwner(library));
  const identity: TranscriptIdentity = {
    owner: { kind: "recording", id: recordingId },
    sourceId,
    generation: "native-fixture",
  };
  const output = await store.reserve(identity);
  const adapted = portHistoricalSpeechRaw(nativeRaw, {
    execution: speechExecution(),
    available: nativeRequest.params.track.available,
  });
  await writeFile(output, adapted.body);
  const metadata = recordingTranscript(
    (
      await store.ingest({
        identity,
        source: {
          kind: "recording",
          durationUs: 134025574,
          sourceGeneration: "captured-native-fixture",
        },
        request: { ...nativeRequest.params, execution: speechExecution(), output },
        receipt: {
          ...nativeReply.data,
          execution: speechExecution(),
          segments: nativeReply.data.segments.map((segment: { source: unknown }) => ({
            ...segment,
            owned: segment.source,
          })),
          available: nativeRequest.params.track.available,
          output: { file: output, bytes: adapted.body.length, sha256: adapted.sha256 },
        },
        pins: { ...manifest.models.pins, modelDigest: manifest.models.digest },
        signal: new AbortController().signal,
      })
    ).transcript,
  );
  expect(metadata.wordCount).toBe(306);
  expect(
    store.wordRecords(identity, { limit: 1000 }).map((word) => ({
      id: `w${word.ordinal}`,
      text: word.text,
      sourceRange: { startUs: word.startUs, endUs: word.endUs },
    })),
  ).toEqual(retained.map(({ id, text, sourceRange }) => ({ id, text, sourceRange })));
  expect(await readFile(output)).toEqual(adapted.body);
  expect(adapted.referenceReplay.sourceSha256).toBe(
    createHash("sha256").update(nativeRaw).digest("hex"),
  );
  expect(metadata).toMatchObject({
    recordingId,
    sourceId,
    sourceGeneration: "captured-native-fixture",
    narration: { source: nativeRequest.params.track.source, sourceOffsetUs: 0 },
    raw: { bytes: adapted.body.length, sha256: adapted.sha256 },
  });
});
