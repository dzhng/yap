import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  boundedIssues,
  issueCount,
  operationSchema,
  operationError,
  waitJobSchema,
  type Issue,
  type OperationRequest,
  type OperationResponse,
  type WaitMetadata,
  workStateSchema,
} from "@yap/protocol";
import { ArtifactDeliveryError, batchReferences, describeBatch } from "./artifact-delivery.js";

const unsuccessful = new Set(["failed", "canceled", "unavailable", "idle"]);
// Work reads answer in WorkState; a take keeps its own capture lifecycle (`captureReportSchema`),
// and one whose finalization failed stays `finalizing` until a caller retries it.
const successful = new Set(["ready", "complete"]);
function pendingAdmission(source: unknown): boolean {
  const admission = record(source);
  return (
    admission.admissionError == null &&
    admission.job == null &&
    record(admission.publication).state === "published"
  );
}
function stillPending(value: Record<string, unknown>): boolean {
  return (
    ["queued", "running", "preparing", "recording", "paused"].includes(String(value.state)) ||
    (value.state === "finalizing" && value.finalizationError == null) ||
    (Array.isArray(value.sourceAdmissions) &&
      value.sourceAdmissions.some(
        (source) => pendingAdmission(source) || stillPending(record(record(source).job)),
      ))
  );
}
const jobSummary = waitJobSchema.extend({
  state: workStateSchema,
  target: z.record(z.string(), z.unknown()),
});
const reads = new Map([
  ["job.retry", "job.get"],
  ["index.get", "index.get"],
  ["transcript.get", "transcript.get"],
  ["frame.get", "frame.get"],
  ["audio.get", "audio.get"],
  ["waveform.get", "waveform.get"],
  ["spectrogram.get", "spectrogram.get"],
  ["preview.get", "preview.get"],
  ["frame.batch", "frame.batch"],
  ["index.frames", "index.frames"],
  ["audio.measure", "audio.measure"],
  ["audio.pause.get", "audio.pause.get"],
  ["transcript.search", "transcript.search"],
  ["transcript.transcribe", "transcript.get"],
  ["transcript.review", "transcript.review"],
  ["transcript.render.prepare", "transcript.render.get"],
  ["transcript.render.get", "transcript.render.get"],
  ["export.create", "export.status"],
  ["export.recover", "export.status"],
  ["capture.stop", "recording.get"],
  ["recording.get", "recording.get"],
  ["package.open", "package.status"],
  ["speaker.get", "speaker.get"],
  ["alignment.observe", "alignment.observe"],
  ["alignment.get", "alignment.get"],
  ["model.prepare", "model.status"],
  ["skill.install", "skill.status"],
  ["skill.update", "skill.status"],
  ["skill.uninstall", "skill.status"],
]);
/** Getters of a record, and the parameter that names it. */
const recordGetters = new Map([
  ["export.status", "exportId"],
  ["recording.get", "recordingId"],
  ["package.status", "admissionId"],
]);
// Getters used as initial requests must preserve the same domain response while waiting.
for (const read of reads.values()) reads.set(read, read);
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function waitSucceeded(result: OperationResponse): boolean {
  if (!result.ok) return false;
  const data = record(result.data);
  const recovery = record(data.recovery);
  if (result.wait?.job && recovery.jobId === result.wait.job.id && recovery.state !== "ready")
    return false;
  if (Array.isArray(data.items))
    return data.items.every((item) => waitSucceeded({ id: result.id, ...item }));
  if (
    Array.isArray(data.sourceAdmissions) &&
    data.sourceAdmissions.some((source) => {
      const admission = record(source);
      const job = record(admission.job);
      return (
        pendingAdmission(source) ||
        admission.admissionError != null ||
        (job.state !== undefined && job.state !== "ready")
      );
    })
  )
    return false;
  return (
    data.state === undefined ||
    (successful.has(String(data.state)) && data.finalizationError == null)
  );
}
function interrupted(result: Extract<OperationResponse, { ok: false }>) {
  return [
    "TIMEOUT",
    "ABORTED",
    "CONNECTION_ERROR",
    "CONNECTION_CLOSED",
    "INVALID_RESPONSE",
    "UNCORRELATED_RESPONSE",
  ].includes(result.error.code);
}

