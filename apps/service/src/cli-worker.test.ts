import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliWorker } from "./worker.js";
let directory: string;
let runner: string;
beforeAll(async () => {
  directory = await mkdtemp("/tmp/yap-cli-worker-");
  runner = join(directory, "runner");
  await writeFile(
    runner,
    `#!${process.execPath}\nprocess.on('exit',code=>require('node:fs').writeSync(Number(process.argv[3]),String(code)+'\\n'));process.stdout.write(Buffer.from([0,255,10,128]));process.stderr.write('diagnostics');`,
    { mode: 0o755 },
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("raw command output remains binary and finishes only after process exit/drain", async () => {
  const result = await cliWorker({ executable: "/ignored", ownerExecutable: runner, args: [] });
  expect(result.ok).toBe(true);
  if (result.ok) {
    const data = result.data as { stdout: Buffer; stderr: string; exitCode: number };
    expect(data.stdout).toEqual(Buffer.from([0, 255, 10, 128]));
    expect(data.stderr).toBe("diagnostics");
    expect(data.exitCode).toBe(0);
  }
});

it("progress-like output is not completion, and timeout retires the process", async () => {
  const hold = join(directory, "hold");
  await writeFile(
    hold,
    `#!${process.execPath}\nprocess.on('exit',code=>require('node:fs').writeSync(Number(process.argv[3]),String(code)+'\\n'));process.stdout.write('progress=end\\n');setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  expect(
    await cliWorker(
      { executable: "/ignored", ownerExecutable: hold, args: [] },
      { timeoutMs: 300 },
    ),
  ).toMatchObject({ ok: false, error: { code: "MEDIA_WORKER_TIMEOUT" } });
});
it("noisy diagnostics and malformed JSON fail within the output bound", async () => {
  const noisy = join(directory, "noisy");
  await writeFile(
    noisy,
    `#!${process.execPath}\nprocess.on('exit',code=>require('node:fs').writeSync(Number(process.argv[3]),String(code)+'\\n'));process.stderr.write('x'.repeat(10000));setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  expect(
    await cliWorker(
      { executable: "/ignored", ownerExecutable: noisy, args: [] },
      { maxBytes: 100 },
    ),
  ).toMatchObject({ ok: false, error: { code: "LIMIT_EXCEEDED" } });
  expect(
    await cliWorker(
      { executable: "/ignored", ownerExecutable: runner, args: [] },
      { output: "json" },
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "INVALID_RESPONSE", message: "CLI returned malformed JSON" },
  });
});
it("nonzero exit cannot certify buffered output", async () => {
  const failed = join(directory, "failed");
  await writeFile(
    failed,
    `#!${process.execPath}\nprocess.on('exit',code=>require('node:fs').writeSync(Number(process.argv[3]),String(code)+'\\n'));process.stdout.write('{}');process.stderr.write('chosen diagnostic');process.exitCode=3;`,
    { mode: 0o755 },
  );
  expect(
    await cliWorker(
      { executable: "/ignored", ownerExecutable: failed, args: [] },
      { output: "json" },
    ),
  ).toMatchObject({ ok: false, error: { details: { exitCode: 3, stderr: "chosen diagnostic" } } });
});

it("JSON decoding refuses invalid UTF-8 rather than changing returned facts", async () => {
  const invalid = join(directory, "invalid-utf8");
  await writeFile(
    invalid,
    `#!${process.execPath}\nprocess.on('exit',code=>require('node:fs').writeSync(Number(process.argv[3]),String(code)+'\\n'));process.stdout.write(Buffer.from([123,34,120,34,58,34,255,34,125]));`,
    { mode: 0o755 },
  );
  expect(
    await cliWorker(
      { executable: "/ignored", ownerExecutable: invalid, args: [] },
      { output: "json" },
    ),
  ).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
});

it("cancellation remains visible while completed command ownership retires", async () => {
  const controller = new AbortController();
  const kill = process.kill.bind(process);
  let held = false;
  const observer = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 0 && !held) {
      held = true;
      controller.abort();
      return true;
    }
    return kill(pid, signal);
  });
  try {
    expect(
      await cliWorker(
        { executable: "/ignored", ownerExecutable: runner, args: [] },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { code: "CANCELED" } });
  } finally {
    observer.mockRestore();
  }
});

it("malformed and duplicated private completion cannot certify a command", async () => {
  for (const completion of ["x\n", "0\n0\n"]) {
    const invalid = join(directory, "invalid-completion");
    await writeFile(
      invalid,
      `#!${process.execPath}\nrequire('node:fs').writeSync(Number(process.argv[3]),${JSON.stringify(completion)});setInterval(()=>{},1000);`,
      { mode: 0o755 },
    );
    expect(
      await cliWorker({ executable: "/ignored", ownerExecutable: invalid, args: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "CLI completion is malformed or duplicated" },
    });
  }
});
