import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "./catalog.js";
import { SpeakerEvidenceStore, speakerOperandRecords } from "./speaker-evidence.js";
import { nativeOutput, speakerSource } from "./speaker-evidence.fixture.js";

test("portable speaker staging preserves native bytes, row ordinals, all score cells and publication order", async () => {
  const home = await mkdtemp("/tmp/speaker-portable-");
  const donor = new Catalog(join(home, "donor.sqlite")),
    target = new Catalog(join(home, "target.sqlite"));
  try {
    const records = new SpeakerEvidenceStore(donor, () => {});
    const identity = {
      owner: { kind: "asset" as const, id: "a".repeat(64) },
      sourceId: "a".repeat(64),
      generation: "g-z",
      policy: "speaker-v1" as const,
    };
    const original = nativeOutput(["0.500 2.000 speaker_1", "0.000 1.000 speaker_0"]);
    original.report += "\n";
    const stage = records.stage(identity, speakerSource, original);
    donor.transaction(() => stage.publish());
    const newer = records.stage(
      { ...identity, generation: "g-a" },
      { ...speakerSource, decoder: { ...speakerSource.decoder, osBuild: "newer-decoder" } },
      original,
    );
    donor.transaction(() => newer.publish());
    const portable = records.portableGenerations(identity.owner.id);
    const imported = new SpeakerEvidenceStore(target, () => {});
    for (const item of portable) {
      const stage = imported.stagePortable(
        item.metadata,
        records.operands(item.metadata),
        () => {},
      );
      target.transaction(() => stage.publish());
      await stage.close();
    }
    expect(imported.operands(stage.metadata)).toEqual(original);
    expect(imported.intervalPage({ identity: stage.metadata, limit: 1000 })).toEqual(
      records.intervalPage({ identity: stage.metadata, limit: 1000 }),
    );
    expect(imported.scorePage({ identity: stage.metadata, limit: 1000 })).toEqual(
      records.scorePage({ identity: stage.metadata, limit: 1000 }),
    );
    expect(
      speakerOperandRecords(stage.metadata, original).scorePage({
        identity: stage.metadata,
        limit: 1000,
      }),
    ).toEqual(records.scorePage({ identity: stage.metadata, limit: 1000 }));
    expect(portable.map((item) => item.metadata.generation)).toEqual(["g-z", "g-a"]);
    expect(imported.latestObservation(identity.owner.id, speakerSource)?.generation).toBe("g-a");
  } finally {
    donor.close();
    target.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("portable speaker tampering and changed live owner refuse before ready publication; canceled staging is reclaimed", async () => {
  const home = await mkdtemp("/tmp/speaker-portable-refusal-");
  const donor = new Catalog(join(home, "donor.sqlite")),
    target = new Catalog(join(home, "target.sqlite"));
  try {
    const records = new SpeakerEvidenceStore(donor, () => {});
    const identity = {
      owner: { kind: "asset" as const, id: "a".repeat(64) },
      sourceId: "a".repeat(64),
      generation: "g1",
      policy: "speaker-v1" as const,
    };
    const operands = nativeOutput();
    const original = records.stage(identity, speakerSource, operands);
    donor.transaction(() => original.publish());
    const imported = new SpeakerEvidenceStore(target, () => {
      throw Error("source owner changed");
    });
    expect(() =>
      imported.stagePortable(
        original.metadata,
        { ...operands, report: operands.report + " " },
        () => {},
      ),
    ).toThrow("operands differ");
    expect(() => imported.metadata(identity)).toThrow("not ready");
    const staged = imported.stagePortable(original.metadata, operands, () => {});
    expect(() => target.transaction(() => staged.publish())).toThrow("source owner changed");
    expect(() => imported.metadata(identity)).toThrow("not ready");
    await staged.close();
    expect(imported.portableGenerations(identity.owner.id)).toEqual([]);
    expect(() => imported.capturedOperands(identity)).toThrow("not retained");
  } finally {
    donor.close();
    target.close();
    await rm(home, { recursive: true, force: true });
  }
});
