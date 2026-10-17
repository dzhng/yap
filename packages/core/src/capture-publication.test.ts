import { expect, test } from "vitest";
import { readRecoveryReceipt } from "./capture-publication.js";

test("recovery receipt rejects unknown top-level fields", () => {
  expect(() =>
    readRecoveryReceipt({
      durationUs: 0,
      tracks: [],
      journal: null,
      inputsClosed: true,
      sourcePublication: { state: "unavailable", error: { code: "NO_SOURCE", message: "empty" } },
      unexpected: true,
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
});

test("recovery receipt preserves completion and cleanup diagnostics", () => {
  expect(
    readRecoveryReceipt({
      durationUs: 100,
      journal: {
        header: { sessionID: "source" },
        completion: { failureCode: "JOURNAL_FAILED", failureMessage: "retained" },
      },
      tracks: [{ role: "video", failure: null, futureField: true }],
      cleanupFailure: { code: "CLEANUP_PENDING", message: "workspace retained" },
      inputsClosed: true,
      sourcePublication: null,
    }),
  ).toMatchObject({
    durationUs: 100,
    captured: true,
    failureCode: "JOURNAL_FAILED",
    failureMessage: "retained",
    cleanupFailure: { code: "CLEANUP_PENDING" },
    inputsClosed: true,
  });
});

test("recovery receipt preserves journal diagnostics when no completion exists", () => {
  expect(
    readRecoveryReceipt({
      durationUs: 100,
      journal: { completion: { failureCode: null, failureMessage: null } },
      journalFailure: { code: "INVALID_JOURNAL", message: "retained prefix" },
      tracks: [],
      inputsClosed: true,
      sourcePublication: null,
    }),
  ).toMatchObject({
    failureCode: "INVALID_JOURNAL",
    failureMessage: "retained prefix",
  });
});

test("recovery receipt rejects a completion message without a completion code", () => {
  expect(() =>
    readRecoveryReceipt({
      durationUs: 0,
      journal: { completion: { failureCode: null, failureMessage: "orphaned" } },
      tracks: [],
      inputsClosed: true,
      sourcePublication: null,
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
});
