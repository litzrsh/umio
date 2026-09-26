import { describe, expect, it } from "vitest";
import { Activity } from "../src/cli/activity.js";
import { DEFAULT_HEARTBEAT_MS, parseCommandLine, splitCommandLine } from "../src/cli/args.js";
import { formatDuration, parseDuration } from "../src/cli/duration.js";
import { nodeTable, recoveryBlock, summarizeInput, truncate } from "../src/cli/format.js";
import { keyAction, parseLine } from "../src/cli/keys.js";
import { ChatSession, OperationGate } from "../src/cli/session.js";
import { createStyle, detectColor, stripAnsi } from "../src/cli/style.js";
import { Terminal, type Timers } from "../src/cli/terminal.js";
import type { GenerateResult, ToolCallPart, WorkflowRun } from "../src/index.js";

const plain = createStyle(false);

describe("parseCommandLine", () => {
  const command = (...argv: string[]) => {
    const result = parseCommandLine(argv);
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  it("defaults to chat and parses global options", () => {
    const { command: parsed, options } = command(
      "--model",
      "local",
      "--tools",
      "repo, misc",
      "-q",
      "--no-color",
    );
    expect(parsed).toEqual({ kind: "chat" });
    expect(options).toMatchObject({
      model: "local",
      tools: ["repo", "misc"],
      quiet: true,
      color: false,
      yes: false,
    });
    expect(options.heartbeatMs).toBe(DEFAULT_HEARTBEAT_MS);
  });

  it("parses help, version and topics", () => {
    expect(command("--version").command).toEqual({ kind: "version" });
    expect(command("-h").command).toEqual({ kind: "help" });
    expect(command("graph", "--help").command).toEqual({ kind: "help", topic: "graph" });
    expect(command("help", "doctor").command).toEqual({ kind: "help", topic: "doctor" });
  });

  it("joins ask arguments into one prompt", () => {
    expect(command("ask", "what", "is", "this?").command).toEqual({
      kind: "ask",
      prompt: "what is this?",
    });
    expect(command("ask").command).toEqual({ kind: "ask" });
  });

  it("parses graph subcommands", () => {
    expect(command("graph", "run", "wf.mjs", "--input", "hi", "--run-id", "r1").command).toEqual({
      kind: "graph-run",
      module: "wf.mjs",
      input: "hi",
      runId: "r1",
    });
    expect(command("graph", "status", "r1").command).toEqual({ kind: "graph-status", runId: "r1" });
    expect(command("graph", "cancel", "r1").command).toEqual({
      kind: "graph-cancel",
      runId: "r1",
      wait: false,
      timeoutMs: 30_000,
    });
    expect(command("graph", "cancel", "r1", "--wait", "--timeout", "2m").command).toMatchObject({
      wait: true,
      timeoutMs: 120_000,
    });
    expect(command("graph", "list", "--needs-recovery").command).toEqual({
      kind: "graph-list",
      needsRecovery: true,
    });
    expect(command("graph", "resume", "wf.mjs", "r1").command).toEqual({
      kind: "graph-resume",
      module: "wf.mjs",
      runId: "r1",
    });
    expect(
      command("graph", "recover", "wf.mjs", "r1", "a", "--fail", "--reason", "refunded").command,
    ).toEqual({
      kind: "graph-recover",
      module: "wf.mjs",
      runId: "r1",
      nodeId: "a",
      choice: { type: "fail", reason: "refunded" },
    });
    expect(
      command("graph", "recover", "wf.mjs", "r1", "a", "--complete", '{"x":1}').command,
    ).toMatchObject({
      choice: { type: "complete", json: '{"x":1}' },
    });
  });

  it("reports usage errors with a help topic", () => {
    const errors = [
      [["frobnicate"], /Unknown command "frobnicate".*umio ask/],
      [["graph"], /Missing graph subcommand/],
      [["graph", "run"], /needs <module>/],
      [["graph", "status", "a", "b"], /Unexpected argument "b"/],
      [["graph", "recover", "m", "r", "n"], /exactly one of --retry/],
      [["graph", "recover", "m", "r", "n", "--retry", "--fail"], /exactly one/],
      [
        ["graph", "run", "m", "--input", "a", "--input-file", "f"],
        /either --input or --input-file/,
      ],
      [["--bogus"], /Unknown option '--bogus'/],
      [["--heartbeat", "soon"], /Invalid --heartbeat/],
      [["doctor", "--node-timeout", "forever"], /Invalid --node-timeout/],
      [["graph", "cancel", "r1", "--timeout", "later"], /Invalid --timeout/],
    ] as const;
    for (const [argv, message] of errors) {
      const result = parseCommandLine(argv);
      expect(result.ok, argv.join(" ")).toBe(false);
      if (!result.ok) expect(result.error).toMatch(message);
    }
  });

  it("parses doctor's intended node duration", () => {
    expect(command("doctor").command).toEqual({ kind: "doctor", nodeTimeoutMs: 10_800_000 });
    expect(command("doctor", "--node-timeout", "12h").command).toEqual({
      kind: "doctor",
      nodeTimeoutMs: 43_200_000,
    });
    expect(command("doctor", "--node-timeout", "none").command).toEqual({
      kind: "doctor",
      nodeTimeoutMs: null,
    });
  });
});

describe("splitCommandLine", () => {
  it("handles quotes and escapes", () => {
    expect(splitCommandLine(`run wf.mjs --input "two words" --complete '{"a": 1}' x\\ y`)).toEqual([
      "run",
      "wf.mjs",
      "--input",
      "two words",
      "--complete",
      '{"a": 1}',
      "x y",
    ]);
    expect(splitCommandLine(`say ""`)).toEqual(["say", ""]);
    expect(splitCommandLine(`"open`)).toBeUndefined();
  });
});

describe("durations", () => {
  it("parses and formats", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h30m")).toBe(9_000_000);
    expect(parseDuration("1h 5m")).toBe(3_900_000);
    expect(parseDuration("1500")).toBe(1_500);
    expect(parseDuration("off")).toBeNull();
    expect(parseDuration("3 days")).toBeUndefined();
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(2 * 3_600_000 + 3 * 60_000)).toBe("2h 03m");
  });
});

