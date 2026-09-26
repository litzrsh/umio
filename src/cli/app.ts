/**
 * Dispatch: parsed command → adapter → terminal. Owns exit codes and signal
 * handling for non-interactive commands. `runCli` takes all I/O as arguments,
 * so tests drive it with fake streams.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_FILE } from "../config/load.js";
import type { UmioConfig } from "../config/schema.js";
import type { WorkflowRun } from "../graph/types.js";
import { LLM } from "../llm/client.js";
import type { ModelClient } from "../llm/types.js";
import { sanitizeConnectionString, sanitizeUrl } from "../secrets.js";
import { skillsFromConfig } from "../skills/config.js";
import type { Tool } from "../tools/tool.js";
import { Activity } from "./activity.js";
import { type Command, type GlobalOptions, parseCommandLine } from "./args.js";
import { type Approval, runChatTurn } from "./chat.js";
import {
  describeModel,
  findConfig,
  type LocatedConfig,
  loadCliConfig,
  maskedConfig,
  requireModel,
  selectToolsets,
  summarizeModels,
  writeStarterConfig,
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { formatDuration } from "./duration.js";
import { CliError, debugDetails, explain } from "./explain.js";
import { oneLine, runStatusLabel, turnFooter } from "./format.js";
import {
  type CancelReport,
  cancelRun,
  type DecisionReport,
  decideApproval,
  listApprovals,
  readInput,
  recoverGraph,
  resumeGraph,
  runGraph,
  runSnapshot,
  storeHolder,
} from "./graph.js";
import { helpFor } from "./help.js";
import { ChatSession } from "./session.js";
import { cliSkills } from "./skills.js";
import { type CliStore, openCliStore, type PgModule } from "./store.js";
import { createStyle, detectColor } from "./style.js";
import { type OutputStream, Terminal, type Timers } from "./terminal.js";
import {
  approvalLines,
  resultOutputs,
  runJson,
  runReport,
  snapshotReport,
  TerminalChatView,
  TerminalGraphView,
} from "./views.js";

export interface InputStream extends NodeJS.EventEmitter {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
  resume?(): unknown;
  pause?(): unknown;
}

export interface CliIO {
  readonly stdin: InputStream;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** Subscribes to a process signal; returns the unsubscribe function. */
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
  /** Leaves immediately (second Ctrl+C). */
  exit(code: number): void;
}

export interface CliDeps {
  readonly fetch?: typeof fetch;
  /** Builds the model client; default `new LLM(config)`. Tests pass a scripted one. */
  readonly createModel?: (config: UmioConfig) => ModelClient;
  readonly timers?: Timers;
  readonly version?: string;
  /** Loads the `pg` module for a PostgreSQL store; tests pass their own. */
  readonly loadPg?: () => Promise<PgModule>;
}

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  needsRecovery: 3,
  paused: 4,
  cancelled: 130,
} as const;

export interface Context {
  readonly io: CliIO;
  readonly options: GlobalOptions;
  readonly terminal: Terminal;
  readonly deps: CliDeps;
}

export async function runCli(
  argv: readonly string[],
  io: CliIO,
  deps: CliDeps = {},
): Promise<number> {
  const parsed = parseCommandLine(argv);
  const color = detectColor(
    Boolean(io.stderr.isTTY),
    io.env,
    parsed.ok ? parsed.options.color : undefined,
  );
  const style = createStyle(color, io.env);
  if (!parsed.ok) {
    io.stderr.write(`${style.red("error:")} ${parsed.error}\n`);
    io.stderr.write(`${style.dim(`hint: umio help${parsed.topic ? ` ${parsed.topic}` : ""}`)}\n`);
    return EXIT.usage;
  }
  const { command, options } = parsed;
  const terminal = new Terminal(io.stdout, io.stderr, {
    style,
    quiet: options.quiet,
    heartbeatMs: options.heartbeatMs,
    env: io.env,
    ...(deps.timers && { timers: deps.timers }),
  });
  const context: Context = { io, options, terminal, deps };
  try {
    return await dispatch(command, context);
  } catch (error) {
    reportError(error, context);
    return error instanceof CliError ? error.exitCode : EXIT.error;
  } finally {
    terminal.stopActivity();
  }
}

