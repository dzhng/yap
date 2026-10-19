import assert from "node:assert/strict";

/** Public edits for the frozen familiar sentence and its accepted selection. */
export async function authorAcceptedRetime({ edit, asset, streamId, candidate }) {
  const placed = await edit("place", [
    { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    {
      operation: "place",
      label: "clip",
      clip: {
        trackId: { label: "audio" },
        assetId: asset.assetId,
        streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 4820000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 4820000 } },
        pitch: "preserve",
      },
    },
  ]);
  let current = placed.revision;
  const [firstFrame, lastFrame] = candidate.sourceFrames;
  const startUs = (firstFrame * 1000000) / 48000,
    endUs = (lastFrame * 1000000) / 48000;
  for (const boundary of [startUs, endUs].filter((v) => v > 0 && v < 4820000)) {
    const clip = current.document.clips.find(
      (v) => v.placement.range.startUs < boundary && v.placement.range.endUs > boundary,
    );
    assert(clip);
    current = (
      await edit("split-" + boundary, [
        { operation: "split", clipIds: [clip.id], atUs: boundary, scope: "selected" },
      ])
    ).revision;
  }
  const selected = current.document.clips.find(
    (v) => v.source.range.startUs === startUs && v.source.range.endUs === endUs,
  );
  assert(selected);
  // These are explicit authored integer durations, not a new engine rounding rule.
  const durationUs = Math.round(
    ((endUs - startUs) * candidate.rate.denominator) / candidate.rate.numerator,
  );
  await edit(
    "retime",
    [
      {
        operation: "retime",
        clipIds: [selected.id],
        durationUs,
        scope: "selected",
        pitch: "preserve",
        ripple: { trackIds: [placed.edit.labels.audio] },
      },
    ],
    "mcp",
  );

  return { selected, startUs, durationUs };
}
