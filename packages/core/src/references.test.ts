import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { ResourceReferences } from "./references.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("a recording retirement fence refuses new acquisition and asset references", async () => {
  const home = await mkdtemp("/tmp/yap-references-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const references = new ResourceReferences(catalog);
  references.fence("acquisition", ["capture-copy"]);
  references.fence("asset", ["asset-copy"]);
  expect(() =>
    references.retain("acquisition", { kind: "revision", id: "r" }, ["capture-copy"]),
  ).toThrow(expect.objectContaining({ code: "DELETE_IN_PROGRESS" }));
  expect(() => references.retain("asset", { kind: "revision", id: "r" }, ["asset-copy"])).toThrow(
    expect.objectContaining({ code: "DELETE_IN_PROGRESS" }),
  );
});
