import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JourneyService, poll, run, hash, mcpReceiveBytes } from "./source-evidence-fixture.mjs";
import { writeSourceWave, sample } from "./audio-project-fixture.mjs";
import { transcriptDurationFixture } from "./transcript-duration-fixture.mjs";
import { sourceEventDurationFixture } from "./source-event-duration-fixture.mjs";

const { values } = parseArgs({
  options: { out: { type: "string" }, query: { type: "string", default: "timeline" } },
});
assert.ok(process.env.YAP_NATIVE);
assert.ok(
  ["timeline", "waveform", "transcript", "transcript-search", "events", "cursor"].includes(
    values.query,
  ),
);
const out = values.out ? resolve(values.out) : await mkdtemp("/tmp/yap-duration-memory-");
await mkdir(out, { recursive: true });
const source = join(out, "source.wav");
const search = values.query === "transcript-search";
const hasTranscript = search || values.query === "transcript";
const capture = values.query === "events" || values.query === "cursor";
if (!capture) await writeSourceWave(source, { source: 0, seconds: hasTranscript ? 6 : 1 });
const transcript = hasTranscript ? await transcriptDurationFixture(out, source) : undefined;
if (search) assert.equal(transcript.words[1].text, "so");
const occurrences = 10000,
  clipUs = transcript ? 320000 : 100000,
  rowsPerQuery = 250;
