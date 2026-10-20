import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { registeredModels, speakerModel } from "./model-registry.js";
import { parakeetModel, Models, type ModelManifest } from "./models.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const contents: Record<string, Buffer> = {
  "Model.mlmodelc/weights/weight.bin": Buffer.alloc(256 * 1024, "weights"),
  "vocab.json": Buffer.from('{"0":"um"}'),
};
const pin = (path: string, body: Buffer) => ({
  path,
  bytes: body.length,
  sha256: createHash("sha256").update(body).digest("hex"),
});
const manifest: ModelManifest = {
  name: "tiny",
  purpose: "transcription",
  autoPrepare: true,
  platform: { system: process.platform, architecture: process.arch },
  repo: "test/tiny-coreml",
  revision: "r1",
  folderName: "tiny-model",
  engine: {
    runtime: "TinyRuntime",
    runtimeVersion: "1.0.0",
    runtimeRevision: "c".repeat(40),
    decoder: "tiny-decoder",
  },
  files: Object.entries(contents).map(([path, body]) => pin(path, body)),
};
type Handler = (path: string, response: ServerResponse, request: IncomingMessage) => void;
const serveFile: Handler = (path, response) => {
  const body = contents[path];
  if (!body) return void response.writeHead(404).end();
  response.writeHead(200, { "content-length": body.length }).end(body);
};

