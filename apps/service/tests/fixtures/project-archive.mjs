import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { AssetStore } from "@yap/core/assets";
import { ProjectStore } from "@yap/core/projects";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { projectPackageManifest, resourceMetadataMember } from "@yap/core/project-package";

export async function projectArchiveContents(store, home, contents = ["generated source"]) {
  const acquisitions = new AcquisitionStore(store);
  const assets = new AssetStore(store, home);
  await assets.recover();
  const imported = [];
  for (const [index, content] of contents.entries()) {
    const source = join(home, `source-${index}.mov`);
    await writeFile(source, content);
    // Source bytes and probe metadata are controlled; no media decoding is requested.
    imported.push(
      await assets.import(source, { kind: "import" }, async () => ({
        originUs: 0,
        streams: [
          {
            id: "video",
            kind: "video",
            codec: "fixture",
            decodable: true,
            width: 32,
            height: 16,
            orientedWidth: 32,
            orientedHeight: 16,
            startUs: 0,
            endUs: 100,
            segments: [{ startUs: 0, endUs: 100, empty: false }],
          },
        ],
      })),
    );
  }
  const asset = imported[0];
  const projects = new ProjectStore(
    store,
    assets,
    new TranscriptStore(store, home, assetTranscriptOwner(assets, acquisitions)),
    acquisitions,
  );
  const created = projects.create({
    requestId: "create",
    title: "Portable fixture",
    canvas: {
      width: 32,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  projects.apply(created.project.id, {
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
      ...imported.map((asset, index) => ({
        operation: "place",
        clip: {
          trackId: { label: "video" },
          assetId: asset.id,
          streamId: "video",
          source: { kind: "range", range: { startUs: 0, endUs: 100 } },
          placement: { kind: "project", range: { startUs: index * 100, endUs: (index + 1) * 100 } },
        },
      })),
    ],
  });
  const snapshot = JSON.parse(JSON.stringify(projects.snapshot(created.project.id)));
  const resources = imported.map((value) => ({ kind: "asset", ...assets.portable(value.id) }));
  const mediaPath = `assets/${asset.fileName}`;
  const files = {};
  for (const [index, resource] of resources.entries()) {
    const metadata = resourceMetadataMember(resource);
    files[`assets/${resource.asset.fileName}`] = contents[index];
    files[metadata.reference.metadata.path] = metadata.body;
  }
  for (const [ordinal, revision] of snapshot.revisions.entries())
    files[`revisions/${ordinal}.json`] = JSON.stringify(revision);
  const inventory = Object.entries(files).map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  }));
  const manifest = projectPackageManifest(snapshot, resources, inventory);
  files["manifest.json"] = JSON.stringify(manifest);
  return { assets, acquisitions, projects, snapshot, asset, mediaPath, files };
}
