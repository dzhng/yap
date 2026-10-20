import { z } from "zod";

/**
 * The private app channel carries capture control in both directions. These shapes are the
 * boundary between the two owners: the service names a take and a directory, and native
 * answers with what its device actually did. Neither side restates the other's schema.
 */
const id = z.string().min(1);
const absolutePath = z.string().min(1).startsWith("/");
const finite = z.number().finite();
const authorization = z.enum(["authorized", "denied", "restricted", "not_determined", "unknown"]);

export const captureSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("display"), id: z.int().nonnegative() }).strict(),
  z.object({ kind: z.literal("window"), id: z.int().nonnegative() }).strict(),
  z.object({ kind: z.literal("camera"), id: id.max(256) }).strict(),
  z
    .object({
      kind: z.literal("region"),
      displayId: z.int().nonnegative(),
      x: finite,
      y: finite,
      width: finite.positive(),
      height: finite.positive(),
    })
    .strict(),
]);
export type CaptureSource = z.infer<typeof captureSourceSchema>;

/**
 * What a caller chooses about a take. These takes are narrated, so the microphone is on unless a
 * caller refuses it, and what the machine itself plays stays out until it is asked for. This is
 * the one place either default is stated: every peer is told both, explicitly, on every start.
 */
export const captureSelectionSchema = z
  .object({
    source: captureSourceSchema,
    microphone: z.boolean().default(true),
    systemAudio: z.boolean().default(false),
    microphoneDeviceId: id.optional(),
    cameraDeviceId: id.max(256).optional(),
    /**
     * Whether the companion camera records from the first frame. Absent with a companion camera
     * means "on"; admission never fills it in, so a caller's omission stays visible.
     */
    cameraAtStart: z.enum(["on", "off"]).optional(),
  })
  .superRefine((selection, context) => {
    if (selection.source.kind === "camera" && selection.cameraDeviceId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["cameraDeviceId"],
        message: "A primary camera cannot also select a companion camera.",
      });
    }
    if (selection.cameraAtStart !== undefined && selection.cameraDeviceId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["cameraAtStart"],
        message: "A camera start state needs a selected companion camera.",
      });
    }
  });
export type CaptureSelection = z.output<typeof captureSelectionSchema>;

/** Identity and directory are allocated before native runs, so native never invents either. */
export const nativeStartSchema = captureSelectionSchema
  .safeExtend({
    recordingId: id,
    sourceId: id,
    cameraSourceId: id.max(256).optional(),
    cameraDirectory: absolutePath.optional(),
    outputDirectory: absolutePath,
  })
  .superRefine((selection, context) => {
    if (selection.source.kind !== "camera") return;
    for (const field of ["cameraSourceId", "cameraDirectory"] as const) {
      if (selection[field] !== undefined)
        context.addIssue({
          code: "custom",
          path: [field],
          message: "A primary camera cannot carry companion camera authority.",
        });
    }
  });

export const captureReportSchema = z
  .object({
    recordingId: id,
    sourceId: id,
    sequence: z.int().min(1),
    state: z.enum(["recording", "paused", "finalizing", "complete", "interrupted"]),
    reason: z.string().min(1).nullish(),
    message: z.string().max(4096).nullish(),
    finalizationError: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().max(4096),
      })
      .nullable()
      .optional(),
    sourceDurationUs: z.int().nonnegative().nullish(),
    // The capture-facts owner validates the complete bounded authority before its lifecycle write.
    publication: z.unknown().optional(),
  })
  .strict();
export type CaptureReport = z.infer<typeof captureReportSchema>;

/**
 * Permission is the native session's own fact: it is read without asking for anything, so a
 * status call never prompts. Only an explicit person-initiated request can change either value.
 */
export const capturePermissionsSchema = z
  .object({
    screen: z.boolean(),
    microphone: authorization,
    camera: authorization,
  })
  .strict();

/**
 * The device state native owns. The catalog stores what this reports; it derives nothing.
 * `elapsedUs` is the running take's playback time, read from the capture clock that writes its
 * media, so it omits paused time and freezes while paused. Nothing else derives elapsed time.
 * `camera` is the live state of the take's reserved companion camera, non-null exactly while
 * native holds a take with one. It is never stored: turning the camera on or off is not a
 * lifecycle transition, and the off time is recorded only as gaps in the camera source.
 */
export const captureDeviceSchema = z
  .object({
    state: z.enum(["idle", "selecting", "recording", "paused", "finalizing"]),
    recordingId: id.nullable(),
    sourceId: id.nullable(),
    elapsedUs: z.int().nonnegative().nullable(),
    selection: captureSelectionSchema.nullable(),
    camera: z
      .object({ deviceId: id.max(256), state: z.enum(["on", "off"]) })
      .strict()
      .nullable(),
    permissions: capturePermissionsSchema,
  })
  .strict();

/**
 * Source and device discovery facts. Listing activates no input and requests no permission;
 * `microphones` names what a narrated take could use. A caller explicitly selects a camera
 * by its stable device ID; discovery itself neither chooses nor activates it. An empty list is honest.
 */
export const captureSourcesSchema = z
  .object({
    displays: z.array(
      z.object({ id: z.int(), name: z.string(), width: z.int(), height: z.int() }).strict(),
    ),
    windows: z.array(
      z.object({ id: z.int(), title: z.string(), application: z.string() }).strict(),
    ),
    cameras: z.array(
      z.object({ id, name: z.string(), isDefault: z.boolean().optional() }).strict(),
    ),
    microphones: z.array(z.object({ id, name: z.string(), isDefault: z.boolean() }).strict()),
  })
  .strict();