export function reportError(error: unknown, { terminal, options, io }: Context): void {
  const { style } = terminal;
  const { message, hint } = explain(error);
  terminal.forceNote(`${style.red("error:")} ${message}`);
  if (hint) terminal.forceNote(style.dim(`hint: ${hint}`));
  if (options.debug || io.env.UMIO_DEBUG) terminal.forceNote(style.dim(debugDetails(error)));
}

async function dispatch(command: Command, context: Context): Promise<number> {
  const { io, options, terminal } = context;
  switch (command.kind) {
    case "help":
      io.stdout.write(helpFor(command.topic));
      return EXIT.ok;
    case "version":
      io.stdout.write(`umio ${context.deps.version ?? readVersion()}\n`);
      return EXIT.ok;
    case "init": {
      const path = resolve(io.cwd, options.config ?? DEFAULT_CONFIG_FILE);
      await writeStarterConfig(path, command.localModel, command.force);
      terminal.line(`${terminal.style.green(terminal.style.symbols.ok)} Wrote ${path}`);
      terminal.line(
        `  Model "local" → ${command.localModel} on Ollama (http://localhost:11434/v1).`,
      );
      terminal.line(`  Next: ollama pull ${command.localModel} && umio doctor`);
      return EXIT.ok;
    }
    case "doctor":
      return doctor(command.nodeTimeoutMs, context);
    case "config":
      return showConfig(context);
    case "models": {
      const { config } = await loadCliConfig(io.cwd, io.env, options.config);
      const models = summarizeModels(config, io.env);
      if (options.json) return json(context, models);
      for (const model of models) {
        terminal.line(`${model.isDefault ? "*" : " "} ${describeModel(model)}`);
      }
      return EXIT.ok;
    }
    case "tools": {
      const { config } = await loadCliConfig(io.cwd, io.env, options.config);
      const toolsets = selectToolsets(config, options.tools);
      if (options.json) {
        return json(
          context,
          Object.fromEntries(
            Object.entries(toolsets).map(([name, set]) => [
              name,
              [...set].map((tool) => ({
                name: tool.name,
                readOnly: tool.annotations?.readOnly ?? false,
              })),
            ]),
          ),
        );
      }
      for (const line of toolLines(toolsets, context)) terminal.line(line);
      return EXIT.ok;
    }
    case "skills-list":
    case "skills-show":
      return skillsCommand(command, context);
    case "ask":
      return ask(command.prompt, context);
    case "chat": {
      if (!io.stdin.isTTY || !io.stdout.isTTY) {
        throw new CliError("Interactive chat needs a terminal.", {
          hint: 'For scripts and pipes use: umio ask "<prompt>" (or pipe the prompt into `umio ask`).',
          exitCode: EXIT.usage,
        });
      }
      const { startRepl } = await import("./repl.js");
      return startRepl(context);
    }
    default:
      return runGraphCommand(command, context, undefined);
  }
}

/** `umio graph …`, also used by the REPL's /graph (which passes its own signal). */
export async function runGraphCommand(
  command: Command,
  context: Context,
  replSignal: AbortSignal | undefined,
): Promise<number> {
  const { io, options, terminal } = context;
  const now = () => terminal.timers.now();

  // Commands that only touch the store: the config is read for its location, if there is one.
  if (
    command.kind === "graph-status" ||
    command.kind === "graph-list" ||
    command.kind === "graph-cancel" ||
    command.kind === "graph-approvals" ||
    command.kind === "graph-decide" ||
    command.kind === "graph-migrate"
  ) {
    const configPath = await findConfig(io.cwd, io.env, options.config).catch(() => undefined);
    const located = configPath ? await loadCliConfig(io.cwd, io.env, configPath) : undefined;
    const backend = await openBackend(context, located);
    try {
      return await storeCommand(command, context, backend, now);
    } finally {
      await backend.close();
    }
  }

  const located = await loadCliConfig(io.cwd, io.env, options.config);
  const llm = modelClient(context, located.config);
  const backend = await openBackend(context, located);
  const env = {
    cwd: io.cwd,
    config: located.config,
    configDir: dirname(located.path),
    llm,
    backend,
  };
  try {
    return await workflowCommand(command, context, env, replSignal);
  } finally {
    await backend.close();
  }
}

