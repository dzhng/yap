import { randomUUID } from "node:crypto";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  operationError,
  type OperationFailure,
  type UpdateBlocker,
} from "@yap/protocol";

/** The fence owns only admission and its permit. Domain and transport owners retain their work. */
export class UpdateAdmission {
  private permit: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private waiting = false;
  private notification: ReturnType<typeof setImmediate> | undefined;
  constructor(
    private readonly blockers: () => UpdateBlocker[],
    private readonly emit: () => void,
    private readonly timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    private readonly watch: (waiting: boolean) => void = () => {},
  ) {}

  refusal(): OperationFailure | undefined {
    return this.permit
      ? operationError("UPDATING", "Service replacement is prepared; retry after the update")
      : undefined;
  }
  prepare() {
    if (this.permit)
      return {
        ok: false as const,
        error: operationError("UPDATING", "A replacement permit is already held").error,
      };
    const id = randomUUID();
    const timer = setTimeout(() => this.release(id), this.timeoutMs);
    timer.unref();
    this.permit = { id, timer };
    let blockers: UpdateBlocker[];
    try {
      blockers = this.blockers();
    } catch (error) {
      this.release(id);
      throw error;
    }
    if (blockers.length) {
      this.release(id);
      this.observe(true);
      return { ok: true as const, data: { kind: "blocked" as const, blockers } };
    }
    this.observe(false);
    return { ok: true as const, data: { kind: "prepared" as const, permitId: id } };
  }
  commit(id: string) {
    if (this.permit?.id !== id)
      return operationError("INVALID_PERMIT", "Replacement permit is no longer current");
    clearTimeout(this.permit.timer);
    return { ok: true as const, data: { committed: true } };
  }
  release(id: string) {
    if (this.permit?.id === id) {
      clearTimeout(this.permit.timer);
      this.permit = undefined;
      this.observe(false);
    }
    return { ok: true as const, data: { released: true } };
  }
  observe(waiting: boolean) {
    this.waiting = waiting;
    this.watch(waiting);
    if (!waiting && this.notification) {
      clearImmediate(this.notification);
      this.notification = undefined;
    }
  }
  progress = () => {
    if (!this.waiting || this.notification) return;
    this.notification = setImmediate(() => {
      this.notification = undefined;
      if (this.waiting) this.emit();
    });
  };
  close() {
    if (this.permit) clearTimeout(this.permit.timer);
    this.permit = undefined;
    this.observe(false);
  }
}
