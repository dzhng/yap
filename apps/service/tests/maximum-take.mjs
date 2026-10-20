import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CaptureStore } from "@yap/core/capture-store";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore, AcquisitionImporter } from "@yap/core/acquisitions";
import { SourceEvidenceStore } from "@yap/core/evidence";
import { MAXIMUM_TAKE_US } from "@yap/protocol";
import { mediaWorker } from "../dist/worker.js";
import { assetProbe } from "../dist/media-probe.js";
import { sourceExporter } from "../dist/source-export.js";

// Real prerecorded ingress, writer, publication, export, media probe and acquisition admission.
// The native fixture substitutes the hardware input and host clock only.
test("the automatic twelve-hour finish imports as a complete ordinary source", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximum-take-"));
  let catalog;
  try {
    const fixture = join(root, "fixture");
    const native = resolve("helpers/mac/.build/debug/yap-native");
    const { stdout } = await promisify(execFile)(
      resolve("helpers/mac/.build/debug/YapCaptureTests"),
      [],
      {
        env: { ...process.env, YAP_MAXIMUM_TAKE: "1", YAP_MAXIMUM_TAKE_OUTPUT: fixture },
        timeout: 60_000,
      },
    );
    assert.match(stdout, /PASS 12-hour prerecorded/);
    const publication = JSON.parse(await readFile(join(fixture, "publication.json"), "utf8"));
    const source = publication.primary.source;
    let ordinal = 0;
    catalog = new CaptureStore(join(root, "catalog.sqlite"), {
      now: () => "2026-10-20T00:00:00Z",
      newId: () => (++ordinal === 1 ? "maximum-duration-take" : source.sourceId),
    });
    const recording = catalog.allocate().recording;
    catalog.ingestLifecycle(recording.id, {
      sourceId: source.sourceId,
      sequence: 1,
      state: "finalizing",
      publication,
    });
    catalog.ingestLifecycle(recording.id, {
      sourceId: source.sourceId,
      sequence: 2,
      state: "complete",
      sourceDurationUs: MAXIMUM_TAKE_US,
      reason: "maximumDuration",
    });
    const managed = join(root, "recordings", recording.id);
    await mkdir(managed, { recursive: true });
    await rename(join(fixture, "take"), join(managed, "source"));
    const assets = new AssetStore(catalog, root);
    await assets.recover();
    const acquisitions = new AcquisitionStore(catalog);
    const evidence = new SourceEvidenceStore(catalog, (identity) =>
      acquisitions.intent(identity.owner.id),
    );
    const importer = new AcquisitionImporter(catalog, acquisitions, assets, evidence, root);
    const signal = new AbortController().signal;
    await importer.recover(signal);
    const intent = acquisitions.admitCapture(catalog, recording.id, join(managed, "source"));
    const workspace = join(root, "probe");
    await mkdir(workspace, { mode: 0o700 });
    const worker = mediaWorker({ YAP_NATIVE: native });
    const imported = await importer.executeImport(
      intent.acquisitionId,
      "maximum-duration-import",
      {
        probe: assetProbe(worker, workspace),
        exportSource: sourceExporter(worker),
      },
      signal,
    );
    assert.equal(imported.sourceId, source.sourceId);
    assert.equal(imported.evidence.receipt.completion.durationUs, MAXIMUM_TAKE_US);
    assert.ok(imported.bindings.some((binding) => binding.sourceRoles.includes("video")));
    assert.equal(catalog.get(recording.id).completionReason, "maximumDuration");
    assert.equal(catalog.get(recording.id).interruptionReason, null);
    console.log(
      `PASS maximumDuration import: ${imported.evidence.receipt.completion.durationUs} us, ${imported.bindings.length} media binding; 20-hour pause excluded`,
    );
  } finally {
    catalog?.close();
    await rm(root, { recursive: true, force: true });
  }
});
