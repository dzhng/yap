import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rational, toTime } from "../../composition/dist/index.js";
import { hash, poll, run } from "./source-evidence-fixture.mjs";

export async function matchedMovieAudio({ call, out, canvas, name, expected, wrong, range }) {
  assert.equal(expected.length % 8, 0, "Movie oracle must contain complete stereo Float32 frames");
  assert.equal(wrong.length, expected.length, "Control must span the same movie timeline");
  const durationUs = toTime(rational(BigInt(expected.length / 8) * 1000000n, 48000n));
  // Encode the independent PCM through a plain unit-rate project with matched ranges.
  // This proves movie audio delivery without comparing lossy AAC to lossless PCM.
  async function movieReference(name, pcm) {
    const raw = join(out, name + ".f32");
    const wav = join(out, name + ".wav");
    await writeFile(raw, pcm);
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "f32le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      raw,
      "-c:a",
      "pcm_f32le",
      wav,
    ]);
    const pending = await call("asset.import", { path: wav, requestId: name + "-import" });
    const imported = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (value) => value.state === "ready",
      name + "-import",
    );
    const asset = await call("asset.get", { assetId: imported.published.output.assetId });
    const created = await call("project.create", {
      requestId: name + "-project",
      canvas,
    });
    const edited = await call("edit.apply", {
      projectId: created.project.projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: name + "-place",
      operations: [
        { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
        {
          operation: "place",
          clip: {
            trackId: { label: "audio" },
            assetId: asset.id,
            streamId: asset.streams[0].streamId,
            source: { kind: "range", range: { startUs: 0, endUs: durationUs } },
            placement: { kind: "project", range: { startUs: 0, endUs: durationUs } },
          },
        },
      ],
    });
    return { projectId: created.project.projectId, revisionId: edited.revision.revisionId };
  }
  async function referencePreview(selection, name, range) {
    const path = join(out, name + ".mp4");
    await poll(
      () =>
        call(
          "preview.get",
          {
            ...selection,
            ...(range ? { range } : {}),
            settings: { preset: "balanced" },
          },
          { output: path },
        ),
      (value) => value.state === "ready",
      name,
    );
    return path;
  }
  async function decoded(path) {
    const { stdout } = await run(
      "ffmpeg",
      ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "-"],
      { encoding: "buffer", maxBuffer: 4000000 },
    );
    assert(stdout.length > 0, "Movie must contain decoded audio");
    return stdout;
  }
  const referenceSelection = await movieReference(name + "movie-reference", expected);
  const result = {
    harnessSha256: hash(await readFile(import.meta.filename)),
    pcmSha256: hash(expected),
    matchedAAC: {},
  };
  for (const [kind, selectionRange] of [
    ["full", null],
    ["range", range],
  ]) {
    const actualPath = join(out, name + kind + "-preview.mp4");
    const referencePath = await referencePreview(
      referenceSelection,
      name + "reference-" + kind,
      selectionRange,
    );
    const actual = await decoded(actualPath),
      reference = await decoded(referencePath);
    assert(
      actual.equals(reference),
      kind + " movie audio must equal matched independent reference AAC",
    );
    await writeFile(join(out, name + kind + "-decoded.f32"), actual);
    result.matchedAAC[kind] = {
      decodedBytes: actual.length,
      sha256: hash(actual),
      exact: true,
      actualMovieSha256: hash(await readFile(actualPath)),
      referenceMovieSha256: hash(await readFile(referencePath)),
    };
  }
  const wrongSelection = await movieReference(name + "movie-control", wrong);
  const wrongAAC = await decoded(
    await referencePreview(wrongSelection, name + "reference-control"),
  );
  assert.notEqual(hash(wrongAAC), result.matchedAAC.full.sha256);
  result.control = { pcmSha256: hash(wrong), decodedSha256: hash(wrongAAC), differs: true };
  return result;
}
