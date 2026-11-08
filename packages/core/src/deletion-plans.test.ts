import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Catalog, catalogFormat } from "./catalog.js";
import { DeletionPlans } from "./deletion-plans.js";

test("deletion plan tables are additive and idempotent on format 29", async () => {
  const home = await mkdtemp("/tmp/yap-deletion-plans-");
  const path = join(home, "catalog.sqlite");
  try {
    const first = new Catalog(path);
    const plans = new DeletionPlans(first);
    expect(plans).toBeDefined();
    expect(first.catalog.prepare("PRAGMA user_version").get()).toEqual({
      user_version: catalogFormat,
    });
    first.close();

    const second = new Catalog(path);
    new DeletionPlans(second);
    expect(second.catalog.prepare("PRAGMA user_version").get()).toEqual({
      user_version: catalogFormat,
    });
    expect(
      second.catalog
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'deletion_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "deletion_plan_members" },
      { name: "deletion_plans" },
      { name: "deletion_requests" },
    ]);
    second.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