describe("interactive keys and lines", () => {
  it("cancels with Esc or Ctrl+C and never exits while something runs", () => {
    const running = { operation: "running", approvalPending: false } as const;
    expect(keyAction({ name: "escape" }, running)).toBe("cancel");
    expect(keyAction({ name: "c", ctrl: true }, running)).toBe("cancel");
    expect(keyAction({ name: "c", ctrl: true }, { ...running, operation: "cancelling" })).toBe(
      "still-cancelling",
    );
    expect(keyAction({ name: "d", ctrl: true }, running)).toBe("hint-cancel-first");
    expect(keyAction({ name: "x" }, running)).toBe("ignore");
    expect(
      keyAction({ name: "c", ctrl: true }, { operation: "idle", approvalPending: false }),
    ).toBe("ignore");
  });

  it("answers approvals only while one is pending", () => {
    const asking = { operation: "running", approvalPending: true } as const;
    expect(keyAction({ name: "y" }, asking)).toBe("approve-yes");
    expect(keyAction({ name: "n" }, asking)).toBe("approve-no");
    expect(keyAction({ name: "return" }, asking)).toBe("approve-no");
    expect(keyAction({ name: "a" }, asking)).toBe("approve-always");
    expect(keyAction({ name: "y" }, { ...asking, approvalPending: false })).toBe("ignore");
    expect(keyAction({ name: "escape" }, asking)).toBe("cancel");
  });

  it("parses slash commands and prompts", () => {
    expect(parseLine("  ")).toEqual({ kind: "empty" });
    expect(parseLine("hello there")).toEqual({ kind: "prompt", text: "hello there" });
    expect(parseLine("//etc/hosts is?")).toEqual({ kind: "prompt", text: "/etc/hosts is?" });
    expect(parseLine("/model local")).toEqual({ kind: "model", alias: "local" });
    expect(parseLine("/quit")).toEqual({ kind: "exit" });
    expect(parseLine(`/graph run wf.mjs --input "a b"`)).toEqual({
      kind: "graph",
      argv: ["run", "wf.mjs", "--input", "a b"],
    });
    expect(parseLine("/new now")).toMatchObject({ kind: "error" });
    expect(parseLine("/mdoel")).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/Did you mean \/model/),
    });
  });
});

