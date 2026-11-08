import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const run = promisify(execFile);

/** Compile the real publication/storage/parent-lifetime owners without codecs or model dependencies. */
export async function compilePublicationOwner(directory) {
  const root = resolve(import.meta.dirname, "../..");
  const sources = join(root, "Sources");
  const cache = join(directory, "swift-cache");
  await run("/usr/bin/xcrun", [
    "swiftc",
    "-module-cache-path",
    cache,
    "-emit-library",
    "-emit-module",
    "-module-name",
    "YapMedia",
    ...["NativeFailure", "DirectoryContents", "ExclusiveFile"].map((name) =>
      join(sources, "YapMedia", name + ".swift"),
    ),
    "-emit-module-path",
    join(directory, "YapMedia.swiftmodule"),
    "-o",
    join(directory, "libYapMedia.dylib"),
  ]);
  const main = join(directory, "main.swift");
  await writeFile(
    main,
    `import Foundation
import YapMedia
if CommandLine.arguments.dropFirst().first == "--run-cli" {
    CommandWorker.run(Array(CommandLine.arguments.dropFirst()))
}
let parentExit = ParentLifetime.endWorkWhenParentExits()
while let line = readLine() {
    var response: [String: Any] = [:]
    do {
        let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        response["id"] = request["id"]
        let operation = request["operation"] as! String
        let params = request["params"] as! [String: Any]
        let data: Any
        if PublicationOperation.operations.contains(operation) { data = try PublicationOperation.execute(operation, params) }
        else if operation == "storage.externalDirectory" { data = try ManagedFiles.externalDirectory(params) }
        else { try ManagedFiles.execute(operation, params); data = ["removed": true] }
        response["ok"] = true; response["data"] = data
    } catch {
        let failure = error as? NativeFailure ?? NativeFailure("FIXTURE_FAILURE", error.localizedDescription)
        response["ok"] = false
        response["error"] = ["code": failure.code, "message": failure.message, "details": [:]]
    }
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: response))
    FileHandle.standardOutput.write(Data([0x0a]))
}
`,
  );
  const binary = join(directory, "publication-owner");
  await run("/usr/bin/xcrun", [
    "swiftc",
    "-I",
    directory,
    "-L",
    directory,
    "-lYapMedia",
    "-Xlinker",
    "-rpath",
    "-Xlinker",
    directory,
    "-module-cache-path",
    cache,
    ...["WireRequest", "Descriptors", "ManagedFiles", "PublicationOperation"].map((name) =>
      join(sources, "YapWire", name + ".swift"),
    ),
    ...["ParentLifetime", "CommandWorker"].map((name) =>
      join(sources, "YapNative", name + ".swift"),
    ),
    main,
    "-o",
    binary,
  ]);
  return binary;
}
