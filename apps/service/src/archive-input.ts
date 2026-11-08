import { constants, fstatSync, openSync } from "node:fs";
import { CatalogError } from "@yap/core/catalog";
import { openedFile, type OpenedFile, type FileIdentity, fileIdentity } from "@yap/core/files";
import { O_NOFOLLOW_ANY } from "@yap/core/open-flags";

export type AdmittedArchive = OpenedFile &
  Readonly<{
    bytes: number;
    identity: Readonly<Omit<FileIdentity, "changedNs">>;
  }>;
/** Pin the object before queue admission; native copying later creates the immutable snapshot. */
export function admitArchive(path: string): AdmittedArchive {
  if (process.platform !== "darwin")
    throw new CatalogError("UNSUPPORTED_PLATFORM", "Archive admission requires macOS");
  let file: OpenedFile;
  try {
    file = openedFile(openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY));
  } catch (error) {
    throw new CatalogError("INVALID_PACKAGE", "Package archive could not be admitted", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const stat = fstatSync(file.fd, { bigint: true });
    if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Archive must be a regular file with an exact byte identity",
      );
    const { device, inode, modifiedNs } = fileIdentity(stat);
    return Object.freeze({
      get fd() {
        return file.fd;
      },
      close: () => file.close(),
      bytes: Number(stat.size),
      identity: Object.freeze({ device, inode, modifiedNs }),
    });
  } catch (error) {
    file.close();
    throw error;
  }
}
