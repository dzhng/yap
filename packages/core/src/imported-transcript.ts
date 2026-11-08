import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream, statSync } from "node:fs";
import { fileIdentity, type IdentifiedFile } from "./files.js";
import { Catalog, CatalogError } from "./catalog.js";
import {
  readImportedTranscript,
  type ImportedCue,
  type ImportedFormat,
} from "./transcript-import.js";

export type ImportedTranscriptSource = {
  assetId: string;
  streamId: string;
  acquisitionId?: string | undefined;
};
export type ImportedTranscriptReceipt = {
  generation: string;
  source: ImportedTranscriptSource;
  origin: {
    format: ImportedFormat;
    parser: { name: string; version: string };
    timingBasis: "supplied";
    raw: { bytes: number; sha256: string };
    metadata: Record<string, unknown>;
  };
  timingPolicy: "supplied" | "align";
  alignment?: { modelId: string; channel: number } | undefined;
  cues: ImportedCue[];
};
export type PortableImportedTranscript = {
  generation: string;
  source: ImportedTranscriptSource;
  origin: ImportedTranscriptReceipt["origin"];
  timingPolicy: "supplied" | "align";
  alignment?: { modelId: string; channel: number } | undefined;
  cues: ImportedCue[];
};
export function importedTranscriptGenerationResource(
  value: Pick<PortableImportedTranscript, "generation" | "source">,
): string {
  return JSON.stringify({ source: value.source, generation: value.generation });
}

type StoredImport = {
  requestId: string;
  source: string;
  generation: string;
  format: ImportedFormat;
  parser: string;
  timingBasis: "supplied";
  timingPolicy: "supplied" | "align";
  alignmentModelId: string | null;
  alignmentChannel: number | null;
  rawSha256: string;
  rawBytes: number;
  metadata: string;
  state: "complete";
};

function sourceKey(source: ImportedTranscriptSource): string {
  return JSON.stringify(source);
}

function parseStored(row: StoredImport, cues: ImportedCue[]): ImportedTranscriptReceipt {
  return {
    generation: row.generation,
    source: JSON.parse(row.source) as ImportedTranscriptSource,
    origin: {
      format: row.format,
      parser: JSON.parse(row.parser) as { name: string; version: string },
      timingBasis: row.timingBasis,
      raw: { bytes: row.rawBytes, sha256: row.rawSha256 },
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    },
    timingPolicy: row.timingPolicy,
    ...(row.alignmentModelId === null
      ? {}
      : { alignment: { modelId: row.alignmentModelId, channel: row.alignmentChannel ?? 0 } }),
    cues,
  };
}

