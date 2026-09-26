/**
 * Adapter from `umio graph …` to `WorkflowExecutor` and `FileCheckpointStore`.
 * Everything the runtime decides (uncertain nodes, recovery, cancel) stays
 * the runtime's: this module loads, calls and reports, and never picks a
 * recovery action or retries anything itself.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { UmioConfig } from "../config/schema.js";
import { FileCheckpointStore } from "../graph/checkpoint/file.js";
import { CheckpointStoreLockedError } from "../graph/errors.js";
import { pendingApprovalsOf, WorkflowExecutor } from "../graph/executor.js";
import { waitingNodes } from "../graph/plan.js";
import type {
  ApprovalDecision,
  CancelAck,
  GraphRunEvent,
  JsonValue,
  PendingApproval,
  RecoveryAction,
  WorkflowDefinition,
  WorkflowRun,
} from "../graph/types.js";
import type { ModelClient } from "../llm/types.js";
import type { RecoverChoice } from "./args.js";
import { CliError } from "./explain.js";
import type { CliStore, FileCliStore, RunView } from "./store.js";

/** What a workflow module's default export may be. */
export type WorkflowModuleExport =
  | WorkflowDefinition
  | ((context: {
      llm: ModelClient;
      config: UmioConfig;
    }) => WorkflowDefinition | Promise<WorkflowDefinition>);

export interface GraphEnvironment {
  readonly cwd: string;
  readonly config: UmioConfig;
  /** Directory of the config file; the default store lives under it. */
  readonly configDir: string;
  readonly llm: ModelClient;
  /** Where runs are kept. */
  readonly backend: CliStore;
}

export function storeDir(cwd: string, configDir: string | undefined, explicit?: string): string {
  return explicit ? resolve(cwd, explicit) : join(configDir ?? cwd, ".umio", "runs");
}

/** Imports a workflow module and returns its definition. */
export async function loadWorkflow(
  path: string,
  env: Pick<GraphEnvironment, "cwd" | "config" | "llm">,
): Promise<WorkflowDefinition> {
  const file = resolve(env.cwd, path);
  let module: { default?: WorkflowModuleExport };
  try {
    module = (await import(pathToFileURL(file).href)) as { default?: WorkflowModuleExport };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      code === "ERR_MODULE_NOT_FOUND" && String((error as Error).message).includes(file)
        ? `Workflow module ${file} not found.`
        : `Cannot load workflow module ${file}: ${(error as Error).message.split("\n")[0]}`,
      {
        hint:
          extname(file) === ".ts"
            ? "TypeScript modules need Node ≥ 22.18 (type stripping) and must import @litzrsh/umio as a package, not from source."
            : "The module must be an ES module whose default export is a WorkflowDefinition or a function returning one.",
        cause: error,
      },
    );
  }
  const exported = module.default;
  const definition =
    typeof exported === "function"
      ? await exported({ llm: env.llm, config: env.config })
      : exported;
  if (
    !definition ||
    typeof definition !== "object" ||
    !("graph" in definition) ||
    !("handlers" in definition)
  ) {
    throw new CliError(`${file} does not export a workflow definition.`, {
      hint: "Use `export default { graph, handlers, predicates }` or `export default ({ llm, config }) => ({ … })`.",
    });
  }
  return definition;
}

export interface GraphRunView {
  /** Called once the module is loaded, before the run starts. */
  definition?(definition: WorkflowDefinition): void;
  event(event: GraphRunEvent): void;
}

/** Runs `task` with an executor over the store (the file store is claimed for the duration). */
function withExecutor<T>(
  backend: CliStore,
  config: UmioConfig | undefined,
  task: (executor: WorkflowExecutor) => Promise<T>,
): Promise<T> {
  return backend.withStore((store) =>
    task(config ? WorkflowExecutor.fromConfig(config, { store }) : new WorkflowExecutor({ store })),
  );
}

export function newRunId(graphId: string, now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  return `${graphId}-${stamp}-${randomBytes(2).toString("hex")}`;
}

export async function readInput(
  cwd: string,
  input: string | undefined,
  inputFile: string | undefined,
): Promise<JsonValue> {
  if (input !== undefined) return input;
  if (inputFile === undefined) return null;
  const text = await readFile(resolve(cwd, inputFile), "utf8");
  if (extname(inputFile) !== ".json") return text;
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new CliError(`${inputFile} is not valid JSON.`, { cause: error });
  }
}

export interface StartedRun {
  readonly runId: string;
  readonly result: Promise<WorkflowRun>;
}

/**
 * Starts a run. Aborting `signal` is an explicit, recorded cancel (the
 * executor finalizes the run as `cancelled` after the grace period).
 */
