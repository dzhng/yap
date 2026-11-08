import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nativePackage = fileURLToPath(new URL("../../../../helpers/mac/", import.meta.url));

/** Link the production protocol module, building it first so a fresh checkout needs no prior build. */
export function protocolLinkArguments(build = join(nativePackage, ".build/debug/")) {
  execFileSync(
    "swift",
    [
      "build",
      "--build-system",
      "native",
      "--package-path",
      nativePackage,
      "--target",
      "YapProtocol",
    ],
    { stdio: "ignore" },
  );
  const outputs = JSON.parse(
    readFileSync(join(build, "YapProtocol.build/output-file-map.json"), "utf8"),
  );
  return [
    "-I",
    join(build, "Modules"),
    ...Object.values(outputs).flatMap((value) => (value.object ? [value.object] : [])),
  ];
}