function openBackend(context: Context, located: LocatedConfig | undefined): Promise<CliStore> {
  const { io, options, deps } = context;
  return openCliStore({
    cwd: io.cwd,
    ...(located && { configDir: dirname(located.path) }),
    ...(options.store !== undefined && { explicit: options.store }),
    ...(located?.config.graph?.checkpoint && { checkpoint: located.config.graph.checkpoint }),
    ...(deps.loadPg && { loadPg: deps.loadPg }),
  });
}

/** status, list, cancel, approvals, approve/reject, migrate. */
async function storeCommand(
  command: Command,
  context: Context,
  backend: CliStore,
  now: () => number,
): Promise<number> {
  const { options, terminal } = context;
  const holderOf = async () =>
    backend.kind === "file" ? await storeHolder(backend.dir) : undefined;
  switch (command.kind) {
    case "graph-status": {
      const snapshot = await runSnapshot(backend, command.runId);
      const holder = await holderOf();
      if (options.json) return json(context, runJson(snapshot, now(), holder));
      for (const line of snapshotReport(snapshot, terminal, now(), holder)) terminal.line(line);
      return statusCode(snapshot.record.status);
    }
    case "graph-list": {
      const runs = await backend.list(command.needsRecovery ? { status: "needs-recovery" } : {});
      if (options.json)
        return json(
          context,
          runs.map((run) => runJson(run, now())),
        );
      if (runs.length === 0) terminal.note(`No runs in ${backend.location}.`);
      for (const { record } of runs) {
        const nodes = Object.values(record.nodes);
        const uncertain = nodes.filter((node) => node.status === "uncertain").length;
        const waiting = nodes.filter((node) => node.status === "waiting").length;
        terminal.line(
          `${record.runId}  ${runStatusLabel(record.status, terminal.style)}  ${terminal.style.dim(`${record.workflowId} · updated ${new Date(record.updatedAt).toLocaleString()}${uncertain ? ` · ${uncertain} uncertain` : ""}${waiting ? ` · ${waiting} awaiting approval` : ""}`)}`,
        );
      }
      return EXIT.ok;
    }
    case "graph-approvals": {
      const approvals = await listApprovals(backend, command.runId);
      if (options.json) return json(context, approvals);
      if (approvals.length === 0) {
        terminal.note(
          command.runId
            ? `Run ${command.runId} has no approval waiting.`
            : `No approvals waiting in ${backend.location}.`,
        );
      }
      for (const line of approvalLines(approvals, terminal, options.verbose)) terminal.line(line);
      return EXIT.ok;
    }
    case "graph-decide": {
      const report = await decideApproval(backend, command, now);
      if (options.json) json(context, report);
      else for (const line of decisionReportLines(report, terminal)) terminal.line(line);
      return decisionExitCode(report);
    }
    case "graph-migrate": {
      if (backend.kind === "file") {
        terminal.line(`The file store needs no setup (${backend.location}).`);
        return EXIT.ok;
      }
      await backend.migrate();
      if (options.json) return json(context, { migrated: true, store: backend.location });
      terminal.line(`Checkpoint tables are ready in ${backend.location}.`);
      return EXIT.ok;
    }
    case "graph-cancel": {
      if (command.wait && !options.json) {
        terminal.note(
          terminal.style.dim(
            `Waiting up to ${formatDuration(command.timeoutMs)} for the run to stop…`,
          ),
        );
      }
      const report = await cancelRun(backend, command.runId, {
        wait: command.wait,
        timeoutMs: command.timeoutMs,
        now,
      });
      if (options.json) {
        json(context, report);
      } else {
        for (const line of cancelReportLines(report, terminal)) terminal.line(line);
      }
      return cancelExitCode(report);
    }
    default:
      throw new CliError(`Unsupported command ${command.kind}.`);
  }
}