const report = {
  passed: false,
  scope:
    "Sampled service resident memory for equal-cardinality two/four-hour " +
    values.query +
    " queries; no native decode or movie memory claim",
  query: values.query,
  ...(!capture ? { sourceSha256: hash(await readFile(source)) } : {}),
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  harnessSha256: hash(await readFile(import.meta.filename)),
  nodeVersion: process.version,
  mcpReceiveBytes,
  controls: { occurrences, clipUs, rowsPerQuery, repeats: 20, trialsPerDuration: 3 },
  ...(transcript ? { transcriptFixture: transcript.evidence } : {}),
  ...(search ? { searchText: "so" } : {}),
  cases: [],
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
try {
  // Alternate order to avoid assigning all earlier/later machine conditions to one duration.
  for (const seconds of [7200, 14400, 14400, 7200, 7200, 14400]) {
    const home = await realpath(await mkdtemp("/tmp/sr-duration-memory-"));
    const trial = { seconds, home, trace: [], samples: [], queryMs: [] };
    report.cases.push(trial);
    const nativeConfiguration = capture
      ? join(out, `capture-service-${report.cases.length}.json`)
      : undefined;
    if (capture) {
      trial.nativeOperationsFile = join(out, `native-operations-${report.cases.length}.jsonl`);
      await writeFile(
        nativeConfiguration,
        JSON.stringify({
          sources: [],
          allowedOperations: [
            "media.probe",
            "media.sourceEvidence",
            "media.sourceVisualSamples",
            "storage.clearRenderWorkspace",
          ],
          operationsFile: trial.nativeOperationsFile,
        }),
      );
    }
    const service = transcript
      ? new JourneyService(
          home,
          trial,
          await transcript.configure(trial, report.cases.length),
          new URL("./transcript-fixture-service.mjs", import.meta.url),
        )
      : capture
        ? new JourneyService(
            home,
            trial,
            nativeConfiguration,
            new URL("./evidence-service.mjs", import.meta.url),
          )
        : new JourneyService(home, trial);
    const call = (operation, params) => service.call(operation, params, { transport: "mcp" });
    let sampling,
      sampleError,
      stopped = false;
    try {
      await service.start();
      let asset, events;
      if (capture) {
        events = await sourceEventDurationFixture({
          mode: values.query,
          home,
          out: join(out, `source-events-${report.cases.length}`),
          call,
        });
        asset = events.asset;
        trial.sourceEvents = events.record;
      } else {
        const imported = await call("asset.import", { path: source, requestId: "source" });
        const ready = await poll(
          () => call("job.get", { jobId: imported.jobId }),
          (x) => x.state === "ready",
          "source import",
        );
        asset = await call("asset.get", { assetId: ready.published.output.assetId });
      }
      let generation;
      if (transcript) {
        await call("transcript.transcribe", {
          assetId: asset.assetId,
          streamId: asset.streams[0].streamId,
        });
        const sourceWords = await poll(
          () =>
            call("transcript.get", {
              assetId: asset.assetId,
              streamId: asset.streams[0].streamId,
              limit: 1000,
            }),
          (x) => x.state === "ready",
          "source transcript ingestion",
        );
        generation = sourceWords.generation;
        trial.sourceTranscript = sourceWords;
        assert.deepEqual(
          sourceWords.rows
            .filter((row) => row.type === "word")
            .slice(0, 5)
            .map((row) => ({ text: row.text, source: row.sourceRange })),
          transcript.words.map((word) => ({ text: word.text, source: word.source })),
        );
      }
      const made = await call("project.create", {
        requestId: "project",
        canvas: {
          width: 16,
          height: 16,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
      });
      const projectId = made.project.projectId;
      let revisionId = made.revision.revisionId;
      const apply = async (operations, requestId) => {
        const result = await call("edit.apply", {
          projectId,
          expectedRevisionId: revisionId,
          requestId,
          operations,
        });
        revisionId = result.revision.revisionId;
        return result;
      };
      const track = (
        await apply(
          [
            {
              operation: "track.add",
              label: "track",
              track: { kind: capture ? "video" : "audio", order: 0 },
            },
          ],
          "track",
        )
      ).edit.labels.track;
      let lastRevision;
      const durationUs = seconds * 1e6;
      const starts = Array.from({ length: occurrences }, (_, i) =>
        Math.floor((i * (durationUs - clipUs)) / (occurrences - 1)),
      );
      const clipIds = [];
      const clipLabel = (index) => `${capture ? "event" : "word"}-${index}`;
      for (let first = 0; first < occurrences; first += 500) {
        const placed = await apply(
          starts.slice(first, first + 500).map((startUs, offset) => ({
            operation: "place",
            ...(transcript || capture ? { label: clipLabel(first + offset) } : {}),
            clip: {
              trackId: track,
              ...(events?.selection ?? {
                assetId: asset.assetId,
                streamId: asset.streams[0].streamId,
              }),
              source: {
                kind: "range",
                range: transcript
                  ? transcript.words[(first + offset) % 5].source
                  : (events?.sourceRange ?? { startUs: 0, endUs: clipUs }),
              },
              placement: { kind: "project", range: { startUs, endUs: startUs + clipUs } },
            },
          })),
          `place-${first}`,
        );
        lastRevision = placed.revision;
        if (transcript || capture)
          for (let offset = 0; offset < 500; offset++)
            clipIds.push(placed.edit.labels[clipLabel(first + offset)]);
      }
      trial.projectId = projectId;
      trial.revisionId = revisionId;
      if (transcript || capture) {
        assert.equal(lastRevision.ordinal, 21);
        assert.equal(lastRevision.document.clips.length, occurrences);
        assert.equal(lastRevision.document.tracks.length, 1);
        assert.equal(lastRevision.document.groups.length, 0);
        if (capture) assert.deepEqual(lastRevision.document.processing, []);
        trial.revisionOrdinal = lastRevision.ordinal;
        trial.documentSha256 = hash(Buffer.from(JSON.stringify(lastRevision.document)));
      }
      // Authoring allocations cannot inflate this process's query memory baseline.
      await service.stop();
      if (capture) {
        trial.preparationNativeOperations = (await readFile(trial.nativeOperationsFile, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert(
          !trial.preparationNativeOperations.some(
            ({ operation }) => operation === "speech.transcribe",
          ),
        );
        if (values.query === "events")
          assert(
            trial.preparationNativeOperations.some(
              ({ operation }) => operation === "media.sourceVisualSamples",
            ),
          );
        trial.queryNativeOperationsFile = join(
          out,
          `query-native-operations-${report.cases.length}.jsonl`,
        );
        await writeFile(trial.queryNativeOperationsFile, "");
        await writeFile(
          nativeConfiguration,
          JSON.stringify({
            sources: [],
            allowedOperations: ["storage.clearRenderWorkspace"],
            operationsFile: trial.queryNativeOperationsFile,
          }),
        );
      }
      await service.start();
      trial.queryPid = service.child.pid;
      const rss = async () => {
        const bytes =
          Number((await run("ps", ["-o", "rss=", "-p", String(trial.queryPid)])).stdout.trim()) *
          1024;
        assert.ok(Number.isFinite(bytes) && bytes > 0);
        return bytes;
      };
      trial.baselineBytes = await rss();
      sampling = (async () => {
        while (!stopped) {
          trial.samples.push({ atMs: performance.now(), bytes: await rss() });
          await delay(20);
        }
      })().catch((error) => {
        sampleError = error;
        trial.samplerError = { message: error.message };
        stopped = true;
      });
      const expected = starts
        .flatMap((startUs) => [startUs, startUs + clipUs])
        .filter((x) => x > 0 && x < durationUs)
        .sort((a, b) => a - b)
        .slice(0, rowsPerQuery);
      const readTimeline = async () => {
        const rows = [];
        let cursor,
          pages = 0;
        do {
          const page = await poll(
            () =>
              call("timeline.events", {
                projectId,
                revisionId,
                range: { startUs: 0, endUs: durationUs },
                limit: rowsPerQuery - rows.length,
                ...(cursor ? { cursor } : {}),
              }),
            (x) => x.state === "ready",
            "query page",
          );
          rows.push(...page.rows);
          cursor = page.nextCursor;
          assert.ok(++pages <= 100, "Continuation must make bounded progress");
        } while (rows.length < rowsPerQuery && cursor);
        assert.deepEqual(
          rows.map((r) => r.kind),
          expected.map(() => "cut"),
        );
        assert.deepEqual(
          rows.map((r) => r.projectAtUs),
          expected,
        );
        return hash(Buffer.from(JSON.stringify(rows)));
      };
      const expectedWords = transcript
        ? Array.from({ length: rowsPerQuery }, (_, row) => {
            const index = search ? 1 + row * 5 : row,
              startUs = starts[index],
              ordinal = index % 5,
              word = transcript.words[ordinal];
            return {
              type: "word",
              wordId: `w${ordinal}`,
              ordinal,
              text: word.text,
              kind: "speech",
              confidence: word.confidence,
              segment: 0,
              sourceRange: word.source,
              partial: false,
              clipId: clipIds[index],
              assetId: asset.assetId,
              streamId: asset.streams[0].streamId,
              trackId: track,
              trackRank: 0,
              generation,
              fragments: [{ source: word.source, project: { startUs, endUs: startUs + clipUs } }],
            };
          })
        : undefined;
      const expectedTranscript = search
        ? expectedWords.map((word) => ({
            trackId: track,
            trackRank: 0,
            words: [word],
            projectRange: word.fragments[0].project,
          }))
        : expectedWords;
      if (transcript)
        await writeFile(
          join(out, `transcript-expected-${report.cases.length}.json`),
          JSON.stringify(expectedTranscript, null, 2),
        );
      const expectedEvidence = events
        ? events.expected({
            starts,
            clipIds,
            trackId: track,
            durationUs,
            clipUs,
            limit: rowsPerQuery,
          })
        : expectedTranscript;
      if (capture)
        await writeFile(
          join(out, `events-expected-${report.cases.length}.json`),
          JSON.stringify(expectedEvidence, null, 2),
        );
      const readEvidence = async (transport = "mcp") => {
        const rows = [],
          pages = [],
          checkpoints = new Set();
        let cursor;
        do {
          const params = {
            projectId,
            revisionId,
            ...(search ? { text: "so" } : {}),
            limit:
              search || capture
                ? rowsPerQuery - rows.length
                : Math.min(125, rowsPerQuery - rows.length),
            ...(cursor ? { cursor } : {}),
          };
          const page = await poll(
            () =>
              service.call(
                events?.operation ?? (search ? "transcript.search" : "transcript.get"),
                params,
                { transport },
              ),
            (value) => value.state === "ready",
            "evidence page",
          );
          assert.equal(page.projectId, projectId);
          assert.equal(page.revisionId, revisionId);
          if (cursor) {
            // A continuation names only the manifest it reads; the opaque cursor no longer shows it.
            assert.deepEqual(Object.keys(page.dependencies), ["manifestId"]);
          } else {
            assert.equal(page.dependencies.length, 1);
            if (events) {
              assert.deepEqual(page.dependencies[0].selection, events.selection);
              assert.deepEqual(page.dependencies[0].capture, events.record.source.context);
            } else {
              assert.equal(page.dependencies[0].transcript.generation, generation);
              assert.deepEqual(page.dependencies[0].transcript.engine, transcript.engine);
            }
          }
          const delivered = search ? page.entries : page.rows;
          if (!search && !capture)
            assert.ok(delivered.length > 0, "Transcript continuation must progress");
          assert.notDeepEqual(page.nextCursor, cursor);
          if (page.nextCursor) {
            // Cursors are opaque: a repeat is a repeated checkpoint. The service itself refuses
            // a cursor replayed against a different query, so its pinned fields are not read here.
            const next = page.nextCursor;
            assert(!checkpoints.has(next), "Evidence continuation repeated a checkpoint");
            checkpoints.add(next);
          }
          rows.push(...delivered);
          pages.push({ params, response: page });
          cursor = page.nextCursor;
          assert.ok(
            pages.length <= (search || capture ? 100 : 10),
            "Evidence continuation must remain bounded",
          );
        } while (rows.length < rowsPerQuery && cursor);
        assert.deepEqual(
          rows,
          expectedEvidence,
          "Frozen evidence and independently authored occurrence clocks differ",
        );
        assert.ok(cursor, "A bounded prefix must retain a continuation for remaining occurrences");
        const family = capture ? "events" : "transcript";
        const field = family + (transport === "cli" ? "CLIPages" : "Pages");
        if (!trial[field]) {
          trial[field] =
            `${family}-${transport === "cli" ? "cli-" : ""}pages-${report.cases.length}.json`;
          await writeFile(join(out, trial[field]), JSON.stringify(pages, null, 2));
          if (transport === "mcp") trial[family + "PageCount"] = pages.length;
        }
        return hash(Buffer.from(JSON.stringify(rows)));
      };
      const waveformRange = { startUs: durationUs - 250000, endUs: durationUs };
      const windowStart = seconds * 48000 - 12000;
      const expectedBuckets =
        values.query === "waveform"
          ? Array.from({ length: rowsPerQuery }, (_, bucket) => {
              const gridStart = windowStart + bucket * 48;
              return {
                gridStart,
                sampleRange: { start: gridStart, end: gridStart + 48 },
                partial: false,
                channels: [0, 1].map((channel) => {
                  // The last 100ms occurrence begins after 150ms of authored empty space.
                  const samples = Array.from({ length: 48 }, (_, i) => {
                    const local = bucket * 48 + i - 7200;
                    return local < 0 ? 0 : sample(0, local, channel) / 32768;
                  });
                  return {
                    min: Math.min(...samples),
                    max: Math.max(...samples),
                    rms: Math.sqrt(
                      samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
                    ),
                  };
                }),
              };
            })
          : undefined;
      const readWaveform = async () => {
        const params = {
          projectId,
          revisionId,
          range: waveformRange,
          bucketFrames: 48,
          format: "json",
        };
        let delivered;
        const ready = await poll(
          async () => {
            delivered = await service.mcp.callTool({ name: "waveform.get", arguments: params });
            assert.equal(delivered.structuredContent?.ok, true);
            trial.trace.push({
              operation: "waveform.get",
              transport: "mcp",
              state: delivered.structuredContent.data.state,
            });
            return delivered.structuredContent.data;
          },
          (value) => value.state === "ready",
          "waveform delivery",
        );
        assert.equal(delivered.content.length, 2);
        assert.equal(delivered.content[1].type, "text");
        const text = delivered.content[1].text,
          document = JSON.parse(text);
        assert.equal(document.domain, "project");
        assert.equal(document.projectId, projectId);
        assert.equal(document.revisionId, revisionId);
        assert.deepEqual(document.range, waveformRange);
        assert.deepEqual(document.sampleRange, { start: windowStart, end: seconds * 48000 });
        assert.equal(document.sampleRate, 48000);
        assert.equal(document.channels, 2);
        assert.equal(document.bucketFrames, 48);
        assert.deepEqual(document.buckets, expectedBuckets);
        assert.equal(ready.published.output.sizeBytes, Buffer.byteLength(text));
        if (!trial.waveform) {
          const file = `waveform-${report.cases.length}-${seconds}.json`;
          await writeFile(join(out, file), text);
          trial.waveform = {
            file,
            receipt: ready,
            buckets: document.buckets.length,
            measurementSha256: hash(
              Buffer.from(JSON.stringify(document.buckets.map((row) => row.channels))),
            ),
          };
        }
        return hash(Buffer.from(text));
      };
      const read =
        transcript || capture
          ? readEvidence
          : values.query === "waveform"
            ? readWaveform
            : readTimeline;
      const coldAt = performance.now();
      trial.rowsSha256 = await read();
      trial.coldMs = performance.now() - coldAt;
      for (let repeat = 0; repeat < report.controls.repeats; repeat++) {
        const at = performance.now();
        assert.equal(await read(), trial.rowsSha256);
        trial.queryMs.push(performance.now() - at);
      }
      if (values.query === "waveform" || transcript || capture) {
        trial.queryP95Ms = [...trial.queryMs].sort((a, b) => a - b)[
          Math.ceil(trial.queryMs.length * 0.95) - 1
        ];
      }
      stopped = true;
      await sampling;
      if (sampleError) throw sampleError;
      trial.sampledPeakBytes = Math.max(...trial.samples.map((s) => s.bytes));
      trial.sampledGrowthBytes = Math.max(0, trial.sampledPeakBytes - trial.baselineBytes);
      assert.ok(
        trial.samples.length >= 10,
        "Not enough resident samples to assess the query workload",
      );
      assert.ok(trial.sampledGrowthBytes > 0, "Query allocation growth was not observable");
      if (transcript || capture) {
        assert.equal(
          await readEvidence("cli"),
          trial.rowsSha256,
          "CLI and MCP evidence pages differ",
        );
        const operations = (
          await readFile(
            capture ? trial.queryNativeOperationsFile : trial.nativeOperationsFile,
            "utf8",
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        assert.deepEqual(
          operations.filter(({ operation }) => operation !== "storage.clearRenderWorkspace"),
          capture ? [] : [{ operation: "media.probe" }, { operation: "speech.transcribe" }],
          "Querying must not run inference again or decode timeline audio",
        );
      }
      if (values.query === "waveform" || transcript || capture)
        assert.ok(
          trial.queryP95Ms <= 250,
          "Cached250-row inspection exceeded unchanged250ms p95 budget",
        );
    } finally {
      stopped = true;
      if (sampling) await sampling;
      try {
        await service.stop();
      } finally {
        try {
          await writeFile(join(out, `service-${report.cases.length}.log`), service.logs.join(""));
          await save();
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
    }
  }
  const cohort = (seconds, field) =>
    median(report.cases.filter((c) => c.seconds === seconds).map((c) => c[field]));
  report.comparison = {
    twoHourMedianPeakBytes: cohort(7200, "sampledPeakBytes"),
    fourHourMedianPeakBytes: cohort(14400, "sampledPeakBytes"),
    twoHourMedianGrowthBytes: cohort(7200, "sampledGrowthBytes"),
    fourHourMedianGrowthBytes: cohort(14400, "sampledGrowthBytes"),
  };
  report.comparison.peakRatio =
    report.comparison.fourHourMedianPeakBytes / report.comparison.twoHourMedianPeakBytes;
  report.comparison.growthRatio =
    report.comparison.fourHourMedianGrowthBytes / report.comparison.twoHourMedianGrowthBytes;
  report.passed = report.comparison.peakRatio < 2 && report.comparison.growthRatio < 2;
  await save();
  assert.ok(
    report.passed,
    "Doubling timeline duration doubled observed bounded-query memory; retain report and profile",
  );
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await save();
}
console.log(out);
