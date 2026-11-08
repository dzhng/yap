import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { JobQueue } from "./jobs.js";
import { ResourceReferences } from "./references.js";

test("admission publishes the real job and its references atomically, including replay", async () => {
  const home = await mkdtemp("/tmp/job-admission-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const references = new ResourceReferences(catalog);
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    execute: async () => "unused",
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw new Error("Wrong target");
        return target;
      },
      isAvailable: () => true,
      isCapturing: () => true,
      isDeleting: () => false,
    },
  });
  try {
    const request = {
      target: { kind: "asset" as const, id: "source" },
      artifact: "transcript",
      input: "pinned",
      lane: "heavy" as const,
    };
    expect(() =>
      jobs.submit(request, (job) => {
        references.retain("asset", { kind: "job", id: job.jobId }, ["source"]);
        throw new Error("admission failed");
      }),
    ).toThrow("admission failed");
    expect(references.owners("asset", "source")).toEqual([]);
    expect(jobs.status(request).state).toBe("not_requested");
    const first = jobs.submit(request, (job) =>
      references.retain("asset", { kind: "job", id: job.jobId }, ["source"]),
    );
    const replay = jobs.submit(request, (job) =>
      references.retain("acquisition", { kind: "job", id: job.jobId }, ["context"]),
    );
    expect(replay.jobId).toBe(first.jobId);
    expect(references.owners("asset", "source")).toEqual([{ kind: "job", id: first.jobId }]);
    expect(references.owners("acquisition", "context")).toEqual([{ kind: "job", id: first.jobId }]);
  } finally {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});