/** run, resume, recover: they load the workflow module. */
async function workflowCommand(
  command: Command,
  context: Context,
  env: Parameters<typeof runGraph>[0],
  replSignal: AbortSignal | undefined,
): Promise<number> {
  const { io, options, terminal } = context;
  const now = () => terminal.timers.now();

  if (command.kind === "graph-recover") {
    const run = await recoverGraph(env, command);
    if (options.json) return json(context, runJson({ record: run }, now()));
    terminal.line(`Recorded ${command.choice.type} for ${command.nodeId}.`);
    for (const line of runReport(run, terminal, now(), { module: command.module }))
      terminal.line(line);
    if (run.status === "running") {
      terminal.line(
        terminal.style.dim(`Continue with: umio graph resume ${command.module} ${command.runId}`),
      );
    }
    return statusCode(run.status);
  }

  if (command.kind !== "graph-run" && command.kind !== "graph-resume") {
    throw new CliError(`Unsupported command ${command.kind}.`);
  }
  // run / resume: long-running, cancellable.
  const controller = new AbortController();
  replSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  const activity = new Activity(now(), { kind: "graph", running: [], done: 0, total: 0 });
  const view = new TerminalGraphView(terminal, activity);
  let graph: { edges: readonly { from: string }[]; nodes: readonly { id: string }[] } | undefined;
  const recordDefinition = view.definition.bind(view);
  view.definition = (definition) => {
    graph = definition.graph;
    recordDefinition(definition);
  };
  const stopSignals = replSignal
    ? () => {}
    : cancelOnSignals(context, controller, "graph", () => view.runId);
  terminal.startActivity(activity);
  let run: WorkflowRun;
  try {
    if (command.kind === "graph-run") {
      const input = await readInput(io.cwd, command.input, command.inputFile);
      const started = await runGraph(
        env,
        { module: command.module, input, ...(command.runId && { runId: command.runId }) },
        view,
        controller.signal,
        now(),
      );
      run = started.run;
    } else {
      run = await resumeGraph(env, command, view, controller.signal);
    }
  } finally {
    terminal.stopActivity();
    stopSignals();
  }
  const results = resultOutputs(run, graph);
  if (options.json) return json(context, { ...runJson({ record: run }, now()), results });
  terminal.line();
  for (const line of runReport(run, terminal, now(), { module: command.module }))
    terminal.line(line);
  for (const result of results) {
    terminal.line();
    terminal.line(terminal.style.bold(`${result.nodeId}:`));
    terminal.line(result.text);
  }
  return statusCode(run.status);
}

/**
 * The model client for a command. `--model` becomes the default model, so
 * workflow agents that name no model use it too.
 */
export function modelClient(context: Context, config: UmioConfig): ModelClient {
  const alias = context.options.model;
  const effective = alias ? { ...config, defaultModel: requireModel(config, alias) } : config;
  return (context.deps.createModel ?? ((value) => new LLM(value)))(effective);
}

/** Words for a cancel report: always says whether the cancel is only recorded or confirmed. */
export function cancelReportLines(report: CancelReport, terminal: Terminal): string[] {
  const { style } = terminal;
  const id = report.runId;
  const lines: string[] = [];
  switch (report.outcome) {
    case "not-found":
      return [`No run "${id}".`];
    case "already-terminal":
      return [`Nothing to cancel: run ${id} is already ${report.status}.`];
    case "cancelled":
      return [
        style.green(`Confirmed: run ${id} is cancelled.`) +
          style.dim(" It had no live owner; nodes left running are now uncertain."),
      ];
    case "recorded":
    case "already-requested":
      lines.push(
        `${report.outcome === "recorded" ? "Cancel request recorded" : "A cancel request was already recorded"} for run ${id} — ${style.bold("not yet confirmed")}.`,
        style.dim(
          report.ownerActive
            ? "  The umio process driving it checks every ~2 s, then stops it through the normal cancel path (up to 10 s more for handlers that ignore aborts)."
            : "  No process is driving this run right now; the request is applied when it is next resumed, recovered or cancelled with the store free.",
        ),
      );
      break;
    case "requested":
      lines.push(
        `Cancel recorded in run ${id} — ${style.bold("not yet confirmed")}.`,
        style.dim(
          "  Its previous owner's lease has not expired; `umio graph resume` (or cancel again) finalizes it after that.",
        ),
      );
      break;
  }
  if (report.waited === "ended") {
    lines.push(
      report.confirmed === "cancelled"
        ? style.green(`Confirmed: run ${id} is cancelled.`)
        : style.yellow(
            `Run ${id} ended ${report.confirmed ?? "(removed)"} before the cancel took effect.${report.confirmed === "needs-recovery" ? " The request stays recorded; `umio graph cancel` again once the store is free finalizes it." : ""}`,
          ),
    );
  } else if (report.waited === "timeout") {
    lines.push(
      style.yellow(
        `Not confirmed yet: run ${id} is still running. The request stays recorded; check with \`umio graph status ${id}\`.`,
      ),
    );
  } else {
    lines.push(style.dim(`  Confirm with \`umio graph status ${id}\`, or use --wait next time.`));
  }
  return lines;
}

