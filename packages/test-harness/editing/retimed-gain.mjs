import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";
import { writeSourceWave, waveHeader } from "./audio-project-fixture.mjs";

// This small delivery gate uses no composition evaluator for its expected envelope.
export async function runRetimedGain(output) {
  assert(output && process.env.YAP_NATIVE);
  const out = resolve(output);
  await mkdir(out);
  const home = await mkdtemp(join(tmpdir(), "yap-retimed-gain-"));
  const report = {
    passed: false,
    trace: [],
    exchanges: [],
    cases: [],
    workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
    harnessSha256: hash(await readFile(new URL(import.meta.url))),
    scope:
      "Delivered retimed stereo PCM and independent animated envelope; no listening or playback",
    maximumAbsolutePcmError: 1e-7,
  };
  const service = new JourneyService(home, report),
    call = service.call.bind(service);
  const f = Math.fround,
    fraction = (numerator, denominator = 1) => ({ numerator, denominator });
  const sampleAt = (us) => Math.floor((us * 48000) / 1000000);
  const startUs = 300001,
    endUs = 1550001,
    splitUs = 933333;
  const smooth = (t) => {
    t = Math.max(0, Math.min(1, t));
    return 3 * t * t - 2 * t * t * t;
  };
  async function audio(selection, name) {
    const result = await poll(
      () => call("audio.get", selection),
      (v) => v.state === "ready",
      name,
    );
    const path = join(out, name + ".wav");
    await call("audio.get", selection, { output: path });
    const bytes = await readFile(path),
      header = waveHeader(bytes, bytes.length);
    const pcm = bytes.subarray(header.offset);
    assert.equal(result.published.output.frameCount, pcm.length / 8);
    assert.equal(result.published.output.channels, 2);
    assert.equal(result.published.output.sampleRate, 48000);
    const mcp = await service.mcp.callTool({ name: "audio.get", arguments: selection });
    assert.equal(mcp.structuredContent.ok, true);
    assert.deepEqual(
      Buffer.from(mcp.content.find((v) => v.type === "audio").data, "base64"),
      bytes,
    );
    return { pcm, receipt: result.published.output, sha256: hash(pcm) };
  }
  try {
    const source = join(out, "source.wav");
    await writeSourceWave(source, { source: 0, seconds: 2 });
    report.sourceSha256 = hash(await readFile(source));
    await service.start();
    const admitted = await call("asset.import", { requestId: randomUUID(), path: source });
    await poll(
      () => call("job.get", { jobId: admitted.jobId }),
      (v) => v.state === "ready",
      "source",
    );
    const asset = await call("asset.get", { assetId: report.sourceSha256 });
    for (const pitch of ["preserve", "follow"])
      for (const anchor of ["clip", "content", "project"]) {
        const created = await call("project.create", {
          requestId: randomUUID(),
          canvas: {
            width: 64,
            height: 48,
            fps: { numerator: 30, denominator: 1 },
            background: "#000000ff",
          },
        });
        const projectId = created.project.projectId;
        let revisionId = created.revision.revisionId;
        const edit = async (operations) => {
          const result = await call(
            "edit.apply",
            { projectId, expectedRevisionId: revisionId, requestId: randomUUID(), operations },
            { transport: "mcp" },
          );
          revisionId = result.revision.revisionId;
          return result;
        };
        const placed = await edit([
          { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
          {
            operation: "place",
            label: "clip",
            clip: {
              trackId: { label: "track" },
              assetId: asset.assetId,
              streamId: asset.streams.find((v) => v.kind === "audio").streamId,
              source: { kind: "range", range: { startUs: 200000, endUs: 1200000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
            },
          },
        ]);
        const clipId = placed.edit.labels.clip;
        const window =
          anchor === "clip"
            ? { kind: "clip", clipId, start: fraction(1, 5), end: fraction(4, 5) }
            : anchor === "content"
              ? { kind: "content", clipId, sourceRange: { startUs: 400000, endUs: 1000000 } }
              : { kind: "project", range: { startUs: fraction(1500004, 3), endUs: 1100001 } };
        const keys =
          anchor === "clip"
            ? [fraction(0), fraction(1)]
            : anchor === "content"
              ? [200000, 1200000]
              : [0, 1000000];
        await edit([
          {
            operation: "processing.set",
            target: { kind: "clip", id: clipId },
            steps: [
              {
                processor: {
                  type: "gain",
                  gain: {
                    keys: [
                      { at: keys[0], value: 0.25, interpolation: { cubic: [1 / 3, 0, 2 / 3, 1] } },
                      { at: keys[1], value: 1.25, interpolation: "hold" },
                    ],
                  },
                },
                window,
              },
            ],
          },
        ]);
        await edit([
          { operation: "move", clipIds: [clipId], atUs: startUs, ripple: "none" },
          { operation: "retime", clipIds: [clipId], durationUs: 1250000, pitch, ripple: "none" },
        ]);
        const selection = { projectId, revisionId, range: { startUs, endUs } };
        const dry = await audio(
          { ...selection, tap: { target: { kind: "clip", id: clipId }, point: { kind: "dry" } } },
          `${pitch}-${anchor}-dry`,
        );
        const processed = await audio(selection, `${pitch}-${anchor}-processed`);
        assert.equal(processed.pcm.length, (sampleAt(endUs) - sampleAt(startUs)) * 8);
        assert.equal(dry.pcm.length, processed.pcm.length);
        const activeStart = sampleAt(anchor === "project" ? 1500004 / 3 : startUs + 250000);
        const activeEnd = sampleAt(anchor === "project" ? 1100001 : startUs + 1000000);
        let maximum = 0,
          wrongPhaseMaximum = 0;
        for (let i = 0; i < processed.pcm.length / 8; i++) {
          const global = sampleAt(startUs) + i;
          const t =
            anchor === "project"
              ? global / 48000
              : (global * 1000000 - startUs * 48000) / (1250000 * 48000);
          const active = global >= activeStart && global < activeEnd;
          const gain = f(active ? 0.25 + smooth(t) : 1);
          const wrongGain = f(active ? 0.25 + smooth(global / 48000) : 1);
          for (let c = 0; c < 2; c++) {
            const raw = dry.pcm.readFloatLE(i * 8 + c * 4),
              actual = processed.pcm.readFloatLE(i * 8 + c * 4);
            const error = Math.abs(actual - f(raw * gain));
            maximum = Math.max(maximum, error);
            wrongPhaseMaximum = Math.max(wrongPhaseMaximum, Math.abs(actual - f(raw * wrongGain)));
            assert(
              error <= report.maximumAbsolutePcmError,
              `${pitch}/${anchor} sample${global}/${c}: ${error}`,
            );
          }
        }
        if (anchor !== "project")
          assert(
            wrongPhaseMaximum > 0.01,
            "Envelope oracle must distinguish project and retained clocks",
          );
        const left = await audio(
          { ...selection, range: { startUs, endUs: splitUs } },
          `${pitch}-${anchor}-left`,
        );
        const right = await audio(
          { ...selection, range: { startUs: splitUs, endUs } },
          `${pitch}-${anchor}-right`,
        );
        assert.deepEqual(Buffer.concat([left.pcm, right.pcm]), processed.pcm);
        await edit([{ operation: "split", clipIds: [clipId], atUs: splitUs }]);
        const split = await audio({ ...selection, revisionId }, `${pitch}-${anchor}-split`);
        assert.deepEqual(split.pcm, processed.pcm);
        report.cases.push({
          pitch,
          anchor,
          maximumPcmError: maximum,
          wrongProjectPhaseMaximum: wrongPhaseMaximum,
          drySha256: dry.sha256,
          processedSha256: processed.sha256,
          frames: processed.pcm.length / 8,
          activeSamples: { start: activeStart, end: activeEnd },
          joinedRangesExact: true,
          splitExact: true,
          receipt: processed.receipt,
        });
        await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
    assert.equal(hash(await readFile(source)), report.sourceSha256);
    report.passed = true;
  } finally {
    await service.stop();
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await rm(home, { recursive: true, force: true });
  }
}
