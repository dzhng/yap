import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PresetRefresh } from "./preset-refresh.js";
import type { PackageSource } from "./preset-install.js";
import type { PresetIndex } from "./preset-format.js";

const file = (path: string, text: string) => ({
  path,
  bytes: Buffer.byteLength(text),
  sha256: createHash("sha256").update(text).digest("hex"),
});
const pkg = (id: string, version: number, text = id) => ({
  id,
  kind: "preset" as const,
  version,
  files: [file("PRESET.md", text)],
});

type Timer = { fn: () => void; ms: number; unref?: () => void };
function fakeClock() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    now: () => new Date(now),
    setTimeout: ((fn: () => void, ms: number) => {
      const timer: Timer = { fn, ms, unref: () => {} };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: Timer) => {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
    }) as unknown as typeof clearTimeout,
    advance(ms: number) {
      now += ms;
      const due = timers.splice(0, timers.length);
      for (const timer of due.filter((t) => t.ms <= ms)) timer.fn();
      timers.push(...due.filter((t) => t.ms > ms).map((t) => ({ ...t, ms: t.ms - ms })));
    },
  };
}
function sourceFor(
  index: PresetIndex,
  contents: Record<string, string>,
  calls: { index: number; files: number } = { index: 0, files: 0 },
): PackageSource {
  return {
    source: "downloaded",
    commit: "c".repeat(40),
    async index() {
      calls.index++;
      return index;
    },
    async file(pkg, path) {
      calls.files++;
      const body = contents[`${pkg.id}/${path}`] ?? contents[`${pkg.kind}/${path}`] ?? "";
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
    },
  };
}

describe("PresetRefresh", () => {
  it("runs immediately and daily, joins overlapping calls, and reports newer availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-refresh-"));
    const clock = fakeClock();
    const calls = { index: 0, files: 0 };
    const index: PresetIndex = { format: 1, packages: [pkg("demo", 2), pkg("kit", 2)] };
    const refresh = new PresetRefresh({
      root,
      source: () => sourceFor(index, { "demo/PRESET.md": "demo", "kit/PRESET.md": "kit" }, calls),
      clock,
      everyMs: 100,
    });
    try {
      refresh.start();
      await refresh.run();
      expect(refresh.state()).toMatchObject({ commit: "c".repeat(40), available: [] });
      expect(calls.index).toBe(1);
      const [a, b] = await Promise.all([refresh.run(), refresh.run()]);
      expect(a).toEqual(b);
      expect(calls.index).toBe(2);
      clock.advance(100);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls.index).toBe(3);
    } finally {
      refresh.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  async function seeded() {
    const root = await mkdtemp(join(tmpdir(), "preset-refresh-"));
    for (const [id, text] of [
      ["old", "old"],
      ["shipped", "shipped"],
      ["mine", "mine"],
    ] as const) {
      await mkdir(join(root, id), { recursive: true });
      await writeFile(join(root, id, "PRESET.md"), text);
    }
    await writeFile(
      join(root, "receipt.json"),
      JSON.stringify({
        packages: {
          old: {
            kind: "preset",
            version: 1,
            source: "downloaded",
            files: [file("PRESET.md", "old")],
          },
          shipped: {
            kind: "preset",
            version: 1,
            source: "bundled",
            files: [file("PRESET.md", "shipped")],
          },
        },
        conflicts: {},
      }),
    );
    await writeFile(join(root, "local.json"), JSON.stringify({ ids: ["mine"] }));
    return root;
  }

  it("offline keeps every installed copy and records the error", async () => {
    const root = await seeded();
    try {
      const offline: PackageSource = {
        source: "downloaded",
        async index() {
          throw new Error("offline");
        },
        async file() {
          throw new Error("offline");
        },
      };
      const refresh = new PresetRefresh({ root, source: () => offline, clock: fakeClock() });
      await expect(refresh.run()).rejects.toThrow(/offline/);
      expect(refresh.state().error).toMatch(/offline/);
      expect(await readFile(join(root, "old", "PRESET.md"), "utf8")).toBe("old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a downloaded preset the index no longer lists, never bundled or local ones", async () => {
    const root = await seeded();
    try {
      const refresh = new PresetRefresh({
        root,
        source: () =>
          sourceFor({ format: 1, packages: [pkg("fresh", 1)] }, { "fresh/PRESET.md": "fresh" }),
        clock: fakeClock(),
      });
      const report = await refresh.run();
      expect(report.removed).toEqual(["old"]);
      expect(await readFile(join(root, "shipped", "PRESET.md"), "utf8")).toBe("shipped");
      expect(await readFile(join(root, "mine", "PRESET.md"), "utf8")).toBe("mine");
      expect(await readFile(join(root, "fresh", "PRESET.md"), "utf8")).toBe("fresh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downloads only versions higher than installed and counts the bytes", async () => {
    const root = await seeded();
    try {
      const calls = { index: 0, files: 0 };
      const index: PresetIndex = {
        format: 1,
        packages: [pkg("old", 1, "old"), pkg("shipped", 2, "shipped v2")],
      };
      const refresh = new PresetRefresh({
        root,
        source: () => sourceFor(index, { "shipped/PRESET.md": "shipped v2" }, calls),
        clock: fakeClock(),
      });
      const report = await refresh.run();
      expect(report.installed).toEqual(["shipped"]);
      expect(calls.files).toBe(1);
      expect(refresh.state().bytesDone).toBe(Buffer.byteLength("shipped v2"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("close waits for a refresh in flight, so nothing is still renaming when ownership is released", async () => {
  const root = await mkdtemp(join(tmpdir(), "preset-refresh-close-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const index: PresetIndex = { format: 1, packages: [pkg("slow", 1)] };
  const base = sourceFor(index, { "slow/PRESET.md": "slow" });
  const source: PackageSource = {
    ...base,
    async index() {
      await gate;
      return index;
    },
  };
  const refresh = new PresetRefresh({ root, source: () => source, clock: fakeClock() });
  const running = refresh.run();
  let closed = false;
  const closing = refresh.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await running;
  await closing;
  expect(closed).toBe(true);
  await rm(root, { recursive: true, force: true });
});

it("remembers every id in the last remote index and lets callers wait for a run in flight", async () => {
  const root = await mkdtemp(join(tmpdir(), "preset-refresh-ids-"));
  const index: PresetIndex = { format: 1, packages: [pkg("official", 1)] };
  const refresh = new PresetRefresh({
    root,
    source: () => sourceFor(index, { "official/PRESET.md": "official" }),
    clock: fakeClock(),
  });
  void refresh.run();
  await refresh.settled();
  expect(refresh.remoteIds()).toEqual(new Set(["official"]));
  await rm(root, { recursive: true, force: true });
});
