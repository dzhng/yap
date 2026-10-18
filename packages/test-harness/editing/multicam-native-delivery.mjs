import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { verifyMulticamBehavior } from "./multicam-behavior.mjs";
import { verifyMulticamCorpus } from "./multicam-corpus.mjs";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../../../", import.meta.url).pathname;
const recipePath = join(
  root,
  "specs/done/video-editing-feedback/assets/01-corpus-multicam/behavior-recipe.json",
);
const width = 320;
const height = 180;
const channels = 3;
const frameBytes = width * height * channels;
const frameDurationUs = 1_000_000;
// The preview is an H.264 delivery round trip; direct frame PNGs are lossless.
// Keep this bounded rather than claiming byte parity across the two codecs.
const previewMaeLimit = 12;

const refuse = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

const contained = (rootDirectory, artifact) => {
  if (typeof artifact !== "string" || artifact.length === 0)
    refuse("ARTIFACT_PATH", "Retained native evidence must name an artifact");
  const path = resolve(rootDirectory, artifact);
  const local = relative(resolve(rootDirectory), path);
  if (!artifact || isAbsolute(artifact) || local.startsWith("..") || isAbsolute(local))
    refuse("ARTIFACT_PATH", "Retained native evidence must stay inside its report directory");
  return path;
};

const readArtifact = async (rootDirectory, artifact, code, expectedHash) => {
  const path = contained(rootDirectory, artifact);
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? ""))
    refuse(code, `Retained native evidence artifact hash is missing: ${artifact}`);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile())
    refuse(code, `Retained native evidence artifact is not a regular file: ${artifact}`);
  const bytes = await readFile(path);
  if (hash(bytes) !== expectedHash)
    refuse(code, `Retained native evidence artifact bytes differ: ${artifact}`);
  return { path, bytes };
};

const decodeFrames = async (path, count, { exact = false } = {}) => {
  const requestedCount = exact ? count + 1 : count;
  const { stdout } = await execFileAsync(
    process.env.YAP_FFMPEG ?? "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-frames:v",
      String(requestedCount),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: frameBytes * requestedCount + 1024 },
  );
  const expectedBytes = frameBytes * count;
  if (stdout.length < expectedBytes || (exact && stdout.length > expectedBytes))
    refuse("PICTURE_DECODE", `${path}: expected ${count} ${width}x${height} RGB frames`);
  return Array.from({ length: count }, (_, index) =>
    stdout.subarray(index * frameBytes, (index + 1) * frameBytes),
  );
};

const decodeFrame = async (path) => {
  return (await decodeFrames(path, 1))[0];
};

const mae = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  let difference = 0;
  for (let index = 0; index < actual.length; index++)
    difference += Math.abs(actual[index] - expected[index]);
  return difference / actual.length;
};

const sourceManifest = async (fixturesDirectory) =>
  JSON.parse(await readFile(join(fixturesDirectory, "picture-manifest.json"), "utf8"));

