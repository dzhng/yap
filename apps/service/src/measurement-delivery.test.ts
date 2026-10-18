import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { startProjectService } from "./project-service.js";
import { probeFileFixture } from "./project-service.fixture.js";
import { compileCliOwner } from "./cli-owner.fixture.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
// Compiling the real Swift owner is setup, not the behavior under test, and takes seconds on a
// loaded machine, so it runs once with its own budget.
let ownerDirectory: string;
let nativeExecutable: string;
beforeAll(async () => {
  ownerDirectory = await mkdtemp("/tmp/yap-measure-owner-");
  nativeExecutable = await compileCliOwner(ownerDirectory);
}, 120_000);
afterAll(() => rm(ownerDirectory, { recursive: true, force: true }));
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const main = new URL("../../cli/dist/main.js", import.meta.url).pathname;
async function run(socket: string, operation: string, params: unknown, args: string[] = []) {
  const child = spawn(
    process.execPath,
    [main, operation, "--socket", socket, "--params", JSON.stringify(params), ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (p) => {
    stdout += p;
  });
  child.stderr.on("data", (p) => {
    stderr += p;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, result: JSON.parse(stdout), stderr };
}

test("production service measurement leases deliver complete JSON to CLI and MCP without reopening cache paths", async () => {
  const home = await mkdtemp("/tmp/yap-measure-delivery-");
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "tools");
  await mkdir(join(directory, "bin"), { recursive: true });
  const summary =
    "Summary:\nIntegrated loudness:\n I: -23.0 LUFS\n Threshold: -33.0 LUFS\nLoudness range:\n LRA: 2.0 LU\n Threshold: -43.0 LUFS\n LRA low: -24.0 LUFS\n LRA high: -22.0 LUFS\nSample peak:\n Peak: -4.0 dBFS\nTrue peak:\n Peak: -3.5 dBFS\n";
  const files: Record<string, string> = {};
  for (const name of ["ffmpeg", "ffprobe"]) {
    const script = `#!${process.execPath}\nif (process.argv.includes('-version')) process.stdout.write('${name} version fixture Copyright\\nconfiguration: --disable-gpl --disable-nonfree\\n'); else process.stderr.write(${JSON.stringify(summary)});\n`;
    await writeFile(join(directory, "bin", name), script, { mode: 0o755 });
    files[`bin/${name}`] = sha(script);
  }
  const receipt = JSON.stringify({
    format: 1,
    version: "fixture",
    sourceSha256: "a".repeat(64),
    recipeSha256: "b".repeat(64),
    files,
  });
  await writeFile(join(directory, "receipt.json"), receipt);
  const wave = Buffer.from(
    "524946462800000057415645666d7420100000000300010080bb000000ee02000400200064617461040000000000803e",
    "hex",
  );
  const source = join(home, "source.wav");
  await writeFile(source, wave);
  const service = await startProjectService({
    home,
    ffmpeg: { directory, receiptSha256: sha(receipt) },
    nativeExecutable,
    worker: probeFileFixture(home, async (operation, params) => {
      if (operation === "media.probe")
        return {
          ok: true,
          data: {
            originUs: 0,
            streams: [
              {
                id: "audio:1",
                kind: "audio",
                codec: "pcm",
                decodable: true,
                startUs: 0,
                endUs: 21,
                sampleRate: 48000,
                channels: 1,
                segments: [{ startUs: 0, endUs: 21, empty: false }],
              },
            ],
          },
        };
      if (operation !== "media.sourceAudio")
        throw Error(`Unexpected native operation ${operation}`);
      await writeFile(params.output as string, wave, { flag: "wx" });
      return {
        ok: true,
        data: {
          file: params.output,
          mediaType: "audio/wav",
          bytes: wave.length,
          sampleRate: 48000,
          channels: 1,
          layout: "mono",
          range: params.range,
          sampleRange: { start: 0, end: 1 },
          frames: 1,
          decodedFrames: 1,
          unavailable: [],
        },
      };
    }),
  });
  cleanups.push(() => service.close());
  const imported = await run(
    service.socketPath,
    "asset.import",
    { requestId: "source", path: source },
    ["--wait", "--timeout-ms", "3000"],
  );
  expect(imported.code, JSON.stringify(imported)).toBe(0);
  const params = { assetId: imported.result.data.published.output.assetId, streamId: "audio:1" };
  const output = join(home, "measurement.json");
  const measured = await run(service.socketPath, "audio.measure", params, [
    "--wait",
    "--timeout-ms",
    "5000",
    "--output",
    output,
  ]);
  expect(measured.code, JSON.stringify(measured)).toBe(0);
  const bytes = await readFile(output);
  const evidence = JSON.parse(bytes.toString());
  expect(evidence).toMatchObject({
    assetId: params.assetId,
    streamId: "audio:1",
    sampleRange: { start: 0, end: 1 },
    kind: "loudness",
    measurement: {
      samplePeakDbfs: -4,
      truePeakDbtp: -3.5,
      integratedReason: "insufficient-duration",
    },
  });
  const waveformOutput = join(home, "waveform.json");
  const waveform = await run(service.socketPath, "waveform.get", params, [
    "--wait",
    "--timeout-ms",
    "3000",
    "--output",
    waveformOutput,
  ]);
  expect(waveform.code, JSON.stringify(waveform)).toBe(0);
  const waveformBytes = await readFile(waveformOutput);
  expect(JSON.parse(waveformBytes.toString())).toMatchObject({
    sampleRange: { start: 0, end: 1 },
    buckets: [{ gridStart: 0, channels: [{ min: 0.25, max: 0.25, rms: 0.25 }] }],
  });
  const mcp = spawn(process.execPath, [main, "mcp", "--socket", service.socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(async () => {
    if (mcp.exitCode === null) {
      const exited = new Promise<void>((resolve) => mcp.once("exit", () => resolve()));
      mcp.stdin.end();
      await exited;
    }
  });
  const reply = await new Promise<{ isError?: boolean; content: { type: string; text: string }[] }>(
    (resolve, reject) => {
      let buffer = "";
      mcp.once("error", reject);
      mcp.stdout.on("data", (bytes) => {
        buffer += bytes;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.id === 1) {
            mcp.stdin.write(
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
            );
            mcp.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "audio.measure", arguments: params },
              }) + "\n",
            );
          } else if (message.id === 2) resolve(message.result);
        }
      });
      mcp.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "measurement-proof", version: "1" },
          },
        }) + "\n",
      );
    },
  );
  expect(reply.isError).not.toBe(true);
  expect(JSON.parse(reply.content[1]!.text)).toEqual(evidence);
  if (process.env.YAP_WAIT_EVIDENCE) {
    const evidenceDirectory = process.env.YAP_WAIT_EVIDENCE;
    await writeFile(join(evidenceDirectory, "measurement.json"), bytes);
    await writeFile(join(evidenceDirectory, "waveform.json"), waveformBytes);
    await writeFile(
      join(evidenceDirectory, "delivery-receipt.json"),
      JSON.stringify(
        {
          controls: {
            pcm: "one Float32 mono sample at 0.25, 48 kHz; native boundary fixture",
            meter: "fixed FFmpeg stderr summary; production parser and real native CLI lifetime",
          },
          params,
          imported: imported.result,
          measured: measured.result,
          waveform: waveform.result,
          mcp: reply,
        },
        null,
        2,
      ) + "\n",
    );
  }
  const { callLocal } = await import("@yap/client");
  expect(
    await callLocal(service.socketPath, {
      id: "closed",
      operation: "artifact.read",
      params: { token: measured.result.data.delivery.token, offsetBytes: 0 },
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_EXPIRED" } });
}, 15000);