/** Durable source-owned imported transcript generations. Cue timing stays cue-level evidence. */
export class ImportedTranscriptStore {
  constructor(
    private readonly store: Catalog,
    private readonly home: string,
    private readonly validateSource: (source: ImportedTranscriptSource) => void,
  ) {
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS imported_transcripts (
        requestId TEXT PRIMARY KEY, source TEXT NOT NULL, generation TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL, parser TEXT NOT NULL, timingBasis TEXT NOT NULL,
        timingPolicy TEXT NOT NULL DEFAULT 'supplied',
        alignmentModelId TEXT,
        alignmentChannel INTEGER,
        rawSha256 TEXT NOT NULL, rawBytes INTEGER NOT NULL, metadata TEXT NOT NULL,
        state TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imported_transcript_cues (
        generation TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT NOT NULL,
        startUs INTEGER NOT NULL, endUs INTEGER NOT NULL, text TEXT NOT NULL,
        speaker TEXT, settings TEXT, words TEXT NOT NULL,
        PRIMARY KEY(generation, ordinal), FOREIGN KEY(generation) REFERENCES imported_transcripts(generation)
      ) STRICT;
    `);
    const columns = store.catalog.prepare("PRAGMA table_info(imported_transcripts)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "timingPolicy"))
      store.catalog.exec(
        "ALTER TABLE imported_transcripts ADD COLUMN timingPolicy TEXT NOT NULL DEFAULT 'supplied'",
      );
    if (!columns.some((column) => column.name === "alignmentModelId"))
      store.catalog.exec("ALTER TABLE imported_transcripts ADD COLUMN alignmentModelId TEXT");
    if (!columns.some((column) => column.name === "alignmentChannel"))
      store.catalog.exec("ALTER TABLE imported_transcripts ADD COLUMN alignmentChannel INTEGER");
  }

  async importPath(
    requestId: string,
    source: ImportedTranscriptSource,
    path: string,
    format?: ImportedFormat,
    timingPolicy: "supplied" | "align" = "supplied",
    alignment?: { modelId: string; channel: number },
  ): Promise<ImportedTranscriptReceipt> {
    this.validateSource(source);
    const existing = this.store.catalog
      .prepare("SELECT * FROM imported_transcripts WHERE requestId=?")
      .get(requestId) as StoredImport | undefined;
    if (existing) {
      if (existing.source !== sourceKey(source))
        throw new CatalogError(
          "CONFLICT",
          "Transcript import request was reused for another source",
        );
      return this.get(source, existing.generation);
    }
    const parsed = await readImportedTranscript(
      createReadStream(path, { highWaterMark: 65_536 }),
      format === undefined ? {} : { format },
    );
    const generation = randomUUID();
    const output = join(
      this.home,
      "transcripts",
      "imported",
      source.assetId,
      generation,
      `source.${parsed.format}`,
    );
    await mkdir(join(this.home, "transcripts", "imported", source.assetId, generation), {
      recursive: true,
    });
    await copyFile(path, output);
    this.store.transaction(() => {
      this.store.catalog
        .prepare(
          "INSERT INTO imported_transcripts(requestId,source,generation,format,parser,timingBasis,timingPolicy,alignmentModelId,alignmentChannel,rawSha256,rawBytes,metadata,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          requestId,
          sourceKey(source),
          generation,
          parsed.format,
          JSON.stringify(parsed.parser),
          parsed.timingBasis,
          timingPolicy,
          alignment?.modelId ?? null,
          alignment?.channel ?? null,
          parsed.raw.sha256,
          parsed.raw.bytes,
          JSON.stringify(parsed.metadata),
          "complete",
        );
      const insert = this.store.catalog.prepare(
        "INSERT INTO imported_transcript_cues(generation,ordinal,id,startUs,endUs,text,speaker,settings,words) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const cue of parsed.cues)
        insert.run(
          generation,
          cue.ordinal,
          cue.id,
          cue.source.startUs,
          cue.source.endUs,
          cue.text,
          cue.speaker ?? null,
          cue.settings ?? null,
          JSON.stringify(cue.words),
        );
    });
    return this.get(source, generation);
  }

  get(source: ImportedTranscriptSource, generation: string): ImportedTranscriptReceipt {
    this.validateSource(source);
    const row = this.store.catalog
      .prepare("SELECT * FROM imported_transcripts WHERE generation=?")
      .get(generation) as StoredImport | undefined;
    if (!row || row.state !== "complete" || row.source !== sourceKey(source))
      throw new CatalogError("NOT_FOUND", "Imported transcript generation is unavailable", {
        generation,
      });
    const rows = this.store.catalog
      .prepare("SELECT * FROM imported_transcript_cues WHERE generation=? ORDER BY ordinal")
      .all(generation) as {
      ordinal: number;
      id: string;
      startUs: number;
      endUs: number;
      text: string;
      speaker: string | null;
      settings: string | null;
      words: string;
    }[];
    return parseStored(
      row,
      rows.map((cue) => ({
        id: cue.id,
        ordinal: cue.ordinal,
        text: cue.text,
        ...(cue.speaker === null ? {} : { speaker: cue.speaker }),
        ...(cue.settings === null ? {} : { settings: cue.settings }),
        source: { startUs: cue.startUs, endUs: cue.endUs },
        words: JSON.parse(cue.words),
      })),
    );
  }

  find(source: ImportedTranscriptSource): ImportedTranscriptReceipt | null {
    const row = this.store.catalog
      .prepare(
        "SELECT generation FROM imported_transcripts WHERE source=? AND state='complete' ORDER BY rowid DESC LIMIT 1",
      )
      .get(sourceKey(source)) as { generation: string } | undefined;
    return row ? this.get(source, row.generation) : null;
  }

  /** The owning asset has been fenced; reclaim every imported generation and its raw file tree. */
  async purge(assetId: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const row = this.store.catalog
        .prepare(
          "SELECT generation FROM imported_transcripts WHERE json_extract(source,'$.assetId')=? ORDER BY rowid LIMIT 1",
        )
        .get(assetId) as { generation: string } | undefined;
      if (!row) break;
      await rm(join(this.home, "transcripts", "imported", assetId, row.generation), {
        recursive: true,
        force: true,
      });
      this.store.transaction(() => {
        this.store.catalog
          .prepare("DELETE FROM imported_transcript_cues WHERE generation=?")
          .run(row.generation);
        this.store.catalog
          .prepare("DELETE FROM imported_transcripts WHERE generation=?")
          .run(row.generation);
      });
    }
    await rm(join(this.home, "transcripts", "imported", assetId), { recursive: true, force: true });
  }

  portableGenerations(assetId: string): PortableImportedTranscript[] {
    const rows = this.store.catalog
      .prepare("SELECT * FROM imported_transcripts WHERE state='complete' ORDER BY rowid")
      .all() as StoredImport[];
    return rows
      .filter((row) => (JSON.parse(row.source) as ImportedTranscriptSource).assetId === assetId)
      .map((row) => {
        const receipt = this.get(
          JSON.parse(row.source) as ImportedTranscriptSource,
          row.generation,
        );
        return {
          generation: receipt.generation,
          source: receipt.source,
          origin: receipt.origin,
          timingPolicy: receipt.timingPolicy,
          ...(receipt.alignment === undefined ? {} : { alignment: receipt.alignment }),
          cues: receipt.cues,
        };
      });
  }

  portableFile(
    value: Pick<PortableImportedTranscript, "source" | "generation" | "origin">,
  ): IdentifiedFile {
    const path = join(
      this.home,
      "transcripts",
      "imported",
      value.source.assetId,
      value.generation,
      `source.${value.origin.format}`,
    );
    const stats = statSync(path, { bigint: true });
    return { path, bytes: Number(stats.size), identity: fileIdentity(stats) };
  }

  portableReceipt(value: PortableImportedTranscript): ImportedTranscriptReceipt {
    return this.get(value.source, value.generation);
  }

  /** Copy an imported generation into its canonical location and verify its receipt. */
  async adoptPortable(
    value: PortableImportedTranscript,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.validateSource(value.source);
    const existing = this.store.catalog
      .prepare("SELECT * FROM imported_transcripts WHERE generation=?")
      .get(value.generation) as StoredImport | undefined;
    if (existing) {
      if (existing.source !== sourceKey(value.source))
        throw new CatalogError(
          "CONFLICT",
          "Imported transcript generation belongs to another source",
        );
      return;
    }
    const parsed = await readImportedTranscript(
      createReadStream(sourcePath, { highWaterMark: 65_536, signal }),
      { format: value.origin.format },
    );
    if (
      parsed.raw.sha256 !== value.origin.raw.sha256 ||
      parsed.raw.bytes !== value.origin.raw.bytes
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Imported transcript source bytes differ from its receipt",
      );
    if (parsed.cues.length !== value.cues.length)
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Imported transcript cue count differs from its receipt",
      );
    if (JSON.stringify(parsed.cues) !== JSON.stringify(value.cues))
      throw new CatalogError("INVALID_PACKAGE", "Imported transcript cues differ from its receipt");
    const output = join(
      this.home,
      "transcripts",
      "imported",
      value.source.assetId,
      value.generation,
      `source.${value.origin.format}`,
    );
    await mkdir(
      join(this.home, "transcripts", "imported", value.source.assetId, value.generation),
      { recursive: true },
    );
    await copyFile(sourcePath, output);
    this.store.transaction(() => {
      this.store.catalog
        .prepare(
          "INSERT INTO imported_transcripts(requestId,source,generation,format,parser,timingBasis,timingPolicy,alignmentModelId,alignmentChannel,rawSha256,rawBytes,metadata,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          `package:${value.generation}`,
          sourceKey(value.source),
          value.generation,
          value.origin.format,
          JSON.stringify(value.origin.parser),
          value.origin.timingBasis,
          value.timingPolicy,
          value.alignment?.modelId ?? null,
          value.alignment?.channel ?? null,
          value.origin.raw.sha256,
          value.origin.raw.bytes,
          JSON.stringify(value.origin.metadata),
          "complete",
        );
      const insert = this.store.catalog.prepare(
        "INSERT INTO imported_transcript_cues(generation,ordinal,id,startUs,endUs,text,speaker,settings,words) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const cue of value.cues)
        insert.run(
          value.generation,
          cue.ordinal,
          cue.id,
          cue.source.startUs,
          cue.source.endUs,
          cue.text,
          cue.speaker ?? null,
          cue.settings ?? null,
          JSON.stringify(cue.words),
        );
    });
  }
}
