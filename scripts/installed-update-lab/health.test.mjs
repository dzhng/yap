import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForHealth, waitForObservation } from "./health.mjs";

const boundedWait = (predicate, label) =>
  waitForObservation(predicate, label, {
    timeoutMs: 25,
    intervalMs: 1,
    interrupted: () => undefined,
    evidence: "fixture-receipt.json",
  });

test("persisted Off observation waits past socket readiness for the native updater report", async () => {
  const disabled = {
    status: "ready",
    update: { state: "unavailable", availability: "disabled", error: null },
  };
  const replies = [
    { ok: false, error: { code: "CONNECTION_ERROR" } },
    {
      ok: true,
      data: {
        status: "ready",
        update: { state: "unavailable", availability: "unavailable", error: null },
      },
    },
    { ok: true, data: disabled },
  ];
  assert.deepEqual(await waitForHealth(() => replies.shift(), boundedWait, "disabled"), disabled);
});

test("a permanently unavailable updater fails within the bound and preserves its diagnostic reply", async () => {
  const reply = {
    ok: true,
    data: {
      status: "ready",
      update: {
        state: "unavailable",
        availability: "unavailable",
        error: { code: "UPDATE_UNAVAILABLE", message: "fixture SDK startup failure" },
      },
    },
  };
  await assert.rejects(
    waitForHealth(() => reply, boundedWait, "disabled"),
    (error) => {
      assert.match(error.message, /ready service with updater disabled timed out/);
      assert.match(error.message, /fixture-receipt.json/);
      assert.match(error.message, /UPDATE_UNAVAILABLE/);
      assert.match(error.message, /fixture SDK startup failure/);
      return true;
    },
  );
});
