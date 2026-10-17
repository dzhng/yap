import type { PackageSource } from "./preset-install.js";
import { folderFor, type PresetIndex, type PresetManifest } from "./preset-format.js";

export type RemoteOptions = {
  repo?: string;
  ref?: string;
  apiBase?: string;
  rawBase?: string;
  fetch?: typeof globalThis.fetch;
  maxIndexBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_INDEX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HEX40 = /^[a-f0-9]{40}$/i;

function errorAt(url: string, message: string): Error {
  return new Error(`${message}: ${url}`);
}

/** Reject with a timeout error unless `work` settles first; the timer is always cleared. */
async function within<T>(work: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => reject(errorAt(url, "request timed out")), ms);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  return new URL(url).host;
}

async function fetchWithTimeout(
  fetcher: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(errorAt(url, "request timed out")),
    timeoutMs,
  );
  try {
    // `within` also covers a fetch that ignores the abort signal.
    const response = await within(
      fetcher(url, { ...init, signal: controller.signal, redirect: "manual" }),
      timeoutMs,
      url,
    );
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400) {
      if (!location) throw errorAt(url, `redirect without location`);
      const redirected = new URL(location, url).toString();
      if (hostOf(redirected) !== hostOf(url))
        throw errorAt(url, `redirect off-host to ${redirected}`);
      return fetchWithTimeout(fetcher, redirected, timeoutMs, init);
    }
    if (response.url && hostOf(response.url) !== hostOf(url))
      throw errorAt(url, `redirect off-host to ${response.url}`);
    if (!response.ok) throw errorAt(url, `request failed with HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.includes(url)) throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw errorAt(url, "request timed out");
    throw errorAt(url, error instanceof Error ? error.message : String(error));
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function readLimited(
  response: Response,
  url: string,
  limit: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (!response.body) throw errorAt(url, "response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await within(reader.read(), timeoutMs, url);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw errorAt(url, `response exceeds ${limit} bytes`);
      chunks.push(next.value);
    }
  } catch (error) {
    throw error instanceof Error && error.message.includes(url)
      ? error
      : errorAt(url, error instanceof Error ? error.message : String(error));
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function remoteSource(options: RemoteOptions = {}): PackageSource {
  const repo = options.repo ?? "dzhng/yap";
  const ref = options.ref ?? "main";
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const rawBase = (options.rawBase ?? "https://raw.githubusercontent.com").replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxIndexBytes = options.maxIndexBytes ?? DEFAULT_INDEX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let commit: string | undefined;
  let commitPromise: Promise<string> | undefined;

  const resolveCommit = async (): Promise<string> => {
    if (commit) return commit;
    commitPromise ??= (async () => {
      const url = `${apiBase}/repos/${repo}/commits/${encodeURIComponent(ref)}`;
      const response = await fetchWithTimeout(fetcher, url, timeoutMs, {
        headers: { Accept: "application/vnd.github.sha" },
      });
      const body = new TextDecoder()
        .decode(await readLimited(response, url, 128, timeoutMs))
        .trim();
      if (!HEX40.test(body)) throw errorAt(url, `invalid commit ${body}`);
      commit = body.toLowerCase();
      return commit;
    })();
    return commitPromise;
  };

  const source: PackageSource = {
    source: "downloaded",
    get commit() {
      return commit;
    },
    async index(): Promise<PresetIndex> {
      const pinned = await resolveCommit();
      const url = `${rawBase}/${repo}/${pinned}/presets/index.json`;
      const response = await fetchWithTimeout(fetcher, url, timeoutMs, {});
      try {
        return JSON.parse(
          new TextDecoder().decode(await readLimited(response, url, maxIndexBytes, timeoutMs)),
        ) as PresetIndex;
      } catch (error) {
        if (error instanceof Error && error.message.includes(url)) throw error;
        throw errorAt(url, error instanceof Error ? error.message : String(error));
      }
    },
    // The installer checks each file's bytes and sha256.
    async file(pkg: PresetManifest, path: string): Promise<ReadableStream<Uint8Array>> {
      const pinned = await resolveCommit();
      const url = `${rawBase}/${repo}/${pinned}/presets/${folderFor(pkg)}/${path}`;
      const response = await fetchWithTimeout(fetcher, url, timeoutMs, {});
      if (!response.body) throw errorAt(url, "response has no body");
      const reader = response.body.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            // Inactivity timeout per read: a large file may take long, a stalled one may not.
            const next = await within(reader.read(), timeoutMs, url);
            if (next.done) {
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            reader.releaseLock();
            controller.error(
              error instanceof Error && error.message.includes(url)
                ? error
                : errorAt(url, error instanceof Error ? error.message : String(error)),
            );
          }
        },
        cancel(reason) {
          void reader.cancel(reason);
        },
      });
    },
  };
  return source;
}
