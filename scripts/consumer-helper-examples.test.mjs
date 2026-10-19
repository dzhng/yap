import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const run = (code, cwd) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("published helper examples retain returned revision and continuation identities without preparing or editing", async () => {
  const reference = await readFile(join(root, "skills/yap/references/helper-examples.md"), "utf8");
  const examples = Object.fromEntries(
    [...reference.matchAll(/```javascript\n\/\/ ([\w-]+)\n([\s\S]*?)```/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const scratch = await mkdtemp(join(tmpdir(), "yap-helper-examples-"));
  try {
    const revision = {
      ok: true,
      data: {
        projectId: "opaque-project-719",
        revision: { id: "opaque-revision-531", document: {} },
      },
    };
    await writeFile(join(scratch, "revision.json"), JSON.stringify(revision));
    await writeFile(join(scratch, "range.json"), JSON.stringify({ startUs: 0, endUs: 1000000 }));
    await writeFile(
      join(scratch, "cli.json"),
      JSON.stringify({ executable: join(scratch, "peer") }),
    );
    await writeFile(
      join(scratch, "peer"),
      `#!${process.execPath}
let text = ''; for await (const chunk of process.stdin) text += chunk;
const params = JSON.parse(text), operation = process.argv[2];
if (params.projectId !== 'opaque-project-719' || params.revisionId !== 'opaque-revision-531' || params.prepare === true) process.exit(9);
let data;
if (operation === 'revision.get') data = ${JSON.stringify(revision.data)};
else if (operation === 'transcript.get') data = {projectId: params.projectId, revisionId: params.revisionId, state:'ready', rows:[{type:'word',text:params.cursor?'second':'first',segment:0,generation:'generation-8',ordinal:params.cursor?1:0,assetId:'asset-9',streamId:'audio-7',clipId:'clip-6',trackId:'speech-5',sourceRange:{startUs:params.cursor?400000:0,endUs:params.cursor?800000:400000},fragments:[{source:{startUs:params.cursor?400000:0,endUs:params.cursor?800000:400000},project:{startUs:params.cursor?400000:0,endUs:params.cursor?800000:400000}}]}], nextCursor:params.cursor?null:'opaque-checkpoint-131'};
else if (operation === 'timeline.events') data = {revisionId:params.revisionId,state:'ready',coverage:{cuts:{state:'ready'}},rows:[],nextCursor:null};
else if (operation === 'waveform.get') data = {revisionId:params.revisionId,state:'failed',reason:'controlled_decoder_failure'};
else process.exit(10);
console.log(JSON.stringify({ok:true,data}));
`,
      { mode: 0o755 },
    );
    const helper = (name, input) => {
      const result = spawnSync(process.execPath, [join(root, `skills/yap/scripts/${name}.mjs`)], {
        cwd: scratch,
        input,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const request = run(examples["transcript-request"], scratch);
    await writeFile(join(scratch, "transcript-request.json"), request);
    const first = helper("compact-transcripts", request);
    assert.deepEqual(first.selections[0].identity, {
      projectId: "opaque-project-719",
      revisionId: "opaque-revision-531",
    });
    assert.equal(first.continuation.cursor, "opaque-checkpoint-131");
    await writeFile(join(scratch, "compact.json"), JSON.stringify(first));
    const second = helper("compact-transcripts", run(examples["transcript-continuation"], scratch));
    assert.equal(second.continuation, null);
    assert.equal(second.selections[0].rows[0].text, "second");
    const timeline = helper("timeline-inspection", run(examples["timeline-request"], scratch));
    assert.deepEqual(timeline.manifest.identity, first.selections[0].identity);
    assert.equal(timeline.manifest.waveform.state, "failed");
    assert.equal(timeline.manifest.waveform.reason, "controlled_decoder_failure");
    const review = helper("review-bundle", run(examples["review-request"], scratch));
    assert.equal(review.revisions[0].revisionId, revision.data.revision.id);
    assert.equal(review.revisions[0].wholeRevisionExtentVerified, false);
    assert.equal(review.revisions[0].windows[0].inspection.manifest.waveform.state, "failed");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("published caption example preserves selected occurrence pins and returns drafts that report their issues", async () => {
  const reference = await readFile(join(root, "skills/yap/references/helper-examples.md"), "utf8");
  const code = reference.match(/```javascript\n\/\/ caption-request\n([\s\S]*?)```/)[1];
  const scratch = await mkdtemp(join(tmpdir(), "yap-caption-example-"));
  try {
    const sourceRange = { startUs: 0, endUs: 800000 };
    const row = {
      type: "word",
      text: "Hello!",
      ordinal: 13,
      generation: "opaque-generation-17",
      segment: 0,
      assetId: "asset-9",
      streamId: "audio-7",
      clipId: "clip-6",
      trackId: "speech-5",
      sourceRange,
      fragments: [{ source: sourceRange, project: sourceRange }],
    };
    const entry = {
      identity: { projectId: "project-41", revisionId: "revision-71" },
      state: "ready",
      complete: true,
      rows: [row],
    };
    await writeFile(join(scratch, "entry.json"), JSON.stringify(entry));
    await writeFile(
      join(scratch, "caption-settings.json"),
      JSON.stringify({
        rowIndexes: [0],
        trackId: "returned-caption-track-89",
        canvas: { width: 640, height: 360 },
        style: {
          font: { assetId: "admitted-font-92", postScriptName: "ArialMT" },
          width: 500,
          height: 90,
          size: 32,
          color: "#ffffffff",
          alignment: "center",
          wrap: true,
        },
        constraints: {
          widthGraphemes: 24,
          maxLines: 2,
          minDwellUs: 500000,
          maxDwellUs: 3000000,
          maxCps: 30,
          pauseUs: 400000,
          breakOnPunctuation: true,
          separator: " ",
          safeArea: { x: 20, y: 20, width: 600, height: 320 },
        },
      }),
    );
    const request = run(code, scratch);
    const result = spawnSync(
      process.execPath,
      [join(root, "skills/yap/scripts/caption-proposals.mjs")],
      { cwd: scratch, input: request, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.identity, entry.identity);
    assert.deepEqual(output.proposals[0].words, [row]);
    assert.equal(output.proposals[0].clip.trackId, "returned-caption-track-89");
    assert.equal(output.proposals[0].clip.seed.generation, "opaque-generation-17");
    // A draft inside every caller constraint carries no issue; pixel fit is never claimed.
    assert.deepEqual(output.issues, []);
    assert.deepEqual(output.proposals[0].issues, []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("installed Node can discover helper help without contacting Yap", () => {
  for (const name of [
    "compact-transcripts",
    "timeline-inspection",
    "review-bundle",
    "caption-proposals",
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(root, `skills/yap/scripts/${name}.mjs`), "--help"],
      { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith("Usage:"), `${name} returned no usage`);
  }
});
