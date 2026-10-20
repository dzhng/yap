import { spawn } from "node:child_process";

function failure(code, message, details = {}, retryable = false, retryAfterMs) {
  return Object.assign(new Error(message), {
    code,
    details,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Consumer helpers share this bounded, single-call CLI boundary. Never retries. */
export function createCli({
  executable = "yap",
  socket,
  timeoutMs = 200_000,
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw failure("INVALID_REQUEST", "CLI timeout and output limit must be positive integers");
  return (operation, params, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(failure("CANCELED", "CLI call canceled"));
        return;
      }
      let input;
      try {
        input = JSON.stringify(params);
      } catch (error) {
        reject(error);
        return;
      }
      const args = [operation, "--params", "-", ...(socket ? ["--socket", socket] : [])];
      const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
      const chunks = [];
      let size = 0,
        error;
      const stop = (reason) => {
        if (error) return;
        error = reason;
        child.kill("SIGKILL");
        // Only the CLI is ours. App/service descendants may own their own lifetime;
        // inherited pipes must not keep this stopped exchange open.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const abort = () => stop(failure("CANCELED", "CLI call canceled"));
      const timer = setTimeout(
        () => stop(failure("CLI_TIMEOUT", "CLI call exceeded its deadline", { timeoutMs }, true)),
        timeoutMs,
      );
      child.on("error", (reason) => stop(failure("CLI_UNAVAILABLE", reason.message)));
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes)
            stop(failure("LIMIT_EXCEEDED", "CLI output exceeded its byte limit", { maxBytes }));
          else if (stream === child.stdout) chunks.push(chunk);
        });
      }
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
          return;
        }
        let envelope;
        try {
          envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reject(
            failure("INVALID_CLI_RESPONSE", "CLI did not return a JSON envelope", { exitCode }),
          );
          return;
        }
        if (envelope?.ok === false && typeof envelope.error?.code === "string") {
          reject(
            failure(
              envelope.error.code,
              envelope.error.message,
              envelope.error.details,
              envelope.error.retryable,
              envelope.error.retryAfterMs,
            ),
          );
        } else if (exitCode === 0 && envelope?.ok === true && "data" in envelope) {
          resolve(envelope.data);
        } else {
          reject(
            failure("INVALID_CLI_RESPONSE", "CLI result and exit status disagree", { exitCode }),
          );
        }
      });
      child.stdin.on("error", () => {});
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(input);
    });
}
