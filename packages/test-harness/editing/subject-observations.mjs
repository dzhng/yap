import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, copyFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll, run, root, hash } from "./source-evidence-fixture.mjs";
import { faceObservationsSchema } from "@yap/protocol";
import { trackFaceObservations } from "@yap/core/face-tracking";
import { planSubjectFraming, rational } from "@yap/composition";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "media-root": { type: "string" },
    case: { type: "string" },
    "capture-root": { type: "string" },
    "framing-case": { type: "string" },
    "skip-motion": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "YAP_NATIVE=ABSOLUTE_WORKER node subject-observations.mjs --out EMPTY_DIRECTORY --media-root CERTIFIED_CORPUS_DIRECTORY [--case graham|madison|lily] [--capture-root PRIOR_EXACT_CAPTURE] [--framing-case contain-reachable|contain-center|contain-conflict|crop-center|crop-cap] [--skip-motion]\nAll72 frames/selected real host, independent face zones, planted movement/multiple/occlusion/orientation controls and public explicit geometry delivery. No models/devices; retained observations drive caller-selected geometry.",
  );
  process.exit(0);
}
assert.ok(
  values.out &&
    isAbsolute(values.out) &&
    values["media-root"] &&
    isAbsolute(process.env.YAP_NATIVE ?? ""),
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), []);
const gates = JSON.parse(
  await readFile(
    join(root, "specs/done/video-editing-feedback/assets/15-face-observations/gates.json"),
  ),
);
const manifest = JSON.parse(
  await readFile(join(root, "fixtures/video-editing-feedback/manifest.json")),
);
const retained = values["capture-root"]
  ? JSON.parse(await readFile(join(values["capture-root"], "report.json")))
  : null;
const selected = Object.keys(gates.faces).filter((id) => !values.case || id === values.case);
assert.ok(selected.length, "Select a declared host");
const home = await mkdtemp("/tmp/yap-subject-observations-");
const report = {
  passed: false,
  scope: gates.scope,
  gatesSha256: hash(
    await readFile(
      join(root, "specs/done/video-editing-feedback/assets/15-face-observations/gates.json"),
    ),
  ),
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
  trace: [],
  cases: [],
  controls: [],
  framing: [],
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service),
  save = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + "\n");