/** Words for an approval decision: always says whether it is only recorded or already applied. */
export function decisionReportLines(report: DecisionReport, terminal: Terminal): string[] {
  const { style } = terminal;
  const { runId, target } = report;
  const verb = report.approved ? "Approval" : "Rejection";
  const who = (decision: DecisionReport["decision"]) =>
    decision
      ? `${decision.approved ? "approved" : "rejected"}${decision.decidedBy ? ` by ${decision.decidedBy}` : ""} at ${new Date(decision.decidedAt).toLocaleString()}`
      : "decided";
  switch (report.outcome) {
    case "not-found":
      return [`No run "${runId}".`];
    case "already-terminal":
      return [`Nothing to decide: run ${runId} is already ${report.status}.`];
    case "not-pending":
      return [
        `Run ${runId} has no approval "${target}" waiting.`,
        style.dim(
          report.waiting?.length
            ? `  Waiting: ${report.waiting.join(", ")} (see \`umio graph approvals ${runId}\`).`
            : "  It has no approval waiting.",
        ),
      ];
    case "already-decided":
      return [
        (report.decision?.approved === report.approved ? style.dim : style.yellow)(
          `Already decided: ${target} was ${who(report.decision)}. Your decision was not recorded.`,
        ),
      ];
    case "recorded":
      return [
        `${verb} recorded for run ${runId}, ${target} — ${style.bold("not yet applied")}.`,
        style.dim(
          report.status === "paused"
            ? `  The run is paused. Continue it with: umio graph resume <module> ${runId}`
            : report.ownerActive
              ? "  The umio process driving the run applies it within ~2 s."
              : `  No process is driving the run now; it is applied when the run is resumed (umio graph resume <module> ${runId}).`,
        ),
      ];
  }
}

/** 0 when recorded, or when the same decision was already recorded; 1 otherwise. */
function decisionExitCode(report: DecisionReport): number {
  if (report.outcome === "recorded") return EXIT.ok;
  if (report.outcome === "already-decided" && report.decision?.approved === report.approved) {
    return EXIT.ok;
  }
  return EXIT.error;
}

/** 0 when recorded (without --wait) or confirmed; 1 when not found, timed out, or the run ended otherwise. */
function cancelExitCode(report: CancelReport): number {
  if (report.outcome === "not-found") return EXIT.error;
  if (report.waited === "timeout") return EXIT.error;
  if (report.waited === "ended" && report.confirmed !== "cancelled") return EXIT.error;
  return EXIT.ok;
}

function statusCode(status: WorkflowRun["status"]): number {
  switch (status) {
    case "completed":
    case "running":
      return EXIT.ok;
    case "needs-recovery":
      return EXIT.needsRecovery;
    case "paused":
      return EXIT.paused;
    case "cancelled":
      return EXIT.cancelled;
    default:
      return EXIT.error;
  }
}

/**
 * First Ctrl+C: an explicit cancel (abort the operation's signal). Second
 * Ctrl+C or SIGTERM: leave at once, without finalizing anything, so the
 * state stays inspectable and recoverable.
 */
