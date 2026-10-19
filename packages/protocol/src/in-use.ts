import { z } from "zod";

const id = z.string().min(1);

export const inUseProjectSchema = z.strictObject({
  kind: z.literal("project"),
  id: id,
  title: z.string(),
  revisions: z.int().nonnegative(),
});

export const inUseAcquisitionSchema = z.strictObject({
  kind: z.literal("acquisition"),
  id: id,
});

export const inUseDerivedAssetSchema = z.strictObject({
  kind: z.literal("asset"),
  id: id,
});

/** The structured details shared by every IN_USE refusal. */
export const inUseDetailsSchema = z
  .strictObject({
    assetId: id.optional(),
    acquisitionId: id.optional(),
    recordingId: id.optional(),
    usedBy: z.array(inUseProjectSchema),
    acquisitions: z.array(inUseAcquisitionSchema),
    derivedAssets: z.array(inUseDerivedAssetSchema),
    freesBytes: z.int().nonnegative(),
    cascadeFreesBytes: z.int().nonnegative(),
  })
  .refine(
    (value) =>
      [value.assetId, value.acquisitionId, value.recordingId].filter(
        (candidate) => candidate !== undefined,
      ).length === 1,
    "Exactly one subject identity is required",
  );

export type InUseDetails = z.infer<typeof inUseDetailsSchema>;
