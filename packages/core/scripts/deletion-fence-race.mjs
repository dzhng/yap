import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../dist/assets.js";
import { Catalog } from "../dist/catalog.js";
import { DeletionPlans } from "../dist/deletion-plans.js";

const root = await mkdtemp(join(tmpdir(), "yap-deletion-fence-"));
const catalog = new Catalog(join(root, "catalog.sqlite"));
try {
  const assets = new AssetStore(catalog, root);
  await assets.recover();
  const input = join(root, "input.png");
  await writeFile(input, "fixture pixels");
  const staged = await assets.stage(input, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "image:0",
        kind: "image",
        codec: "public.png",
        decodable: true,
        width: 2,
        height: 1,
        orientedWidth: 2,
        orientedHeight: 1,
        orientation: 1,
      },
    ],
  }));
  const plans = new DeletionPlans(catalog);
  const tombstone = Promise.resolve().then(() => {
    plans.create("asset", staged.asset.id, false);
    plans.setPhase("asset", staged.asset.id, "tombstoned");
  });
  const publication = Promise.resolve().then(() => {
    try {
      catalog.transaction(() => staged.publish());
      return { ok: true };
    } catch (error) {
      return { code: error.code };
    }
  });
  await Promise.all([tombstone, publication]);
  await staged.close();
  const fileExists = await stat(join(root, "assets", staged.asset.fileName)).then(
    () => true,
    () => false,
  );
  console.log(
    JSON.stringify({
      assetId: staged.asset.id,
      publication: await publication,
      rowExists: assets.has(staged.asset.id),
      fileExists,
      agrees: assets.has(staged.asset.id) === fileExists,
    }),
  );
} finally {
  catalog.close();
  await rm(root, { recursive: true, force: true });
}
