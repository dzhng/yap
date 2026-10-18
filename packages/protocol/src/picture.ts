import { z } from "zod";

const count = z
  .int()
  .min(0)
  .max(8192 * 8192);
const maxPicturePixels = 8192 * 8192;
const byte = z.int().min(0).max(255);
const fraction = z.number().finite().min(0).max(1);
export const pictureRectSchema = z.strictObject({
  x: z.int().min(-1_000_000).max(1_000_000),
  y: z.int().min(-1_000_000).max(1_000_000),
  width: z.int().min(1).max(8192),
  height: z.int().min(1).max(8192),
});
export const pictureObservationRequestSchema = z
  .strictObject({
    darkAtOrBelow: byte.default(5),
    brightAtOrAbove: byte.default(250),
    edgeDarkFraction: fraction.default(0.98),
    edgeOpaqueFraction: fraction.default(1),
    regions: z
      .array(
        z.strictObject({
          regionId: z
            .string()
            .min(1)
            .refine((id) => new TextEncoder().encode(id).length <= 128),
          rect: pictureRectSchema,
        }),
      )
      .max(8)
      .default([]),
  })
  .refine(
    (r) =>
      r.darkAtOrBelow < r.brightAtOrAbove &&
      new Set(r.regions.map((v) => v.regionId)).size === r.regions.length &&
      r.regions.reduce((sum, v) => sum + v.rect.width * v.rect.height, 0) <= maxPicturePixels,
  );
export type PictureObservationRequest = z.input<typeof pictureObservationRequestSchema>;
export type NormalizedPictureObservationRequest = z.output<typeof pictureObservationRequestSchema>;
const metric = z.strictObject({
  histogram: z.array(count).length(256),
  mean: z.number().finite().min(0).max(255).optional(),
  minimum: byte.optional(),
  maximum: byte.optional(),
  darkFraction: fraction.optional(),
  brightFraction: fraction.optional(),
});
const region = z.strictObject({
  regionId: z.string().min(1),
  requestedRect: pictureRectSchema,
  sampledRect: pictureRectSchema.optional(),
  state: z.enum(["measured", "unavailable"]),
  reason: z.enum(["outside_raster", "no_opaque_pixels"]).optional(),
  coverage: z.strictObject({
    requestedPixels: count,
    rasterPixels: count,
    opaquePixels: count,
    transparentPixels: count,
    partialAlphaPixels: count,
  }),
  channels: z.strictObject({ red: metric, green: metric, blue: metric }),
  luma: metric,
});
const profile = z
  .strictObject({
    name: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    iccStatus: z.enum(["present", "absent"]),
  })
  .refine((p) => (p.sha256 === null) === (p.iccStatus === "absent"));
