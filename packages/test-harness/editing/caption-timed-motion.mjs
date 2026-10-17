import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "../../core/dist/catalog.js";
import { AssetStore } from "../../core/dist/assets.js";
import { AcquisitionStore } from "../../core/dist/acquisitions.js";
import { selectSource } from "../../core/dist/source-selection.js";
import { assetTranscriptOwner } from "../../core/dist/transcript-processing.js";
import { TranscriptStore, speechExecution } from "../../core/dist/transcript.js";
import { captionProposals } from "../../../skills/yap/scripts/caption-proposals.mjs";
import { hash, poll, run } from "./source-evidence-fixture.mjs";

// Synthetic provider observations isolate text mapping and clocks from ASR accuracy.
async function retainWords(home, source, words) {
  const library = join(home, "library"),
    catalog = new Catalog(join(library, "catalog.sqlite"));
  try {
    const assets = new AssetStore(catalog, library),
      acquisitions = new AcquisitionStore(catalog);
    const selected = selectSource(assets, acquisitions, source);
    const records = new TranscriptStore(
      catalog,
      library,
      assetTranscriptOwner(assets, acquisitions),
    );
    const identity = {
      owner: { kind: "asset", assetId: source.assetId },
      sourceId: source.assetId,
      generation: "caption-fixture-observations",
    };
    const output = await records.reserve(identity),
      range = { startUs: 0, endUs: 2000000 };
    const raw =
      JSON.stringify({ ordinal: 0, source: range, owned: range, state: "transcribed", words }) +
      "\n";
    await writeFile(output, raw);
    const pins = {
      runtime: "FluidAudio",
      runtimeVersion: "0.15.7",
      runtimeRevision: "synthetic-caption-fixture",
      decoder: "parakeet-tdt-batch",
      model: "synthetic-caption-fixture",
      modelRevision: "synthetic-caption-fixture",
      modelDigest: "a".repeat(64),
    };
    await records.ingest({
      identity,
      source: {
        kind: "asset",
        streamId: source.streamId,
        durationUs: selected.durationUs,
        supportDigest: selected.supportDigest,
      },
      request: {
        execution: speechExecution(),
        models: { directory: library, files: [] },
        track: selected.track,
        output,
      },
      receipt: {
        output: { file: output, bytes: Buffer.byteLength(raw), sha256: hash(raw) },
        engine: { ...pins, encoderPrecision: "int8", computeUnits: "cpu" },
        segments: [
          {
            ordinal: 0,
            source: range,
            owned: range,
            state: "transcribed",
            wordCount: words.length,
          },
        ],
        execution: speechExecution(),
        wordCount: words.length,
        available: selected.track.available,
      },
      pins,
      signal: new AbortController().signal,
    });
    return identity.generation;
  } finally {
    catalog.close();
  }
}