export async function runGraph(
  env: GraphEnvironment,
  command: { module: string; input: JsonValue; runId?: string },
  view: GraphRunView,
  signal: AbortSignal,
  now: number,
): Promise<{ runId: string; run: WorkflowRun }> {
  const definition = await loadWorkflow(command.module, env);
  view.definition?.(definition);
  const runId = command.runId ?? newRunId(definition.graph.id, now);
  const run = await withExecutor(env.backend, env.config, (executor) =>
    executor.run(definition, command.input, {
      runId,
      signal,
      observer: { emit: (event) => view.event(event) },
    }),
  );
  return { runId, run };
}

export async function resumeGraph(
  env: GraphEnvironment,
  command: { module: string; runId: string },
  view: GraphRunView,
  signal: AbortSignal,
): Promise<WorkflowRun> {
  const definition = await loadWorkflow(command.module, env);
  view.definition?.(definition);
  return withExecutor(env.backend, env.config, (executor) =>
    executor.resume(definition, command.runId, {
      signal,
      observer: { emit: (event) => view.event(event) },
    }),
  );
}

/**
 * What `umio graph cancel` achieved. `recorded`, `already-requested` and
 * `requested` only mean the request is stored; `confirmed` says whether the
 * run was then seen to end (with `--wait`), and how.
 */
export interface CancelReport {
  readonly runId: string;
  readonly outcome:
    | "recorded" // a request file for the process holding the store
    | "already-requested"
    | "requested" // recorded in the run; its (crashed) owner's lease has not expired yet
    | "cancelled" // finalized by this command: nobody owned the run
    | "already-terminal"
    | "not-found";
  /** How the request travelled: a control file (store held by another process) or the store itself. */
  readonly via?: "control-file" | "store";
  /** The final status seen while waiting; absent without --wait or on timeout. */
  readonly confirmed?: WorkflowRun["status"];
  readonly waited?: "ended" | "timeout";
  readonly status?: WorkflowRun["status"];
  /** The run was being driven by a live process when the request was made. */
  readonly ownerActive?: boolean;
}

export interface CancelOptions {
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
}

/**
 * Cancels a run from any process.
 *
 * - Postgres: the executor's `cancel()`; the store is shared, so a live owner
 *   anywhere sees the request on its next poll.
 * - File store: if this process can open it (no other umio process holds it),
 *   the executor's `cancel()` does it. If another process holds it, only a
 *   cancel *request* is written beside the run, which that process applies
 *   through its executor's normal path; nothing here ever writes the run or
 *   its lease.
 */
export async function cancelRun(
  backend: CliStore,
  runId: string,
  options: CancelOptions,
): Promise<CancelReport> {
  const snapshot = await backend.snapshot(runId);
  if (!snapshot) return { runId, outcome: "not-found" };
  if (isTerminalStatus(snapshot.record.status)) {
    return { runId, outcome: "already-terminal", status: snapshot.record.status };
  }
  const holder = backend.kind === "file" ? await storeHolder(backend.dir) : undefined;
  const ownerActive = Boolean(
    snapshot.record.status === "running" &&
      leaseActive(snapshot, options.now()) &&
      (backend.kind === "postgres" || holder?.alive),
  );
  const report = await submit(backend, runId, snapshot.instance, ownerActive);
  if (!options.wait || !["recorded", "already-requested", "requested"].includes(report.outcome)) {
    return report;
  }

  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = options.now() + options.timeoutMs;
  while (options.now() < deadline) {
    await sleep(options.pollMs ?? 250);
    const current = await backend.snapshot(runId);
    if (!current || current.instance !== snapshot.instance) return { ...report, waited: "ended" };
    const status = current.record.status;
    if (isTerminalStatus(status) || status === "needs-recovery") {
      return { ...report, waited: "ended", confirmed: status };
    }
    // The owner died before finishing: once its lease has expired, finalize
    // through the executor's own cancel (W7) instead of waiting forever.
    const ownerGone = backend.kind === "postgres" || !(await storeHolder(backend.dir))?.alive;
    if (!leaseActive(current, options.now()) && ownerGone) {
      const direct = await submit(backend, runId, snapshot.instance, false);
      if (direct.outcome === "cancelled") {
        return { ...report, waited: "ended", confirmed: "cancelled", via: report.via ?? "store" };
      }
    }
  }
  return { ...report, waited: "timeout" };
}

/** Whether the run's lease is unexpired (by the database clock, for Postgres). */
export function leaseActive(view: RunView, now: number): boolean {
  if (view.leaseActive !== undefined) return view.leaseActive;
  return Boolean(view.lease && view.lease.expiresAt > now);
}

/**
 * Runs `task` on the writable store. For the file store held by another
 * process, calls `whenLocked` instead (which must not write the run).
 */