function cancelOnSignals(
  context: Context,
  controller: AbortController,
  what: "graph" | "ask",
  runId: () => string | undefined,
): () => void {
  const { io, terminal } = context;
  const { style } = terminal;
  const leave = () => {
    terminal.stopActivity();
    const id = runId();
    terminal.forceNote(
      style.yellow(
        what === "graph"
          ? `Exited without finalizing${id ? ` run ${id}` : ""}. Inspect it with \`umio graph status ${id ?? "<run-id>"}\`; \`umio graph resume\` marks its running nodes uncertain instead of re-running them.`
          : "Exited.",
      ),
    );
    io.exit(EXIT.cancelled);
  };
  const stopInt = io.onSignal("SIGINT", () => {
    if (controller.signal.aborted) return leave();
    controller.abort();
    terminal.forceNote(
      style.yellow(
        what === "graph"
          ? "Cancelling the run (running nodes get a grace period)… Press Ctrl+C again to exit without waiting."
          : "Cancelling… Press Ctrl+C again to exit immediately.",
      ),
    );
  });
  const stopTerm = io.onSignal("SIGTERM", leave);
  return () => {
    stopInt();
    stopTerm();
  };
}

/** `umio skills list|show`: what the config permits, validated. */
async function skillsCommand(
  command: Extract<Command, { kind: "skills-list" | "skills-show" }>,
  context: Context,
): Promise<number> {
  const { io, options, terminal } = context;
  const { style } = terminal;
  const { config } = await loadCliConfig(io.cwd, io.env, options.config);
  const section = config.skills;
  if (!section) {
    if (options.json) return json(context, { configured: false, skills: [] });
    terminal.line("No skills configured.");
    terminal.line(
      style.dim('  Add "skills": { "roots": ["./skills"], "include": ["<name>"] } to the config.'),
    );
    return command.kind === "skills-list" ? EXIT.ok : EXIT.error;
  }
  const binding = await skillsFromConfig(config);
  if (!binding) return EXIT.error;
  const { catalog } = binding;
  const activate = new Set(section.activate ?? []);
  const permitted = catalog.list().filter((skill) => section.include.includes(skill.name));

  if (command.kind === "skills-show") {
    if (!section.include.includes(command.name)) {
      throw new CliError(`Skill "${command.name}" is not permitted by skills.include.`, {
        hint: `Permitted: ${section.include.join(", ") || "(none)"}.`,
      });
    }
    const skill = await catalog.load(command.name);
    if (options.json) return json(context, { ...skill, active: activate.has(skill.name) });
    terminal.line(`${style.bold(skill.name)} ${style.dim(`sha256:${skill.digest}`)}`);
    terminal.line(skill.description);
    terminal.line();
    terminal.line(skill.body);
    return EXIT.ok;
  }

  const missing = section.include.filter(
    (name) => !catalog.list().some((skill) => skill.name === name),
  );
  if (options.json) {
    json(context, {
      configured: true,
      roots: section.roots,
      include: section.include,
      activate: section.activate ?? [],
      allowModelSelection: section.allowModelSelection ?? false,
      skills: permitted.map((skill) => ({ ...skill, active: activate.has(skill.name) })),
      missing,
      diagnostics: catalog.diagnostics,
    });
  } else {
    terminal.line(
      `${style.bold("Skills")} ${style.dim(`· model selection ${section.allowModelSelection ? "on" : "off"} · ${permitted.length} permitted of ${catalog.list().length} found`)}`,
    );
    const width = Math.max(4, ...permitted.map((skill) => skill.name.length));
    for (const skill of permitted) {
      const mark = activate.has(skill.name) ? style.green("active") : style.dim("      ");
      terminal.line(
        `  ${skill.name.padEnd(width)}  ${mark}  ${oneLine(skill.description)} ${style.dim(`sha256:${skill.digest.slice(0, 12)}`)}`,
      );
    }
    for (const name of missing) {
      terminal.line(style.red(`  ${name.padEnd(width)}  not found in ${section.roots.join(", ")}`));
    }
    for (const item of catalog.diagnostics) {
      terminal.line(
        style.red(
          `${style.symbols.error} ${item.path}${item.field ? ` (${item.field})` : ""}: ${item.message}`,
        ),
      );
    }
  }
  return catalog.diagnostics.length > 0 || missing.length > 0 ? EXIT.error : EXIT.ok;
}

