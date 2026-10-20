import { expect, test } from "vitest";
import {
  readCapturePublication,
  readCaptureSourceOutcome,
  readRecoveryReceipt,
} from "./capture-publication.js";

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

/** What native capture reports for a screen take whose journal has the given layout. */
function screenPublication(layout: number) {
  return {
    generation: "generation",
    sourceId: "source",
    inputsClosed: true,
    camera: null,
    primary: {
      state: "published",
      source: {
        kind: "primary",
        sourceId: "source",
        sourceDurationUs: 2_796_908,
        originHostUs: 793_489_750_500,
        journal: {
          file: "source.journal.jsonl",
          bytes: 21_677,
          sha256: "a".repeat(64),
          lastSequence: 15,
          layout,
        },
        members: { "video.mov": { bytes: "8623", sha256: "b".repeat(64) } },
      },
    },
  };
}

test("a screen take journaled with marks (layout 3) publishes like one without", () => {
  const allocation = { id: "take", sourceId: "source", camera: null };
  for (const layout of [2, 3])
    expect(
      readCapturePublication(screenPublication(layout), allocation, null).authorities.primary
        ?.journal.layout,
    ).toBe(layout);
  for (const layout of [1, 4])
    expect(() => readCapturePublication(screenPublication(layout), allocation, null)).toThrow();
});

test("native pending publication projects its code's verdict without a wire retry bit", () => {
  expect(
    readCaptureSourceOutcome({
      state: "pending",
      error: { code: "INVALID_JOURNAL", message: "Retained journal needs repair" },
    }),
  ).toEqual({
    state: "pending",
    error: { code: "INVALID_JOURNAL", message: "Retained journal needs repair", retryable: true },
  });
});