/** Replay the retained native multicam report without launching a service. */
export async function verifyRetainedMulticamNativeDelivery(reportPath, fixturesDirectory) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const pictures = await sourceManifest(fixturesDirectory);
  const corpus = await verifyMulticamCorpus(fixturesDirectory);
  const recipeIdentityPath = join(
    root,
    "specs/done/video-editing-feedback/assets/01-corpus-multicam/behavior-recipe.identity.json",
  );
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  const behavior = await verifyMulticamBehavior(fixturesDirectory, recipePath, recipeIdentityPath);
  const sourceNames = corpus.coverage.sources;
  if (report.passed !== true || report.kind !== "retained-multicam-native-delivery")
    refuse("REPORT_STATUS", "Native multicam report is not a passing retained delivery");
  if (JSON.stringify(report.sources) !== JSON.stringify(sourceNames))
    refuse("SOURCE_COVERAGE", "Native multicam report has the wrong source set");
  const reportDirectory = resolve(reportPath, "..");
  if (behavior.selectionCount !== recipe.selections.length)
    refuse("SELECTION_COVERAGE", "Caller-authored source schedule and recipe disagree");
  if (!/^[a-f0-9]{64}$/.test(report.nativeSha256 ?? ""))
    refuse("NATIVE_IDENTITY", "Native worker identity is missing from the receipt");
  if (
    !report.workerIdentity ||
    typeof report.workerIdentity.path !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.workerIdentity.fileSha256 ?? "")
  )
    refuse("NATIVE_IDENTITY", "Native worker identity artifact is missing from the receipt");
  const workerIdentityArtifact = await readArtifact(
    reportDirectory,
    report.workerIdentity.path,
    "NATIVE_IDENTITY",
    report.workerIdentity.fileSha256,
  );
  let nativeIdentity;
  try {
    nativeIdentity = JSON.parse(workerIdentityArtifact.bytes);
  } catch {
    refuse("NATIVE_IDENTITY", "Native worker identity artifact is not valid JSON");
  }
  if (nativeIdentity.kind !== "native-worker" || nativeIdentity.sha256 !== report.nativeSha256)
    refuse("NATIVE_IDENTITY", "Native worker identity differs from the retained identity receipt");
  if (!Array.isArray(recipe.selections) || recipe.selections.length !== 9)
    refuse("SELECTION_COVERAGE", "Caller-authored multicam recipe must contain nine selections");
  if (report.project?.frameRate !== 1 || report.project?.frameCount !== recipe.selections.length)
    refuse(
      "PROJECT_SHAPE",
      "Native multicam project must contain one frame per authored selection",
    );
  if (report.synchronization !== "not-established" || report.cameraChoice !== "caller-authored")
    refuse("SCOPE", "Native multicam evidence must not promote sync or automatic camera choice");
  if (!Array.isArray(report.selections) || report.selections.length !== recipe.selections.length)
    refuse("SELECTION_COVERAGE", "Native multicam report must contain nine selections");
  const canonicalFrames = new Map();
  for (const source of sourceNames) {
    const samples = pictures.sources[source].samples;
    const decoded = await decodeFrames(
      join(fixturesDirectory, pictures.sources[source].path),
      samples.length,
    );
    for (const [index, bytes] of decoded.entries()) {
      if (hash(bytes) !== samples[index].sha256)
        refuse("PICTURE_SELECTION", `${source} retained sample ${index} changed`);
      canonicalFrames.set(`${source}:${index}`, bytes);
    }
  }
  const previewArtifact = await readArtifact(
    reportDirectory,
    report.preview?.path,
    "NATIVE_PREVIEW",
    report.preview?.fileSha256,
  );
  const previewPath = previewArtifact.path;
  const previewFrames = await decodeFrames(previewPath, report.selections.length, { exact: true });
  if (hash(Buffer.concat(previewFrames)) !== report.preview?.rgbSha256)
    refuse("NATIVE_PREVIEW", "Retained preview RGB bytes differ");
  for (const [index, selection] of report.selections.entries()) {
    const authored = behavior.selections[index];
    if (
      selection.sequenceIndex !== index ||
      selection.source !== authored.source ||
      selection.pictureSampleIndex !== authored.pictureSampleIndex ||
      selection.audioWindowStartUs !== authored.audioWindowStartUs ||
      !sourceNames.includes(selection.source)
    )
      refuse("SELECTION_ORDER", `Selection ${index} has the wrong source order`);
    if (!Number.isInteger(selection.pictureSampleIndex) || selection.pictureSampleIndex < 0)
      refuse("PICTURE_SELECTION", `Selection ${index} has the wrong picture sample`);
    const expected = pictures.sources[selection.source]?.samples?.[selection.pictureSampleIndex];
    if (
      !expected ||
      selection.sourcePictureSha256 !== authored.pictureSha256 ||
      authored.pictureSha256 !== expected.sha256
    )
      refuse("PICTURE_SELECTION", `Selection ${index} is not bound to its retained picture sample`);
    const canonical = canonicalFrames.get(`${selection.source}:${selection.pictureSampleIndex}`);
    const sourceFrameArtifact = await readArtifact(
      reportDirectory,
      selection.sourceFrame?.path,
      "NATIVE_FRAME",
      selection.sourceFrame?.fileSha256,
    );
    const sourceFramePath = sourceFrameArtifact.path;
    const sourceFrame = await decodeFrame(sourceFramePath);
    if (hash(sourceFrame) !== selection.sourceFrame?.rgbSha256)
      refuse("NATIVE_FRAME", `Source frame ${index} RGB bytes differ`);
    const sourceMae = mae(sourceFrame, canonical);
    if (Math.abs(sourceMae - selection.sourceFrame.mae) > 1e-12 || sourceMae > previewMaeLimit)
      refuse("NATIVE_FRAME", `Source frame ${index} is not bound to its retained picture sample`);
    const nativeFrameArtifact = await readArtifact(
      reportDirectory,
      selection.nativeFrame?.path,
      "NATIVE_FRAME",
      selection.nativeFrame?.fileSha256,
    );
    const nativeFramePath = nativeFrameArtifact.path;
    const nativeFrame = await decodeFrame(nativeFramePath);
    if (hash(nativeFrame) !== selection.nativeFrame?.rgbSha256)
      refuse("NATIVE_FRAME", `Native frame ${index} RGB bytes differ`);
    const nativeMae = mae(nativeFrame, sourceFrame);
    if (Math.abs(nativeMae - selection.nativeFrame.mae) > 1e-12 || nativeMae > 2)
      refuse("NATIVE_FRAME", `Selection ${index} drifted from its retained source frame`);
    const previewFrame = previewFrames[index];
    const previewMae = mae(previewFrame, sourceFrame);
    if (
      hash(previewFrame) !== selection.previewFrame?.rgbSha256 ||
      Math.abs(previewMae - selection.previewFrame.mae) > 1e-12 ||
      previewMae > previewMaeLimit
    )
      refuse("NATIVE_PREVIEW", `Preview frame ${index} drifted from its retained source frame`);
  }
  return {
    ok: true,
    kind: report.kind,
    sources: report.sources,
    selectionCount: report.selections.length,
    synchronization: report.synchronization,
    cameraChoice: report.cameraChoice,
  };
}

