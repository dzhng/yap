import assert from "node:assert/strict";
import { captionClock } from "./caption-clock.mjs";
import { captionTimedMotion } from "./caption-timed-motion.mjs";
import { captionSeeds } from "./caption-seeds.mjs";
import { styledCaptionSheet } from "./styled-caption-sheet.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } } });
assert.ok(
  [
    "literal-text",
    "alpha",
    "faces",
    "anchors",
    "unicode",
    "repeated-retimed-speech",
    "caption-clock",
    "styled-sheet",
    "timed-motion",
  ].includes(values.case),
);
assert.ok(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await mkdtemp("/tmp/sr-captions-");
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  pictures: [],
  checks: [],
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const ref = (label) => ({ label });
const fixture = join(root, "specs/done/agent-editing/assets/17a-text-layout");
const frozen = JSON.parse(await readFile(join(fixture, "report.json"), "utf8"));
async function admit(path) {
  const pending = await call("asset.import", { requestId: randomUUID(), path });
  const job = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
    "asset",
  );
  return call("asset.get", { assetId: job.published.output.assetId });
}
async function rgba(path) {
  return (
    await run(
      process.env.FFMPEG ?? "ffmpeg",
      ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    )
  ).stdout;
}
async function picture(selection, name) {
  await poll(
    () => call("frame.get", selection),
    (value) => value.state === "ready",
    name,
  );
  const path = join(out, name + ".png");
  const result = await call("frame.get", selection, { output: path });
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: selection });
  assert.equal(mcp.structuredContent.ok, true);
  const bytes = await readFile(path);
  assert.deepEqual(
    Buffer.from(mcp.content.find((content) => content.type === "image").data, "base64"),
    bytes,
  );
  const row = { name, selection, sha256: hash(bytes), receipt: result.published.output };
  report.pictures.push(row);
  return { path, bytes, receipt: row.receipt };
}
async function project(canvas) {
  const created = await call("project.create", { requestId: randomUUID(), canvas });
  let revisionId = created.revision.revisionId;
  const projectId = created.project.projectId;
  return {
    selection: () => ({ projectId, revisionId }),
    async edit(operations) {
      const result = await call("edit.apply", {
        projectId,
        expectedRevisionId: revisionId,
        requestId: randomUUID(),
        operations,
      });
      revisionId = result.revision.revisionId;
      return result;
    },
  };
}
try {
  await service.start();
  const font = await admit(frozen.cases[0].request.fontPath);
  assert.equal(font.assetId, frozen.fontSHA256);
  if (values.case === "literal-text")
    for (const test of frozen.cases.filter((test) => test.receipt && test.name !== "repeat")) {
      const expected = await admit(join(fixture, test.name + ".png"));
      const input = test.request;
      const source = {
        kind: "text",
        text: input.text,
        font: { assetId: font.assetId, postScriptName: test.receipt.font },
        width: input.width,
        height: input.height,
        size: input.size,
        color: "#ffffffff",
        alignment: input.alignment,
        wrap: input.wrap,
      };
      const p = await project({
        width: input.width,
        height: input.height,
        fps: { numerator: 8, denominator: 1 },
        background: "#00000000",
      });
      await p.edit([
        { operation: "track.add", label: "text", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "text-clip",
          clip: {
            trackId: ref("text"),
            source,
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ]);
      const controlProject = await project({
        width: input.width,
        height: input.height,
        fps: { numerator: 8, denominator: 1 },
        background: "#00000000",
      });
      await controlProject.edit([
        { operation: "track.add", label: "control", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          clip: {
            trackId: ref("control"),
            assetId: expected.assetId,
            streamId: expected.streams[0].streamId,
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ]);
      for (const [background, suffix] of [
        ["#00000000", "alpha"],
        ["#000000ff", "black"],
        ["#ffffffff", "white"],
      ]) {
        await p.edit([{ operation: "canvas.set", canvas: { background } }]);
        await controlProject.edit([{ operation: "canvas.set", canvas: { background } }]);
        const actual = await picture({ ...p.selection(), atUs: 0 }, `${test.name}-${suffix}`);
        const control = await picture(
          { ...controlProject.selection(), atUs: 0 },
          `${test.name}-${suffix}-control`,
        );
        assert.deepEqual(
          actual.bytes,
          control.bytes,
          `frozen raster parity: ${test.name}/${suffix}`,
        );
        const layout = actual.receipt.pictures[0].layout;
        assert.deepEqual(layout.lines, test.receipt.lines);
        assert.deepEqual(layout.visibleRange, test.receipt.visibleRange);
        if (suffix === "alpha") {
          assert.deepEqual(
            await rgba(actual.path),
            await rgba(join(fixture, test.name + ".png")),
            `raw RGBA parity: ${test.name}`,
          );
        }
      }
      report.checks.push({ name: test.name, exactFrozenRaster: true, exactLayout: true });
    }
  if (values.case === "repeated-retimed-speech")
    await captionSeeds({ service, call, out, home, font, picture, admit, report });
  if (values.case === "unicode") {
    const p = await project({
      width: 320,
      height: 100,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    });
    const source = {
      kind: "text",
      text: "é",
      font: { assetId: font.assetId, postScriptName: "ArialMT" },
      width: 320,
      height: 100,
      size: 32,
      color: "#ffffffff",
      alignment: "left",
      wrap: true,
    };
    const placed = await p.edit([
      ...["a", "b"].map((label, order) => ({
        operation: "track.add",
        label,
        track: { kind: "video", order },
      })),
      ...[
        ["a", "é"],
        ["b", "e\u0301"],
      ].map(([label, text]) => ({
        operation: "place",
        label: label + "-text",
        clip: {
          trackId: ref(label),
          source: { ...source, text },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      })),
    ]);
    const result = await picture({ ...p.selection(), atUs: 0 }, "distinct-unicode-literals");
    assert.deepEqual(
      result.receipt.pictures.map((picture) => picture.layout.text),
      ["é", "e\u0301"],
    );
    assert.deepEqual(
      result.receipt.pictures.map((picture) => picture.layout.visibleRange),
      [
        [0, 1],
        [0, 2],
      ],
    );
    report.checks.push({
      name: "canonical-equivalent-literals-retain-exact-layout-ranges",
      exactUTF16: true,
    });
    await p.edit([
      { operation: "remove", clipIds: [placed.edit.labels["b-text"]], ripple: "none" },
    ]);
    // Font fallback publishes: the frame draws what the platform chose and names it as an issue.
    for (const [name, text, code, codePoint] of [
      ["fallback", "A😀", "font-substituted", 0x1f600],
      ["missing", "A\uffff", "glyph-missing", 0xffff],
    ]) {
      await p.edit([
        {
          operation: "text.set",
          clipId: placed.edit.labels["a-text"],
          source: { ...source, text },
        },
      ]);
      const result = await poll(
        () => call("frame.get", { ...p.selection(), atUs: 0 }),
        (value) => ["ready", "failed"].includes(value.state),
        name,
      );
      report.checks.push({ name, state: result.state, issues: result.published?.issues });
      assert.equal(result.state, "ready", JSON.stringify(result));
      assert.deepEqual(
        result.published.issues.map(({ code, evidence }) => ({
          code,
          clipId: evidence.clipId,
          requested: evidence.requested,
          codePoints: evidence.codePoints,
        })),
        [
          {
            code,
            clipId: placed.edit.labels["a-text"],
            requested: source.font,
            codePoints: [codePoint],
          },
        ],
      );
      const drawn = await picture({ ...p.selection(), atUs: 0 }, name);
      assert.ok(
        drawn.receipt.pictures[0].layout.lines[0].fonts.includes(
          result.published.issues[0].evidence.used,
        ),
      );
    }
    for (const [name, path, postScriptName, text] of [
      ["color-emoji", "/System/Library/Fonts/Apple Color Emoji.ttc", ".AppleColorEmojiUI", "😀"],
      [
        "devanagari",
        "/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc",
        "DevanagariSangamMN",
        "नमस्ते दुनिया",
      ],
    ]) {
      const imported = await admit(path);
      assert.ok(imported.fontFaces.some((face) => face.postScriptName === postScriptName));
      await p.edit([
        {
          operation: "text.set",
          clipId: placed.edit.labels["a-text"],
          source: {
            ...source,
            text,
            font: { assetId: imported.assetId, postScriptName },
            size: 40,
            verticalAlignment: "center",
            alignment: "center",
          },
        },
      ]);
      const rendered = await picture({ ...p.selection(), atUs: 0 }, name);
      const layout = rendered.receipt.pictures[0].layout;
      assert.equal(layout.text, text);
      assert.deepEqual(layout.visibleRange, [0, text.length]);
      assert.deepEqual([...new Set(layout.lines.flatMap((line) => line.fonts))], [postScriptName]);
      const pixels = await rgba(rendered.path);
      let foregroundPixels = 0,
        coloredPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const channels = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (Math.max(...channels) > 32) foregroundPixels++;
        if (Math.max(...channels) - Math.min(...channels) > 32) coloredPixels++;
      }
      assert.ok(foregroundPixels > 100, `${name}: visible glyphs`);
      if (name === "color-emoji") assert.ok(coloredPixels > 100, "Emoji must retain color");
      report.checks.push({
        name,
        fontAssetId: imported.assetId,
        postScriptName,
        text,
        exactUTF16: true,
        noSubstitutedFonts: true,
        foregroundPixels,
        coloredPixels,
      });
    }
  }
  if (values.case === "anchors") {
    const media = await admit(join(root, "specs/done/agent-editing/assets/00-corpus/a.mov"));
    const stream = media.streams.find((stream) => stream.kind === "video");
    const source = {
      kind: "text",
      text: "Attached caption",
      font: { assetId: font.assetId, postScriptName: "ArialMT" },
      width: 320,
      height: 100,
      size: 32,
      color: "#ffffffff",
      alignment: "left",
      wrap: true,
    };
    const p = await project({
      width: 320,
      height: 100,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    });
    const authored = await p.edit([
      ...["media", "content", "clip", "project"].map((label, order) => ({
        operation: "track.add",
        label,
        track: { kind: "video", order },
      })),
      {
        operation: "place",
        label: "parent",
        clip: {
          trackId: ref("media"),
          assetId: media.assetId,
          streamId: stream.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
        },
      },
      ...[
        [
          "content",
          {
            kind: "content",
            clipId: ref("parent"),
            sourceRange: { startUs: 500000, endUs: 1500000 },
          },
        ],
        [
          "clip",
          {
            kind: "clip",
            clipId: ref("parent"),
            start: { numerator: 1, denominator: 4 },
            end: { numerator: 3, denominator: 4 },
          },
        ],
        ["project", { kind: "project", range: { startUs: 500000, endUs: 1500000 } }],
      ].map(([label, placement]) => ({
        operation: "place",
        label: label + "-text",
        clip: { trackId: ref(label), source, placement },
      })),
    ]);
    async function sample(name, points, counts) {
      const pictures = [];
      for (let i = 0; i < points.length; i++) {
        const result = await picture({ ...p.selection(), atUs: points[i] }, name + "-" + points[i]);
        const texts = result.receipt.pictures.filter((picture) => picture.kind === "text");
        assert.equal(texts.length, counts[i], name + "/" + points[i]);
        assert.ok(texts.every((picture) => picture.status === "available"));
        pictures.push(result.bytes);
      }
      return pictures;
    }
    const points = [0, 500000, 1000000, 1500000];
    const before = await sample("authored", points, [0, 3, 3, 0]);
    await p.edit([{ operation: "split", clipIds: [authored.edit.labels.parent], atUs: 1000000 }]);
    const after = await sample("split", points, [0, 3, 3, 0]);
    assert.deepEqual(after, before);
    report.checks.push({ name: "three-anchor-public-split", exactFrames: true });
    // Restore through the public revision operation, then retime the media owner.
    const restored = await call("edit.restore", {
      projectId: p.selection().projectId,
      expectedRevisionId: p.selection().revisionId,
      targetRevisionId: authored.revision.revisionId,
      requestId: randomUUID(),
    });
    const retimed = await call("edit.apply", {
      projectId: p.selection().projectId,
      expectedRevisionId: restored.revisionId,
      requestId: randomUUID(),
      operations: [
        {
          operation: "retime",
          clipIds: [authored.edit.labels.parent],
          durationUs: 1000000,
          ripple: "none",
        },
      ],
    });
    const selection = {
      projectId: p.selection().projectId,
      revisionId: retimed.revision.revisionId,
    };
    for (const [atUs, expected] of [
      [250000, 2],
      [500000, 3],
      [750000, 1],
      [1250000, 1],
    ]) {
      const result = await picture({ ...selection, atUs }, "retimed-" + atUs);
      assert.equal(
        result.receipt.pictures.filter((picture) => picture.kind === "text").length,
        expected,
      );
    }
    const repeated = await call("edit.apply", {
      projectId: selection.projectId,
      expectedRevisionId: selection.revisionId,
      requestId: randomUUID(),
      operations: [
        {
          operation: "duplicate",
          clipIds: [authored.edit.labels.parent],
          atUs: 2000000,
          copyLabels: [{ clipId: authored.edit.labels.parent, label: "copy" }],
        },
      ],
    });
    for (const [atUs, expected] of [
      [2250000, 2],
      [2500000, 2],
      [2750000, 0],
    ]) {
      const result = await picture(
        { projectId: selection.projectId, revisionId: repeated.revision.revisionId, atUs },
        "repeated-" + atUs,
      );
      assert.equal(
        result.receipt.pictures.filter((picture) => picture.kind === "text").length,
        expected,
      );
    }
    const trimmed = await call("edit.apply", {
      projectId: selection.projectId,
      expectedRevisionId: repeated.revision.revisionId,
      requestId: randomUUID(),
      operations: [
        {
          operation: "trim",
          clipId: repeated.edit.labels.copy,
          range: { startUs: 2500000, endUs: 3000000 },
          ripple: "none",
        },
      ],
    });
    const trimPicture = await picture(
      { projectId: selection.projectId, revisionId: trimmed.revision.revisionId, atUs: 2500000 },
      "trimmed-attachment",
    );
    assert.equal(
      trimPicture.receipt.pictures.filter((picture) => picture.kind === "text").length,
      2,
    );
    report.checks.push({
      name: "retime-repeat-trim-attachments",
      sourceClockOwner: "media",
      projectAnchorUnchanged: true,
    });
  }
  if (values.case === "faces") {
    // OpenType head.unitsPerEm changes metrics without changing the face name.
    // Recalculate the table and whole-font checksums; fixture bytes stay private.
    const modified = Buffer.from(await readFile(frozen.cases[0].request.fontPath));
    const checksum = (bytes) => {
      let sum = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        let word = 0;
        for (let j = 0; j < 4; j++) word = (word * 256 + (bytes[i + j] ?? 0)) >>> 0;
        sum = (sum + word) >>> 0;
      }
      return sum;
    };
    let headRecord;
    for (let i = 0; i < modified.readUInt16BE(4); i++) {
      if (modified.toString("ascii", 12 + 16 * i, 16 + 16 * i) === "head") headRecord = 12 + 16 * i;
    }
    assert.ok(headRecord);
    const offset = modified.readUInt32BE(headRecord + 8),
      length = modified.readUInt32BE(headRecord + 12);
    const originalUnits = modified.readUInt16BE(offset + 18);
    assert.ok(originalUnits * 2 <= 16384);
    modified.writeUInt16BE(originalUnits * 2, offset + 18);
    modified.writeUInt32BE(0, offset + 8);
    modified.writeUInt32BE(checksum(modified.subarray(offset, offset + length)), headRecord + 4);
    modified.writeUInt32BE((0xb1b0afba - checksum(modified)) >>> 0, offset + 8);
    assert.equal(checksum(modified), 0xb1b0afba);
    const changedPath = join(home, "same-name-different-metrics.ttf");
    await writeFile(changedPath, modified);
    const changed = await admit(changedPath);
    assert.notEqual(changed.assetId, font.assetId);
    assert.deepEqual(changed.fontFaces, font.fontFaces);
    const p = await project({
      width: 420,
      height: 100,
      fps: { numerator: 8, denominator: 1 },
      background: "#00000000",
    });
    const source = {
      kind: "text",
      text: "Exact face identity",
      font: { assetId: font.assetId, postScriptName: "ArialMT" },
      width: 420,
      height: 100,
      size: 32,
      color: "#ffffffff",
      alignment: "left",
      wrap: true,
    };
    const placed = await p.edit([
      { operation: "track.add", label: "text", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "text-clip",
        clip: {
          trackId: ref("text"),
          source,
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ]);
    const original = await picture({ ...p.selection(), atUs: 0 }, "original-face");
    await p.edit([
      {
        operation: "text.set",
        clipId: placed.edit.labels["text-clip"],
        source: { ...source, font: { assetId: changed.assetId, postScriptName: "ArialMT" } },
      },
    ]);
    const distinct = await picture({ ...p.selection(), atUs: 0 }, "same-name-distinct-asset");
    assert.notDeepEqual(distinct.bytes, original.bytes);
    assert.equal(
      distinct.receipt.pictures[0].layout.lines[0].width * 2,
      original.receipt.pictures[0].layout.lines[0].width,
    );
    report.checks.push({
      name: "same-face-name-distinct-bytes",
      original: font.assetId,
      changed: changed.assetId,
      unitsPerEm: [originalUnits, originalUnits * 2],
      distinctRaster: true,
      exactHalfWidth: true,
    });
    const donor = p.selection();
    const exportId = randomUUID();
    await call("export.create", {
      ...donor,
      requestId: exportId,
      kind: "processed-package",
      directory: home,
      leaf: "fonts.zip",
    });
    const exported = await poll(
      () => call("export.status", { exportId }),
      (value) => value.state === "ready",
      "font package",
    );
    await rm(changedPath);
    await service.stop();
    service.home = join(home, "recipient");
    await service.start();
    const admission = await call("package.open", { path: exported.output });
    const ready = await poll(
      () => call("package.status", { admissionId: admission.packageId }),
      (value) => value.state === "ready",
      "open font package",
    );
    const adoptionRequestId = randomUUID();
    const adoption = await poll(
      () =>
        call("package.adopt", { packageHandle: ready.packageHandle, requestId: adoptionRequestId }),
      (value) => value.state === "ready",
      "adopt font package",
    );
    const adopted = {
      project: await call("project.get", { projectId: adoption.published.output.projectId }),
      revision: { revisionId: adoption.published.output.revisionId },
    };
    const adoptedCurrent = await picture(
      { projectId: adopted.project.projectId, revisionId: adopted.revision.revisionId, atUs: 0 },
      "adopted-distinct-asset",
    );
    assert.deepEqual(adoptedCurrent.bytes, distinct.bytes);
    const undo = await call("edit.undo", {
      projectId: adopted.project.projectId,
      expectedRevisionId: adopted.revision.revisionId,
      requestId: randomUUID(),
    });
    const adoptedHistory = await picture(
      { projectId: adopted.project.projectId, revisionId: undo.revisionId, atUs: 0 },
      "adopted-original-history",
    );
    assert.deepEqual(adoptedHistory.bytes, original.bytes);
    assert.deepEqual(
      (await call("asset.get", { assetId: font.assetId })).fontFaces,
      font.fontFaces,
    );
    assert.deepEqual(
      (await call("asset.get", { assetId: changed.assetId })).fontFaces,
      changed.fontFaces,
    );
    report.checks.push({
      name: "font-history-package-fresh-store",
      currentRasterExact: true,
      undoRasterExact: true,
      originalFontIdsPreserved: true,
    });
    await service.stop();
    service.home = home;
    await service.start();
    const collection = await admit("/System/Library/Fonts/Supplemental/AlBayan.ttc");
    const rasters = [];
    for (const postScriptName of ["AlBayan", "AlBayan-Bold"]) {
      assert.ok(collection.fontFaces.some((face) => face.postScriptName === postScriptName));
      await p.edit([
        {
          operation: "text.set",
          clipId: placed.edit.labels["text-clip"],
          source: {
            ...source,
            text: "مرحبا بالعالم",
            font: { assetId: collection.assetId, postScriptName },
          },
        },
      ]);
      const result = await picture({ ...p.selection(), atUs: 0 }, postScriptName);
      assert.equal(result.receipt.pictures[0].layout.font.postScriptName, postScriptName);
      rasters.push(result.bytes);
    }
    assert.notDeepEqual(...rasters);
    report.checks.push({
      name: "collection-face-raster-selection",
      assetId: collection.assetId,
      distinctRaster: true,
    });
  }
  if (values.case === "alpha") {
    const source = {
      kind: "text",
      text: "Alpha",
      font: { assetId: font.assetId, postScriptName: "ArialMT" },
      width: 320,
      height: 100,
      size: 32,
      color: "#ffffffff",
      alignment: "left",
      wrap: true,
    };
    const p = await project({
      width: 320,
      height: 100,
      fps: { numerator: 8, denominator: 1 },
      background: "#12345680",
    });
    const placed = await p.edit([
      { operation: "track.add", label: "text", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "text-clip",
        clip: {
          trackId: ref("text"),
          source,
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ]);
    const png = await picture({ ...p.selection(), atUs: 0 }, "half-alpha");
    const pixels = await rgba(png.path);
    assert.equal(pixels.at(-1), 128);
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value === 255));
    async function preview(name, expected) {
      const result = await poll(
        () => call("preview.get", p.selection()),
        (value) => ["ready", "failed"].includes(value.state),
        name,
      );
      assert.equal(result.state, expected, JSON.stringify(result));
      if (expected === "failed") {
        const job = await call("job.get", { jobId: result.jobId });
        assert.equal(job.errorCode, "NOT_READY");
        assert.match(job.reason, /opaque/i);
        report.checks.push({ name, result, job });
      } else report.checks.push({ name, result });
    }
    await preview("translucent-canvas-movie-refused", "failed");
    await p.edit([{ operation: "canvas.set", canvas: { background: "#000000ff" } }]);
    await preview("opaque-text-movie-ready", "ready");
    const range = { startUs: 250000, endUs: 750000 };
    const movie = join(out, "text-full.mp4");
    const rangeMovie = join(out, "text-range.mp4");
    await poll(
      () => call("preview.get", { ...p.selection(), range }, { output: rangeMovie }),
      (value) => value.state === "ready",
      "text range preview",
    );
    await poll(
      () => call("preview.get", p.selection(), { output: movie }),
      (value) => value.state === "ready",
      "text full preview",
    );
    const exportId = randomUUID();
    await call("export.create", {
      ...p.selection(),
      requestId: exportId,
      kind: "video",
      directory: out,
      leaf: "text-export.mp4",
    });
    const exported = await poll(
      () => call("export.status", { exportId }),
      (value) => value.state === "ready",
      "text range export",
    );
    assert.deepEqual(await readFile(movie), await readFile(exported.output));
    report.checks.push({ name: "text-range-preview-and-full-export", exactFullBytes: true, range });

    await p.edit([
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ label: "half", processor: { type: "opacity", opacity: 0.5 } }],
      },
    ]);
    await preview("output-alpha-movie-refused", "failed");
    await p.edit([
      { operation: "processing.set", target: { kind: "output" }, steps: [] },
      { operation: "canvas.set", canvas: { background: "#00000000" } },
    ]);
    await preview("transparent-text-movie-refused", "failed");
    const opaquePath = join(home, "opaque.png");
    await run("/opt/homebrew/bin/ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=320x100",
      "-frames:v",
      "1",
      opaquePath,
    ]);
    const opaque = await admit(opaquePath);
    await p.edit([
      { operation: "track.add", label: "opaque", track: { kind: "video", order: 1 } },
      {
        operation: "place",
        label: "opaque-clip",
        clip: {
          trackId: ref("opaque"),
          assetId: opaque.assetId,
          streamId: opaque.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ]);
    await preview("opaque-cover-on-transparent-canvas-ready", "ready");
    await p.edit([
      {
        operation: "move",
        clipIds: [placed.edit.labels["text-clip"]],
        atUs: 2000000,
        ripple: "none",
      },
    ]);
    await preview("transparent-gap-movie-refused", "failed");
  }
  if (values.case === "caption-clock")
    await captionClock({ call, out, font, project, admit, picture, report });
  if (values.case === "timed-motion")
    await captionTimedMotion({ call, out, home, font, project, admit, picture, report, rgba });
  if (values.case === "styled-sheet")
    await styledCaptionSheet({ project, picture, font, report, rgba });
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, out }));
