import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureStore } from "../../core/dist/capture-store.js";
import {
  SourceEvidenceStore,
  sourceEvidenceRecords,
  validateSourceReceipt,
  recordingEvidenceOwner,
} from "../../core/dist/evidence.js";

const [stage, directory] = process.argv.slice(2);
let catalog;
try {
  const file = join(directory, "evidence.jsonl");
  const receipt = validateSourceReceipt(
    JSON.parse(readFileSync(join(directory, "receipt.json"))),
    "long-take-fixture",
  );
  let records = 0;
  let firstCursor, lastCursor;
  if (stage === "ts-read") {
    for await (const row of sourceEvidenceRecords(file, receipt)) {
      if (row.event === "cursorSample") {
        firstCursor ??= row.content;
        lastCursor = row.content;
      }
      if (++records % 36000 === 0) console.error(`validated ${records} normalized records`);
    }
    firstCursor = firstCursor && JSON.parse(firstCursor);
    lastCursor = lastCursor && JSON.parse(lastCursor);
  } else if (stage === "ingest") {
    catalog = new CaptureStore(join(directory, "catalog.sqlite"), {
      now: () => "2026-10-20T00:00:00Z",
      newId: () => "long-take-fixture",
    });
    const recording = catalog.allocate().recording;
    const store = new SourceEvidenceStore(catalog, recordingEvidenceOwner(catalog));
    const heartbeat = setInterval(
      () =>
        console.error(
          `indexed ${catalog.catalog.prepare("SELECT count(*) AS n FROM source_evidence_records").get().n} records`,
        ),
      10000,
    );
    try {
      await store.ingest({
        owner: { kind: "recording", id: recording.id },
        sourceId: "long-take-fixture",
        generation: "probe",
        file,
        receipt,
      });
      records = catalog.catalog
        .prepare("SELECT count(*) AS n FROM source_evidence_records")
        .get().n;
      const cursor = (order) =>
        catalog.catalog
          .prepare(
            `SELECT content FROM source_evidence_records WHERE event='cursorSample' ORDER BY sequence ${order} LIMIT 1`,
          )
          .get();
      const first = cursor("ASC"),
        last = cursor("DESC");
      firstCursor = first && JSON.parse(first.content);
      lastCursor = last && JSON.parse(last.content);
    } finally {
      clearInterval(heartbeat);
    }
  } else throw Error(`Unknown stage ${stage}`);
  console.log(JSON.stringify({ status: "pass", detail: { records, firstCursor, lastCursor } }));
} catch (error) {
  console.log(
    JSON.stringify({ status: "fail", code: error.code ?? "PROBE_FAILED", message: error.message }),
  );
  process.exitCode = 1;
} finally {
  catalog?.close();
}