export async function runRetainedMulticamNativeDelivery(outDirectory) {
  assert.ok(process.env.YAP_NATIVE, "YAP_NATIVE must point at the native worker");
  const out = resolve(outDirectory);
  const fixturesDirectory = join(root, "fixtures/video-editing-feedback/synchronization");
  const pictures = await sourceManifest(fixturesDirectory);
  const corpus = await verifyMulticamCorpus(fixturesDirectory);
  const sourceNames = corpus.coverage.sources;
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  const recipeIdentityPath = join(
    root,
    "specs/done/video-editing-feedback/assets/01-corpus-multicam/behavior-recipe.identity.json",
  );
  const behavior = await verifyMulticamBehavior(fixturesDirectory, recipePath, recipeIdentityPath);
  const pictureSampleIndexes = pictures.sources[sourceNames[0]].samples.map(
    ({ frameIndex }) => frameIndex,
  );
  for (const source of sourceNames) {
    if (
      JSON.stringify(pictures.sources[source].samples.map(({ frameIndex }) => frameIndex)) !==
      JSON.stringify(pictureSampleIndexes)
    )
      refuse("PICTURE_COVERAGE", `${source}: picture sample indexes differ`);
  }
  const existing = await readdir(out).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (existing.length > 0)
    refuse("OUTPUT_DIR_NOT_EMPTY", "Native multicam output directory must be empty");
  const workerIdentityPath = "worker-identity.json";
  const nativeBytes = await readFile(process.env.YAP_NATIVE);
  const nativeSha256 = hash(nativeBytes);
  const workerIdentityBytes = Buffer.from(
    `${JSON.stringify({ kind: "native-worker", sha256: nativeSha256 })}\n`,
  );
  const report = {
    passed: false,
    kind: "retained-multicam-native-delivery",
    trace: [],
    exchanges: [],
    sources: sourceNames,
    synchronization: "not-established",
    cameraChoice: "caller-authored",
    nativeSha256,
    workerIdentity: {
      path: workerIdentityPath,
      fileSha256: hash(workerIdentityBytes),
    },
    project: { width, height, frameRate: 1, frameCount: recipe.selections.length },
    selections: [],
    checks: [],
  };
  await mkdir(out, { recursive: true });
  const home = await mkdtemp("/tmp/yap-retained-multicam-native-");
  const evidenceDirectory = join(out, "native");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(out, workerIdentityPath), workerIdentityBytes);
  const service = new JourneyService(home, report, evidenceDirectory);
  const call = service.call.bind(service);
  const save = () => writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const imported = new Map();
  try {
    await service.start();
    for (const source of sourceNames) {
      const sourcePath = join(fixturesDirectory, pictures.sources[source].path);
      assert.equal(
        hash(await readFile(sourcePath)),
        pictures.sources[source].sha256,
        `${source}: retained picture source changed`,
      );
      const request = await call("asset.import", { requestId: randomUUID(), path: sourcePath });
      const ready = await poll(
        () => call("job.get", { jobId: request.jobId }),
        (value) => value.state === "ready",
        `${source} import`,
      );
      const asset = await call(
        "asset.get",
        { assetId: ready.published.output.assetId },
        { transport: "mcp" },
      );
      imported.set(source, { asset });
    }
    const project = await call("project.create", {
      requestId: randomUUID(),
      canvas: { width, height, fps: { numerator: 1, denominator: 1 }, background: "#000000ff" },
    });
    const selections = behavior.selections.map(
      ({ source, pictureSampleIndex, audioWindowStartUs }) => ({
        source,
        pictureSampleIndex,
        audioWindowStartUs,
      }),
    );
    const members = new Map(
      sourceNames.map((source) => [
        source,
        {
          asset: imported.get(source).asset,
          streamId: imported.get(source).asset.streams.find((stream) => stream.kind === "video")
            .streamId,
        },
      ]),
    );
    const sourceNativeFrames = new Map();
    const canonicalFrames = new Map();
    for (const source of sourceNames) {
      const decoded = await decodeFrames(
        join(fixturesDirectory, pictures.sources[source].path),
        pictureSampleIndexes.length,
      );
      for (const [index, bytes] of decoded.entries())
        canonicalFrames.set(`${source}:${index}`, bytes);
    }
    for (const source of sourceNames) {
      const member = members.get(source);
      for (const pictureSampleIndex of pictureSampleIndexes) {
        const frameRequest = {
          assetId: member.asset.id,
          streamId: member.streamId,
          atUs: pictureSampleIndex * frameDurationUs + 500_000,
          maxLongEdge: width,
        };
        await poll(
          () => call("frame.get", frameRequest),
          (value) => value.state === "ready",
          `${source} source frame ${pictureSampleIndex}`,
        );
        const framePath = join(out, `source-frame-${source}-${pictureSampleIndex}.png`);
        await call("frame.get", frameRequest, { output: framePath });
        const bytes = await decodeFrame(framePath);
        const frameFile = await readFile(framePath);
        sourceNativeFrames.set(`${source}:${pictureSampleIndex}`, {
          bytes,
          path: relative(out, framePath),
          fileSha256: hash(frameFile),
          rgbSha256: hash(bytes),
          mae: mae(bytes, canonicalFrames.get(`${source}:${pictureSampleIndex}`)),
        });
      }
    }
    const edited = await call("edit.apply", {
      projectId: project.project.projectId,
      expectedRevisionId: project.revision.revisionId,
      requestId: randomUUID(),
      operations: [
        { operation: "track.add", label: "retained-multicam", track: { kind: "video", order: 0 } },
        ...selections.map(({ source, pictureSampleIndex }, sequenceIndex) => {
          const member = members.get(source);
          return {
            operation: "place",
            label: `selection-${sequenceIndex}`,
            clip: {
              trackId: { label: "retained-multicam" },
              assetId: member.asset.id,
              streamId: member.streamId,
              source: {
                kind: "range",
                range: {
                  startUs: pictureSampleIndex * frameDurationUs,
                  endUs: (pictureSampleIndex + 1) * frameDurationUs,
                },
              },
              placement: {
                kind: "project",
                range: {
                  startUs: sequenceIndex * frameDurationUs,
                  endUs: (sequenceIndex + 1) * frameDurationUs,
                },
              },
            },
          };
        }),
      ],
    });
    report.project.projectId = project.project.projectId;
    report.project.revisionId = edited.revision.revisionId;

    for (const [sequenceIndex, selection] of selections.entries()) {
      const { source, pictureSampleIndex } = selection;
      const expected = sourceNativeFrames.get(`${source}:${pictureSampleIndex}`);
      const framePath = join(out, `frame-${String(sequenceIndex).padStart(2, "0")}.png`);
      const atUs = sequenceIndex * frameDurationUs + 500_000;
      const frameRequest = {
        projectId: project.project.projectId,
        revisionId: edited.revision.revisionId,
        atUs,
        maxLongEdge: width,
      };
      await poll(
        () => call("frame.get", frameRequest),
        (value) => value.state === "ready",
        `retained multicam frame ${sequenceIndex}`,
      );
      await call("frame.get", frameRequest, { output: framePath });
      const actualFrame = await decodeFrame(framePath);
      const frameFile = await readFile(framePath);
      report.selections.push({
        sequenceIndex,
        source,
        pictureSampleIndex,
        audioWindowStartUs: selection.audioWindowStartUs,
        sourcePictureSha256: pictures.sources[source].samples[pictureSampleIndex].sha256,
        sourceFrame: {
          path: expected.path,
          fileSha256: expected.fileSha256,
          rgbSha256: expected.rgbSha256,
          mae: expected.mae,
        },
        nativeFrame: {
          path: relative(out, framePath),
          fileSha256: hash(frameFile),
          rgbSha256: hash(actualFrame),
          mae: mae(actualFrame, expected.bytes),
        },
      });
    }

    const previewPath = join(out, "preview.mp4");
    await poll(
      () =>
        call(
          "preview.get",
          {
            projectId: project.project.projectId,
            revisionId: edited.revision.revisionId,
            range: { startUs: 0, endUs: selections.length * frameDurationUs },
          },
          { output: previewPath },
        ),
      (value) => value.state === "ready",
      "retained multicam preview",
    );
    const previewFrames = await decodeFrames(previewPath, selections.length, { exact: true });
    const previewBytes = Buffer.concat(previewFrames);
    for (const [sequenceIndex, selection] of selections.entries()) {
      const expected = sourceNativeFrames.get(
        `${selection.source}:${selection.pictureSampleIndex}`,
      );
      const actual = previewFrames[sequenceIndex];
      report.selections[sequenceIndex].previewFrame = {
        rgbSha256: hash(actual),
        mae: mae(actual, expected.bytes),
      };
    }
    report.preview = {
      path: relative(out, previewPath),
      fileSha256: hash(await readFile(previewPath)),
      rgbSha256: hash(previewBytes),
    };
    report.checks.push(
      "public CLI/MCP imports the three retained picture sources",
      "native frame delivery preserves all nine caller-authored source/sample selections",
      "native preview delivery preserves the nine selected retained frames",
    );
    report.passed = true;
  } finally {
    await service.stop();
    await rm(home, { recursive: true, force: true });
    if (report.passed) await save();
    else await rm(out, { recursive: true, force: true });
  }
  await verifyRetainedMulticamNativeDelivery(join(out, "report.json"), fixturesDirectory);
  await save();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" }, report: { type: "string" }, fixtures: { type: "string" } },
  });
  try {
    if (positionals[0] === "verify" && values.report && values.fixtures)
      console.log(
        JSON.stringify(await verifyRetainedMulticamNativeDelivery(values.report, values.fixtures)),
      );
    else if (positionals[0] === "run" && values.out)
      console.log(JSON.stringify(await runRetainedMulticamNativeDelivery(values.out)));
    else throw new Error("Usage: run --out DIRECTORY | verify --report FILE --fixtures DIRECTORY");
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error: { code: error.code ?? "INVALID_NATIVE_MULTICAM", message: error.message },
      }),
    );
    process.exitCode = 1;
  }
}
