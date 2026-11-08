import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/capture-controller/", import.meta.url));

test(
  "actual controller preserves pending-start interruptions and finalization races",
  { timeout: 150_000 },
  () => {
    const temporary = mkdtempSync(join(tmpdir(), "yap-controller-start-"));
    try {
      const build = join(temporary, "build");
      execFileSync(
        process.execPath,
        [
          join(root, "apps/macos/tests/build-controller-journey.mjs"),
          build,
          join(fixtures, "Lifecycle.swift"),
        ],
        { stdio: "pipe", timeout: 90_000 },
      );
      for (const mode of [
        "pending-start",
        "failed-start",
        "stop-ack",
        "cleanup-pending",
        "maximum-cleanup",
        "cancel-publication",
        "cancel-before-stop",
      ]) {
        const evidence = join(temporary, mode);
        mkdirSync(evidence);
        const result = spawnSync(join(build, "controller-journey"), [], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            YAP_CONTROLLER_MODE: mode,
            YAP_CONTROLLER_REPORT_ROOT: evidence,
            YAP_CONTROLLER_NODE: process.execPath,
            YAP_CONTROLLER_AUDIO: join(
              root,
              "specs/done/agent-editing/assets/20a-sparse-storage/run/continuous-48000.mov",
            ),
            YAP_CONTROLLER_PEER: join(fixtures, "control-peer.mjs"),
          },
        });
        assert.equal(
          result.status,
          0,
          `${mode}: ${result.stdout}\n${result.stderr}\n${result.error ?? ""}`,
        );
        assert.match(result.stdout, /PASS/);
        process.stdout.write(result.stdout);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
