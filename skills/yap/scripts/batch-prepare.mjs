import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createCli } from "./yap-cli.mjs";

const activeStates = new Set(["queued", "running", "uncertain"]);
const failedStates = new Set(["failed", "unavailable", "canceled"]);
const uncertainCodes = new Set([
  "CLI_TIMEOUT",
  "CLI_UNAVAILABLE",
  "INVALID_CLI_RESPONSE",
  "LIMIT_EXCEEDED",
  "CANCELED",
  "TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ERROR",
  "UNCORRELATED_RESPONSE",
  "ABORTED",
  "INVALID_RESPONSE",
]);

// Starting work reports a status naming its job `jobId`; job.get, job.retry and job.cancel
// return the job record itself, which names itself `id`.
const jobOf = (status) => status.jobId ?? status.id;

export function createBatch(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 1000)
    throw new Error("Supply one to 1000 explicit files");
  const paths = new Set(),
    requests = new Set();
  const items = files.map(({ path, requestId = randomUUID(), transcriptStreamIds = [] }) => {
    if (typeof path !== "string" || !isAbsolute(path) || paths.has(path))
      throw new Error("Each selected file must have a unique absolute path");
    if (typeof requestId !== "string" || !requestId || requests.has(requestId))
      throw new Error("Each import must have a unique requestId");
    if (
      !Array.isArray(transcriptStreamIds) ||
      transcriptStreamIds.length > 16 ||
      transcriptStreamIds.some((id) => typeof id !== "string" || !id) ||
      new Set(transcriptStreamIds).size !== transcriptStreamIds.length
    )
      throw new Error("Select at most 16 unique transcript stream IDs per file");
    paths.add(path);
    requests.add(requestId);
    return {
      path,
      requestId,
      transcriptStreamIds,
      import: { state: "idle" },
      asset: null,
      transcripts: [],
    };
  });
  return { version: 1, items };
}