async function fixture(handler: Handler = serveFile) {
  const home = await mkdtemp("/tmp/yap-speech-models-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const prefix = `/${manifest.repo}/resolve/${manifest.revision}/`;
    const path = decodeURIComponent(request.url!.slice(prefix.length));
    handler(path, response, request);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const local: typeof fetch = (input, init) => {
    requests.push(String(input));
    return fetch(String(input).replace("https://huggingface.co", origin), init);
  };
  const open = (network: typeof fetch = local) => new Models(home, network, [manifest], catalog);
  const models = join(await realpath(home), "models");
  return {
    home,
    requests,
    network: local,
    catalog,
    open,
    models,
    revision: join(models, "tiny", "r1"),
    staged: () => readdir(join(models, ".staging")),
  };
}
const catalogFor = (home: string) => {
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  return catalog;
};
const offline: typeof fetch = () => {
  throw new Error("status and native requests must not use the network");
};
const failure = (code: string, retryable = false) =>
  expect.objectContaining({ code, retryable }) as unknown as CatalogError;
/** Sends the first bytes of a large file, then holds the response open until released. */
function stalling(path: string) {
  const held: ServerResponse[] = [];
  const handler: Handler = (requested, response) => {
    if (requested !== path) return serveFile(requested, response, undefined as never);
    const body = contents[path]!;
    response.writeHead(200, { "content-length": body.length });
    response.write(body.subarray(0, 1024));
    held.push(response);
  };
  return { handler, held };
}

test("prepare installs pinned files whole and reports them for the native request", async () => {
  const { open, requests, models, revision, staged } = await fixture();
  const speech = open();
  expect(await speech.status("tiny")).toEqual({ state: "absent" });

  await speech.prepare("tiny", new AbortController().signal);

  expect(await speech.status("tiny")).toEqual({ state: "ready" });
  expect(await speech.transcription("tiny").nativeRequest()).toEqual({
    directory: join(revision, "tiny-model"),
    files: manifest.files,
  });
  for (const [path, body] of Object.entries(contents))
    expect(await readFile(join(revision, "tiny-model", path))).toEqual(body);
  expect(JSON.parse(await readFile(join(revision, "receipt.json"), "utf8"))).toMatchObject({
    modelDigest: speech.transcription("tiny").modelDigest,
  });
  expect(requests.sort()).toEqual([
    "https://huggingface.co/test/tiny-coreml/resolve/r1/Model.mlmodelc/weights/weight.bin",
    "https://huggingface.co/test/tiny-coreml/resolve/r1/vocab.json",
  ]);
  expect(await staged()).toEqual([]);
  expect((await stat(models)).mode & 0o777).toBe(0o700);
});

test("startup preparation includes every model opted into the lifecycle catalog", async () => {
  const { open } = await fixture();
  const speech = open();
  const preparing = speech.prepareAuto(new AbortController().signal);
  await preparing;
  expect(await speech.status("tiny")).toEqual({ state: "ready" });
});

test("the runtime pinned beside the model is the one the native worker resolves", async () => {
  const resolved = JSON.parse(
    await readFile(new URL("../../../helpers/mac/Package.resolved", import.meta.url), "utf8"),
  ) as { pins: { identity: string; state: { version?: string; revision: string } }[] };
  const fluidAudio = resolved.pins.find((pin) => pin.identity === "fluidaudio");
  expect(fluidAudio?.state).toEqual({
    version: parakeetModel.engine.runtimeVersion,
    revision: parakeetModel.engine.runtimeRevision,
  });
});

test("the model digest names the pinned file list, not the order it is declared in", async () => {
  const { home } = await fixture();
  const digest = new Models(home, offline, [manifest], catalogFor(home)).transcription(
    "tiny",
  ).modelDigest;
  const reordered = { ...manifest, files: [...manifest.files].reverse() };
  expect(
    new Models(home, offline, [reordered], catalogFor(home)).transcription("tiny").modelDigest,
  ).toBe(digest);
  const repinned = {
    ...manifest,
    files: manifest.files.map((file, index) =>
      index ? file : { ...file, sha256: "0".repeat(64) },
    ),
  };
  expect(
    new Models(home, offline, [repinned], catalogFor(home)).transcription("tiny").modelDigest,
  ).not.toBe(digest);
});

test("status, native requests and an already prepared model never use the network", async () => {
  const { open } = await fixture();
  expect(await open(offline).status("tiny")).toEqual({ state: "absent" });
  await expect(open(offline).transcription("tiny").nativeRequest()).rejects.toEqual(
    failure("MODEL_NOT_PREPARED", true),
  );
  await open().prepare("tiny", new AbortController().signal);

  const restarted = open(offline);
  expect(await restarted.status("tiny")).toEqual({ state: "ready" });
  await restarted.prepare("tiny", new AbortController().signal);
  expect((await restarted.transcription("tiny").nativeRequest()).files).toEqual(manifest.files);
});

test("an interrupted download is retryable and leaves no model", async () => {
  const { open, revision, staged } = await fixture((path, response) => {
    const body = contents[path]!;
    response.writeHead(200, { "content-length": body.length });
    response.write(body.subarray(0, body.length / 2), () => response.destroy());
  });
  const speech = open();

  await expect(speech.prepare("tiny", new AbortController().signal)).rejects.toEqual(
    failure("MODEL_DOWNLOAD_FAILED", true),
  );

  expect(await speech.status("tiny")).toMatchObject({
    state: "failed",
    code: "MODEL_DOWNLOAD_FAILED",
    retryable: true,
  });
  await expect(stat(revision)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await staged()).toEqual([]);
});

test("staging left by a process that stopped mid-download is removed on the next start", async () => {
  const { handler, held } = stalling("Model.mlmodelc/weights/weight.bin");
  const { open, revision, staged } = await fixture(handler);
  const controller = new AbortController();
  const preparing = open().prepare("tiny", controller.signal);
  cleanups.push(async () => {
    controller.abort();
    await preparing.catch(() => {});
  });
  await vi.waitFor(() => expect(held).toHaveLength(1));
  expect(await staged()).toHaveLength(1);

  const restarted = open(offline);

  expect(await staged()).toEqual([]);
  expect(await restarted.status("tiny")).toEqual({ state: "absent" });
  await expect(stat(revision)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a file whose bytes differ from its pin is refused", async () => {
  const { open, revision, staged } = await fixture((path, response) => {
    const body = Buffer.from(contents[path]!);
    body[0] = body[0]! ^ 0xff;
    response.writeHead(200).end(body);
  });
  const speech = open();

  await expect(speech.prepare("tiny", new AbortController().signal)).rejects.toEqual(
    failure("MODEL_HASH_MISMATCH", true),
  );

  expect(await speech.status("tiny")).toMatchObject({
    state: "failed",
    code: "MODEL_HASH_MISMATCH",
  });
  await expect(stat(revision)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await staged()).toEqual([]);
});

test("a file longer or shorter than its pin is refused without reading past the pin", async () => {
  const responses: Handler[] = [
    // Never ends: only the size bound can stop this download.
    (path, response) =>
      void response.writeHead(200).write(Buffer.concat([contents[path]!, Buffer.from("x")])),
    (path, response) => void response.writeHead(200).end(contents[path]!.subarray(1)),
  ];
  for (const handler of responses) {
    const { open, revision } = await fixture(handler);
    const speech = open();

    await expect(speech.prepare("tiny", new AbortController().signal)).rejects.toEqual(
      failure("MODEL_HASH_MISMATCH", true),
    );
    await expect(stat(revision)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("a prepared file changed on disk reads as invalid until prepare replaces the install", async () => {
  const { open, requests, revision } = await fixture();
  const speech = open();
  await speech.prepare("tiny", new AbortController().signal);
  const vocabulary = join(revision, "tiny-model", "vocab.json");
  await writeFile(vocabulary, '{"0":"uh"}');

  expect(await speech.status("tiny")).toEqual({ state: "invalid" });
  await expect(speech.transcription("tiny").nativeRequest()).rejects.toEqual(
    failure("MODEL_NOT_PREPARED", true),
  );

  await speech.prepare("tiny", new AbortController().signal);
  expect(await speech.status("tiny")).toEqual({ state: "ready" });
  expect(await readFile(vocabulary)).toEqual(contents["vocab.json"]);
  expect(requests).toHaveLength(4);
});

test("an extra file inside the model folder makes the install invalid", async () => {
  const { open, revision } = await fixture();
  const speech = open();
  await speech.prepare("tiny", new AbortController().signal);
  await mkdir(join(revision, "tiny-model", "Extra.mlmodelc"));
  await writeFile(join(revision, "tiny-model", "Extra.mlmodelc", "model.mil"), "");

  expect(await speech.status("tiny")).toEqual({ state: "invalid" });
});

test("concurrent prepares join one download", async () => {
  const { handler, held } = stalling("Model.mlmodelc/weights/weight.bin");
  const { open, requests } = await fixture(handler);
  const speech = open();

  const first = speech.prepare("tiny", new AbortController().signal);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  expect(await speech.status("tiny")).toMatchObject({
    state: "preparing",
    totalBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
    etaMs: expect.any(Number),
  });
  const second = speech.prepare("tiny", new AbortController().signal);
  held[0]!.end(contents["Model.mlmodelc/weights/weight.bin"]!.subarray(1024));

  await Promise.all([first, second]);
  expect(await speech.status("tiny")).toEqual({ state: "ready" });
  expect(requests.filter((url) => url.endsWith("weight.bin"))).toHaveLength(1);
});

test("model preparation owns update blocking through settlement and signals progress without a status request", async () => {
  const { handler, held } = stalling("Model.mlmodelc/weights/weight.bin");
  const { open } = await fixture(handler);
  const models = open();
  let settled!: () => void;
  const progress = new Promise<void>((resolve) => {
    settled = resolve;
  });
  models.onUpdateProgress = settled;
  const preparation = models.prepare("tiny", new AbortController().signal);
  void preparation.catch(() => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));
  try {
    expect(models.updateBlocked).toBe(true);
  } finally {
    held[0]!.end(contents["Model.mlmodelc/weights/weight.bin"]!.subarray(1024));
    await preparation;
  }
  await progress;
  expect(models.updateBlocked).toBe(false);
  models.onUpdateProgress = undefined;
});

test("a caller that aborts leaves a joined prepare running", async () => {
  const { handler, held } = stalling("Model.mlmodelc/weights/weight.bin");
  const { open } = await fixture(handler);
  const speech = open();
  const leaving = new AbortController();
  const left = speech.prepare("tiny", leaving.signal);
  const stayed = speech.prepare("tiny", new AbortController().signal);
  await vi.waitFor(() => expect(held).toHaveLength(1));

  leaving.abort(new Error("left"));
  await expect(left).rejects.toThrow("left");
  held[0]!.end(contents["Model.mlmodelc/weights/weight.bin"]!.subarray(1024));

  await stayed;
  expect(await speech.status("tiny")).toEqual({ state: "ready" });
});

test("abort by every caller stops the download and leaves no model", async () => {
  const { handler, held } = stalling("Model.mlmodelc/weights/weight.bin");
  const { open, revision, staged } = await fixture(handler);
  const speech = open();
  const controller = new AbortController();
  const preparing = speech.prepare("tiny", controller.signal);
  await vi.waitFor(() => expect(held).toHaveLength(1));

  controller.abort(new Error("stopped"));

  await expect(preparing).rejects.toThrow("stopped");
  expect(await speech.status("tiny")).toEqual({ state: "absent" });
  await expect(stat(revision)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await staged()).toEqual([]);
});

test("removing a model wins an in-flight prepare and persists until explicit prepare", async () => {
  const { handler, held } = stalling("Model.mlmodelc/weights/weight.bin");
  const f = await fixture(handler);
  const catalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  const models = new Models(f.home, f.network, [manifest], catalog);
  const preparing = models.prepare("tiny", new AbortController().signal);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  const removed = models.remove("tiny", "remove-tiny", () => false);
  held[0]!.end(contents["Model.mlmodelc/weights/weight.bin"]!.subarray(1024));
  await expect(preparing).rejects.toBeTruthy();
  await expect(removed).resolves.toEqual({
    id: "tiny",
    deleted: true,
    freedBytes: expect.any(Number),
  });
  expect(models.presence("tiny")).toBe("absent");
  const requestsAfterRemoval = f.requests.length;
  catalog.close();
  const restartedCatalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => restartedCatalog.close());
  const restarted = new Models(f.home, f.network, [manifest], restartedCatalog);
  await restarted.prepareAuto(new AbortController().signal);
  expect(await restarted.status("tiny")).toEqual({ state: "absent" });
  expect(f.requests).toHaveLength(requestsAfterRemoval);
  const explicit = restarted.prepare("tiny", new AbortController().signal);
  await vi.waitFor(() => expect(held).toHaveLength(2));
  held[1]!.end(contents["Model.mlmodelc/weights/weight.bin"]!.subarray(1024));
  await explicit;
  expect(await restarted.status("tiny")).toEqual({ state: "ready" });
});

test("replaying an incomplete removal resumes deletion and measures the bytes", async () => {
  const f = await fixture();
  const catalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  const models = new Models(f.home, f.network, [manifest], catalog);
  await models.prepare("tiny", new AbortController().signal);
  await mkdir(join(f.models, ".cache", "tiny"), { recursive: true });
  await writeFile(join(f.models, ".cache", "tiny", "compiler.bin"), Buffer.alloc(7));
  const receiptBytes = (await stat(join(f.revision, "receipt.json"))).size;
  catalog.catalog
    .prepare(
      "INSERT INTO model_removals(modelId,requestId,removedAtMs,freedBytes,completedAtMs,clearedAtMs) VALUES(?,?,?,?,?,?)",
    )
    .run("tiny", "crash", Date.now(), 0, null, null);
  catalog.close();
  const restartedCatalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => restartedCatalog.close());
  const restarted = new Models(f.home, f.network, [manifest], restartedCatalog);

  await expect(restarted.remove("tiny", "crash", () => false)).resolves.toEqual({
    id: "tiny",
    deleted: true,
    freedBytes: manifest.files.reduce((total, file) => total + file.bytes, 0) + receiptBytes + 7,
  });
  expect(restarted.presence("tiny")).toBe("absent");
});

test("a removal interrupted before its files are gone finishes on restart, not on a later replay", async () => {
  const f = await fixture();
  const catalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  const models = new Models(f.home, f.network, [manifest], catalog);
  await models.prepare("tiny", new AbortController().signal);
  catalog.catalog
    .prepare(
      "INSERT INTO model_removals(modelId,requestId,removedAtMs,freedBytes,completedAtMs,clearedAtMs) VALUES(?,?,?,?,?,?)",
    )
    .run("tiny", "crash", Date.now(), 0, null, null);
  catalog.close();
  const restartedCatalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => restartedCatalog.close());
  const restarted = new Models(f.home, f.network, [manifest], restartedCatalog);

  await restarted.prepareAuto(new AbortController().signal);
  expect(restarted.presence("tiny")).toBe("absent");
  await restarted.prepare("tiny", new AbortController().signal);
  const replayed = await restarted.remove("tiny", "crash", () => false);
  expect(replayed).toMatchObject({ id: "tiny", deleted: true });
  expect(replayed.freedBytes).toBeGreaterThan(0);
  expect(restarted.presence("tiny")).toBe("ready");
});

test("preparing clears the removal fence but keeps request receipts", async () => {
  const f = await fixture();
  const catalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  const models = new Models(f.home, f.network, [manifest], catalog);
  await models.prepare("tiny", new AbortController().signal);
  const first = await models.remove("tiny", "r1", () => false);
  await models.prepare("tiny", new AbortController().signal);

  await expect(models.remove("tiny", "r1", () => false)).resolves.toEqual(first);
  expect(models.presence("tiny")).toBe("ready");
  const second = await models.remove("tiny", "r2", () => false);
  expect(second.freedBytes).toBe(first.freedBytes);
  expect(models.presence("tiny")).toBe("absent");
});

test("concurrent removals are serialized and only the first reports removed bytes", async () => {
  const f = await fixture();
  const catalog = new Catalog(join(f.home, "catalog.sqlite"));
  cleanups.push(() => catalog.close());
  const models = new Models(f.home, f.network, [manifest], catalog);
  await models.prepare("tiny", new AbortController().signal);
  const [first, second] = await Promise.all([
    models.remove("tiny", "remove-1", () => false),
    models.remove("tiny", "remove-2", () => false),
  ]);
  expect(first.freedBytes).toBeGreaterThan(0);
  expect(second.freedBytes).toBe(0);
});

test("a models directory that is a link is refused", async () => {
  const { home } = await fixture();
  const elsewhere = join(home, randomUUID());
  await mkdir(elsewhere);
  await symlink(elsewhere, join(home, "models"));

  expect(() => new Models(home, offline, [manifest], catalogFor(home))).toThrow(
    failure("MODEL_STORAGE_FAILED", true),
  );
});

async function voiceFixture() {
  const home = await mkdtemp("/tmp/yap-model-runtime-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const f = {
    home,
    models: join(await realpath(home), "models"),
    staged: () => readdir(join(home, "models/.staging")),
  };
  const runtime = join(f.home, "runtime-source"),
    source = join(f.home, "model-source");
  await mkdir(runtime);
  await mkdir(source);
  for (const [path, body] of Object.entries(contents)) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), body);
  }
  const executable = Buffer.from("a pinned executable");
  await writeFile(join(runtime, "worker"), executable, { mode: 0o700 });
  await symlink("worker", join(runtime, "python"));
  const entries = [
    { kind: "file" as const, mode: 0o700, ...pin("worker", executable) },
    { kind: "symlink" as const, mode: 0o755, path: "python", target: "worker" },
  ];
  const voice: ModelManifest = {
    ...manifest,
    name: "voice",
    purpose: "voice",
    runtimeArtifact: {
      digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      entries,
      python: "worker",
      entry: "worker",
    },
  };
  const owner = () => new Models(f.home, offline, [manifest, voice], catalogFor(f.home));
  return {
    ...f,
    owner,
    runtime,
    source,
    voice,
    sources: { runtimeSource: runtime, modelSource: source },
  };
}

