import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Link the production media module built by the native package in this checkout. */
export function mediaLinkArguments() {
  const build = fileURLToPath(new URL("../../../../helpers/mac/.build/debug/", import.meta.url));
  const outputs = JSON.parse(
    readFileSync(join(build, "YapMedia.build/output-file-map.json"), "utf8"),
  );
  return [
    "-I",
    join(build, "Modules"),
    ...Object.values(outputs).flatMap((value) => (value.object ? [value.object] : [])),
  ];
}
