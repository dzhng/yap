import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callLocal } from "../../../packages/client/dist/index.js";

const sources = fileURLToPath(new URL("../Sources/Yap/", import.meta.url));

/** Builds the app's real AppSocket with a handler standing in for the app's operation owners. */
function build(t) {
  const scratch = realpathSync(mkdtempSync("/tmp/yap-app-socket-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const main = join(scratch, "Main.swift");
  writeFileSync(
    main,
    `
import Foundation
final class Box: @unchecked Sendable { var data: Data; init(_ data: Data) { self.data = data } }
@main struct Check {
    static func main() {
        signal(SIGPIPE, SIG_IGN) // as the app does at launch
        let shortcuts = Box(Data(#"{"version":2,"bindings":{}}"#.utf8))
        let socket = AppSocket(path: CommandLine.arguments[1], maxRequestBytes: 1 << 20) { operation, params, answer in
            switch operation {
            case "update.status": answer(.success(Data(#"{"state":"idle"}"#.utf8)))
            case "shortcuts.get": answer(.success(shortcuts.data))
            case "shortcuts.set":
                let object = try! JSONSerialization.jsonObject(with: params) as! [String: Any]
                shortcuts.data = try! JSONSerialization.data(withJSONObject: ["version": 2, "bindings": object["bindings"]!])
                answer(.success(shortcuts.data))
            case "login.setEnabled":
                answer(.failure(ServiceFailure(code: "INVALID_PARAMS", message: "login.setEnabled requires enabled.")))
            default: answer(.success(params))
            }
        }
        do { try socket.start() } catch {
            print("refused \\(error.code)"); fflush(stdout); exit(3)
        }
        print("listening"); fflush(stdout)
        while FileHandle.standardInput.availableData.count > 0 {}
        socket.stop()
    }
}
`,
  );
  const executable = join(scratch, "check");
  const compile = spawnSync(
    "swiftc",
    [
      "-swift-version",
      "6",
      "-parse-as-library",
      ...["AppSocket", "ServiceBundle", "NodeRuntime"].map((name) =>
        join(sources, `${name}.swift`),
      ),
      main,
      "-o",
      executable,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(compile.status, 0, compile.stderr);
  return { scratch, executable };
}

function serve(t, executable, path) {
  const child = spawn(executable, [path], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  return new Promise((resolve) => {
    child.stdout.once("data", (line) => resolve({ child, line: String(line).trim() }));
  });
}

test("the app answers its own operations on its socket, framed like the service", async (t) => {
  const { scratch, executable } = build(t);
  const path = join(scratch, "app.sock");
  // A socket file left by a crashed app is replaced rather than blocking the new one.
  const stale = createServer();
  await new Promise((resolve) => stale.listen(path, resolve));
  await new Promise((resolve) => stale.close(resolve));
  writeFileSync(join(scratch, "marker"), "");
  const { child, line } = await serve(t, executable, path);
  assert.equal(line, "listening");

  assert.deepEqual(await callLocal(path, { id: "a", operation: "update.status", params: {} }), {
    id: "a",
    ok: true,
    data: { state: "idle" },
  });
  assert.deepEqual(await callLocal(path, { id: "b", operation: "login.setEnabled", params: {} }), {
    id: "b",
    ok: false,
    error: {
      code: "INVALID_PARAMS",
      message: "login.setEnabled requires enabled.",
      retryable: false,
      details: {},
    },
  });
  assert.deepEqual(
    await callLocal(path, { id: "shortcut-get", operation: "shortcuts.get", params: {} }),
    {
      id: "shortcut-get",
      ok: true,
      data: { version: 2, bindings: {} },
    },
  );
  assert.deepEqual(
    await callLocal(path, {
      id: "shortcut-set",
      operation: "shortcuts.set",
      params: {
        bindings: { "capture.startOrStop": "option+shift+s" },
      },
    }),
    {
      id: "shortcut-set",
      ok: true,
      data: {
        version: 2,
        bindings: { "capture.startOrStop": "option+shift+s" },
      },
    },
  );
  assert.deepEqual(
    await callLocal(path, { id: "shortcut-get-2", operation: "shortcuts.get", params: {} }),
    {
      id: "shortcut-get-2",
      ok: true,
      data: {
        version: 2,
        bindings: { "capture.startOrStop": "option+shift+s" },
      },
    },
  );
  assert.deepEqual(
    await callLocal(path, { id: "c", operation: "skill.status", params: { echoed: [1, "two"] } }),
    { id: "c", ok: true, data: { echoed: [1, "two"] } },
  );

  // A garbled request is answered, not left hanging.
  const garbled = await new Promise((resolve, reject) => {
    const socket = createConnection(path, () => socket.write("not json\n"));
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("end", () => resolve(JSON.parse(reply)));
    socket.on("error", reject);
  });
  assert.equal(garbled.ok, false);
  assert.equal(garbled.error.code, "INVALID_REQUEST");

  // A second app must not take over a live one's socket.
  const second = await serve(t, executable, path);
  assert.equal(second.line, "refused SOCKET_IN_USE");
  assert.deepEqual(await callLocal(path, { id: "d", operation: "update.status", params: {} }), {
    id: "d",
    ok: true,
    data: { state: "idle" },
  });

  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  assert.equal(existsSync(path), false, "a stopped app removes its socket");
});

test("a first launch creates the socket's private directory, parents included", async (t) => {
  const { scratch, executable } = build(t);
  const path = join(scratch, "home/.yap/run/app.sock");
  const { child, line } = await serve(t, executable, path);
  assert.equal(line, "listening");
  assert.deepEqual(await callLocal(path, { id: "e", operation: "update.status", params: {} }), {
    id: "e",
    ok: true,
    data: { state: "idle" },
  });
  const { statSync } = await import("node:fs");
  assert.equal(statSync(join(scratch, "home/.yap/run")).mode & 0o777, 0o700);
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
});

test("a caller that trickles its request is cut off within the deadline", async (t) => {
  const { scratch, executable } = build(t);
  const path = join(scratch, "app.sock");
  const { line } = await serve(t, executable, path);
  assert.equal(line, "listening");
  const started = Date.now();
  const closedAfter = await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const drip = setInterval(() => socket.write("{"), 2_000);
    socket.on("close", () => {
      clearInterval(drip);
      resolve(Date.now() - started);
    });
    socket.on("error", () => {});
    setTimeout(() => reject(new Error("still connected after 15 s")), 15_000);
  });
  assert.ok(closedAfter < 8_000, `closed after ${closedAfter} ms`);
});
