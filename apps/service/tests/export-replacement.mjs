import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm, stat, link, rename, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startProjectService } from "../dist/project-service.js";
import { mediaWorker } from "../dist/worker.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = process.env.YAP_NATIVE;
assert.ok(
  binary,
  "YAP_NATIVE must name the production native executable or focused publication owner",
);
async function fixture(t, wrap = (worker) => worker) {
  const home = await mkdtemp("/tmp/yap-replacement-home-");
  const output = await mkdtemp("/tmp/yap-replacement-output-");
  let service;
  t.after(async () => {
    await service?.close();
    await rm(home, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  });
  const native = mediaWorker({ YAP_NATIVE: binary });
  const worker = wrap(async (operation, params, options) => {
    if (operation === "media.audioCapabilities" || operation === "media.pictureCapabilities")
      return { ok: true, data: {} };
    if (operation === "storage.clearRenderWorkspace") {
      if (params.parent)
        await rm(join(home, "library/render", params.parent.name), {
          recursive: true,
          force: true,
        });
      return { ok: true, data: { removed: true } };
    }
    if (operation === "media.probe") {
      const bytes = Buffer.from(
        JSON.stringify({
          originUs: 0,
          streams: [],
          fontFaces: [{ postScriptName: "FixtureFont", familyName: "Fixture" }],
        }),
      );
      const slot = Number(String(params.output).split("/").at(-1)) - 3;
      writeSync(options.descriptors[slot], bytes, 0, bytes.length, 0);
      return { ok: true, data: { file: params.output, bytes: bytes.length, sha256: hash(bytes) } };
    }
    return native(operation, params, options);
  });
  service = await startProjectService({ home, worker, nativeExecutable: binary });
  const exchanges = [];
  async function call(operation, params, wait = false) {
    const child = spawn(
      process.execPath,
      [
        resolve("apps/cli/dist/main.js"),
        operation,
        "--socket",
        service.socketPath,
        "--params",
        JSON.stringify(params),
        ...(wait ? ["--wait", "--timeout-ms", "5000"] : []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    const code = await new Promise((yes, no) => {
      child.once("error", no);
      child.once("close", yes);
    });
    const response = JSON.parse(stdout);
    exchanges.push({ operation, params, code, response });
    return { code, response, stderr };
  }
  async function good(operation, params, wait = false) {
    const result = await call(operation, params, wait);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.response.ok, true, JSON.stringify(result));
    return result.response.data;
  }
  const source = join(output, "original-font.bin");
  await writeFile(source, "original source bytes");
  const imported = await good("asset.import", { path: source, requestId: "font" }, true);
  const fontId = imported.published.output.assetId;
  const initial = await good("project.create", {
    requestId: "project",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = initial.project.projectId;
  const textSource = (text) => ({
    kind: "text",
    text,
    font: { assetId: fontId, postScriptName: "FixtureFont" },
    width: 160,
    height: 96,
    size: 32,
    color: "#ffffffff",
    alignment: "left",
    wrap: true,
  });
  let edited = await good("edit.apply", {
    projectId,
    requestId: "first-text",
    expectedRevisionId: initial.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "captions" },
      {
        operation: "place",
        label: "text",
        clip: {
          trackId: { label: "captions" },
          source: textSource("First words"),
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  const placementId = edited.edit.labels.text;
  return {
    home,
    output,
    source,
    exchanges,
    call,
    good,
    restart: async () => {
      await service.close();
      service = await startProjectService({ home, worker, nativeExecutable: binary });
    },
    request: (extra = {}) => {
      const requestId = randomUUID();
      const request = {
        projectId,
        revisionId: edited.revision.revisionId,
        placementIds: [placementId],
        kind: "srt",
        directory: output,
        leaf: "captions.srt",
        requestId,
        ...extra,
      };
      return request;
    },
    edit: async (text) => {
      edited = await good("edit.apply", {
        projectId,
        requestId: randomUUID(),
        expectedRevisionId: edited.revision.revisionId,
        operations: [{ operation: "text.set", clipId: placementId, source: textSource(text) }],
      });
      return edited;
    },
  };
}

test("public new export replaces unchanged Yap-owned bytes and old intent never replaces its successor", async (t) => {
  const f = await fixture(t);
  const firstRequest = f.request();
  const first = await f.good("export.create", firstRequest, true);
  const old = await readFile(first.output);
  await f.edit("Revised words");
  const secondRequest = f.request();
  const result = await f.call("export.create", secondRequest, true);
  assert.equal(result.code, 0, JSON.stringify(result));
  const second = result.response.data;
  const after = await readFile(second.output);
  assert.notDeepEqual(after, old);
  assert.match(after.toString(), /Revised words/);
  assert.equal(hash(after), second.receipt.sha256);
  assert.deepEqual(second.receipt.replacement.file, first.receipt.file);
  await f.good(
    "export.recover",
    { exportId: firstRequest.requestId, requestId: "recover-first" },
    true,
  );
  assert.deepEqual(await readFile(second.output), after);
  if (process.env.YAP_EXPORT_EVIDENCE)
    await writeFile(
      join(process.env.YAP_EXPORT_EVIDENCE, "public-owned-replacement.json"),
      JSON.stringify(
        { oldSha256: hash(old), newSha256: hash(after), exchanges: f.exchanges },
        null,
        2,
      ) + "\n",
    );
});

test("foreign overwrite never authorizes replacing an original imported source", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.source);
  const result = await f.call(
    "export.create",
    f.request({ leaf: "original-font.bin", overwrite: true }),
    true,
  );
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.response.error.code, "SOURCE_DESTINATION");
  assert.deepEqual(await readFile(f.source), before);
  const alias = join(f.output, "alias.bin");
  await link(f.source, alias);
  await rename(f.source, join(f.output, "renamed-original.bin"));
  const aliased = await f.call(
    "export.create",
    f.request({ leaf: "alias.bin", overwrite: true }),
    true,
  );
  assert.equal(aliased.code, 1, JSON.stringify(aliased));
  assert.equal(aliased.response.error.code, "SOURCE_DESTINATION");
  assert.deepEqual(await readFile(alias), before);
});

test("foreign and modified formerly-owned regular files require explicit overwrite bound to replay identity", async (t) => {
  const f = await fixture(t);
  const destination = join(f.output, "captions.srt");
  await writeFile(destination, "foreign file");
  const refused = await f.call("export.create", f.request(), true);
  assert.equal(refused.code, 1, JSON.stringify(refused));
  assert.equal(await readFile(destination, "utf8"), "foreign file");
  const explicit = f.request({ overwrite: true });
  const committed = await f.good("export.create", explicit, true);
  assert.equal(committed.receipt.replacement.sha256, hash("foreign file"));
  assert.match(await readFile(destination, "utf8"), /First words/);
  const changedRequest = await f.call("export.create", { ...explicit, overwrite: false }, true);
  assert.equal(changedRequest.code, 1);
  assert.equal(changedRequest.response.error.code, "REQUEST_CONFLICT");
  await writeFile(destination, "modified formerly-owned bytes");
  const modified = await f.call("export.create", f.request(), true);
  assert.equal(modified.code, 1, JSON.stringify(modified));
  assert.equal(await readFile(destination, "utf8"), "modified formerly-owned bytes");
  const replaced = await f.good("export.create", f.request({ overwrite: true }), true);
  assert.equal(replaced.receipt.replacement.sha256, hash("modified formerly-owned bytes"));
  assert.match(await readFile(destination, "utf8"), /First words/);
});

const gate = () => Promise.withResolvers();
test(
  "cancellation before replacement commit preserves previous output and explicit retry reuses its pin",
  { timeout: 15000 },
  async (t) => {
    const entered = gate(),
      release = gate();
    t.after(() => release.resolve());
    let armed = false;
    const f = await fixture(t, (worker) => async (operation, params, options) => {
      if (operation === "publication.commit" && armed) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return worker(operation, params, options);
    });
    const first = await f.good("export.create", f.request(), true);
    const before = await readFile(first.output);
    await f.edit("After cancellation");
    const request = f.request();
    armed = true;
    const pending = await f.good("export.create", request);
    await entered.promise;
    assert.deepEqual(await readFile(first.output), before);
    const cancel = f.good("job.cancel", { jobId: pending.jobId });
    const deadline = performance.now() + 5000;
    while ((await f.good("job.get", { jobId: pending.jobId })).state !== "canceled") {
      assert.ok(performance.now() < deadline, "cancellation was not admitted");
    }
    assert.deepEqual(await readFile(first.output), before);
    release.resolve();
    const canceledRecord = await cancel;
    const canceled = await f.call("export.status", { exportId: request.requestId });
    assert.equal(canceled.code, 0, JSON.stringify(canceled));
    assert.equal(canceled.response.ok, true, JSON.stringify(canceled));
    assert.equal(canceled.response.data.exportId, request.requestId);
    assert.equal(canceledRecord.exportId, request.requestId);
    assert.equal(canceledRecord.state, "canceled");
    assert.equal(canceledRecord.jobId, pending.jobId);
    assert.equal(canceledRecord.snapshot.revisionId, request.revisionId);
    assert.deepEqual(await readFile(first.output), before);
    await f.good("job.retry", { jobId: pending.jobId }, true);
    const retried = await f.good("export.status", { exportId: request.requestId }, true);
    assert.deepEqual(retried.receipt.replacement.file, first.receipt.file);
    assert.match(await readFile(retried.output, "utf8"), /After cancellation/);
  },
);

test(
  "lost replacement acknowledgement recovers exact native bytes after service restart",
  { timeout: 15000 },
  async (t) => {
    let armed = false,
      loseObservation = false;
    const f = await fixture(t, (worker) => async (operation, params, options) => {
      if (operation === "publication.reconcile" && loseObservation)
        throw new Error("controlled lost acknowledgement");
      const result = await worker(operation, params, options);
      if (operation === "publication.commit" && armed) {
        armed = false;
        loseObservation = true;
      }
      return result;
    });
    const first = await f.good("export.create", f.request(), true);
    await f.edit("Recovered replacement");
    const request = f.request();
    armed = true;
    const failed = await f.call("export.create", request, true);
    assert.equal(failed.code, 1, JSON.stringify(failed));
    assert.equal(failed.response.data.receipt, null);
    const bytes = await readFile(first.output),
      inode = (await stat(first.output, { bigint: true })).ino.toString();
    assert.match(bytes.toString(), /Recovered replacement/);
    loseObservation = false;
    await f.restart();
    const recovered = await f.good(
      "export.recover",
      { exportId: request.requestId, requestId: `${request.requestId}:recover` },
      true,
    );
    assert.equal(recovered.receipt.file.ino, inode);
    assert.equal(recovered.receipt.sha256, hash(bytes));
    assert.deepEqual(await readFile(recovered.output), bytes);
    assert.deepEqual(recovered.receipt.replacement.file, first.receipt.file);
  },
);

test(
  "two admitted publishers pinned to one victim cannot both replace it",
  { timeout: 15000 },
  async (t) => {
    const entered = gate(),
      release = gate();
    t.after(() => release.resolve());
    let armed = false;
    const f = await fixture(t, (worker) => async (operation, params, options) => {
      if (operation === "publication.allocate" && armed) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return worker(operation, params, options);
    });
    await f.good("export.create", f.request(), true);
    await f.edit("First publisher");
    const first = f.request();
    armed = true;
    await f.good("export.create", first);
    await entered.promise;
    await f.edit("Second publisher");
    const second = f.request();
    await f.good("export.create", second);
    release.resolve();
    const won = await f.good("export.status", { exportId: first.requestId }, true);
    const lost = await f.call("export.status", { exportId: second.requestId }, true);
    assert.equal(lost.code, 1, JSON.stringify(lost));
    assert.equal(lost.response.data.receipt, null);
    assert.match(await readFile(won.output, "utf8"), /First publisher/);
    const secondStatus = await f.good("export.status", { exportId: second.requestId });
    if (secondStatus.jobId) await f.call("job.retry", { jobId: secondStatus.jobId }, true);
    assert.match(await readFile(won.output, "utf8"), /First publisher/);
  },
);

for (const mode of ["foreign", "symlink"])
  test(`public external swap ${mode} conflict reports uncertain visibility and retains unknown displacement`, async (t) => {
    let armed = false,
      raced;
    const f = await fixture(t, (worker) => async (operation, params, options) => {
      if (operation === "publication.commit" && armed) {
        armed = false;
        return raced(operation, params, options);
      }
      return worker(operation, params, options);
    });
    const library = join(f.home, "swap-fault.dylib");
    await promisify(execFile)("/usr/bin/clang", [
      "-dynamiclib",
      resolve("helpers/mac/Tests/fixtures/publication-swap-interpose.c"),
      "-o",
      library,
    ]);
    const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const wrapper = join(f.home, "raced-native");
    const sentinel = join(f.output, "sentinel");
    await writeFile(sentinel, "untouched external referent");
    const assertDisplaced = async (path) => {
      if (mode === "foreign") assert.equal(await readFile(path, "utf8"), "foreign raced bytes");
      else assert.equal(await readlink(path), sentinel);
    };
    await writeFile(
      wrapper,
      `#!/bin/sh\nexport DYLD_INSERT_LIBRARIES=${quote(library)}\nexport YAP_SWAP_FAULT=${mode}\nexport YAP_SWAP_TARGET=${quote(sentinel)}\nexec ${quote(binary)}\n`,
      { mode: 0o700 },
    );
    raced = mediaWorker({ YAP_NATIVE: wrapper });
    const first = await f.good("export.create", f.request(), true);
    await f.edit("Uncertain new output");
    const request = f.request();
    armed = true;
    const failed = await f.call("export.create", request, true);
    assert.equal(failed.code, 1, JSON.stringify(failed));
    assert.equal(failed.response.data.receipt, null);
    const job = await f.good("job.get", { jobId: failed.response.data.jobId });
    assert.equal(job.errorCode, "DESTINATION_CHANGED");
    assert.equal(job.errorDetails.state, "conflicted");
    assert.equal(job.errorDetails.destinationVisibility, "uncertain");
    const displaced = job.errorDetails.retainedDisplaced;
    await assertDisplaced(displaced);
    const visible = await readFile(first.output);
    assert.match(visible.toString(), /Uncertain new output/);
    await f.call(
      "export.recover",
      { exportId: request.requestId, requestId: `${request.requestId}:recover` },
      true,
    );
    await f.call("job.retry", { jobId: failed.response.data.jobId }, true);
    const abandoned = await f.call("export.abandon", { exportId: request.requestId });
    assert.equal(abandoned.code, 1, JSON.stringify(abandoned));
    assert.deepEqual(await readFile(first.output), visible);
    await assertDisplaced(displaced);
    assert.equal(await readFile(sentinel, "utf8"), "untouched external referent");
    const storage = await f.good("storage.usage", {});
    if (mode === "symlink") {
      await writeFile(sentinel, Buffer.alloc(4 * 1024 * 1024, 0x61));
      const after = await f.good("storage.usage", {});
      // Model acquisition may settle between observations; external bytes must not affect
      // the non-model managed total.
      assert.equal(after.totalBytes - after.modelBytes, storage.totalBytes - storage.modelBytes);
      assert.equal(await readlink(displaced), sentinel);
    }
    if (process.env.YAP_EXPORT_EVIDENCE)
      await writeFile(
        join(
          process.env.YAP_EXPORT_EVIDENCE,
          mode === "foreign"
            ? "public-external-conflict.json"
            : "public-external-symlink-conflict.json",
        ),
        JSON.stringify(
          {
            visibleSha256: hash(visible),
            displaced:
              mode === "foreign"
                ? { sha256: hash("foreign raced bytes") }
                : { symlink: sentinel, bytes: Buffer.byteLength(sentinel) },
            storage,
            exchanges: f.exchanges,
          },
          null,
          2,
        ) + "\n",
      );
  });

test("an SRT export of literal markup publishes and reports the issue in its status", async (t) => {
  const f = await fixture(t);
  await f.edit("<b>literal</b> words");
  const request = f.request({ leaf: "markup.srt" });
  const exported = await f.good("export.create", request, true);
  assert.match(await readFile(exported.output, "utf8"), /<b>literal<\/b> words/);
  const status = await f.good("export.status", { exportId: request.requestId }, true);
  assert.deepEqual(
    status.issues.map((issue) => issue.code),
    ["srt-literal-markup"],
  );
});

test("a failed export recovers through job.retry with the jobId its status returns", async (t) => {
  let failures = 1,
    allocations = 0;
  const f = await fixture(t, (worker) => async (operation, params, options) => {
    if (operation === "publication.allocate") {
      allocations++;
      if (failures-- > 0)
        return {
          ok: false,
          error: {
            code: "MEDIA_WORKER_UNAVAILABLE",
            message: "Injected publication failure",
            retryable: true,
            details: {},
          },
        };
    }
    return worker(operation, params, options);
  });
  const request = f.request();
  const created = await f.call("export.create", request, true);
  assert.equal(created.code, 1, JSON.stringify(created));
  const failed = await f.good("export.status", { exportId: request.requestId });
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.equal(failed.retryable, true, JSON.stringify(failed));
  assert.equal(failed.jobId, created.response.data.jobId);
  assert.equal(failed.receipt, null);
  await assert.rejects(readFile(join(f.output, request.leaf)), { code: "ENOENT" });
  const retried = await f.good("job.retry", { jobId: failed.jobId }, true);
  assert.equal(retried.jobId, failed.jobId);
  const ready = await f.good("export.status", { exportId: request.requestId });
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.jobId, failed.jobId);
  assert.equal(allocations, 2);
  const bytes = await readFile(ready.output);
  assert.match(bytes.toString(), /First words/);
  assert.equal(hash(bytes), ready.receipt.sha256);
});

test("a failed preview recovers through job.retry with the jobId preview.get returns", async (t) => {
  let failures = 1,
    renders = 0;
  const f = await fixture(t, (worker) => async (operation, params, options) => {
    if (operation === "media.renderCompositionMovie") {
      renders++;
      if (failures-- > 0)
        return {
          ok: false,
          error: {
            code: "MEDIA_WORKER_UNAVAILABLE",
            message: "Injected render failure",
            retryable: true,
            details: {},
          },
        };
    }
    return worker(operation, params, options);
  });
  // The fixture's text clip uses a font the native renderer cannot read; silence renders.
  const selection = await silentProject(f, "silent-preview");
  const pending = await f.good("preview.get", selection);
  assert.ok(pending.jobId, JSON.stringify(pending));
  const deadline = performance.now() + 10000;
  let failed = pending;
  while (failed.state !== "failed") {
    assert.ok(["queued", "running"].includes(failed.state), JSON.stringify(failed));
    assert.ok(performance.now() < deadline, JSON.stringify(failed));
    failed = await f.good("preview.get", selection);
  }
  assert.equal(failed.jobId, pending.jobId);
  assert.equal(failed.retryable, true);
  assert.equal(failed.published, null);
  assert.equal(failed.delivery, null);
  assert.equal(renders, 1);
  await f.good("job.retry", { jobId: failed.jobId }, true);
  const ready = await f.good("preview.get", selection);
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.jobId, failed.jobId);
  assert.equal(renders, 2);
  // The CLI consumes the delivery and hands back the movie it wrote.
  const movie = await readFile(ready.output);
  assert.equal(movie.subarray(4, 8).toString(), "ftyp");
});

/** A short silent project the native renderer can complete without any media assets. */
async function silentProject(f, requestId) {
  const created = await f.good("project.create", {
    requestId,
    canvas: {
      width: 32,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#204080ff",
    },
  });
  const silent = await f.good("edit.apply", {
    projectId: created.project.projectId,
    requestId: `${requestId}-silence`,
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
        },
      },
    ],
  });
  return { projectId: created.project.projectId, revisionId: silent.revision.revisionId };
}

