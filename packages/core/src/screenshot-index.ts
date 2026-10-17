import { ResourceReferences } from "./references.js";
import { ownerIdentity, type JobOwner } from "./jobs.js";
import {
  copyImportedFile,
  hashFile,
  fileIdentity,
  retainedFileRead,
  type IdentifiedFile,
} from "./files.js";
import { openRetainedImage, type RetainedImage } from "./retained-image.js";
import {
  ScreenshotIndexReader,
  type EntryQuery,
  type CoverageQuery,
  type IndexCoverage,
} from "./screenshot-index-read.js";
import { createHash } from "node:crypto";
import { fstatSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { CatalogError, type Catalog } from "./catalog.js";

export const selectionPolicy = Object.freeze({
  id: "sampled-evidence-selection-v2",
  coverageUs: 5_000_000,
  ordinarySpacingUs: 1_000_000,
  idleUs: 300_000,
  continuousUs: 2_000_000,
  motionToleranceFraction: 0.001,
  burstDistanceFraction: 0.01,
  maximumPendingCandidates: 5000,
});

export type IndexRecords = {
  identity: { generation: string };
  candidate: { ordinal: number };
  frame: RetainedImage;
  coverage: { ordinal: number | null };
};
export type ScreenshotIndexMetadata<D extends IndexRecords = IndexRecords> = D["identity"] & {
  durationUs: number;
  candidateCount: number;
  coverageCount: number;
  bytes: number;
};
export type ScreenshotIndexEntry<D extends IndexRecords = IndexRecords> = {
  candidate: D["candidate"];
  frame: D["frame"];
  coverageCount: number;
};
export type IndexOwner = Extract<JobOwner, { kind: "asset" | "project" }>;
export type PortableIndexRecord<D extends IndexRecords> =
  | {
      kind: "entry";
      candidate: D["candidate"];
      frame: D["frame"];
      source: IdentifiedFile;
      sha256: string;
    }
  | { kind: "coverage"; coverage: D["coverage"] };
export function indexGenerationResource(owner: IndexOwner, generation: string): string {
  return JSON.stringify([...ownerIdentity(owner), generation]);
}
export type IndexAdmission = "produced" | "retained";
export type IndexDomain<D extends IndexRecords> = {
  owner(identity: D["identity"]): IndexOwner;
  pin(identity: D["identity"]): D["identity"];
  begin(identity: D["identity"], admission: IndexAdmission): number;
  candidate(
    identity: D["identity"],
    candidate: D["candidate"],
    frame: D["frame"],
    path: string,
    previous: D["candidate"] | null,
  ): void;
  coverage(input: {
    identity: D["identity"];
    candidate: D["candidate"] | null;
    coverage: D["coverage"];
    admission: IndexAdmission;
  }): { startUs: number; endUs: number };
  merge(before: D["coverage"], next: D["coverage"]): D["coverage"] | null;
  finishEntry?(coverageCount: number): void;
  finish(identity: D["identity"], candidateCount: number): void;
  retained?(
    identity: D["identity"],
    signal: AbortSignal,
  ): {
    coverage(frame: D["frame"] | undefined, coverage: D["coverage"]): Promise<void>;
    close(): Promise<unknown>;
  };
  isDeleting(owner: IndexOwner): boolean;
};
type Generation = {
  identity: string;
  state: string;
  durationUs: number;
  candidateCount: number;
  coverageCount: number;
  bytes: number;
  throughUs: number;
  device: number | null;
  inode: number | null;
};
type Entry = {
  ordinal: number;
  candidate: string;
  frame: string;
  bytes: number;
  device: number;
  inode: number;
  modified: number;
  coverageCount: number;
};
type Coverage = { sequence: number; ordinal: number | null; content: string };
const where = "ownerKind=? AND ownerId=? AND generation=?";
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
function metadata<D extends IndexRecords>(row: Generation): ScreenshotIndexMetadata<D> {
  return {
    ...JSON.parse(row.identity),
    durationUs: row.durationUs,
    candidateCount: row.candidateCount,
    coverageCount: row.coverageCount,
    bytes: row.bytes,
  };
}
/** Producers can refuse oversized records before scheduling pictures; writes use the same budget. */
export function encodeIndexRecord(value: unknown): string {
  const text = JSON.stringify(value),
    observed = Buffer.byteLength(text),
    maximum = 262144;
  if (observed > maximum)
    throw new CatalogError("LIMIT_EXCEEDED", "Index row exceeds storage budget", {
      limitKind: "index-record-bytes",
      maximum,
      observed,
    });
  return text;
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Owns retained rows and PNGs; only the job queue can publish a finished generation. */
export class ScreenshotIndexStore<
  D extends IndexRecords = IndexRecords,
> extends ScreenshotIndexReader<D> {
  private readonly home: string;
  private readonly device: number;
  private readonly references: ResourceReferences;
  /** Startup runs before queue admission, including owners absent from the asset/project catalog. */
  async recoverPending(ownerKind: IndexOwner["kind"], signal: AbortSignal): Promise<void> {
    let cursor = 0;
    const failures: unknown[] = [];
    for (;;) {
      signal.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,identity FROM screenshot_index_generations WHERE ownerKind=? AND state!='complete' AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(ownerKind, cursor) as { cursor: number; identity: string }[];
      for (const row of rows) {
        signal.throwIfAborted();
        try {
          await this.remove(JSON.parse(row.identity) as D["identity"]);
        } catch (error) {
          if (!failures.length) failures.push(error);
        }
        cursor = row.cursor;
      }
      if (rows.length < 100) break;
      await setImmediate();
    }
    if (failures.length)
      throw new AggregateError(failures, "Pending screenshot index recovery failed");
  }
  /** Pin metadata only; archive jobs enumerate and hash retained payloads afterward. */
  portableGenerations(
    owner: IndexOwner,
    limit = 25000,
    revisionIds?: readonly string[],
  ): ScreenshotIndexMetadata<D>[] {
    const rows = this.store.catalog
      .prepare(
        "SELECT * FROM screenshot_index_generations WHERE ownerKind=? AND ownerId=? AND (? IS NULL OR json_extract(identity, '$.revisionId') IN (SELECT value FROM json_each(?))) ORDER BY generation LIMIT ?",
      )
      .all(
        ...ownerIdentity(owner),
        revisionIds ? JSON.stringify(revisionIds) : null,
        revisionIds ? JSON.stringify(revisionIds) : null,
        limit + 1,
      ) as Generation[];
    if (rows.length > limit)
      throw new CatalogError("LIMIT_EXCEEDED", "Retained index inventory exceeds its limit");
    if (rows.some((row) => row.state !== "complete"))
      throw new CatalogError("PROCESSING_BUSY", "Screenshot index generation is incomplete", {});
    return rows.map((row) => metadata<D>(row));
  }
  portableImage(identity: D["identity"], ordinal: number): IdentifiedFile {
    const row = this.row(identity, "complete"),
      entry = this.entry(identity, ordinal);
    const directory = this.checkedDirectory(identity, row);
    const file = this.openImage(directory, row, entry).file;
    try {
      return {
        path: join(directory, `${ordinal}.png`),
        bytes: entry.bytes,
        identity: fileIdentity(fstatSync(file.fd, { bigint: true })),
      };
    } finally {
      file.close();
    }
  }
  constructor(
    private readonly store: Catalog,
    home: string,
    private readonly domain: IndexDomain<D>,
  ) {
    super();
    this.references = new ResourceReferences(store);
    this.home = realpathSync(home);
    this.device = lstatSync(this.home).dev;
    store.catalog.exec(`CREATE TABLE IF NOT EXISTS screenshot_index_generations (
    ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,generation TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,
    durationUs INTEGER NOT NULL,candidateCount INTEGER NOT NULL DEFAULT 0,coverageCount INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,throughUs INTEGER NOT NULL DEFAULT 0,device INTEGER,inode INTEGER,
    PRIMARY KEY(ownerKind,ownerId,generation)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS screenshot_index_entries (
    ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,candidate TEXT NOT NULL,frame TEXT NOT NULL,
    bytes INTEGER NOT NULL,device INTEGER NOT NULL,inode INTEGER NOT NULL,modified REAL NOT NULL,coverageCount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(ownerKind,ownerId,generation,ordinal)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS screenshot_index_coverage (
    ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,generation TEXT NOT NULL,sequence INTEGER NOT NULL,ordinal INTEGER,content TEXT NOT NULL,
    PRIMARY KEY(ownerKind,ownerId,generation,sequence)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS screenshot_index_coverage_candidate ON screenshot_index_coverage(ownerKind,ownerId,generation,ordinal,sequence);`);
  }
  private key(identity: D["identity"]) {
    return [...ownerIdentity(this.domain.owner(identity)), identity.generation];
  }
  private row(identity: D["identity"], state?: string): Generation {
    const row = this.store.catalog
      .prepare(`SELECT * FROM screenshot_index_generations WHERE ${where}`)
      .get(...this.key(identity)) as Generation | undefined;
    if (!row || !isDeepStrictEqual(JSON.parse(row.identity), this.domain.pin(identity)))
      invalid("Index identity does not match retained generation");
    if (state && row.state !== state)
      invalid(
        state === "complete"
          ? "Index generation is not complete"
          : "Index generation is not writable",
      );
    return row;
  }
  /** Generation directories that reclaim removes for this owner. */
  ownedPaths(owner: IndexOwner): readonly string[] {
    const rows = this.store.catalog
      .prepare("SELECT identity FROM screenshot_index_generations WHERE ownerKind=? AND ownerId=?")
      .all(...ownerIdentity(owner)) as { identity: string }[];
    return rows.map((row) => join(this.home, ...this.parts(JSON.parse(row.identity))));
  }
  /** The generation directory's segments below the index home; one owner for the layout. */
  private parts(identity: D["identity"]): string[] {
    const [kind, id] = ownerIdentity(this.domain.owner(identity));
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !identity.generation) invalid("Invalid index identity");
    return [
      "evidence",
      "index",
      kind,
      id,
      createHash("sha256").update(identity.generation).digest("hex"),
    ];
  }
  private directory(identity: D["identity"], create = false, exclusive = false): string {
    const parts = this.parts(identity);
    const home = lstatSync(this.home);
    if (!home.isDirectory() || home.dev !== this.device) invalid("Retained index home changed");
    let path = this.home;
    for (const [partIndex, segment] of parts.entries()) {
      path = join(path, segment);
      if (create) {
        try {
          mkdirSync(path);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" ||
            (exclusive && partIndex === parts.length - 1)
          )
            throw error;
        }
      }
      const stat = lstatSync(path);
      if (!stat.isDirectory()) invalid("Retained index directory must not be a link");
      if (stat.dev !== this.device) invalid("Retained index must stay on the library filesystem");
    }
    return path;
  }
  private checkedDirectory(identity: D["identity"], row: Generation): string {
    const path = this.directory(identity);
    const stat = lstatSync(path);
    if (stat.ino !== row.inode) invalid("Retained index directory changed");
    return path;
  }

  private openImage(directory: string, row: Generation, entry: Entry) {
    if (entry.device !== row.device) invalid("Retained image belongs to another filesystem");
    // Device numbers can change across boots. Persisted numbers establish that the image
    // and its generation shared a filesystem; current reads must stay on the library's.
    return openRetainedImage(join(directory, `${entry.ordinal}.png`), JSON.parse(entry.frame), {
      device: this.device,
      inode: entry.inode,
      modified: entry.modified,
    });
  }
  /** Files and structural rows are staged first; ownership becomes visible only in the caller's transaction. */
  async stagePortable(
    expected: ScreenshotIndexMetadata<D>,
    records: AsyncIterable<PortableIndexRecord<D>>,
    signal: AbortSignal,
    validation: IndexDomain<D>,
  ) {
    for (const count of [
      expected.durationUs,
      expected.candidateCount,
      expected.coverageCount,
      expected.bytes,
    ])
      if (!integer(count))
        throw new CatalogError("INVALID_PACKAGE", "Invalid retained index counts");
    if (expected.candidateCount > 25000 || expected.coverageCount > 25000)
      throw new CatalogError("LIMIT_EXCEEDED", "Retained index exceeds package row budget");
    const identity = this.domain.pin(expected),
      key = this.key(identity);
    const prior = this.store.catalog
      .prepare(`SELECT * FROM screenshot_index_generations WHERE ${where}`)
      .get(...key) as Generation | undefined;
    if (prior && (prior.state !== "complete" || !isDeepStrictEqual(metadata<D>(prior), expected)))
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Retained index identity conflicts with local generation",
      );
    let owned = false;
    const close = async () => {
      if (!owned) return;
      const row = this.store.catalog
        .prepare(`SELECT state FROM screenshot_index_generations WHERE ${where}`)
        .get(...key);
      if (row?.state !== "complete") await this.remove(identity);
    };
    try {
      if (!prior) {
        this.store.catalog
          .prepare(
            "INSERT INTO screenshot_index_generations(ownerKind,ownerId,generation,identity,state,durationUs) VALUES(?,?,?,?,'staging',?)",
          )
          .run(...key, encodeIndexRecord(identity), expected.durationUs);
        try {
          const path = this.directory(identity, true, true),
            stat = lstatSync(path);
          owned = true;
          this.store.catalog
            .prepare(`UPDATE screenshot_index_generations SET device=?,inode=? WHERE ${where}`)
            .run(stat.dev, stat.ino, ...key);
        } catch (error) {
          if (!owned)
            this.store.catalog
              .prepare(`DELETE FROM screenshot_index_generations WHERE ${where}`)
              .run(...key);
          throw error;
        }
      }
      let candidates = 0,
        coverageCount = 0,
        bytes = 0;
      for await (const record of records) {
        signal.throwIfAborted();
        const row = this.row(identity, prior ? "complete" : "staging");
        if (record.kind === "entry") {
          if (
            coverageCount ||
            record.candidate.ordinal !== candidates ||
            candidates >= expected.candidateCount ||
            record.frame.file !== `${candidates}.png` ||
            !/^[a-f0-9]{64}$/.test(record.sha256)
          )
            throw new CatalogError(
              "INVALID_PACKAGE",
              "Retained index entry ordering or file identity is invalid",
            );
          const path = join(this.checkedDirectory(identity, row), `${candidates}.png`),
            frame = { ...record.frame, file: path };
          if (prior) {
            const old = this.entry(identity, candidates);
            if (
              !isDeepStrictEqual(JSON.parse(old.candidate), record.candidate) ||
              !isDeepStrictEqual(JSON.parse(old.frame), frame)
            )
              throw new CatalogError(
                "INVALID_PACKAGE",
                "Retained index entry conflicts with local evidence",
              );
            const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              if ((await hashFile(file, frame.bytes, signal)).sha256 !== record.sha256)
                throw new CatalogError(
                  "INVALID_PACKAGE",
                  "Retained index PNG conflicts with local bytes",
                );
            } finally {
              await file.close();
            }
          } else {
            const copied = await copyImportedFile(
              record.source.path,
              path,
              signal,
              record.source,
              32 * 1024 * 1024,
            );
            if (copied.bytes !== frame.bytes || copied.sha256 !== record.sha256)
              throw new CatalogError(
                "INVALID_PACKAGE",
                "Retained index PNG differs from inventory",
              );
            const retained = openRetainedImage(path, frame),
              stat = retained.stat;
            retained.file.close();
            this.store.catalog
              .prepare("INSERT INTO screenshot_index_entries VALUES(?,?,?,?,?,?,?,?,?,?,0)")
              .run(
                ...key,
                candidates,
                encodeIndexRecord(record.candidate),
                encodeIndexRecord(frame),
                stat.size,
                stat.dev,
                stat.ino,
                stat.mtimeMs,
              );
            this.store.catalog
              .prepare(
                `UPDATE screenshot_index_generations SET candidateCount=candidateCount+1,bytes=bytes+? WHERE ${where}`,
              )
              .run(stat.size, ...key);
          }
          candidates++;
          bytes += frame.bytes;
        } else {
          const coverage = record.coverage;
          if (
            candidates !== expected.candidateCount ||
            coverageCount >= expected.coverageCount ||
            (coverage.ordinal !== null &&
              (!integer(coverage.ordinal) || coverage.ordinal >= candidates))
          )
            throw new CatalogError(
              "INVALID_PACKAGE",
              "Retained index coverage ordering is invalid",
            );
          if (prior) {
            const old = this.store.catalog
              .prepare(
                `SELECT content FROM screenshot_index_coverage WHERE ${where} AND sequence=?`,
              )
              .get(...key, coverageCount);
            if (!old || !isDeepStrictEqual(JSON.parse(old.content as string), coverage))
              throw new CatalogError(
                "INVALID_PACKAGE",
                "Retained index coverage conflicts with local evidence",
              );
          } else {
            this.store.catalog
              .prepare("INSERT INTO screenshot_index_coverage VALUES(?,?,?,?,?,?)")
              .run(...key, coverageCount, coverage.ordinal, encodeIndexRecord(coverage));
            this.store.catalog
              .prepare(
                `UPDATE screenshot_index_generations SET coverageCount=coverageCount+1 WHERE ${where}`,
              )
              .run(...key);
            this.store.catalog
              .prepare(
                `UPDATE screenshot_index_entries SET coverageCount=coverageCount+1 WHERE ${where} AND ordinal=?`,
              )
              .run(...key, coverage.ordinal);
          }
          coverageCount++;
        }
        await setImmediate();
      }
      if (
        candidates !== expected.candidateCount ||
        coverageCount !== expected.coverageCount ||
        bytes !== expected.bytes
      )
        throw new CatalogError("INVALID_PACKAGE", "Retained index inventory differs from metadata");
      if (!prior) {
        let directory = this.directory(identity);
        for (;;) {
          const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (directory === this.home) break;
          directory = dirname(directory);
        }
      }
      await this.validateRetained(identity, validation, signal);
      return {
        metadata: expected,
        close,
        publish: () => {
          signal.throwIfAborted();
          this.row(identity, prior ? "complete" : "staging");
          if (this.domain.begin(identity, "retained") !== expected.durationUs)
            invalid("Retained index owner changed before publication");
          if (!prior)
            this.store.catalog
              .prepare(
                `UPDATE screenshot_index_generations SET state='complete',throughUs=durationUs WHERE ${where}`,
              )
              .run(...key);
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  private async validateRetained(
    identity: D["identity"],
    domain: IndexDomain<D>,
    signal: AbortSignal,
  ): Promise<void> {
    const row = this.row(identity),
      directory = this.checkedDirectory(identity, row);
    if (domain.begin(identity, "retained") !== row.durationUs)
      invalid("Retained index duration differs from its owner");
    const retained = domain.retained?.(identity, signal);
    try {
      let previous: D["candidate"] | null = null;
      for (let ordinal = 0; ordinal < row.candidateCount; ordinal++) {
        signal.throwIfAborted();
        const entry = this.entry(identity, ordinal),
          candidate = JSON.parse(entry.candidate) as D["candidate"];
        domain.candidate(
          identity,
          candidate,
          JSON.parse(entry.frame),
          join(directory, `${ordinal}.png`),
          previous,
        );
        domain.finishEntry?.(entry.coverageCount);
        this.openImage(directory, row, entry).file.close();
        previous = candidate;
        if (ordinal % 100 === 99) await setImmediate(undefined, { signal });
      }
      let through = 0;
      for (let sequence = 0; sequence < row.coverageCount; sequence++) {
        signal.throwIfAborted();
        const stored = this.store.catalog
          .prepare(`SELECT content FROM screenshot_index_coverage WHERE ${where} AND sequence=?`)
          .get(...this.key(identity), sequence);
        if (!stored) invalid("Retained index coverage is missing");
        const coverage = JSON.parse(stored.content as string) as D["coverage"],
          candidate =
            coverage.ordinal === null
              ? null
              : (JSON.parse(this.entry(identity, coverage.ordinal).candidate) as D["candidate"]),
          extent = domain.coverage({ identity, candidate, coverage, admission: "retained" });
        if (
          !integer(extent.startUs) ||
          !integer(extent.endUs) ||
          extent.startUs !== through ||
          extent.endUs <= through ||
          extent.endUs > row.durationUs
        )
          invalid("Retained index coverage must progress contiguously inside its span");
        await retained?.coverage(
          coverage.ordinal === null
            ? undefined
            : JSON.parse(this.entry(identity, coverage.ordinal).frame),
          coverage,
        );
        through = extent.endUs;
        if (sequence % 100 === 99) await setImmediate(undefined, { signal });
      }
      if (through !== row.durationUs) invalid("Retained index coverage is incomplete");
      domain.finish(identity, row.candidateCount);
    } finally {
      await retained?.close();
    }
  }
  begin(identity: D["identity"]): void {
    const encoded = encodeIndexRecord(this.domain.pin(identity));
    const durationUs = this.domain.begin(identity, "produced");
    this.store.catalog
      .prepare(
        "INSERT INTO screenshot_index_generations(ownerKind,ownerId,generation,identity,state,durationUs) VALUES(?,?,?,?,'building',?)",
      )
      .run(...this.key(identity), encoded, durationUs);
    const path = this.directory(identity, true),
      stat = lstatSync(path);
    this.store.catalog
      .prepare(`UPDATE screenshot_index_generations SET device=?,inode=? WHERE ${where}`)
      .run(stat.dev, stat.ino, ...this.key(identity));
  }
  outputPath(identity: D["identity"], ordinal: number): string {
    const row = this.row(identity, "building");
    if (!integer(ordinal) || ordinal !== row.candidateCount)
      invalid("Candidate ordinal must be the next append");
    return join(this.checkedDirectory(identity, row), `${ordinal}.png`);
  }
  private entry(identity: D["identity"], ordinal: number): Entry {
    if (!integer(ordinal)) invalid("Invalid candidate ordinal");
    const entry = this.store.catalog
      .prepare(`SELECT * FROM screenshot_index_entries WHERE ${where} AND ordinal=?`)
      .get(...this.key(identity), ordinal) as Entry | undefined;
    if (!entry) invalid("Unknown selected image");
    return entry;
  }
  appendCandidate(identity: D["identity"], candidate: D["candidate"], frame: D["frame"]): void {
    const encodedCandidate = encodeIndexRecord(candidate),
      encodedFrame = encodeIndexRecord(frame);
    const path = this.outputPath(identity, candidate.ordinal);
    const previous = candidate.ordinal
      ? (JSON.parse(this.entry(identity, candidate.ordinal - 1).candidate) as D["candidate"])
      : null;
    this.domain.candidate(identity, candidate, frame, path, previous);
    const { file, stat } = openRetainedImage(path, frame);
    file.close();
    this.store.transaction(() => {
      const row = this.row(identity, "building");
      if (row.candidateCount !== candidate.ordinal) invalid("Candidate append moved");
      this.store.catalog
        .prepare("INSERT INTO screenshot_index_entries VALUES(?,?,?,?,?,?,?,?,?,?,0)")
        .run(
          ...this.key(identity),
          candidate.ordinal,
          encodedCandidate,
          encodedFrame,
          stat.size,
          stat.dev,
          stat.ino,
          stat.mtimeMs,
        );
      this.store.catalog
        .prepare(
          `UPDATE screenshot_index_generations SET candidateCount=candidateCount+1,bytes=bytes+? WHERE ${where}`,
        )
        .run(stat.size, ...this.key(identity));
    });
  }
  appendCoverage(identity: D["identity"], coverage: D["coverage"]): void {
    this.store.transaction(() => {
      const row = this.row(identity, "building");
      const candidate =
        coverage.ordinal === null
          ? null
          : (JSON.parse(this.entry(identity, coverage.ordinal).candidate) as D["candidate"]);
      const extent = this.domain.coverage({
        identity,
        candidate,
        coverage,
        admission: "produced",
      });
      if (
        !integer(extent.startUs) ||
        !integer(extent.endUs) ||
        extent.startUs !== row.throughUs ||
        extent.endUs <= extent.startUs ||
        extent.endUs > row.durationUs
      )
        invalid("Index coverage must progress contiguously inside its retained span");
      const previous = this.store.catalog
        .prepare(
          `SELECT * FROM screenshot_index_coverage WHERE ${where} ORDER BY sequence DESC LIMIT 1`,
        )
        .get(...this.key(identity)) as Coverage | undefined;
      const before = previous ? (JSON.parse(previous.content) as D["coverage"]) : undefined;
      const merged = before ? this.domain.merge(before, coverage) : null;
      if (previous && merged) {
        this.store.catalog
          .prepare(`UPDATE screenshot_index_coverage SET content=? WHERE ${where} AND sequence=?`)
          .run(encodeIndexRecord(merged), ...this.key(identity), previous.sequence);
      } else {
        this.store.catalog
          .prepare("INSERT INTO screenshot_index_coverage VALUES(?,?,?,?,?,?)")
          .run(
            ...this.key(identity),
            row.coverageCount,
            coverage.ordinal,
            encodeIndexRecord(coverage),
          );
        this.store.catalog
          .prepare(
            `UPDATE screenshot_index_generations SET coverageCount=coverageCount+1 WHERE ${where}`,
          )
          .run(...this.key(identity));
        this.store.catalog
          .prepare(
            `UPDATE screenshot_index_entries SET coverageCount=coverageCount+1 WHERE ${where} AND ordinal=?`,
          )
          .run(...this.key(identity), coverage.ordinal);
      }
      this.store.catalog
        .prepare(`UPDATE screenshot_index_generations SET throughUs=? WHERE ${where}`)
        .run(extent.endUs, ...this.key(identity));
    });
  }
  async finish(identity: D["identity"], signal?: AbortSignal): Promise<ScreenshotIndexMetadata<D>> {
    const row = this.row(identity, "building");
    if (row.throughUs !== row.durationUs) invalid("Index coverage is incomplete");
    signal?.throwIfAborted();
    this.store.catalog
      .prepare(`UPDATE screenshot_index_generations SET state='finishing' WHERE ${where}`)
      .run(...this.key(identity));
    for (let ordinal = 0; ordinal < row.candidateCount; ordinal += 100) {
      signal?.throwIfAborted();
      this.row(identity, "finishing");
      const directory = this.checkedDirectory(identity, row);
      const entries = this.store.catalog
        .prepare(
          `SELECT * FROM screenshot_index_entries WHERE ${where} AND ordinal>=? ORDER BY ordinal LIMIT 100`,
        )
        .all(...this.key(identity), ordinal) as Entry[];
      for (const entry of entries) {
        this.domain.finishEntry?.(entry.coverageCount);
        const file = this.openImage(directory, row, entry);
        file.file.close();
      }
      await setImmediate();
    }
    signal?.throwIfAborted();
    this.row(identity, "finishing");
    this.domain.finish(identity, row.candidateCount);
    this.store.catalog
      .prepare(`UPDATE screenshot_index_generations SET state='complete' WHERE ${where}`)
      .run(...this.key(identity));
    return metadata<D>(this.row(identity, "complete"));
  }
  protected readMetadata(identity: D["identity"]): ScreenshotIndexMetadata<D> {
    if (this.domain.isDeleting(this.domain.owner(identity)))
      throw new CatalogError("NOT_FOUND", "Screenshot index owner is being deleted");
    return metadata<D>(this.row(identity, "complete"));
  }
  protected entryRows(identity: D["identity"], query: EntryQuery): ScreenshotIndexEntry<D>[] {
    this.readMetadata(identity);
    const rows = this.store.catalog
      .prepare(
        `SELECT candidate,frame,coverageCount FROM screenshot_index_entries WHERE ${where} AND ordinal>? ${query.through === undefined ? "" : "AND ordinal<=?"} ORDER BY ordinal LIMIT ?`,
      )
      .all(
        ...this.key(identity),
        query.after,
        ...(query.through === undefined ? [] : [query.through]),
        query.limit,
      ) as Pick<Entry, "candidate" | "frame" | "coverageCount">[];
    return rows.map(({ candidate, frame, coverageCount }) => ({
      candidate: JSON.parse(candidate),
      frame: JSON.parse(frame),
      coverageCount,
    }));
  }
  protected coverageRows(identity: D["identity"], query: CoverageQuery): IndexCoverage<D>[] {
    const rows = this.store.catalog
      .prepare(
        `SELECT sequence,content FROM screenshot_index_coverage WHERE ${where} AND sequence>? ${query.through === undefined ? "" : "AND sequence<=?"} ${query.ordinal === undefined ? "" : "AND ordinal=?"} ORDER BY sequence LIMIT ?`,
      )
      .all(
        ...this.key(identity),
        query.after,
        ...(query.through === undefined ? [] : [query.through]),
        ...(query.ordinal === undefined ? [] : [query.ordinal]),
        query.limit,
      ) as Pick<Coverage, "sequence" | "content">[];
    return rows.map(({ sequence, content }) => ({ sequence, ...JSON.parse(content) }));
  }
  openRead(identity: D["identity"], ordinal: number) {
    const row = this.row(identity, "complete");
    this.readEntry(identity, ordinal);
    const entry = this.entry(identity, ordinal);
    const { file } = this.openImage(this.checkedDirectory(identity, row), row, entry);
    return retainedFileRead(file, entry.bytes);
  }

  async remove(identity: D["identity"]): Promise<void> {
    if (
      !this.store.catalog
        .prepare(`SELECT 1 FROM screenshot_index_generations WHERE ${where}`)
        .get(...this.key(identity))
    )
      return;
    const row = this.row(identity);
    this.store.catalog
      .prepare(`UPDATE screenshot_index_generations SET state='deleting' WHERE ${where}`)
      .run(...this.key(identity));
    let directory: string | undefined;
    try {
      if (row.device === null) {
        // A crash before exclusive directory admission provides no authority to delete an existing path.
        this.directory(identity);
        throw new CatalogError(
          "INVALID_STORAGE",
          "Unadmitted screenshot index directory requires inspection",
        );
      }
      directory = this.checkedDirectory(identity, row);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    // Include the next, possibly rendered but not appended image left by cancellation.
    for (let ordinal = 0; ordinal <= row.candidateCount; ordinal++) {
      if (directory) {
        try {
          unlinkSync(join(directory, `${ordinal}.png`));
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (ordinal % 100 === 99) {
        await setImmediate();
        if (directory) this.checkedDirectory(identity, row);
      }
    }
    for (const table of ["screenshot_index_entries", "screenshot_index_coverage"]) {
      while (true) {
        const result = this.store.catalog
          .prepare(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT 100)`,
          )
          .run(...this.key(identity));
        if (Number(result.changes) < 100) break;
        await setImmediate();
      }
    }
    if (directory) {
      try {
        rmdirSync(directory);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    this.store.catalog
      .prepare(`DELETE FROM screenshot_index_generations WHERE ${where}`)
      .run(...this.key(identity));
  }
  async reclaim(
    owner: IndexOwner,
    keep: (identity: D["identity"]) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    let failureCount = 0;
    let firstFailure: unknown;
    while (true) {
      signal?.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,identity FROM screenshot_index_generations WHERE ownerKind=? AND ownerId=? AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(...ownerIdentity(owner), cursor) as { cursor: number; identity: string }[];
      for (const row of rows) {
        signal?.throwIfAborted();
        const identity = JSON.parse(row.identity) as D["identity"];
        try {
          if (
            !keep(identity) &&
            !this.references.has(
              "index-generation",
              indexGenerationResource(owner, identity.generation),
            )
          )
            await this.remove(identity);
        } catch (error) {
          failureCount++;
          firstFailure ??= error;
        }
        cursor = row.cursor;
      }
      if (rows.length < 100) {
        if (failureCount)
          throw new AggregateError(
            [firstFailure],
            `${failureCount} retained index generations could not be reclaimed`,
          );
        return;
      }
      await setImmediate();
    }
  }
}
