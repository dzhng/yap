import type { StatePlan } from "./processing-state.js";
import { sampleAt } from "./sample-clock.js";
import type { SampleScalarProgram } from "./scalar-program.js";
import { compileScalarCurve, type CompiledScalarCurve } from "./curve.js";
import { compare, fromTime, toTime, type Rational } from "./rational.js";
import { processingScalars } from "./processing.js";
import type { Geometry } from "./geometry.js";
import type { ValidatedComposition, ExactRange } from "./model.js";
import type { ProcessingInstruction } from "./processing-plan.js";
import {
  isStatefulProcessor,
  processorRegistry,
  type StatefulProcessor,
  type Anchor,
  type ProcessingStep,
  type ProcessingTarget,
  type ScalarCurve,
  type TimeValue,
} from "./schema.js";

export type CompiledProcessingInstruction = Omit<ProcessingInstruction, "steps"> & {
  steps: readonly {
    id: string;
    enabled: boolean;
    processor:
      | Exclude<ProcessingStep["processor"], StatefulProcessor | { type: "gain" }>
      | (Exclude<StatefulProcessor, { type: "rnnoise" }> & {
          active: readonly { start: number; end: number }[];
        })
      | {
          type: "rnnoise";
          mix?: number | SampleScalarProgram;
          active: readonly { start: number; end: number }[];
        }
      | {
          type: "gain";
          gain: number | SampleScalarProgram;
          active?: readonly { start: number; end: number }[];
        };
  }[];
};

