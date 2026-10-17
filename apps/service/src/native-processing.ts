import type { CompiledProcessingInstruction } from "@yap/composition";

/** Native audio reads only each step's id, enabled flag and lowered processor; the audio
 * program already holds only audio processors, and picture work arrives as visual operations. */
export function nativeProcessing(plan: readonly CompiledProcessingInstruction[]) {
  return plan.map(({ steps, ...node }) => ({
    ...node,
    steps: steps.map(({ id, enabled, processor }) => ({ id, enabled, processor })),
  }));
}
