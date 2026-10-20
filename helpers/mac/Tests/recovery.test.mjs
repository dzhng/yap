import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const executable =
  process.env.YAP_NATIVE ?? fileURLToPath(new URL("../.build/debug/yap-native", import.meta.url));
function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function recover(directory) {
  const response = JSON.parse(
    run(
      executable,
      [],
      JSON.stringify({ id: "recover", operation: "media.recover", params: { directory } }) + "\n",
    ),
  );
  assert.equal(response.ok, true);
  return response.data;
}
function audio(directory) {
  run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=0.5",
    "-af",
    "asetpts=PTS+0.25/TB",
    "-c:a",
    "pcm_f32le",
    join(directory, "narration.mov"),
  ]);
}

test("short optional narration never shortens decoded video", () => {
  const directory = mkdtempSync(join(tmpdir(), "yap-recovery-test-"));
  try {
    run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=10:duration=2",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      join(directory, "video.mov"),
    ]);
    audio(directory);
    const before = createHash("sha256")
      .update(readFileSync(join(directory, "video.mov")))
      .digest("hex");
    const result = recover(directory);
    assert.equal(result.durationUs, 2_000_000);
    assert.equal(result.tracks[0].intervalCount, 1);
    assert.equal(result.tracks[0].intervals, undefined);
    assert.equal(result.tracks[1].intervalCount, 1);
    assert.equal(result.tracks[2].failure.code, "MISSING_MEDIA");
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(directory, "video.mov")))
        .digest("hex"),
      before,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unreadable video retains independently decodable narration", () => {
  const directory = mkdtempSync(join(tmpdir(), "yap-audio-recovery-test-"));
  try {
    writeFileSync(join(directory, "video.mov"), "incomplete movie header");
    audio(directory);
    const result = recover(directory);
    assert.equal(result.durationUs, 0);
    assert.equal(result.tracks[0].intervalCount, 0);
    assert.equal(result.tracks[0].failure.code, "DECODE_FAILED");
    assert.equal(result.tracks[1].intervalCount, 1);
    assert.equal(result.tracks[1].acquisitionVerified, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("truncated acquisition journal preserves known audio gaps and an unfinished pause", () => {
  const directory = mkdtempSync(join(tmpdir(), "yap-journal-test-"));
  try {
    audio(directory);
    const records = [
      {
        sequence: 1,
        event: "header",
        data: {
          schemaVersion: 1,
          sessionID: "fixture-session",
          source: { kind: "window", windowID: 1 },
          width: 160,
          height: 90,
          microphone: true,
          systemAudio: false,
        },
      },
      { sequence: 2, event: "origin", data: { hostUs: 1_000_000 } },
      {
        sequence: 3,
        event: "audioSamples",
        data: { role: "narration", startUs: 250_000, endUs: 300_000 },
      },
      {
        sequence: 4,
        event: "audioSamples",
        data: { role: "narration", startUs: 300_001, endUs: 400_000 },
      },
      {
        sequence: 5,
        event: "audioSamples",
        data: { role: "narration", startUs: 500_000, endUs: 700_000 },
      },
      { sequence: 6, event: "pauseBegan", data: { hostUs: 1_700_000 } },
    ];
    writeFileSync(
      join(directory, "capture.journal.jsonl"),
      records.map(JSON.stringify).join("\n") + '\n{"sequence":7,"event":"pauseEnded"',
    );
    const result = recover(directory);
    assert.equal(result.durationUs, 0);
    assert.equal(result.journal.header.sessionID, "fixture-session");
    assert.equal(result.journal.file, "capture.journal.jsonl");
    assert.equal(result.journal.acquiredAudio, undefined);
    assert.equal(result.journal.originHostUs, 1_000_000);
    assert.equal(result.journal.lastSequence, 6);
    assert.equal(result.journal.incompleteTail, true);
    assert.equal(result.journal.invalidAtSequence, undefined);
    assert.equal(result.journal.openPauseHostUs, 1_700_000);
    assert.equal(result.journal.pauses, undefined);
    assert.equal(result.tracks[2].failure.code, "NOT_REQUESTED");
    assert.equal(result.tracks[1].intervalCount, 2);
    assert.equal(result.tracks[1].acquisitionVerified, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a journal record that will not decode is named instead of silently dropped", () => {
  const directory = mkdtempSync(join(tmpdir(), "yap-journal-invalid-test-"));
  try {
    audio(directory);
    const records = [
      {
        sequence: 1,
        event: "header",
        data: {
          schemaVersion: 1,
          sessionID: "fixture-session",
          source: { kind: "window", windowID: 1 },
          width: 160,
          height: 90,
          microphone: true,
          systemAudio: false,
        },
      },
      { sequence: 2, event: "origin", data: { hostUs: 1_000_000 } },
      {
        sequence: 3,
        event: "audioSamples",
        data: { role: "narration", startUs: 250_000, endUs: 700_000 },
      },
      { sequence: 4, event: "pauseBegan", data: { hostUs: "not-a-timestamp" } },
      { sequence: 5, event: "finished", data: { state: "complete" } },
    ];
    writeFileSync(
      join(directory, "capture.journal.jsonl"),
      records.map(JSON.stringify).join("\n") + "\n",
    );
    const result = recover(directory);
    assert.equal(result.journal.invalidAtSequence, 4);
    assert.equal(result.journal.incompleteTail, false);
    assert.equal(result.journal.lastSequence, 3);
    assert.equal(result.journal.originHostUs, 1_000_000);
    assert.equal(result.journal.finished, false);
    assert.equal(result.tracks[1].intervalCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unreadable journal remains a retryable wire failure until access is restored", () => {
  const directory = mkdtempSync(join(tmpdir(), "yap-recovery-access-"));
  const journal = join(directory, "capture.journal.jsonl");
  writeFileSync(
    journal,
    JSON.stringify({
      sequence: 1,
      event: "header",
      data: {
        schemaVersion: 2,
        sessionID: "access",
        source: { kind: "fixture" },
        width: 160,
        height: 90,
        microphone: false,
        systemAudio: false,
      },
    }) + "\n",
  );
  try {
    chmodSync(journal, 0o000);
    const response = JSON.parse(
      run(
        executable,
        [],
        JSON.stringify({ id: "access", operation: "media.recover", params: { directory } }) + "\n",
      ),
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "JOURNAL_UNAVAILABLE");
    assert.equal(response.error.details.cause, "JOURNAL_UNAVAILABLE");
    chmodSync(journal, 0o600);
    assert.equal(recover(directory).journal.header.sessionID, "access");
  } finally {
    chmodSync(journal, 0o600);
    rmSync(directory, { recursive: true, force: true });
  }
});
