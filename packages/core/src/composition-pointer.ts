import { setImmediate } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  isMediaClip,
  compare,
  fromTime,
  toTime,
  floor,
  subtract,
  type createCompiler,
  type ProcessingInstruction,
  type CompiledFrame,
  type ValidatedComposition,
} from "@yap/composition";
import type { SourceEvidenceReader } from "./evidence-read.js";
import { sourceSelectionKey, type SourceSelection } from "./source-selection.js";
import type { PointerPreparation } from "./pointer-preparation.js";
import { PresentationPointerHistory } from "./presentation-pointer-history.js";
import { CatalogError } from "./catalog.js";

/** Provisional attempt admission, independent of source duration or output pixel allocation. */
export const pointerPreparationLimits = Object.freeze({
  maxSources: 256,
  rowBytes: 256 * 1024,
});
export type PreparedPointers = { file: string; bytes: number; records: number; sha256: string };
/** Admit source history only if an enabled pointer can contribute to an actual sampled frame. */
export function compositionPointerSources(input: {
  model: ValidatedComposition;
  compiler: Pick<ReturnType<typeof createCompiler>, "frameBoundary" | "frameTime">;
  processing: readonly ProcessingInstruction[];
  range: { startUs: number; endUs: number };
}): SourceSelection[] {
  const selected = new Set<string>();
  for (const node of input.processing) {
    if (node.target.kind !== "clip") continue;
    for (const step of node.steps) {
      if (step.enabled && step.processor.type === "pointer") {
        selected.add(node.target.id);
        break;
      }
    }
  }
  if (!selected.size || input.range.startUs === input.range.endUs) return [];
  const boundary = input.compiler.frameBoundary(input.range.startUs);
  const first =
    boundary.after?.sampleAtUs === input.range.startUs ? boundary.after : boundary.before;
  if (!first) return [];
  const start = fromTime(input.compiler.frameTime(first.index)),
    end = fromTime(input.range.endUs);
  const sources = new Map<string, SourceSelection>();
  for (const resolved of input.model.clips) {
    const clip = resolved.clip;
    if (!selected.has(clip.id) || !isMediaClip(clip) || resolved.stream?.kind !== "video") continue;
    if (!clip.acquisitionId)
      throw new CatalogError("INVALID_EVIDENCE", "Pointer clip lacks capture authority");
    let lo = 0,
      hi = resolved.available.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (compare(resolved.available[mid]!.end, start) <= 0) lo = mid + 1;
      else hi = mid;
    }
    for (let index = lo; index < resolved.available.length; index++) {
      const span = resolved.available[index]!;
      if (compare(span.start, end) >= 0) break;
      const lower = compare(span.start, start) > 0 ? span.start : start;
      const sample = input.compiler.frameBoundary(toTime(lower)).after;
      if (
        !sample ||
        sample.sampleAtUs >= input.range.endUs ||
        compare(fromTime(input.compiler.frameTime(sample.index)), span.end) >= 0
      )
        continue;
      const selection = {
        assetId: clip.assetId,
        streamId: clip.streamId,
        acquisitionId: clip.acquisitionId,
      };
      sources.set(sourceSelectionKey(selection), selection);
      if (sources.size > pointerPreparationLimits.maxSources)
        throw new CatalogError("LIMIT_EXCEEDED", "Pointer admission exceeds source lease budget", {
          limitKind: "maxSources",
          maximum: pointerPreparationLimits.maxSources,
          observed: sources.size,
        });
      break;
    }
  }
  return [...sources.values()];
}

type Held = Parameters<Parameters<PointerPreparation["withHistory"]>[2]>[0];

/** Writes one bounded row per enabled pointer operation in raw compiler order.
 * All source/cache leases enclose the stream; no overlays cross inline IPC. */