/** Wait on admitted work and pinned reads; execution and retry ownership remain in the service. */
export async function waitForWork(options: {
  request: OperationRequest;
  initial: OperationResponse;
  timeoutMs: number;
  signal: AbortSignal;
  call(operation: string, params: Record<string, unknown>): Promise<OperationResponse>;
  progress(message: string): void;
  close(token: string): Promise<void>;
}): Promise<OperationResponse> {
  const { request, timeoutMs, signal, call } = options;
  let latest = options.initial;
  let current = jobSummary.safeParse(options.initial.ok ? options.initial.data : null).data;
  let progress = "";
  let settled = false;
  const jobs = new Map<string, z.infer<typeof jobSummary>>();
  if (current) jobs.set(current.id, current);
  let batchSelection: unknown;
  const failures = new Map<number, OperationResponse>();
  const inspect = async (jobId: string) => {
    const result = await call("job.get", { jobId });
    if (result.ok) {
      const job = jobSummary.parse(result.data);
      // A job's target names what it works on; the waited response named the same thing.
      const named = (kind: string) => (job.target.kind === kind ? job.target.id : undefined);
      for (const [key, value] of [
        ["assetId", named("asset")],
        ["projectId", named("project")],
        ["revisionId", job.target.revisionId],
      ] as const)
        if (pins[key] !== undefined && value !== pins[key])
          throw new ArtifactDeliveryError(
            "INVALID_RESPONSE",
            `Waiting job changed selected ${key}`,
          );
      const pinned = jobs.get(jobId);
      if (
        job.id !== jobId ||
        (pinned &&
          (pinned.attemptGeneration !== job.attemptGeneration ||
            pinned.attemptId !== job.attemptId ||
            !isDeepStrictEqual(pinned.target, job.target)))
      )
        throw new ArtifactDeliveryError(
          "INVALID_RESPONSE",
          "Waiting job changed its pinned attempt or target",
        );
      jobs.set(jobId, job);
    }
    return result;
  };
  const metadata = (
    state: WaitMetadata["state"],
    error?: Extract<OperationResponse, { ok: false }>["error"],
  ): OperationResponse => {
    settled = state === "settled";
    const identity = current
      ? {
          job: {
            id: current.id,
            attemptGeneration: current.attemptGeneration,
            attemptId: current.attemptId,
          },
        }
      : {};
    return {
      ...latest,
      wait:
        state === "interrupted"
          ? { state, timeoutMs, ...identity, error: error! }
          : { state, timeoutMs, ...identity },
    };
  };
  const expired = () => signal.aborted && signal.reason === "wait_deadline";
  const stopped = () =>
    metadata(
      expired() ? "timed_out" : "interrupted",
      operationError("ABORTED", "Waiting was interrupted; admitted work is not rolled back").error,
    );
  const pins = record(latest.ok ? latest.data : null);
  let read = reads.get(request.operation);
  if (request.operation === "transcript.search") read = "transcript.search";
  let params: Record<string, unknown> =
    read === "model.status" ? { modelId: request.params.modelId } : { ...request.params };
  const sourcePreparation =
    read === "transcript.get" && request.operation === "transcript.transcribe";
  if (sourcePreparation) {
    delete params.requestId;
    delete params.sourceRange;
    delete params.context;
    const retainedGeneration = record(record(pins.published).output).generation;
    if (typeof retainedGeneration === "string") params.generation = retainedGeneration;
  }
  // Rendered recognition reads its words pinned to the generation the preparation published.
  const renderPreparation = read === "transcript.render.get" && read !== request.operation;
  if (renderPreparation) params = { projectId: params.projectId, revisionId: params.revisionId };
  // A preparation's work is keyed by its applied range, and the pinned read can't re-admit the
  // requested one, so the read carries the preparation's clamp.
  const admission =
    (sourcePreparation || renderPreparation) && Array.isArray(pins.issues) ? pins.issues : [];
  // A mutation that returns its record waits through that record's own getter.
  const recordParam = read ? recordGetters.get(read) : undefined;
  if (recordParam && typeof pins.id === "string") params = { [recordParam]: pins.id };
  const selectionKeys = [
    "projectId",
    "revisionId",
    "assetId",
    "streamId",
    "acquisitionId",
    "exportId",
    "recordingId",
    ...(recordParam ? ["id"] : []),
  ];
  if (read && pins.revisionId !== undefined) params.revisionId = pins.revisionId;
  if (read === "index.frames" && typeof pins.generation === "string")
    params.generation = pins.generation;
  const workStatus = (data: Record<string, unknown>) => {
    const recovery = record(data.recovery);
    return read === "export.status" && typeof recovery.jobId === "string" ? recovery : data;
  };
  /** The job that runs this work: a status refers to it; a job's own record is it. */
  const jobOf = (work: Record<string, unknown>) =>
    typeof work.jobId === "string"
      ? work.jobId
      : jobSummary.safeParse(work).success
        ? (work.id as string)
        : undefined;

  const closed = new Set<string>();
  const close = async (result: OperationResponse) => {
    if (!result.ok) return;
    const data = record(result.data);
    const values = Array.isArray(data.items)
      ? data.items.filter((item) => item.ok).map((item) => record(item.data))
      : [data];
    for (const value of values) {
      const token = record(value.delivery).token;
      if (typeof token === "string" && !closed.has(token)) {
        closed.add(token);
        await options.close(token);
      }
    }
  };
  const update = async (result: OperationResponse) => {
    if (result.ok) {
      const data = record(result.data);
      for (const key of selectionKeys)
        if (pins[key] !== undefined && data[key] !== pins[key]) {
          await close(result);
          throw new ArtifactDeliveryError("INVALID_RESPONSE", `Waiting read changed pinned ${key}`);
        }
      if (
        data.state === "ready" &&
        typeof data.generation === "string" &&
        current &&
        data.generation !== current.attemptId
      ) {
        await close(result);
        throw new ArtifactDeliveryError(
          "INVALID_RESPONSE",
          "Waiting evidence page changed its completed attempt",
        );
      }
    }
    closed.clear();
    const read = record(result.ok ? result.data : null);
    latest =
      result.ok && admission.length
        ? {
            ...result,
            data: {
              ...read,
              issues: boundedIssues([
                ...(admission as Issue[]),
                ...((Array.isArray(read.issues) ? read.issues : []) as Issue[]),
              ]),
            },
          }
        : result;
  };
  try {
    if (
      read &&
      !renderPreparation &&
      !operationSchema.safeParse({ operation: read, params }).success
    ) {
      throw new ArtifactDeliveryError(
        "INVALID_RESPONSE",
        "Acknowledgement cannot pin the advertised read",
      );
    }
    for (;;) {
      if (signal.aborted) {
        await close(latest);
        return stopped();
      }
      if (!latest.ok)
        return interrupted(latest) ? metadata("interrupted", latest.error) : metadata("settled");
      const data = record(latest.data);
      const renderedGeneration = record(record(data.published).output).generation;
      if (renderPreparation && data.page === undefined && typeof renderedGeneration === "string") {
        params.generation = renderedGeneration;
        const next = await call(read!, params);
        if (!next.ok && interrupted(next))
          return expired() ? metadata("timed_out") : metadata("interrupted", next.error);
        await update(next);
        continue;
      }
      const work = workStatus(data);
      // Package admissions expose a context-job ID that public job.get cannot inspect.
      const jobId = read === "package.status" ? undefined : jobOf(work);
      // Issues never change the exit status; a ready output names how many it carries.
      // A read's admission issues sit beside the issues published with its output and with each
      // source generation a project read names.
      const issues = [
        data.issues,
        record(data.published).issues,
        ...(Array.isArray(data.dependencies)
          ? data.dependencies.map((dependency) => record(dependency).issues)
          : []),
      ].flatMap((value) => (Array.isArray(value) ? value : []));
      const count = issueCount(issues as Issue[]);
      const attempt =
        current ??
        (jobId && typeof work.attemptGeneration === "number"
          ? { id: jobId, attemptGeneration: work.attemptGeneration }
          : undefined);
      const suffix = attempt ? `(${attempt.id}, attempt ${attempt.attemptGeneration})` : "";
      const marker =
        work.state === "ready" && count > 0
          ? `${request.operation}: ready (${count} issues)${suffix ? ` ${suffix}` : ""}`
          : `${request.operation}: ${String(work.state ?? "batch")} ${suffix}`;
      if (marker !== progress) {
        progress = marker;
        options.progress(marker);
      }
      if (batchReferences.has(request.operation)) {
        const batch = describeBatch(latest, batchReferences.get(request.operation)!);
        const references = batch.items.map((item) => ("atUs" in item ? item.atUs : item.ordinal));
        if (batchSelection !== undefined && !isDeepStrictEqual(batchSelection, references))
          throw new ArtifactDeliveryError(
            "INVALID_RESPONSE",
            "Waiting batch changed its selected item order",
          );
        batchSelection = references;
        let waiting = false;
        const items = [];
        for (const [index, item] of batch.items.entries()) {
          const failed = failures.get(index);
          if (failed) {
            await close({ id: latest.id, ...item });
            items.push({ ...item, ...failed });
            continue;
          }
          if (!item.ok) {
            items.push(item);
            continue;
          }
          const value = record(item.data);
          if (typeof value.jobId === "string") {
            const inspected = await inspect(value.jobId);
            if (!inspected.ok && interrupted(inspected))
              return expired() ? metadata("timed_out") : metadata("interrupted", inspected.error);
            const state = inspected.ok ? record(inspected.data).state : "failed";
            if (unsuccessful.has(String(state))) {
              await close({ id: latest.id, ...item });
              failures.set(index, inspected);
              items.push({ ...item, ...inspected });
              continue;
            }
            if (state !== "ready") waiting = true;
            else if (
              String(record(value.published).generation) !==
                String(jobs.get(value.jobId)!.attemptGeneration) ||
              stillPending(value)
            )
              waiting = true;
          } else if (stillPending(value)) waiting = true;
          items.push(item);
        }
        latest = { ...latest, data: { ...batch, items } };
        if (!waiting) return metadata("settled");
        await close(latest);
        await delay(100, undefined, { signal });
        const next = await call(read!, params);
        if (!next.ok && interrupted(next))
          return expired() ? metadata("timed_out") : metadata("interrupted", next.error);
        await update(next);
        continue;
      }
      if (typeof jobId === "string") {
        const inspected = await inspect(jobId);
        if (!inspected.ok) {
          await close(latest);
          return interrupted(inspected)
            ? expired()
              ? metadata("timed_out")
              : metadata("interrupted", inspected.error)
            : { ...inspected, wait: { state: "settled", timeoutMs } };
        }
        const job = jobSummary.parse(inspected.data);
        current = job;
        if (unsuccessful.has(job.state)) {
          await close(latest);
          if (read === "export.status") {
            if (!stillPending(work)) return metadata("settled");
            await delay(100, undefined, { signal });
            const next = await call(read, params);
            if (!next.ok && interrupted(next))
              return expired() ? metadata("timed_out") : metadata("interrupted", next.error);
            await update(next);
            continue;
          }
          latest = inspected;
          return metadata("settled");
        }
        if (job.state === "ready") {
          const publication = record(work.published);
          if (
            !stillPending(work) &&
            (!publication.generation ||
              String(publication.generation) === String(job.attemptGeneration))
          )
            return metadata("settled");
          if (
            !stillPending(work) &&
            publication.generation &&
            String(publication.generation) !== String(job.attemptGeneration)
          )
            throw new ArtifactDeliveryError(
              "INVALID_RESPONSE",
              "Ready read names an older publication than its completed job",
            );
          await close(latest);
          if (!read) {
            latest = inspected;
            return metadata("settled");
          }
          if (sourcePreparation || renderPreparation) params.generation = job.attemptId;
          await delay(100, undefined, { signal });
          const next = await call(read, params);
          if (!next.ok && interrupted(next))
            return expired() ? metadata("timed_out") : metadata("interrupted", next.error);
          await update(next);
          const nextData = workStatus(record(next.ok ? next.data : null));
          if (
            nextData.jobId !== job.id &&
            (typeof nextData.jobId === "string" || stillPending(nextData))
          )
            current = undefined;
          continue;
        }
        if (!read) latest = inspected;
      } else if (!stillPending(work)) return metadata("settled");
      else if (!read)
        throw new ArtifactDeliveryError(
          "INVALID_RESPONSE",
          "Pending acknowledgement has no advertised work read",
        );
      await close(latest);
      await delay(100, undefined, { signal });
      if (typeof jobId !== "string") {
        const next = await call(read!, params);
        if (
          !next.ok &&
          (interrupted(next) || (read === "package.status" && next.error.code === "NOT_FOUND"))
        )
          return expired() ? metadata("timed_out") : metadata("interrupted", next.error);
        await update(next);
      }
    }
  } catch (error) {
    await close(latest);
    if (signal.aborted) return stopped();
    if (error instanceof ArtifactDeliveryError)
      return metadata("interrupted", operationError(error.code, error.message).error);
    if (error instanceof z.ZodError)
      return metadata(
        "interrupted",
        operationError("INVALID_RESPONSE", "Waiting received malformed job identity").error,
      );
    throw error;
  } finally {
    if (!settled) await close(latest);
  }
}
