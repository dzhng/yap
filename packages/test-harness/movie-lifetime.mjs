import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  createCompiler,
  validateComposition,
  resolveOutputSettings,
} from "../composition/dist/index.js";
import { projectMovieRenderer } from "../../apps/service/dist/project-render.js";
import { mediaWorker, nativeResult } from "../../apps/service/dist/worker.js";
import { clearRenderWorkspace, withRenderAttempt } from "../../apps/service/dist/render.js";
const execute = promisify(execFile);
const native = await realpath(
  process.env.YAP_NATIVE ??
    new URL("../../helpers/mac/.build/debug/yap-native", import.meta.url).pathname,
);
function compile(fixture, endUs, output) {
  const model = validateComposition(fixture.document, fixture.assets);
  const window = createCompiler(model, "movie-lifetime").window({
    range: { startUs: 0, endUs },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  return {
    model,
    window,
    assets: fixture.bindings,
    fonts: [],
    output,
    settings: resolveOutputSettings(),
  };
}
async function command(file, args) {
  return (await execute(file, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
async function until(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error("Native assembly made no observed progress");
}
async function assemblyFile(parent) {
  for (const attempt of await readdir(parent))
    for (const stage of await readdir(join(parent, attempt)).catch(() => [])) {
      const file = join(parent, attempt, stage, "movie.mp4");
      try {
        await readFile(file);
        return file;
      } catch {}
    }
}
async function stagingSnapshot(parent) {
  const entries = {};
  async function visit(path, relative = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(relative, entry.name),
        file = join(path, entry.name);
      if (entry.isDirectory()) {
        entries[name] = "directory";
        await visit(file, name);
      } else
        entries[name] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
    }
  }
  await visit(parent);
  return entries;
}
async function nativePid(parent = process.pid) {
  const rows = (await command("ps", ["-axo", "pid=,ppid=,comm="])).split("\n");
  for (const row of rows) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match && Number(match[2]) === parent && match[3] === native) return Number(match[1]);
  }
}
async function orphanedWorker(request, preparation, nativeWorker) {
  const renderURL = new URL("../../apps/service/dist/render.js", import.meta.url).href;
  const workerURL = new URL("../../apps/service/dist/worker.js", import.meta.url).href;
  const projectURL = new URL("../../apps/service/dist/project-render.js", import.meta.url).href;
  const compositionURL = new URL("../composition/dist/index.js", import.meta.url).href;
  const code = `
    import {withRenderAttempt} from ${JSON.stringify(renderURL)};
    import {projectMovieRenderer} from ${JSON.stringify(projectURL)};
    import {createCompiler,validateComposition,resolveOutputSettings} from ${JSON.stringify(compositionURL)};
    import {mediaWorker} from ${JSON.stringify(workerURL)};
    import {join} from 'node:path';
    const request=${JSON.stringify(request)};
    const worker=mediaWorker({YAP_NATIVE:${JSON.stringify(native)}});
    const signal=new AbortController().signal;
    if(${preparation}) {
      await withRenderAttempt(worker,request.attemptParent,signal,async(directory,execute)=>{
        await execute('media.presentationEvidence',{source:request.source,
          plan:[{source:{startUs:0,endUs:60000000},playback:{startUs:0,endUs:60000000}}],
          output:join(directory,'presentation.jsonl'),maxBytes:64000000},{signal});
        throw new Error('Preparation completed before orphan proof');
      },async()=>{throw new Error('Preparation consumed before orphan proof')});
    } else {
      const compile=${compile.toString()};
      await projectMovieRenderer(worker,request.attemptParent).render(
        compile(request.fixture,60000000,request.output),signal);
      throw new Error('Render completed before orphan proof');
    }
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  owner.stderr.on("data", (x) => (errors += x));
  const closed = new Promise((resolve) => owner.once("close", resolve));
  let pid;
  // A worker this lab stops must never be left stopped: a run that is interrupted between the
  // SIGSTOP and its own cleanup would otherwise leave a native process frozen on this person's
  // Mac, holding its workspace open, until they found and killed it themselves.
  const release = () => {
    if (!pid) return;
    try {
      process.kill(pid, "SIGCONT");
      process.kill(pid, "SIGKILL");
    } catch {
      // It has already gone.
    }
    pid = undefined;
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      release();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
  try {
    await until(async () => {
      assert.equal(owner.exitCode, null, errors);
      for (const entry of await readdir(request.attemptParent)) {
        const entries = await readdir(join(request.attemptParent, entry), {
          withFileTypes: true,
        }).catch(() => []);
        if (entries.some((value) => value.isDirectory())) {
          pid = await nativePid(owner.pid);
          if (pid) {
            process.kill(pid, "SIGSTOP");
            return true;
          }
        }
      }
    });
    owner.kill("SIGKILL");
    await closed;
    const abandoned = await readdir(request.attemptParent);
    assert.ok(abandoned.length > 0);
    const held = await stagingSnapshot(request.attemptParent);
    const began = Date.now();
    await assert.rejects(
      clearRenderWorkspace(nativeWorker, request.attemptParent, new AbortController().signal),
      { code: "RENDER_WORKSPACE_BUSY", retryable: true },
    );
    const busyMs = Date.now() - began;
    const short = compile(request.fixture, 1000000, request.output + "-concurrent.mp4");
    const concurrent = await projectMovieRenderer(nativeWorker, request.attemptParent).render(
      short,
      new AbortController().signal,
    );
    const concurrentBytes = (await readFile(concurrent.file)).length;
    assert.ok(concurrentBytes > 0);
    assert.deepEqual(await readdir(request.attemptParent), abandoned);
    assert.deepEqual(await stagingSnapshot(request.attemptParent), held);
    await assert.rejects(
      clearRenderWorkspace(nativeWorker, request.attemptParent, new AbortController().signal),
      { code: "RENDER_WORKSPACE_BUSY", retryable: true },
    );
    process.kill(pid, "SIGKILL");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    });
    pid = undefined;
    await clearRenderWorkspace(nativeWorker, request.attemptParent, new AbortController().signal);
    assert.deepEqual(await readdir(request.attemptParent), []);
    const resumed = await projectMovieRenderer(nativeWorker, request.attemptParent).render(
      { ...short, output: request.output + "-resumed.mp4" },
      new AbortController().signal,
    );
    const bytes = (await readFile(resumed.file)).length;
    assert.ok(bytes > 0);
    assert.deepEqual(await readdir(request.attemptParent), []);
    return {
      preparation,
      parentKilled: true,
      independentAttemptSucceeded: true,
      orphanStagingUnchanged: true,
      startupBarrierBlocked: true,
      busyMs,
      reusedAfterWorkerExit: true,
    };
  } finally {
    owner.kill("SIGKILL");
    release();
    process.removeListener("exit", release);
    await closed;
  }
}

test(
  "real composition movie worker owns publication and abort/deadline cleanup",
  { timeout: 90000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "yap-movie-lifetime-"));
    try {
      const attempts = join(home, "attempts");
      await mkdir(attempts, { mode: 0o700 });
      const source = join(home, "video.mp4"),
        audio = join(home, "audio.mov");
      await command("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10:duration=60",
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-movflags",
        "+faststart",
        "-an",
        source,
      ]);
      await command("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.2*sin(2*PI*997*t)|0.2*sin(2*PI*1511*t):s=48000:d=60",
        "-c:a",
        "pcm_f32le",
        audio,
      ]);
      const before = await Promise.all([readFile(source), readFile(audio)]);
      const run = mediaWorker({ YAP_NATIVE: native });
      const assets = [],
        bindings = [];
      for (const [id, path, kind] of [
        ["video", source, "video"],
        ["audio", audio, "audio"],
      ]) {
        const probe = nativeResult(await run("media.probe", { path }));
        const stream = probe.streams.find((value) => value.kind === kind);
        assert.ok(stream);
        assets.push({
          id,
          streams: [
            {
              id: stream.id,
              kind,
              ...(kind === "video"
                ? { width: stream.orientedWidth, height: stream.orientedHeight }
                : {}),
              bounds: { startUs: stream.startUs, endUs: stream.endUs },
              available: [{ startUs: stream.startUs, endUs: stream.endUs }],
            },
          ],
        });
        bindings.push({ assetId: id, streamId: stream.id, path, originUs: probe.originUs });
      }
      const fixture = {
        assets,
        bindings,
        document: {
          canvas: {
            width: 320,
            height: 180,
            fps: { numerator: 10, denominator: 1 },
            background: "#000000ff",
          },
          tracks: [
            { id: "video", kind: "video", order: 0 },
            { id: "audio", kind: "audio", order: 0 },
          ],
          groups: [],
          syncGroups: [],
          processing: [],
          clips: bindings.map((binding) => ({
            id: binding.assetId,
            assetId: binding.assetId,
            streamId: binding.streamId,
            trackId: binding.assetId,
            source: { kind: "range", range: { startUs: 0, endUs: 60000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 60000000 } },
          })),
        },
      };
      const request = compile(fixture, 60000000, join(home, "canceled.mp4"));
      const controller = new AbortController();
      let observedPid, partial;
      const checked = async (...args) => {
        const result = await run(...args);
        if (args[0] === "storage.clearRenderWorkspace") return result;
        assert.ok(observedPid);
        assert.throws(() => process.kill(observedPid, 0), { code: "ESRCH" });
        await readFile(partial);
        return result;
      };
      const pending = projectMovieRenderer(checked, attempts).render(request, controller.signal);
      const rejected = assert.rejects(pending, (error) => {
        assert.equal(error, controller.signal.reason);
        return true;
      });
      partial = await until(() => assemblyFile(attempts));
      observedPid = await until(nativePid);
      controller.abort();
      await rejected;
      assert.deepEqual(await readdir(attempts), []);
      await assert.rejects(
        projectMovieRenderer(
          (op, params, options) =>
            run(
              op,
              params,
              op === "storage.clearRenderWorkspace" ? options : { ...options, timeoutMs: 150 },
            ),
          attempts,
        ).render({ ...request, output: join(home, "timeout.mp4") }, new AbortController().signal),
        { code: "MEDIA_WORKER_TIMEOUT" },
      );
      assert.deepEqual(await readdir(attempts), []);
      const receipt = await projectMovieRenderer(run, attempts).render(
        compile(fixture, 1000000, join(home, "success.mp4")),
        new AbortController().signal,
      );
      assert.ok((await readFile(receipt.file)).length > 0);
      assert.equal(receipt.audio.frames, 48000);
      const audioProbe = JSON.parse(
        await command("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a",
          "-show_entries",
          "stream=codec_name",
          "-of",
          "json",
          receipt.file,
        ]),
      );
      assert.deepEqual(
        audioProbe.streams.map((stream) => stream.codec_name),
        ["aac"],
      );
      assert.deepEqual(await readdir(attempts), []);
      await assert.rejects(
        projectMovieRenderer(run, attempts).render(
          {
            ...request,
            output: join(home, "failed.mp4"),
            assets: bindings.map((binding) =>
              binding.assetId === "audio"
                ? { ...binding, path: join(home, "missing.mov") }
                : binding,
            ),
          },
          new AbortController().signal,
        ),
        { code: "NATIVE_DECODE_FAILED" },
      );
      assert.deepEqual(await readdir(attempts), []);
      const restart = [];
      for (const preparation of [false, true])
        restart.push(
          await orphanedWorker(
            {
              fixture,
              source,
              attemptParent: attempts,
              output: join(home, `orphan-${preparation}.mp4`),
            },
            preparation,
            run,
          ),
        );
      const external = join(home, "external"),
        moved = join(home, "moved-attempts");
      await mkdir(external);
      await writeFile(join(external, "sentinel"), "outside");
      await symlink(external, join(attempts, "abandoned-link"));
      // Only startup admission clears stale siblings; live attempts clean their own child.
      await clearRenderWorkspace(run, attempts, new AbortController().signal);
      // This consumer deliberately replaces the parent after reading the artifact.
      // Exercise the shared attempt lifetime directly because publication normally copies it.
      const short = compile(fixture, 1000000, join(home, "replacement.mp4"));
      await withRenderAttempt(
        run,
        attempts,
        new AbortController().signal,
        async (directory, worker) => {
          const frames = join(directory, "frames.jsonl"),
            file = join(directory, "movie.mp4");
          await writeFile(
            frames,
            [...short.window.frames()].map((frame) => JSON.stringify(frame) + "\n").join(""),
          );
          return nativeResult(
            await worker("media.renderCompositionMovie", {
              output: file,
              frames,
              range: short.window.manifest.range,
              canvas: short.window.manifest.canvas,
              settings: short.settings,
              processing: short.window.processing(),
              assets: short.assets,
              fonts: [],
              audio: { range: short.window.manifest.sampleRange, clips: [...short.window.audio()] },
            }),
          );
        },
        async (media) => {
          assert.ok((await readFile(media.file)).length > 0);
          await rename(attempts, moved);
          await symlink(external, attempts);
        },
      );
      assert.equal(await readFile(join(external, "sentinel"), "utf8"), "outside");
      assert.deepEqual(await readdir(moved), []);
      assert.deepEqual(await readdir(external), ["sentinel"]);
      assert.deepEqual(await readFile(source), before[0]);
      assert.deepEqual(await readFile(audio), before[1]);
      console.log(
        JSON.stringify({
          // The deleted in-process MovieTests hook is not a worker-lifetime proof.
          nativeFinalizationPhase:
            "pending: exact writer-finishing cancellation and sibling-pump failure",

          restart,
          descriptorCleanupSurvivedReplacement: true,
          externalSentinelUnchanged: true,
          abortAfterAssemblyStarted: true,
          closedBeforeReclaim: true,
          deadlineReclaimed: true,
          successfulAudioFrames: receipt.audio.frames,
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
