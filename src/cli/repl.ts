/**
 * The interactive session. Readline edits the input line while idle; while
 * an operation runs, readline is closed and raw keypresses are read instead,
 * so Esc/Ctrl+C cancel (never exit) and typed text cannot garble the output.
 */
import { randomUUID } from "node:crypto";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import type { ToolCallPart } from "../llm/types.js";
import type { Tool } from "../tools/tool.js";
import { Activity } from "./activity.js";
import {
  type Context,
  configLines,
  EXIT,
  modelClient,
  reportError,
  reportInterruption,
  runGraphCommand,
  toolLines,
} from "./app.js";
import { parseCommandLine } from "./args.js";
import { type Approval, runChatTurn } from "./chat.js";
import {
  describeModel,
  loadCliConfig,
  requireModel,
  selectToolsets,
  summarizeModels,
} from "./config.js";
import { formatDuration } from "./duration.js";
import { formatCount, summarizeInput, truncate, turnFooter } from "./format.js";
import { TOPICS } from "./help.js";
import { completeLine, keyAction, parseLine } from "./keys.js";
import { ChatSession, OperationGate, type OperationKind } from "./session.js";
import { TerminalChatView } from "./views.js";

export async function startRepl(context: Context): Promise<number> {
  const { io, options, terminal } = context;
  const { style } = terminal;
  const now = () => terminal.timers.now();
  const located = await loadCliConfig(io.cwd, io.env, options.config);
  const { config } = located;
  const toolsets = selectToolsets(config, options.tools);
  const tools: Tool[] = Object.values(toolsets).flatMap((set) => [...set]);
  const llm = modelClient(context, config);
  const session = new ChatSession(requireModel(config, options.model), now(), shortId());
  const gate = new OperationGate();
  const history: string[] = [];
  let pendingApproval: ((answer: Approval) => void) | undefined;
  let prefill: string | undefined;
  let rl: Interface | undefined;

  const describeCurrentModel = () =>
    summarizeModels(config, io.env).find((model) => model.alias === session.model);

  terminal.line(
    `${style.bold("umio")} ${style.dim(`· model ${session.model} (${describeCurrentModel()?.model ?? "?"}${describeCurrentModel()?.local ? ", local" : ""}) · tools: ${Object.keys(toolsets).join(", ") || "none"} · /help · Ctrl+D to exit`)}`,
  );

  /** Reads one line; null on Ctrl+D (or when stdin ends). */
  const readLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (value: string | null) => {
        if (settled) return;
        settled = true;
        const current = rl;
        rl = undefined;
        current?.close();
        resolve(value);
      };
      rl = createInterface({
        input: io.stdin as NodeJS.ReadableStream,
        output: io.stdout as NodeJS.WritableStream,
        terminal: true,
        history: [...history],
        historySize: 500,
        removeHistoryDuplicates: true,
        completer: completeLine,
      });
      rl.setPrompt(`${style.cyan(style.symbols.prompt)} `);
      rl.on("line", (line) => {
        if (line.trim()) history.unshift(line);
        done(line);
      });
      rl.on("close", () => done(null));
      rl.on("SIGINT", () => {
        const current = rl;
        if (!current) return;
        if (current.line.length > 0) {
          current.write(null, { ctrl: true, name: "u" }); // clear the line
          return;
        }
        io.stdout.write(
          `\n${style.dim("(Ctrl+C cancels running work. To exit, press Ctrl+D or type /exit.)")}\n`,
        );
        current.prompt();
      });
      rl.prompt();
      if (prefill) {
        rl.write(prefill);
        prefill = undefined;
      }
    });

  /** Runs `body` as the one operation, with Esc/Ctrl+C wired to cancel it. */
  const operation = async <T>(kind: OperationKind, body: (signal: AbortSignal) => Promise<T>) => {
    const signal = gate.begin(kind);
    const stdin = io.stdin;
    const onKey = (
      _text: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ) => {
      const action = keyAction(key ?? {}, {
        operation: gate.state,
        approvalPending: pendingApproval !== undefined,
      });
      switch (action) {
        case "cancel":
          gate.cancel();
          pendingApproval?.("no");
          pendingApproval = undefined;
          terminal.forceNote(
            style.yellow(
              kind === "graph"
                ? "Cancelling… running nodes get a grace period to stop."
                : "Cancelling…",
            ),
          );
          break;
        case "still-cancelling":
          terminal.note(style.dim("Still cancelling; waiting for running work to stop."));
          break;
        case "hint-cancel-first":
          terminal.note(style.dim("Something is running. Press Esc or Ctrl+C to cancel it first."));
          break;
        case "approve-yes":
        case "approve-no":
        case "approve-always": {
          const answer = pendingApproval;
          pendingApproval = undefined;
          answer?.(
            action === "approve-yes" ? "yes" : action === "approve-always" ? "always" : "no",
          );
          break;
        }
        default:
          break;
      }
    };
    emitKeypressEvents(stdin as NodeJS.ReadableStream);
    stdin.setRawMode?.(true);
    stdin.on("keypress", onKey);
    stdin.resume?.();
    try {
      return await body(signal);
    } finally {
      stdin.off("keypress", onKey);
      stdin.setRawMode?.(false);
      pendingApproval?.("no");
      pendingApproval = undefined;
      gate.end();
    }
  };

  const approve = (call: ToolCallPart, tool: Tool, activity: Activity): Promise<Approval> =>
    new Promise((resolve) => {
      pendingApproval = (answer) => {
        activity.set({ kind: "model" }, now());
        terminal.note(
          style.dim(
            `    → ${answer === "always" ? `yes, and always for ${tool.name} this session` : answer}`,
          ),
        );
        resolve(answer);
      };
      activity.set({ kind: "approval", name: tool.name }, now());
      terminal.note(
        `${style.yellow(`  ${style.symbols.warn} ${tool.name}`)} ${style.dim(truncate(summarizeInput(call.input), terminal.width - tool.name.length - 30))} ${style.bold("run it? [y]es [n]o [a]lways")}`,
      );
    });

  const chat = async (text: string) => {
    const started = now();
    const activity = new Activity(started);
    terminal.startActivity(activity);
    const outcome = await operation("chat", (signal) =>
      runChatTurn(session, text, {
        llm,
        tools,
        signal,
        autoApprove: options.yes,
        approve: (call, tool) => approve(call, tool, activity),
        view: new TerminalChatView(terminal, activity, {
          verbose: options.verbose,
          showTools: true,
        }),
      }),
    ).finally(() => terminal.stopActivity());
    terminal.endText();
    if (outcome.status === "completed") {
      terminal.note(turnFooter(now() - started, outcome.result.usage, style));
      if (outcome.result.stopReason === "max-steps") {
        terminal.note(
          style.yellow("! Stopped at the step limit while the model still wanted tools."),
        );
      }
      return;
    }
    reportInterruption(outcome, context);
    if (outcome.interruption.restoredPrompt !== undefined) {
      prefill = outcome.interruption.restoredPrompt;
      terminal.note(style.dim("Nothing ran; your message is back on the prompt."));
    } else {
      terminal.note(style.dim("The model will be told what already ran with your next message."));
    }
  };

  const graph = async (argv: readonly string[]) => {
    const parsed = parseCommandLine(["graph", ...argv]);
    if (!parsed.ok) {
      terminal.forceNote(`${style.red("error:")} ${parsed.error}`);
      terminal.note(
        style.dim(
          "hint: /graph run <module> · status <run-id> · list · resume <module> <run-id> · cancel <run-id> · approvals · approve|reject <run-id> <node-id> · recover …",
        ),
      );
      return;
    }
    const merged = {
      ...parsed.options,
      ...(parsed.options.config === undefined && { config: located.path }),
      ...(parsed.options.store === undefined &&
        options.store !== undefined && { store: options.store }),
      color: style.color,
    };
    const graphContext: Context = { ...context, options: merged };
    await operation("graph", (signal) =>
      runGraphCommand(parsed.command, graphContext, signal).catch((error) => {
        reportError(error, graphContext);
        return EXIT.error;
      }),
    );
  };

  const onTerm = io.onSignal("SIGTERM", () => {
    terminal.stopActivity();
    terminal.forceNote(
      style.yellow(
        "Terminated. Graph runs in progress are left as they are; inspect them with umio graph status.",
      ),
    );
    io.exit(EXIT.cancelled);
  });
  // With raw mode on, Ctrl+C arrives as a key; a SIGINT from elsewhere cancels too.
  const onInt = io.onSignal("SIGINT", () => {
    if (gate.state !== "idle") gate.cancel();
  });

  try {
    for (;;) {
      const line = await readLine();
      if (line === null) break;
      const action = parseLine(line);
      try {
        switch (action.kind) {
          case "empty":
            break;
          case "prompt":
            await chat(action.text);
            break;
          case "help":
            io.stdout.write(TOPICS.chat ?? "");
            break;
          case "model":
            if (action.alias) {
              session.model = requireModel(config, action.alias);
              terminal.line(`Model: ${session.model}. The conversation continues with it.`);
            } else {
              for (const model of summarizeModels(config, io.env)) {
                terminal.line(
                  `${model.alias === session.model ? style.cyan(style.symbols.running) : " "} ${describeModel(model)}`,
                );
              }
            }
            break;
          case "config":
            for (const text of configLines(located, context)) terminal.line(text);
            break;
          case "tools":
            for (const text of toolLines(toolsets, context)) terminal.line(text);
            if (session.alwaysApproved.size > 0) {
              terminal.line(
                style.dim(
                  `Always approved this session: ${[...session.alwaysApproved].join(", ")}`,
                ),
              );
            }
            break;
          case "session":
            terminal.line(
              [
                `Session ${session.id} · model ${session.model}`,
                `  started ${formatDuration(now() - session.startedAt)} ago · ${session.turns} turns · ${session.messages.length} messages`,
                `  tokens in ${formatCount(session.usage.inputTokens)} out ${formatCount(session.usage.outputTokens)}`,
                session.pendingNote
                  ? "  the next message will tell the model about a cancelled turn's tools"
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            break;
          case "new":
            session.reset(now(), shortId());
            terminal.line(
              `New session ${session.id}. The transcript and tool approvals were cleared.`,
            );
            break;
          case "cancel":
            terminal.line(
              style.dim("Nothing is running. (While something runs, press Esc or Ctrl+C.)"),
            );
            break;
          case "exit":
            return EXIT.ok;
          case "graph":
            await graph(action.argv);
            break;
          case "error":
            terminal.forceNote(`${style.red("error:")} ${action.message}`);
            break;
        }
      } catch (error) {
        reportError(error, context);
      }
    }
    return EXIT.ok;
  } finally {
    onTerm();
    onInt();
    rl?.close();
    terminal.stopActivity();
    io.stdin.pause?.();
  }
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}
