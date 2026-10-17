import { mediaProbeSchema } from "@yap/core/assets";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { readMediaProbe } from "./media-probe.js";
import { sourcePublicationMembers, type SourceExporter } from "@yap/core/source-admission";
import { publicationDeadlineMs } from "./publication.js";
import { CatalogError } from "@yap/core/catalog";
import { fileIdentity } from "@yap/core/files";
import type { SourceEvidenceReceipt } from "@yap/core/evidence";
import { MAX_MEDIA_TIMEOUT_MS, nativeResult, type MediaWorker } from "./worker.js";

/** Canonical verification budgets source work separately from file size: sparse media can
 * be tiny but expensive. The bounded allowance does not establish a capture-stop guarantee. */
async function verificationDeadline(
  directory: string,
  canonicalBytes: number | undefined,
  captureAuthority: boolean,
) {
  const published = await Promise.all(
    sourcePublicationMembers.map(async (name) => ({
      name,
      exists: await lstat(join(directory, name)).then(
        (info) => info.isFile(),
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
    })),
  );
  if (!captureAuthority && !published.some((member) => member.exists)) return undefined; // Preserve the legacy worker budget.
  const size = async (name: string) => {
    const file = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return 0;
    try {
      const info = await file.stat();
      return info.isFile() ? info.size : 0;
    } finally {
      await file.close();
    }
  };
  const bytes =
    (await size("capture.journal.jsonl")) +
    (await size("camera.mapping.jsonl")) +
    (canonicalBytes ??
      (await size("narration.mov")) +
        (await size("system.mov")) +
        (captureAuthority ||
        published.some((member) => member.name === "camera.publication.json" && member.exists)
          ? await size("video.mov")
          : 0));
  return Math.min(MAX_MEDIA_TIMEOUT_MS, 600_000 + publicationDeadlineMs(bytes));
}

/** Native verifies canonical bytes through the admitted inode, never a reopened donor path. */
export function sourceExporter(
  worker: MediaWorker,
  lifetime?: { readonly fd: number },
): SourceExporter {
  return async (directory, output, signal, canonical, workLifetimes = [], sourceAuthority) => {
    const lifetimes = [...(lifetime ? [lifetime.fd] : []), ...workLifetimes];
    const handles: FileHandle[] = [];
    const inputs: Record<string, string> = {};
    let canonicalBytes = 0;
    try {
      for (const [role, expected] of Object.entries(canonical ?? {})) {
        const file = await open(
          expected.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(file);
        const stat = await file.stat({ bigint: true });
        if (
          !stat.isFile() ||
          stat.size !== BigInt(expected.bytes) ||
          !isDeepStrictEqual(fileIdentity(stat), expected.identity)
        )
          throw new CatalogError("SOURCE_CHANGED", "Canonical input changed after admission");
        canonicalBytes += Number(stat.size);
        inputs[role] = `/dev/fd/${handles.length + 2}`;
        if (expected.metadata) {
          if (
            expected.metadata.streams.some(
              (stream) => stream.kind === "video" && stream.hasAlpha === undefined,
            )
          )
            throw new CatalogError(
              "PREREQUISITE_MISSING",
              "Canonical video metadata lacks current native alpha facts; source re-admission is required",
            );
          const actual = mediaProbeSchema.parse(
            await readMediaProbe(worker, dirname(output), "/dev/fd/3", signal, [
              file.fd,
              ...lifetimes,
            ]),
          );
          if (
            actual.streams.some(
              (stream) => stream.kind === "video" && stream.hasAlpha === undefined,
            )
          )
            throw new CatalogError(
              "PREREQUISITE_MISSING",
              "Native worker lacks required video alpha facts",
            );
          if (!isDeepStrictEqual(actual, expected.metadata))
            throw new CatalogError(
              "INVALID_PACKAGE",
              "Canonical media metadata differs from its immutable bytes",
            );
        }
      }
      const timeoutMs = await verificationDeadline(
        directory,
        canonical === undefined ? undefined : canonicalBytes,
        sourceAuthority !== undefined,
      );
      return nativeResult(
        await worker(
          "media.sourceEvidence",
          {
            directory,
            output,
            ...(canonical === undefined ? {} : { canonical: inputs }),
            ...(sourceAuthority === undefined ? {} : { sourceAuthority }),
          },
          {
            signal,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            descriptors: [...handles.map((file) => file.fd), ...lifetimes],
          },
        ),
      ) as SourceEvidenceReceipt;
    } catch (error) {
      // Only known access/IO failures are operational. Preserve native and identity refusals.
      if (
        !(error instanceof CatalogError) &&
        ["EACCES", "EPERM", "EIO"].includes((error as NodeJS.ErrnoException)?.code ?? "")
      )
        throw new CatalogError("MEDIA_UNAVAILABLE", "Cannot read source evidence input", {});
      throw error;
    } finally {
      await Promise.all(handles.map((file) => file.close()));
    }
  };
}
