import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fstatSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { callLocal } from "@yap/client";
import { encodeJsonLine } from "@yap/protocol";
import { createConnection } from "node:net";
import { startProjectService } from "../dist/project-service.js";
import { native, nativeBinary, until } from "./fixtures/project-export.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function adoptedMedia(t, kind) {
  const root = await realpath(await mkdtemp("/tmp/yap-adopted-media-"));
  let home = join(root, "producer");
  const output = join(root, "output");
  await mkdir(home);
  await mkdir(output);
  const bytes = gunzipSync(
    await readFile(resolve("specs/done/agent-editing/assets/03d-consumer-cutover/mixed-av.mov.gz")),
  );
  const oracle = JSON.parse(
    gunzipSync(
      await readFile(
        resolve("specs/done/agent-editing/assets/03d-consumer-cutover/mixed-av-oracle.json.gz"),
      ),
    ),
  );
  assert.equal(hash(bytes), oracle.fixtureSha256);
  const input = join(root, "input.mov"),
    marker = join(root, "held"),
    library = join(root, "barrier.dylib");
  await writeFile(input, bytes);
  let fail = true,
    hold = false,
    nativeClosed = false,
    pid,
    service;
  t.after(async () => {
    const results = await Promise.allSettled([service?.close()]);
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") results.push({ status: "rejected", reason: error });
      }
    }
    await rm(root, { recursive: true, force: true });
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  });
  const operationName = kind === "frame" ? "media.sourceFrame" : "media.sourceAudio";
  const serviceOptions = {
    worker: async (operation, params, options) => {
      if (operation !== operationName) return native(operation, params, options);
      if (fail) {
        fail = false;
        return {
          ok: false,
          error: {
            code: "MEDIA_WORKER_FAILED",
            message: "Injected native worker failure",
            retryable: true,
            details: {},
          },
        };
      }
      if (!hold) return native(operation, params, options);
      const previousLibrary = process.env.DYLD_INSERT_LIBRARIES,
        previousMarker = process.env.YAP_TEST_NATIVE_HELD;
      process.env.DYLD_INSERT_LIBRARIES = library;
      process.env.YAP_TEST_NATIVE_HELD = marker;
      let pending;
      try {
        pending = native(operation, params, { ...options, timeoutMs: 5000 });
      } finally {
        if (previousLibrary === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
        else process.env.DYLD_INSERT_LIBRARIES = previousLibrary;
        if (previousMarker === undefined) delete process.env.YAP_TEST_NATIVE_HELD;
        else process.env.YAP_TEST_NATIVE_HELD = previousMarker;
      }
      try {
        return await pending;
      } finally {
        nativeClosed = true;
      }
    },
  };
  service = await startProjectService({ home, ...serviceOptions });
  const call = async (operation, params = {}) => {
    const result = await callLocal(service.socketPath, { id: randomUUID(), operation, params });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const ready = async (run) =>
    until(async () => {
      const state = await run();
      assert.ok(
        !["failed", "canceled", "cleanup_failed"].includes(state.state),
        JSON.stringify(state),
      );
      return state.state === "ready" && state;
    });
  for (const params of [{ limit: 501 }, { unfinishedOnly: "yes" }, { typo: true }]) {
    const result = await callLocal(service.socketPath, {
      id: randomUUID(),
      operation: "export.list",
      params,
    });
    assert.equal(result.ok, false, JSON.stringify({ params, result }));
    assert.equal(result.error.code, "INVALID_PARAMS");
  }
  const admitted = await call("asset.import", { path: input, requestId: randomUUID() });
  const imported = await ready(() => call("job.get", { jobId: admitted.jobId }));
  const asset = await call("asset.get", { assetId: imported.published.output.assetId });
  const managedSource = service.assets.path(asset.id);
  const video = asset.streams.find((s) => s.kind === "video");
  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = project.project.projectId;
  await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: project.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
      {
        operation: "place",
        clip: {
          trackId: { label: "video" },
          assetId: asset.id,
          streamId: video.id,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    exportId,
    kind: "processed-package",
    directory: output,
    leaf: "project.zip",
  });
  await until(async () => {
    const status = await call("export.status", { exportId });
    assert.notEqual(status.state, "failed", JSON.stringify(status));
    return status.state === "committed";
  });
  const archive = join(output, "project.zip"),
    archiveHash = hash(await readFile(archive));
  await service.close();
  home = join(root, "recipient");
  await mkdir(home);
  service = await startProjectService({ home, ...serviceOptions });
  assert.deepEqual((await call("package.status")).admissions, []);
  await new Promise((resolve, reject) => {
    const socket = createConnection(service.socketPath);
    const timeout = setTimeout(
      () => socket.destroy(new Error("Lost package reply deadline")),
      3000,
    );
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        encodeJsonLine({ id: randomUUID(), operation: "package.open", params: { path: archive } }),
      ),
    );
    // Recover the admission through public discovery without parsing its discarded reply.
    socket.once("data", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const { admissions } = await call("package.status");
  assert.equal(admissions.length, 1, JSON.stringify(admissions));
  const [opening] = admissions;
  const opened = await ready(() => call("package.status", { admissionId: opening.id }));
  const requestId = randomUUID();
  const adopted = await ready(() =>
    call("package.adopt", { packageHandle: opened.packageHandle, requestId }),
  );
  assert.notEqual(adopted.published.output.projectId, projectId);
  const adoptedRevision = await call("revision.get", {
    projectId: adopted.published.output.projectId,
  });
  const adoptedAssetId = adoptedRevision.revision.document.clips[0].assetId;
  const adoptedAsset = await call("asset.get", { assetId: adoptedAssetId });
  const recipientSource = service.assets.path(adoptedAssetId);
  const selected = {
    assetId: adoptedAssetId,
    streamId: adoptedAsset.streams.find((s) => s.kind === (kind === "frame" ? "video" : "audio"))
      .id,
  };
  const request = {
    ...selected,
    ...(kind === "frame"
      ? { atUs: 100000, maxLongEdge: 96 }
      : { range: { startUs: 0, endUs: 250000 } }),
  };
  const failed = await until(async () => {
    const status = await call(`${kind}.get`, request);
    return status.state === "failed" && status;
  });
  assert.equal(failed.retryable, true);
  assert.deepEqual(await readdir(join(home, "library", "render")), []);
  await call(`${kind}.retry`, request);
  const retried = await ready(() => call(`${kind}.get`, request));
  assert.equal(retried.jobId, failed.jobId);
  assert.equal(retried.published.generation, 2);
  const signature =
    kind === "frame" ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from("RIFF");
  const content = await call("artifact.read", {
    token: retried.delivery.token,
    offset: 0,
    maxBytes: signature.length,
  });
  assert.deepEqual(Buffer.from(content.data, "base64"), signature);
  await call("package.close", { admissionId: opening.id });
  assert.deepEqual(
    await call("artifact.read", {
      token: retried.delivery.token,
      offset: 0,
      maxBytes: signature.length,
    }),
    content,
  );
  const cached = await stat(
    join(home, "library", "cache", "derived", `${retried.published.output.cacheId}.cache`),
  );
  const retained = () =>
    readdirSync("/dev/fd")
      .map(Number)
      .filter((fd) => {
        try {
          const value = fstatSync(fd);
          return value.dev === cached.dev && value.ino === cached.ino;
        } catch (error) {
          if (error.code === "EBADF") return false;
          throw error;
        }
      });
  assert.ok(retained().length > 0, "The artifact delivery retains an actual descriptor");
  const built = spawnSync(
    "/usr/bin/clang",
    ["-dynamiclib", "-o", library, resolve("apps/service/tests/fixtures/native-start-barrier.c")],
    { encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  hold = true;
  await call(`${kind}.get`, {
    ...request,
    ...(kind === "frame" ? { atUs: 300000 } : { range: { startUs: 100000, endUs: 350000 } }),
  });
  pid = await until(async () =>
    Number(
      await readFile(marker, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }),
    ),
  );
  const observed = spawnSync("/bin/ps", ["-p", String(pid), "-o", "ppid=,command="], {
    encoding: "utf8",
  });
  assert.equal(observed.stdout.trim(), `${process.pid} ${nativeBinary}`);
  await until(() =>
    spawnSync("/bin/ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" })
      .stdout.trim()
      .startsWith("T"),
  );
  await service.close();
  assert.equal(nativeClosed, true, "Service close awaits actual native operation settlement");
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
  );
  pid = undefined;
  assert.ok(Date.now() < retried.delivery.expiresAt);
  assert.deepEqual(retained(), [], "Service closure releases unexpired artifact descriptors");
  assert.deepEqual(await readdir(join(home, "library", "render")), []);
  assert.equal(hash(await readFile(input)), oracle.fixtureSha256);
  assert.equal(hash(await readFile(managedSource)), oracle.fixtureSha256);
  assert.equal(hash(await readFile(recipientSource)), oracle.fixtureSha256);
  assert.equal(hash(await readFile(archive)), archiveHash);
}

test(
  "adopted package source frame retries actual media and drains native work and deliveries on service close",
  { timeout: 20000 },
  async (t) => adoptedMedia(t, "frame"),
);
test(
  "adopted package source audio retries actual media and drains native work and deliveries on service close",
  { timeout: 20000 },
  async (t) => adoptedMedia(t, "audio"),
);
