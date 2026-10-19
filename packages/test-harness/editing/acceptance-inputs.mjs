import assert from "node:assert/strict";
import { readFile, open, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { hashFile } from "@yap/core/files";
export async function identifyFile(path, expected) {
  const file = await open(path, "r");
  let result;
  try {
    const before = await file.stat({ bigint: true });
    result = { path, ...(await hashFile(file, Number(before.size), new AbortController().signal)) };
  } finally {
    await file.close();
  }
  if (expected) {
    assert.equal(
      result.sha256,
      expected.sha256,
      "Fixture byte identity differs from its authority",
    );
    if (expected.bytes !== undefined) assert.equal(result.bytes, expected.bytes);
  }
  return result;
}
export function sourceRange(range, originUs) {
  const value = { startUs: range.startUs - originUs, endUs: range.endUs - originUs };
  assert.ok(
    Number.isSafeInteger(value.startUs) &&
      Number.isSafeInteger(value.endUs) &&
      value.endUs > value.startUs &&
      value.startUs >= 0,
    "Range is outside the bound source clock",
  );
  return value;
}
export function bindMarkedSpeech(marks, asset) {
  assert.equal(
    asset.assetId,
    marks.binding.sourceSha256,
    "Human marks require their original source identity",
  );
  assert.equal(
    asset.originUs,
    marks.binding.sourceOriginUs,
    "Human marks require their original source clock",
  );
  return {
    contextOriginalRange: marks.binding.sourceRange,
    contextAssetRange: sourceRange(marks.binding.sourceRange, asset.originUs),
    targets: marks.independentAnnotations.independentFillerInventory.targets.map((v) => ({
      id: v.id,
      kind: v.kind,
      text: v.text,
      originalRange: v.sourceRange,
      assetRange: sourceRange(v.sourceRange, asset.originUs),
    })),
    protected: marks.independentAnnotations.protectedNeighbors.map((v) => ({
      wordId: v.wordId,
      text: v.text,
      originalRange: v.independentRange,
      assetRange: sourceRange(v.independentRange, asset.originUs),
    })),
    inventoryComplete: marks.independentAnnotations.independentFillerInventory.complete,
  };
}
export function requireSupport(rows, range) {
  let next = range.startUs;
  for (const row of rows)
    if (!row.empty && row.startUs <= next && row.endUs > next)
      next = Math.min(range.endUs, row.endUs);
  assert.equal(next, range.endUs, "Requested fixture range crosses missing physical support");
}
/** Resolve authority files and retained inputs; no toolkit operation or media treatment. */
export async function tutorialInputs(root, mediaRoot, out) {
  const authorities = {};
  const json = async (path) => {
    const identity = await identifyFile(join(root, path));
    authorities[path] = identity;
    return JSON.parse(await readFile(identity.path, "utf8"));
  };
  const marks = await json("specs/done/agent-editing/assets/12d-human-marks/human-marks.json");
  const cleanup = await json(
    "specs/done/agent-editing/assets/12e-labeled-cleanup/native-report.json",
  );
  const retime = await json("specs/done/agent-editing/assets/13a-corrected-selections/report.json");
  const retimeListening = await json(
    "specs/done/agent-editing/assets/13a-corrected-selections/listening.json",
  );
  const take = await json("fixtures/screen-camera-timing/manifest.json");
  const provenance = [];
  for (const entry of take.sources.filter((v) => !v.path.endsWith(".mov")))
    provenance.push(
      await identifyFile(join(mediaRoot, "fixtures/screen-camera-timing", entry.path), entry),
    );
  provenance.push(
    await identifyFile(
      join(mediaRoot, "fixtures/narrated-workbench/capture.journal.jsonl"),
      await identifyFile(join(root, "fixtures/narrated-workbench/capture.journal.jsonl")),
    ),
  );
  await json(
    "specs/done/agent-editing/assets/12b-public-parity/public-model-preparation/verification.json",
  );
  const corpus = await json("specs/done/agent-editing/assets/00-corpus/manifest.json");
  const font = await json("specs/done/agent-editing/assets/17a-text-layout/report.json");
  const voice = await json("specs/done/agent-editing/assets/19f-public-voice-jobs/report.json");
  const word = await json("specs/done/agent-editing/assets/18-voice-roomtone/report.json");
  const music = await json("specs/done/agent-editing/assets/08-narration-music/archive.json");
  assert.equal(cleanup.source.sha256, marks.binding.sourceSha256);
  const snapshotScreen = await identifyFile(join(root, "fixtures/narrated-workbench/video.mov"));
  const entries = [
    [
      "workbenchNarration",
      "fixtures/narrated-workbench/narration.mov",
      "audio",
      { sha256: marks.binding.sourceSha256 },
    ],
    ["workbenchScreen", "fixtures/narrated-workbench/video.mov", "video", snapshotScreen],
    [
      "retimeOriginal",
      "specs/done/agent-editing/assets/13a-corrected-selections/original.wav",
      "audio",
      { sha256: retime.sourceSha256 },
    ],
    [
      "voiceContext",
      "specs/done/agent-editing/assets/18-voice/context.wav",
      "audio",
      { sha256: "779cbc2c8b034ec8aff96879cda49c0042ca4401ac25aab8e41abae3de79bb45" },
    ],
    [
      "voiceReference",
      "specs/done/agent-editing/assets/18-voice/reference.wav",
      "audio",
      { sha256: voice.receipts[0].reference.assetId },
    ],
    [
      "pauseLoop",
      "specs/done/agent-editing/assets/19-soft-roomtone-overlap/loop.wav",
      "audio",
      { sha256: "7fa912f6ced158759e62ed7e5f6577034b731d1ca18fce3e27ac67147f66ff55" },
    ],
    [
      "still",
      "specs/done/agent-editing/assets/00-corpus/still-alpha.png",
      "image",
      corpus.assets.find((v) => v.path === "still-alpha.png"),
    ],
    ...[
      ["camera", "camera/camera.raw.mov", "video"],
      ["screen", "screen/video.mov", "video"],
      ["microphone", "screen/narration.packed.mov", "audio"],
    ].map(([key, path, kind]) => [
      key,
      "fixtures/screen-camera-timing/" + path,
      kind,
      take.sources.find((v) => v.path === path),
    ]),
  ];
  const inputs = [];
  for (const [key, path, kind, expected] of entries)
    inputs.push({
      key,
      kind,
      relativePath: path,
      ...(await identifyFile(join(mediaRoot, path), expected)),
    });
  inputs.push({
    key: "font",
    kind: "font",
    ...(await identifyFile(font.cases[0].request.fontPath, { sha256: font.fontSHA256 })),
  });
  const archive = join(root, "specs/done/agent-editing/assets/08-narration-music", music.archive);
  await identifyFile(archive, music);
  const member = music.files.find((v) => v.path === "final/synthetic-chord-bed.wav");
  assert.ok(member);
  const extracted = (
    await run("tar", ["-xOf", archive, member.path], {
      encoding: "buffer",
      maxBuffer: 2 * 1024 ** 2,
    })
  ).stdout;
  const musicPath = join(out, "inputs", "synthetic-chord-bed.wav");
  await mkdir(dirname(musicPath), { recursive: true });
  try {
    await identifyFile(musicPath, member);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(musicPath, extracted, { flag: "wx" });
  }
  inputs.push({
    key: "music",
    kind: "audio",
    archiveMember: member.path,
    ...(await identifyFile(musicPath, member)),
  });
  const comparison = [
    [
      "retime",
      "specs/done/agent-editing/assets/13a-corrected-selections/internal-slower-0.8x.wav",
      retimeListening.candidates.find((v) => v.path === "internal-slower-0.8x.wav"),
    ],
    [
      "rawWord",
      "specs/done/agent-editing/assets/18-voice/same-take-word.wav",
      { sha256: voice.receipts.find((v) => v.text === "paid").published.audio.assetId },
    ],
    [
      "acceptedWordContext",
      "specs/done/agent-editing/assets/18-voice-roomtone/word-room-context.wav",
      { sha256: word.cases.find((v) => v.id === "word").outputs.room.sha256 },
    ],
  ];
  const references = [];
  for (const [key, path, expected] of comparison)
    references.push({ key, ...(await identifyFile(join(mediaRoot, path), expected)) });
  return {
    inputs,
    provenance,
    authorities,
    marks,
    cleanup,
    retime,
    word,
    voice,
    references,
    brief: await identifyFile(
      join(root, "specs/done/agent-editing/assets/25-fixture-brief/README.md"),
    ),
    screenAuthority: snapshotScreen,
  };
}
