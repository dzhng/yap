import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { callLocal } from "@yap/client";
import { bundleNodeEntry } from "../../../scripts/node-bundle.mjs";
import { nativePictureCapabilities, projectMovieRenderer } from "../dist/project-render.js";
import { fixture, until, native, nativeBinary } from "./fixtures/project-export.mjs";

test(
  "bundled project startup reconciles ready preview cache before admitting its persisted export waiter",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { admission: false });
    // Pin the identity the bundled service composes: native picture capabilities are part of it,
    // and the child runs without an FFmpeg installation, so no audio processing runtime is added.
    const implementation = projectMovieRenderer(
      native,
      join(f.home, "render"),
      undefined,
      {},
      undefined,
      await nativePictureCapabilities(native),
    ).implementationId;
    f.replaceRenderer(implementation);
    const request = { ...f.request(), leaf: "restarted.mp4" };
    const pending = await f.exports.create(request);
    await f.jobs.idle();
    const preview = f.catalog.catalog
      .prepare("SELECT jobId FROM jobs WHERE artifact='preview' AND targetId=?")
      .get(f.projectId);
    const ready = f.jobs.inspect(preview.jobId);
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    const read = f.cache.acquire(ready.published.output.cacheId);
    assert.ok(read);
    const cached = Buffer.alloc(read.bytes);
    try {
      let position = 0;
      while (position < cached.length) {
        const bytes = read.read(cached.subarray(position), position);
        assert.ok(bytes > 0);
        position += bytes;
      }
    } finally {
      read.release();
    }
    assert.equal(pending.state, "queued");
    assert.equal(f.jobs.job(pending.jobId).state, "waiting");
    await f.close();
    // A real path, as installed: through the /tmp symlink a bundled module can pass by accident.
    const home = realpathSync(await mkdtemp("/tmp/yap-bundled-export-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await rename(f.home, join(home, "library"));
    const bundle = join(home, "service.mjs");
    bundleNodeEntry(resolve("apps/service/dist/main.js"), bundle, { stdio: "pipe" });
    const child = spawn(process.execPath, [bundle], {
      cwd: "/",
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        YAP_HOME: home,
        YAP_NATIVE: nativeBinary,
        YAP_FFMPEG_DIRECTORY: "",
      },
    });
    const closed = once(child, "close");
    let stdout = "",
      diagnostics = "",
      started,
      startupFailure;
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-32000);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let end;
      while ((end = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.event === "started") started = message;
        if (message.event === "failed") startupFailure = message;
      }
    });
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      await until(() => {
        assert.equal(startupFailure, undefined, JSON.stringify(startupFailure));
        assert.equal(child.exitCode, null, diagnostics);
        return started;
      });
      const status = await until(async () => {
        const result = await callLocal(started.socketPath, {
          id: randomUUID(),
          operation: "export.status",
          params: { exportId: request.exportId },
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(
          !["failed", "unavailable", "canceled"].includes(result.data.state),
          JSON.stringify(result.data),
        );
        return result.data.state === "ready" && result.data;
      });
      assert.equal(status.snapshot.revisionId, f.placed.revision.id);
      const output = await readFile(join(f.output, request.leaf));
      assert.deepEqual(output, cached);
      assert.equal(status.receipt.sha256, createHash("sha256").update(cached).digest("hex"));
    } finally {
      child.stdin.end();
      const watchdog = setTimeout(() => group("SIGKILL"), 5000);
      const terminal = await closed;
      clearTimeout(watchdog);
      const survived = group(0);
      if (survived) {
        group("SIGKILL");
        await until(() => !group(0));
      }
      assert.equal(survived, false, "Bundled service left an owned native child");
      assert.deepEqual(terminal, [0, null], diagnostics);
    }
  },
);
