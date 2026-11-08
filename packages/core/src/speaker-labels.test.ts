import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { SpeakerLabelStore } from "./speaker-labels.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("bindings replace only the selected generation and retain explicit names", async () => {
  const home = await mkdtemp("/tmp/speaker-labels-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const labels = new SpeakerLabelStore(catalog);
  const identity = {
    owner: { kind: "asset" as const, id: "a".repeat(64) },
    sourceId: "a".repeat(64),
    generation: "generation-a",
    policy: "speaker-v1" as const,
  };

  expect(labels.read(identity)).toEqual([]);
  expect(
    labels.bind(identity, [
      { slot: 0, displayName: "Ada" },
      { slot: 2, displayName: "Grace" },
    ]),
  ).toEqual([
    { slot: 0, displayName: "Ada" },
    { slot: 2, displayName: "Grace" },
  ]);
  expect(labels.read({ ...identity, generation: "generation-b" })).toEqual([]);
  expect(labels.bind(identity, [{ slot: 1, displayName: "Lin" }])).toEqual([
    { slot: 1, displayName: "Lin" },
  ]);
  expect(() =>
    labels.bind(identity, [
      { slot: 1, displayName: "Lin" },
      { slot: 1, displayName: "Ada" },
    ]),
  ).toThrow("Speaker label slots must be unique");
});
