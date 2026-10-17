import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { mkdir, open, rename, rm, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { O_NOFOLLOW_ANY } from "./open-flags.js";
import { CatalogError } from "./catalog.js";
import type {
  SpeechModelFile,
  SpeechEnginePins,
  ModelStatus,
  SpeechModelRequest,
  ModelManifest,
  ModelSources,
  PreparedRuntime,
  RuntimeMaterializer,
} from "./model-types.js";
import { registeredModels } from "./model-registry.js";
import { adoptFile, adoptRuntime, verifyRuntime } from "./model-files.js";
export type * from "./model-types.js";
export { parakeetModel } from "./model-registry.js";

type Receipt = {
  modelDigest: string;
  files: Record<string, { modifiedNs: string; inode: string }>;
  runtimeDigest?: string;
};
type Flight = {
  readonly controller: AbortController;
  done: Promise<void>;
  participants: number;
  receivedBytes: number;
  readonly startedAtMs: number;
  sources: ModelSources;
};

const storageFailure = (error: unknown) =>
  error instanceof CatalogError
    ? error
    : new CatalogError(
        "MODEL_STORAGE_FAILED",
        `Model storage failed: ${(error as Error).message}`,
        {
          cause: (error as NodeJS.ErrnoException).code,
        },
      );
async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw storageFailure(error);
  }
}
function privateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isDirectory())
    throw new CatalogError("MODEL_STORAGE_FAILED", "Model directory must not be a link");
}
async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  for (let offset = 0; offset < data.byteLength;)
    offset += (await handle.write(data, offset)).bytesWritten;
}
/** Creates a new regular file that cannot land through a symlinked path component. */
const createFile = (path: string) =>
  open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY, 0o600);

/**
 * Owns the pinned speech model under `<home>/models/<name>/<revision>/<folderName>`. Only
 * `prepare` uses the network; status and the native request read local files alone.
 */
class Preparation {
  readonly modelDigest: string;
  readonly pins: SpeechEnginePins;
  get updateBlocked(): boolean {
    return !!this.flight || !!this.verification;
  }
  private flight: Flight | undefined;
  onUpdateProgress: (() => void) | undefined;
  private failure: CatalogError | undefined;
  private verification: Promise<ModelStatus> | undefined;
  constructor(
    private readonly models: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    readonly manifest: ModelManifest,
    private readonly materializeRuntime: RuntimeMaterializer | undefined,
  ) {
    this.modelDigest = createHash("sha256")
      .update(
        JSON.stringify(
          [...manifest.files]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .map((file) => [file.path, file.bytes, file.sha256]),
        ),
      )
      .digest("hex");
    this.pins = { ...manifest.engine, model: manifest.repo, modelRevision: manifest.revision };
    privateDirectory(join(this.models, manifest.name));
  }

  /** Details an agent can show before asking the user to acquire an optional dependency. */
  notPreparedError(purpose: ModelManifest["purpose"] = this.manifest.purpose): CatalogError {
    const modelBytes = this.manifest.files.reduce((total, file) => total + file.bytes, 0);
    const runtime = this.manifest.runtimeArtifact;
    const runtimeBytes = runtime
      ? runtime.acquisition
        ? runtime.acquisition.files.reduce((total, file) => total + file.bytes, 0)
        : runtime.entries.reduce(
            (total, entry) => total + (entry.kind === "file" ? entry.bytes : 0),
            0,
          )
      : 0;
    const purposeLabel = purpose === "transcription" ? "transcription" : purpose;
    const operation =
      purpose === "transcription"
        ? "transcript.transcribe"
        : purpose === "alignment"
          ? "alignment.observe"
          : purpose === "speaker"
            ? "speaker.observe"
            : "voice.generate";
    const scope = {
      modelFiles: this.manifest.files.length,
      modelBytes,
      runtimeFiles: runtime
        ? runtime.acquisition
          ? runtime.acquisition.files.length
          : runtime.entries.filter((entry) => entry.kind === "file").length
        : 0,
      runtimeBytes,
      runtimeAcquisition: runtime?.acquisition
        ? "registered acquisition"
        : runtime
          ? "registered runtime inventory"
          : null,
    };
    const estimatedBytes = modelBytes + runtimeBytes;
    return new CatalogError(
      "MODEL_NOT_PREPARED",
      `The ${purposeLabel} model/runtime is not prepared. model.prepare will download/acquire and verify the ${purposeLabel} model/runtime files before ${operation} can run.`,
      {
        modelId: this.manifest.name,
        purpose,
        downloadScope: scope,
        estimatedBytes,
        estimatedBytesKnown: true,
        whyNeeded: `${operation} needs the registered ${purposeLabel} model/runtime to produce its evidence or audio output.`,
        retryable: true,
        retryOperation: operation,
      },
    );
  }

