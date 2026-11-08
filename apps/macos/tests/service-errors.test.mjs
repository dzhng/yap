import assert from "node:assert/strict";
import { test } from "node:test";
import { checkServiceHost } from "./fixtures/swift-service-host.mjs";
import { operationSchema } from "../../../packages/protocol/dist/index.js";

test("ServiceHost derives the service refusal's verdict and delay and resolving request", (t) => {
  const result = checkServiceHost(
    t,
    `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
send({event:'started', pid:process.pid, socketPath:'/scratch/service.sock'});
createInterface({input:process.stdin}).on('line', (line) => {
  const {request} = JSON.parse(line);
  send({event:'result', response:{id:request.id, ok:false, error:{
    code:'NOT_READY', message:'Still preparing', retryable:false, retryAfterMs:1,
    details:{retry:{operation:'job.get',params:{jobId:'missing'}}}
  }}});
}).on('close', () => process.exit(0));
`,
    `
    do { _ = try await host.call("job.get", ["jobId": "missing"]); exit(1) }
    catch { print(String(decoding: try! JSONSerialization.data(withJSONObject: error.envelope), as: UTF8.self)) }
`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const error = JSON.parse(result.stdout);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 15000);
  assert.deepEqual(error.details, {
    retry: { operation: "job.get", params: { jobId: "missing" } },
  });
  operationSchema.parse(error.details.retry);
});

test("ServiceHost sends native refusals with their delay and resolving request", (t) => {
  const result = checkServiceHost(
    t,
    `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
send({event:'started', pid:process.pid, socketPath:'/scratch/service.sock'});
let waiting;
createInterface({input:process.stdin}).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event === 'request') {
    waiting = message.request.id;
    send({event:'call',request:{id:'native-fixture',operation:'capture.status',params:{}}});
  } else send({event:'result',response:{id:waiting,ok:true,data:message.response.error}});
}).on('close', () => process.exit(0));
`,
    `
    do { print(String(decoding: try await host.call("capture.status"), as: UTF8.self)) }
    catch { print(error.code); exit(1) }
`,
    [],
    `
    answer(.failure(ServiceFailure(code: "NOT_READY", message: "Still preparing",
        details: Data(#"{"retry":{"operation":"job.get","params":{"jobId":"missing"}}}"#.utf8))))
`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const error = JSON.parse(result.stdout);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 15000);
  assert.deepEqual(error.details, {
    retry: { operation: "job.get", params: { jobId: "missing" } },
  });
  operationSchema.parse(error.details.retry);
});

test("a terminal service failure retains retry metadata for pending and later calls", (t) => {
  const result = checkServiceHost(
    t,
    `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
send({event:'started', pid:process.pid, socketPath:'/scratch/service.sock'});
createInterface({input:process.stdin}).on('line', () => {
  send({event:'failed',error:{code:'NOT_READY',message:'Still preparing',retryable:false,retryAfterMs:1,
    details:{retry:{operation:'job.get',params:{jobId:'missing'}}}}});
}).on('close', () => process.exit(0));
`,
    `
    for _ in 0..<2 {
        do { _ = try await host.call("job.get", ["jobId": "missing"]); exit(1) }
        catch { print(String(decoding: try! JSONSerialization.data(withJSONObject: error.envelope), as: UTF8.self)) }
    }
`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const line of result.stdout.trim().split("\n")) {
    const error = JSON.parse(line);
    assert.equal(error.retryAfterMs, 15000);
    assert.deepEqual(error.details, {
      retry: { operation: "job.get", params: { jobId: "missing" } },
    });
    operationSchema.parse(error.details.retry);
  }
});
