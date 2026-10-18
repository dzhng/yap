import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { assertMatchedInputs } from "./encoded-appearance-inputs.mjs";

// Additional captured-media evidence consumes the existing authored curve journey.
export async function captureKeyframeAppearance({
  out,
  home,
  report,
  call,
  geometry,
  original,
  projectId,
  clipId,
  stepId,
  movedRevisionId,
  head,
  fullPath,
  rangePath,
}) {
  const directory = join(out, "appearance"),
    native = join(out, "native"),
    decoder = join(home, "decode-appearance"),
    pixels = join(home, "appearance-pixels");
  await mkdir(directory);
  for (const [source, target] of [
    ["EncodedAppearanceFrames.swift", decoder],
    ["FrameImagePixels.swift", pixels],
  ])
    await run("swiftc", [
      "-parse-as-library",
      join(root, "packages/test-harness/editing", source),
      "-o",
      target,
    ]);
  const evidence = {
    passed: false,
    settings: report.settings,
    nativeSHA256: report.workerSha256,
    case: report.case,
    cohorts: [],
    references: [],
    scope:
      "Frozen animation and encoded appearance; no continuous playback, listening or whole-slice acceptance",
  };
  const historical =
    report.case === "moved-split-zoom"
      ? "16-zoom"
      : report.case === "moved-split-pose"
        ? "16-pose"
        : "16-geometry";
  const frozen = JSON.parse(
    gunzipSync(
      await readFile(
        join(root, "specs/done/agent-editing/assets", historical, "root-public.json.gz"),
      ),
    ),
  );
  const transferred = JSON.parse(
    await readFile(
      join(root, "specs/done/agent-editing/assets/16-animated-appearance/preencode-reference.json"),
      "utf8",
    ),
  );
  evidence.preencodeChecks = [];
  // Boundary fixes intentionally changed old PNGs; the explicit replay table pins each transfer.
  // Preserve every exact pre-encode lifecycle/analytic control, not only movie samples.
  for (const picture of report.pictures) {
    const prior = frozen.pictures.find((p) => p.name === picture.name);
    assert(prior, picture.name);
    const transfer = transferred.references[report.case]?.find(
      (entry) => entry.historicalSHA256 === prior.sha256,
    );
    const expectedSHA256 = transfer?.correctedSHA256 ?? prior.sha256;
    evidence.preencodeChecks.push({
      name: picture.name,
      historicalSHA256: prior.sha256,
      expectedSHA256,
      actualSHA256: picture.sha256,
      historicalByteMatch: picture.sha256 === prior.sha256,
      correctedReference: transfer ?? null,
    });
    assert.equal(
      picture.sha256,
      expectedSHA256,
      `Frozen/correction-backed ${picture.name} changed`,
    );
  }
  for (const [i, picture] of original.entries()) {
    const path = join(directory, `reference-${i}.png`);
    await copyFile(picture.file, path);
    const color = JSON.parse((await run(pixels, [path, path + ".rgba"])).stdout);
    evidence.references.push({
      index: i,
      sampleAtUs: 2000000 + i * 125000,
      path,
      sha256: hash(await readFile(path)),
      color,
    });
  }
  const records = async () =>
    Promise.all(
      (await readdir(native))
        .filter((n) => n.endsWith(".json"))
        .map(async (name) => ({
          path: join(native, name),
          data: JSON.parse(await readFile(join(native, name), "utf8")),
        })),
    );
  async function retain(path, name, label, range, eligible) {
    const candidates = eligible.filter(
      (r) =>
        r.data.operation === "media.renderCompositionMovie" &&
        r.data.request.range.startUs === range.startUs &&
        r.data.request.range.endUs === range.endUs,
    );
    assert.equal(candidates.length, 1, `${name}/${label} capture is not unique`);
    const capture = candidates[0],
      prefix = capture.path.slice(0, -5),
      dest = join(directory, name, label);
    await mkdir(dest, { recursive: true });
    assert.equal(
      hash(await readFile(path)),
      hash(await readFile(prefix + "-output")),
      "Captured writer output differs from delivered movie",
    );
    assert.deepEqual(capture.data.request.settings, report.settings);
    await copyFile(path, join(dest, "movie.mp4"));
    await copyFile(capture.path, join(dest, "native-request.json"));
    await copyFile(prefix + "-frames.jsonl", join(dest, "compiled.frames.jsonl"));
    const frames = (await readFile(prefix + "-frames.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert(
      !capture.data.request.pointers,
      "Frozen still-source cohort unexpectedly has pointer preparation",
    );
    await run(decoder, [path, join(dest, "decoded")]);
    const decoded = JSON.parse(await readFile(join(dest, "decoded/frames.json"), "utf8"));
    assert.equal(decoded.frames.length, frames.length);
    const expectedSamples =
      label === "range"
        ? [2250000, 2375000, 2500000, 2625000, 2750000]
        : Array.from({ length: 24 }, (_, i) => i * 125000);
    assert.deepEqual(
      frames.map((frame) => frame.sampleAtUs),
      expectedSamples,
      "Frozen animation sample clock changed",
    );
    for (const [i, f] of frames.entries())
      assert.equal(
        BigInt(decoded.frames[i].pts.value) * 1000000n,
        BigInt(Math.max(range.startUs, f.visibleRange.startUs) - range.startUs) *
          BigInt(decoded.frames[i].pts.timescale),
      );
    return {
      label,
      path: join(dest, "movie.mp4"),
      range,
      frames,
      pointers: [],
      decoded,
      sha256: hash(await readFile(path)),
    };
  }
  try {
    const positiveRecords = await records();
    const positive = {
      name: "positive",
      full: await retain(
        fullPath,
        "positive",
        "full",
        { startUs: 0, endUs: 3000000 },
        positiveRecords,
      ),
      clipped: await retain(
        rangePath,
        "positive",
        "range",
        { startUs: 2250001, endUs: 2750001 },
        positiveRecords,
      ),
    };
    assertMatchedInputs(positive.full, positive.clipped);
    evidence.cohorts.push(positive);
    // Frozen controls have analytically authored poses at every sampled curve time.
    const phase = (value) =>
      Array.isArray(value)
        ? value.map(phase)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, v]) => [
                key,
                key === "at"
                  ? 2000000 + (v.numerator / v.denominator) * 1000000 + 125000
                  : phase(v),
              ]),
            )
          : value;
    for (const name of ["phase", "geometry"]) {
      const restored = await call("edit.restore", {
        projectId,
        requestId: randomUUID(),
        expectedRevisionId: head,
        targetRevisionId: movedRevisionId,
      });
      let processor = geometry();
      if (name === "phase") processor = phase(processor);
      else {
        const rect = processor.rect ?? { x: 0, y: 0, width: 40, height: 64 };
        const x =
          typeof rect.x === "number"
            ? rect.x + 4
            : { keys: rect.x.keys.map((key) => ({ ...key, value: key.value + 4 })) };
        processor = { ...processor, rect: { ...rect, x } };
      }
      const edited = await call("edit.apply", {
        projectId,
        expectedRevisionId: restored.id,
        requestId: randomUUID(),
        operations: [
          {
            operation: "processing.set",
            target: { kind: "clip", id: clipId },
            steps: [
              {
                id: stepId,
                processor,
                ...(name === "phase"
                  ? { window: { kind: "project", range: { startUs: 2000000, endUs: 3000000 } } }
                  : {}),
              },
            ],
          },
        ],
      });
      head = edited.revision.revisionId;
      const selection = { projectId, revisionId: edited.revision.revisionId },
        pictures = [];
      for (let i = 0; i < 8; i++) {
        const path = join(directory, `${name}-reference-${i}.png`);
        await poll(
          () => call("frame.get", { ...selection, atUs: 2000000 + i * 125000 }, { output: path }),
          (v) => v.state === "ready",
          `${name} picture`,
        );
        if (name === "phase")
          assert.equal(
            hash(await readFile(path)),
            original[Math.max(i - 1, 0)].sha256,
            "Delayed phase does not match prior frozen curve sample",
          );
        pictures.push({
          index: i,
          sampleAtUs: 2000000 + i * 125000,
          path,
          sha256: hash(await readFile(path)),
        });
      }
      const before = new Set((await records()).map((r) => r.path)),
        path = join(directory, `${name}.mp4`);
      await poll(
        () => call("preview.get", { ...selection, settings: report.settings }, { output: path }),
        (v) => v.state === "ready",
        `${name} movie`,
      );
      evidence.cohorts.push({
        name,
        pictures,
        full: await retain(
          path,
          name,
          "full",
          { startUs: 0, endUs: 3000000 },
          (await records()).filter((r) => !before.has(r.path)),
        ),
      });
    }
    evidence.frozenPictureChecks = report.pictures.length;
    evidence.passed = true;
  } finally {
    await writeFile(join(directory, "report.json"), JSON.stringify(evidence, null, 2) + "\n");
  }
  return evidence;
}