export async function prepareCompositionPointers(
  input: {
    model: ValidatedComposition;
    frames: () => Iterable<CompiledFrame>;
    output: string;
    preparation: PointerPreparation;
    evidence: SourceEvidenceReader;
  },
  signal: AbortSignal,
): Promise<PreparedPointers> {
  if (!isAbsolute(input.output))
    throw new CatalogError(
      "INVALID_OUTPUT",
      "Pointer preparation requires an absolute attempt path",
    );
  const clips = new Map(input.model.clips.map(({ clip }) => [clip.id, clip]));
  const selections = new Map<string, SourceSelection>();
  // Compiler windows are replayable; this scan discovers only participating sources.
  const operations = async function* (frames: Iterable<CompiledFrame>) {
    let frameCount = 0,
      operationCount = 0;
    for (const frame of frames) {
      signal.throwIfAborted();
      if (frameCount++ % 128 === 0) await setImmediate(undefined, { signal });
      for (const node of frame.visual)
        for (const op of node.operations) {
          signal.throwIfAborted();
          if (operationCount++ % 256 === 0) await setImmediate(undefined, { signal });
          if (op.kind === "pointer") yield { frame, node, op };
        }
    }
  };
  let rows = 0;
  for await (const { frame, node } of operations(input.frames())) {
    signal.throwIfAborted();
    ++rows;
    if (node.target.kind !== "clip")
      throw new CatalogError("INVALID_EVIDENCE", "Pointer operation lacks clip source context");
    const clip = clips.get(node.target.id)!;
    if (!clip || !isMediaClip(clip) || !clip.acquisitionId)
      throw new CatalogError("INVALID_EVIDENCE", "Pointer clip lacks capture authority");
    const layer = frame.layers.find((layer) => layer.clipId === clip.id);
    if (!layer || layer.availability !== "available") continue;
    const selection = {
      assetId: clip.assetId,
      streamId: clip.streamId,
      acquisitionId: clip.acquisitionId,
    };
    selections.set(JSON.stringify(selection), selection);
    if (selections.size > pointerPreparationLimits.maxSources)
      throw new CatalogError("LIMIT_EXCEEDED", "Pointer preparation exceeds source lease budget");
  }
  const contexts = new Map<string, Held>();
  const entries = [...selections.entries()];
  const use = async (index: number): Promise<PreparedPointers> => {
    if (index < entries.length) {
      const [key, selection] = entries[index]!;
      return input.preparation.withHistory(selection, signal, async (held) => {
        contexts.set(key, held);
        try {
          return await use(index + 1);
        } finally {
          contexts.delete(key);
        }
      });
    }
    return write();
  };
  const write = async () => {
    signal.throwIfAborted();
    const staging = join(dirname(input.output), `.pointers-${randomUUID()}`);
    const file = await open(staging, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0,
      records = 0;
    const samplers = new Map<string, PresentationPointerHistory>();
    try {
      for await (const { frame, node, op } of operations(input.frames())) {
        signal.throwIfAborted();
        ++records;
        if (node.target.kind !== "clip")
          throw new CatalogError("INVALID_EVIDENCE", "Pointer operation lacks clip context");
        const clip = clips.get(node.target.id)!;
        if (!isMediaClip(clip) || !clip.acquisitionId)
          throw new CatalogError("INVALID_EVIDENCE", "Pointer clip lacks capture authority");
        const layer = frame.layers.find((layer) => layer.clipId === clip.id);
        const base = {
          frameIndex: frame.index,
          sampleAtUs: frame.sampleAtUs,
          clipId: clip.id,
          stepId: op.stepId,
          trailUs: op.trailUs,
        };
        let row: unknown = { ...base, status: "inactive" };
        if (layer) {
          if (layer.kind !== "video")
            throw new CatalogError("INVALID_EVIDENCE", "Pointer requires a timed video layer");
          const identity = {
            assetId: clip.assetId,
            streamId: clip.streamId,
            requestedSourceUs: layer.sourceUs,
          };
          if (layer.assetId !== clip.assetId || layer.streamId !== clip.streamId)
            throw new CatalogError("INVALID_EVIDENCE", "Compiled pointer layer changed its source");
          if (layer.availability !== "available")
            row = {
              ...base,
              ...identity,
              status: "excluded",
              availability: layer.availability,
            };
          else {
            const key = JSON.stringify({
              assetId: clip.assetId,
              streamId: clip.streamId,
              acquisitionId: clip.acquisitionId,
            });
            const held = contexts.get(key)!;
            let sampler = samplers.get(key);
            if (!sampler) {
              sampler = new PresentationPointerHistory(
                {
                  presentation: held.presentation,
                  evidence: input.evidence,
                  identity: held.plan.history.evidence,
                },
                signal,
              );
              samplers.set(key, sampler);
            }
            const capture = subtract(
              fromTime(layer.sourceUs),
              fromTime(held.plan.sourceToAssetOffsetUs),
            );
            const captureUs = floor(capture);
            const sampled = await sampler.sample(0, toTime(capture), op.trailUs);
            const context = {
              ...base,
              ...identity,
              captureUs,
              clockOffsetUs: held.plan.history.clockOffsetUs,
              sourceToAssetOffsetUs: held.plan.sourceToAssetOffsetUs,
              width: held.presentation.receipt.sourceWidth,
              height: held.presentation.receipt.sourceHeight,
              start: sampled.record.start,
              end: sampled.record.end,
            };
            row =
              sampled.inspection.kind === "empty"
                ? { ...context, status: "empty" }
                : {
                    ...context,
                    status: "picture",
                    sampleTime: sampled.inspection.record.sampleTime,
                    overlay: sampled.inspection.plan.overlay,
                  };
          }
        }
        const data = Buffer.from(JSON.stringify(row) + "\n");
        if (data.length > pointerPreparationLimits.rowBytes)
          throw new CatalogError("LIMIT_EXCEEDED", "Pointer preparation exceeds byte budget");
        await file.writeFile(data);
        hash.update(data);
        bytes += data.length;
      }
      if (records !== rows)
        throw new CatalogError(
          "INVALID_EVIDENCE",
          "Compiled pointer occurrences changed during preparation",
        );
      await file.sync();
      signal.throwIfAborted();
      await link(staging, input.output);
      return { file: input.output, bytes, records, sha256: hash.digest("hex") };
    } finally {
      for (const sampler of samplers.values()) await sampler.close();
      try {
        await file.close();
      } finally {
        await rm(staging, { force: true });
      }
    }
  };
  return use(0);
}
