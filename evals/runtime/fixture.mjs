import { createServer } from "node:net";
import { appendFile } from "node:fs/promises";

export async function failedJobFixture() {
  const server = createServer((socket) => {
    let bytes = "";
    socket.on("data", async (chunk) => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n")));
      await appendFile("/sandbox/service-calls.jsonl", JSON.stringify(request) + "\n");
      const response =
        request.operation === "job.get" && request.params.jobId === "audit-job"
          ? {
              id: request.id,
              ok: true,
              data: {
                jobId: "audit-job",
                attemptId: "audit-attempt",
                target: { kind: "asset", assetId: "audit-asset" },
                artifact: "audio",
                lane: "heavy",
                state: "failed",
                reason: "The scripted preparation attempt failed.",
                errorCode: "AUDIT_FIXTURE_FAILURE",
                errorDetails: null,
                retryable: false,
                generation: 1,
                inputSha256: "0".repeat(64),
                result: null,
              },
            }
          : {
              id: request.id,
              ok: false,
              error: {
                code: "UNSUPPORTED",
                message: "This read-only fixture supplies only job.get for audit-job.",
                retryable: false,
              },
            };
      socket.end(JSON.stringify(response) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen("/sandbox/service.sock", resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}

const refusal = ({ assetId, usedBy, freesBytes, cascadeFreesBytes }) => ({
  code: "IN_USE",
  message: "The asset is still used by library projects.",
  retryable: false,
  details: {
    assetId,
    usedBy,
    acquisitions: [],
    derivedAssets: [],
    freesBytes,
    cascadeFreesBytes,
  },
});

function deletionReply(request, response) {
  return { id: request.id, ...response };
}

function unsupported(request, message) {
  return deletionReply(request, {
    ok: false,
    error: { code: "UNSUPPORTED", message, retryable: false },
  });
}

function serveDeletionFixture(responder) {
  const server = createServer((socket) => {
    let bytes = "";
    socket.on("data", async (chunk) => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n")));
      await appendFile("/sandbox/service-calls.jsonl", JSON.stringify(request) + "\n");
      socket.end(JSON.stringify(responder(request)) + "\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen("/sandbox/service.sock", () =>
      resolve(() => new Promise((done) => server.close(done))),
    );
  });
}

export async function deletionFixture(name) {
  if (name === "refused-delete") {
    const assetId = "asset-imported-clip";
    const details = {
      assetId,
      usedBy: [
        {
          kind: "project",
          projectId: "project-client-interview",
          title: "Client interview",
          revisions: 2,
        },
        {
          kind: "project",
          projectId: "project-social-cut",
          title: "Social cut",
          revisions: 1,
        },
      ],
      acquisitions: [],
      derivedAssets: [],
      freesBytes: 48_000_000,
      cascadeFreesBytes: 148_000_000,
    };
    return serveDeletionFixture((request) => {
      if (request.operation === "asset.delete")
        return deletionReply(request, {
          ok: false,
          error: refusal({
            assetId,
            usedBy: details.usedBy,
            freesBytes: details.freesBytes,
            cascadeFreesBytes: details.cascadeFreesBytes,
          }),
        });
      if (request.operation === "asset.get")
        return deletionReply(request, {
          ok: true,
          data: {
            assetId,
            sizeBytes: details.freesBytes,
            streams: [{ streamId: "video:0", mediaKind: "video" }],
          },
        });
      return unsupported(request, "This refusal fixture only answers asset.delete and asset.get.");
    });
  }

  if (name === "authorized-free-a-clip") {
    const assetId = "asset-history-only-clip";
    const sourceProjectId = "project-history-holder";
    const sourceRevisionId = "revision-head-before-remove";
    const editedRevisionId = "revision-after-remove";
    const copyProjectId = "project-history-copy";
    const copyRevisionId = "revision-copy-head";
    const freedBytes = 12_345_678;
    let removed = false;
    let originalDeleted = false;
    let assetDeleted = false;
    const usedBy = [
      { kind: "project", projectId: sourceProjectId, title: "History holder", revisions: 3 },
    ];
    return serveDeletionFixture((request) => {
      if (request.operation === "asset.delete") {
        if (!assetDeleted) {
          if (removed && originalDeleted) {
            assetDeleted = true;
            return deletionReply(request, {
              ok: true,
              data: { assetId, deleted: true, freedBytes },
            });
          }
          return deletionReply(request, {
            ok: false,
            error: refusal({
              assetId,
              usedBy,
              freesBytes: freedBytes,
              cascadeFreesBytes: freedBytes,
            }),
          });
        }
        return deletionReply(request, {
          ok: true,
          data: { assetId, deleted: true, freedBytes },
        });
      }
      if (request.operation === "asset.get")
        return deletionReply(request, {
          ok: true,
          data: {
            assetId,
            sizeBytes: freedBytes,
            streams: [{ streamId: "video:0", mediaKind: "video" }],
          },
        });
      if (request.operation === "project.get")
        return deletionReply(request, {
          ok: true,
          data: {
            projectId: sourceProjectId,
            title: "History holder",
            revisionId: sourceRevisionId,
          },
        });
      if (request.operation === "revision.get") {
        const projectId = request.params.projectId;
        const revisionId = projectId === copyProjectId ? copyRevisionId : sourceRevisionId;
        return deletionReply(request, {
          ok: true,
          data: { projectId, revisionId, state: "ready", document: { tracks: [] } },
        });
      }
      if (request.operation === "revision.history")
        return deletionReply(request, {
          ok: true,
          data: {
            projectId: request.params.projectId,
            revisions: [{ revisionId: copyRevisionId, ordinal: 0 }],
            nextCursor: null,
          },
        });
      if (request.operation === "preview.get")
        return deletionReply(request, {
          ok: true,
          data: {
            projectId: copyProjectId,
            revisionId: copyRevisionId,
            state: "ready",
            jobId: null,
          },
        });
      if (request.operation === "edit.apply") {
        removed = true;
        return deletionReply(request, {
          ok: true,
          data: { projectId: sourceProjectId, revisionId: editedRevisionId, issues: [] },
        });
      }
      if (request.operation === "project.duplicate")
        return deletionReply(request, {
          ok: true,
          data: {
            projectId: copyProjectId,
            revisionId: copyRevisionId,
            title: "History holder copy",
            state: "ready",
          },
        });
      if (request.operation === "project.delete") {
        originalDeleted = true;
        return deletionReply(request, {
          ok: true,
          data: { projectId: sourceProjectId, deleted: true, freedBytes: 0 },
        });
      }
      if (request.operation === "asset.origins")
        return deletionReply(request, {
          ok: true,
          data: { origins: [], nextCursor: null },
        });
      return unsupported(
        request,
        "This free-a-clip fixture only answers the deletion recipe operations.",
      );
    });
  }

  return undefined;
}
