import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mediaWorker, nativeResult, type MediaWorker } from "./worker.js";
import { clearRenderWorkspace, withRenderedFile, withRenderAttempt } from "./render.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp("/tmp/yap-render-attempt-");
  homes.push(home);
  const executable = join(home, "worker");
  const parent = join(home, "attempts");
  await mkdir(parent, { mode: 0o700 });
  await writeFile(
    executable,
    `#!${process.execPath}
import {mkdirSync,writeFileSync,readdirSync,rmSync,fstatSync,statSync,rmdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
let text=''; process.stdin.on('data',x=>text+=x); process.stdin.on('end',()=>{
 const {operation,params}=JSON.parse(text);
 if(operation==='storage.clearRenderWorkspace') {
  const parent=${JSON.stringify(parent)};
  const opened=fstatSync(3,{bigint:true});
  if(String(opened.dev)!==params.expectedDirectory.dev || String(opened.ino)!==params.expectedDirectory.ino) throw Error('Wrong cleanup descriptor');
  const directory=[parent,...readdirSync(parent).map(name=>join(parent,name))].find(path=>{
   const stat=statSync(path,{bigint:true});return stat.dev===opened.dev && stat.ino===opened.ino;
  });
  if(!directory) throw Error('Unknown cleanup directory');
  for(const name of readdirSync(directory)) rmSync(join(directory,name),{recursive:true,force:true});
  if(params.parent) {
   const root=fstatSync(4,{bigint:true});
   if(String(root.dev)!==params.parent.expectedDirectory.dev || String(root.ino)!==params.parent.expectedDirectory.ino || join(parent,params.parent.name)!==directory) throw Error('Wrong cleanup parent');
   rmdirSync(directory);
  }
  process.stdout.write(JSON.stringify({ok:true,data:{removed:true}})+'\\n'); return;
 }
 const dir=dirname(params.output);
 mkdirSync(join(dir,'.movie-render-held')); writeFileSync(join(dir,'.movie-render-held','partial'),'partial');
 writeFileSync(join(dir,'pid'),String(process.pid));
 if(params.source==='malformed') process.stdout.write('not-json\\n');
 if(params.source==='crash') process.exit(19);
 if(params.source==='success') {
  writeFileSync(params.output,'finished');
  process.stdout.write(JSON.stringify({ok:true,data:{file:params.output,mediaType:'video/mp4',codec:'h264',durationUs:30000000,width:2,height:2,frameCount:1,bytes:8}})+'\\n');
 }
 setInterval(()=>{},1000);
});`,
  );
  await chmod(executable, 0o755);
  return { home, parent, executable, run: mediaWorker({ YAP_NATIVE: executable }) };
}
async function ready(parent: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    for (const dir of await readdir(parent)) {
      try {
        return {
          pid: Number(await readFile(join(parent, dir, "pid"), "utf8")),
          dir: join(parent, dir),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await delay(5);
  }
  throw new Error("Worker never reached staging");
}

it("first-use render initializes its absent parent and retires only its owned attempt", async () => {
  const { parent, run } = await fixture();
  await rm(parent, { recursive: true });
  const result = await withRenderAttempt(
    run,
    parent,
    new AbortController().signal,
    async (directory) => {
      const path = join(directory, "derivative.mov");
      await writeFile(path, "completed derivative");
      return path;
    },
    async (path) => readFile(path, "utf8"),
  );
  expect(result).toBe("completed derivative");
  expect(await readdir(parent)).toEqual([]);
});

it("deadline failure reclaims the closed attempt and preserves its reason", async () => {
  const { parent, run } = await fixture();
  const worker: MediaWorker = (operation, params, options) =>
    run(
      operation,
      params,
      operation === "storage.clearRenderWorkspace" ? options : { ...options, timeoutMs: 250 },
    );
  await expect(
    withRenderAttempt(
      worker,
      parent,
      new AbortController().signal,
      async (directory, execute) =>
        nativeResult(
          await execute("media.renderCompositionFrame", {
            source: "hold",
            output: join(directory, "frame.png"),
          }),
        ),
      async () => null,
    ),
  ).rejects.toMatchObject({ code: "MEDIA_WORKER_TIMEOUT", retryable: true });
  expect(await readdir(parent)).toEqual([]);
});
it.each(["malformed", "crash"])(
  "%s response closes the process before removing partial staging",
  async (source) => {
    const { parent, run } = await fixture();
    const worker: MediaWorker = async (...args) => {
      const result = await run(...args);
      if (args[0] !== "storage.clearRenderWorkspace") {
        const current = await ready(parent);
        expect(() => process.kill(current.pid, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }),
        );
        expect(await readFile(join(current.dir, ".movie-render-held", "partial"), "utf8")).toBe(
          "partial",
        );
      }
      return result;
    };
    await expect(
      withRenderAttempt(
        worker,
        parent,
        new AbortController().signal,
        async (directory, execute) =>
          nativeResult(
            await execute("media.renderCompositionFrame", {
              source,
              output: join(directory, "frame.png"),
            }),
          ),
        async () => {
          throw new Error("must not consume");
        },
      ),
    ).rejects.toMatchObject({
      code: source === "malformed" ? "INVALID_RESPONSE" : "MEDIA_WORKER_FAILED",
    });
    expect(await readdir(parent)).toEqual([]);
  },
);
it("abort after native publication but before receipt prevents consumption", async () => {
  const { parent, run } = await fixture();
  const controller = new AbortController();
  const worker: MediaWorker = async (...args) => {
    const result = await run(...args);
    if (args[0] === "storage.clearRenderWorkspace") return result;
    expect(result.ok).toBe(true);
    controller.abort();
    return result;
  };
  await expect(
    withRenderAttempt(
      worker,
      parent,
      controller.signal,
      async (directory, execute) =>
        nativeResult(
          await execute("media.renderCompositionFrame", {
            source: "success",
            output: join(directory, "frame.png"),
          }),
        ),
      async () => {
        throw new Error("must not consume");
      },
    ),
  ).rejects.toMatchObject({ code: "CANCELED" });
  expect(await readdir(parent)).toEqual([]);
});
it("successful consumption and consumer failure both end their attempt lifetime", async () => {
  const { parent, run } = await fixture();
  const produce = async (directory: string, execute: MediaWorker) => {
    const file = join(directory, "frame.png");
    nativeResult(
      await execute("media.renderCompositionFrame", { source: "success", output: file }),
    );
    return file;
  };
  expect(
    await withRenderAttempt(run, parent, new AbortController().signal, produce, async (file) =>
      readFile(file, "utf8"),
    ),
  ).toBe("finished");
  await expect(
    withRenderAttempt(run, parent, new AbortController().signal, produce, async () => {
      throw new Error("consumer failed");
    }),
  ).rejects.toThrow("consumer failed");
  expect(await readdir(parent)).toEqual([]);
});

it("abort during consumption preserves consumer-owned effects while reclaiming the attempt", async () => {
  const { parent, run } = await fixture();
  const controller = new AbortController();
  await expect(
    withRenderAttempt(
      run,
      parent,
      controller.signal,
      async (directory, execute) =>
        nativeResult(
          await execute("media.renderCompositionFrame", {
            source: "success",
            output: join(directory, "frame.png"),
          }),
        ),
      async () => {
        await writeFile(join(parent, "..", "consumer-owned"), "committed by consumer");
        controller.abort();
        return "late";
      },
    ),
  ).rejects.toMatchObject({ code: "CANCELED" });
  expect(await readFile(join(parent, "..", "consumer-owned"), "utf8")).toBe(
    "committed by consumer",
  );
  expect(await readdir(parent)).toEqual([]);
});

it("does not retry failed startup cleanup", async () => {
  const { parent } = await fixture();
  await writeFile(join(parent, "abandoned"), "retain");
  let calls = 0;
  const failed: MediaWorker = async () => {
    calls++;
    return {
      ok: false,
      error: {
        code: "DELETE_FAILED",
        message: "owned cleanup failed",
        retryable: true,
        details: {},
      },
    };
  };
  await expect(
    clearRenderWorkspace(failed, parent, new AbortController().signal),
  ).rejects.toMatchObject({ code: "DELETE_FAILED" });
  expect(calls).toBe(1);
  expect(await readFile(join(parent, "abandoned"), "utf8")).toBe("retain");
});

it("refuses non-private and linked workspaces without native cleanup", async () => {
  const { parent } = await fixture();
  const sentinel = join(parent, "sentinel");
  await writeFile(sentinel, "retain");
  const unused: MediaWorker = async () => {
    throw new Error("must not run native cleanup");
  };
  await chmod(parent, 0o755);
  await expect(
    withRenderAttempt(
      unused,
      parent,
      new AbortController().signal,
      async () => {
        throw new Error("must not render");
      },
      async () => null,
    ),
  ).rejects.toMatchObject({ code: "INVALID_STORAGE" });
  await chmod(parent, 0o700);
  const linked = join(parent, "..", "linked");
  await symlink(parent, linked);
  await expect(
    withRenderAttempt(
      unused,
      linked,
      new AbortController().signal,
      async () => {
        throw new Error("must not render");
      },
      async () => null,
    ),
  ).rejects.toMatchObject({ code: "INVALID_STORAGE" });
  expect(await readFile(sentinel, "utf8")).toBe("retain");
});

it("producer cancellation waits for its bound worker before cleanup", async () => {
  const { parent, run } = await fixture();
  const controller = new AbortController();
  const pending = withRenderAttempt(
    run,
    parent,
    controller.signal,
    async (directory, worker) =>
      nativeResult(
        await worker("media.presentationEvidence", {
          source: "hold",
          output: join(directory, "presentation.jsonl"),
        }),
      ),
    async () => {
      throw new Error("must not consume");
    },
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELED" });
  const current = await ready(parent);
  controller.abort();
  await rejected;
  expect(() => process.kill(current.pid, 0)).toThrowError(
    expect.objectContaining({ code: "ESRCH" }),
  );
  expect(await readdir(parent)).toEqual([]);
});

it("startup admission skips absent workspaces and clears existing stale staging once", async () => {
  const { parent, run } = await fixture();
  let calls = 0;
  const counted: MediaWorker = async (...args) => {
    calls++;
    return run(...args);
  };
  const missing = join(parent, "..", "not-created");
  await clearRenderWorkspace(counted, missing, new AbortController().signal);
  expect(calls).toBe(0);
  await expect(readdir(missing)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(parent, "abandoned"), "staging");
  await clearRenderWorkspace(counted, parent, new AbortController().signal);
  expect(calls).toBe(1);
  expect(await readdir(parent)).toEqual([]);
});

it("startup cancellation during cleanup settles after cleanup and releases authority", async () => {
  const { parent, run } = await fixture();
  const controller = new AbortController();
  await writeFile(join(parent, "abandoned"), "staging");
  const worker: MediaWorker = async (...args) => {
    const result = await run(...args);
    controller.abort();
    return result;
  };
  await expect(clearRenderWorkspace(worker, parent, controller.signal)).rejects.toMatchObject({
    code: "CANCELED",
  });
  expect(await readdir(parent)).toEqual([]);
  await clearRenderWorkspace(run, parent, new AbortController().signal);
});

it.each(["audio.wav", "frame.png"] as const)(
  "%s attempts retain only their completed output and reject a substituted receipt path",
  async (filename) => {
    const { home, parent, run } = await fixture();
    const output = join(home, "audio.cache");
    const produce = async (file: string, worker: MediaWorker) =>
      nativeResult(await worker("media.mixCompositionAudio", { source: "success", output: file }));
    const signal = new AbortController().signal;
    const receipt = await withRenderedFile(
      run,
      { attemptParent: parent, output, filename },
      signal,
      produce,
    );
    expect(receipt).toMatchObject({ file: output, bytes: 8 });
    expect(await readFile(output, "utf8")).toBe("finished");
    expect(await readdir(parent)).toEqual([]);
    // The cache reservation is exclusive even when an older file already occupies its path.
    await expect(
      withRenderedFile(run, { attemptParent: parent, output, filename }, signal, produce),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(output, "utf8")).toBe("finished");
    expect(await readdir(parent)).toEqual([]);
    const substituted = join(home, "unrelated.cache");
    await expect(
      withRenderedFile(
        run,
        { attemptParent: parent, output: substituted, filename },
        signal,
        async (file, worker) => {
          await produce(file, worker);
          return { file: output };
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(readFile(substituted)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(parent)).toEqual([]);
  },
);

it("audio abort reclaims native side staging after child close without publishing cache bytes", async () => {
  const { home, parent, run } = await fixture();
  const output = join(home, "audio.cache");
  const controller = new AbortController();
  const worker: MediaWorker = async (...args) => {
    const result = await run(...args);
    if (args[0] !== "storage.clearRenderWorkspace") {
      const active = await ready(parent);
      expect(() => process.kill(active.pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
      expect(await readFile(join(active.dir, ".movie-render-held", "partial"), "utf8")).toBe(
        "partial",
      );
    }
    return result;
  };
  const pending = withRenderedFile(
    worker,
    { attemptParent: parent, output, filename: "audio.wav" },
    controller.signal,
    async (file, worker) =>
      nativeResult(await worker("media.mixCompositionAudio", { source: "hold", output: file })),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELED" });
  const active = await ready(parent);
  controller.abort();
  await rejected;
  expect(() => process.kill(active.pid, 0)).toThrowError(
    expect.objectContaining({ code: "ESRCH" }),
  );
  expect(await readdir(parent)).toEqual([]);
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("audio owner SIGKILL preserves the orphan child's lock until restart can reclaim staging", async () => {
  const { home, parent, executable, run } = await fixture();
  // Launch freshly stripped source, not a possibly stale dist build, in a separate service owner.
  const require = createRequire(import.meta.url);
  for (const name of ["render", "worker"])
    await writeFile(
      join(home, `${name}.mjs`),
      stripTypeScriptTypes(await readFile(new URL(`./${name}.ts`, import.meta.url), "utf8"))
        .replace('"./worker.js"', '"./worker.mjs"')
        .replace(/"(@yap\/[^"]+)"/g, (_, specifier: string) =>
          JSON.stringify(pathToFileURL(require.resolve(specifier)).href),
        ),
    );
  const output = join(home, "audio.cache");
  const code = `
    import {withRenderedFile} from ${JSON.stringify(pathToFileURL(join(home, "render.mjs")).href)};
    import {mediaWorker,nativeResult} from ${JSON.stringify(pathToFileURL(join(home, "worker.mjs")).href)};
    await withRenderedFile(mediaWorker({YAP_NATIVE:${JSON.stringify(executable)}}),
      {attemptParent:${JSON.stringify(parent)},output:${JSON.stringify(output)},filename:"audio.wav"},
      new AbortController().signal,async(output,worker)=>nativeResult(await worker('media.mixCompositionAudio',{source:'hold',output})));
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  owner.stderr.on("data", (bytes) => {
    errors += bytes.toString();
  });
  const closed = once(owner, "close");
  let nativePid: number | undefined;
  const killNative = async () => {
    if (!nativePid) return;
    try {
      process.kill(nativePid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await expect
      .poll(
        () => {
          try {
            process.kill(nativePid!, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
            throw error;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    nativePid = undefined;
  };
  try {
    const active = await ready(parent).catch((error) => {
      throw new Error(`${error.message}: ${errors}`);
    });
    nativePid = active.pid;
    owner.kill("SIGKILL");
    const [code, signal] = await closed;
    expect(code).toBeNull();
    expect(signal).toBe("SIGKILL");
    expect(() => process.kill(nativePid!, 0)).not.toThrow();
    const staged = await readdir(parent);
    expect(staged).toHaveLength(1);
    await expect(
      clearRenderWorkspace(run, parent, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RENDER_WORKSPACE_BUSY", retryable: true });
    expect(await readdir(parent)).toEqual(staged);
    expect(await readFile(join(active.dir, ".movie-render-held", "partial"), "utf8")).toBe(
      "partial",
    );
    await killNative();
    await clearRenderWorkspace(run, parent, new AbortController().signal);
    expect(await readdir(parent)).toEqual([]);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    owner.kill("SIGKILL");
    await closed;
    await killNative();
  }
}, 15000);

it("parallel attempt cancellation leaves the other worker and its staging intact", async () => {
  const { home, parent, run } = await fixture();
  const controllers = [new AbortController(), new AbortController()];
  const start = (index: number) =>
    withRenderedFile(
      run,
      {
        attemptParent: parent,
        output: join(home, `concurrent-${index}.cache`),
        filename: index === 0 ? "audio.wav" : "frame.png",
      },
      controllers[index]!.signal,
      async (output, worker) =>
        nativeResult(await worker("media.mixCompositionAudio", { source: "hold", output })),
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const first = start(0);
  const settled = [first];
  try {
    const active = await ready(parent);
    const second = start(1);
    settled.push(second);
    await expect.poll(async () => (await readdir(parent)).length).toBe(2);
    const secondDirectory = join(
      parent,
      (await readdir(parent)).find((name) => join(parent, name) !== active.dir)!,
    );
    await expect
      .poll(async () => readFile(join(secondDirectory, "pid"), "utf8").catch(() => ""))
      .not.toBe("");
    const secondPid = Number(await readFile(join(secondDirectory, "pid"), "utf8"));
    await expect(
      clearRenderWorkspace(run, parent, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RENDER_WORKSPACE_BUSY" });
    controllers[0]!.abort();
    expect(await first).toMatchObject({ error: { code: "CANCELED" } });
    expect(await readdir(parent)).toEqual([secondDirectory.slice(parent.length + 1)]);
    expect(() => process.kill(secondPid, 0)).not.toThrow();
    expect(await readFile(join(secondDirectory, ".movie-render-held", "partial"), "utf8")).toBe(
      "partial",
    );
    await expect(
      clearRenderWorkspace(run, parent, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RENDER_WORKSPACE_BUSY" });
    controllers[1]!.abort();
    expect(await second).toMatchObject({ error: { code: "CANCELED" } });
    expect(await readdir(parent)).toEqual([]);
    await clearRenderWorkspace(run, parent, new AbortController().signal);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(settled);
  }
});

it.runIf(Boolean(process.env.YAP_NATIVE))(
  "native cleanup uses each attempt authority while the shared root excludes startup",
  async () => {
    const { home, parent } = await fixture();
    const native = mediaWorker({ YAP_NATIVE: process.env.YAP_NATIVE });
    const gate = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const release = [gate<void>(), gate<void>()];
    const entered = [gate<string>(), gate<string>()];
    const requests = release.map((gate, index) =>
      withRenderedFile(
        native,
        {
          attemptParent: parent,
          output: join(home, `native-${index}.cache`),
          filename: index === 0 ? "audio.wav" : "frame.png",
        },
        new AbortController().signal,
        async (file) => {
          await writeFile(file, `retained-${index}`);
          entered[index]!.resolve(file);
          await gate.promise;
          return { file, bytes: 10 };
        },
      ),
    );
    // Retain rejection handlers while both requests are intentionally held.
    const all = Promise.allSettled(requests);
    try {
      const files = await Promise.race([
        Promise.all(entered.map((value) => value.promise)),
        Promise.all(requests).then(() => {
          throw new Error("Attempt completed before release");
        }),
      ]);
      expect(await readdir(parent)).toHaveLength(2);
      await expect(
        clearRenderWorkspace(native, parent, new AbortController().signal),
      ).rejects.toMatchObject({ code: "RENDER_WORKSPACE_BUSY" });
      release[0]!.resolve();
      expect(await requests[0]).toMatchObject({ file: join(home, "native-0.cache") });
      expect(await readFile(join(home, "native-0.cache"), "utf8")).toBe("retained-0");
      expect(await readFile(files[1]!, "utf8")).toBe("retained-1");
      expect(await readdir(parent)).toHaveLength(1);
      await expect(
        clearRenderWorkspace(native, parent, new AbortController().signal),
      ).rejects.toMatchObject({ code: "RENDER_WORKSPACE_BUSY" });
      release[1]!.resolve();
      expect(await requests[1]).toMatchObject({ file: join(home, "native-1.cache") });
      expect(await readdir(parent)).toEqual([]);
      await clearRenderWorkspace(native, parent, new AbortController().signal);
    } finally {
      release.forEach((value) => value.resolve());
      await all;
    }
  },
  10000,
);

it.runIf(Boolean(process.env.YAP_NATIVE))(
  "attempt cleanup survives renamed parent without touching a replacement directory",
  async () => {
    const { home, parent } = await fixture();
    const native = mediaWorker({ YAP_NATIVE: process.env.YAP_NATIVE });
    const moved = join(home, "moved"),
      external = join(home, "outside");
    await mkdir(external, { mode: 0o700 });
    let attemptName = "";
    await withRenderAttempt(
      native,
      parent,
      new AbortController().signal,
      async (directory) => {
        attemptName = basename(directory);
        await writeFile(join(directory, "owned"), "rendered");
        return directory;
      },
      async (directory) => {
        expect(await readFile(join(directory, "owned"), "utf8")).toBe("rendered");
        await rename(parent, moved);
        await symlink(external, parent);
        await mkdir(join(external, attemptName));
      },
    );
    expect(await readdir(external)).toEqual([attemptName]);
    expect(await readdir(moved)).toEqual([]);
  },
);
