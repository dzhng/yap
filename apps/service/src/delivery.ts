import { randomUUID } from "node:crypto";
import { CatalogError } from "@yap/core/catalog";

export type DerivativeRead = {
  readonly bytes: number;
  read(buffer: Uint8Array, position: number): number;
  release(): void;
};

/** Identical IDs in different domains have independent delivery lifetimes. */
export type DerivativeOwner = Readonly<{
  kind: "recording" | "package" | "project" | "asset" | "result";
  id: string;
}>;

type Lease = {
  owner: DerivativeOwner;
  handle: DerivativeRead;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};
const lifetimeMs = 30_000;
const maximumLeases = 32;

/** Local metadata transport carries bounded chunks; the service retains the acquired read handle.
 * EOF does not close a lease: the last chunk must remain retryable after a lost response. */
export class DerivativeDelivery {
  private readonly leases = new Map<string, Lease>();
  private readonly reservations = new Set<symbol>();
  private disposed = false;
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return this.leases.size > 0 || this.reservations.size > 0;
  }

  /** Reserve capacity before work that may commit; release before opening its result in the same turn. */
  reserve(): () => void {
    this.requireCapacity();
    const reservation = Symbol();
    this.reservations.add(reservation);
    return () => {
      if (this.reservations.delete(reservation)) this.onUpdateProgress?.();
    };
  }

  private requireCapacity(): void {
    if (this.disposed) throw new CatalogError("OWNER_CLOSED", "Derivative delivery is closed");
    this.expire();
    if (this.leases.size + this.reservations.size >= maximumLeases)
      throw new CatalogError("CAPACITY_EXCEEDED", "Too many derivative deliveries are open");
  }

  open(
    owner: DerivativeOwner,
    acquire: () => DerivativeRead | null,
  ): { token: string; bytes: number; expiresAt: number } {
    this.requireCapacity();
    const retainedOwner = { ...owner };
    const handle = acquire();
    if (!handle)
      throw new CatalogError("ARTIFACT_EXPIRED", "Derivative is no longer available", {});
    try {
      const token = randomUUID();
      const expiresAt = Date.now() + lifetimeMs;
      const timer = setTimeout(() => this.close(token), lifetimeMs);
      timer.unref();
      this.leases.set(token, { owner: retainedOwner, handle, expiresAt, timer });
      return { token, bytes: handle.bytes, expiresAt };
    } catch (error) {
      handle.release();
      throw error;
    }
  }

  read(
    token: string,
    offset: number,
    maxBytes: number,
  ): {
    data: string;
    offset: number;
    nextOffset: number;
    eof: boolean;
  } {
    const lease = this.requireLease(token);
    // The operation schema bounds both values; only the delivery knows its own size.
    if (offset > lease.handle.bytes)
      throw new CatalogError("INVALID_RANGE", "Offset is past the end of the delivery");
    const size = Math.min(maxBytes, lease.handle.bytes - offset);
    const buffer = Buffer.alloc(size);
    try {
      let received = 0;
      while (received < size) {
        const count = lease.handle.read(buffer.subarray(received), offset + received);
        if (count === 0)
          throw new CatalogError(
            "ARTIFACT_EXPIRED",
            "Derivative ended before its published size",
            {},
          );
        received += count;
      }
      const nextOffset = offset + received;
      return {
        data: buffer.toString("base64"),
        offset,
        nextOffset,
        eof: nextOffset === lease.handle.bytes,
      };
    } catch (error) {
      this.close(token);
      throw error;
    }
  }

  /** A live consumer extends the same pin; silence still releases it automatically. */
  renew(token: string): { token: string; bytes: number; expiresAt: number } {
    const lease = this.requireLease(token);
    lease.expiresAt = Date.now() + lifetimeMs;
    lease.timer.refresh();
    return { token, bytes: lease.handle.bytes, expiresAt: lease.expiresAt };
  }

  private requireLease(token: string): Lease {
    const lease = this.leases.get(token);
    if (!lease || Date.now() >= lease.expiresAt) {
      this.close(token);
      throw new CatalogError("ARTIFACT_EXPIRED", "Derivative delivery has expired or closed", {});
    }
    return lease;
  }

  close(token: string): void {
    const lease = this.leases.get(token);
    if (!lease) return;
    this.leases.delete(token);
    clearTimeout(lease.timer);
    lease.handle.release();
    this.onUpdateProgress?.();
  }
  revoke({ kind, id }: DerivativeOwner): void {
    for (const [token, lease] of this.leases)
      if (lease.owner.kind === kind && lease.owner.id === id) this.close(token);
  }
  dispose(): void {
    this.disposed = true;
    this.reservations.clear();
    for (const token of this.leases.keys()) this.close(token);
  }
  private expire(): void {
    const now = Date.now();
    for (const [token, lease] of this.leases) if (now >= lease.expiresAt) this.close(token);
  }
}