describe("OperationGate", () => {
  it("moves idle → running → cancelling → idle; cancel is not exit", () => {
    const gate = new OperationGate();
    expect(gate.cancel()).toBe("idle");
    const signal = gate.begin("chat");
    expect(() => gate.begin("graph")).toThrow(/already running/);
    expect(gate.canExit()).toBe(false);
    expect(gate.cancel()).toBe("cancelling");
    expect(signal.aborted).toBe(true);
    expect(gate.cancel()).toBe("already-cancelling");
    expect(gate.state).toBe("cancelling");
    expect(gate.canExit()).toBe(false);
    gate.end();
    expect(gate.state).toBe("idle");
    expect(gate.canExit()).toBe(true);
  });
});

describe("ChatSession interruptions", () => {
  const call = (id: string, name: string): ToolCallPart => ({
    type: "tool-call",
    id,
    name,
    input: { id },
  });
  const modelResult = (calls: ToolCallPart[]): GenerateResult => ({
    message: { role: "assistant", content: calls },
    text: "",
    toolCalls: calls,
    finishReason: "tool-calls",
    rawFinishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "m",
    raw: {},
  });

  it("undoes a turn in which no tool ran and hands the prompt back", () => {
    const session = new ChatSession("local", 0, "s1");
    session.messages = [{ role: "user", content: "earlier" }];
    const turn = session.beginTurn("write the file");
    turn.modelFinished(modelResult([call("c1", "write_file")])); // requested, never started
    expect(session.interruptTurn(turn, "cancelled")).toEqual({
      restoredPrompt: "write the file",
      affected: [],
    });
    expect(session.messages).toEqual([{ role: "user", content: "earlier" }]);
    expect(session.pendingNote).toBeUndefined();
  });

  it("keeps what tools did, marks the unknown, and tells the model next time", () => {
    const session = new ChatSession("local", 0, "s1");
    const turn = session.beginTurn("deploy");
    const [done, interrupted, notStarted] = [
      call("c1", "build"),
      call("c2", "upload"),
      call("c3", "notify"),
    ];
    turn.modelFinished(modelResult([done, interrupted, notStarted]));
    turn.toolStarted("c1");
    turn.toolFinished({
      call: done,
      result: { type: "tool-result", toolCallId: "c1", content: "built" },
      executed: true,
      durationMs: 5,
    });
    turn.toolStarted("c2");

    const outcome = session.interruptTurn(turn, "cancelled");
    expect(outcome.restoredPrompt).toBeUndefined();
    expect(outcome.affected.map((tool) => [tool.call.name, tool.status])).toEqual([
      ["build", "done"],
      ["upload", "running"],
    ]);
    const tool = session.messages.at(-1);
    expect(tool?.role).toBe("tool");
    expect(tool?.content).toEqual([
      { type: "tool-result", toolCallId: "c1", content: "built" },
      expect.objectContaining({
        toolCallId: "c2",
        isError: true,
        content: expect.stringMatching(/outcome is unknown/),
      }),
      expect.objectContaining({
        toolCallId: "c3",
        isError: true,
        content: expect.stringMatching(/Not run/),
      }),
    ]);
    // The next message carries the note once, so the model does not repeat the tools.
    const next = session.beginTurn("status?");
    expect(next.userMessage.content).toMatch(
      /^\[Note from umio: .*build \(completed\), upload \(interrupted, outcome unknown\).*\]\n\nstatus\?$/s,
    );
    expect(next.prompt).toBe("status?");
  });

  it("reset clears the transcript, usage and approvals", () => {
    const session = new ChatSession("local", 0, "s1");
    session.messages = [{ role: "user", content: "x" }];
    session.alwaysApproved.add("write_file");
    session.pendingNote = "note";
    session.reset(10, "s2");
    expect(session).toMatchObject({
      id: "s2",
      startedAt: 10,
      messages: [],
      turns: 0,
      pendingNote: undefined,
    });
    expect(session.alwaysApproved.size).toBe(0);
  });
});

