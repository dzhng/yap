import { appendFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const directory = process.env.YAP_CONTROLLER_REPORT_ROOT;
const mode = process.env.YAP_CONTROLLER_MODE;
process.stdout.write(
  JSON.stringify({ event: "started", pid: process.pid, socketPath: "/fixture" }) + "\n",
);
const lines = createInterface({ input: process.stdin });
const answer = async (message) => {
  const request = message.request;
  await appendFile(join(directory, "reports.jsonl"), JSON.stringify(request) + "\n");
  const state = request.params.state;
  const barrier =
    mode === "cancel-before-stop" && state === "finalizing"
      ? "finalizing"
      : ["stop-ack", "cleanup-pending", "maximum-cleanup"].includes(mode) &&
          ["complete", "interrupted"].includes(state)
        ? "terminal"
        : null;
  if (barrier) {
    await writeFile(join(directory, barrier + "-entered"), "");
    for (let remaining = 500; remaining > 0; remaining--) {
      if (
        await access(join(directory, barrier + "-release")).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(10);
    }
  }
  process.stdout.write(
    JSON.stringify({
      event: "result",
      response: {
        id: request.id,
        ok: true,
        data: request.params,
      },
    }) + "\n",
  );
};
lines.on("line", (line) => {
  void answer(JSON.parse(line));
});