const request = { recipe: "vision-face-rectangles-v1" };
const iou = (a, b) => {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / (a.width * a.height + b.width * b.height - area);
};
function checkFaces(observations, expected) {
  const o = faceObservationsSchema.parse(observations);
  const failures = [];
  if (o.faces.length !== expected.length)
    failures.push(`expected ${expected.length} face(s); got ${o.faces.length}`);
  if (o.status !== (expected.length ? "available" : "no_face"))
    failures.push(`detector state ${o.status}`);
  const matches = expected.map((zone, index) => {
    const face = o.faces[index];
    if (!face) return { zone, face: null, overlap: 0 };
    const overlap = iou(face.boundingBox, zone);
    if (overlap < gates.localization.minimumBoxIoU)
      failures.push(`Independent zone IoU ${overlap} below ${gates.localization.minimumBoxIoU}`);
    const b = face.boundingBox,
      x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    assert.ok(
      x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height,
      "Detected center outside independently authored face zone",
    );
    return { zone, face, overlap };
  });
  return { observations: o, matches, localization: { passed: failures.length === 0, failures } };
}
let ordinal = 0;
try {
  const pictures = join(home, "images"),
    pixels = join(home, "pixels");
  await run("swiftc", [
    "-parse-as-library",
    join(root, "packages/test-harness/editing/SubjectEvidenceImages.swift"),
    "-o",
    pictures,
  ]);
  await run("swiftc", [
    "-parse-as-library",
    join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
    "-o",
    pixels,
  ]);
  async function rgba(file) {
    const raw = join(home, `rgba-${ordinal++}`);
    const profile = JSON.parse((await run(pixels, [file, raw])).stdout);
    const bytes = await readFile(raw);
    await rm(raw);
    return { profile, bytes };
  }
  async function imported(file, id) {
    const ack = await call("asset.import", { path: file, requestId: `import-${id}` });
    const ready = await poll(
      () => call("job.get", { jobId: ack.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    const asset = await call("asset.get", { assetId: ready.published.output.assetId });
    const stream = asset.streams.find((v) => ["video", "image"].includes(v.kind));
    return { source: { assetId: asset.id, streamId: stream.id }, stream };
  }
  async function frame(selection, file, atUs, options = {}) {
    const params = {
      ...selection,
      ...(atUs === undefined ? {} : { atUs }),
      maxLongEdge: 640,
      faceObservations: request,
      ...options,
    };
    await poll(
      () => call("frame.get", params, { transport: "mcp" }),
      (v) => v.state === "ready",
      "face frame",
    );
    return (await call("frame.get", params, { output: file })).published.output;
  }
  async function overlay(file, expected, o, output) {
    const operands = join(home, `overlay-${ordinal++}.json`);
    await save(operands, { authored: expected, detected: o.faces.map((v) => v.boundingBox) });
    await run(pictures, ["overlay", file, output, operands]);
  }
  await service.start();
  for (const id of selected) {
    const entry = manifest.cases.find((v) => v.id === `${id}-picture`),
      input = join(values["media-root"], entry.derivative.file);
    assert.equal(hash(await readFile(input)), entry.derivative.sha256);
    const directory = join(out, id);
    await mkdir(directory);
    const { source, stream } = await imported(input, id);
    const row = { id, inputSha256: entry.derivative.sha256, source, frames: [] };
    report.cases.push(row);
    if (retained) {
      const previous = retained.cases.find((c) => c.id === id);
      assert.equal(previous.inputSha256, row.inputSha256);
      assert.equal(retained.workerSha256, report.workerSha256);
      assert.equal(retained.gatesSha256, report.gatesSha256);
      row.frames = previous.frames;
      for (const f of row.frames) {
        const file = `frame-${String(f.ordinal).padStart(2, "0")}.png`,
          input = join(values["capture-root"], id, file);
        assert.equal(hash(await readFile(input)), f.pngSha256);
        await copyFile(input, join(directory, file));
        assert.equal(
          BigInt(f.receipt.sample.value) * 24n,
          BigInt(f.ordinal) * BigInt(f.receipt.sample.timescale),
        );
      }
      row.reusedAcceptedObservations = true;
    } else
      for (let n = 0; n < 72; n++) {
        const atUs = Math.ceil((n * 1_000_000) / 24),
          file = join(directory, `frame-${String(n).padStart(2, "0")}.png`);
        const receipt = await frame(source, file, atUs);
        assert.equal(
          BigInt(receipt.sample.value) * 24n,
          BigInt(n) * BigInt(receipt.sample.timescale),
          "Every exact native sample, without integer-us hold duplication",
        );
        const checked = checkFaces(receipt.faceObservations, [gates.faces[id]]);
        row.frames.push({
          ordinal: n,
          atUs,
          receipt,
          ...checked,
          pngSha256: hash(await readFile(file)),
        });
        if ([0, 12, 36, 71].includes(n))
          await overlay(
            file,
            [gates.faces[id]],
            checked.observations,
            join(directory, `overlay-${n}.png`),
          );
        if (n % 12 === 0) console.log(`${id}: ${n + 1}/72 delivered frames`);
      }
    row.tracks = trackFaceObservations(
      row.frames.map((f) => ({ atUs: f.atUs, observations: f.observations })),
      { maxGapUs: gates.tracking.maxGapUs },
    );
    assert.equal(row.tracks.length, gates.tracking.singleHostTracks);
    assert.deepEqual(
      row.tracks[0].samples.map((v) => v.status),
      Array(72).fill("observed"),
    );
    assert.equal(row.tracks[0].ambiguous, false);
    // Detection has a distinct retained recipe; it never changes the delivered raster.
    const plain = join(directory, "plain-0.png");
    await frame(source, plain, 0, { faceObservations: undefined });
    assert.equal(hash(await readFile(plain)), row.frames[0].pngSha256);
    assert.equal(hash(await readFile(input)), entry.derivative.sha256);
    row.stream = stream;
    await save(join(directory, "report.json"), row);
  }
  const host = report.cases[0],
    controlDir = join(out, "controls");
  await run(pictures, ["controls", join(out, host.id, "frame-00.png"), controlDir]);
  // Planted translation/multi-face zones are meaningful only for the frozen Graham source.
  if (host.id === "graham") {
    const base = gates.faces.graham,
      samples = [];
    for (const [id, expected] of [
      ...[0, 12, 24, -280].map((x) => [`shift-${x}`, [{ ...base, x: base.x + x }]]),
      [
        "multiple",
        [0, 320].map((x) => ({
          x: base.x / 2 + x,
          y: base.y / 2,
          width: base.width / 2,
          height: base.height / 2,
        })),
      ],
      ["occluded", []],
      ["orientation6", [base]],
    ]) {
      const input = join(controlDir, `${id}.png`),
        { source } = await imported(input, id),
        file = join(controlDir, `${id}-delivered.png`);
      const receipt = await frame(source, file),
        checked = checkFaces(receipt.faceObservations, expected);
      if (id === "orientation6") {
        const upright = await rgba(join(controlDir, "shift-0-delivered.png")),
          rotated = await rgba(file);
        assert.deepEqual(
          rotated.bytes,
          upright.bytes,
          "Metadata6 must produce identical upright pixels before judging Vision orientation",
        );
      }
      report.controls.push({ id, source, receipt, ...checked });
      await overlay(file, expected, checked.observations, join(controlDir, `${id}-overlay.png`));
      if (id.startsWith("shift-") && id !== "shift--280")
        samples.push({ atUs: samples.length * 100000, observations: checked.observations });
    }
    const blank = report.controls.find((v) => v.id === "occluded").observations;
    const moving = trackFaceObservations(samples);
    assert.equal(moving.length, 1);
    const hidden = trackFaceObservations([
      samples[0],
      { atUs: 200000, observations: blank },
      { ...samples[0], atUs: 400000 },
    ]);
    assert.deepEqual(
      hidden[0].samples.map((v) => v.status),
      ["observed", "gap", "observed"],
    );
    const expired = trackFaceObservations([
      samples[0],
      { atUs: 700000, observations: blank },
      { ...samples[0], atUs: 900000 },
    ]);
    assert.equal(expired.length, 2);
    const reset = trackFaceObservations([samples[0], { ...samples[1], reset: "scene_change" }]);
    assert.equal(reset.length, 2);
    report.controlTracks = { moving, hidden, expired, reset };
  }
  // Explicitly selected subject and preservation; use observations already retained above.
  for (const host of report.cases) {
    const directory = join(out, host.id),
      first = host.frames[0];
    const sourceImage = join(directory, "source-full.png");
    await frame(host.source, sourceImage, 0, { maxLongEdge: 1920, faceObservations: undefined });
    const ratio = host.stream.width / first.observations.width;
    const faces = first.observations.faces.map((f) => ({
      ...f,
      boundingBox: Object.fromEntries(
        Object.entries(f.boundingBox).map(([k, v]) => [k, v * ratio]),
      ),
    }));
    const canvas = { width: 640, height: 640 };
    const cases = [
      {
        id: "contain-reachable",
        preservation: "contain",
        target: {
          x: (faces[0].boundingBox.x + faces[0].boundingBox.width / 2) / host.stream.width,
          y: 0.5,
        },
        zoom: { min: 0.1, max: 2 },
      },
      {
        id: "contain-center",
        preservation: "contain",
        target: { x: 0.5, y: 0.5 },
        zoom: { min: 0.1, max: 2 },
      },
      {
        id: "contain-conflict",
        preservation: "contain",
        target: { x: 0.5, y: 0.1 },
        zoom: { min: 0.1, max: 2 },
      },
      {
        id: "crop-center",
        preservation: "crop",
        target: { x: 0.5, y: 0.5 },
        zoom: { min: 0.1, max: 2 },
      },
      {
        id: "crop-cap",
        preservation: "crop",
        target: { x: 0.5, y: 0.5 },
        zoom: { min: 0.1, max: 0.4 },
      },
    ];
    const created = await call("project.create", {
      requestId: `create-${host.id}`,
      canvas: { ...canvas, fps: { numerator: 24, denominator: 1 }, background: "#000000ff" },
    });
    const placed = await call("edit.apply", {
      projectId: created.project.projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: `place-${host.id}`,
      operations: [
        { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "host",
          clip: {
            ...host.source,
            trackId: { label: "video" },
            source: { kind: "range", range: { startUs: 0, endUs: 3_000_000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 3_000_000 } },
          },
        },
      ],
    });
    const project = {
      projectId: created.project.projectId,
      revisionId: placed.revision.revisionId,
    };
    const before = join(directory, "before.png");
    await frame(project, before, 0, { faceObservations: undefined });
    for (const c of cases.filter(
      (c) => !values["framing-case"] || c.id === values["framing-case"],
    )) {
      const operands = {
        source: { width: host.stream.width, height: host.stream.height },
        canvas,
        faces,
        subjectId: "face-0",
        target: c.target,
        margins: { x: 24 * ratio, y: 24 * ratio },
        zoom: c.zoom,
        preservation: c.preservation,
      };
      const plan = planSubjectFraming(operands);
      if (!plan.geometry) {
        assert.equal(plan.status, "unavailable");
        const beforeRefusal = join(directory, `${c.id}-before-refusal.png`),
          file = join(directory, `${c.id}.png`);
        await frame(project, beforeRefusal, 0, { faceObservations: undefined });
        const receipt = await frame(project, file, 0, { faceObservations: undefined });
        assert.equal(hash(await readFile(file)), hash(await readFile(beforeRefusal)));
        report.framing.push({
          host: host.id,
          id: c.id,
          observationPin: {
            cacheGeneration: first.receipt.cacheId,
            faceObservationSha256: hash(Buffer.from(JSON.stringify(first.observations))),
            inputSha256: host.inputSha256,
          },
          operands,
          plan,
          receipt,
          comparison: null,
          refusalPreservesPixels: true,
          pngSha256: hash(await readFile(file)),
        });
        continue;
      }
      const changed = await call("edit.apply", {
        projectId: project.projectId,
        expectedRevisionId: project.revisionId,
        requestId: `${host.id}-${c.id}`,
        operations: [
          {
            operation: "processing.set",
            target: { kind: "clip", id: placed.revision.document.clips[0].id },
            steps: [{ processor: plan.geometry }],
          },
        ],
      });
      project.revisionId = changed.revision.revisionId;
      const selection = { ...project },
        file = join(directory, `${c.id}.png`);
      const receipt = await frame(selection, file, 0, { faceObservations: undefined });
      const reference = join(directory, `${c.id}-reference.png`),
        refOperands = join(home, `ref-${ordinal++}.json`);
      await save(refOperands, { canvas, geometry: plan.geometry });
      await run(pictures, ["reference", sourceImage, reference, refOperands]);
      await run(pictures, [
        "reference-cg",
        sourceImage,
        join(directory, `${c.id}-cg-reference.png`),
        refOperands,
      ]);
      const actual = await rgba(file),
        expected = await rgba(reference);
      assert.deepEqual(actual.profile.width, expected.profile.width);
      let sum = 0,
        max = 0,
        count = 0,
        black = 0,
        perimeterSum = 0,
        perimeterMax = 0,
        perimeterCount = 0;
      const crop = plan.geometry.crop ?? {
        x: 0,
        y: 0,
        width: host.stream.width,
        height: host.stream.height,
      };
      const r = plan.geometry.rect ?? { x: 0, y: 0, width: 640, height: 640 };
      const scaleX = r.width / crop.width,
        scaleY = r.height / crop.height;
      const sx = plan.geometry.fit === "stretch" ? scaleX : Math.min(scaleX, scaleY);
      const sy = plan.geometry.fit === "stretch" ? scaleY : sx;
      const footprint = {
        x: r.x + (r.width - crop.width * sx) / 2,
        y: r.y + (r.height - crop.height * sy) / 2,
        width: crop.width * sx,
        height: crop.height * sy,
      };
      const b = faces[0].boundingBox,
        faceCenter = {
          x: footprint.x + (b.x + b.width / 2 - crop.x) * sx,
          y: footprint.y + (b.y + b.height / 2 - crop.y) * sy,
        };
      const targetError = Math.hypot(
        faceCenter.x - c.target.x * 640,
        faceCenter.y - c.target.y * 640,
      );
      if (plan.status === "ready" && !plan.issues.length)
        assert.ok(targetError <= gates.framing.maximumFaceTargetErrorPixels);
      for (let y = 0; y < 640; y++)
        for (let x = 0; x < 640; x++) {
          const i = (y * 640 + x) * 4;
          if (
            expected.bytes[i] === 0 &&
            expected.bytes[i + 1] === 0 &&
            expected.bytes[i + 2] === 0
          ) {
            black++;
            assert.ok(
              actual.bytes[i] === 0 && actual.bytes[i + 1] === 0 && actual.bytes[i + 2] === 0,
              "Black outside the explicit source footprint",
            );
          }
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(actual.bytes[i + k] - expected.bytes[i + k]);
            sum += d;
            max = Math.max(max, d);
            count++;
            if (
              c.preservation === "contain" &&
              x >= Math.ceil(footprint.x) &&
              x < Math.floor(footprint.x + footprint.width) &&
              y >= Math.ceil(footprint.y) &&
              y < Math.floor(footprint.y + footprint.height) &&
              (x < Math.ceil(footprint.x) + 4 ||
                x >= Math.floor(footprint.x + footprint.width) - 4 ||
                y < Math.ceil(footprint.y) + 4 ||
                y >= Math.floor(footprint.y + footprint.height) - 4)
            ) {
              perimeterSum += d;
              perimeterMax = Math.max(perimeterMax, d);
              perimeterCount++;
            }
          }
        }
      assert.ok(
        max <= gates.framing.maximumPerimeterChannelDifference &&
          sum / count <= gates.framing.meanPerimeterChannelDifference,
        "Every static delivered raster must match the frozen reference bound",
      );
      assert.notEqual(
        hash(await readFile(file)),
        hash(await readFile(before)),
        "Framing must change delivered pixels",
      );
      report.framing.push({
        host: host.id,
        id: c.id,
        observationPin: {
          cacheGeneration: first.receipt.cacheId,
          faceObservationSha256: hash(Buffer.from(JSON.stringify(first.observations))),
          inputSha256: host.inputSha256,
        },
        operands,
        plan,
        receipt,
        comparison: {
          passed:
            max <= gates.framing.maximumPerimeterChannelDifference &&
            sum / count <= gates.framing.meanPerimeterChannelDifference,
          meanChannelDifference: sum / count,
          maximumChannelDifference: max,
          blackPixels: black,
          footprint,
          faceCenter,
          targetErrorPixels: targetError,
          sourcePerimeter:
            c.preservation === "contain"
              ? {
                  scope:
                    "All source-perimeter raster sites inside the declared footprint (4px width); full-raster error also retained",
                  meanChannelDifference: perimeterSum / perimeterCount,
                  maximumChannelDifference: perimeterMax,
                  passed:
                    perimeterSum / perimeterCount <= gates.framing.meanPerimeterChannelDifference &&
                    perimeterMax <= gates.framing.maximumPerimeterChannelDifference,
                }
              : null,
        },
        pngSha256: hash(await readFile(file)),
        referenceSha256: hash(await readFile(reference)),
      });
      if (c.id === "crop-center" && host.id === "graham") {
        const clipId = placed.revision.document.clips[0].id;
        const split = await call("edit.apply", {
          projectId: project.projectId,
          expectedRevisionId: project.revisionId,
          requestId: "geometry-split",
          operations: [{ operation: "split", clipIds: [clipId], atUs: 1_500_000 }],
        });
        project.revisionId = split.revision.revisionId;
        for (const atUs of [0, 1_750_000]) {
          const beforeSplit = join(directory, `split-reference-${atUs}.png`),
            afterSplit = join(directory, `split-${atUs}.png`);
          await frame(selection, beforeSplit, atUs, { faceObservations: undefined });
          await frame(project, afterSplit, atUs, { faceObservations: undefined });
          assert.equal(hash(await readFile(afterSplit)), hash(await readFile(beforeSplit)));
        }
        const repeated = await call("edit.apply", {
          projectId: project.projectId,
          expectedRevisionId: project.revisionId,
          requestId: "geometry-repeat",
          operations: [{ operation: "duplicate", clipIds: [clipId], atUs: 3_000_000 }],
        });
        project.revisionId = repeated.revision.revisionId;
        const repeatFile = join(directory, "repeat.png"),
          repeatReference = join(directory, "split-reference-0.png");
        await frame(project, repeatFile, 3_000_000, { faceObservations: undefined });
        assert.equal(hash(await readFile(repeatFile)), hash(await readFile(repeatReference)));
        const repeatId = repeated.revision.document.clips.find(
          (v) => !split.revision.document.clips.some((old) => old.id === v.id),
        ).id;
        const retimed = await call("edit.apply", {
          projectId: project.projectId,
          expectedRevisionId: project.revisionId,
          requestId: "geometry-retime",
          operations: [
            { operation: "retime", clipIds: [repeatId], durationUs: 3_000_000, ripple: "none" },
          ],
        });
        project.revisionId = retimed.revision.revisionId;
        const slow = join(directory, "retime.png"),
          original = join(directory, "retime-reference.png");
        await frame(project, slow, 4_000_000, { faceObservations: undefined });
        await frame(selection, original, 500_000, { faceObservations: undefined });
        assert.equal(hash(await readFile(slow)), hash(await readFile(original)));
        report.temporalGeometry = {
          splitExact: true,
          repeatExact: true,
          retimeExact: true,
          observationsReused: true,
        };
      }
      console.log(
        `${host.id}/${c.id}: ${plan.status} ${plan.issues.map((issue) => issue.evidence.constraint ?? issue.code).join(",")} meanΔ=${(sum / count).toFixed(3)}`,
      );
    }
  }
  const indexed = report.cases.find((c) => c.id === "graham");
  if (indexed) {
    const created = await call("project.create", {
      requestId: "indexed-create",
      canvas: {
        width: 640,
        height: 360,
        fps: { numerator: 24, denominator: 1 },
        background: "#000000ff",
      },
    });
    const placed = await call("edit.apply", {
      projectId: created.project.projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: "indexed-place",
      operations: [
        { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          clip: {
            ...indexed.source,
            trackId: { label: "v" },
            source: { kind: "range", range: { startUs: 0, endUs: 3_000_000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 3_000_000 } },
          },
        },
      ],
    });
    report.indexes = [];
    for (const [kind, selection] of [
      ["source", indexed.source],
      [
        "project",
        {
          projectId: created.project.projectId,
          revisionId: placed.revision.revisionId,
          maxLongEdge: 640,
        },
      ],
    ]) {
      for (const faceObservations of [undefined, request]) {
        const params = {
          ...selection,
          ...(faceObservations ? { faceObservations } : {}),
          limit: 1,
        };
        console.log(
          `${kind} ${faceObservations ? "face" : "plain"} index: preparing retained evidence`,
        );
        const ready = await poll(
          () => call("index.get", params, { transport: "mcp" }),
          (v) => v.state === "ready",
          "retained face index",
        );
        const entry = ready.page.entries[0];
        if (faceObservations) assert.equal(entry.frame.faceObservations.status, "available");
        else assert.equal(entry.frame.faceObservations, undefined);
        const file = join(
          out,
          "graham",
          `${kind}-index-${faceObservations ? "face" : "plain"}.png`,
        );
        const delivered = await call("index.frame", entry.reference, { output: file });
        assert.deepEqual(delivered.published.output.faceObservations, entry.frame.faceObservations);
        if (ready.page.nextCursor)
          await call(
            "index.get",
            { ...params, cursor: ready.page.nextCursor },
            { transport: "mcp" },
          );
        report.indexes.push({
          kind,
          params,
          metadata: ready.page.metadata,
          entry,
          delivered,
          pngSha256: hash(await readFile(file)),
        });
      }
    }
  }
  const graham = report.cases.find((c) => c.id === "graham");
  if (graham && !values["skip-motion"]) {
    const directory = join(out, "graham"),
      canvas = { width: 640, height: 640 },
      ratio = 3,
      plans = [];
    let held = null;
    for (const f of graham.frames) {
      // A planted missing observation tests caller-authored hold; native rows remain intact.
      const operands = {
        source: { width: 1920, height: 1080 },
        canvas,
        faces:
          f.ordinal === 24
            ? []
            : f.observations.faces.map((face) => ({
                ...face,
                boundingBox: Object.fromEntries(
                  Object.entries(face.boundingBox).map(([k, v]) => [k, v * ratio]),
                ),
              })),
        subjectId: "face-0",
        target: { x: 0.5, y: 0.5 },
        margins: { x: 72, y: 72 },
        zoom: { min: 0.1, max: 2 },
        preservation: "crop",
      };
      const plan = planSubjectFraming(operands);
      if (plan.status === "ready" && !plan.issues.length) held = plan.geometry;
      assert.ok(held, "No geometry may be invented before the first accepted observation");
      plans.push({
        ordinal: f.ordinal,
        atUs: f.atUs,
        observationsSha256: hash(Buffer.from(JSON.stringify(f.observations))),
        plan,
        geometry: held,
        policy:
          plan.status === "ready" && !plan.issues.length
            ? "explicit proposal"
            : "caller-authored hold",
      });
    }
    assert.equal(plans[24].plan.reason, "subject_missing");
    assert.deepEqual(plans[24].geometry, plans[23].geometry);
    const clipFraction = (ordinal) => {
      const at = rational(BigInt(ordinal), 72n);
      return { numerator: Number(at.numerator), denominator: Number(at.denominator) };
    };
    const geometry = {
      type: "geometry",
      fit: "stretch",
      rect: { x: 0, y: 0, width: 640, height: 640 },
      crop: Object.fromEntries(
        ["x", "y", "width", "height"].map((key) => [
          key,
          {
            keys: plans.map((p) => ({
              at: clipFraction(p.ordinal),
              value: p.geometry.crop[key],
              interpolation: "hold",
            })),
          },
        ]),
      ),
    };
    const created = await call("project.create", {
      requestId: "moving-create",
      canvas: { ...canvas, fps: { numerator: 24, denominator: 1 }, background: "#000000ff" },
    });
    const placed = await call("edit.apply", {
      projectId: created.project.projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: "moving-place",
      operations: [
        { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "host",
          clip: {
            ...graham.source,
            trackId: { label: "v" },
            source: { kind: "range", range: { startUs: 0, endUs: 3_000_000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 3_000_000 } },
          },
        },
      ],
    });
    const authored = await call("edit.apply", {
      projectId: created.project.projectId,
      expectedRevisionId: placed.revision.revisionId,
      requestId: "moving-author",
      operations: [
        {
          operation: "processing.set",
          target: { kind: "clip", id: placed.revision.document.clips[0].id },
          steps: [{ processor: geometry }],
        },
      ],
    });
    const samples = [];
    for (const n of [0, 12, 24, 36, 51, 71]) {
      const p = plans[n],
        source = join(directory, `moving-source-${n}.png`),
        file = join(directory, `moving-${n}.png`),
        reference = join(directory, `moving-${n}-reference.png`),
        operands = join(home, `moving-${n}.json`);
      await frame(graham.source, source, p.atUs, {
        maxLongEdge: 1920,
        faceObservations: undefined,
      });
      await frame(
        { projectId: created.project.projectId, revisionId: authored.revision.revisionId },
        file,
        p.atUs,
        { faceObservations: undefined },
      );
      await save(operands, { canvas, geometry: p.geometry });
      await run(pictures, ["reference", source, reference, operands]);
      const actual = await rgba(file),
        expected = await rgba(reference);
      let sum = 0,
        max = 0;
      for (let i = 0; i < actual.bytes.length; i++) {
        const d = Math.abs(actual.bytes[i] - expected.bytes[i]);
        sum += d;
        max = Math.max(max, d);
      }
      assert.ok(
        sum / actual.bytes.length <= 1,
        "Moving geometry must match the independent linear-light reference",
      );
      samples.push({
        ordinal: n,
        atUs: p.atUs,
        pngSha256: hash(await readFile(file)),
        meanChannelDifference: sum / actual.bytes.length,
        maximumChannelDifference: max,
      });
    }
    report.movingGeometry = {
      scope:
        "Explicit per-observation ordinary hold curves, selected Graham source; planted missing observation at24 holds the previous accepted proposal. No smoothing or detector improvement claim.",
      geometry,
      plans,
      samples,
    };
  }
  report.localization = {
    passed: [...report.cases.flatMap((c) => c.frames), ...report.controls].every(
      (f) => f.localization.passed,
    ),
    failures: [
      ...report.cases.flatMap((c) =>
        c.frames.map((f) => ({ host: c.id, ordinal: f.ordinal, ...f.localization })),
      ),
      ...report.controls.map((f) => ({ control: f.id, ...f.localization })),
    ].filter((v) => !v.passed),
  };
  report.deliveryPassed = report.framing.every((c) =>
    c.comparison
      ? c.comparison.passed &&
        (!c.comparison.sourcePerimeter || c.comparison.sourcePerimeter.passed)
      : c.refusalPreservesPixels,
  );
  report.passed = report.localization.passed && report.deliveryPassed;
  if (!report.passed) process.exitCode = 1;
} finally {
  await service.stop();
  report.logs = service.logs;
  await save(join(out, "report.json"), report);
  await rm(home, { recursive: true, force: true });
}
