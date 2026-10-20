import { createHash } from "node:crypto";
import { z } from "zod";
import { CatalogError } from "./catalog.js";

/** Limits apply to observed bytes and names, independently of ZIP header declarations. */
export const archiveLimits = {
  pathBytes: 512,
  componentBytes: 128,
  depth: 16,
  revisionBytes: 1024 ** 2,
  history: 1_000,
};
export type ArchiveLimits = typeof archiveLimits;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const localIdentity = z.strictObject({
  device: z.string().regex(/^\d{1,20}$/),
  inode: z.string().regex(/^\d{1,20}$/),
  modifiedNs: z.string().regex(/^\d{1,20}$/),
  changedNs: z.string().regex(/^\d{1,20}$/),
});
const memberSchema = z.strictObject({
  path: z.string(),
  directory: z.boolean(),
  bytes: integer,
  sha256: digest,
  identity: localIdentity.nullable(),
});
const receiptSchema = z.strictObject({
  manifest: z.unknown(),
  manifestIdentity: z.strictObject({ bytes: integer, sha256: digest }),
  revisions: z.record(z.string(), z.string()),
  members: z.array(memberSchema),
  archiveSha256: digest,
  expandedBytes: integer,
  copiedBytes: integer,
  initialReadBytes: integer,
  peakResidentBytes: integer,
  parser: z.string(),
});

export function validateArchiveLimits(limits: ArchiveLimits): void {
  for (const key of Object.keys(archiveLimits) as (keyof ArchiveLimits)[])
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > archiveLimits[key])
      throw new RangeError(
        `Archive ${key} must be a positive integer within the supported maximum`,
      );
}

export type ArchiveManifest = {
  inventory: readonly { path: string; bytes: number; sha256: string }[];
};
export type ArchiveManifestValidator<T extends ArchiveManifest> = (
  body: unknown,
  limits: ArchiveLimits,
) => T;

/** The native owner supplies fully enumerated, hashed bytes; this owner checks their package meaning. */
export function verifyArchiveReceipt<T extends ArchiveManifest>(
  value: unknown,
  limits: ArchiveLimits,
  validate: ArchiveManifestValidator<T>,
) {
  validateArchiveLimits(limits);
  const parsed = receiptSchema.safeParse(value);
  const invalid = (message: string): never => {
    throw new CatalogError("INVALID_PACKAGE", message);
  };
  if (!parsed.success) return invalid("Invalid native archive receipt");
  const receipt = parsed.data;
  if (receipt.copiedBytes < 1) return invalid("Archive receipt exceeds its limits");
  const manifest = validate(receipt.manifest, limits);
  const expected = new Map(manifest.inventory.map((entry) => [entry.path, entry]));
  const actual = new Map<string, z.infer<typeof memberSchema>>();
  const folded = new Map<string, string>();
  let total = 0;
  for (const entry of receipt.members) {
    const parts = entry.path.split("/");
    if (
      !/^[A-Za-z0-9_./-]+$/.test(entry.path) ||
      parts.some((p) => !p || p === "." || p === "..") ||
      parts.some((p) => p.length > limits.componentBytes) ||
      parts.length > limits.depth ||
      entry.path.length > limits.pathBytes ||
      folded.has(entry.path.toLowerCase()) ||
      (entry.directory && entry.bytes !== 0) ||
      (entry.directory ? entry.identity !== null : entry.identity === null)
    )
      return invalid("Invalid or duplicate extracted member");
    folded.set(entry.path.toLowerCase(), entry.path);
    actual.set(entry.path, entry);
    total += entry.bytes;
    if (!Number.isSafeInteger(total)) return invalid("Archive byte total is unsafe");
  }
  if (total !== receipt.expandedBytes) return invalid("Archive byte total mismatch");
  const checkText = (path: string, text: string) => {
    const entry = actual.get(path);
    if (
      !entry ||
      entry.directory ||
      entry.bytes !== Buffer.byteLength(text) ||
      entry.sha256 !== createHash("sha256").update(text).digest("hex")
    )
      return invalid("Archive metadata bytes do not match their inventory");
  };
  const manifestEntry = actual.get("manifest.json");
  if (
    !manifestEntry ||
    manifestEntry.directory ||
    manifestEntry.bytes !== receipt.manifestIdentity.bytes ||
    manifestEntry.sha256 !== receipt.manifestIdentity.sha256
  )
    return invalid("Archive manifest identity differs from its parsed member");
  for (const [path, text] of Object.entries(receipt.revisions)) checkText(path, text);
  const requiredDirectories = new Set<string>();
  for (const entry of manifest.inventory) {
    const member = actual.get(entry.path);
    if (
      !member ||
      member.directory ||
      member.bytes !== entry.bytes ||
      member.sha256 !== entry.sha256
    )
      return invalid("Missing member or inventory hash/size mismatch");
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) requiredDirectories.add(parts.slice(0, i).join("/"));
  }
  for (const member of actual.values()) {
    if (
      member.directory
        ? !requiredDirectories.has(member.path)
        : member.path !== "manifest.json" && !expected.has(member.path)
    )
      return invalid("Unlisted archive member");
    const parts = member.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = actual.get(folded.get(parts.slice(0, i).join("/").toLowerCase()) ?? "");
      if (ancestor && (!ancestor.directory || ancestor.path !== parts.slice(0, i).join("/")))
        return invalid("Archive file/directory collision");
    }
  }
  return {
    manifest,
    files: receipt.members
      .filter((entry) => !entry.directory)
      .map((entry) => ({
        path: `content/${entry.path}`,
        bytes: entry.bytes,
        identity: entry.identity!,
      })),
    revisionContents: receipt.revisions,
    archiveSha256: receipt.archiveSha256,
    copiedBytes: receipt.copiedBytes,
    expandedBytes: total,
    memberCount: actual.size,
    parser: receipt.parser,
    initialReadBytes: receipt.initialReadBytes,
    peakResidentBytes: receipt.peakResidentBytes,
  };
}

const writeReceiptSchema = z.strictObject({
  path: z.literal("payload.zip"),
  bytes: integer.positive(),
  sha256: digest,
  identity: localIdentity,
  expandedBytes: integer,
  entries: integer.positive(),
  peakResidentBytes: integer,
  writer: z.string().min(1),
});
/** Byte assembly only; complete package semantics belong to the manifest/payload owner. */
export function verifyArchiveWriteReceipt(value: unknown, limits: ArchiveLimits = archiveLimits) {
  validateArchiveLimits(limits);
  const parsed = writeReceiptSchema.safeParse(value);
  if (!parsed.success)
    throw new CatalogError("INVALID_NATIVE_RESPONSE", "Invalid ZIP write receipt");
  return parsed.data;
}
