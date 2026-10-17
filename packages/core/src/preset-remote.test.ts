import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installPackages } from "./preset-install.js";
import { remoteSource } from "./preset-remote.js";
import type { PresetIndex } from "./preset-format.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest = (id = "demo", version = 2, text = "new") => ({
  id, kind: "preset" as const, version,
  files: [{ path: "PRESET.md", bytes: Buffer.byteLength(text), sha256: sha(text) }],
});

type Reply = { status?: number; body?: string; headers?: Record<string, string>; url?: string };
function fakeFetch(replies: Record<string, Reply | (() => Reply | Promise<Reply>)>) {
  const calls: string[] = [];
  const fetch = async (input: string | URL) => {
    const url = String(input); calls.push(url);
    const found = replies[url];
    if (!found) throw new Error(`unexpected ${url}`);
    const reply = typeof found === "function" ? await found() : found;
    return new Response(reply.body ?? "", { status: reply.status ?? 200, ...(reply.headers ? { headers: reply.headers } : {}) });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("remoteSource", () => {
  it("resolves ref once and pins the index and files to the commit", async () => {
    const index: PresetIndex = { format: 1, packages: [manifest()] };
    const api = "https://api.test"; const raw = "https://raw.test";
    const { fetch, calls } = fakeFetch({
      [`${api}/repos/acme/presets/commits/main`]: { body: "a".repeat(40), headers: { "content-type": "text/plain" } },
      [`${raw}/acme/presets/${"a".repeat(40)}/presets/index.json`]: { body: JSON.stringify(index) },
      [`${raw}/acme/presets/${"a".repeat(40)}/presets/demo/PRESET.md`]: { body: "new" },
    });
    const source = remoteSource({ repo: "acme/presets", apiBase: api, rawBase: raw, fetch });
    const target = await mkdtemp(join(tmpdir(), "preset-remote-"));
    try {
      await installPackages(source, target);
      expect(calls).toEqual([
        `${api}/repos/acme/presets/commits/main`,
        `${raw}/acme/presets/${"a".repeat(40)}/presets/index.json`,
        `${raw}/acme/presets/${"a".repeat(40)}/presets/demo/PRESET.md`,
      ]);
      expect(source.commit).toBe("a".repeat(40));
    } finally { await rm(target, { recursive: true, force: true }); }
  });

  it("reports tampered and dropped streams without replacing the old copy", async () => {
    const index: PresetIndex = { format: 1, packages: [manifest("demo", 2, "new")] };
    const commit = "b".repeat(40); const api = "https://api.test"; const raw = "https://raw.test";
    let tamper = true;
    const { fetch } = fakeFetch({
      [`${api}/repos/acme/presets/commits/main`]: { body: commit },
      [`${raw}/acme/presets/${commit}/presets/index.json`]: { body: JSON.stringify(index) },
      [`${raw}/acme/presets/${commit}/presets/demo/PRESET.md`]: () => ({ body: tamper ? "bad" : "new" }),
    });
    const source = remoteSource({ repo: "acme/presets", apiBase: api, rawBase: raw, fetch });
    const target = await mkdtemp(join(tmpdir(), "preset-remote-"));
    try {
      await writeFile(join(target, "receipt.json"), JSON.stringify({ packages: { demo: { kind: "preset", version: 1, source: "downloaded", files: [{ path: "PRESET.md", bytes: 3, sha256: sha("old") }] } }, conflicts: {} }));
      await writeFile(join(target, "demo"), "");
      await rm(join(target, "demo"));
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(target, "demo")));
      await writeFile(join(target, "demo", "PRESET.md"), "old");
      const report = await installPackages(source, target);
      expect(report.failed[0]?.reason).toMatch(/sha256 mismatch/);
      expect(await readFile(join(target, "demo", "PRESET.md"), "utf8")).toBe("old");
    } finally { await rm(target, { recursive: true, force: true }); }
  });

  it("names the URL for non-2xx and timeout failures", async () => {
    const api = "https://api.test"; const url = `${api}/repos/acme/presets/commits/main`;
    const bad = fakeFetch({ [url]: { status: 503, body: "no" } });
    await expect(remoteSource({ repo: "acme/presets", apiBase: api, fetch: bad.fetch }).index()).rejects.toThrow(url);
    const slow = fakeFetch({ [url]: () => new Promise<Reply>(() => {}) });
    await expect(remoteSource({ repo: "acme/presets", apiBase: api, fetch: slow.fetch, timeoutMs: 1 }).index()).rejects.toThrow(url);
  });
});
