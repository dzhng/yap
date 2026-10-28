import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failure, launchedAs, runJsonHelper, us } from "./storyboard-io.mjs";

const BATCH = 8; // frame.batch's per-call limit

function sampleTimes(request) {
  const step = request.stepUs ?? 2_000_000;
  if (!Number.isSafeInteger(step) || step < 100_000)
    throw failure("INVALID_REQUEST", "stepUs must be an integer of at least 100000");
  const times = new Set((request.atUs ?? []).map((t) => Math.round(us(t))));
  for (const range of request.ranges ?? [])
    for (let t = Math.round(us(range.startUs)); t < us(range.endUs); t += step) times.add(t);
  if (!times.size) throw failure("INVALID_REQUEST", "Supply ranges or atUs to sample");
  return [...times].sort((a, b) => a - b);
}

/** One bounded `yap frame.batch --wait --output DIR` call; resolves the parsed JSON envelope. */
function frameBatch(cli, params, directory, timeoutMs) {
  const args = ["frame.batch", "--params", "-", "--wait", "--timeout-ms", String(timeoutMs)];
  args.push("--output", directory, ...(cli.socket ? ["--socket", cli.socket] : []));
  return new Promise((resolve, reject) => {
    const child = spawn(cli.executable ?? "yap", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(failure("CLI_TIMEOUT", "frame.batch exceeded its deadline", { timeoutMs }));
    }, timeoutMs + 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(failure("CLI_UNAVAILABLE", error.message));
    });
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          failure("INVALID_CLI_RESPONSE", "frame.batch did not return a JSON envelope", {
            exitCode,
          }),
        );
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(params));
  });
}

function stillsFrom(receipt, issues) {
  const stills = [];
  for (const item of receipt.data.items) {
    const data = item.data ?? {};
    const output = data.published?.output;
    if (!item.ok || data.state !== "ready" || !output || typeof data.output !== "string") {
      issues.push({
        code: "still-unavailable",
        message: `No still at ${item.atUs} us: ${item.error?.code ?? data.reason ?? data.state}`,
        evidence: { atUs: item.atUs },
      });
      continue;
    }
    const scale = output.sourceWidth / output.width;
    const faces = (output.faceObservations?.faces ?? []).map(
      ({ boundingBox: box, confidence }) => ({
        x: box.x * scale,
        y: box.y * scale,
        width: box.width * scale,
        height: box.height * scale,
        confidence,
      }),
    );
    if (output.faceObservations && output.faceObservations.status !== "available")
      issues.push({
        code: "faces-unavailable",
        message: `Face observations ${output.faceObservations.status} at ${item.atUs} us`,
        evidence: { atUs: item.atUs },
      });
    stills.push({
      atUs: item.atUs,
      actualSourceUs: output.actualSourceUs,
      file: data.output,
      width: output.width,
      height: output.height,
      sourceWidth: output.sourceWidth,
      sourceHeight: output.sourceHeight,
      faces,
    });
  }
  return stills;
}

/**
 * Sample source stills with face observations through `yap frame.batch`, eight per call. Every
 * receipt is saved beside its stills; a rerun reuses complete batches instead of fetching again.
 */
export async function sampleStills(request) {
  const { assetId, streamId, acquisitionId, out } = request;
  if (!assetId || !streamId || !out)
    throw failure("INVALID_REQUEST", "Supply assetId, streamId (the video stream) and out");
  const times = sampleTimes(request);
  const cli = request.cli ?? {};
  const timeoutMs = request.timeoutMs ?? 300_000;
  await mkdir(out, { recursive: true });
  const issues = [];
  const stills = [];
  let fetched = 0;
  for (let i = 0; i < times.length; i += BATCH) {
    const name = `batch-${String(i / BATCH + 1).padStart(4, "0")}`;
    const receiptPath = join(out, `${name}.json`);
    const atUs = times.slice(i, i + BATCH);
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      const saved = receipt.data.items.map((item) => item.atUs);
      if (saved.join() !== atUs.join()) receipt = undefined;
    } catch {
      receipt = undefined;
    }
    if (!receipt) {
      const params = {
        assetId,
        streamId,
        ...(acquisitionId ? { acquisitionId } : {}),
        atUs,
        maxLongEdge: request.maxLongEdge ?? 960,
        faceObservations: {},
      };
      // --output refuses an existing directory; a batch without a receipt never finished.
      await rm(join(out, name), { recursive: true, force: true });
      receipt = await frameBatch(cli, params, join(out, name), timeoutMs);
      if (receipt.ok !== true) {
        await writeFile(join(out, `${name}.refused.json`), JSON.stringify(receipt, null, 1));
        throw failure(
          receipt.error?.code ?? "CLI_FAILED",
          receipt.error?.message ?? "frame.batch failed",
          {
            receipt: join(out, `${name}.refused.json`),
          },
        );
      }
      await writeFile(receiptPath, JSON.stringify(receipt, null, 1));
      fetched++;
    }
    stills.push(...stillsFrom(receipt, issues));
  }
  const first = stills[0];
  const manifest = {
    source: {
      assetId,
      streamId,
      width: first?.sourceWidth,
      height: first?.sourceHeight,
    },
    stills,
    issues,
  };
  const manifestPath = join(out, "stills.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  return { manifest: manifestPath, stills: stills.length, fetchedBatches: fetched, issues };
}

if (launchedAs(import.meta.url, "sample-stills.mjs"))
  await runJsonHelper(
    sampleStills,
    `Usage: node sample-stills.mjs < request.json
Sample source stills with face observations through yap frame.batch (read-only; never edits).
Request: assetId, streamId (video), optional acquisitionId, ranges [{startUs,endUs}] and/or atUs,
stepUs (default 2000000), maxLongEdge (default 960), out (directory), timeoutMs per batch, cli
{executable, socket}. Writes out/batch-NNNN.json receipts, their stills and out/stills.json; a
rerun reuses complete batches. Face boxes in the manifest are source pixels, top-left origin.`,
  );
