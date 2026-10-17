import { DatabaseSync } from "node:sqlite";
import { refusalRetryable } from "@yap/protocol";
/**
 * The persisted contract shared by catalog owners. Additive tables are created idempotently.
 * Changes to existing shapes or required ownership records need a bump and an explicit
 * migration owner. Launch version 0.1.33 is the compatibility floor and already uses 29;
 * earlier catalogs are refused until a deliberately tested migration is added.
 */
export const catalogFormat = 29;
export const minimumSupportedCatalogFormat = 29;
export class CatalogError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.retryable = refusalRetryable(this.code);
  }
}

/**
 * A refusal that reports a dependency's failure. Retryability belongs to the code, so the
 * dependency's own code is kept only when the ledger agrees with how that dependency can be
 * retried; otherwise the generic dependency code with the matching retryability is reported.
 */
export function dependencyRefusal(
  code: string,
  message: string,
  details: Record<string, unknown>,
  retryable: boolean,
): CatalogError {
  if (refusalRetryable(code) === retryable) return new CatalogError(code, message, details);
  return new CatalogError(retryable ? "DEPENDENCY_FAILED" : "DEPENDENCY_REFUSED", message, {
    ...details,
    dependencyCode: code,
  });
}

/** One SQLite connection and transaction boundary, shared by the library owners. */
export class Catalog {
  readonly catalog: DatabaseSync;
  constructor(path: string, busyTimeoutMs = 1000) {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 10000)
      throw new RangeError("SQLite timeout must be 0–10000 milliseconds");
    this.catalog = new DatabaseSync(path, { timeout: busyTimeoutMs });
    const { user_version: format } = this.catalog.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (format === 0 && !this.catalog.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get())
      this.catalog.exec(`PRAGMA user_version=${catalogFormat}`);
    else if (format !== catalogFormat) {
      this.catalog.close();
      throw new CatalogError(
        "UNSUPPORTED_CATALOG",
        "This catalog was written in another format; open a library created by this version.",
        { format, supportedFormat: catalogFormat },
      );
    }
  }
  close(): void {
    if (this.catalog.isOpen) this.catalog.close();
  }
  /** One immediate transaction for writes that must land together, reporting a lock wait as retryable. */
  transaction<T>(run: () => T): T {
    let began = false;
    try {
      this.catalog.exec("BEGIN IMMEDIATE");
      began = true;
      const result = run();
      this.catalog.exec("COMMIT");
      return result;
    } catch (error) {
      if (began) this.catalog.exec("ROLLBACK");
      if (error && typeof error === "object" && "errcode" in error && error.errcode === 5)
        throw new CatalogError("STORAGE_BUSY", "Catalog is locked; retry the request", {});
      throw error;
    }
  }
}