async function ask(prompt: string | undefined, context: Context): Promise<number> {
  const { io, options, terminal } = context;
  let text = prompt;
  if (text === undefined) {
    if (io.stdin.isTTY) {
      throw new CliError("No prompt given.", {
        hint: 'umio ask "your question", or pipe it: echo "…" | umio ask',
        exitCode: EXIT.usage,
      });
    }
    text = await readAll(io.stdin);
  }
  if (!text.trim()) throw new CliError("The prompt is empty.", { exitCode: EXIT.usage });

  const located = await loadCliConfig(io.cwd, io.env, options.config);
  const model = requireModel(located.config, options.model);
  const tools = Object.values(selectToolsets(located.config, options.tools)).flatMap((set) => [
    ...set,
  ]);
  const llm = modelClient(context, located.config);
  const skills = await cliSkills(located.config, options);
  const now = () => terminal.timers.now();
  const session = new ChatSession(model, now(), "ask");
  const activity = new Activity(now());
  const controller = new AbortController();
  const stopSignals = cancelOnSignals(context, controller, "ask", () => undefined);
  const records: { name: string; input: unknown; isError: boolean; durationMs: number }[] = [];
  const started = now();
  terminal.startActivity(activity);
  let outcome: Awaited<ReturnType<typeof runChatTurn>>;
  try {
    const view = new TerminalChatView(terminal, activity, {
      verbose: options.verbose,
      showTools: true,
    });
    outcome = await runChatTurn(session, text, {
      llm,
      tools,
      ...(skills && { skills }),
      signal: controller.signal,
      autoApprove: options.yes,
      view: {
        waiting: () => view.waiting(),
        text: (delta) => {
          if (!options.json) view.text(delta);
        },
        modelFinished: (result) => {
          if (!options.json) view.modelFinished(result);
        },
        toolStarted: (call) => view.toolStarted(call),
        toolFinished: (execution) => {
          records.push({
            name: execution.call.name,
            input: execution.call.input,
            isError: execution.result.isError ?? false,
            durationMs: execution.durationMs,
          });
          view.toolFinished(execution);
        },
      },
    });
  } finally {
    terminal.stopActivity();
    stopSignals();
  }
  terminal.endText();
  if (outcome.status !== "completed") {
    reportInterruption(outcome, context);
    if (options.json) {
      json(context, {
        status: outcome.status,
        error: explain(outcome.error).message,
        tools: records,
      });
    }
    return outcome.status === "cancelled" ? EXIT.cancelled : EXIT.error;
  }
  const { result } = outcome;
  if (options.json) {
    return json(context, {
      text: result.text,
      stopReason: result.stopReason,
      model,
      usage: result.usage,
      tools: records,
    });
  }
  if (result.stopReason === "max-steps") {
    terminal.note(
      terminal.style.yellow(
        "! Stopped at the step limit (maxSteps) while the model still wanted tools.",
      ),
    );
  }
  terminal.note(turnFooter(now() - started, result.usage, terminal.style));
  return EXIT.ok;
}

export function reportInterruption(
  outcome: {
    status: "cancelled" | "failed";
    error: unknown;
    interruption: { affected: { call: { name: string }; status: string }[] };
  },
  context: Context,
): void {
  const { terminal } = context;
  const { style } = terminal;
  if (outcome.status === "failed") reportError(outcome.error, context);
  else terminal.forceNote(style.yellow(`${style.symbols.cancelled} Cancelled.`));
  const affected = outcome.interruption.affected;
  if (affected.length > 0) {
    terminal.forceNote(
      style.yellow(
        `${style.symbols.warn} Tools that already ran and may have had effects: ${affected
          .map((tool) => `${tool.call.name}${tool.status === "running" ? " (interrupted)" : ""}`)
          .join(", ")}. They will not be re-run automatically.`,
      ),
    );
  }
}