async function onStore<T>(
  backend: CliStore,
  task: (executor: WorkflowExecutor) => Promise<T>,
  whenLocked: (backend: FileCliStore) => Promise<T>,
): Promise<T> {
  try {
    return await backend.withStore((store) => task(new WorkflowExecutor({ store })));
  } catch (error) {
    if (backend.kind === "file" && error instanceof CheckpointStoreLockedError) {
      return whenLocked(backend);
    }
    throw error;
  }
}

async function submit(
  backend: CliStore,
  runId: string,
  instance: string | undefined,
  ownerActive: boolean,
): Promise<CancelReport> {
  return onStore<CancelReport>(
    backend,
    async (executor) => {
      const ack: CancelAck = await executor.cancel(runId);
      return {
        runId,
        outcome: ack.outcome,
        via: "store" as const,
        ownerActive: backend.kind === "postgres" && ownerActive,
        ...(ack.status && { status: ack.status }),
      };
    },
    (file) => submitFileCancel(file.dir, runId, instance, ownerActive),
  );
}

async function submitFileCancel(
  dir: string,
  runId: string,
  instance: string | undefined,
  ownerActive: boolean,
): Promise<CancelReport> {
  {
    const receipt = await FileCheckpointStore.submitCancelRequest(dir, runId, {
      ...(instance !== undefined && { instance }),
    });
    switch (receipt.outcome) {
      case "recorded":
      case "already-requested":
        return { runId, outcome: receipt.outcome, via: "control-file", ownerActive };
      case "already-terminal":
        return { runId, outcome: "already-terminal", status: receipt.status };
      default:
        return { runId, outcome: "not-found" };
    }
  }
}

/** What `umio graph approve|reject` achieved. */
export interface DecisionReport {
  readonly runId: string;
  readonly target: string;
  /** `recorded` is not yet applied to the run: its owner or the next resume applies it. */
  readonly outcome:
    | "recorded"
    | "already-decided"
    | "not-pending"
    | "already-terminal"
    | "not-found";
  readonly approved: boolean;
  /** The decision in effect: this one if recorded, else the one that came first. */
  readonly decision?: ApprovalDecision;
  readonly via?: "control-file" | "store";
  readonly status?: WorkflowRun["status"];
  /** A live process is driving the run and applies the decision within ~2 s. */
  readonly ownerActive?: boolean;
  /** Approval nodes still waiting (for a not-pending target). */
  readonly waiting?: readonly string[];
}

/**
 * Records an approval decision from any process. Never applies it to the run
 * record itself: the run's owner does (on its next poll), or the next
 * `resume` of a paused run does, exactly once.
 */
export async function decideApproval(
  backend: CliStore,
  command: { runId: string; target: string; approved: boolean; comment?: string; by?: string },
  now: () => number,
): Promise<DecisionReport> {
  const { runId, target, approved } = command;
  const base = { runId, target, approved };
  const snapshot = await backend.snapshot(runId);
  if (!snapshot) return { ...base, outcome: "not-found" };
  const holder = backend.kind === "file" ? await storeHolder(backend.dir) : undefined;
  const ownerActive = Boolean(
    snapshot.record.status === "running" &&
      leaseActive(snapshot, now()) &&
      (backend.kind === "postgres" || holder?.alive),
  );
  const options = {
    decidedBy: command.by ?? defaultDecider(),
    ...(command.comment !== undefined && { comment: command.comment }),
  };
  const report = await onStore<DecisionReport>(
    backend,
    async (executor) => {
      const ack = approved
        ? await executor.approve(runId, target, options)
        : await executor.reject(runId, target, options);
      return {
        ...base,
        outcome: ack.outcome,
        via: "store" as const,
        ...(ack.decision && { decision: ack.decision }),
        ...(ack.status && { status: ack.status }),
      };
    },
    async (file) => {
      // The holder applies decision files on its poll; nothing here touches the run file.
      const { record } = snapshot;
      if (isTerminalStatus(record.status)) {
        return { ...base, outcome: "already-terminal" as const, status: record.status };
      }
      const node = waitingNodes(record).find(
        (item) => item.nodeId === target || item.approval?.requestId === target,
      );
      if (!node?.approval)
        return { ...base, outcome: "not-pending" as const, status: record.status };
      const decision: ApprovalDecision = {
        requestId: node.approval.requestId,
        nodeId: node.nodeId,
        approved,
        decidedAt: now(),
        decidedBy: options.decidedBy,
        ...(options.comment !== undefined && { comment: options.comment }),
      };
      const receipt = await FileCheckpointStore.submitDecision(file.dir, runId, decision, {
        ...(snapshot.instance !== undefined && { instance: snapshot.instance }),
      });
      if (receipt.outcome === "not-found") return { ...base, outcome: "not-found" as const };
      if (receipt.outcome === "already-terminal") {
        return { ...base, outcome: "already-terminal" as const, status: receipt.status };
      }
      return {
        ...base,
        outcome: receipt.outcome,
        via: "control-file" as const,
        decision: receipt.decision,
        status: record.status,
      };
    },
  );
  return {
    ...report,
    ownerActive,
    ...(report.outcome === "not-pending" && {
      waiting: waitingNodes(snapshot.record).map((node) => node.nodeId),
    }),
  };
}

