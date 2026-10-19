import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { mediaWorker } from "../../dist/worker.js";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { fixture, nativeBinary } from "./project-export.mjs";

export async function killExportOwner(f, gap, extra = {}) {
  const existing = {
    home: f.home,
    output: f.output,
    projectId: f.projectId,
    asset: { id: f.asset.id },
    placed: { revision: { id: f.placed.revision.id } },
    ...extra,
  };
  const child = fork(fileURLToPath(import.meta.url), [JSON.stringify(existing), gap], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, YAP_NATIVE: nativeBinary },
  });
  const closed = once(child, "close");
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(20000) });
    assert.deepEqual(message, { gap });
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await closed, [null, "SIGKILL"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

export async function crashFixture(t, gap, wrap, kind = "video") {
  const f = await fixture(t, { admission: false });
  const request = {
    ...f.request(),
    kind,
    leaf: kind === "processed-package" ? "recovered.zip" : "recovered.mp4",
  };
  await f.exports.create(request);
  await f.jobs.idle();
  await f.close();
  await killExportOwner(f, gap);
  const reopened = await fixture(t, { existing: f, wrap });
  return { f, reopened, exportId: request.exportId };
}

export async function receiptCrash(t, mode = "write") {
  let interruptedWorker,
    interrupt = true;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (op, ...args) => {
        if (op === "publication.prepare" && interrupt) {
          interrupt = false;
          return interruptedWorker(op, ...args);
        }
        return run(op, ...args);
      },
  });
  const library = join(f.home, "receipt-fault.dylib"),
    executable = join(f.home, "receipt-fault-worker");
  const compiled = spawnSync(
    "/usr/bin/clang",
    [
      "-dynamiclib",
      resolve("helpers/mac/Tests/fixtures/publication-write-interpose.c"),
      "-o",
      library,
    ],
    { encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    executable,
    `#!/bin/sh\nYAP_RECEIPT_FAULT=${quote(mode)} DYLD_INSERT_LIBRARIES=${quote(library)} exec ${quote(nativeBinary)}\n`,
    { mode: 0o700 },
  );
  interruptedWorker = mediaWorker({ YAP_NATIVE: executable });
  const request = { ...f.request(), leaf: "retry.mp4" };
  await f.exports.create(request);
  await f.jobs.idle();
  return {
    f,
    exportId: request.exportId,
    stage: join(f.output, ".yap-export-" + request.exportId),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(typeof process.send, "function");
  // The parent ends this owner with SIGKILL at the requested native/catalog gap.
  process.on("message", () => {});
  const existing = JSON.parse(process.argv[2]),
    gap = process.argv[3];
  const crashed = await fixture(
    { after() {} },
    {
      existing,
      wrap:
        (run) =>
        async (op, ...args) => {
          if (
            (gap === "ack" && op === "publication.acknowledge") ||
            (gap === "package-copy" && op === "archive.write")
          ) {
            process.send({ gap });
            await new Promise(() => {});
          }
          if (gap === "package-survivor" && op === "archive.write") {
            const environment = {
              DYLD_INSERT_LIBRARIES: existing.library,
              YAP_TEST_COPY_BARRIER: existing.marker,
              YAP_TEST_COPY_PARTIAL: "0",
              YAP_TEST_COPY_MIN_FD: "6",
            };
            const previous = Object.fromEntries(
              Object.keys(environment).map((key) => [key, process.env[key]]),
            );
            Object.assign(process.env, environment);
            try {
              return run(op, ...args);
            } finally {
              for (const key of Object.keys(environment)) {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
              }
            }
          }
          const result = await run(op, ...args);
          if (
            (gap === "commit" && op === "publication.commit") ||
            (gap === "allocate" && op === "publication.allocate") ||
            (gap === "abandon" && op === "publication.retire") ||
            (gap === "package-create" && op === "packageWorkspace.create") ||
            (gap === "package-write" && op === "archive.write") ||
            (gap === "package-commit" && op === "publication.commit") ||
            (gap === "package-cleanup" && op === "packageWorkspace.remove")
          ) {
            process.send({ gap });
            await new Promise(() => {});
          }
          return result;
        },
    },
  );
  if (gap === "abandon") await crashed.exports.abandon(existing.exportId);
  await crashed.jobs.idle();
  process.send({
    gapNotReached: gap,
    jobs: crashed.catalog.catalog.prepare("SELECT artifact,state,reason,errorCode FROM jobs").all(),
  });
}
