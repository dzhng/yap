import { writeFile } from "node:fs/promises";
import type { CaptureStore } from "./capture-store.js";
import { CatalogError } from "./catalog.js";
import type { DerivedCache } from "./cache.js";
import {
  analyzeVisualSamples,
  observeVisualSamples,
  sceneSampleLimits,
  scenePolicy,
  type VisualObservations,
  type VisualSample,
  type VisualSampler,
} from "./scenes.js";

function combine(
  times: readonly number[],
  batches: (VisualObservations | null)[],
): VisualObservations {
  const first = batches.find((batch) => batch !== null)!;
  const samples = new Map<number, VisualSample>();
  for (const batch of batches) {
    if (!batch) continue;
    if (batch.sourceWidth !== first.sourceWidth || batch.sourceHeight !== first.sourceHeight)
      throw new CatalogError(
        "INVALID_EVIDENCE",
        "Visual observation dimensions changed within an immutable source",
      );
    for (const sample of batch.samples) samples.set(sample.requestedSourceUs, sample);
  }
  return {
    sourceWidth: first.sourceWidth,
    sourceHeight: first.sourceHeight,
    samples: times.flatMap((at) => (samples.has(at) ? [samples.get(at)!] : [])),
  };
}

/** Reuses bounded native observations; retained scene conclusions belong to scene evidence. */
export class VisualObservationCache {
  constructor(
    private readonly store: CaptureStore,
    private readonly cache: DerivedCache,
    private readonly decode: VisualSampler,
  ) {
    store.catalog.exec(`
    CREATE TABLE IF NOT EXISTS visual_observation_samples (
      identity TEXT NOT NULL,requestedUs INTEGER NOT NULL,cacheId TEXT NOT NULL REFERENCES derived_cache(id) ON DELETE CASCADE,
      sampleOrdinal INTEGER NOT NULL,PRIMARY KEY(identity,requestedUs)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS visual_observation_samples_file ON visual_observation_samples(cacheId);`);
  }

  readonly sample: VisualSampler = async (request, signal) => {
    signal.throwIfAborted();
    this.store.get(request.ownerId);
    const { atSourceUs: times, kept } = request;
    if (
      !Number.isSafeInteger(kept.startUs) ||
      !Number.isSafeInteger(kept.endUs) ||
      kept.startUs < 0 ||
      kept.endUs <= kept.startUs ||
      times.length < 1 ||
      times.length > sceneSampleLimits.count ||
      times.some(
        (at, i) =>
          !Number.isSafeInteger(at) ||
          at < kept.startUs ||
          at >= kept.endUs ||
          (i > 0 && at <= times[i - 1]!),
      ) ||
      times.at(-1)! - times[0]! > sceneSampleLimits.spanUs
    )
      throw new CatalogError(
        "INVALID_RANGE",
        "Visual observations require a bounded ordered retained batch",
      );
    // Finalized source paths name immutable recording media; moving a library merely misses reuse.
    const identity = JSON.stringify([
      request.ownerId,
      scenePolicy.id,
      request.source,
      kept.startUs,
      kept.endUs,
    ]);
    const existing = this.read(identity, times);
    const cachedTimes = new Set(existing?.samples.map((sample) => sample.requestedSourceUs));
    const missing = times.filter((at) => !cachedTimes.has(at));
    if (missing.length === 0) return existing!;
    const observed = await observeVisualSamples(
      { ...request, atSourceUs: missing },
      this.decode,
      signal,
    );
    const assembled = combine(times, [existing, observed]);
    analyzeVisualSamples(assembled.samples);
    signal.throwIfAborted();
    const output = this.cache.reserve({ kind: "recording", id: request.ownerId });
    try {
      await writeFile(output.path, JSON.stringify(observed), { flag: "wx" });
      signal.throwIfAborted();
      await this.cache.publish(output.id);
      signal.throwIfAborted();
      // Another lane may already own some requested times. Keep those first publications.
      const winner = this.read(identity, times);
      const result = combine(times, [assembled, winner]);
      analyzeVisualSamples(result.samples);
      const inserted = this.store.transaction(() => {
        let count = 0;
        const insert = this.store.catalog.prepare(
          "INSERT OR IGNORE INTO visual_observation_samples(identity,requestedUs,cacheId,sampleOrdinal) VALUES(?,?,?,?)",
        );
        for (const [ordinal, sample] of observed.samples.entries())
          count += Number(
            insert.run(identity, sample.requestedSourceUs, output.id, ordinal).changes,
          );
        return count;
      });
      if (inserted === 0) this.cache.remove(output.id);
      return result;
    } catch (error) {
      this.cache.remove(output.id);
      throw error;
    }
  };

  private read(identity: string, times: readonly number[]): VisualObservations | null {
    const rows = this.store.catalog
      .prepare(
        `SELECT requestedUs,cacheId,sampleOrdinal FROM visual_observation_samples WHERE identity=? AND requestedUs IN (${times.map(() => "?").join(",")})`,
      )
      .all(identity, ...times) as { requestedUs: number; cacheId: string; sampleOrdinal: number }[];
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = grouped.get(row.cacheId) ?? [];
      group.push(row);
      grouped.set(row.cacheId, group);
    }
    let result: VisualObservations | null = null;
    for (const [cacheId, group] of grouped) {
      const observed = this.readFile(cacheId);
      if (!observed) continue;
      const selected = {
        sourceWidth: observed.sourceWidth,
        sourceHeight: observed.sourceHeight,
        samples: group.map((row) => {
          const sample = observed.samples[row.sampleOrdinal];
          if (sample?.requestedSourceUs !== row.requestedUs)
            throw new CatalogError(
              "INVALID_CACHE",
              "Visual observation lookup does not match its batch",
            );
          return sample;
        }),
      };
      result = combine(times, [result, selected]);
    }
    return result;
  }

  private readFile(cacheId: string): VisualObservations | null {
    const held = this.cache.acquire(cacheId);
    if (!held) return null;
    try {
      const bytes = Buffer.alloc(held.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = held.read(bytes.subarray(offset), offset);
        if (count === 0)
          throw new CatalogError("INVALID_CACHE", "Visual observation cache ended early");
        offset += count;
      }
      return JSON.parse(bytes.toString("utf8")) as VisualObservations;
    } finally {
      held.release();
    }
  }
}
