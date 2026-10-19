import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { callLocal } from "@yap/client";
import { startProjectService } from "../dist/project-service.js";
import { native, until } from "./fixtures/project-export.mjs";

// Packages Yap 0.1.61 wrote (version 6): a plain project, scene and transcript evidence, and
// source and project indexes. Import reads them in the version-7 shape.
for (const name of ["project", "scene", "transcript", "source-index", "project-index"])
  test(`a ${name} package 0.1.61 wrote opens and adopts`, async () => {
    const home = await realpath(await mkdtemp("/tmp/yap-package-v6-"));
    const archive = join(home, `${name}.zip`);
    await copyFile(new URL(`./fixtures/packages-v6/${name}.zip`, import.meta.url), archive);
    const service = await startProjectService({
      home,
      worker: native,
      nativeExecutable: process.env.YAP_NATIVE,
    });
    const call = async (operation, params = {}) => {
      const result = await callLocal(service.socketPath, { id: randomUUID(), operation, params });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.data;
    };
    try {
      const opening = await call("package.open", { path: archive, requestId: "open" });
      const opened = await until(async () => {
        const status = await call("package.status", { admissionId: opening.id });
        assert.notEqual(status.state, "failed", JSON.stringify(status));
        return status.state === "ready" && status;
      });
      const adopted = await until(async () => {
        const work = await call("package.adopt", {
          packageHandle: opened.packageHandle,
          requestId: "adopt",
        });
        assert.notEqual(work.state, "failed", JSON.stringify(work));
        return work.state === "ready" && work;
      });
      const projectId = adopted.published.output.projectId;
      const { revisions } = await call("revision.history", { projectId });
      assert.ok(revisions.length > 0);
      for (const revision of revisions) assert.equal(revision.projectId, projectId);
      assert.equal((await call("project.get", { projectId })).id, projectId);
    } finally {
      await service.close();
      await rm(home, { recursive: true, force: true });
    }
  });
