import { afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { projectServiceFixture } from "./project-service.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);

test("public project frames publish requested native face evidence through the production renderer", async () => {
  const f = await projectServiceFixture(cleanups, async (operation, params) => {
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [
            {
              id: "image:0",
              kind: "image",
              width: 1,
              height: 1,
              orientedWidth: 1,
              orientedHeight: 1,
              orientation: 1,
              hasAlpha: false,
              codec: "png",
              decodable: true,
            },
          ],
        },
      };
    if (operation !== "media.renderCompositionFrame")
      throw Error(`Unexpected native operation ${operation}`);
    await writeFile(String(params.output), png, { flag: "wx" });
    const frame = params.frame as {
      layers: { clipId: string; assetId: string; streamId: string }[];
    };
    return {
      ok: true,
      data: {
        file: params.output,
        mediaType: "image/png",
        profile: "h264-rec709",
        width: 1,
        height: 1,
        sourceWidth: 1,
        sourceHeight: 1,
        bytes: png.length,
        frame: params.frame,
        pictures: frame.layers.map((layer) => ({
          kind: "image",
          clipId: layer.clipId,
          assetId: layer.assetId,
          streamId: layer.streamId,
          status: "available",
        })),
        decodedSamples: 0,
        decodedImages: 1,
        readerOpens: 1,
        ...(params.faceObservations === undefined
          ? {}
          : {
              faceObservations: {
                recipe: "vision-face-rectangles-v1",
                implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
                coordinateSpace: "delivered-top-left-pixels",
                width: 1,
                height: 1,
                status: "no_face",
                faces: [],
                reason: "no_face",
              },
            }),
      },
    };
  });
  const imported = await f.call("asset.import", { path: f.path, requestId: "image" });
  if (!imported.ok) throw Error(JSON.stringify(imported));
  const job = imported.data as { jobId: string };
  const assetId = (await f.job(job.jobId, "ready")).published!.output.assetId;
  const created = await f.call("project.create", {
    requestId: "project",
    canvas: { width: 1, height: 1, fps: { numerator: 1, denominator: 1 }, background: "#000000ff" },
  });
  if (!created.ok) throw Error(JSON.stringify(created));
  const project = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const edited = await f.call("edit.apply", {
    projectId: project.project.id,
    expectedRevisionId: project.revision.id,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        clip: {
          assetId,
          streamId: "image:0",
          trackId: { label: "v" },
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1_000_000 } },
        },
      },
    ],
  });
  if (!edited.ok) throw Error(JSON.stringify(edited));
  const revision = edited.data as { revision: { id: string } };
  const selection = {
    projectId: project.project.id,
    revisionId: revision.revision.id,
    atUs: 0,
    faceObservations: { recipe: "vision-face-rectangles-v1" },
  };
  const requested = await f.call("frame.get", selection);
  if (!requested.ok) throw Error(JSON.stringify(requested));
  const status = requested.data as { jobId: string };
  await f.job(status.jobId, "ready");
  const ready = await f.call("frame.get", selection);
  expect(ready).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      published: {
        output: {
          faceObservations: {
            status: "no_face",
            reason: "no_face",
            faces: [],
            implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
          },
        },
      },
    },
  });
  if (ready.ok) {
    const data = ready.data as { delivery: { token: string } };
    await f.call("artifact.close", { token: data.delivery.token });
  }
});