function defaultDecider(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/** Waiting approvals of one run, or of every run in the store. */
export async function listApprovals(
  backend: CliStore,
  runId: string | undefined,
): Promise<PendingApproval[]> {
  const runs = runId
    ? [await runSnapshot(backend, runId)]
    : await backend.list({ awaitingApproval: true });
  return runs.flatMap((run) => pendingApprovalsOf(run.record, run.decisions));
}

function isTerminalStatus(status: WorkflowRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export async function recoverGraph(
  env: GraphEnvironment,
  command: { module: string; runId: string; nodeId: string; choice: RecoverChoice },
): Promise<WorkflowRun> {
  const action = await recoveryAction(env.cwd, command.choice);
  const definition = await loadWorkflow(command.module, env);
  return withExecutor(env.backend, env.config, (executor) =>
    executor.recoverNode(definition, command.runId, command.nodeId, action),
  );
}

export async function recoveryAction(cwd: string, choice: RecoverChoice): Promise<RecoveryAction> {
  switch (choice.type) {
    case "retry":
      return { type: "retry" };
    case "fail":
      return { type: "fail", ...(choice.reason && { message: choice.reason }) };
    default: {
      const text =
        choice.file !== undefined
          ? await readFile(resolve(cwd, choice.file), "utf8")
          : (choice.json ?? "");
      try {
        return { type: "complete", output: JSON.parse(text) as JsonValue };
      } catch (error) {
        throw new CliError("The --complete output is not valid JSON.", {
          hint: `Quote it for the shell, e.g. --complete '{"text":"…"}' or --complete '"plain string"'.`,
          cause: error,
        });
      }
    }
  }
}

export async function runSnapshot(backend: CliStore, runId: string): Promise<RunView> {
  const snapshot = await backend.snapshot(runId);
  if (!snapshot) {
    throw new CliError(`No run "${runId}" in ${backend.location}.`, {
      hint: "List runs with `umio graph list`; pass --store or --config if they live elsewhere.",
    });
  }
  return snapshot;
}

/** The process holding the store directory, from its `owner.pid` file. */
export interface StoreHolder {
  readonly pid: number;
  readonly alive: boolean;
}

export async function storeHolder(dir: string): Promise<StoreHolder | undefined> {
  const pid = Number.parseInt(await readFile(join(dir, "owner.pid"), "utf8").catch(() => ""), 10);
  if (!Number.isInteger(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch (error) {
    return { pid, alive: (error as NodeJS.ErrnoException).code === "EPERM" };
  }
}

/** Who owns a run right now, from the stored lease, control record and store holder. */
export function ownership(snapshot: RunView, now: number, holder?: StoreHolder): string {
  const { record, lease } = snapshot;
  const pending = cancelState(snapshot);
  const cancel =
    pending === "pending"
      ? `; cancel requested ${Math.max(0, Math.round((now - (snapshot.pendingCancelRequest?.requestedAt ?? now)) / 1_000))}s ago by pid ${snapshot.pendingCancelRequest?.pid}, not yet picked up by the owner`
      : pending === "recorded"
        ? "; cancel requested (recorded in the run, being applied)"
        : "";
  if (record.status === "paused") {
    const count = waitingNodes(record).length;
    return `paused — waiting for ${count} approval${count === 1 ? "" : "s"}; no process owns it${cancel}`;
  }
  if (record.status !== "running") return `not owned${cancel}`;
  if (lease && leaseActive(snapshot, now)) {
    const left = `${Math.ceil((lease.expiresAt - now) / 1_000)}s`;
    if (holder && !holder.alive) {
      return `interrupted — its process (pid ${holder.pid}) is gone; the lease expires in ${left}, then \`umio graph resume\`${cancel}`;
    }
    return `owned by a live executor${holder ? ` (pid ${holder.pid})` : ""}, lease valid for ${left}${cancel}`;
  }
  return `interrupted — no live owner; continue with \`umio graph resume\`${cancel}`;
}

/**
 * `pending`: a request file the holder has not picked up; `recorded`: in the
 * run, the owner (or the next resume) is applying it; `none` otherwise.
 */
export function cancelState(snapshot: RunView): "none" | "pending" | "recorded" {
  if (isTerminalStatus(snapshot.record.status)) return "none";
  if (snapshot.cancelRequested) return "recorded";
  return snapshot.pendingCancelRequest ? "pending" : "none";
}

export function defaultStoreFor(
  configPath: string | undefined,
  cwd: string,
  explicit?: string,
): string {
  return storeDir(cwd, configPath ? dirname(configPath) : undefined, explicit);
}