test("local runtime and model adoption survives restart and detects changed executable bytes", async () => {
  const f = await voiceFixture(),
    models = f.owner();
  const descriptor = models.list().find((entry) => entry.id === "voice")!;
  expect(descriptor.preparation.runtimeSourceRequired).toBe(true);
  expect(await models.status("voice")).toEqual({ state: "absent" });
  await models.prepare("voice", new AbortController().signal, f.sources);
  const ready = await models.runtime("voice", "voice");
  expect(await readFile(ready.python)).toEqual(Buffer.from("a pinned executable"));
  expect((await stat(ready.python)).ino).not.toBe((await stat(join(f.runtime, "worker"))).ino);
  expect((await stat(ready.python)).mode & 0o777).toBe(0o700);
  expect(await f.owner().status("voice")).toEqual({ state: "ready" });
  await models.prepare("voice", new AbortController().signal);
  expect((await models.runtime("voice", "voice")).descriptorDigest).toBe(
    descriptor.descriptorDigest,
  );
  const changed = Buffer.from(await readFile(ready.python));
  changed[0] = changed[0]! ^ 0xff;
  await writeFile(ready.python, changed);
  expect(await models.status("voice")).toEqual({ state: "invalid" });
  await expect(models.runtime("voice", "voice")).rejects.toMatchObject({
    code: "MODEL_NOT_PREPARED",
  });
  expect(await readFile(join(f.runtime, "worker"))).toEqual(Buffer.from("a pinned executable"));
});