/** Share anchored scalar clocks between picture sampling and audio-program lowering. */
export function temporalProcessing(model: ValidatedComposition) {
  const clips = new Map(model.clips.map((value) => [value.clip.id, value]));
  const programs = new Map<string, Map<string, CompiledScalarCurve | null>>();
  const clocks = new Map<string, { range: ExactRange; anchor: Anchor; empty: boolean }>();
  function clock(step: ProcessingStep, target: ProcessingTarget) {
    const cached = clocks.get(step.id);
    if (cached) return cached;
    const clip = target.kind === "clip" ? clips.get(target.id)! : undefined;
    const range = clip?.range ?? { start: fromTime(0), end: fromTime(model.durationUs) };
    let anchor: Anchor =
      step.window ??
      (target.kind === "clip"
        ? {
            kind: "clip",
            clipId: target.id,
            start: { numerator: 0, denominator: 1 },
            end: { numerator: 1, denominator: 1 },
          }
        : { kind: "project", range: { startUs: 0, endUs: model.durationUs } });
    let empty = compare(range.start, range.end) >= 0;
    if (anchor.kind === "content" && clip?.clip.source.kind === "range") {
      const source = clip.clip.source.range;
      const startUs =
        compare(fromTime(anchor.sourceRange.startUs), fromTime(source.startUs)) > 0
          ? anchor.sourceRange.startUs
          : source.startUs;
      const endUs =
        compare(fromTime(anchor.sourceRange.endUs), fromTime(source.endUs)) < 0
          ? anchor.sourceRange.endUs
          : source.endUs;
      empty ||= compare(fromTime(startUs), fromTime(endUs)) >= 0;
      if (!empty) anchor = { ...anchor, sourceRange: { startUs, endUs } };
    }
    const result = { range, anchor, empty };
    clocks.set(step.id, result);
    return result;
  }
  function program(
    step: ProcessingStep,
    target: ProcessingTarget,
    slot: string,
    value: number | ScalarCurve,
  ) {
    let slots = programs.get(step.id);
    if (!slots) {
      slots = new Map();
      programs.set(step.id, slots);
    }
    if (slots.has(slot)) return slots.get(slot)!;
    const { range, anchor, empty } = clock(step, target);
    const curve =
      typeof value === "number"
        ? {
            keys: [
              {
                at: anchor.kind === "clip" ? { numerator: 0, denominator: 1 } : 0,
                value,
                interpolation: "hold" as const,
              },
            ],
          }
        : value;
    const compiled = empty
      ? null
      : compileScalarCurve(model, curve, anchor, step.evaluationRange).restrict({
          startUs: toTime(range.start),
          endUs: toTime(range.end),
        });
    slots.set(slot, compiled);
    return compiled;
  }
  function scalar(
    step: ProcessingStep,
    target: ProcessingTarget,
    slot: string,
    value: number | ScalarCurve,
    at: TimeValue,
  ) {
    return typeof value === "number" && !step.window
      ? value
      : (program(step, target, slot, value)?.sample(at) ?? null);
  }
  return {
    active(step: ProcessingStep, target: ProcessingTarget): readonly ExactRange[] {
      if (!step.enabled) return [];
      if (!step.window && !step.evaluationRange) {
        const { range, empty } = clock(step, target);
        return empty ? [] : [range];
      }
      return program(step, target, "window", 1)?.active ?? [];
    },
    audio(
      plan: readonly ProcessingInstruction[],
      sampleRate: number,
      state?: StatePlan,
    ): CompiledProcessingInstruction[] {
      const stateActive = new Map<string, { start: number; end: number }[]>();
      for (const domain of state?.domains ?? [])
        for (const member of domain.members) {
          const start = sampleAt(fromTime(member.range.startUs), sampleRate),
            end = sampleAt(fromTime(member.range.endUs), sampleRate);
          if (start === end) continue;
          const ranges = stateActive.get(member.stepId) ?? [];
          ranges.push({ start, end });
          stateActive.set(member.stepId, ranges);
        }
      // The output stack carries picture processors too; the audio program runs only audio ones.
      return plan.map(({ steps, ...node }) => ({
        ...node,
        steps: steps
          .filter((step) => processorRegistry[step.processor.type].mediaKind === "audio")
          .map((step) => {
            const { id, enabled, processor } = step;
            if (processor.type === "rnnoise")
              return {
                id,
                enabled,
                processor: {
                  type: "rnnoise" as const,
                  active: stateActive.get(id) ?? [],
                  ...(processor.mix === undefined
                    ? {}
                    : {
                        mix:
                          typeof processor.mix === "number"
                            ? processor.mix
                            : (program(step, node.target, "mix", processor.mix)?.samples(
                                sampleRate,
                              ) ?? 0),
                      }),
                },
              };
            if (isStatefulProcessor(processor))
              return {
                id,
                enabled,
                processor: { ...processor, active: stateActive.get(id) ?? [] },
              };
            if (processor.type !== "gain") return { id, enabled, processor };
            if (typeof processor.gain === "number" && !step.window)
              return { id, enabled, processor: { type: "gain" as const, gain: processor.gain } };
            const compiled = program(step, node.target, "gain", processor.gain);
            const active = (compiled?.available ?? [])
              .map(({ start, end }) => ({
                start: sampleAt(start, sampleRate),
                end: sampleAt(end, sampleRate),
              }))
              .filter(({ start, end }) => start < end);
            return {
              id,
              enabled,
              processor: {
                type: "gain" as const,
                gain:
                  typeof processor.gain === "number"
                    ? processor.gain
                    : (compiled?.samples(sampleRate) ?? 1),
                active,
              },
            };
          }),
      }));
    },
    opacity(step: ProcessingStep, target: ProcessingTarget, at: TimeValue) {
      return step.processor.type === "opacity"
        ? scalar(step, target, "opacity", step.processor.opacity, at)
        : null;
    },
    geometry(step: ProcessingStep, target: ProcessingTarget, at: TimeValue): Geometry | null {
      if (step.processor.type !== "geometry") return null;
      const { scale, rect, crop, pivot, rotationDeg, ...rest } = step.processor;
      const resolved = Object.fromEntries(
        Object.entries(processingScalars(step.processor)).map(([slot, value]) => [
          slot,
          scalar(step, target, slot, value, at),
        ]),
      );
      if (
        Object.values(resolved).some((value) => value === null) ||
        (step.window && program(step, target, "window", 1)?.sample(at) == null)
      )
        return null;
      return {
        ...rest,
        ...(scale ? { scale: { x: resolved["scale.x"]!, y: resolved["scale.y"]! } } : {}),
        ...(rect
          ? {
              rect: {
                x: resolved["rect.x"]!,
                y: resolved["rect.y"]!,
                width: resolved["rect.width"]!,
                height: resolved["rect.height"]!,
              },
            }
          : {}),
        ...(crop
          ? {
              crop: {
                x: resolved["crop.x"]!,
                y: resolved["crop.y"]!,
                width: resolved["crop.width"]!,
                height: resolved["crop.height"]!,
              },
            }
          : {}),
        ...(pivot ? { pivot: { x: resolved["pivot.x"]!, y: resolved["pivot.y"]! } } : {}),
        ...(rotationDeg !== undefined ? { rotationDeg: resolved.rotationDeg! } : {}),
      };
    },
    boundaries(plan: readonly ProcessingInstruction[]): Rational[] {
      const points = plan
        .flatMap((node) =>
          node.steps.flatMap((step) => {
            if (!step.enabled) return [];
            const curves = Object.entries(processingScalars(step.processor)).filter(
              ([, value]) => typeof value !== "number",
            );
            if (curves.length)
              return curves.flatMap(
                ([slot, value]) => program(step, node.target, slot, value)?.boundaries ?? [],
              );
            return step.window ? (program(step, node.target, "window", 1)?.boundaries ?? []) : [];
          }),
        )
        .sort(compare);
      return points.filter((at, index) => index === 0 || compare(at, points[index - 1]!) !== 0);
    },
  };
}
