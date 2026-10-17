# 12 media.list

**Contract.** `media.list {cursor?, limit?}` follows the slice 05 paging rules.
- **What it lists:** recordings plus assets with an `import` origin (`assets.ts:305`),
  newest first, behind one cursor.
- **Row shape:** `{kind: "recording"|"imported", recordingId|assetId, title, durationUs, sizeBytes, createdAt}`.
- **Titles.** A recording's title is its capture time. An import's title is the
  original filename, from `asset_origins`.
- **Excluded:**
  - capture copies;
  - generated and derived assets (HDR conversion, voice);
  - anything tombstoned;
  - canceled takes (as `recording.list` does today).
- **Assets with both origins.** An asset that is content-addressed and has both a
  capture and an import origin appears once, as imported.

**Seam.** A `MediaListing` read model in core that merges the two stores under one
cursor position.

**Run or see.** `yap media.list --params '{"limit":5}'` across a fixture that
interleaves recordings and imports by date.

**Verify.** Red tests first:
- merge ordering across both sources;
- cursor continuation across the boundary between the two kinds;
- the origin filter;
- tombstone exclusion;
- an asset with both origins;
- CLI/MCP parity through the schema.

**Same slice:** catalog entry.

**Firewall.** No app work. `recording.list` and `asset.list` stay as their own
listings.

**Delegated.** How the merge cursor is encoded inside the codec.