/** Public seeded highlights and ordinary entrance curves against independent numeric frames. */
export async function captionTimedMotion({
  call,
  out,
  home,
  font,
  project,
  admit,
  picture,
  report,
  rgba,
}) {
  const audioPath = join(out, "caption-fixture.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "2",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);
  const media = await admit(audioPath),
    source = { assetId: media.id, streamId: media.streams.find((s) => s.kind === "audio").id };
  const words = [
    { text: "new", source: { startUs: 0, endUs: 750000 } },
    { text: "omit", source: { startUs: 500000, endUs: 1000000 } },
    { text: "wrong", source: { startUs: 625000, endUs: 1500000 } },
    { text: "now", source: { startUs: 1375000, endUs: 2000000 } },
  ];
  const generation = await retainWords(home, source, words);
  console.log("timed-motion: retained declared word observations; no inference");
  const canvas = {
    width: 640,
    height: 180,
    fps: { numerator: 16, denominator: 1 },
    background: "#142032ff",
  };
  const p = await project(canvas),
    reference = await project(canvas),
    baseline = await project(canvas);
  const placed = await p.edit([
    { operation: "track.add", label: "speech", track: { kind: "audio", order: 0 } },
    { operation: "track.add", label: "captions", track: { kind: "video", order: 0 } },
    ...[0, 2000000].map((atUs, i) => ({
      operation: "place",
      label: "speech" + i,
      clip: {
        trackId: { label: "speech" },
        ...source,
        source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: atUs, endUs: atUs + 2000000 } },
      },
    })),
  ]);
  const style = {
    font: { assetId: font.id, postScriptName: "ArialMT" },
    width: 600,
    height: 100,
    size: 42,
    color: "#ffffffff",
    alignment: "center",
    verticalAlignment: "center",
    wrap: false,
    highlight: { activeColor: "#ffcc00ff", inactiveColor: "#ffffffff" },
  };
  const drafts = [0, 1].map(
    (i) =>
      captionProposals({
        entry: {
          identity: p.selection(),
          state: "ready",
          complete: true,
          rows: words.map((word, ordinal) => ({
            type: "word",
            ordinal,
            text: word.text,
            segment: 0,
            partial: false,
            clipId: placed.edit.labels["speech" + i],
            trackId: placed.edit.labels.speech,
            ...source,
            generation,
            sourceRange: word.source,
            fragments: [
              {
                source: word.source,
                project: {
                  startUs: word.source.startUs + i * 2000000,
                  endUs: word.source.endUs + i * 2000000,
                },
              },
            ],
          })),
        },
        rowIndexes: [0, 1, 2, 3],
        corrections: [
          { rowIndex: 0, text: "New" },
          { rowIndex: 1, text: "" },
          { rowIndex: 2, text: "Trend!" },
        ],
        trackId: placed.edit.labels.captions,
        canvas,
        style,
        constraints: {
          widthGraphemes: 40,
          maxLines: 1,
          minDwellUs: 500000,
          maxDwellUs: 3000000,
          maxCps: 30,
          pauseUs: 400000,
          breakOnPunctuation: false,
          separator: " ",
          safeArea: { x: 20, y: 20, width: 600, height: 140 },
        },
      }).proposals[0],
  );
  assert.equal(drafts[0].text, "New  Trend! now");
  report.captionTimedMotion = {
    syntheticWords: true,
    noASR: true,
    source,
    generation,
    drafts,
    stillComparisons: [],
    movieComparisons: [],
  };
  const captioned = await p.edit(
    drafts.map((draft, i) => ({ operation: "place", label: "caption" + i, clip: draft.clip })),
  );
  const target = (i) => ({ kind: "clip", id: captioned.edit.labels["caption" + i] });
  const geometry = (scale) => ({
    ...drafts[0].geometry,
    processor: { ...drafts[0].geometry.processor, scale: { x: scale, y: scale } },
  });
  const curve = (end, start) => ({
    keys: [
      { at: { numerator: 0, denominator: 1 }, value: start, interpolation: "linear" },
      { at: { numerator: 1, denominator: end }, value: 1, interpolation: "hold" },
    ],
  });
  const motion = () => [
    geometry(curve(4, 0.85)),
    { processor: { type: "opacity", opacity: curve(8, 0) } },
  ];
  await p.edit(
    [0, 1].map((i) => ({ operation: "processing.set", target: target(i), steps: [geometry(1)] })),
  );
  const refs = [];
  for (const arm of [reference, baseline]) {
    const authored = await arm.edit([
      { operation: "track.add", label: "caption", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "text",
        clip: {
          trackId: { label: "caption" },
          source: { ...style, kind: "text", text: "New  Trend! now" },
          placement: { kind: "project", range: { startUs: 0, endUs: 4000000 } },
        },
      },
    ]);
    refs.push(authored.edit.labels.text);
  }
  // Independent fixture arithmetic: these windows/ranges are literal expected operands.
  const expectedRuns = (t) => [
    ...(t < 750000 ? [[0, 3]] : []),
    ...(t >= 625000 && t < 1500000 ? [[5, 11]] : []),
    ...(t >= 1375000 && t < 2000000 ? [[12, 15]] : []),
  ];
  async function numeric(arm, id, atUs, motionOn) {
    const scale = motionOn ? 0.85 + 0.15 * Math.min(atUs / 500000, 1) : 1;
    const opacity = motionOn ? Math.min(atUs / 250000, 1) : 1;
    await arm.edit([
      {
        operation: "text.set",
        clipId: id,
        source: {
          ...style,
          kind: "text",
          text: "New  Trend! now",
          activeRanges: expectedRuns(atUs),
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id },
        steps: [geometry(scale), { processor: { type: "opacity", opacity } }],
      },
    ]);
    return { scale, opacity };
  }
  async function compare(atUs, label, motionOn) {
    const values = await numeric(reference, refs[0], atUs, motionOn);
    await numeric(baseline, refs[1], atUs, false);
    const actual = await picture({ ...p.selection(), atUs }, label + "-candidate");
    const expected = await picture({ ...reference.selection(), atUs }, label + "-reference");
    const before = await picture({ ...baseline.selection(), atUs }, label + "-baseline");
    assert.deepEqual(
      await rgba(actual.path),
      await rgba(expected.path),
      label + ": independent numeric reference",
    );
    const layout = actual.receipt.pictures.find((row) => row.kind === "text").layout;
    assert.deepEqual(layout.activeRanges, expectedRuns(atUs));
    assert.deepEqual(layout.visibleRange, [0, 15]);
    assert.ok(layout.lines.every((line) => line.fonts.every((face) => face === "ArialMT")));
    report.captionTimedMotion.stillComparisons.push({
      label,
      atUs,
      expectedRuns: expectedRuns(atUs),
      ...values,
      candidateSha256: hash(actual.bytes),
      referenceSha256: hash(expected.bytes),
      baselineSha256: hash(before.bytes),
    });
    return actual;
  }
  // Variable A: fixed geometry, including immediately adjacent sampled word landmarks.
  for (const atUs of [562500, 625000, 687500, 750000, 1312500, 1375000, 1437500, 1500000])
    await compare(atUs, "highlight-" + atUs, false);
  console.log("timed-motion: highlight landmarks match independent numeric pixels");
  await p.edit(
    [0, 1].map((i) => ({ operation: "processing.set", target: target(i), steps: motion() })),
  );
  // Variable B: active windows fixed, numeric reference samples independently.
  for (const atUs of [0, 62500, 187500, 250000, 437500, 500000, 562500])
    await compare(atUs, "entrance-" + atUs, true);
  console.log("timed-motion: entrance samples match independent numeric pixels");
  const samePhase = await picture({ ...p.selection(), atUs: 2187500 }, "repeat-entrance");
  assert.deepEqual(samePhase.bytes, await readFile(join(out, "entrance-187500-candidate.png")));
  const splitBefore = await picture({ ...p.selection(), atUs: 187500 }, "before-split-entrance");
  await p.edit([{ operation: "split", clipIds: [captioned.edit.labels.caption0], atUs: 125000 }]);
  assert.deepEqual(
    (await picture({ ...p.selection(), atUs: 187500 }, "after-split-entrance")).bytes,
    splitBefore.bytes,
  );
  const sourceSplitBefore = await picture(
    { ...p.selection(), atUs: 1125000 },
    "before-source-split",
  );
  await p.edit([{ operation: "split", clipIds: [placed.edit.labels.speech0], atUs: 1000000 }]);
  assert.deepEqual(
    (await picture({ ...p.selection(), atUs: 1125000 }, "after-source-split")).bytes,
    sourceSplitBefore.bytes,
  );
  await p.edit([
    {
      operation: "retime",
      clipIds: [placed.edit.labels.speech1],
      durationUs: 1000000,
      pitch: "preserve",
      ripple: "none",
    },
  ]);
  assert.deepEqual(
    (await picture({ ...p.selection(), atUs: 2125000 }, "retimed-entrance")).bytes,
    await readFile(join(out, "entrance-250000-candidate.png")),
  );
  assert.deepEqual(
    (await picture({ ...p.selection(), atUs: 2687500 }, "retimed-overlap")).bytes,
    await readFile(join(out, "highlight-1375000-candidate.png")),
  );
  console.log("timed-motion: repeat, cue/source split and retime preserve pixels");

  const range = { startUs: 90000, endUs: 590000 },
    paths = { full: join(out, "motion-full.mp4"), range: join(out, "motion-range.mp4") };
  for (const name of ["full", "range"]) {
    const selection = { ...p.selection(), ...(name === "range" ? { range } : {}) };
    await poll(
      () => call("preview.get", selection),
      (v) => v.state === "ready",
      "motion " + name,
    );
    await call("preview.get", selection, { output: paths[name] });
  }
  const exportId = randomUUID();
  await call("export.create", {
    ...p.selection(),
    exportId,
    kind: "video",
    directory: out,
    leaf: "motion-export.mp4",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "motion export",
  );
  assert.deepEqual(await readFile(paths.full), await readFile(exported.output));
  const movieReference = await project(canvas);
  const referenceTrack = await movieReference.edit([
    { operation: "track.add", label: "text", track: { kind: "video", order: 0 } },
  ]);
  await movieReference.edit(
    Array.from({ length: 48 }, (_, i) => {
      // The second speech occurrence was retimed to 1 second above. Its content-anchored
      // caption inherits that extent; retained source word windows still span 2 seconds.
      const atUs = i * 62500,
        sourceUs = atUs < 2000000 ? atUs : (atUs - 2000000) * 2;
      const scale = 0.85 + 0.15 * Math.min(sourceUs / 500000, 1),
        opacity = Math.min(sourceUs / 250000, 1);
      return [
        {
          operation: "place",
          label: "sample" + i,
          clip: {
            trackId: referenceTrack.edit.labels.text,
            source: {
              ...style,
              kind: "text",
              text: "New  Trend! now",
              activeRanges: expectedRuns(sourceUs),
            },
            placement: { kind: "project", range: { startUs: atUs, endUs: atUs + 62500 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "sample" + i } },
          steps: [geometry(scale), { processor: { type: "opacity", opacity } }],
        },
      ];
    }).flat(),
  );
  const referencePath = join(out, "motion-reference.mp4");
  await poll(
    () => call("preview.get", movieReference.selection()),
    (v) => v.state === "ready",
    "numeric movie reference",
  );
  await call("preview.get", movieReference.selection(), { output: referencePath });
  async function decoded(path) {
    return (
      await run("ffmpeg", ["-v", "error", "-i", path, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], {
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  }
  const [full, clipped, numericMovie] = await Promise.all([
      decoded(paths.full),
      decoded(paths.range),
      decoded(referencePath),
    ]),
    size = 640 * 180 * 3;
  const samples = Array.from({ length: 48 }, (_, i) => i * 62500).filter(
    (t) => t + 62500 > range.startUs && t < range.endUs,
  );
  assert.equal(full.length, size * 48);
  assert.equal(numericMovie.length, full.length);
  assert.equal(clipped.length, size * samples.length);
  const pts = {};
  for (const name of ["full", "range"]) {
    const probe = JSON.parse(
      (
        await run("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_frames",
          "-show_entries",
          "frame=best_effort_timestamp_time",
          "-of",
          "json",
          paths[name],
        ])
      ).stdout,
    );
    pts[name] = probe.frames.map((f) => Math.round(Number(f.best_effort_timestamp_time) * 1000000));
  }
  assert.deepEqual(
    pts.full,
    Array.from({ length: 48 }, (_, i) => i * 62500),
  );
  assert.deepEqual(
    pts.range,
    samples.map((t) => Math.max(t, range.startUs) - range.startUs),
  );
  report.captionTimedMotion.movieReferenceComparisons = [];
  for (let i = 0; i < 48; i++) {
    let error = 0,
      count = 0;
    for (let y = 65; y < 155; y++)
      for (let x = 20; x < 620; x++)
        for (let c = 0; c < 3; c++) {
          const offset = i * size + (y * 640 + x) * 3 + c;
          error += Math.abs(full[offset] - numericMovie[offset]);
          count++;
        }
    const meanAbsoluteError = error / count;
    assert.ok(
      meanAbsoluteError < 3,
      `numeric delivered caption reference at ${i * 62500}: ${meanAbsoluteError}`,
    );
    report.captionTimedMotion.movieReferenceComparisons.push({
      atUs: i * 62500,
      meanAbsoluteError,
    });
  }
  for (let i = 0; i < samples.length; i++) {
    let error = 0,
      count = 0;
    // Caption-only mask includes all ink, transformed edges and surrounding space.
    for (let y = 65; y < 155; y++)
      for (let x = 20; x < 620; x++)
        for (let c = 0; c < 3; c++) {
          const offset = (y * 640 + x) * 3 + c;
          error += Math.abs(
            full[(samples[i] / 62500) * size + offset] - clipped[i * size + offset],
          );
          count++;
        }
    const meanAbsoluteError = error / count;
    assert.ok(
      meanAbsoluteError < 3,
      `mid-entrance delivered phase at ${samples[i]}: ${meanAbsoluteError}`,
    );
    report.captionTimedMotion.movieComparisons.push({
      sampleAtUs: samples[i],
      rangeLocalUs: Math.max(samples[i], range.startUs) - range.startUs,
      meanAbsoluteError,
    });
  }
  console.log("timed-motion: numeric movie, clipped absolute phase and committed export verified");
  report.checks.push({
    name: "timed-caption-motion",
    exactNumericStillPixels: true,
    numericMovieReference: true,
    correctedAndDroppedDisplay: true,
    overlappingRuns: true,
    repeatedOccurrence: true,
    cueSplitPreservesPhase: true,
    sourceSplitPreservesHighlight: true,
    retimePreservesPhase: true,
    range,
    exactPreviewExportBytes: true,
  });
}
