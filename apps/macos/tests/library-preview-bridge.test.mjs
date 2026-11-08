import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (path) => ({
  path: realpathSync(path),
  bytes: readFileSync(path).length,
  sha256: digest(readFileSync(path)),
});
async function run(executable, args, env, out) {
  const child = spawn(executable, args, { env, cwd: out, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value) => (stdout += value));
  child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
  const exit = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return { pid: child.pid, executable, args, exit, stdout, stderr };
}

test(
  "actual source metadata pages and composed historical preview consumption",
  { timeout: 90000 },
  async () => {
    const candidate = join(repository, "dist/Yap.app/Contents");
    const out = process.env.YAP_23K_EVIDENCE
      ? realpathSync(process.env.YAP_23K_EVIDENCE)
      : mkdtempSync(join(tmpdir(), "yap-consumer-bridge-"));
    try {
      const service = pin(
          process.env.YAP_23K_SERVICE ?? join(candidate, "Resources/service/main.mjs"),
        ),
        worker = pin(process.env.YAP_23K_NATIVE ?? join(candidate, "MacOS/yap-native"));
      const config = JSON.parse(
        readFileSync(
          process.env.YAP_23K_CONFIG ?? join(candidate, "Resources/service/runtime.json"),
          "utf8",
        ),
      );
      const home = join(out, "home"),
        build = join(out, "consumer");
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(build, { mode: 0o700 });
      const archive = join(
        repository,
        "specs/done/agent-editing/assets/25b-fresh-caller/evidence.tar.gz",
      );
      const producer = JSON.parse(
        readFileSync(join(dirname(archive), "verification.json"), "utf8"),
      );
      assert.equal(digest(readFileSync(archive)), producer.metadataArchive.sha256);
      const members = JSON.parse(readFileSync(`${archive}.members.json`, "utf8"));
      const historical = {};
      const selected = {
        project: "project.get-initial",
        waiting: "primitive-fixture-preview-poll-0",
        ready: "primitive-fixture-preview-poll-3",
        empty: "recipient-initial-project.list",
      };
      mkdirSync(join(out, "historical"));
      const historicalPins = [];
      for (const [key, stem] of Object.entries(selected)) {
        for (const suffix of ["request", "reply"]) {
          const name = `${stem}.${suffix}.json`;
          const bytes = execFileSync("tar", ["-xOf", archive, name], {
            maxBuffer: 8 * 1024 * 1024,
          });
          assert.equal(bytes.length, members[name].bytes);
          assert.equal(digest(bytes), members[name].sha256);
          writeFileSync(join(out, "historical", name), bytes);
          historicalPins.push({ member: name, ...members[name] });
          if (suffix === "reply") {
            const reply = JSON.parse(bytes);
            assert(reply.ok);
            historical[key] = reply.data;
            // Archives stay byte-exact; only this current controller's scripted input changes.
            if (historical[key].published) {
              const { preview, ...identity } = historical[key].published;
              historical[key].published = { ...identity, output: preview };
            }
            // The archive predates record identity: a project names itself `id`.
            if (key === "project") {
              const { projectId, ...project } = historical[key];
              historical[key] = { id: projectId, ...project };
            }
            // The archive predates WorkState and unit-suffixed delivery fields.
            if (historical[key].state === "processing") historical[key].state = "running";
            if (historical[key].delivery) {
              const { token, bytes, expiresAt } = historical[key].delivery;
              historical[key].delivery = { token, sizeBytes: bytes, expiresAtMs: expiresAt };
            }
          }
        }
      }
      const tap = join(out, "source-observer.mjs"),
        native = join(out, "startup-worker.mjs");
      writeFileSync(
        tap,
        `import {appendFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const log=x=>appendFileSync(process.env.YAP_23K_CONTROL,JSON.stringify(x)+'\\n');
process.stdin.on('data',b=>log({direction:'request',base64:b.toString('base64')}));
const write=process.stdout.write.bind(process.stdout);process.stdout.write=(b,...args)=>{log({direction:'response',base64:Buffer.from(b).toString('base64')});return write(b,...args)};
process.on('exit',code=>log({event:'source-node-exit',pid:process.pid,code}));
await import(pathToFileURL(process.env.YAP_23K_SERVICE).href);
`,
      );
      writeFileSync(
        native,
        `#!${config.nodePath}
import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const log=x=>appendFileSync(process.env.YAP_23K_NATIVE_LOG,JSON.stringify(x)+'\\n');let bytes='';
process.stdin.setEncoding('utf8').on('data',x=>bytes+=x);process.stdin.on('end',()=>{
const request=JSON.parse(bytes);log({event:'request',request});const operation=request.operation;
if(!/^media\\.(audio|picture|sourceChannel)Capabilities$/.test(operation)||Object.keys(request.params).length){log({event:'refused',operation});process.stdout.write(JSON.stringify({id:request.id,ok:false,error:{code:'FIXTURE_UNEXPECTED_NATIVE',message:operation,retryable:false,details:{}}})+'\\n');return;}
const child=spawn(process.env.YAP_23K_NATIVE,[],{stdio:['pipe','pipe','pipe']});log({event:'forwarded',operation,pid:child.pid});
let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
child.on('close',(code,signal)=>{log({event:'close',operation,pid:child.pid,code,signal,stdout,stderr});process.stdout.write(stdout);process.stderr.write(stderr);process.exitCode=code??1});child.stdin.end(bytes);
});
`,
      );
      chmodSync(native, 0o700);
      writeFileSync(
        join(out, "inputs.json"),
        JSON.stringify({ bundle: { ...config, script: tap, native }, historical }),
      );
      const compile = [];
      const swift = readFileSync(join(root, "tests/fixtures/library-preview-bridge.swift"), "utf8");
      const appSources = [
        "LibraryController",
        "PreviewController",
        "PreviewWindow",
        "ServiceHost",
        "ServiceBundle",
        "NodeRuntime",
      ];
      const executable = compileControlsCheck(build, appSources, swift, (command) => {
        compile.push(command);
        writeFileSync(join(out, "compiler.json"), JSON.stringify(compile, null, 2));
      });
      const sources = appSources.map((name) => join(root, "Sources/Yap", `${name}.swift`));
      sources.push(
        ...readdirSync(join(root, "Sources/YapControls"))
          .filter((n) => n.endsWith(".swift"))
          .map((n) => join(root, "Sources/YapControls", n)),
      );
      sources.push(
        fileURLToPath(import.meta.url),
        join(root, "tests/fixtures/library-preview-bridge.swift"),
        join(root, "tests/fixtures/swift-controls.mjs"),
      );
      const authority = {
        service,
        worker,
        node: pin(config.nodePath),
        executable: pin(executable),
        sources: sources.map(pin),
        historicalPins,
        historicalProducer: JSON.parse(
          readFileSync(join(dirname(archive), "producer.json"), "utf8"),
        ),
      };
      writeFileSync(join(out, "authority.json"), JSON.stringify(authority, null, 2));
      const env = {
        ...process.env,
        YAP_HOME: home,
        YAP_23K_SERVICE: service.path,
        YAP_23K_NATIVE: worker.path,
        YAP_23K_CONTROL: join(out, "source-control.jsonl"),
        YAP_23K_NATIVE_LOG: join(out, "native.jsonl"),
      };
      const green = await run(
        executable,
        [join(out, "inputs.json"), join(out, "green.jsonl")],
        env,
        out,
      );
      writeFileSync(join(out, "consumer.json"), JSON.stringify(green, null, 2));
      assert.deepEqual(green.exit, { code: 0, signal: null }, green.stderr);
      const nativeRows = readFileSync(env.YAP_23K_NATIVE_LOG, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(
        nativeRows
          .filter((x) => x.event === "request")
          .map((x) => x.request.operation)
          .sort(),
        ["media.audioCapabilities", "media.pictureCapabilities", "media.sourceChannelCapabilities"],
      );
      assert(nativeRows.every((x) => x.event !== "refused"));
      assert.deepEqual(
        nativeRows.filter((x) => x.event === "close").map((x) => [x.code, x.signal]),
        [
          [0, null],
          [0, null],
          [0, null],
        ],
      );
      const control = readFileSync(env.YAP_23K_CONTROL, "utf8").trim().split("\n").map(JSON.parse);
      const termination = control.find((x) => x.event === "source-node-exit");
      assert.equal(termination.code, 0);
      const frames = (direction) =>
        Buffer.concat(
          control
            .filter((x) => x.direction === direction)
            .map((x) => Buffer.from(x.base64, "base64")),
        )
          .toString("utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
      const requests = frames("request").map((x) => x.request);
      const answers = frames("response");
      assert(
        answers.every((x) => x.event !== "call"),
        "Capture callback must not execute",
      );
      const exchanges = requests.map((request) => ({
        request,
        response: answers.find((x) => x.event === "result" && x.response.id === request.id)
          ?.response,
      }));
      assert(exchanges.every((x) => x.response?.ok));
      assert(
        exchanges.every((x) =>
          ["project.create", "project.list", "project.get", "media.list", "recording.get"].includes(
            x.request.operation,
          ),
        ),
      );
      writeFileSync(join(out, "source-exchanges.json"), JSON.stringify(exchanges, null, 2));
      const observed = readFileSync(join(out, "green.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert(observed.some((x) => x.event === "source-os-exit" && x.pid === termination.pid));
      const red = await run(
        executable,
        [
          join(out, "inputs.json"),
          join(out, "missing-pin.jsonl"),
          "--historical-only",
          "--omit-second-pin",
        ],
        env,
        out,
      );
      writeFileSync(join(out, "negative-control.json"), JSON.stringify(red, null, 2));
      assert.deepEqual(red.exit, { code: 1, signal: null });
      assert.match(
        red.stderr,
        /Historical preview request must retain the first returned revision/,
      );
      assert.equal(digest(readFileSync(worker.path)), worker.sha256);
      console.log(`PASS complete actual metadata and historical ownership records: ${out}`);
    } finally {
      if (!process.env.YAP_23K_EVIDENCE) rmSync(out, { recursive: true, force: true });
    }
  },
);