  private platformFailure(): CatalogError | undefined {
    const required = this.manifest.platform;
    if (required.system !== process.platform || required.architecture !== process.arch)
      return new CatalogError(
        "MODEL_PLATFORM_UNSUPPORTED",
        "Registered model execution requires a different platform",
        { required, actual: { system: process.platform, architecture: process.arch } },
      );
    return undefined;
  }

  snapshot(): ModelStatus {
    const unsupported = this.platformFailure();
    if (unsupported)
      return {
        state: "failed",
        code: unsupported.code,
        message: unsupported.message,
        retryable: false,
      };
    if (this.flight)
      return (() => {
        const totalBytes =
          this.manifest.files.reduce((total, file) => total + file.bytes, 0) +
          (!this.flight.sources.runtimeSource && this.manifest.runtimeArtifact?.acquisition
            ? this.manifest.runtimeArtifact.acquisition.files.reduce(
                (total, file) => total + file.bytes,
                0,
              )
            : (this.manifest.runtimeArtifact?.entries.reduce(
                (total, entry) => total + (entry.kind === "file" ? entry.bytes : 0),
                0,
              ) ?? 0));
        const elapsedMs = Math.max(0, Date.now() - this.flight!.startedAtMs);
        const rate = elapsedMs > 0 ? this.flight!.receivedBytes / elapsedMs : 0;
        return {
          state: "preparing",
          receivedBytes: this.flight!.receivedBytes,
          totalBytes,
          etaMs:
            rate > 0
              ? Math.ceil(Math.max(0, totalBytes - this.flight!.receivedBytes) / rate)
              : null,
        };
      })();
    // A failed preparation saw more than the receipt can, so it outranks receipt readiness.
    if (!this.failure) return { state: this.inspect() };
    const { code, message, retryable } = this.failure;
    return { state: "failed", code, message, retryable };
  }

  async status(): Promise<ModelStatus> {
    if (this.platformFailure()) return this.snapshot();
    if (this.flight || !this.manifest.runtimeArtifact) return this.snapshot();
    if (this.verification) return this.verification;
    this.verification = this.verify();
    try {
      return await this.verification;
    } finally {
      this.verification = undefined;
      this.onUpdateProgress?.();
    }
  }

  private async verify(): Promise<ModelStatus> {
    const state = this.inspect();
    if (state === "ready") {
      try {
        await verifyRuntime(join(this.root, "runtime"), this.manifest.runtimeArtifact!);
      } catch {
        return { state: "invalid" };
      }
      return { state: "ready" };
    }
    if (!this.failure) return { state };
    const { code, message, retryable } = this.failure;
    return { state: "failed", code, message, retryable };
  }