/** Resume only selected imports/preparations; jobs and source clocks remain product-owned. */
export async function prepareBatch(
  manifest,
  {
    invoke = createCli(),
    concurrency = 2,
    maxPolls = 20,
    pollIntervalMs = 250,
    retryFailed = false,
    save = async () => {},
    signal,
  } = {},
) {
  if (manifest?.version !== 1) throw new Error("Unsupported batch manifest version");
  createBatch(manifest.items);
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isSafeInteger(maxPolls) ||
    maxPolls < 0 ||
    maxPolls > 1000 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > 10_000
  )
    throw new Error("Invalid concurrency or polling budget");
  let saving = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(manifest);
    saving = saving.then(() => save(snapshot));
    return saving;
  };
  await persist(); // Replay identities must survive a lost import answer.
  const pending = (item) =>
    activeStates.has(item.import.state) ||
    item.transcripts.some((entry) => activeStates.has(entry.status?.state));
  const candidates = [
    ...manifest.items.filter(pending),
    ...manifest.items.filter((item) => !pending(item)),
  ];
  let next = 0;
  async function itemWork(item) {
    let polls = 0;
    const request = async (operation, params, update) => {
      if (!pending(item) && manifest.items.filter(pending).length >= concurrency) return false;
      update({ state: "uncertain", jobId: params.jobId ?? null });
      await persist();
      try {
        update(await invoke(operation, params, { signal }));
      } catch (error) {
        update({
          state: uncertainCodes.has(error.code) ? "uncertain" : "failed",
          jobId: params.jobId ?? null,
          errorCode: error.code ?? "PREPARATION_FAILED",
          reason: error.message,
          errorDetails: error.details ?? {},
          retryable: error.retryable ?? false,
        });
        await persist();
        throw error;
      }
      await persist();
      return true;
    };
    const wait = async (status, update) => {
      while (
        activeStates.has(status.state) &&
        status.state !== "uncertain" &&
        polls < maxPolls &&
        !signal?.aborted
      ) {
        await delay(pollIntervalMs, undefined, { signal });
        status = await invoke("job.get", { jobId: jobOf(status) }, { signal });
        polls++;
        update(status);
        await persist();
      }
      return status;
    };
    item.error = null;
    if (retryFailed && failedStates.has(item.import.state)) {
      if (jobOf(item.import)) {
        if (
          !(await request("job.retry", { jobId: jobOf(item.import) }, (status) => {
            item.import = status;
          }))
        )
          return false;
      } else item.import = { state: "idle" };
    }
    if (["idle", "uncertain"].includes(item.import.state)) {
      if (
        !(await request(
          "asset.import",
          { requestId: item.requestId, path: item.path },
          (status) => {
            item.import = status;
          },
        ))
      )
        return false;
    }
    item.import = await wait(item.import, (status) => {
      item.import = status;
    });
    if (item.import.state !== "ready") return !activeStates.has(item.import.state);
    if (!item.asset) {
      item.asset = await invoke(
        "asset.get",
        { assetId: item.import.published.output.assetId },
        { signal },
      );
      await persist();
    }
    const pendingStream = (id) =>
      activeStates.has(item.transcripts.find((entry) => entry.streamId === id)?.status.state);
    const streams = [
      ...item.transcriptStreamIds.filter(pendingStream),
      ...item.transcriptStreamIds.filter((id) => !pendingStream(id)),
    ];
    for (const streamId of streams) {
      let entry = item.transcripts.find((candidate) => candidate.streamId === streamId);
      if (!entry) {
        entry = { streamId, status: { state: "idle" } };
        item.transcripts.push(entry);
      }
      if (entry.status.state === "uncertain") {
        entry.status = await invoke(
          "transcript.get",
          {
            assetId: item.import.published.output.assetId,
            streamId,
            limit: 1,
          },
          { signal },
        );
        await persist();
      }
      if (
        retryFailed &&
        (failedStates.has(entry.status.state) || entry.status.state === "uncertain")
      ) {
        if (jobOf(entry.status)) {
          if (
            !(await request("job.retry", { jobId: jobOf(entry.status) }, (status) => {
              entry.status = status;
            }))
          )
            return false;
        } else entry.status = { state: "idle" };
      }
      if (entry.status.state === "idle") {
        if (
          !(await request(
            "transcript.transcribe",
            { assetId: item.import.published.output.assetId, streamId },
            (status) => {
              entry.status = status;
            },
          ))
        )
          return false;
      }
      entry.status = await wait(entry.status, (status) => {
        entry.status = status;
      });
      if (activeStates.has(entry.status.state)) return false;
    }
    return true;
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (next < candidates.length && !signal?.aborted) {
        const item = candidates[next++];
        try {
          if (!(await itemWork(item))) break; // Pending work keeps its admission slot until resume.
        } catch (error) {
          item.error = {
            code: error.code ?? "PREPARATION_FAILED",
            message: error.message,
            details: error.details ?? {},
            retryable: error.retryable ?? false,
          };
          if (pending(item)) {
            await persist();
            break;
          }
        }
        await persist();
      }
    }),
  );
  const summary = { ready: 0, failed: 0, pending: 0, notRequested: 0 };
  for (const item of manifest.items) {
    const statuses = [item.import, ...item.transcripts.map((entry) => entry.status)];
    const state =
      item.error || statuses.some((status) => failedStates.has(status.state))
        ? "failed"
        : pending(item)
          ? "pending"
          : item.import.state !== "ready"
            ? "notRequested"
            : item.transcriptStreamIds.some(
                  (id) =>
                    !item.transcripts.some(
                      (entry) => entry.streamId === id && entry.status.state === "ready",
                    ),
                )
              ? "notRequested"
              : "ready";
    summary[state]++;
  }
  await persist();
  return { manifest, summary };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node batch-prepare.mjs --manifest FILE [--concurrency 1..8] [--polls 0..1000] [--poll-ms 0..10000] [--retry-failed] [--cli PATH] [--socket PATH]\nFILE starts as {items:[{path:absolute,transcriptStreamIds?:[explicit IDs]}]}; it becomes a resumable task manifest. Transcript preparation never prepares models. Pending work stops further admission at the concurrency cap.",
    );
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--retry-failed") options.retryFailed = true;
    else if (
      ["--manifest", "--concurrency", "--polls", "--poll-ms", "--cli", "--socket"].includes(
        args[i],
      ) &&
      args[i + 1]
    )
      options[args[i].slice(2)] = args[++i];
    else throw new Error("Unknown or incomplete option; use --help");
  }
  if (!options.manifest) throw new Error("An explicit --manifest is required");
  const file = resolve(options.manifest);
  const input = JSON.parse(await readFile(file, "utf8"));
  const manifest = input.version === undefined ? createBatch(input.items) : input;
  const save = async (state) => {
    const temporary = `${file}.part-${process.pid}`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const result = await prepareBatch(manifest, {
    invoke: createCli({ executable: options.cli, socket: options.socket }),
    save,
    ...(options.concurrency ? { concurrency: Number(options.concurrency) } : {}),
    ...(options.polls ? { maxPolls: Number(options.polls) } : {}),
    ...(options["poll-ms"] ? { pollIntervalMs: Number(options["poll-ms"]) } : {}),
    retryFailed: options.retryFailed,
  });
  console.log(JSON.stringify({ manifest: file, summary: result.summary }));
  if (result.summary.failed) process.exitCode = 1;
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
