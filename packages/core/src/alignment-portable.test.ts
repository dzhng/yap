import { expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { AlignmentEvidenceStore, alignmentOperandRecords } from "./alignment-evidence.js";
import { SourceAlignmentRead } from "./alignment-read.js";
import { alignmentEvidenceSourceSchema } from "./alignment-operands.js";
import { alignmentOutput, alignmentSource } from "./alignment-evidence.fixture.js";

const identity = {
  owner: { kind: "asset" as const, id: "a".repeat(64) },
  generation: "g-z",
  policy: "alignment-v1" as const,
};
test("portable alignment preserves original operands, complete rows and original publication order", async () => {
  const donor = new Catalog(":memory:"),
    target = new Catalog(":memory:");
  try {
    const records = new AlignmentEvidenceStore(donor, () => {}),
      imported = new AlignmentEvidenceStore(target, () => {}),
      operands = alignmentOutput();
    operands.report += "\n";
    const first = records.stage(identity, alignmentSource, operands);
    donor.transaction(() => first.publish());
    const newer = records.stage({ ...identity, generation: "g-a" }, alignmentSource, operands);
    donor.transaction(() => newer.publish());
    const portable = [...records.portableGenerations(identity.owner.id)];
    for (const item of portable) {
      const staged = imported.stagePortable(
        item.metadata,
        records.operands(item.metadata),
        () => {},
      );
      target.transaction(() => staged.publish());
      await staged.close();
    }
    expect(portable.map((item) => item.metadata.generation)).toEqual(["g-z", "g-a"]);
    expect(imported.operands(first.metadata)).toEqual(operands);
    expect(
      imported.latestObservation(
        identity.owner.id,
        alignmentEvidenceSourceSchema
          .omit({ pcm: true, decoder: true })
          .strip()
          .parse(alignmentSource),
      )?.generation,
    ).toBe("g-a");
    const immutable = alignmentOperandRecords(first.metadata, operands);
    for (const query of [
      { view: "words" as const },
      { view: "scores" as const },
      { view: "acoustic" as const, thresholdRMS: 0.1 },
      { view: "raw" as const, operand: "report" as const },
    ]) {
      expect(new SourceAlignmentRead(immutable, first.metadata).page(query)).toEqual(
        new SourceAlignmentRead(imported, first.metadata).page(query),
      );
    }
  } finally {
    donor.close();
    target.close();
  }
});
test("portable operand tampering and changed live ownership refuse before publication; abandoned staging is reclaimed", async () => {
  const donor = new Catalog(":memory:"),
    target = new Catalog(":memory:");
  try {
    const records = new AlignmentEvidenceStore(donor, () => {}),
      operands = alignmentOutput(),
      first = records.stage(identity, alignmentSource, operands);
    donor.transaction(() => first.publish());
    const imported = new AlignmentEvidenceStore(target, () => {
      throw Error("owner changed");
    });
    expect(() =>
      imported.stagePortable(
        first.metadata,
        { ...operands, report: operands.report + " " },
        () => {},
      ),
    ).toThrow("operands differ");
    expect(() =>
      imported.stagePortable({ ...first.metadata, wordCount: 1 }, operands, () => {}),
    ).toThrow("metadata differs");
    const staged = imported.stagePortable(first.metadata, operands, () => {});
    expect(() => target.transaction(() => staged.publish())).toThrow("owner changed");
    expect(() => imported.metadata(identity)).toThrow("not ready");
    await staged.close();
    expect([...imported.portableGenerations(identity.owner.id)]).toEqual([]);
    expect(() => imported.capturedOperands(identity)).toThrow("not retained");
  } finally {
    donor.close();
    target.close();
  }
});
