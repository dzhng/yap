import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { PresetIndex, PresetManifest } from "./preset-format.js";
import { directorySource, installPackages, type PackageSource } from "./preset-install.js";

const enc = new TextEncoder();
const manifest = (
  id = "sample-style",
  version = 1,
  text = "## Any footage\n\n## Shoot\n\n## Edit\n",
) => {
  const data = enc.encode(`---\nid: ${id}\nname: Sample\nversion: ${version}\n---\n${text}`);
  const file = {
    path: "PRESET.md",
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  return { id, kind: "preset", name: "Sample", version, files: [file] } satisfies PresetManifest;
};
const content = (id: string, version: number, text = "## Any footage\n\n## Shoot\n\n## Edit\n") =>
  enc.encode(`---\nid: ${id}\nname: Sample\nversion: ${version}\n---\n${text}`);

const sourceFor = (
  packages: PresetManifest[],
  contents: Map<string, Uint8Array>,
  source?: "bundled" | "downloaded",
): PackageSource => ({
  ...(source ? { source } : {}),
  index: async (): Promise<PresetIndex> => ({ format: 1, packages }),
  file: async (_pkg, path) => {
    const value = contents.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(value);
        controller.close();
      },
    });
  },
});

describe("preset installer", () => {
  test("installs a package atomically", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const pkg = manifest();
    const data = content(pkg.id, 1);
    const report = await installPackages(sourceFor([pkg], new Map([["PRESET.md", data]])), target);
    expect(report.installed).toEqual([pkg.id]);
    expect(await readFile(join(target, pkg.id, "PRESET.md"), "utf8")).toContain("id: sample-style");
    expect(
      JSON.parse(await readFile(join(target, "receipt.json"), "utf8")).packages[pkg.id].version,
    ).toBe(1);
  });

  test("tampered bytes fail with the path and preserve the previous copy", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const old = manifest("sample-style", 1, "old");
    const good = content("sample-style", 1, "old");
    await installPackages(sourceFor([old], new Map([["PRESET.md", good]])), target);
    const next = manifest("sample-style", 2, "new");
    const tampered = enc.encode(`---\nid: sample-style\nname: Sample\nversion: 2\n---\nwrong`);
    const report = await installPackages(
      sourceFor([next], new Map([["PRESET.md", tampered]])),
      target,
    );
    expect(report.failed[0]?.reason).toContain("PRESET.md");
    expect(await readFile(join(target, "sample-style", "PRESET.md"), "utf8")).toContain(
      "version: 1",
    );
    expect(
      JSON.parse(await readFile(join(target, "receipt.json"), "utf8")).packages["sample-style"]
        .version,
    ).toBe(1);
  });

  test("a stream error halfway leaves the installed folder and receipt unchanged", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const old = manifest("sample-style", 1);
    const oldData = content("sample-style", 1);
    await installPackages(sourceFor([old], new Map([["PRESET.md", oldData]])), target);
    const beforeReceipt = await readFile(join(target, "receipt.json"), "utf8");
    const next = manifest("sample-style", 2);
    const source: PackageSource = {
      index: async () => ({ format: 1, packages: [next] }),
      file: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode("partial"));
            controller.error(new Error("dropped"));
          },
        }),
    };
    const report = await installPackages(source, target);
    expect(report.failed[0]?.reason).toContain("dropped");
    expect(await readFile(join(target, "sample-style", "PRESET.md"), "utf8")).toEqual(
      new TextDecoder().decode(oldData),
    );
    expect(await readFile(join(target, "receipt.json"), "utf8")).toBe(beforeReceipt);
  });

  test("higher replaces, tie and lower skip", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const one = manifest("sample-style", 1);
    const data = content("sample-style", 1);
    await installPackages(sourceFor([one], new Map([["PRESET.md", data]])), target);
    const two = manifest("sample-style", 2);
    const twoData = content("sample-style", 2);
    expect(
      (await installPackages(sourceFor([two], new Map([["PRESET.md", twoData]])), target))
        .installed,
    ).toEqual(["sample-style"]);
    expect(
      (await installPackages(sourceFor([two], new Map([["PRESET.md", twoData]])), target))
        .skipped[0]?.reason,
    ).toBe("tie");
    const lower = manifest("sample-style", 1);
    expect(
      (await installPackages(sourceFor([lower], new Map([["PRESET.md", data]])), target)).skipped[0]
        ?.reason,
    ).toBe("older version");
  });

  test("local presets stay untouched and same-id remote is a conflict", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    await writeFile(join(target, "local.json"), JSON.stringify({ ids: ["sample-style"] }));
    await mkdir(join(target, "sample-style"));
    await writeFile(join(target, "sample-style", "PRESET.md"), "local");
    const pkg = manifest();
    const report = await installPackages(
      sourceFor([pkg], new Map([["PRESET.md", enc.encode("remote")]])),
      target,
    );
    expect(report.conflicts).toEqual(["sample-style"]);
    expect(await readFile(join(target, "sample-style", "PRESET.md"), "utf8")).toBe("local");
    const receipt = JSON.parse(await readFile(join(target, "receipt.json"), "utf8"));
    expect(receipt.packages["sample-style"]).toBeUndefined();
    expect(receipt.conflicts["sample-style"]).toEqual({ version: 1 });
    await writeFile(join(target, "local.json"), JSON.stringify({ ids: [] }));
    const restored = content("sample-style", 1);
    expect(
      (await installPackages(sourceFor([pkg], new Map([["PRESET.md", restored]])), target))
        .installed,
    ).toEqual(["sample-style"]);
    const restoredReceipt = JSON.parse(await readFile(join(target, "receipt.json"), "utf8"));
    expect(restoredReceipt.conflicts["sample-style"]).toBeUndefined();
    expect(restoredReceipt.packages["sample-style"].version).toBe(1);
  });

  test("removes only missing downloaded packages when requested", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const pkg = manifest("old-style");
    const data = content("old-style", 1);
    await installPackages(sourceFor([pkg], new Map([["PRESET.md", data]])), target);
    const bundled = manifest("bundled-style");
    await installPackages(
      sourceFor([bundled], new Map([["PRESET.md", content("bundled-style", 1)]]), "bundled"),
      target,
    );
    await writeFile(join(target, "local.json"), JSON.stringify({ ids: ["local-style"] }));
    await mkdir(join(target, "local-style"));
    await writeFile(join(target, "local-style", "PRESET.md"), "local");
    const report = await installPackages(sourceFor([], new Map()), target, undefined, {
      removeMissingDownloaded: true,
    });
    expect(report.removed).toEqual(["old-style"]);
    expect(await readFile(join(target, "receipt.json"), "utf8")).not.toContain("old-style");
    expect(await readFile(join(target, "bundled-style", "PRESET.md"), "utf8")).toContain(
      "bundled-style",
    );
    expect(await readFile(join(target, "local-style", "PRESET.md"), "utf8")).toBe("local");
  });

  test("concurrent installs serialize per target", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const a = manifest("a-style", 1);
    const b = manifest("b-style", 1);
    const data = (id: string) => content(id, 1);
    await Promise.all([
      installPackages(sourceFor([a], new Map([["PRESET.md", data("a-style")]])), target),
      installPackages(sourceFor([b], new Map([["PRESET.md", data("b-style")]])), target),
    ]);
    const receipt = JSON.parse(await readFile(join(target, "receipt.json"), "utf8"));
    expect(Object.keys(receipt.packages).sort()).toEqual(["a-style", "b-style"]);
  });

  test("directorySource round-trips the repository presets", async () => {
    const target = await mkdtemp(join(tmpdir(), "preset-install-"));
    const source = directorySource(join(process.cwd(), "../../presets"));
    const index = await source.index();
    const report = await installPackages(source, target, undefined, {
      removeMissingDownloaded: false,
    });
    expect(report.failed).toEqual([]);
    for (const pkg of index.packages) {
      for (const file of pkg.files) {
        const actual = await readFile(
          join(target, pkg.kind === "preset" ? pkg.id : pkg.kind, file.path),
        );
        expect(actual.byteLength).toBe(file.bytes);
        expect(createHash("sha256").update(actual).digest("hex")).toBe(file.sha256);
      }
    }
  });
});

test("refuses a remote package whose id or kind would escape the target", async () => {
  const outer = await mkdtemp(join(tmpdir(), "preset-install-escape-"));
  const target = join(outer, "presets");
  const text = "x";
  const file = {
    path: "PRESET.md",
    bytes: 1,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  const source = {
    index: async () => ({
      format: 1 as const,
      packages: [
        { id: "../escaped", kind: "preset" as const, version: 1, files: [file] },
        { id: "kit", kind: "evil" as never, version: 1, files: [file] },
      ],
    }),
    file: async () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
  };
  const report = await installPackages(source, target);
  expect(report.installed).toEqual([]);
  expect(report.failed.map((f) => f.id).sort()).toEqual(["../escaped", "kit"]);
  await expect(stat(join(outer, "escaped"))).rejects.toThrow();
});