describe("Activity", () => {
  it("describes long silence as still running, never as a failure", () => {
    const activity = new Activity(0);
    expect(activity.describe(5_000)).toBe("waiting for model · 5s");
    const prefill = activity.describe(2 * 3_600_000);
    expect(prefill).toMatch(/waiting for model · 2h 00m · no output yet — still running/);
    expect(prefill).not.toMatch(/fail|error|timeout/i);
    activity.output(2 * 3_600_000);
    expect(activity.describe(2 * 3_600_000 + 1_000)).toBe("receiving · 2h 00m");
    expect(activity.describe(2 * 3_600_000 + 14 * 60_000)).toMatch(
      /still running, last output 14m 00s ago/,
    );
  });

  it("keeps showing cancelling until the operation ends", () => {
    const activity = new Activity(0);
    activity.set({ kind: "cancelling" }, 1);
    activity.set({ kind: "model" }, 2);
    expect(activity.describe(3)).toMatch(/^cancelling/);
  });
});

describe("formatting", () => {
  const run: WorkflowRun = {
    schemaVersion: 1,
    runId: "r 1",
    workflowId: "wf",
    definitionVersion: "1",
    definitionHash: "h",
    status: "needs-recovery",
    input: null,
    nodes: {
      a: { nodeId: "a", status: "completed", attempt: 1, startedAt: 0, finishedAt: 65_000 },
      b: {
        nodeId: "b",
        status: "uncertain",
        attempt: 2,
        uncertainReason: "process-lost",
        startedAt: 0,
        finishedAt: 1,
      },
      c: { nodeId: "c", status: "pending", attempt: 0 },
    },
    edges: {},
    revision: 3,
    createdAt: 0,
    updatedAt: 0,
  };

  it("shows node status as symbol and word, without color codes when plain", () => {
    const lines = nodeTable(run, plain, 80, 0);
    expect(lines).toEqual([
      "  a     ✓ completed · attempt 1 · 1m 05s",
      "  b     ? uncertain · attempt 2 · 1ms (process-lost)",
      "  c     · pending",
    ]);
    const colored = nodeTable(run, createStyle(true), 80, 0);
    expect(colored.map(stripAnsi)).toEqual(lines);
  });

  it("explains uncertain nodes and offers explicit recovery commands, choosing none", () => {
    const text = recoveryBlock(run, plain, "wf.mjs").join("\n");
    expect(text).toMatch(/1 node needs manual recovery\. umio never retries these automatically\./);
    expect(text).toMatch(/idempotency key r 1:b/);
    expect(text).toMatch(/side effects may have happened/);
    for (const flag of ["--retry", "--complete '<json>'", "--fail --reason"]) {
      expect(text).toContain(`umio graph recover wf.mjs 'r 1' b ${flag}`);
    }
    expect(text).toContain("umio graph resume wf.mjs 'r 1'");
  });

  it("fits narrow terminals", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
    for (const line of nodeTable(run, plain, 20, 0))
      expect([...line].length).toBeLessThanOrEqual(40);
    expect(summarizeInput({ path: "src/a.ts", query: "two  words" })).toBe(
      'path=src/a.ts query="two words"',
    );
  });
});