test("job.retry on a failed export also retries the export's own failed audio render", async (t) => {
  let failures = 1,
    mixes = 0;
  const f = await fixture(t, (worker) => async (operation, params, options) => {
    if (operation === "media.mixCompositionAudio") {
      mixes++;
      if (failures-- > 0)
        return {
          ok: false,
          error: {
            code: "MEDIA_WORKER_UNAVAILABLE",
            message: "Injected audio render failure",
            retryable: true,
            details: {},
          },
        };
    }
    return worker(operation, params, options);
  });
  const request = {
    ...(await silentProject(f, "audio-export")),
    kind: "audio",
    directory: f.output,
    leaf: "audio.wav",
    requestId: randomUUID(),
  };
  const created = await f.call("export.create", request, true);
  assert.equal(created.code, 1, JSON.stringify(created));
  const failed = await f.good("export.status", { exportId: request.requestId });
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.equal(failed.retryable, true);
  assert.equal(failed.jobId, created.response.data.jobId);
  assert.equal(mixes, 1);
  const retried = await f.good("job.retry", { jobId: failed.jobId }, true);
  assert.equal(retried.jobId, failed.jobId);
  const ready = await f.good("export.status", { exportId: request.requestId });
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.jobId, failed.jobId);
  assert.equal(mixes, 2);
  const wave = await readFile(ready.output);
  assert.equal(wave.subarray(0, 4).toString(), "RIFF");
  assert.equal(hash(wave), ready.receipt.sha256);
});
