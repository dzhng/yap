import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { JourneyService, poll, run, root, hash } from "./source-evidence-fixture.mjs";
import { pointerFixture } from "./pointer-fixture.mjs";
import { sourceSurface, stackSurface, expectedRgba } from "./layers-oracle.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out);
const home = await mkdtemp(join(tmpdir(), "sr-pointer-geometry-"));
const report = {
  passed: false,
  trace: [],
  references: [],
  cases: [],
  scope: "Pointer alpha/support geometry and exact output rotation; no encoded color acceptance",
};
const service = new JourneyService(home, report, join(out, "native")),
  call = service.call.bind(service);
const pixelTool = join(home, "pixels");
const error = (a, b, alphaOnly = false) => {
  assert.equal(a.length, b.length);
  let maximum = 0;
  for (let i = alphaOnly ? 3 : 0; i < a.length; i += alphaOnly ? 4 : 1)
    maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
};
// Memoize only exact pixel centers. Values stay floating point, so this changes
// repeated reference work, never interpolation or quantization semantics.
function cached(surface) {
  const values = new Float64Array(surface.width * surface.height * 4),
    ready = new Uint8Array(surface.width * surface.height);
  return {
    ...surface,
    sample(x, y) {
      const ix = x - 0.5,
        iy = y - 0.5;
      if (
        !Number.isInteger(ix) ||
        !Number.isInteger(iy) ||
        ix < 0 ||
        iy < 0 ||
        ix >= surface.width ||
        iy >= surface.height
      )
        return surface.sample(x, y);
      const index = iy * surface.width + ix;
      if (!ready[index]) {
        values.set(surface.sample(x, y), index * 4);
        ready[index] = 1;
      }
      return values.subarray(index * 4, index * 4 + 4);
    },
  };
}
const geometry = (label, settings) => ({
  label,
  processor: { type: "geometry", ...settings },
});
async function picture(selection, atUs, target, point, name, canvas) {
  const file = join(out, name + ".png");
  const response = await poll(
    () =>
      call(
        "frame.get",
        {
          projectId: selection.projectId,
          revisionId: selection.revisionId,
          atUs,
          maxLongEdge: Math.max(canvas.width, canvas.height),
          tap: { target, point },
        },
        { output: file },
      ),
    (v) => v.state === "ready",
    name,
  );
  await run(pixelTool, [file, file + ".rgba"]);
  // evidence is what the report retains; rgba is the decoded frame the checks compare.
  return {
    evidence: { file, receipt: response, sha256: hash(await readFile(file)) },
    rgba: await readFile(file + ".rgba"),
  };
}
async function project(source, canvas, stages) {
  const initial = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      ...canvas,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const ref = (label) => ({ label });
  const edited = await call(
    "edit.apply",
    {
      projectId: initial.project.projectId,
      expectedRevisionId: initial.revision.revisionId,
      requestId: randomUUID(),
      operations: [
        {
          operation: "group.add",
          label: "outer",
          group: { kind: "video", order: 0 },
        },
        {
          operation: "group.add",
          label: "inner",
          group: { kind: "video", order: 0, parentId: ref("outer") },
        },
        {
          operation: "track.add",
          label: "track",
          track: { kind: "video", order: 0, parentId: ref("inner") },
        },
        {
          operation: "place",
          label: "clip",
          clip: {
            ...source,
            trackId: ref("track"),
            source: {
              kind: "range",
              range: { startUs: 800000, endUs: 1200000 },
            },
            placement: {
              kind: "project",
              range: { startUs: 0, endUs: 400000 },
            },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: ref("clip") },
          steps: [
            {
              label: "clear-footage",
              processor: { type: "opacity", opacity: 0 },
            },
            {
              label: "pointer",
              processor: { type: "pointer", trailUs: 600000 },
            },
            ...(stages?.clip ?? []),
          ],
        },
        ...Object.entries(stages ?? {})
          .filter(([scope]) => scope !== "clip")
          .map(([scope, steps]) => ({
            operation: "processing.set",
            target:
              scope === "output"
                ? { kind: "output" }
                : {
                    kind: ["inner", "outer"].includes(scope) ? "group" : scope,
                    id: ref(scope),
                  },
            steps,
          })),
      ],
    },
    { transport: "mcp" },
  );
  return {
    projectId: initial.project.projectId,
    revisionId: edited.revision.revisionId,
    labels: edited.edit.labels,
  };
}
try {
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
      "-o",
      pixelTool,
    ],
    { timeout: 120000 },
  );
  const { donor } = await pointerFixture(home);
  await service.start();
  const pending = await call("acquisition.import", {
    requestId: randomUUID(),
    path: donor,
  });
  const imported = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "pointer acquisition",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: imported.target.acquisitionId,
  });
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  const source = {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
  };
  const originalCanvas = { width: 256, height: 160 },
    reference = await project(source, originalCanvas);
  const references = [];
  for (let index = 0; index < 4; index++) {
    const result = await picture(
      reference,
      index * 100000,
      { kind: "clip", id: reference.labels.clip },
      { kind: "processed" },
      `source-alpha-${index}`,
      originalCanvas,
    );
    const alpha = Buffer.from(result.rgba);
    for (let i = 0; i < alpha.length; i++) if (i % 4 !== 3) alpha[i] = 0;
    assert.ok(alpha.some((v, i) => i % 4 === 3 && v > 128));
    assert.ok(alpha.some((v, i) => i % 4 === 3 && v === 0));
    references.push(alpha);
    report.references.push(result.evidence);
  }
  for (const canvas of [
    { width: 256, height: 160 },
    { width: 320, height: 240 },
  ])
    for (const fit of ["contain", "cover", "stretch"]) {
      const name = `${canvas.width}x${canvas.height}-${fit}`;
      const stages = {
        clip: [
          geometry("fit", {
            crop: { x: 32, y: 24, width: 192, height: 112 },
            rect: { x: 24, y: 16, width: 192, height: 128 },
            fit,
          }),
          geometry("second", {
            rect: {
              x: 8,
              y: 8,
              width: canvas.width - 16,
              height: canvas.height - 16,
            },
            fit: "stretch",
          }),
        ],
        track: [geometry("track-turn", { rotationDeg: 180 })],
        inner: [
          geometry("inner-size", {
            rect: {
              x: 8,
              y: 8,
              width: canvas.width - 16,
              height: canvas.height - 16,
            },
            fit: "stretch",
          }),
        ],
        outer: [geometry("outer-turn", { rotationDeg: 180 })],
        output: [geometry("output-turn", { rotationDeg: 180 })],
      };
      const selected = await project(source, canvas, stages),
        row = { name, canvas, stages, selected, pictures: [], output: [] };
      report.cases.push(row);
      for (let index = 0; index < 4; index++) {
        let surface = sourceSurface({
          width: 256,
          height: 160,
          rgba: references[index],
          encodedProfile: "srgb",
        });
        const sequence = [
          {
            name: "clip-fit",
            target: { kind: "clip", id: selected.labels.clip },
            point: { kind: "after-step", stepId: selected.labels.fit },
            steps: [stages.clip[0]],
          },
          {
            name: "clip-second",
            target: { kind: "clip", id: selected.labels.clip },
            point: { kind: "processed" },
            steps: [stages.clip[1]],
          },
          ...["track", "inner", "outer"].map((scope) => ({
            name: scope,
            target: {
              kind: scope === "track" ? "track" : "group",
              id: selected.labels[scope],
            },
            point: { kind: "processed" },
            steps: stages[scope],
          })),
        ];
        for (const [stageIndex, stage] of sequence.entries()) {
          surface = cached(stackSurface(surface, stage.steps, canvas, stageIndex === 0));
          if (index !== 0 && stage.name !== "outer") continue;
          const expected = expectedRgba(surface),
            result = await picture(
              selected,
              index * 100000,
              stage.target,
              stage.point,
              `${name}-${index}-${stage.name}`,
              canvas,
            );
          const maximumAlphaError = error(result.rgba, expected, true);
          await writeFile(result.evidence.file + ".expected-alpha.rgba", expected);
          assert.ok(
            maximumAlphaError <= 2,
            `${name}/${index}/${stage.name}: alpha error ${maximumAlphaError}`,
          );
          const shifted = Buffer.alloc(expected.length);
          for (let y = 0; y < canvas.height; y++)
            expected.copy(
              shifted,
              (y * canvas.width + 1) * 4,
              y * canvas.width * 4,
              ((y + 1) * canvas.width - 1) * 4,
            );
          assert.ok(error(shifted, result.rgba, true) > 2, "One-pixel shift escaped alpha gate");
          assert.ok(
            error(Buffer.alloc(expected.length), result.rgba, true) > 2,
            "Missing pointer escaped alpha gate",
          );
          row.pictures.push({
            index,
            stage: stage.name,
            ...result.evidence,
            maximumAlphaError,
            onePixelShiftRejected: true,
            missingPointerRejected: true,
          });
        }
        const dry = await picture(
          selected,
          index * 100000,
          { kind: "output" },
          { kind: "dry" },
          `${name}-${index}-output-dry`,
          canvas,
        );
        const rendered = await picture(
          selected,
          index * 100000,
          { kind: "output" },
          { kind: "processed" },
          `${name}-${index}-output-turn`,
          canvas,
        );
        const rotated = Buffer.alloc(dry.rgba.length);
        for (let pixel = 0; pixel < canvas.width * canvas.height; pixel++)
          dry.rgba.copy(
            rotated,
            (canvas.width * canvas.height - 1 - pixel) * 4,
            pixel * 4,
            pixel * 4 + 4,
          );
        const maximumRotationError = error(rendered.rgba, rotated);
        assert.ok(
          maximumRotationError <= 2,
          `${name}/${index}: output rotation error ${maximumRotationError}`,
        );
        assert.ok(
          error(dry.rgba, rendered.rgba) > 2,
          "Output rotation did not move asymmetric pointer",
        );
        row.output.push({
          index,
          dry: dry.evidence,
          rendered: rendered.evidence,
          maximumRotationError,
          omittedRotationRejected: true,
        });
      }
    }
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
      await writeFile(join(out, "service.log"), service.logs.join(""));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
