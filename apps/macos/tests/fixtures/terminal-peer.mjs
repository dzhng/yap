import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

// The service boundary is held; capture/controller/writers in the app remain real.
const home = process.env.YAP_HOME;
const socketPath = join(home, "run", "service.sock");
mkdirSync(join(home, "run"), { recursive: true });
const pending = new Map();
let held = null;
let holdFirstReport = true;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
function answer(request, data) {
  send({ event: "result", response: { id: request.id, ok: true, data } });
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "result") {
      const waiting = pending.get(message.response.id);
      pending.delete(message.response.id);
      waiting?.resolve(message.response);
    } else if (message.event === "request") {
      const request = message.request;
      if (request.operation === "capture.report") {
        if (request.params.state === "finalizing" && holdFirstReport) {
          held = request;
          holdFirstReport = false;
        } else answer(request, request.params);
      } else if (request.operation === "service.health") {
        answer(request, {
          status: "ready",
          pid: process.pid,
          socketPath,
          home,
          node: process.versions.node,
          uptimeMs: 0,
        });
      } else {
        send({
          event: "result",
          response: {
            id: request.id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Native lifetime fixture",
              retryable: true,
              details: {},
            },
          },
        });
      }
    }
  })
  .on("close", () => process.exit(0));

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", async (bytes) => {
    buffer += bytes.toString();
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
    socket.removeAllListeners("data");
    let response;
    if (request.operation === "peer.status") {
      response = {
        ok: true,
        data: {
          held: held?.params ?? null,
          pending: [...pending.values()].map((value) => value.operation),
        },
      };
    } else if (request.operation === "peer.release") {
      if (held) answer(held, held.params);
      held = null;
      response = { ok: true, data: {} };
    } else if (request.operation === "peer.native") {
      const id = randomUUID();
      response = await new Promise((resolve) => {
        pending.set(id, { operation: request.params.operation, resolve });
        send({ event: "call", request: { id, ...request.params } });
      });
    } else {
      response = {
        ok: false,
        error: {
          code: "UNKNOWN_OPERATION",
          message: "Unknown fixture operation",
          retryable: false,
          details: {},
        },
      };
    }
    socket.end(JSON.stringify({ ...response, id: request.id }) + "\n");
  });
});
server.listen(socketPath, () => send({ event: "started", pid: process.pid, socketPath }));
