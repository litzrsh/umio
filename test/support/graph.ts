/**
 * Helpers shared by the graph executor suites: a store view that can "crash",
 * controllable handlers and an event recorder.
 */
import type {
  CasResult,
  CheckpointStore,
  EdgeSpec,
  GraphRunEvent,
  JsonValue,
  Lease,
  NodeContext,
  NodeHandler,
  NodeSpec,
  RunObserver,
  WorkflowDefinition,
  WorkflowRun,
} from "../../src/index.js";
import type { FakeClock } from "./fake-clock.js";

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

const never = <T>() => new Promise<T>(() => {});

/**
 * One simulated process's view of a shared store. After `crash()` every call
 * it makes hangs forever: its timers stop re-arming and it writes nothing
 * more, as if the process had died. Records writes, leases and renewals.
 */
export class ProcessStore implements CheckpointStore {
  crashed = false;
  /** Crash right after a successful write that matches. */
  crashAfterWrite?: (run: WorkflowRun) => boolean;
  readonly writes: WorkflowRun[] = [];
  readonly leases: Lease[] = [];
  renewals = 0;

  constructor(readonly inner: CheckpointStore) {}

  crash() {
    this.crashed = true;
  }

  private call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.crashed) return never();
    return operation().then((value) => (this.crashed ? never<T>() : value));
  }

  create(run: WorkflowRun, ownerId: string, ttlMs: number) {
    return this.call(async () => {
      const lease = await this.inner.create(run, ownerId, ttlMs);
      this.writes.push(run);
      this.leases.push(lease);
      return lease;
    });
  }
  load(runId: string) {
    return this.call(() => this.inner.load(runId));
  }
  compareAndSwap(run: WorkflowRun, expected: number, lease: Lease) {
    return this.call(async (): Promise<CasResult> => {
      const result = await this.inner.compareAndSwap(run, expected, lease);
      if (result === "ok") {
        this.writes.push(run);
        if (this.crashAfterWrite?.(run)) this.crash();
      }
      return result;
    });
  }
  acquireLease(runId: string, ownerId: string, ttlMs: number) {
    return this.call(async () => {
      const lease = await this.inner.acquireLease(runId, ownerId, ttlMs);
      if (lease) this.leases.push(lease);
      return lease;
    });
  }
  renewLease(lease: Lease, ttlMs: number) {
    this.renewals += 1;
    return this.call(() => this.inner.renewLease(lease, ttlMs));
  }
  releaseLease(lease: Lease) {
    return this.call(() => this.inner.releaseLease(lease));
  }
  requestCancel(runId: string) {
    return this.call(() => this.inner.requestCancel(runId));
  }
  isCancelRequested(runId: string) {
    return this.call(() => this.inner.isCancelRequested(runId));
  }
  delete(runId: string) {
    return this.call(() => this.inner.delete(runId));
  }

  /** Writes that left the run in a status other than `running`. */
  terminalWrites(): WorkflowRun[] {
    return this.writes.filter((write) => write.status !== "running");
  }
}

export function graph(
  nodes: NodeSpec[],
  edges: EdgeSpec[],
  handlers: Record<string, NodeHandler>,
  predicates: WorkflowDefinition["predicates"] = {},
): WorkflowDefinition {
  const targets = new Set(edges.map((edge) => edge.to));
  return {
    graph: {
      id: "wf",
      version: "1",
      entry: nodes.filter((node) => !targets.has(node.id)).map((node) => node.id),
      nodes,
      edges,
    },
    handlers,
    predicates,
  };
}

/** Nodes whose handler key equals their ID. */
export const nodes = (...ids: (string | NodeSpec)[]): NodeSpec[] =>
  ids.map((item) => (typeof item === "string" ? { id: item, handler: item } : item));

/**
 * A handler that settles only when told to. A cooperative one rejects with
 * the signal's reason when its attempt is aborted; an uncooperative one
 * ignores the signal. Records every context it was invoked with.
 */
export function controlled(options: { cooperative?: boolean } = {}) {
  const cooperative = options.cooperative ?? true;
  const contexts: NodeContext[] = [];
  const pending: { resolve(value: JsonValue): void; reject(error: unknown): void }[] = [];
  const abortedAt: number[] = [];
  const handler: NodeHandler = (context) =>
    new Promise((resolve, reject) => {
      contexts.push(context);
      pending.push({ resolve, reject });
      context.signal.addEventListener(
        "abort",
        () => {
          abortedAt.push(contexts.length);
          if (cooperative) reject(context.signal.reason);
        },
        { once: true },
      );
    });
  return {
    handler,
    contexts,
    calls: () => contexts.length,
    /** Settles the latest invocation. */
    finish: (value: JsonValue = "done") => pending.at(-1)?.resolve(value),
    fail: (error: unknown) => pending.at(-1)?.reject(error),
    aborted: () => contexts.at(-1)?.signal.aborted ?? false,
  };
}

/** A handler that completes when the fake clock reaches `start + durationMs`. */
export function sleeper(
  clock: FakeClock,
  durationMs: number,
  options: { cooperative?: boolean; output?: JsonValue } = {},
) {
  const contexts: NodeContext[] = [];
  const abortTimes: number[] = [];
  const handler: NodeHandler = (context) =>
    new Promise((resolve, reject) => {
      contexts.push(context);
      const cancel = clock.setTimer(durationMs, () => resolve(options.output ?? "done"));
      context.signal.addEventListener(
        "abort",
        () => {
          abortTimes.push(clock.now());
          if (options.cooperative ?? true) {
            cancel();
            reject(context.signal.reason);
          }
        },
        { once: true },
      );
    });
  return { handler, contexts, abortTimes };
}

/** Collects run events; `summary()` gives compact "type:node" strings. */
export function recorder(): {
  observer: RunObserver;
  events: GraphRunEvent[];
  summary(): string[];
} {
  const events: GraphRunEvent[] = [];
  return {
    observer: { emit: (event) => void events.push(event) },
    events,
    summary: () =>
      events.map((event) => {
        switch (event.type) {
          case "node-start":
          case "node-event":
            return `${event.type}:${event.nodeId}#${event.attempt}`;
          case "node-retry":
            return `node-retry:${event.nodeId}#${event.attempt}`;
          case "node-finish":
            return `node-finish:${event.nodeId}:${event.status}`;
          case "run-finish":
            return `run-finish:${event.status}`;
          case "run-needs-recovery":
            return `run-needs-recovery:${event.nodes.join(",")}`;
          default:
            return event.type;
        }
      }),
  };
}

/** Tracks whether a promise has settled, for checking that something is still pending. */
export function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}
