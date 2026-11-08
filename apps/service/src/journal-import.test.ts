import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureFixture } from "./project-capture.fixture.js";
import { mediaWorker } from "./worker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test.runIf(Boolean(process.env.YAP_NATIVE))(
  "production import admits an eleven-second schema-3 stroke larger than 64 KiB",
  async () => {
    const native = process.env.YAP_NATIVE!;
    const f = await captureFixture(cleanup, undefined, mediaWorker({ YAP_NATIVE: native }));
    const directory = join(f.home, "long-stroke");
    await mkdir(directory);
    const journal = join(directory, "capture.journal.jsonl");
    // Fixed observations and synthetic pictures replace capture hardware; serialization is real.
    execFileSync(join(dirname(native), "YapCaptureTests"), [], {
      env: {
        ...process.env,
        YAP_LONG_STROKE_FIXTURE: journal,
        YAP_LONG_STROKE_VIDEO: join(directory, "video.mov"),
      },
    });
    const before = await readFile(journal);
    expect(before).toEqual(
      await readFile(
        new URL("../../../fixtures/journal/schema3-long-stroke.jsonl", import.meta.url),
      ),
    );
    const markLine = before
      .toString("utf8")
      .split("\n")
      .find((line) => line.includes('"event":"mark"'))!;
    expect(Buffer.byteLength(markLine)).toBeGreaterThan(65536);
    expect(JSON.parse(markLine).data.points).toHaveLength(660);
    const imported = await f.call("acquisition.import", {
      requestId: "long-stroke",
      path: directory,
    });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const job = imported.data as { jobId: string; target: { id: string } };
    await expect
      .poll(async () => {
        const reply = await f.call("job.get", { jobId: job.jobId });
        if (!reply.ok) throw new Error(JSON.stringify(reply));
        const state = reply.data as { state: string };
        if (state.state === "failed") throw new Error(JSON.stringify(state));
        return state.state;
      })
      .toBe("ready");
    expect(await f.call("acquisition.get", { acquisitionId: job.target.id })).toMatchObject({
      ok: true,
      data: { sourceId: "schema3-long-stroke" },
    });
    expect(await readFile(journal)).toEqual(before);
  },
);