async function doctor(nodeTimeoutMs: number | null, context: Context): Promise<number> {
  const { io, options, terminal } = context;
  const checks = await runDoctor({
    cwd: io.cwd,
    env: io.env,
    ...(options.config && { config: options.config }),
    ...(options.model && { model: options.model }),
    nodeTimeoutMs,
    ...(context.deps.fetch && { fetch: context.deps.fetch }),
  });
  const failed = checks.some((check) => check.status === "error");
  if (options.json) {
    json(context, { ok: !failed, checks });
    return failed ? EXIT.error : EXIT.ok;
  }
  const { style } = terminal;
  for (const check of checks) {
    const mark =
      check.status === "ok"
        ? style.green(`${style.symbols.ok} ok   `)
        : check.status === "warn"
          ? style.yellow(`${style.symbols.warn} warn `)
          : style.red(`${style.symbols.error} error`);
    terminal.line(`${mark} ${check.title}`);
    if (check.hint) terminal.line(style.dim(`        ${check.hint}`));
  }
  return failed ? EXIT.error : EXIT.ok;
}

async function showConfig(context: Context): Promise<number> {
  const { io, options, terminal } = context;
  const located: LocatedConfig = await loadCliConfig(io.cwd, io.env, options.config);
  const { config, path } = located;
  if (options.json) return json(context, { path, config: maskedConfig(config) });
  for (const line of configLines(located, context)) terminal.line(line);
  return EXIT.ok;
}

export function configLines({ config, path }: LocatedConfig, context: Context): string[] {
  const { style } = context.terminal;
  const lines = [
    `${style.bold("Config")} ${path}`,
    `  default model: ${config.defaultModel ?? "(none)"}`,
  ];
  lines.push(`  ${style.bold("Models")}`);
  for (const model of summarizeModels(config, context.io.env))
    lines.push(`    ${describeModel(model)}`);
  lines.push(`  ${style.bold("Providers")}`);
  for (const [name, provider] of Object.entries(config.providers)) {
    lines.push(
      `    ${name}: ${provider.type}${"baseURL" in provider && provider.baseURL ? ` · ${sanitizeUrl(provider.baseURL) ?? provider.baseURL}` : ""}`,
    );
  }
  lines.push(`  ${style.bold("Tools")} ${Object.keys(config.tools ?? {}).join(", ") || "(none)"}`);
  const graph = config.graph ?? {};
  lines.push(
    `  ${style.bold("Graph")} maxConcurrency ${graph.maxConcurrency ?? 4} · node timeout ${
      graph.nodeTimeoutMs === null
        ? "none"
        : `${Math.round((graph.nodeTimeoutMs ?? 10_800_000) / 60_000)} min`
    } per attempt (a whole agent run: all its model and tool calls)`,
  );
  const checkpoint = graph.checkpoint;
  lines.push(
    `    runs: ${
      checkpoint?.type === "postgres"
        ? `postgres ${sanitizeConnectionString(checkpoint.connectionString)}${checkpoint.schema ? ` (schema ${checkpoint.schema})` : ""}`
        : `files in ${checkpoint?.dir ?? ".umio/runs"} (next to the config)`
    }`,
  );
  return lines;
}

export function toolLines(toolsets: Record<string, Iterable<Tool>>, context: Context): string[] {
  const { style } = context.terminal;
  const lines: string[] = [];
  for (const [name, set] of Object.entries(toolsets)) {
    lines.push(style.bold(name));
    for (const tool of set) {
      const kind = tool.annotations?.readOnly
        ? style.dim("read-only")
        : style.yellow("may change things — asks first");
      lines.push(`  ${tool.name} · ${kind}`);
      if (context.options.verbose) lines.push(style.dim(`    ${oneLine(tool.description)}`));
    }
  }
  if (lines.length === 0) lines.push(style.dim('No tools configured (add a "tools" section).'));
  return lines;
}

function json(context: Context, value: unknown): number {
  context.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return EXIT.ok;
}

async function readAll(stream: InputStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "@litzrsh/umio" && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "unknown";
}

export type { Approval };
