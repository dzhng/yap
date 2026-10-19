import type { IndexPointerSample } from "./source-index-selection.js";

export const coverageQuietUs = 30_000_000;

/**
 * The coverage gate shared by source and project picture selection (D21). A picture is due when
 * it differs from the last chosen picture and either thirty seconds have passed since that choice
 * or the pointer has travelled one picture long edge since it. Every chosen picture counts,
 * whatever its reason, so selectors report each one through `chosen`.
 *
 * Times are the selector's own clock; pointer samples keep theirs. A selector scans forward with
 * `advance`, may report choices in any order (a project knows its last frame before it scans),
 * and the tracker counts only those at or before the scan.
 */
export class CoverageTracker {
  // Sorted, so the latest choice at or before the scan is one search however choices arrive.
  private readonly choices: number[] = [];
  private pointer: readonly IndexPointerSample[] = [];
  private pointerIndex = 0;
  private position = -Infinity;
  private lastChosen = -Infinity;
  private travelPx = 0;
  // The stillness run of the last chosen picture, when the scan saw it; unknown counts as changed.
  private chosenRun: number | undefined;

  constructor(pointer: readonly IndexPointerSample[] = []) {
    this.scan(pointer);
  }

  /** Start another forward scan (a project reads one source fragment at a time); choices stay. */
  scan(pointer: readonly IndexPointerSample[]): void {
    this.pointer = pointer;
    this.pointerIndex = 0;
    this.position = -Infinity;
    this.lastChosen = -Infinity;
    this.travelPx = 0;
    this.chosenRun = undefined;
  }

  chosen(at: number): void {
    const choices = this.choices;
    if (!choices.length || at > choices.at(-1)!) choices.push(at);
    else {
      const index = this.search(at);
      if (choices[index - 1] !== at) choices.splice(index, 0, at);
    }
    if (at <= this.position) this.settle();
  }

  /** Move the scan to `at`, counting pointer travel through `pointerUs` on the samples' clock. */
  advance(at: number, pointerUs = at): void {
    const samples = this.pointer;
    while (samples[this.pointerIndex] && samples[this.pointerIndex]!.sourceUs <= pointerUs) {
      const sample = samples[this.pointerIndex++]!;
      const prior = samples[this.pointerIndex - 2];
      if (prior && sample.x !== null && sample.y !== null && prior.x !== null && prior.y !== null)
        this.travelPx += Math.hypot(sample.x - prior.x, sample.y - prior.y);
    }
    this.position = at;
    this.settle();
  }

  /** Whether the picture at the scan, in stillness run `run`, is due for coverage. */
  due(run: number, pictureLongEdgePx: number): boolean {
    return (
      Number.isFinite(this.lastChosen) &&
      run !== this.chosenRun &&
      (this.position - this.lastChosen >= coverageQuietUs || this.travelPx >= pictureLongEdgePx)
    );
  }

  /** What the scan shows now: a run, or `undefined` for no picture. Called after any choice. */
  shown(run: number | undefined): void {
    this.settle();
    if (run === undefined) this.chosenRun = undefined;
    else if (this.lastChosen === this.position) this.chosenRun = run;
  }

  // A newer choice at or before the scan restarts travel and forgets the chosen picture.
  private settle(): void {
    const latest = this.choices[this.search(this.position) - 1] ?? -Infinity;
    if (latest === this.lastChosen) return;
    this.lastChosen = latest;
    this.travelPx = 0;
    this.chosenRun = undefined;
  }

  // The index of the first choice after `at`.
  private search(at: number): number {
    let low = 0,
      high = this.choices.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.choices[middle]! <= at) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
