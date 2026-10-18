import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { ProjectStore } from "@yap/core/projects";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";

/** Admit a generated silent fixture with its supplied probe facts, then explicitly author it. */
export async function generatedVideoProject(home, path, { width, height, durationUs }) {
  const library = join(home, "library");
  await mkdir(library, { recursive: true, mode: 0o700 });
  const catalog = new Catalog(join(library, "catalog.sqlite"));
  try {
    const assets = new AssetStore(catalog, library);
    await assets.recover();
    const asset = await assets.import(path, { kind: "generated" }, async () => ({
      originUs: 0,
      streams: [
        {
          id: "track:1",
          kind: "video",
          codec: "h264",
          decodable: true,
          startUs: 0,
          endUs: durationUs,
          segments: [{ startUs: 0, endUs: durationUs, empty: false }],
          width,
          height,
          orientedWidth: width,
          orientedHeight: height,
        },
      ],
    }));
    const acquisitions = new AcquisitionStore(catalog);
    const projects = new ProjectStore(
      catalog,
      assets,
      new TranscriptStore(catalog, library, assetTranscriptOwner(assets, acquisitions)),
      acquisitions,
    );
    const created = projects.create({
      requestId: "native-media-project",
      canvas: { width, height, fps: { numerator: 1, denominator: 1 }, background: "#000000ff" },
    });
    const authored = projects.apply(created.project.projectId, {
      requestId: "native-media-video",
      expectedRevisionId: created.revision.revisionId,
      operations: [
        { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
        {
          operation: "place",
          label: "clip",
          clip: {
            trackId: { label: "video" },
            assetId: asset.id,
            streamId: "track:1",
            source: { kind: "range", range: { startUs: 0, endUs: durationUs } },
            placement: { kind: "project", range: { startUs: 0, endUs: durationUs } },
          },
        },
      ],
    });
    return {
      projectId: created.project.projectId,
      revisionId: authored.revision.revisionId,
      clipId: authored.edit.labels.clip,
      trackId: authored.edit.labels.video,
    };
  } finally {
    catalog.close();
  }
}