export const pictureObservationsSchema = z
  .strictObject({
    recipe: z.literal("profile-managed-srgb-rgba8-rec709-encoded-luma-opaque-only-v1"),
    coordinateSpace: z.literal("delivered-top-left-pixels"),
    lumaWeights: z.tuple([z.literal(0.2126), z.literal(0.7152), z.literal(0.0722)]),
    alphaInterpretation: z.literal("only-alpha-255-contributes-to-color-metrics"),
    sourceProfile: profile,
    measurementProfile: profile,
    width: z.int().min(1).max(8192),
    height: z.int().min(1).max(8192),
    rgbaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    request: pictureObservationRequestSchema,
    full: region,
    regions: z.array(region).max(8),
    edgeBands: z
      .array(
        z.strictObject({
          edge: z.enum(["top", "bottom", "left", "right"]),
          depthPixels: z.int().min(1).max(8192),
          rect: pictureRectSchema,
          opaqueFraction: fraction,
          darkFraction: fraction,
          meanLuma: z.number().finite().min(0).max(255),
          histogram: z.array(count).length(256),
          adjacentMeanLuma: z.number().finite().min(0).max(255).optional(),
        }),
      )
      .max(4),
  })
  .superRefine((v, ctx) => {
    const reject = () =>
      ctx.addIssue({
        code: "custom",
        message: "Picture observations contradict their raster, masks or histogram operands",
      });
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const raster = { x: 0, y: 0, width: v.width, height: v.height };
    if (
      v.full.regionId !== "full" ||
      !equal(v.full.requestedRect, raster) ||
      v.regions.length !== v.request.regions.length
    )
      reject();
    for (const [i, r] of [v.full, ...v.regions].entries()) {
      const requested = v.request.regions[i - 1];
      if (
        i > 0 &&
        (!requested || r.regionId !== requested.regionId || !equal(r.requestedRect, requested.rect))
      )
        reject();
      const q = r.requestedRect,
        x = Math.max(0, q.x),
        y = Math.max(0, q.y),
        right = Math.min(v.width, q.x + q.width),
        bottom = Math.min(v.height, q.y + q.height);
      const sampled =
        right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
      const c = r.coverage,
        n = c.opaquePixels;
      if (
        !equal(r.sampledRect, sampled) ||
        c.requestedPixels !== q.width * q.height ||
        c.rasterPixels !== (sampled ? sampled.width * sampled.height : 0) ||
        c.rasterPixels !== n + c.transparentPixels + c.partialAlphaPixels ||
        r.state !== (n > 0 ? "measured" : "unavailable") ||
        r.reason !== (n > 0 ? undefined : sampled ? "no_opaque_pixels" : "outside_raster")
      )
        reject();
      for (const m of [r.luma, r.channels.red, r.channels.green, r.channels.blue]) {
        const sum = m.histogram.reduce((a, b) => a + b, 0),
          weighted = m.histogram.reduce((a, b, j) => a + b * j, 0);
        const minimum = m.histogram.findIndex((b) => b > 0),
          maximum = m.histogram.findLastIndex((b) => b > 0);
        if (
          sum !== n ||
          m.mean !== (n ? weighted / n : undefined) ||
          m.minimum !== (n ? minimum : undefined) ||
          m.maximum !== (n ? maximum : undefined) ||
          m.darkFraction !==
            (n
              ? m.histogram.slice(0, v.request.darkAtOrBelow + 1).reduce((a, b) => a + b, 0) / n
              : undefined) ||
          m.brightFraction !==
            (n
              ? m.histogram.slice(v.request.brightAtOrAbove).reduce((a, b) => a + b, 0) / n
              : undefined)
        )
          reject();
      }
    }
    if (new Set(v.edgeBands.map((b) => b.edge)).size !== v.edgeBands.length) reject();
    for (const b of v.edgeBands) {
      const vertical = b.edge === "left" || b.edge === "right",
        dimension = vertical ? v.width : v.height;
      const expected = vertical
        ? {
            x: b.edge === "left" ? 0 : v.width - b.depthPixels,
            y: 0,
            width: b.depthPixels,
            height: v.height,
          }
        : {
            x: 0,
            y: b.edge === "top" ? 0 : v.height - b.depthPixels,
            width: v.width,
            height: b.depthPixels,
          };
      if (
        b.depthPixels > dimension ||
        !equal(b.rect, expected) ||
        b.opaqueFraction < v.request.edgeOpaqueFraction ||
        b.darkFraction < v.request.edgeDarkFraction ||
        (b.depthPixels === dimension && b.adjacentMeanLuma !== undefined)
      )
        reject();
      const edgeCount = b.histogram.reduce((a, c) => a + c, 0);
      const edgeWeighted = b.histogram.reduce((a, c, i) => a + c * i, 0);
      if (
        Math.abs(edgeCount - b.opaqueFraction * b.rect.width * b.rect.height) > 1e-9 ||
        Math.abs(
          b.darkFraction -
            b.histogram.slice(0, v.request.darkAtOrBelow + 1).reduce((a, c) => a + c, 0) /
              edgeCount,
        ) > 1e-12 ||
        Math.abs(b.meanLuma - edgeWeighted / edgeCount) > 1e-9
      )
        reject();
    }
  });
export type PictureObservations = z.infer<typeof pictureObservationsSchema>;
