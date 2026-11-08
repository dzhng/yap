import { createHash } from "node:crypto";
import {
  correspondenceMeasurementSchema,
  correspondenceReceiptSchema,
  type CorrespondenceEndpoint,
  type CorrespondenceMeasurement,
  type CorrespondenceReceipt,
} from "@yap/protocol";
import { CatalogError } from "./catalog.js";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
function endpointKey(endpoint: CorrespondenceEndpoint): string {
  return canonical(endpoint);
}

/** Validate one complete measurement and bind it to immutable endpoint identities. */
export function admitCorrespondence(input: {
  evidenceId: string;
  generation: string;
  left: CorrespondenceEndpoint;
  right: CorrespondenceEndpoint;
  measurement: CorrespondenceMeasurement;
}): CorrespondenceReceipt {
  const measurement = correspondenceMeasurementSchema.parse(input.measurement);
  if (endpointKey(input.left) === endpointKey(input.right))
    throw new CatalogError("INVALID_PARAMS", "Correspondence endpoints must be distinct");
  if (measurement.verdict === "accepted") {
    const selectedAnchors = measurement.anchors.filter((anchor) => anchor.selected !== null);
    if (selectedAnchors.length !== measurement.anchors.length)
      throw new CatalogError(
        "INVALID_INPUT_EVIDENCE",
        "Accepted correspondence requires every anchor to be selected",
      );
    if (measurement.candidates.filter((candidate) => candidate.selected).length !== 1)
      throw new CatalogError(
        "INVALID_INPUT_EVIDENCE",
        "Accepted correspondence requires one selected mapping",
      );
  }
  const unsigned = {
    id: input.evidenceId,
    generation: input.generation,
    recipe: "temporal-correspondence-v1" as const,
    left: input.left,
    right: input.right,
    measurement,
  };
  const fingerprint = createHash("sha256").update(canonical(unsigned)).digest("hex");
  return correspondenceReceiptSchema.parse({ ...unsigned, fingerprint });
}

/** Replay a receipt and reject any changed identity, metric or fingerprint. */
export function verifyCorrespondenceReceipt(value: unknown): CorrespondenceReceipt {
  const receipt = correspondenceReceiptSchema.parse(value);
  const { fingerprint, ...unsigned } = receipt;
  const expected = createHash("sha256").update(canonical(unsigned)).digest("hex");
  if (fingerprint !== expected)
    throw new CatalogError("INVALID_EVIDENCE", "Correspondence receipt fingerprint changed");
  return receipt;
}