  /**
   * Startup's readiness: the receipt matches the model files and the runtime matches its
   * registered inventory by metadata. No bytes are hashed; execution still verifies them.
   */
  async intact(signal: AbortSignal): Promise<boolean> {
    if (this.snapshot().state !== "ready") return false;
    const runtime = this.manifest.runtimeArtifact;
    if (!runtime) return true;
    try {
      await verifyRuntime(join(this.root, "runtime"), runtime, signal, "inventory");
      return true;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  async settled(): Promise<void> {
    await Promise.allSettled([this.flight?.done, this.verification]);
  }

  async runtime(purpose: "voice" | "speaker" | "alignment"): Promise<PreparedRuntime> {
    const unsupported = this.platformFailure();
    if (unsupported) throw unsupported;
    if (this.manifest.purpose !== purpose)
      throw new CatalogError(
        "INVALID_REQUEST",
        "Selected model has a different execution purpose",
        { purpose, selected: this.manifest.purpose },
      );
    const runtime = this.manifest.runtimeArtifact;
    if (!runtime || (await this.status()).state !== "ready") throw this.notPreparedError(purpose);
    const cache = join(this.models, ".cache", this.manifest.name);
    await mkdir(cache, { recursive: true, mode: 0o700 });
    return {
      python: join(this.root, "runtime", runtime.python),
      entry: join(this.root, "runtime", runtime.entry),
      model: join(this.root, this.manifest.folderName),
      cache,
      descriptorDigest: this.descriptorDigest,
      runtimeDigest: runtime.digest,
      modelDigest: this.modelDigest,
      runtimeRevision: this.manifest.engine.runtimeRevision,
      modelRevision: this.manifest.revision,
    };
  }

  get descriptorDigest(): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          modelDigest: this.modelDigest,
          pins: this.pins,
          purpose: this.manifest.purpose,
          platform: this.manifest.platform,
          runtimeDigest: this.manifest.runtimeArtifact?.digest,
          generationProfile: this.manifest.generationProfile,
        }),
      )
      .digest("hex");
  }

  /** The model part of a native speech.transcribe request; native re-verifies every listed file. */
  nativeRequest(): SpeechModelRequest {
    const unsupported = this.platformFailure();
    if (unsupported) throw unsupported;
    if (this.inspect() !== "ready") throw this.notPreparedError("transcription");
    return { directory: join(this.root, this.manifest.folderName), files: this.manifest.files };
  }

  /** Joins any prepare in flight; the download stops only once every joined caller aborted. */
  prepare(signal: AbortSignal, sources: ModelSources): Promise<void> {
    const unsupported = this.platformFailure();
    if (unsupported) throw unsupported;
    signal.throwIfAborted();
    for (const path of [sources.runtimeSource, sources.modelSource])
      if (path !== undefined && !isAbsolute(path))
        throw new CatalogError("INVALID_REQUEST", "Model source paths must be absolute");
    const flight =
      this.flight && !this.flight.controller.signal.aborted ? this.flight : this.start(sources);
    flight.participants += 1;
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        flight.participants -= 1;
        if (flight.participants === 0) {
          flight.controller.abort(signal.reason);
          // The final caller owns shutdown: do not release its lifetime before staging cleanup.
          void flight.done.then(
            () => reject(signal.reason),
            () => reject(signal.reason),
          );
        } else reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      flight.done.finally(() => signal.removeEventListener("abort", abort)).then(resolve, reject);
    });
  }

  private get root(): string {
    return join(this.models, this.manifest.name, this.manifest.revision);
  }

  private start(sources: ModelSources): Flight {
    this.failure = undefined;
    const flight: Flight = {
      controller: new AbortController(),
      done: Promise.resolve(),
      participants: 0,
      receivedBytes: 0,
      startedAtMs: Date.now(),
      sources,
    };
    this.flight = flight;
    flight.done = this.run(flight);
    return flight;
  }

  private async run(flight: Flight): Promise<void> {
    try {
      await this.install(flight);
    } catch (error) {
      if (flight.controller.signal.aborted) throw flight.controller.signal.reason;
      this.failure = storageFailure(error);
      throw this.failure;
    } finally {
      if (this.flight === flight) {
        this.flight = undefined;
        this.onUpdateProgress?.();
      }
    }
  }

  private inspect(): "absent" | "ready" | "invalid" {
    const root = this.root;
    try {
      lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      return "invalid";
    }
    try {
      const folder = join(root, this.manifest.folderName);
      for (const path of [this.models, dirname(root), root, folder])
        if (!lstatSync(path).isDirectory()) return "invalid";
      const fd = openSync(join(root, "receipt.json"), constants.O_RDONLY | O_NOFOLLOW_ANY);
      let receipt: Receipt;
      try {
        receipt = JSON.parse(readFileSync(fd, "utf8")) as Receipt;
      } finally {
        closeSync(fd);
      }
      if (
        receipt.modelDigest !== this.modelDigest ||
        receipt.runtimeDigest !== this.manifest.runtimeArtifact?.digest
      )
        return "invalid";
      const present = new Map<string, BigIntStats>();
      const walk = (directory: string, prefix: string) => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name),
            stat = lstatSync(path, { bigint: true });
          if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
          else present.set(`${prefix}${name}`, stat);
        }
      };
      walk(folder, "");
      if (present.size !== this.manifest.files.length) return "invalid";
      for (const file of this.manifest.files) {
        const stat = present.get(file.path),
          identity = receipt.files[file.path];
        if (
          !stat?.isFile() ||
          stat.size !== BigInt(file.bytes) ||
          String(stat.mtimeNs) !== identity?.modifiedNs ||
          String(stat.ino) !== identity.inode
        )
          return "invalid";
      }
      return "ready";
    } catch {
      return "invalid";
    }
  }

  private async verifyInstalled(): Promise<ModelStatus> {
    return this.manifest.runtimeArtifact ? this.verify() : { state: this.inspect() };
  }

  private async install(flight: Flight): Promise<void> {
    if ((await this.verifyInstalled()).state === "ready") return;
    const signal = flight.controller.signal;
    signal.throwIfAborted();
    if (
      this.manifest.runtimeArtifact &&
      !flight.sources.runtimeSource &&
      !this.manifest.runtimeArtifact.acquisition
    )
      throw new CatalogError(
        "MODEL_SOURCE_REQUIRED",
        "This model requires an explicit local runtime artifact source",
      );
    if (this.manifest.modelSourceRequired && !flight.sources.modelSource)
      throw new CatalogError(
        "MODEL_SOURCE_REQUIRED",
        "This model requires an explicit local model source",
      );
    if (
      this.manifest.runtimeArtifact?.acquisition &&
      !flight.sources.runtimeSource &&
      !this.materializeRuntime
    )
      throw new CatalogError(
        "MODEL_RUNTIME_UNAVAILABLE",
        "Runtime preparation requires its owned execution adapter",
      );
    const staging = join(this.models, ".staging", randomUUID());
    try {
      const folder = join(staging, this.manifest.folderName);
      await stored(() => mkdir(folder, { recursive: true, mode: 0o700 }));
      const receipt: Receipt = { modelDigest: this.modelDigest, files: {} };
      const modelSource = flight.sources.modelSource
        ? await realpath(flight.sources.modelSource)
        : undefined;
      if (this.manifest.runtimeArtifact) {
        const runtime = this.manifest.runtimeArtifact;
        if (flight.sources.runtimeSource)
          await adoptRuntime(
            flight.sources.runtimeSource!,
            join(staging, "runtime"),
            this.manifest.runtimeArtifact,
            signal,
            (bytes) => {
              flight.receivedBytes += bytes;
            },
          );
        else {
          const acquisition = runtime.acquisition!;
          const input = join(staging, ".runtime-input"),
            content = join(input, "content");
          for (const file of acquisition.files) {
            if (new URL(file.url).protocol !== "https:")
              throw new CatalogError(
                "INVALID_MODEL",
                "Registered runtime inputs must name immutable HTTPS artifacts",
              );
            await this.download(file, input, flight, file.url);
          }
          await mkdir(content, { mode: 0o700 });
          await this.materializeRuntime!({
            inputs: input,
            directory: content,
            acquisition,
            signal,
          });
          await verifyRuntime(content, runtime, signal);
          await rename(content, join(staging, "runtime"));
          await rm(input, { recursive: true });
        }
        receipt.runtimeDigest = this.manifest.runtimeArtifact.digest;
      }
      for (const file of this.manifest.files)
        receipt.files[file.path] = modelSource
          ? await adoptFile(
              join(modelSource, file.path),
              join(folder, file.path),
              file,
              signal,
              (bytes) => {
                flight.receivedBytes += bytes;
              },
            )
          : await this.download(file, folder, flight);
      await stored(async () => {
        const handle = await createFile(join(staging, "receipt.json"));
        try {
          await writeAll(handle, Buffer.from(JSON.stringify(receipt)));
          await handle.datasync();
        } finally {
          await handle.close();
        }
      });
      signal.throwIfAborted();
      await stored(async () => {
        try {
          await rename(staging, this.root);
        } catch (error) {
          if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
          if ((await this.verifyInstalled()).state === "ready") return;
          // Replace an invalid install whole: the old tree moves into staging before removal.
          const replaced = join(this.models, ".staging", randomUUID());
          await rename(this.root, replaced);
          await rename(staging, this.root);
          await rm(replaced, { recursive: true, force: true });
        }
      });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async download(
    file: SpeechModelFile,
    folder: string,
    flight: Flight,
    url?: string,
  ): Promise<Receipt["files"][string]> {
    const target = join(folder, file.path);
    await stored(() => mkdir(dirname(target), { recursive: true, mode: 0o700 }));
    const failed = (reason: string, details: Record<string, unknown> = {}) =>
      new CatalogError("MODEL_DOWNLOAD_FAILED", `Model download failed: ${reason}`, {
        path: file.path,
        ...details,
      });
    const mismatch = (details: Record<string, unknown>) =>
      new CatalogError("MODEL_HASH_MISMATCH", "Downloaded model file does not match its pin", {
        path: file.path,
        expectedBytes: file.bytes,
        expectedSha256: file.sha256,
        ...details,
      });
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await this.fetch(
        url ??
          `https://huggingface.co/${this.manifest.repo}/resolve/${this.manifest.revision}/${path}`,
        { signal: flight.controller.signal },
      );
    } catch (error) {
      throw failed((error as Error).message);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw failed(`HTTP ${response.status}`, { status: response.status });
    }
    const reader = response.body.getReader();
    try {
      const handle = await stored(() => createFile(target));
      try {
        const hash = createHash("sha256");
        let bytes = 0;
        for (;;) {
          const received = bytes;
          const chunk = await reader.read().catch((error: Error) => {
            throw failed(error.message, { receivedBytes: received });
          });
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          flight.receivedBytes += chunk.value.byteLength;
          if (bytes > file.bytes) throw mismatch({ receivedBytes: bytes });
          hash.update(chunk.value);
          await stored(() => writeAll(handle, chunk.value));
        }
        if (bytes !== file.bytes) throw mismatch({ receivedBytes: bytes });
        const sha256 = hash.digest("hex");
        if (sha256 !== file.sha256) throw mismatch({ sha256 });
        return await stored(async () => {
          await handle.datasync();
          const stat = await handle.stat({ bigint: true });
          return { modifiedNs: String(stat.mtimeNs), inode: String(stat.ino) };
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  }
}

/** One registry, staging recovery root, and preparation flight per immutable registered identity. */
export class Models {
  set onUpdateProgress(callback: (() => void) | undefined) {
    for (const preparation of this.preparations.values()) preparation.onUpdateProgress = callback;
  }
  get updateBlocked(): boolean {
    return [...this.preparations.values()].some((preparation) => preparation.updateBlocked);
  }
  private readonly preparations = new Map<string, Preparation>();
  constructor(
    home: string,
    fetch: typeof globalThis.fetch = globalThis.fetch,
    manifests: readonly ModelManifest[] = registeredModels,
    materializeRuntime?: RuntimeMaterializer,
  ) {
    const directory = join(realpathSync(home), "models");
    privateDirectory(directory);
    rmSync(join(directory, ".staging"), { recursive: true, force: true });
    privateDirectory(join(directory, ".staging"));
    for (const manifest of manifests) {
      if (this.preparations.has(manifest.name)) throw new Error("Duplicate registered model ID");
      this.preparations.set(
        manifest.name,
        new Preparation(directory, fetch, manifest, materializeRuntime),
      );
    }
  }
  private selected(modelId: string): Preparation {
    const model = this.preparations.get(modelId);
    if (!model)
      throw new CatalogError("NOT_FOUND", "Model is not registered", { modelId, kind: "model" });
    return model;
  }
  list() {
    return [...this.preparations].map(([modelId, model]) => ({
      modelId,
      purpose: model.manifest.purpose,
      platform: model.manifest.platform,
      descriptorDigest: model.descriptorDigest,
      modelDigest: model.modelDigest,
      pins: model.pins,
      ...(model.manifest.generationProfile
        ? { generationProfile: model.manifest.generationProfile }
        : {}),
      ...(model.manifest.runtimeArtifact
        ? { runtimeDigest: model.manifest.runtimeArtifact.digest }
        : {}),
      preparation: {
        runtimeSourceRequired:
          !!model.manifest.runtimeArtifact && !model.manifest.runtimeArtifact.acquisition,
        modelSourceRequired: !!model.manifest.modelSourceRequired,
        modelBytes: model.manifest.files.reduce((n, f) => n + f.bytes, 0),
        runtimeBytes:
          model.manifest.runtimeArtifact?.entries.reduce(
            (n, e) => n + (e.kind === "file" ? e.bytes : 0),
            0,
          ) ?? 0,
      },
    }));
  }
  async settled(): Promise<void> {
    await Promise.all([...this.preparations.values()].map((model) => model.settled()));
  }
  /**
   * Start background preparation for models marked as part of the app lifecycle. An intact model
   * (receipt and runtime inventory match) is ready without rehashing its runtime: that hash grows
   * with the runtime, and execution verifies the bytes before every run anyway. Anything else
   * falls through to full verification and repair.
   */
  async prepareAuto(signal: AbortSignal): Promise<void> {
    await Promise.all(
      [...this.preparations.values()]
        .filter((model) => model.manifest.autoPrepare)
        .map(async (model) => {
          if (!(await model.intact(signal))) await model.prepare(signal, {});
        }),
    );
  }
  async status(modelId: string) {
    return this.selected(modelId).status();
  }
  /**
   * Readiness from each preparation receipt, for the cheap service health check. Runtime bytes
   * are verified by preparation, explicit `status` and before every execution, never here: a
   * full hash grows with the installed runtime and would make health as slow as the largest one.
   */
  statuses() {
    return [...this.preparations].map(([modelId, model]) => ({
      modelId,
      purpose: model.manifest.purpose,
      status: model.snapshot(),
    }));
  }
  prepare(modelId: string, signal: AbortSignal, sources: ModelSources = {}) {
    return this.selected(modelId).prepare(signal, sources);
  }
  runtime(modelId: string, purpose: "voice" | "speaker" | "alignment") {
    return this.selected(modelId).runtime(purpose);
  }
  notPrepared(modelId: string, purpose: ModelManifest["purpose"] = "transcription") {
    return this.selected(modelId).notPreparedError(purpose);
  }
  /** The pinned original speaker contract, without exposing its full runtime inventory. */
  speaker(modelId: string) {
    const selected = this.selected(modelId),
      runtime = selected.manifest.runtimeArtifact;
    const checkpoint = selected.manifest.files[0];
    const worker = runtime?.entries.find((entry) => entry.path === "execution/worker.py");
    if (
      selected.manifest.purpose !== "speaker" ||
      selected.manifest.engine.decoder !== "sortformer-original30s" ||
      !runtime ||
      selected.manifest.files.length !== 1 ||
      !checkpoint ||
      worker?.kind !== "file"
    )
      throw new CatalogError(
        "INVALID_REQUEST",
        "Selected model does not provide the original speaker contract",
      );
    return {
      engine: {
        modelId,
        descriptorDigest: selected.descriptorDigest,
        modelDigest: selected.modelDigest,
        modelSha256: checkpoint.sha256,
        runtimeDigest: runtime.digest,
        workerSha256: worker.sha256,
        recipe: "original30s" as const,
      },
      checkpoint: checkpoint.path,
      status: () => selected.snapshot(),
      runtime: () => selected.runtime("speaker"),
    };
  }
  /** Pinned auxiliary CTC observations; this does not reinterpret the TDT transcript engine. */
  alignment(modelId: string) {
    const selected = this.selected(modelId),
      runtime = selected.manifest.runtimeArtifact;
    const checkpoint = selected.manifest.files[0];
    const worker = runtime?.entries.find((entry) => entry.path === "execution/worker.py");
    if (
      selected.manifest.purpose !== "alignment" ||
      selected.manifest.engine.decoder !== "nemo-auxiliary-ctc110-v1" ||
      worker?.kind !== "file" ||
      !runtime ||
      selected.manifest.files.length !== 1 ||
      !checkpoint
    )
      throw new CatalogError(
        "INVALID_REQUEST",
        "Selected model does not provide auxiliary CTC alignment",
      );
    return {
      engine: {
        modelId,
        descriptorDigest: selected.descriptorDigest,
        modelDigest: selected.modelDigest,
        modelSha256: checkpoint.sha256,
        runtimeDigest: runtime.digest,
        workerSha256: worker.sha256,
        recipe: "nemo-auxiliary-ctc110-v1" as const,
      },
      checkpoint: checkpoint.path,
      status: () => selected.snapshot(),
      runtime: () => selected.runtime("alignment"),
    };
  }
  transcription(modelId: string) {
    const selected = this.selected(modelId);
    if (selected.manifest.purpose !== "transcription")
      throw new CatalogError("INVALID_REQUEST", "Selected model does not transcribe");
    return {
      modelDigest: selected.modelDigest,
      pins: selected.pins,
      status: () => selected.snapshot(),
      nativeRequest: async () => selected.nativeRequest(),
      notPrepared: () => selected.notPreparedError("transcription"),
    };
  }
}
