import { applyBatch, createCompiler, validateComposition } from "@yap/composition";
import { encodeJsonLine, REQUEST_FRAME_BYTES } from "@yap/protocol";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { executeComposition } from "./composition-worker.js";
import { audioDeadline, projectAudioRenderer } from "./project-render.js";
import { PROCESS_START_ALLOWANCE_MS, renderWindowDeadlineMs, type MediaWorker } from "./worker.js";

test("a large compiled audio plan reaches execution without enlarging control frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compiled-render-"));
  try {
    const asset = {
      id: "a".repeat(64),
      streams: [
        {
          id: "0",
          kind: "audio" as const,
          channels: 2,
          sampleRate: 48000,
          bounds: { startUs: 0, endUs: 1000000 },
          available: [{ startUs: 0, endUs: 1000000 }],
        },
      ],
    };
    const model = validateComposition(
      {
        canvas: {
          width: 16,
          height: 16,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
        tracks: [{ id: "audio", kind: "audio", order: 0 }],
        groups: [],
        syncGroups: [],
        clips: Array.from({ length: 1000 }, (_, i) => ({
          id: `clip:${"b".repeat(64)}:${i}`,
          trackId: "audio",
          assetId: asset.id,
          streamId: "0",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: {
            kind: "project",
            range: { startUs: i * 2000000, endUs: i * 2000000 + 1500000 },
          },
        })),
        processing: [
          {
            target: { kind: "output" },
            steps: [{ id: "noise", enabled: true, processor: { type: "rnnoise" } }],
          },
        ],
      },
      [asset],
    );
    const compiled = createCompiler(model, "revision").audioWindow({
      range: { startUs: 0, endUs: 1999500000 },
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const window = {
      ...compiled,
      manifest: {
        ...compiled.manifest,
        requirements: compiled.manifest.requirements.map((item) => ({
          ...item,
          implementationId: item.kind === "retime" ? "retime-fixture" : item.implementationId,
        })),
      },
    };
    let admittedPlan: unknown;
    const worker: MediaWorker = async (operation, params) => {
      encodeJsonLine({ id: `worker-${operation}`, operation, params }, REQUEST_FRAME_BYTES);
      if (operation === "storage.clearRenderWorkspace")
        return { ok: true, data: { removed: true } };
      const plan =
        typeof params.planFile === "string"
          ? JSON.parse(await readFile(params.planFile, "utf8"))
          : params;
      if (operation === "media.validateCompositionAudio") {
        admittedPlan = plan;
        return { ok: true, data: { retime: "retime-fixture" } };
      }
      await writeFile(
        plan.output,
        JSON.stringify({
          clips: plan.clips,
          range: plan.range,
          state: plan.state,
          retimeImplementationId: plan.retimeImplementationId,
        }),
      );
      return { ok: true, data: { file: plan.output } };
    };
    const output = join(directory, "delivered.json");
    const renderer = projectAudioRenderer(worker, join(directory, "render"), {
      rnnoise: "rnnoise-fixture",
      retime: "retime-fixture",
    });
    const request = {
      window,
      assets: [
        { assetId: asset.id, streamId: "0", path: join(directory, "source.wav"), originUs: 0 },
      ],
      output,
    };
    await renderer.validateAudio!(request);
    expect(admittedPlan).toMatchObject({
      retimeImplementationId: "retime-fixture",
      clips: [...window.audio()],
    });
    await renderer.render(request, new AbortController().signal);
    const delivered = JSON.parse(await readFile(output, "utf8"));
    expect(delivered.retimeImplementationId).toBe("retime-fixture");
    expect(delivered.clips).toEqual([...window.audio()]);
    expect(delivered.range).toEqual(window.manifest.sampleRange);
    expect(delivered.state).toEqual({
      ...window.audioState(),
      implementationId: "rnnoise-fixture",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late stateful queries budget full distinct retimed contexts and retained reads skip preparation", () => {
  const asset = {
    id: "source",
    streams: [
      {
        id: "audio",
        kind: "audio" as const,
        channels: 2,
        sampleRate: 48000,
        bounds: { startUs: 0, endUs: 100000000 },
        available: [{ startUs: 0, endUs: 100000000 }],
      },
    ],
  };
  const model = validateComposition(
    {
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
      tracks: [{ id: "audio", kind: "audio", order: 0 }],
      groups: [],
      syncGroups: [],
      clips: [0, 1].map((i) => ({
        id: `clip:${i}`,
        trackId: "audio",
        assetId: asset.id,
        streamId: "audio",
        source: { kind: "range", range: { startUs: 0, endUs: 100000000 } },
        placement: {
          kind: "project",
          range: { startUs: i * 200000000, endUs: (i + 1) * 200000000 },
        },
      })),
      processing: [
        {
          target: { kind: "output" },
          steps: [{ id: "noise", enabled: true, processor: { type: "rnnoise" } }],
        },
      ],
    },
    [asset],
  );
  const window = createCompiler(model, "revision").audioWindow({
    range: { startUs: 399900000, endUs: 400000000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  // 400 seconds state + two (100 second input + 200 second output) contexts + query.
  expect(audioDeadline(window)).toBe(renderWindowDeadlineMs({ startUs: 0, endUs: 1000100000 }));
  expect(audioDeadline(window, true)).toBe(renderWindowDeadlineMs({ startUs: 0, endUs: 100000 }));
});

test("deadline distinguishes exact rates sharing sample contexts while pure splits share preparation", () => {
  const asset = {
    id: "source",
    streams: [
      {
        id: "audio",
        kind: "audio" as const,
        channels: 2,
        sampleRate: 48000,
        bounds: { startUs: 0, endUs: 100000000 },
        available: [{ startUs: 0, endUs: 100000000 }],
      },
    ],
  };
  const document = {
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
    tracks: [{ id: "audio", kind: "audio", order: 0 }],
    groups: [],
    syncGroups: [],
    processing: [],
    clips: [
      {
        id: "voice",
        trackId: "audio",
        assetId: asset.id,
        streamId: "audio",
        source: { kind: "range", range: { startUs: 0, endUs: 100000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 200000000 } },
      },
    ],
  };
  const request = {
    range: { startUs: 0, endUs: 200000000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  };
  const base = createCompiler(validateComposition(document, [asset]), "base").audioWindow(request);
  const split = applyBatch(
    document,
    [{ operation: "split", clipIds: ["voice"], atUs: 123456789, scope: "selected" }],
    { assets: [asset], namespace: "split" },
  );
  const splitWindow = createCompiler(
    validateComposition(split.document, [asset]),
    "split",
  ).audioWindow(request);
  expect(audioDeadline(splitWindow)).toBe(audioDeadline(base));
  const collision = {
    ...document,
    tracks: [...document.tracks, { id: "second", kind: "audio", order: 1 }],
    clips: [
      ...document.clips,
      {
        ...document.clips[0],
        id: "other",
        trackId: "second",
        placement: {
          kind: "project",
          range: { startUs: 0, endUs: { numerator: 400000001, denominator: 2 } },
        },
      },
    ],
  };
  const window = createCompiler(validateComposition(collision, [asset]), "collision").audioWindow(
    request,
  );
  expect([...window.audio()].map((clip) => clip.context)).toEqual([
    [...base.audio()][0]!.context,
    [...base.audio()][0]!.context,
  ]);
  expect(audioDeadline(window)).toBe(renderWindowDeadlineMs({ startUs: 0, endUs: 800000000 }));
});

test("fractional frame-duration preparation receives a conservative bounded deadline", () => {
  const duration = { numerator: 15404875, denominator: 3 };
  const model = validateComposition(
    {
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
      tracks: [{ id: "audio", kind: "audio", order: 0 }],
      groups: [],
      syncGroups: [],
      clips: [
        {
          id: "voice",
          trackId: "audio",
          assetId: "source",
          streamId: "audio",
          source: { kind: "range", range: { startUs: 0, endUs: duration } },
          placement: { kind: "project", range: { startUs: 0, endUs: 6000000 } },
          pitch: "preserve",
        },
      ],
      processing: [
        {
          target: { kind: "output" },
          steps: [{ id: "noise", enabled: true, processor: { type: "rnnoise" } }],
        },
      ],
    },
    [
      {
        id: "source",
        streams: [
          {
            id: "audio",
            kind: "audio",
            sampleRate: 48000,
            channels: 1,
            bounds: { startUs: 0, endUs: duration },
            available: [{ startUs: 0, endUs: duration }],
          },
        ],
      },
    ],
  );
  const window = createCompiler(model, "fractional").audioWindow({
    range: { startUs: 0, endUs: 6000000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  // Query + state + retime output each cost six seconds; input is 246478 / 48000 seconds.
  expect(audioDeadline(window)).toBe(
    PROCESS_START_ALLOWANCE_MS + 2 * Math.ceil(18000 + 246478 / 48),
  );
  expect(audioDeadline(window, true)).toBe(PROCESS_START_ALLOWANCE_MS + 12000);
});

test("successive bulk domain requests retire their control files in the same attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bulk-domain-plan-"));
  try {
    const worker: MediaWorker = async (operation, params) => {
      encodeJsonLine({ id: "bulk", operation, params }, REQUEST_FRAME_BYTES);
      const plan =
        typeof params.planFile === "string"
          ? JSON.parse(await readFile(params.planFile, "utf8"))
          : params;
      return {
        ok: true,
        data: { input: plan.input, domainIndex: plan.domainIndex, operand: plan.operand },
      };
    };
    const operand = "x".repeat(REQUEST_FRAME_BYTES + 1);
    for (const [domainIndex, input] of [
      [0, "program"],
      [1, "detector"],
    ] as const) {
      const result = await executeComposition(
        worker,
        "media.prepareCompositionAudioDomain",
        { output: join(directory, "prefix.wav"), domainIndex, input, operand },
        { signal: new AbortController().signal },
      );
      expect(result).toEqual({ ok: true, data: { input, domainIndex, operand } });
      expect(await readdir(directory)).toEqual([]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dynamic normalization budgets its bounded original-input scans while retained audio skips them", () => {
  const asset = {
    id: "source",
    streams: [
      {
        id: "audio",
        kind: "audio" as const,
        channels: 2,
        sampleRate: 48000,
        bounds: { startUs: 0, endUs: 100000000 },
        available: [{ startUs: 0, endUs: 100000000 }],
      },
    ],
  };
  const document = {
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
    tracks: [{ id: "audio", kind: "audio" as const, order: 0 }],
    groups: [],
    syncGroups: [],
    clips: [
      {
        id: "clip",
        trackId: "audio",
        assetId: asset.id,
        streamId: "audio",
        source: { kind: "range" as const, range: { startUs: 0, endUs: 100000000 } },
        placement: { kind: "project" as const, range: { startUs: 0, endUs: 100000000 } },
      },
    ],
    processing: [
      {
        target: { kind: "output" as const },
        steps: [
          {
            id: "normalize",
            enabled: true,
            processor: {
              type: "normalization" as const,
              mode: "dynamic" as const,
              targetIntegratedLufs: -14.5,
              truePeakCeilingDbtp: 0,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
      },
    ],
  };
  const window = createCompiler(validateComposition(document, [asset]), "revision").audioWindow({
    range: { startUs: 99900000, endUs: 100000000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  // Before scanner + loudnorm statistics + three renders and three after scanners = eight traversals.
  expect(audioDeadline(window)).toBe(renderWindowDeadlineMs(window.manifest.range) + 800000);
  expect(audioDeadline(window, true)).toBe(renderWindowDeadlineMs(window.manifest.range));
});
