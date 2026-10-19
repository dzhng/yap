import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { compactTranscripts } from "./compact-transcripts.mjs";
import { createCli } from "./yap-cli.mjs";
import {
  budget,
  failure,
  readTaskFile as readDelivered,
  runJsonHelper,
} from "./inspection-artifacts.mjs";

const active = new Set(["queued", "running"]);
const number = (value) => (typeof value === "number" ? value : value.numerator / value.denominator);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );
const errorRecord = (error) => ({
  state: "error",
  error: { code: error.code ?? "INSPECTION_FAILED", message: error.message },
});
const span = (row) =>
  row.fragments?.map((fragment) => fragment.project) ?? (row.sourceRange ? [row.sourceRange] : []);

/** Owner-produced coordinates remain exact in the manifest; pixels are display only. */
export function timelineSvg(manifest, images) {
  const { width, maxWords } = manifest.budgets;
  const range = manifest.range;
  const left = 140,
    plot = width - left - 35;
  const x = (at) =>
    left +
    Math.max(0, Math.min(1, (number(at) - range.startUs) / (range.endUs - range.startUs))) * plot;
  const elements = [];
  let y = 68;
  const text = (at, top, value, color = "#dce4ef", size = 12) =>
    elements.push(
      `<text x="${at}" y="${top}" fill="${color}" font-size="${size}">${escape(value)}</text>`,
    );
  const rect = (at, top, w, h, fill) =>
    elements.push(
      `<rect x="${at}" y="${top}" width="${Math.max(0, w)}" height="${h}" fill="${fill}"/>`,
    );
  const line = (a, b, c, d, color, strokeWidth = 1) =>
    elements.push(
      `<path d="M${a} ${b}L${c} ${d}" stroke="${color}" stroke-width="${strokeWidth}"/>`,
    );
  text(
    20,
    25,
    `${manifest.domain} timeline — ${manifest.identity.revisionId ?? manifest.identity.assetId}`,
    "#fff",
    16,
  );
  text(
    20,
    45,
    "Display axis only · exact evidence and availability are retained in the manifest",
    "#9aadc6",
  );
  for (let tick = 0; tick <= 4; tick++) {
    const at = range.startUs + ((range.endUs - range.startUs) * tick) / 4;
    line(x(at), y - 7, x(at), y + 8, "#72849b");
    text(Math.min(width - 82, x(at)), y + 26, `${(at / 1_000_000).toFixed(3)} s`);
  }
  y += 45;
  text(20, y + 15, "Pictures");
  const cell = plot / Math.max(1, manifest.frames.length);
  if (!manifest.frames.length)
    text(
      left,
      y + 35,
      (manifest.pictureRequests ?? manifest.budgets.frames) === 0
        ? "Pictures: unselected · no frame requests"
        : "Pictures: no frame evidence returned",
      "#ffb38a",
    );
  for (const [index, entry] of manifest.frames.entries()) {
    const start = left + index * cell;
    const data = entry.data;
    elements.push(
      `<rect x="${start}" y="${y}" width="${cell - 8}" height="124" rx="4" fill="#172438" stroke="#516078"/>`,
    );
    if (images[index])
      elements.push(
        `<image x="${start}" y="${y}" width="${cell - 8}" height="85" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${images[index]}"/>`,
      );
    else {
      rect(start, y, cell - 8, 85, "#263345");
      text(start + 5, y + 25, data?.state ?? entry.error?.code ?? "unavailable", "#ffb38a");
    }
    text(start + 6, y + 102, `request ${(entry.atUs / 1e6).toFixed(3)} s`);
    const frame = data?.published?.output;
    if (frame?.actualSourceUs !== undefined)
      text(
        start + 6,
        y + 118,
        `decoded ${(frame.actualSourceUs / 1e6).toFixed(3)} s`,
        "#9aadc6",
        11,
      );
    line(start + (cell - 8) / 2, y + 124, x(entry.atUs), y + 146, "#6abbec", 2);
    const support = frame?.frame?.visibleRange;
    if (support)
      rect(x(support.startUs), y + 144, x(support.endUs) - x(support.startUs), 4, "#6abbec");
    rect(x(entry.atUs) - 2, y + 136, 4, 21, "#6abbec");
  }
  text(left, y + 173, "Blue tick: request; span: compiled support (project only)", "#9aadc6", 11);
  y += 182;
  const wave = manifest.waveform.measurements;
  if (wave) {
    for (let channel = 0; channel < wave.channels; channel++) {
      text(20, y + 32, `Channel ${channel + 1}`);
      line(left, y + 30, width - 35, y + 30, "#516078");
      for (const bucket of wave.buckets) {
        const value = bucket.channels[channel];
        const a = wave.timeOriginUs ?? 0;
        const start = a + (bucket.sampleRange.start / wave.sampleRate) * 1e6;
        const end = a + (bucket.sampleRange.end / wave.sampleRate) * 1e6;
        rect(
          x(start),
          y + 30 - 25 * Math.min(1, value.max),
          Math.max(1, x(end) - x(start)),
          Math.max(1, 25 * (Math.min(1, value.max) - Math.max(-1, value.min))),
          "#78cbb9",
        );
      }
      for (const entry of wave.unavailable ?? []) {
        const ranges = entry.ranges?.map((value) => ({
          startUs: (value.start / wave.sampleRate) * 1e6,
          endUs: (value.end / wave.sampleRate) * 1e6,
        })) ?? [entry];
        for (const missing of ranges)
          rect(x(missing.startUs), y + 1, x(missing.endUs) - x(missing.startUs), 58, "#823b4a88");
      }
      y += 70;
    }
    text(
      left,
      y,
      "Shaded support is unavailable; mixed audio may still contain other contributors",
      "#ffb38a",
      11,
    );
    y += 22;
  } else {
    text(20, y + 20, `Waveform: ${manifest.waveform.state ?? "not selected"}`, "#ffb38a");
    y += 44;
  }
  text(20, y + 16, "Words / gaps");
  text(left, y + 16, "Faint lines are row guides, not media support", "#9aadc6", 11);
  y += 25;
  const rows = manifest.transcripts.selections?.[0]?.rows ?? [];
  for (const [index, row] of rows.slice(0, maxWords).entries()) {
    line(left, y + 19.5, width - 35, y + 19.5, "#40516b");
    const ranges = span(row);
    for (const range of ranges)
      rect(
        x(range.startUs),
        y + 17,
        x(range.endUs) - x(range.startUs),
        5,
        row.type === "gap" ? "#d68888" : "#e6c475",
      );
    const label = `${index + 1}. ${row.text ?? row.type} ${row.clipId ? `· ${row.clipId}` : ""}${row.partial ? " · partial" : ""}`;
    text(left, y + 12, label.slice(0, Math.floor(plot / 7)));
    y += 27;
  }
  if (!rows.length) {
    text(
      left,
      y + 12,
      `Transcript: ${manifest.transcripts.selections?.[0]?.state ?? manifest.transcripts.state ?? "not selected"}`,
      "#ffb38a",
    );
    y += 28;
  }
  if (manifest.transcripts.continuation) {
    text(left, y + 12, "More transcript rows are outside this text budget", "#ffb38a");
    y += 28;
  }
  const cuts = manifest.events.rows?.filter((row) => row.kind === "cut") ?? [];
  text(20, y + 18, "Cuts / events");
  y += 28;
  for (const row of (manifest.events.rows ?? []).slice(0, 32)) {
    const at = row.projectAtUs ?? row.sourceAtUs;
    if (at !== undefined) {
      const marker = x(at);
      const core = `${[...new Set([row.kind, row.mediaKind].filter(Boolean))].join(" · ")} · ${(number(at) / 1e6).toFixed(3)} s`;
      const id = row.trackId ?? row.clipId;
      const displayId = id?.length > 18 ? `${id.slice(0, 9)}…${id.slice(-6)}` : id;
      const rightSpace = width - 35 - marker - 8;
      const leftSpace = marker - left - 8;
      const full = `${core}${displayId ? ` · ${displayId}` : ""}`;
      const onRight = full.length * 7.2 <= rightSpace || rightSpace >= leftSpace;
      const space = onRight ? rightSpace : leftSpace;
      const label = full.slice(0, Math.max(core.length, Math.floor(space / 7.2)));
      const labelWidth = Math.min(space, label.length * 7.2);
      const labelX = onRight ? marker + 8 : marker - labelWidth - 8;
      // Explicit glyph extent prevents platform font metrics from crossing the marker.
      elements.push(
        `<text x="${labelX}" y="${y + 16}" fill="#dce4ef" font-size="12" textLength="${labelWidth}" lengthAdjust="spacingAndGlyphs">${escape(label)}</text>`,
      );
      rect(x(at) - 2, y + 2, 4, 21, row.kind === "cut" ? "#ef9393" : "#a0aadb");
      y += 30;
    }
  }
  y += 25;
  text(
    left,
    y,
    `${cuts.length} observed cuts · ${Math.min(manifest.events.rows?.length ?? 0, 32)} of ${manifest.events.rows?.length ?? 0} event labels shown · ${manifest.events.state ?? "not selected"}${manifest.events.nextCursor ? " · more pages skipped" : ""}`,
    "#9aadc6",
  );
  text(
    20,
    y + 28,
    "Frames show selected samples, not continuous decode. Unseen or unheard quality is unverified.",
    "#9aadc6",
    11,
  );
  const height = y + 48;
  if (width * height > manifest.budgets.maxPixels)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Timeline image exceeds maxPixels");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,sans-serif"><rect width="100%" height="100%" fill="#111b2b"/>${elements.join("")}</svg>`;
}

export async function inspectTimeline(
  request,
  invoke = createCli(request.cli),
  { readOutput = readDelivered } = {},
) {
  const target = request.target;
  const project = typeof target?.projectId === "string" && !!target.projectId;
  const source = typeof target?.assetId === "string" && !!target.assetId;
  if (project === source || (!project && !target.videoStreamId && !target.audioStreamId))
    throw failure(
      "INVALID_REQUEST",
      "Select one project or an asset with explicit video/audio stream IDs",
    );
  const range = request.range;
  if (
    !range ||
    !Number.isSafeInteger(range.startUs) ||
    !Number.isSafeInteger(range.endUs) ||
    range.startUs < 0 ||
    range.endUs <= range.startUs ||
    range.endUs - range.startUs > 60_000_000
  )
    throw failure("INVALID_REQUEST", "Supply a positive selected window of at most 60 seconds");
  const budgets = {
    frames: budget(request.frames, 4, 0, 8, "frames"),
    maxLongEdge: budget(request.maxLongEdge, 240, 1, 512, "maxLongEdge"),
    width: budget(request.width, 1200, 640, 2048, "width"),
    maxBuckets: budget(request.maxBuckets, 512, 2, 4096, "maxBuckets"),
    maxWords: budget(request.maxWords, 24, 1, 100, "maxWords"),
    maxEventPages: budget(request.maxEventPages, 2, 0, 8, "maxEventPages"),
    maxEvents: budget(request.maxEvents, 64, 1, 500, "maxEvents"),
    maxPixels: budget(request.maxPixels, 4_000_000, 100_000, 16_000_000, "maxPixels"),
    maxBytes: budget(request.maxBytes, 8 * 1024 * 1024, 4096, 32 * 1024 * 1024, "maxBytes"),
    polls: budget(request.polls, 0, 0, 20, "polls"),
    pollMs: budget(request.pollMs, 250, 0, 10_000, "pollMs"),
  };
  if (
    budgets.frames * budgets.maxLongEdge ** 2 + budgets.width * (650 + budgets.maxWords * 27) >
    budgets.maxPixels
  )
    throw failure(
      "INVALID_REQUEST",
      "Requested dimensions exceed maxPixels; reduce image or text budgets",
    );
  let identity, asset;
  if (project) {
    const result = await invoke("revision.get", {
      projectId: target.projectId,
      ...(target.revisionId ? { revisionId: target.revisionId } : {}),
    });
    if (!result.revision?.id || (target.revisionId && result.revision.id !== target.revisionId))
      throw failure("ARTIFACT_CHANGED", "Requested project revision is unavailable");
    identity = { projectId: target.projectId, revisionId: result.revision.id };
  } else {
    asset = await invoke("asset.get", { assetId: target.assetId });
    identity = {
      assetId: target.assetId,
      ...(target.acquisitionId ? { acquisitionId: target.acquisitionId } : {}),
    };
  }
  const pinned = (result) => {
    if (project && result.revisionId && result.revisionId !== identity.revisionId)
      throw failure("ARTIFACT_CHANGED", "Inspector returned a different revision");
    return result;
  };
  const observe = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      return errorRecord(error);
    }
  };
  const get = async (operation, params) => {
    let result = pinned(await invoke(operation, params));
    for (let i = 0; i < budgets.polls && active.has(result.state); i++) {
      await delay(budgets.pollMs);
      result = pinned(await invoke(operation, params));
    }
    return result;
  };
  let remaining = budgets.maxBytes;
  const read = async (path) => {
    const bytes = await readOutput(path, remaining);
    if (!Buffer.isBuffer(bytes) || bytes.length > remaining)
      throw failure("OUTPUT_BUDGET_EXCEEDED", "Delivered evidence exceeds maxBytes");
    remaining -= bytes.length;
    return bytes;
  };
  const manifest = {
    version: 1,
    domain: project ? "project" : "source",
    identity,
    range: { ...range },
    budgets,
    frames: [],
    pictureRequests: 0,
    waveform: { state: "not_selected" },
    transcripts: { state: "not_selected" },
    events: { state: "not_selected", rows: [] },
    work: { decodedSamples: 0, readerOpens: 0 },
  };
  const images = [];
  const video = project ? identity : { ...identity, streamId: target.videoStreamId };
  const audio = project ? identity : { ...identity, streamId: target.audioStreamId };
  if (budgets.frames && (project || target.videoStreamId)) {
    const atUs = Array.from(
      { length: budgets.frames },
      (_, i) =>
        range.startUs +
        Math.floor(((range.endUs - range.startUs - 1) * i) / Math.max(1, budgets.frames - 1)),
    );
    manifest.pictureRequests = atUs.length;
    const batch = await observe(async () =>
      pinned(await invoke("frame.batch", { ...video, atUs, maxLongEdge: budgets.maxLongEdge })),
    );
    if (batch.items) {
      for (const entry of batch.items) {
        const result = await observe(async () => {
          if (!entry.ok) return entry;
          let data = pinned(entry.data);
          if (active.has(data.state) && budgets.polls)
            data = await get("frame.get", {
              ...video,
              atUs: entry.atUs,
              maxLongEdge: budgets.maxLongEdge,
            });
          if (data.state === "ready") {
            const frame = data.published?.output;
            if (!frame) throw failure("INVALID_RESPONSE", "Ready frame has no receipt");
            const bytes = await read(data.output);
            images[manifest.frames.length] = bytes.toString("base64");
            manifest.work.decodedSamples += frame.decodedSamples ?? 0;
            manifest.work.readerOpens += frame.readerOpens ?? 0;
            return {
              atUs: entry.atUs,
              ok: true,
              data,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          }
          return { atUs: entry.atUs, ok: true, data };
        });
        manifest.frames.push(result.atUs === undefined ? { atUs: entry.atUs, ...result } : result);
      }
    } else manifest.frames = atUs.map((atUs) => ({ atUs, ...batch }));
  }
  if (project || target.audioStreamId) {
    manifest.waveform = await observe(async () => {
      const rate = project
        ? 48000
        : asset.streams?.find((stream) => stream.id === target.audioStreamId)?.sampleRate;
      if (!Number.isSafeInteger(rate) || rate < 1)
        throw failure(
          "UNSUPPORTED_FORMAT",
          "Selected audio has no supported integral sample clock",
        );
      const bucketFrames = Math.max(
        1,
        Math.ceil(((range.endUs - range.startUs) * rate) / 1e6 / (budgets.maxBuckets - 1)) + 1,
      );
      const data = await get("waveform.get", { ...audio, range, bucketFrames, format: "json" });
      if (data.state !== "ready") return data;
      const measurements = JSON.parse((await read(data.output)).toString("utf8"));
      pinned(measurements);
      if (
        measurements.domain !== manifest.domain ||
        measurements.buckets?.length > budgets.maxBuckets ||
        !Array.isArray(measurements.buckets)
      )
        throw failure(
          "INVALID_RESPONSE",
          "Waveform clock or bucket budget disagrees with the request",
        );
      return { ...data, measurements };
    });
    manifest.transcripts = await observe(() =>
      compactTranscripts(
        {
          selections: [{ ...audio, range }],
          maxPages: 1,
          pageRows: budgets.maxWords,
          maxBytes: Math.min(remaining, 1024 * 1024),
        },
        invoke,
      ),
    );
  }
  if (budgets.maxEventPages && (project || target.videoStreamId)) {
    manifest.events = await observe(async () => {
      let cursor, coverage, state;
      const rows = [];
      const observations = [];
      for (let page = 0; page < budgets.maxEventPages; page++) {
        const params = project ? { ...identity, range } : { ...video, sourceRange: range };
        const result = await get("timeline.events", {
          ...params,
          limit: budgets.maxEvents - rows.length,
          ...(cursor ? { cursor } : {}),
        });
        const { rows: _rows, nextCursor: _nextCursor, ...facts } = result;
        observations.push(facts);
        coverage ??= result.coverage ?? result.context?.coverage;
        state = result.state;
        rows.push(...(result.rows ?? []));
        cursor = result.nextCursor;
        if (!cursor || rows.length >= budgets.maxEvents) break;
      }
      return { state, coverage: coverage ?? null, rows, observations, nextCursor: cursor ?? null };
    });
  }
  const svg = timelineSvg(manifest, images);
  const result = { manifest, svg };
  if (Buffer.byteLength(JSON.stringify(result)) > budgets.maxBytes)
    throw failure("OUTPUT_BUDGET_EXCEEDED", "Sheet and exact manifest exceed maxBytes");
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: node timeline-inspection.mjs < request.json\nSupply target (projectId/revisionId or assetId with explicit videoStreamId/audioStreamId/acquisitionId), a <=60s range, optional frames/maxLongEdge/width/maxBuckets/maxWords/maxEventPages/maxEvents/maxPixels/maxBytes/polls/pollMs/cli. Returns an SVG sheet and exact manifest. No edits, ASR requests, model downloads or implicit failed-work retries.",
    );
  else await runJsonHelper(inspectTimeline);
}
