import { compare, fromTime, type TimeValue } from "@yap/composition";
import { CatalogError } from "./catalog.js";
export type EvidenceKey = {
  projectStartUs: TimeValue;
  trackRank: number;
  clipId: string;
  sourceOrdinal: number;
  eventKind: string;
};
// Event kinds break otherwise equal keys lexically; this retains gap-before-word ordering.
export function compareKey(a: EvidenceKey, b: EvidenceKey) {
  return (
    compare(fromTime(a.projectStartUs), fromTime(b.projectStartUs)) ||
    a.trackRank - b.trackRank ||
    (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0) ||
    a.sourceOrdinal - b.sourceOrdinal ||
    (a.eventKind < b.eventKind ? -1 : a.eventKind > b.eventKind ? 1 : 0)
  );
}
export type MergePosition = {
  initialized: number;
  pendingTrack: number | null;
  heap: number[];
  last: EvidenceKey | null;
};
export function mergeHeads(
  state: MergePosition,
  tracks: readonly { lowerBound: TimeValue }[],
  limit: number,
  fillNext: (index: number) => boolean,
  key: (index: number) => EvidenceKey | null | undefined,
  emit: (index: number) => void,
  canEmit: (index: number) => boolean = () => true,
) {
  const less = (a: number, b: number) => compareKey(key(a)!, key(b)!) < 0;
  const push = (index: number) => {
    if (!key(index)) return;
    state.heap.push(index);
    let at = state.heap.length - 1;
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!less(state.heap[at]!, state.heap[parent]!)) break;
      [state.heap[at], state.heap[parent]] = [state.heap[parent]!, state.heap[at]!];
      at = parent;
    }
  };
  const pop = () => {
    const result = state.heap[0]!,
      last = state.heap.pop()!;
    if (state.heap.length) {
      state.heap[0] = last;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1,
          right = left + 1;
        if (left >= state.heap.length) break;
        const next =
          right < state.heap.length && less(state.heap[right]!, state.heap[left]!) ? right : left;
        if (!less(state.heap[next]!, state.heap[at]!)) break;
        [state.heap[at], state.heap[next]] = [state.heap[next]!, state.heap[at]!];
        at = next;
      }
    }
    return result;
  };
  for (let emitted = 0; emitted < limit;) {
    if (state.pendingTrack !== null) {
      if (!fillNext(state.pendingTrack)) break;
      push(state.pendingTrack);
      state.pendingTrack = null;
    }
    const next = tracks[state.initialized];
    if (
      next &&
      (!state.heap.length ||
        compare(fromTime(next.lowerBound), fromTime(key(state.heap[0]!)!.projectStartUs)) <= 0)
    ) {
      const index = state.initialized;
      if (!fillNext(index)) break;
      push(index);
      state.initialized++;
      continue;
    }
    if (!state.heap.length) break;
    if (!canEmit(state.heap[0]!)) break;
    const index = pop(),
      currentKey = key(index)!;
    if (state.last && compareKey(currentKey, state.last) <= 0)
      throw new CatalogError("INVALID_EVIDENCE", "Project evidence order did not advance");
    emit(index);
    emitted++;
    state.last = currentKey;
    state.pendingTrack = index;
  }
}