test("a changed source or escaping runtime link never publishes a prepared model", async () => {
  const f = await voiceFixture(),
    models = f.owner();
  await rm(join(f.runtime, "python"));
  await symlink("../outside", join(f.runtime, "python"));
  await expect(
    models.prepare("voice", new AbortController().signal, f.sources),
  ).rejects.toMatchObject({ code: "MODEL_HASH_MISMATCH" });
  expect(await f.staged()).toEqual([]);
  expect(await models.status("tiny")).toEqual({ state: "absent" });
  await rm(join(f.runtime, "python"));
  await symlink("worker", join(f.runtime, "python"));
  await writeFile(join(f.runtime, "worker"), "changed");
  await expect(
    models.prepare("voice", new AbortController().signal, f.sources),
  ).rejects.toMatchObject({ code: "MODEL_HASH_MISMATCH" });
  expect(await f.staged()).toEqual([]);
  await expect(stat(join(f.models, "voice", "r1"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("runtime source and registered identity are explicit, and discovery needs no installed bytes", async () => {
  const f = await voiceFixture(),
    models = f.owner();
  expect(models.list().map((entry) => entry.id)).toEqual(["tiny", "voice"]);
  await expect(models.status("unknown")).rejects.toMatchObject({
    code: "NOT_FOUND",
    details: { kind: "model" },
    retryable: false,
  });
  await expect(models.prepare("voice", new AbortController().signal)).rejects.toMatchObject({
    code: "MODEL_SOURCE_REQUIRED",
  });
  expect(() =>
    models.prepare("voice", new AbortController().signal, { runtimeSource: "relative" }),
  ).toThrow();
  expect(await f.staged()).toEqual([]);
});

test("concurrent verification waits for current bytes while other model requests advance", async () => {
  const f = await voiceFixture(),
    models = f.owner();
  await models.prepare("voice", new AbortController().signal, f.sources);
  let complete = false;
  const first = models.status("voice").then((value) => {
    complete = true;
    return value;
  });
  const second = models.status("voice");
  expect(await models.status("tiny")).toEqual({ state: "absent" });
  expect(complete).toBe(false);
  expect(models.list().find((entry) => entry.id === "voice")?.purpose).toBe("voice");
  expect(await first).toEqual({ state: "ready" });
  expect(await second).toEqual({ state: "ready" });
  const receipt = await models.runtime("voice", "voice");
  expect(await readlink(join(receipt.python, "..", "python"))).toBe("worker");
  await rename(receipt.python, receipt.python + ".missing");
  expect(await models.status("voice")).toEqual({ state: "invalid" });
});

test("service readiness answers from preparation receipts without waiting on runtime verification", async () => {
  const f = await voiceFixture(),
    models = f.owner();
  await models.prepare("voice", new AbortController().signal, f.sources);
  // An explicit verification of the prepared runtime bytes is still hashing.
  let verified = false;
  const explicit = models.status("voice").then((value) => {
    verified = true;
    return value;
  });
  expect(models.statuses()).toEqual([
    { id: "tiny", purpose: "transcription", status: { state: "absent" } },
    { id: "voice", purpose: "voice", status: { state: "ready" } },
  ]);
  expect(verified).toBe(false);
  expect(await explicit).toEqual({ state: "ready" });
  // The receipt still catches a replaced prepared file without hashing its bytes.
  const model = join(f.models, "voice", "r1", "tiny-model", "vocab.json");
  await rename(model, model + ".old");
  await writeFile(model, contents["vocab.json"]!);
  expect(models.statuses()[1]!.status).toEqual({ state: "invalid" });
});

test("startup trusts an intact preparation receipt while execution still verifies runtime bytes", async () => {
  const f = await voiceFixture();
  await f.owner().prepare("voice", new AbortController().signal, f.sources);
  const runtime = join(f.models, "voice", "r1", "runtime", "worker");
  const before = await stat(runtime);
  // Same length, same inode: only hashing the runtime bytes can see this rewrite.
  await writeFile(runtime, Buffer.from("A pinned executable"));
  expect((await stat(runtime)).ino).toBe(before.ino);

  const restarted = new Models(f.home, offline, [f.voice], catalogFor(f.home));
  await restarted.prepareAuto(new AbortController().signal);
  expect(restarted.statuses()).toEqual([
    { id: "voice", purpose: "voice", status: { state: "ready" } },
  ]);
  expect(restarted.updateBlocked).toBe(false);

  expect(await restarted.status("voice")).toEqual({ state: "invalid" });
  await expect(restarted.runtime("voice", "voice")).rejects.toMatchObject({
    code: "MODEL_NOT_PREPARED",
  });
});

test("startup repairs a prepared model whose runtime lost or changed a file", async () => {
  const damages = [
    (worker: string) => rm(worker),
    (worker: string) => writeFile(worker, "a longer pinned executable", { mode: 0o700 }),
  ];
  for (const damage of damages) {
    const f = await voiceFixture();
    await f.owner().prepare("voice", new AbortController().signal, f.sources);
    const worker = join(f.models, "voice", "r1", "runtime", "worker");
    await damage(worker);

    // Startup cannot repair this runtime without its explicit local source, so reaching full
    // verification and repair surfaces as that refusal rather than a false ready.
    const restarted = new Models(f.home, offline, [f.voice], catalogFor(f.home));
    await expect(restarted.prepareAuto(new AbortController().signal)).rejects.toMatchObject({
      code: "MODEL_SOURCE_REQUIRED",
    });
    // Health reads receipts, but a failed repair outranks the receipt's readiness.
    expect(restarted.statuses()[0]!.status).toEqual({
      state: "failed",
      code: "MODEL_SOURCE_REQUIRED",
      message: "This model requires an explicit local runtime artifact source",
      retryable: false,
    });
    expect(await restarted.status("voice")).toEqual({ state: "invalid" });

    await restarted.prepare("voice", new AbortController().signal, f.sources);
    expect(restarted.statuses()[0]!.status).toEqual({ state: "ready" });
  }
});

test("startup repairs a preparation whose receipt no longer matches its files", async () => {
  const { open, requests, revision } = await fixture();
  await open().prepare("tiny", new AbortController().signal);
  const vocabulary = join(revision, "tiny-model", "vocab.json");
  // Identical bytes in a new file: the receipt no longer names it, so startup re-prepares.
  await rm(vocabulary);
  await writeFile(vocabulary, contents["vocab.json"]!);

  const restarted = open();
  await restarted.prepareAuto(new AbortController().signal);

  expect(await restarted.status("tiny")).toEqual({ state: "ready" });
  expect(requests).toHaveLength(4);
});

test("canceling a local runtime admission drains its private stage without affecting another model", async () => {
  const f = await voiceFixture(),
    models = f.owner(),
    controller = new AbortController();
  const pending = models.prepare("voice", controller.signal, f.sources);
  controller.abort(new Error("cancel local admission"));
  await expect(pending).rejects.toThrow("cancel local admission");
  expect(await f.staged()).toEqual([]);
  expect(await models.status("tiny")).toEqual({ state: "absent" });
  expect(await models.status("voice")).toEqual({ state: "absent" });
});

test("registered platform requirements cannot become false ready execution inputs", async () => {
  const f = await voiceFixture();
  const models = new Models(
    f.home,
    offline,
    [{ ...f.voice, platform: { system: "unsupported", architecture: "unsupported" } }],
    catalogFor(f.home),
  );
  expect(await models.status("voice")).toMatchObject({
    state: "failed",
    code: "MODEL_PLATFORM_UNSUPPORTED",
    retryable: true,
  });
  expect(() => models.prepare("voice", new AbortController().signal, f.sources)).toThrow(
    expect.objectContaining({ code: "MODEL_PLATFORM_UNSUPPORTED" }),
  );
  await expect(models.runtime("voice", "voice")).rejects.toMatchObject({
    code: "MODEL_PLATFORM_UNSUPPORTED",
  });
  expect(models.list()[0]?.platform.system).toBe("unsupported");
});

test("runtime admission preserves pinned directory modes under a restrictive service umask", async () => {
  const f = await voiceFixture();
  await mkdir(join(f.runtime, "data"));
  await chmod(join(f.runtime, "data"), 0o755);
  const entries = [
    ...f.voice.runtimeArtifact!.entries,
    { kind: "directory" as const, path: "data", mode: 0o755 },
  ];
  const voice = {
    ...f.voice,
    runtimeArtifact: {
      ...f.voice.runtimeArtifact!,
      entries,
      digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    },
  };
  const models = new Models(f.home, offline, [voice], catalogFor(f.home));
  const original = process.umask(0o077);
  try {
    await models.prepare("voice", new AbortController().signal, f.sources);
    const prepared = await models.runtime("voice", "voice");
    expect((await stat(join(prepared.python, "..", "data"))).mode & 0o777).toBe(0o755);
  } finally {
    process.umask(original);
  }
});

test("voice joiners and another model prepare independently without cross-canceling", async () => {
  const f = await voiceFixture(),
    models = f.owner(),
    left = new AbortController(),
    right = new AbortController();
  const departing = models.prepare("voice", left.signal, f.sources);
  const joined = models.prepare("voice", right.signal, f.sources);
  const transcription = models.prepare("tiny", new AbortController().signal, {
    modelSource: f.source,
  });
  left.abort(new Error("caller departed"));
  await expect(departing).rejects.toThrow("caller departed");
  await Promise.all([joined, transcription]);
  expect(await models.status("voice")).toEqual({ state: "ready" });
  expect(await models.status("tiny")).toEqual({ state: "ready" });
  expect(await f.staged()).toEqual([]);
});

test("a FIFO model source is refused instead of waiting for a writer", async () => {
  const f = await voiceFixture(),
    models = f.owner();
  const path = join(f.source, manifest.files[0]!.path);
  await rm(path);
  execFileSync("mkfifo", [path]);
  await expect(
    models.prepare("tiny", new AbortController().signal, { modelSource: f.source }),
  ).rejects.toMatchObject({ code: "MODEL_HASH_MISMATCH" });
  expect(await f.staged()).toEqual([]);
});

test("a locally sourced model refuses network acquisition before preparation and remains idempotent when ready", async () => {
  const f = await voiceFixture();
  const speaker: ModelManifest = {
    ...f.voice,
    name: "speaker-local",
    purpose: "speaker",
    modelSourceRequired: true,
  };
  const requests: string[] = [];
  const models = new Models(
    f.home,
    async (input) => {
      requests.push(String(input));
      throw new Error("fixture network acquisition refused");
    },
    [speaker, f.voice],
    catalogFor(f.home),
  );
  const listed = models.list();
  expect(listed.find((value) => value.id === speaker.name)?.preparation.modelSourceRequired).toBe(
    true,
  );
  expect(listed.find((value) => value.id === f.voice.name)?.preparation.modelSourceRequired).toBe(
    false,
  );
  await expect(
    models.prepare(speaker.name, new AbortController().signal, { runtimeSource: f.runtime }),
  ).rejects.toMatchObject({ code: "MODEL_SOURCE_REQUIRED", retryable: false });
  expect(requests).toEqual([]);
  expect(await f.staged()).toEqual([]);
  await models.prepare(speaker.name, new AbortController().signal, f.sources);
  const prepared = await models.runtime(speaker.name, "speaker");
  await models.prepare(speaker.name, new AbortController().signal);
  expect(await models.runtime(speaker.name, "speaker")).toEqual(prepared);
  expect(requests).toEqual([]);
});

test("speaker runtime uses managed preparation and remains readable offline after restart", async () => {
  const f = await voiceFixture();
  const speaker: ModelManifest = { ...f.voice, name: "speaker", purpose: "speaker" };
  const models = new Models(f.home, offline, [speaker], catalogFor(f.home));
  await expect(models.runtime("speaker", "speaker")).rejects.toMatchObject({
    code: "MODEL_NOT_PREPARED",
  });
  await models.prepare("speaker", new AbortController().signal, f.sources);
  const prepared = await new Models(f.home, offline, [speaker], catalogFor(f.home)).runtime(
    "speaker",
    "speaker",
  );
  expect(await readFile(prepared.python)).toEqual(Buffer.from("a pinned executable"));
  expect(prepared.python).not.toBe(join(f.runtime, "worker"));
  expect(prepared.modelRevision).toBe(speaker.revision);
  expect(prepared.runtimeDigest).toBe(speaker.runtimeArtifact!.digest);
  await expect(models.runtime("speaker", "voice")).rejects.toMatchObject({
    code: "INVALID_REQUEST",
  });
});

test("alignment runtime keeps pinned checkpoint and runtime identity through managed preparation", async () => {
  const f = await voiceFixture();
  const body = Buffer.from("pinned alignment worker");
  await mkdir(join(f.runtime, "execution"), { mode: 0o700 });
  await writeFile(join(f.runtime, "execution/worker.py"), body, { mode: 0o700 });
  const entries = [
    ...f.voice.runtimeArtifact!.entries,
    { kind: "directory" as const, path: "execution", mode: 0o700 },
    { kind: "file" as const, mode: 0o700, ...pin("execution/worker.py", body) },
  ];
  const alignment: ModelManifest = {
    ...f.voice,
    name: "alignment",
    purpose: "alignment",
    runtimeArtifact: {
      ...f.voice.runtimeArtifact!,
      entries,
      digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    },
    engine: { ...f.voice.engine, decoder: "nemo-auxiliary-ctc110-v1" },
    files: [f.voice.files[0]!],
  };
  const models = new Models(f.home, offline, [alignment, f.voice], catalogFor(f.home));
  expect(() => models.alignment(f.voice.name)).toThrow(failure("INVALID_REQUEST"));
  const provider = models.alignment(alignment.name);
  await expect(provider.runtime()).rejects.toMatchObject({ code: "MODEL_NOT_PREPARED" });
  await models.prepare(alignment.name, new AbortController().signal, f.sources);
  const restored = new Models(f.home, offline, [alignment], catalogFor(f.home)).alignment(
    alignment.name,
  );
  expect(restored.engine).toEqual(provider.engine);
  expect(restored.engine.workerSha256).toBe(pin("execution/worker.py", body).sha256);
  expect(restored.checkpoint).toBe(alignment.files[0]!.path);
  const runtime = await restored.runtime();
  expect(runtime.runtimeDigest).toBe(restored.engine.runtimeDigest);
  expect(runtime.modelDigest).toBe(restored.engine.modelDigest);
  expect(await readFile(runtime.python)).toEqual(Buffer.from("a pinned executable"));
});

test("model preparation acquires its pinned upstream inputs before materialization and model publication", async () => {
  const f = await voiceFixture();
  const archive = Buffer.from("immutable runtime input fixture");
  const registered: ModelManifest = {
    ...f.voice,
    runtimeArtifact: {
      ...f.voice.runtimeArtifact!,
      acquisition: {
        recipe: "python-wheels-v1",
        interpreterArchive: "interpreter.tar.gz",
        installs: [],
        resources: [],
        nativePolicy: { files: [] },
        files: [
          {
            path: "interpreter.tar.gz",
            url: "https://runtime.invalid/interpreter.tar.gz",
            bytes: archive.length,
            sha256: createHash("sha256").update(archive).digest("hex"),
          },
        ],
      },
    },
  };
  const requests: string[] = [];
  let extracted = 0;
  const models = new Models(
    f.home,
    async (input) => {
      const url = String(input);
      requests.push(url);
      const body =
        url === registered.runtimeArtifact!.acquisition!.files[0]!.url
          ? archive
          : contents[decodeURIComponent(url.split("/resolve/r1/")[1]!)];
      return new Response(new Uint8Array(body!));
    },
    [registered],
    catalogFor(f.home),
    async ({ inputs, directory }) => {
      expect(await readFile(join(inputs, "interpreter.tar.gz"))).toEqual(archive);
      extracted++;
      await writeFile(join(directory, "worker"), "a pinned executable", { mode: 0o700 });
      await symlink("worker", join(directory, "python"));
    },
  );
  expect(models.list()[0]!.preparation.runtimeSourceRequired).toBe(false);
  await models.prepare(registered.name, new AbortController().signal);
  const ready = await models.runtime(registered.name, "voice");
  expect(await readFile(ready.python)).toEqual(Buffer.from("a pinned executable"));
  expect(requests).toEqual([
    "https://runtime.invalid/interpreter.tar.gz",
    ...registered.files.map(
      (file) =>
        `https://huggingface.co/${registered.repo}/resolve/r1/${file.path.split("/").map(encodeURIComponent).join("/")}`,
    ),
  ]);
  await models.prepare(registered.name, new AbortController().signal);
  expect(extracted).toBe(1);
  expect(await f.staged()).toEqual([]);
});

test("a corrupt upstream runtime input is refused before materialization and never becomes ready", async () => {
  const f = await voiceFixture();
  const archive = Buffer.from("immutable runtime input fixture");
  const corrupt = Buffer.from(archive);
  corrupt[0] = corrupt[0]! ^ 1;
  const registered: ModelManifest = {
    ...f.voice,
    runtimeArtifact: {
      ...f.voice.runtimeArtifact!,
      acquisition: {
        recipe: "python-wheels-v1",
        interpreterArchive: "interpreter.tar.gz",
        installs: [],
        resources: [],
        nativePolicy: { files: [] },
        files: [
          {
            path: "interpreter.tar.gz",
            url: "https://runtime.invalid/interpreter.tar.gz",
            bytes: archive.length,
            sha256: createHash("sha256").update(archive).digest("hex"),
          },
        ],
      },
    },
  };
  let extracted = false;
  const models = new Models(
    f.home,
    async () => new Response(corrupt),
    [registered],
    catalogFor(f.home),
    async () => {
      extracted = true;
    },
  );
  await expect(models.prepare(registered.name, new AbortController().signal)).rejects.toMatchObject(
    { code: "MODEL_HASH_MISMATCH", details: { path: "interpreter.tar.gz" } },
  );
  expect(extracted).toBe(false);
  expect(await models.status(registered.name)).toMatchObject({
    state: "failed",
    code: "MODEL_HASH_MISMATCH",
  });
  expect(await f.staged()).toEqual([]);
});

test("unavailable runtime execution refuses before acquiring any upstream bytes", async () => {
  const f = await voiceFixture();
  const registered: ModelManifest = {
    ...f.voice,
    runtimeArtifact: {
      ...f.voice.runtimeArtifact!,
      acquisition: {
        recipe: "python-wheels-v1",
        interpreterArchive: "interpreter.tar.gz",
        installs: [],
        resources: [],
        nativePolicy: { files: [] },
        files: [
          {
            path: "interpreter.tar.gz",
            url: "https://runtime.invalid/input",
            bytes: 1,
            sha256: createHash("sha256").update("x").digest("hex"),
          },
        ],
      },
    },
  };
  const requests: string[] = [];
  const models = new Models(
    f.home,
    async (url) => {
      requests.push(String(url));
      return new Response("x");
    },
    [registered],
    catalogFor(f.home),
  );
  await expect(models.prepare(registered.name, new AbortController().signal)).rejects.toMatchObject(
    { code: "MODEL_RUNTIME_UNAVAILABLE" },
  );
  expect(requests).toEqual([]);
  expect(await f.staged()).toEqual([]);
});

test("registered runtimes prepared from the same pinned inputs record identical files with one mode", () => {
  // Preparation extracts the pinned interpreter archive preserving its member modes and
  // installs pinned wheels under a fixed mask, so the same bytes at the same path are
  // always prepared with the same mode. A registration that disagrees can never verify.
  const recorded = new Map<string, { model: string; mode: number }>();
  const disagreements: string[] = [];
  for (const model of registeredModels) {
    const runtime = model.runtimeArtifact;
    if (!runtime?.acquisition) continue;
    const archive = runtime.acquisition.files.find(
      (file) => file.path === runtime.acquisition!.interpreterArchive,
    )!;
    for (const entry of runtime.entries) {
      if (entry.kind !== "file") continue;
      const key = `${archive.sha256} ${entry.path} ${entry.sha256}`;
      const first = recorded.get(key);
      if (!first) recorded.set(key, { model: model.name, mode: entry.mode });
      else if (first.mode !== entry.mode)
        disagreements.push(
          `${entry.path}: ${first.model} ${first.mode.toString(8)}, ${model.name} ${entry.mode.toString(8)}`,
        );
    }
  }
  expect(disagreements).toEqual([]);
});

test("registered preparation recipes keep pip console wrappers out of every assembled dependency tree", async () => {
  // Only the installer is simulated: it writes a console wrapper with a private build
  // shebang wherever pip's target mode would. The pinned recipe itself runs unchanged.
  const installer = `#!/usr/bin/python3 -I
import json, sys
from pathlib import Path
a = sys.argv[1:]
if "venv" in a:
    Path(a[-1], "lib/python3.12/site-packages").mkdir(parents=True)
elif "--target" in a:
    target = Path(a[a.index("--target") + 1])
    (target / "bin").mkdir(exist_ok=True)
    (target / "bin/wrapper").write_text("#!/private/build/environment/bin/python")
elif any(x.endswith("assemble.py") for x in a):
    bundle = Path(a[a.index("--out") + 1], "bundle")
    bundle.mkdir(parents=True)
    trees = [a[i + 1] for i, x in enumerate(a) if x in ("--primary", "--supplemental")]
    (bundle / "wrappers.json").write_text(json.dumps([str(p) for t in trees for p in Path(t).glob("bin/*")]))
`;
  const prepared: Record<string, unknown> = {};
  for (const model of registeredModels) {
    const acquisition = model.runtimeArtifact?.acquisition;
    if (!acquisition) continue;
    const root = await realpath(await mkdtemp("/tmp/yap-recipe-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const python = join(root, "base/bin/python3.12");
    await mkdir(join(root, "base/bin"), { recursive: true });
    await writeFile(python, installer, { mode: 0o755 });
    const recipe = join(root, "recipe/prepare.py");
    await mkdir(join(root, "recipe"));
    await writeFile(recipe, acquisition.resources.find((r) => r.path === "prepare.py")!.content);
    const inputs = join(root, "inputs"),
      directory = join(root, "content");
    await mkdir(inputs);
    await mkdir(directory);
    const request = join(root, "request.json");
    await writeFile(
      request,
      JSON.stringify({ inputs, base: join(root, "base"), directory, acquisition }),
    );
    execFileSync("/usr/bin/python3", ["-I", "-B", recipe, request], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    prepared[model.name] = JSON.parse(await readFile(join(directory, "wrappers.json"), "utf8"));
  }
  expect(Object.keys(prepared)).not.toEqual([]);
  for (const wrappers of Object.values(prepared)) expect(wrappers).toEqual([]);
});

test("the registered original speaker requires explicit preparation", async () => {
  const home = await mkdtemp("/tmp/yap-original-speaker-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const models = new Models(home, offline, registeredModels, catalogFor(home));
  expect(speakerModel).toMatchObject({
    runtimeArtifact: {
      acquisition: {
        recipe: "python-wheels-v1",
        interpreterArchive: "cpython-3.12.14+20260825-aarch64-apple-darwin-install_only.tar.gz",
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "nemo_toolkit-2.7.3-py3-none-any.whl",
            url: expect.stringContaining("files.pythonhosted.org"),
          }),
        ]),
      },
    },
  });
  expect(speakerModel.autoPrepare).toBeUndefined();
  expect(models.list().find((entry) => entry.id === "speaker-runtime-control")).toMatchObject({
    purpose: "speaker",
    descriptorDigest: "0616f0f01006fbaa76ebaaffc169da816b2f9afdb9288ae17d37e7357bdaf8a6",
    runtimeDigest: "42c54f575cb3c0ce6a469ea39182b64e33f35a5ab30eceb593ec055dcda61df2",
    modelDigest: "ed338c0f61f62a177b04c10e2c01c8f9e987ed006c0bbe4681c9a565acc8f338",
    preparation: { runtimeSourceRequired: false, modelSourceRequired: false },
  });
});
