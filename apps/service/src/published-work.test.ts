import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { projectServiceFixture } from "./project-service.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

test("import acknowledgement, exact replay and ready inspection expose one typed publication without internal results", async () => {
  let begin!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = await projectServiceFixture(cleanups, async (operation) => {
    if (operation === "media.pictureCapabilities" || operation === "media.audioCapabilities")
      return { ok: true, data: {} };
    if (operation !== "media.probe") throw Error(`Unexpected native operation ${operation}`);
    begin();
    await released;
    return {
      ok: true,
      data: {
        originUs: 0,
        streams: [
          {
            id: "image",
            kind: "image",
            codec: "png",
            decodable: true,
            width: 2,
            height: 1,
            orientedWidth: 2,
            orientedHeight: 1,
          },
        ],
      },
    };
  });
  cleanups.push(async () => finish());
  const sourceBytes = 64 * 1024 ** 2;
  await truncate(f.path, sourceBytes);
  const request = { requestId: "import", path: f.path };
  const startedAt = performance.now();
  const accepted = await f.call("asset.import", request);
  if (!accepted.ok) throw Error(accepted.error.message);
  const acknowledgementMs = performance.now() - startedAt;
  expect(accepted.data).toHaveProperty("published", null);
  expect(accepted.data).not.toHaveProperty("result");
  const job = accepted.data as { jobId: string; attemptId: string; attemptGeneration: number };
  await entered;
  const pending = await f.call("job.get", { jobId: job.jobId });
  expect(pending).toMatchObject({
    ok: true,
    data: {
      state: "running",
      jobId: job.jobId,
      attemptId: job.attemptId,
      attemptGeneration: 1,
      published: null,
    },
  });
  expect(await f.call("asset.import", request)).toEqual(pending);
  finish();
  const ready = await f.job(job.jobId, "ready");
  expect(ready).toMatchObject({
    state: "ready",
    published: {
      generation: "1",
      attemptId: job.attemptId,
      output: { assetId: expect.stringMatching(/^[a-f0-9]{64}$/) },
    },
  });
  expect(ready).not.toHaveProperty("result");
  expect(ready).not.toHaveProperty("input");
  if (process.env.YAP_CONTRACT_TEST_OUTPUT)
    await writeFile(
      join(process.env.YAP_CONTRACT_TEST_OUTPUT, "publication-import.json"),
      JSON.stringify(
        { sourceBytes, acknowledgementMs, request, accepted, pending, ready },
        null,
        2,
      ) + "\n",
    );
});

test("a malformed worker result settles failed work in an ok transport reply without publishing partial output", async () => {
  const f = await projectServiceFixture(cleanups, async (operation) => {
    if (operation === "media.pictureCapabilities" || operation === "media.audioCapabilities")
      return { ok: true, data: {} };
    if (operation !== "media.probe") throw Error(`Unexpected native operation ${operation}`);
    return { ok: true, data: { originUs: 0, streams: [{ id: "incomplete" }] } };
  });
  const accepted = await f.call("asset.import", { requestId: "malformed", path: f.path });
  if (!accepted.ok) throw Error(accepted.error.message);
  const { jobId } = accepted.data as { jobId: string };
  const failed = await f.job(jobId, "failed");
  expect(failed).toMatchObject({ state: "failed", published: null, attemptGeneration: 1 });
  expect(failed).not.toHaveProperty("result");
  if (process.env.YAP_CONTRACT_TEST_OUTPUT)
    await writeFile(
      join(process.env.YAP_CONTRACT_TEST_OUTPUT, "publication-malformed.json"),
      JSON.stringify({ accepted, failed }, null, 2) + "\n",
    );
  expect(await f.call("asset.import", { requestId: "malformed", path: f.path })).toEqual({
    id: "test",
    ok: true,
    data: failed,
  });
});
