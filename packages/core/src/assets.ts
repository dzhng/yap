import {
  lutMetadataSchema,
  signedTimeValueSchema,
  timeValueSchema,
  fromTime,
  compare,
  type SelectionRange,
  omit,
} from "@yap/composition";
import {
  assetOriginSchema,
  hdrConversionEvidenceMatchesMetadata,
  type AssetProvenance,
} from "./asset-origins.js";
export type { AssetProvenance } from "./asset-origins.js";
import { isDeepStrictEqual } from "node:util";
import { ResourceReferences, resourceKinds, type ResourceOwner } from "./references.js";
import type { Asset as CompositionAsset } from "@yap/composition";
import { randomUUID } from "node:crypto";
import { constants, unlinkSync } from "node:fs";
import { mkdir, open, link, unlink, opendir, rm, lstat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { Catalog, CatalogError } from "./catalog.js";
import { pageCursor } from "./page-cursor.js";
import {
  copyImportedFile,
  fileIdentity,
  hashFile,
  type IdentifiedFile,
  type FileIdentity,
} from "./files.js";

const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positive = integer.positive();
const segment = z.object({
  startUs: signedTimeValueSchema,
  endUs: signedTimeValueSchema,
  empty: z.boolean(),
  mediaStartUs: signedTimeValueSchema.optional(),
  mediaDurationUs: timeValueSchema.optional(),
});
const stream = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "video", "audio", "unsupported"]),
  codec: z.string(),
  decodable: z.boolean(),
  startUs: timeValueSchema.optional(),
  endUs: timeValueSchema.optional(),
  // Up to 100,000 occupied runs plus inter-run, leading and trailing empty segments.
  segments: z
    .array(segment)
    .max(2 * 100_000 + 1)
    .optional(),
  width: positive.optional(),
  height: positive.optional(),
  orientedWidth: z.number().finite().positive().optional(),
  orientedHeight: z.number().finite().positive().optional(),
  orientedPixelBounds: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .optional(),
  transform: z.array(z.number().finite()).length(6).optional(),
  orientation: integer.min(1).max(8).optional(),
  hasAlpha: z.boolean().optional(),
  sampleRate: z.number().positive().finite().optional(),
  channels: positive.optional(),
  channelLayoutTag: integer.nonnegative().optional(),
  colorPrimaries: z.string().optional(),
  transferFunction: z.string().optional(),
  ycbcrMatrix: z.string().optional(),
  samples: z
    .object({
      count: integer.nonnegative(),
      firstPtsUs: integer,
      lastPtsUs: integer,
      minDurationUs: integer.nonnegative(),
      maxDurationUs: integer.nonnegative(),
    })
    .optional(),
});
export const mediaProbeSchema = z
  .object({
    originUs: signedTimeValueSchema,
    streams: z.array(stream).max(256),
    lut: lutMetadataSchema.optional(),
    fontFaces: z
      .array(
        z
          .object({
            postScriptName: z.string().min(1),
            familyName: z.string().min(1),
            styleName: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256)
      .optional(),
  })
  .refine(
    ({ originUs, streams, fontFaces, lut }) =>
      lut
        ? originUs === 0 && streams.length === 0 && fontFaces === undefined
        : fontFaces
          ? originUs === 0 &&
            streams.length === 0 &&
            new Set(fontFaces.map((face) => face.postScriptName)).size === fontFaces.length
          : streams.length > 0,
    "Expected playable streams, unambiguous non-timed font faces or a non-timed LUT",
  )
  .refine(
    ({ streams }) => new Set(streams.map((stream) => stream.id)).size === streams.length,
    "Expected unique stream identities",
  );
export type MediaProbe = z.infer<typeof mediaProbeSchema>;
export type Asset = MediaProbe & { id: string; bytes: number; createdAt: string; fileName: string };
export const portableAssetSchema = z
  .strictObject({
    asset: mediaProbeSchema
      .safeExtend({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: integer.nonnegative(),
        createdAt: z.string().min(1),
        fileName: z.string().regex(/^[a-f0-9]{64}(?:\.[a-z0-9]{1,12})?$/),
      })
      .strict(),
    origins: z.array(assetOriginSchema).max(1000),
    dependencies: z
      .array(z.strictObject({ kind: z.enum(resourceKinds), id: z.string().min(1).max(2048) }))
      .max(25_000),
  })
  .refine(
    ({ asset, origins, dependencies }) =>
      origins.every(
        (origin) =>
          origin.kind !== "hdr-conversion" ||
          (origin.source.assetId !== asset.id &&
            dependencies.some(
              (dependency) =>
                dependency.kind === "asset" && dependency.id === origin.source.assetId,
            ) &&
            asset.streams.length === (origin.output.audio ? 2 : 1) &&
            hdrConversionEvidenceMatchesMetadata(origin.output, asset)),
      ),
    "HDR conversion requires its immutable original asset dependency",
  );
export type PortableAsset = z.infer<typeof portableAssetSchema>;
export type AssetSummary = Pick<Asset, "id" | "bytes" | "createdAt" | "fileName"> & {
  mediaKinds: MediaProbe["streams"][number]["kind"][];
  streamCount: number;
  fontFaceCount: number;
};
export type ImportIntent = {
  importId: string;
  requestId: string;
  path: string;
  assetId: string | null;
  source: IdentifiedFile;
};
export type PreparedImport = Pick<ImportIntent, "requestId" | "path" | "source">;
export type AssetProbe = (path: string, signal: AbortSignal) => Promise<unknown>;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Immutable assets and references share the project catalog; only ready assets are visible. */
export class AssetStore {
  private readonly directory: string;
  private readonly staging: string;
  private readonly dependencies: ResourceReferences;
  private readonly publications = new Map<string, Promise<void>>();
  constructor(
    private readonly store: Catalog,
    private readonly libraryDirectory: string,
  ) {
    this.dependencies = new ResourceReferences(store);
    this.directory = join(libraryDirectory, "assets");
    this.staging = join(libraryDirectory, "staging", "assets");
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS asset_imports (
        importId TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, path TEXT NOT NULL, assetId TEXT, source TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS asset_import_source_identity ON asset_imports(
        json_extract(source,'$.identity.device'),json_extract(source,'$.identity.inode'));
      CREATE TABLE IF NOT EXISTS assets (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        metadata TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS asset_segments (
        assetId TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        streamId TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), value TEXT NOT NULL,
        PRIMARY KEY(assetId,streamId,ordinal)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS asset_origins (
        assetId TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY(assetId,provenance)
      ) STRICT;
    `);
  }

  /** Startup under the service lifetime lock, before any import can run. */
  async recover(): Promise<void> {
    for (const directory of [
      this.libraryDirectory,
      this.directory,
      join(this.libraryDirectory, "staging"),
      this.staging,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new CatalogError(
          "INVALID_PATH",
          "Managed asset directories must be private directories owned by this user",
        );
    }
    for await (const file of await opendir(this.staging))
      await rm(join(this.staging, file.name), { recursive: true, force: true });
    for await (const entry of await opendir(this.directory)) {
      const file = entry.name;
      const row = this.store.catalog
        .prepare("SELECT metadata FROM assets WHERE id=?")
        .get(file.split(".")[0]!);
      if (!row || (JSON.parse(row.metadata as string) as Asset).fileName !== file)
        await rm(join(this.directory, file), { recursive: true, force: true });
    }
  }

  async prepareImport(requestId: string, path: string): Promise<PreparedImport> {
    if (!requestId || !isAbsolute(path))
      throw new CatalogError(
        "INVALID_PARAMS",
        "Import requires a request ID and absolute local path",
      );
    const previous = this.importReplay(requestId, path);
    if (previous) return { requestId, path, source: previous.source };
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch((error) => {
      throw new CatalogError(
        absent(error) ? "NOT_FOUND" : "INVALID_PATH",
        "Cannot open import source",
      );
    });
    let source: IdentifiedFile;
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new CatalogError(
          "UNSUPPORTED_MEDIA",
          "Import source must be a regular file of supported size",
        );
      source = { path, bytes: Number(stat.size), identity: fileIdentity(stat) };
    } finally {
      await file.close();
    }
    return { requestId, path, source };
  }
  /** Resolve the receipt inside the same transaction that admits its preparation job. */
  admitImport(prepared: PreparedImport): ImportIntent {
    const { requestId, path, source } = prepared;
    const existing = this.importReplay(requestId, path);
    if (existing) return existing;
    const importId = randomUUID();
    this.store.catalog
      .prepare("INSERT INTO asset_imports VALUES(?,?,?,NULL,?)")
      .run(importId, requestId, path, JSON.stringify(source));
    return this.intent(importId);
  }
  private importReplay(requestId: string, path: string): ImportIntent | null {
    const row = this.store.catalog
      .prepare("SELECT importId,path FROM asset_imports WHERE requestId=?")
      .get(requestId);
    if (!row) return null;
    if (row.path !== path)
      throw new CatalogError("REQUEST_CONFLICT", "Import request ID already names another path");
    const intent = this.intent(row.importId as string);
    if (intent.assetId !== null && !this.has(intent.assetId))
      throw new CatalogError("ASSET_DELETED", "The imported asset has been deleted", {
        assetId: intent.assetId,
      });
    return intent;
  }
  intent(importId: string): ImportIntent {
    const row = this.store.catalog
      .prepare("SELECT * FROM asset_imports WHERE importId=?")
      .get(importId);
    if (!row) throw new CatalogError("NOT_FOUND", "Import intent does not exist", { importId });
    return {
      importId: row.importId as string,
      requestId: row.requestId as string,
      path: row.path as string,
      assetId: row.assetId as string | null,
      source: JSON.parse(row.source as string) as IdentifiedFile,
    };
  }
  async executeImport(
    importId: string,
    probe: AssetProbe,
    signal: AbortSignal,
    owner?: ResourceOwner,
  ): Promise<Asset> {
    const intent = this.intent(importId);
    if (intent.assetId) {
      if (!this.has(intent.assetId))
        throw new CatalogError("ASSET_DELETED", "The imported asset has been deleted", {
          assetId: intent.assetId,
        });
      const asset = this.get(intent.assetId);
      if (owner) this.retain(owner, [asset.id]);
      return asset;
    }
    return this.import(
      intent.path,
      { kind: "import", source: intent.path },
      probe,
      signal,
      (asset) => {
        this.store.catalog
          .prepare("UPDATE asset_imports SET assetId=? WHERE importId=?")
          .run(asset.id, importId);
        if (owner) this.retain(owner, [asset.id]);
      },
      intent.source,
    );
  }

  /** Imported originals remain protected even through another pathname or later byte changes. */
  isImportedSource(identity: Pick<FileIdentity, "device" | "inode">): boolean {
    return Boolean(
      this.store.catalog
        .prepare(`SELECT 1 FROM asset_imports INDEXED BY asset_import_source_identity
      WHERE json_extract(source,'$.identity.device')=? AND json_extract(source,'$.identity.inode')=? LIMIT 1`)
        .get(identity.device, identity.inode),
    );
  }

  /** Presence checks do not reconstruct physical segment rows. */
  has(id: string): boolean {
    return Boolean(this.store.catalog.prepare("SELECT 1 FROM assets WHERE id=?").get(id));
  }
  private header(id: string): Asset {
    const row = this.store.catalog.prepare("SELECT metadata FROM assets WHERE id=?").get(id);
    if (!row) throw new CatalogError("NOT_FOUND", "Asset does not exist", { assetId: id });
    return JSON.parse(row.metadata as string) as Asset;
  }
  /** Complete metadata is reconstructed only for callers that need every physical row. */
  get(id: string): Asset {
    const asset = this.header(id);
    if (!asset.streams.some((stream) => stream.segments !== undefined)) return asset;
    const rows = this.store.catalog
      .prepare(
        "SELECT streamId,value FROM asset_segments WHERE assetId=? ORDER BY streamId,ordinal",
      )
      .all(id);
    const segments = new Map<string, string[]>();
    for (const row of rows) {
      const streamId = row.streamId as string;
      const values = segments.get(streamId) ?? [];
      values.push(row.value as string);
      segments.set(streamId, values);
    }
    for (const stream of asset.streams)
      if (stream.segments !== undefined)
        stream.segments = (segments.get(stream.id) ?? []).map((value) => JSON.parse(value));
    return asset;
  }
  /** Called inside the existing import/adoption transaction; rows have one authoritative owner. */
  private insert(asset: Asset): void {
    const header = {
      ...asset,
      streams: asset.streams.map(({ segments, ...stream }) => ({
        ...stream,
        ...(segments === undefined ? {} : { segments: [] }),
      })),
    };
    const inserted = this.store.catalog
      .prepare("INSERT OR IGNORE INTO assets(id,metadata) VALUES(?,?)")
      .run(asset.id, JSON.stringify(header));
    if (!inserted.changes) return;
    const row = this.store.catalog.prepare(
      "INSERT INTO asset_segments(assetId,streamId,ordinal,value) VALUES(?,?,?,?)",
    );
    for (const stream of asset.streams)
      for (const [ordinal, segment] of (stream.segments ?? []).entries())
        row.run(asset.id, stream.id, ordinal, JSON.stringify(segment));
  }
  /** Public discovery omits physical rows; immutable segment pages retain their full meaning. */
  describe(id: string): Omit<Asset, "streams"> & {
    streams: (Omit<Asset["streams"][number], "segments"> & { segmentCount: number })[];
  } {
    const asset = this.header(id);
    const count = this.store.catalog.prepare(
      "SELECT coalesce(max(ordinal)+1,0) AS count FROM asset_segments WHERE assetId=? AND streamId=?",
    );
    return {
      ...asset,
      streams: asset.streams.map(({ segments: _segments, ...stream }) => ({
        ...stream,
        segmentCount: count.get(id, stream.id)!.count as number,
      })),
    };
  }
  segments(
    id: string,
    streamId: string,
    input: {
      cursor?: string;
      limit?: number;
    } = {},
  ): {
    assetId: string;
    streamId: string;
    segments: (z.infer<typeof segment> & { ordinal: number })[];
    nextCursor: string | null;
  } {
    const limit = input.limit ?? 100,
      position =
        input.cursor === undefined
          ? undefined
          : pageCursor.decode("asset.segments", input.cursor, { assetId: id, streamId }),
      decoded = position as { ordinal?: unknown } | undefined,
      after = (decoded?.ordinal ?? -1) as number;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(after) ||
      after < -1
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid asset segment cursor or page bounds");
    const asset = this.header(id);
    if (!asset.streams.some((stream) => stream.id === streamId))
      throw new CatalogError("NOT_FOUND", "Stream does not exist", { assetId: id, streamId });
    const count = this.store.catalog
      .prepare(
        "SELECT coalesce(max(ordinal)+1,0) AS count FROM asset_segments WHERE assetId=? AND streamId=?",
      )
      .get(id, streamId)!.count as number;
    if (after >= count)
      throw new CatalogError("INVALID_PARAMS", "Asset segment cursor exceeds the stream");
    const rows = this.store.catalog
      .prepare(
        "SELECT ordinal,value FROM asset_segments WHERE assetId=? AND streamId=? AND ordinal>? ORDER BY ordinal LIMIT ?",
      )
      .all(id, streamId, after, limit + 1);
    return {
      assetId: id,
      streamId,
      segments: rows
        .slice(0, limit)
        .map((row) => ({ ordinal: row.ordinal as number, ...JSON.parse(row.value as string) })),
      nextCursor:
        rows.length > limit
          ? pageCursor.encode(
              "asset.segments",
              { ordinal: rows[limit - 1]!.ordinal as number },
              { assetId: id, streamId },
            )
          : null,
    };
  }
  path(id: string): string {
    return join(this.directory, this.header(id).fileName);
  }
  /** Assets have no tombstone column in the current catalog; an admitted row is listable. */
  listable(id: string): boolean {
    return Boolean(this.store.catalog.prepare("SELECT 1 FROM assets WHERE id=?").get(id));
  }
  list(input: { cursor?: string; limit?: number } = {}): {
    assets: AssetSummary[];
    nextCursor: string | null;
  } {
    const limit = input.limit ?? 100,
      position =
        input.cursor === undefined ? undefined : pageCursor.decode("asset.list", input.cursor, {}),
      after = position === undefined ? undefined : (position as { sequence?: unknown }).sequence;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (after !== undefined && (!Number.isSafeInteger(after) || (after as number) < 0))
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid asset page bounds");
    const rows = this.store.catalog
      .prepare(`SELECT sequence,id,
        json_extract(metadata,'$.bytes') AS bytes,
        json_extract(metadata,'$.createdAt') AS createdAt,
        json_extract(metadata,'$.fileName') AS fileName,
        json_array_length(metadata,'$.streams') AS streamCount,
        coalesce(json_array_length(metadata,'$.fontFaces'),0) AS fontFaceCount,
        (SELECT json_group_array(kind) FROM (
          SELECT DISTINCT json_extract(value,'$.kind') AS kind
          FROM json_each(assets.metadata,'$.streams') ORDER BY kind
        )) AS mediaKinds
        FROM assets WHERE sequence < coalesce(?, 9223372036854775807) ORDER BY sequence DESC LIMIT ?`)
      .all((after as number | undefined) ?? null, limit + 1);
    return {
      assets: rows.slice(0, limit).map(
        (row) =>
          ({
            id: row.id as string,
            bytes: row.bytes as number,
            createdAt: row.createdAt as string,
            fileName: row.fileName as string,
            streamCount: row.streamCount as number,
            fontFaceCount: row.fontFaceCount as number,
            mediaKinds: JSON.parse(row.mediaKinds as string),
          }) as AssetSummary,
      ),
      nextCursor:
        rows.length > limit
          ? pageCursor.encode("asset.list", { sequence: rows[limit - 1]!.sequence as number }, {})
          : null,
    };
  }
  origins(
    id: string,
    input: { cursor?: string; limit?: number } = {},
  ): {
    origins: AssetProvenance[];
    nextCursor: string | null;
  } {
    this.header(id);
    const limit = input.limit ?? 100,
      position =
        input.cursor === undefined
          ? undefined
          : pageCursor.decode("asset.origins", input.cursor, { assetId: id }),
      decodedOrigin = position as { provenance?: unknown } | undefined,
      afterProvenance = decodedOrigin?.provenance;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (afterProvenance !== undefined && typeof afterProvenance !== "string")
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid provenance page bounds");
    const rows = this.store.catalog
      .prepare(
        "SELECT provenance FROM asset_origins WHERE assetId=? AND provenance>? ORDER BY provenance LIMIT ?",
      )
      .all(id, afterProvenance ?? "", limit + 1);
    return {
      origins: rows
        .slice(0, limit)
        .map((row) => JSON.parse(row.provenance as string) as AssetProvenance),
      nextCursor:
        rows.length > limit
          ? pageCursor.encode(
              "asset.origins",
              { provenance: rows[limit - 1]!.provenance as string },
              { assetId: id },
            )
          : null,
    };
  }
  /** Call inside the revision/job transaction when references must commit with that owner. */
  retain(owner: ResourceOwner, ids: readonly string[]): void {
    for (const id of ids) this.header(id);
    this.dependencies.retain("asset", owner, ids);
  }
  release(owner: ResourceOwner): void {
    this.dependencies.release("asset", owner);
  }
  references(id: string): ResourceOwner[] {
    this.header(id);
    return this.dependencies.owners("asset", id);
  }

  portable(id: string): PortableAsset {
    const origins = this.origins(id, { limit: 1000 });
    if (origins.nextCursor)
      throw new CatalogError("LIMIT_EXCEEDED", "Asset provenance exceeds package limit");
    const dependencies = this.dependencies.dependencies({ kind: "asset", id });
    return { asset: this.get(id), origins: origins.origins, dependencies };
  }

  /** Copy and hash before the caller's shared publication transaction. Unpublished links recover as orphans. */
  async stagePortable(
    value: unknown,
    path: string,
    signal: AbortSignal,
    expected?: IdentifiedFile & { sha256?: string },
  ) {
    const parsed = portableAssetSchema.safeParse(value);
    if (!parsed.success)
      throw new CatalogError("INVALID_PACKAGE", "Invalid portable asset metadata");
    const { asset, origins, dependencies } = parsed.data;
    if (!asset.fileName.startsWith(asset.id))
      throw new CatalogError("INVALID_PACKAGE", "Asset member identity differs from its hash");
    return this.stageFile(
      path,
      extname(asset.fileName),
      signal,
      async (copied) => {
        if (copied.sha256 !== asset.id || copied.bytes !== asset.bytes)
          throw new CatalogError(
            "INVALID_PACKAGE",
            "Asset byte hash or size does not match its identity",
          );
        return { asset, origins, dependencies };
      },
      expected,
    );
  }

  private async stageFile(
    path: string,
    suffix: string,
    signal: AbortSignal,
    describe: (
      copied: { sha256: string; bytes: number },
      staging: string,
    ) => Promise<PortableAsset>,
    expected?: IdentifiedFile & { sha256?: string },
  ) {
    const staging = join(this.staging, randomUUID() + suffix);
    let asset: Asset | undefined;
    let retainedName: string | undefined;
    const removeStaging = async () => {
      await unlink(staging).catch((error) => {
        if (!absent(error)) throw error;
      });
    };
    const cleanup = async () => {
      await removeStaging();
      if (!asset || !retainedName) return;
      const id = asset.id,
        fileName = retainedName;
      const row = this.store.catalog.prepare("SELECT metadata FROM assets WHERE id=?").get(id);
      if (row && (JSON.parse(row.metadata as string) as Asset).fileName !== fileName)
        await unlink(join(this.directory, fileName)).catch((error) => {
          if (!absent(error)) throw error;
        });
    };
    const close = () => (asset ? this.publishFile(asset.id, cleanup) : cleanup());
    try {
      const copied = await copyImportedFile(path, staging, signal, expected);
      const described = await describe(copied, staging);
      asset = described.asset;
      const { origins, dependencies } = described;
      const candidate = asset;
      retainedName = asset.fileName;
      const stored = this.store.catalog
        .prepare("SELECT metadata FROM assets WHERE id=?")
        .get(asset.id);
      if (stored) retainedName = (JSON.parse(stored.metadata as string) as Asset).fileName;
      const publishedName = retainedName;
      await this.publishFile(candidate.id, async () => {
        try {
          signal.throwIfAborted();
          if (this.dependencies.isTombstoned("asset", candidate.id))
            throw new CatalogError("DELETE_IN_PROGRESS", "asset deletion is in progress", {
              assetId: candidate.id,
            });
          await link(staging, join(this.directory, publishedName)).catch(async (error) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = await open(
              join(this.directory, publishedName),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const checked = await hashFile(existing, candidate.bytes, signal);
              if (checked.sha256 !== candidate.id)
                throw new CatalogError(
                  "ASSET_CONFLICT",
                  "Existing asset file hash conflicts with immutable identity",
                );
            } finally {
              await existing.close();
            }
          });
          const directory = await open(this.directory, constants.O_RDONLY);
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await removeStaging();
        }
      });
      signal.throwIfAborted();
      return {
        asset: candidate,
        path: join(this.directory, publishedName),
        close,
        publish: ({ pinnedFile = true }: { pinnedFile?: boolean } = {}) => {
          signal.throwIfAborted();
          const prior = this.store.catalog
            .prepare("SELECT metadata FROM assets WHERE id=?")
            .get(candidate.id);
          if (this.dependencies.isTombstoned("asset", candidate.id)) {
            if (!prior)
              try {
                unlinkSync(join(this.directory, publishedName));
              } catch (error) {
                if (!absent(error)) throw error;
              }
            throw new CatalogError("DELETE_IN_PROGRESS", "asset deletion is in progress", {
              assetId: candidate.id,
            });
          }
          if (prior) {
            const existing = this.get(candidate.id);
            if (pinnedFile && existing.fileName !== publishedName)
              throw new CatalogError(
                "STORAGE_BUSY",
                "Asset publication changed during staging; retry publication",
                {},
              );
            if (
              existing.bytes !== candidate.bytes ||
              !isDeepStrictEqual(
                mediaProbeSchema.parse(existing),
                mediaProbeSchema.parse(candidate),
              )
            )
              throw new CatalogError(
                "ASSET_CONFLICT",
                "Existing asset metadata conflicts with immutable identity",
              );
          } else this.insert({ ...candidate, fileName: publishedName });
          for (const origin of origins)
            this.store.catalog
              .prepare("INSERT OR IGNORE INTO asset_origins VALUES(?,?)")
              .run(candidate.id, JSON.stringify(origin));
          // The caller validates dependency closure before its publication transaction.
          for (const kind of resourceKinds)
            this.dependencies.retain(
              kind,
              { kind: "asset", id: candidate.id },
              dependencies
                .filter((dependency) => dependency.kind === kind)
                .map((dependency) => dependency.id),
            );
          return this.get(candidate.id);
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  /** Link removal changes ctime, so it cannot overlap verification of the same immutable file. */
  private async publishFile<T>(id: string, run: () => Promise<T>): Promise<T> {
    const result = (this.publications.get(id) ?? Promise.resolve()).then(run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.publications.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.publications.get(id) === settled) this.publications.delete(id);
    }
  }
  /** Internal deletion step: remove an asset's managed file under the publication lock. */
  async unlinkFile(id: string): Promise<void> {
    await this.publishFile(id, async () => {
      const asset = this.get(id);
      await unlink(join(this.directory, asset.fileName)).catch((error) => {
        if (!absent(error)) throw error;
      });
    });
  }
  /** Stage immutable bytes without publishing outside the caller's attempt fence. */
  async stage(
    path: string,
    provenance: AssetProvenance,
    probe: AssetProbe,
    signal: AbortSignal = new AbortController().signal,
    expected?: IdentifiedFile & { sha256?: string },
  ) {
    if (!isAbsolute(path))
      throw new CatalogError("INVALID_PATH", "Asset import requires an absolute local path");
    signal.throwIfAborted();
    const extension = extname(path).toLowerCase();
    const suffix = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
    return this.stageFile(
      path,
      suffix,
      signal,
      async ({ sha256: id, bytes }, staging) => {
        if (this.has(id)) return { asset: this.get(id), origins: [provenance], dependencies: [] };
        const parsed = mediaProbeSchema.safeParse(await probe(staging, signal));
        if (!parsed.success)
          throw new CatalogError(
            "INVALID_NATIVE_RESPONSE",
            "Media probe returned invalid metadata",
          );
        const metadata = parsed.data;
        if (
          !metadata.lut &&
          !metadata.fontFaces &&
          !metadata.streams.some((stream) => stream.kind !== "unsupported" && stream.decodable)
        )
          throw new CatalogError(
            "UNSUPPORTED_MEDIA",
            `Media contains no decodable streams: ${metadata.streams.map((stream) => stream.codec).join(", ")}`,
            {
              streams: metadata.streams.map(({ id, kind, codec, decodable }) => ({
                id,
                kind,
                codec,
                decodable,
              })),
            },
          );
        for (const item of metadata.streams) {
          if (item.kind === "audio" || item.kind === "video") {
            if (
              item.startUs === undefined ||
              item.endUs === undefined ||
              compare(fromTime(item.endUs), fromTime(item.startUs)) <= 0 ||
              !item.segments?.length
            )
              throw new CatalogError(
                "UNSUPPORTED_MEDIA",
                "Timed stream has no occupied presentation interval",
                { streamId: item.id },
              );
          }
        }
        return {
          asset: {
            ...metadata,
            id,
            bytes,
            createdAt: new Date().toISOString(),
            fileName: id + suffix,
          },
          origins: [provenance],
          dependencies: [],
        };
      },
      expected,
    );
  }

  async import(
    path: string,
    provenance: AssetProvenance,
    probe: AssetProbe,
    signal: AbortSignal = new AbortController().signal,
    published?: (asset: Asset) => void,
    expected?: IdentifiedFile & { sha256?: string },
  ): Promise<Asset> {
    const staged = await this.stage(path, provenance, probe, signal, expected);
    try {
      return this.store.transaction(() => {
        // Imports return the stored asset; they never bind a receipt to the staged pathname.
        const asset = staged.publish({ pinnedFile: false });
        published?.(asset);
        return asset;
      });
    } finally {
      await staged.close();
    }
  }
}

/** Probe times already share the asset origin; preserve occupied gaps without zeroing each stream. */
export function compositionAsset(asset: Asset): CompositionAsset {
  return {
    id: asset.id,
    ...(asset.lut ? { lut: asset.lut } : {}),
    ...(asset.fontFaces ? { fontFaces: asset.fontFaces.map((face) => face.postScriptName) } : {}),
    streams: asset.streams.flatMap((stream): CompositionAsset["streams"] => {
      if (!stream.decodable || stream.kind === "unsupported") return [];
      if (stream.kind === "image")
        return [
          {
            id: stream.id,
            kind: "image",
            width: stream.orientedWidth!,
            height: stream.orientedHeight!,
          },
        ];
      const available: SelectionRange[] = [];
      for (const segment of [...stream.segments!]
        .filter((s) => !s.empty)
        .sort((a, b) => compare(fromTime(a.startUs), fromTime(b.startUs)))) {
        const startUs =
            compare(fromTime(stream.startUs!), fromTime(segment.startUs)) > 0
              ? stream.startUs!
              : segment.startUs,
          endUs =
            compare(fromTime(stream.endUs!), fromTime(segment.endUs)) < 0
              ? stream.endUs!
              : segment.endUs;
        if (compare(fromTime(startUs), fromTime(endUs)) >= 0) continue;
        const last = available.at(-1);
        if (last && compare(fromTime(startUs), fromTime(last.endUs)) <= 0) {
          if (compare(fromTime(endUs), fromTime(last.endUs)) > 0) last.endUs = endUs;
        } else available.push({ startUs, endUs });
      }
      return [
        {
          id: stream.id,
          ...(stream.kind === "video"
            ? {
                kind: "video" as const,
                width: stream.orientedWidth!,
                height: stream.orientedHeight!,
                ...(stream.orientedPixelBounds ? { pixelBounds: stream.orientedPixelBounds } : {}),
              }
            : {
                kind: "audio" as const,
                ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
                ...(stream.sampleRate !== undefined ? { sampleRate: stream.sampleRate } : {}),
              }),
          bounds: { startUs: stream.startUs!, endUs: stream.endUs! },
          available,
        },
      ];
    }),
  };
}
