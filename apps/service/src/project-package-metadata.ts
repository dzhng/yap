import { createHash } from "node:crypto";
import { JsonDocument } from "@yap/core/json-stream";
import { setImmediate } from "node:timers/promises";
import { CatalogError } from "@yap/core/catalog";
import { retainedFileRead, type FileAccess } from "@yap/core/files";
import { archiveLimits } from "@yap/core/package-archive";
import {
  resolveProjectPackage,
  type ProjectJsonMember,
  type ProjectPackageManifest,
} from "@yap/core/project-package";

/** Only admitted extraction descriptors can hydrate metadata before project readiness. */
export async function resolveProjectPackageMetadata(
  input: {
    manifest: ProjectPackageManifest;
    revisions: ReadonlyMap<string, string>;
    files: FileAccess;
  },
  signal?: AbortSignal,
) {
  const metadata = new Map<string, ProjectJsonMember>(),
    revisions = new Map<string, string>();
  const inventory = new Map(input.manifest.inventory.map((entry) => [entry.path, entry]));
  const members = [
    ...input.manifest.revisions.map((path) => ({ ref: inventory.get(path)!, revision: true })),
    ...input.manifest.resources.map((resource) => ({ ref: resource.metadata, revision: false })),
  ];
  for (const { ref, revision } of members) {
    signal?.throwIfAborted();
    const reader = retainedFileRead(input.files.open(ref.path), ref.bytes);
    try {
      if (revision && ref.bytes > archiveLimits.revisionBytes)
        throw new CatalogError("LIMIT_EXCEEDED", "Authored revision exceeds its member budget");
      const buffer = Buffer.alloc(65_536);
      const document = new JsonDocument();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const hash = createHash("sha256");
      let position = 0,
        text = "";
      while (position < ref.bytes) {
        signal?.throwIfAborted();
        const count = reader.read(
          buffer.subarray(0, Math.min(buffer.length, ref.bytes - position)),
          position,
        );
        if (count <= 0)
          throw new CatalogError("INVALID_PACKAGE", "Project JSON member is truncated");
        const bytes = buffer.subarray(0, count);
        hash.update(bytes);
        if (revision) text += decoder.decode(bytes, { stream: true });
        else document.write(bytes);
        position += count;
        await setImmediate();
      }
      signal?.throwIfAborted();
      if (revision) revisions.set(ref.path, text + decoder.decode());
      else
        metadata.set(ref.path, {
          value: document.finish(),
          bytes: position,
          sha256: hash.digest("hex"),
        });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        throw new CatalogError("INVALID_PACKAGE", "Project JSON member is malformed or not UTF-8");
      throw error;
    } finally {
      reader.release();
    }
  }
  signal?.throwIfAborted();
  return resolveProjectPackage(input.manifest, revisions, archiveLimits, metadata);
}