describe("color detection", () => {
  it("follows --no-color, NO_COLOR, FORCE_COLOR and the TTY", () => {
    expect(detectColor(true, {})).toBe(true);
    expect(detectColor(false, {})).toBe(false);
    expect(detectColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(detectColor(false, { FORCE_COLOR: "1" })).toBe(true);
    expect(detectColor(true, { TERM: "dumb" })).toBe(false);
    expect(detectColor(true, {}, false)).toBe(false);
    expect(createStyle(false, { TERM: "dumb" }).symbols.ok).toBe("+");
  });
});

describe("Terminal", () => {
  class Stream {
    text = "";
    columns = 40;
    listeners: (() => void)[] = [];
    constructor(readonly isTTY: boolean) {}
    write(chunk: string) {
      this.text += chunk;
    }
    on(_event: "resize", listener: () => void) {
      this.listeners.push(listener);
    }
    off(_event: "resize", listener: () => void) {
      this.listeners = this.listeners.filter((item) => item !== listener);
    }
  }
  const timers = () => {
    let now = 0;
    const ticks: { ms: number; tick: () => void; next: number }[] = [];
    const fake: Timers & { advance(ms: number): void } = {
      now: () => now,
      every(ms, tick) {
        const entry = { ms, tick, next: now + ms };
        ticks.push(entry);
        return () => ticks.splice(ticks.indexOf(entry), 1);
      },
      advance(ms) {
        const end = now + ms;
        for (;;) {
          const due = ticks.filter((entry) => entry.next <= end).sort((a, b) => a.next - b.next)[0];
          if (!due) break;
          now = due.next;
          due.next += due.ms;
          due.tick();
        }
        now = end;
      },
    };
    return fake;
  };

  it("draws the status line in a TTY, never over partial model text, and clears it before output", () => {
    const out = new Stream(true);
    const clock = timers();
    const terminal = new Terminal(out, out, {
      style: plain,
      quiet: false,
      heartbeatMs: 1_000,
      env: {},
      timers: clock,
    });
    terminal.startActivity(new Activity(0));
    expect(out.text).toContain("waiting for model · 0ms");
    terminal.text("partial answer");
    const before = out.text.length;
    clock.advance(3_000);
    expect(out.text.length).toBe(before); // mid-line: no redraw
    terminal.endText();
    clock.advance(1_000);
    expect(out.text.slice(before)).toContain("\n\r\x1b[2K");
    expect(out.text.slice(before)).toMatch(/waiting for model · 4s/);
    terminal.stopActivity();
    expect(out.text.endsWith("\r\x1b[2K")).toBe(true);
    expect(out.listeners).toHaveLength(0);
  });

  it("redraws to the new width on resize", () => {
    const out = new Stream(true);
    const clock = timers();
    const terminal = new Terminal(out, out, {
      style: plain,
      quiet: false,
      heartbeatMs: 1_000,
      env: {},
      timers: clock,
    });
    terminal.startActivity(new Activity(0));
    clock.advance(3_600_000);
    out.columns = 20;
    out.text = "";
    for (const listener of out.listeners) listener();
    const drawn = out.text.replace("\r\x1b[2K", "");
    expect([...drawn].length).toBeLessThanOrEqual(19);
    terminal.stopActivity();
  });

  it("prints heartbeats instead when not a TTY, and nothing when quiet", () => {
    const out = new Stream(false);
    const err = new Stream(false);
    const clock = timers();
    const terminal = new Terminal(out, err, {
      style: plain,
      quiet: false,
      heartbeatMs: 60_000,
      env: {},
      timers: clock,
    });
    terminal.startActivity(new Activity(0));
    clock.advance(3 * 60_000);
    expect(err.text.trim().split("\n")).toEqual([
      "umio: still running · waiting for model · 1m 00s · no output yet — still running; long local prompts can take hours",
      "umio: still running · waiting for model · 2m 00s · no output yet — still running; long local prompts can take hours",
      "umio: still running · waiting for model · 3m 00s · no output yet — still running; long local prompts can take hours",
    ]);
    expect(out.text).toBe("");
    terminal.stopActivity();

    const quietErr = new Stream(false);
    const quiet = new Terminal(out, quietErr, {
      style: plain,
      quiet: true,
      heartbeatMs: 60_000,
      env: {},
      timers: clock,
    });
    quiet.startActivity(new Activity(clock.now()));
    clock.advance(10 * 60_000);
    quiet.note("tool line");
    quiet.forceNote("error: shown anyway");
    expect(quietErr.text).toBe("error: shown anyway\n");
  });
});

describe("chat turns", () => {
  it("asks before tools that may change things: always is remembered, no declines, read-only runs", async () => {
    const { runChatTurn } = await import("../src/cli/chat.js");
    const { tool } = await import("../src/index.js");
    const { z } = await import("zod");
    const ran: string[] = [];
    const make = (name: string, readOnly: boolean) =>
      tool({
        name,
        description: name,
        parameters: z.object({}),
        annotations: { readOnly },
        execute: async () => {
          ran.push(name);
          return "ok";
        },
      });
    const tools = [make("look", true), make("write", false), make("delete", false)];
    const calls = (...names: string[]): ToolCallPart[] =>
      names.map((name, index) => ({ type: "tool-call", id: `${name}-${index}`, name, input: {} }));
    const results: GenerateResult[] = [
      { ...modelReply(calls("look", "write", "delete")) },
      { ...modelReply(calls("write")) },
      modelReply([], "done"),
    ];
    const llm = {
      generate: async () => results.shift() as GenerateResult,
      async *stream() {
        yield { type: "finish" as const, result: results.shift() as GenerateResult };
      },
    };
    const asked: string[] = [];
    const session = new ChatSession("local", 0, "s");
    const outcome = await runChatTurn(session, "go", {
      llm,
      tools,
      signal: new AbortController().signal,
      autoApprove: false,
      approve: async (call) => {
        asked.push(call.name);
        return call.name === "write" ? "always" : "no";
      },
      view: { waiting() {}, text() {}, modelFinished() {}, toolStarted() {}, toolFinished() {} },
    });
    expect(outcome.status).toBe("completed");
    expect(asked).toEqual(["write", "delete"]); // look is read-only; the second write is remembered
    expect(ran).toEqual(["look", "write", "write"]);
    expect([...session.alwaysApproved]).toEqual(["write"]);
  });
});

function modelReply(calls: ToolCallPart[], text = ""): GenerateResult {
  return {
    message: { role: "assistant", content: calls.length ? calls : text },
    text,
    toolCalls: calls,
    finishReason: calls.length ? "tool-calls" : "stop",
    rawFinishReason: "x",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "m",
    raw: {},
  };
}

describe("cancel acknowledgments", () => {
  it("always say whether the cancel is only recorded or confirmed", async () => {
    const { cancelReportLines } = await import("../src/cli/app.js");
    const out = { write() {} };
    const terminal = new Terminal(out, out, {
      style: plain,
      quiet: false,
      heartbeatMs: 0,
      env: {},
    });
    const text = (report: Parameters<typeof cancelReportLines>[0]) =>
      cancelReportLines(report, terminal).join("\n");
    expect(
      text({ runId: "r", outcome: "recorded", via: "control-file", ownerActive: true }),
    ).toMatch(
      /Cancel request recorded for run r — not yet confirmed\.[\s\S]*checks every ~2 s[\s\S]*Confirm with `umio graph status r`/,
    );
    expect(
      text({ runId: "r", outcome: "recorded", via: "control-file", ownerActive: false }),
    ).toMatch(/No process is driving this run right now/);
    expect(
      text({ runId: "r", outcome: "recorded", waited: "ended", confirmed: "cancelled" }),
    ).toMatch(/not yet confirmed[\s\S]*Confirmed: run r is cancelled\./);
    expect(
      text({ runId: "r", outcome: "recorded", waited: "ended", confirmed: "completed" }),
    ).toMatch(/Run r ended completed before the cancel took effect\./);
    expect(text({ runId: "r", outcome: "already-requested", waited: "timeout" })).toMatch(
      /already recorded[\s\S]*Not confirmed yet: run r is still running\. The request stays recorded/,
    );
    expect(text({ runId: "r", outcome: "cancelled", via: "store" })).toMatch(
      /^Confirmed: run r is cancelled\./,
    );
    expect(text({ runId: "r", outcome: "already-terminal", status: "completed" })).toBe(
      "Nothing to cancel: run r is already completed.",
    );
  });
});
