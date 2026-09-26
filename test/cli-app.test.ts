/**
 * The CLI end to end through `runCli` with fake streams, a scripted model and
 * real temp directories (config, workflow modules, checkpoint store).
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIO, runCli } from "../src/cli/app.js";
import type { PgModule } from "../src/cli/store.js";
import type {
  GenerateRequest,
  GenerateResult,
  ModelClient,
  StreamEvent,
  ToolCallPart,
} from "../src/index.js";
import { PGLITE_TIMEOUT_MS, pglite } from "./support/postgres.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(config: object | null = baseConfig()): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umio-cli-"));
  dirs.push(dir);
  if (config) await writeFile(join(dir, "umio.config.json"), JSON.stringify(config));
  return dir;
}

function baseConfig(extra: object = {}) {
  return {
    defaultModel: "local",
    providers: { ollama: { type: "ollama", baseURL: "http://127.0.0.1:9/v1" } },
    models: { local: { provider: "ollama", model: "tiny" } },
    tools: { files: { use: "files", root: "." }, misc: { use: "utilities" } },
    ...extra,
  };
}

class Sink {
  text = "";
  constructor(readonly isTTY = false) {}
  write(chunk: string) {
    this.text += chunk;
  }
}

function fakeIO(
  cwd: string,
  options: { stdin?: string; tty?: boolean; env?: Record<string, string> } = {},
) {
  const stdin = Object.assign(Readable.from(options.stdin === undefined ? [] : [options.stdin]), {
    isTTY: options.tty ?? false,
  });
  const handlers = new Map<string, (() => void)[]>();
  const exits: number[] = [];
  const io = {
    stdin,
    stdout: new Sink(options.tty),
    stderr: new Sink(options.tty),
    env: { ...options.env },
    cwd,
    onSignal(signal: string, handler: () => void) {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler]);
      return () =>
        handlers.set(
          signal,
          (handlers.get(signal) ?? []).filter((item) => item !== handler),
        );
    },
    exit(code: number) {
      exits.push(code);
    },
  };
  const signal = (name: string) => {
    for (const handler of handlers.get(name) ?? []) handler();
  };
  return { io: io as unknown as CliIO & { stdout: Sink; stderr: Sink }, signal, exits };
}

const reply = (text: string, calls: ToolCallPart[] = []): GenerateResult => ({
  message: { role: "assistant", content: calls.length ? calls : text },
  text,
  toolCalls: calls,
  finishReason: calls.length ? "tool-calls" : "stop",
  rawFinishReason: calls.length ? "tool_calls" : "stop",
  usage: { inputTokens: 10, outputTokens: 2 },
  model: "tiny",
  raw: {},
});

/** Replies in order; `gate` holds a reply until released (a long local call). */
function scripted(replies: (GenerateResult | "hang")[]) {
  const requests: GenerateRequest[] = [];
  const model: ModelClient = {
    generate: async () => {
      throw new Error("stream expected");
    },
    async *stream(request): AsyncGenerator<StreamEvent> {
      requests.push(request);
      const next = replies.shift();
      if (!next) throw new Error("no scripted reply");
      if (next === "hang") {
        await new Promise((_, reject) =>
          request.signal?.addEventListener("abort", () => reject(new Error("Request aborted.")), {
            once: true,
          }),
        );
        return;
      }
      if (next.text) yield { type: "text-delta", text: next.text };
      yield { type: "finish", result: next };
    },
  };
  return { model, requests };
}

describe("basics", () => {
  it("prints version and help; usage errors exit 2", async () => {
    const dir = await project();
    const version = fakeIO(dir);
    expect(await runCli(["--version"], version.io, { version: "9.9.9" })).toBe(0);
    expect(version.io.stdout.text).toBe("umio 9.9.9\n");

    const help = fakeIO(dir);
    expect(await runCli(["help", "graph"], help.io)).toBe(0);
    expect(help.io.stdout.text).toMatch(/umio graph recover <module> <run-id> <node-id> --retry/);

    const bad = fakeIO(dir);
    expect(await runCli(["graph", "run"], bad.io)).toBe(2);
    expect(bad.io.stderr.text).toBe("error: graph run needs <module>.\nhint: umio help graph\n");
  });

  it("refuses interactive chat without a terminal and points to ask", async () => {
    const { io } = fakeIO(await project());
    expect(await runCli([], io)).toBe(2);
    expect(io.stderr.text).toMatch(/Interactive chat needs a terminal[\s\S]*umio ask/);
  });

  it("explains a missing config and creates one with init", async () => {
    const dir = await project(null);
    const missing = fakeIO(dir);
    expect(await runCli(["models"], missing.io)).toBe(1);
    expect(missing.io.stderr.text).toMatch(
      /error: No umio.config.json found\.\nhint: Create one here with `umio init`/,
    );

    const init = fakeIO(dir);
    expect(await runCli(["init", "--local-model", "qwen3:8b"], init.io)).toBe(0);
    expect(init.io.stdout.text).toMatch(/ollama pull qwen3:8b && umio doctor/);
    const config = JSON.parse(await readFile(join(dir, "umio.config.json"), "utf8"));
    expect(config.models.local.model).toBe("qwen3:8b");
    expect(config.graph).toEqual({ maxConcurrency: 1 });

    const again = fakeIO(dir);
    expect(await runCli(["init"], again.io)).toBe(1);
    expect(again.io.stderr.text).toMatch(/already exists[\s\S]*--force/);

    const models = fakeIO(dir);
    expect(await runCli(["models", "--json"], models.io)).toBe(0);
    expect(JSON.parse(models.io.stdout.text)).toEqual([
      expect.objectContaining({
        alias: "local",
        model: "qwen3:8b",
        local: true,
        timeoutMs: 11_100_000,
        isDefault: true,
      }),
    ]);
  });

  it("rejects an unknown model alias with the configured ones", async () => {
    const { io } = fakeIO(await project());
    expect(
      await runCli(["ask", "--model", "gpt9", "hi"], io, { createModel: () => scripted([]).model }),
    ).toBe(2);
    expect(io.stderr.text).toMatch(
      /Unknown model alias "gpt9"\.\nhint: Configured aliases: local\./,
    );
  });

  it("masks literal secrets in config output", async () => {
    const dir = await project(
      baseConfig({
        providers: {
          ollama: { type: "ollama" },
          cloud: { type: "openai", apiKey: "sk-literal" },
          env: { type: "anthropic", apiKey: "${ANTHROPIC_API_KEY}" },
        },
      }),
    );
    const { io } = fakeIO(dir);
    expect(await runCli(["config", "--json"], io)).toBe(0);
    const { config } = JSON.parse(io.stdout.text);
    expect(config.providers.cloud.apiKey).toBe("••••");
    expect(config.providers.env.apiKey).toBe("${ANTHROPIC_API_KEY}");
  });
});

describe("doctor", () => {
  it("reports an unreachable local server with how to start it", async () => {
    const { io } = fakeIO(await project());
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await runCli(["doctor"], io, { fetch: failing })).toBe(1);
    expect(io.stdout.text).toMatch(
      /✗ error Local provider "ollama" is not reachable at http:\/\/127\.0\.0\.1:9\/v1\.\n\s+Start it with `ollama serve`/,
    );
  });

  it("warns about a missing model and provider timeouts shorter than the intended node duration", async () => {
    const dir = await project(
      baseConfig({
        providers: {
          ollama: { type: "ollama", baseURL: "http://127.0.0.1:9/v1", timeoutMs: 600_000 },
        },
      }),
    );
    const { io } = fakeIO(dir);
    const listing = (async () =>
      new Response(JSON.stringify({ data: [{ id: "other:latest" }] }))) as unknown as typeof fetch;
    expect(await runCli(["doctor", "--json", "--node-timeout", "6h"], io, { fetch: listing })).toBe(
      0,
    );
    const report = JSON.parse(io.stdout.text);
    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        status: "warn",
        title: expect.stringMatching(/does not list: tiny/),
        hint: "Pull it: ollama pull tiny",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        status: "warn",
        title: expect.stringMatching(
          /timeoutMs 600000 ms, below the graph node timeout of 21600000 ms/,
        ),
        hint: expect.stringMatching(
          /Provider limits apply to ONE request; the node timeout covers a whole agent attempt/,
        ),
      }),
    );
  });
});

describe("umio ask", () => {
  it("streams text to stdout and tool activity to stderr", async () => {
    const dir = await project();
    const { model, requests } = scripted([
      reply("", [
        { type: "tool-call", id: "c1", name: "current_time", input: { timeZone: "UTC" } },
      ]),
      reply("It is noon."),
    ]);
    const { io } = fakeIO(dir);
    expect(
      await runCli(["ask", "--no-color", "what", "time?"], io, { createModel: () => model }),
    ).toBe(0);
    expect(io.stdout.text).toBe("It is noon.\n");
    expect(io.stderr.text).toMatch(
      /^ {2}⚙ current_time timeZone=UTC\n {2}✓ current_time · \d+ms · \d+ B\n· \d+ms · in 20 out 4 tokens\n$/,
    );
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "what time?" }]);
    expect(requests[0]?.model).toBe("local");

    const none = scripted([reply("ok")]);
    expect(
      await runCli(["ask", "--tools", "none", "hi"], fakeIO(dir).io, {
        createModel: () => none.model,
      }),
    ).toBe(0);
    expect(none.requests[0]?.tools).toEqual([]);
    const unknown = fakeIO(dir);
    expect(
      await runCli(["ask", "--tools", "nope", "hi"], unknown.io, { createModel: () => none.model }),
    ).toBe(2);
    expect(unknown.io.stderr.text).toMatch(
      /Unknown toolset: nope\.\nhint: Configured toolsets: files, misc\./,
    );
  });

  it("reads the prompt from stdin and prints JSON", async () => {
    const { model } = scripted([reply("Hello.")]);
    const { io } = fakeIO(await project(), { stdin: "say hello\n" });
    expect(await runCli(["ask", "--json"], io, { createModel: () => model })).toBe(0);
    expect(JSON.parse(io.stdout.text)).toEqual({
      text: "Hello.",
      stopReason: "done",
      model: "local",
      usage: { inputTokens: 10, outputTokens: 2 },
      tools: [],
    });
  });

  it("declines tools that may change things unless --yes", async () => {
    const dir = await project();
    const write = {
      type: "tool-call" as const,
      id: "w1",
      name: "write_file",
      input: { path: "out.txt", content: "x" },
    };
    const declined = scripted([reply("", [write]), reply("I could not write it.")]);
    const first = fakeIO(dir);
    expect(await runCli(["ask", "write it"], first.io, { createModel: () => declined.model })).toBe(
      0,
    );
    await expect(access(join(dir, "out.txt"))).rejects.toThrow();
    expect(first.io.stderr.text).toMatch(
      /– write_file not run: Declined: write_file may change things/,
    );

    const approved = scripted([reply("", [write]), reply("Written.")]);
    const second = fakeIO(dir);
    expect(
      await runCli(["ask", "--yes", "write it"], second.io, { createModel: () => approved.model }),
    ).toBe(0);
    await expect(readFile(join(dir, "out.txt"), "utf8")).resolves.toBe("x");
  });

  it("Ctrl+C cancels (exit 130), reports tools that already ran, and a second Ctrl+C exits at once", async () => {
    const dir = await project();
    const { model } = scripted([
      reply("", [{ type: "tool-call", id: "c1", name: "current_time", input: {} }]),
      "hang",
    ]);
    const { io, signal, exits } = fakeIO(dir);
    const running = runCli(["ask", "--no-color", "time?"], io, { createModel: () => model });
    await new Promise((resolve) => setTimeout(resolve, 50));
    signal("SIGINT");
    expect(await running).toBe(130);
    expect(io.stderr.text).toMatch(
      /Cancelling… Press Ctrl\+C again to exit immediately\.\n– Cancelled\.\n! Tools that already ran and may have had effects: current_time\. They will not be re-run automatically\./,
    );
    expect(exits).toEqual([]);

    const hung = scripted(["hang"]);
    const twice = fakeIO(dir);
    const pending = runCli(["ask", "hi"], twice.io, { createModel: () => hung.model });
    await new Promise((resolve) => setTimeout(resolve, 20));
    twice.signal("SIGINT");
    twice.signal("SIGINT");
    expect(twice.exits).toEqual([130]);
    await pending;
  });

  it("explains an unreachable server without dumping objects", async () => {
    const { io } = fakeIO(await project());
    expect(await runCli(["ask", "hi"], io)).toBe(1); // the real LLM against a closed port
    expect(io.stderr.text).toMatch(
      /error: Cannot reach the ollama server\.\nhint: Is it running\? For Ollama: `ollama serve`/,
    );
    expect(io.stderr.text).not.toMatch(/\{|at .*\.ts/);
  }, 20_000);
});

describe("umio graph", () => {
  /** A workflow module with plain handlers (no imports needed). */
  async function module(dir: string, body: string): Promise<string> {
    const path = join(dir, "wf.mjs");
    await writeFile(path, body);
    return path;
  }
  const chain = (handlers: string) => `
    export default ({ llm }) => ({
      graph: { id: "wf", version: "1", entry: ["a"], nodes: [{ id: "a", handler: "a" }, { id: "b", handler: "b" }], edges: [{ from: "a", to: "b" }] },
      handlers: { ${handlers} },
      predicates: {},
    });`;

  it("runs a workflow, shows its result, and reports status and list as JSON", async () => {
    const dir = await project();
    const path = await module(
      dir,
      chain(
        `a: async (c) => "A:" + c.input, b: async (c) => ({ text: "done with " + c.predecessors.a })`,
      ),
    );
    const run = fakeIO(dir);
    expect(
      await runCli(["graph", "run", path, "--input", "go", "--run-id", "r1", "--no-color"], run.io),
    ).toBe(0);
    expect(run.io.stderr.text).toMatch(
      /Run r1\n▸ a started \(attempt 1\)\n✓ a completed · \d+ms\n▸ b started/,
    );
    expect(run.io.stdout.text).toMatch(/r1 · wf@1 · ✓ completed[\s\S]*b:\ndone with A:go\n$/);

    const status = fakeIO(dir);
    expect(await runCli(["graph", "status", "r1", "--json"], status.io)).toBe(0);
    expect(JSON.parse(status.io.stdout.text)).toMatchObject({
      runId: "r1",
      status: "completed",
      owner: "not owned",
      needsRecovery: [],
    });
    await expect(access(join(dir, ".umio", "runs", "r1.run.json"))).resolves.toBeUndefined();

    const list = fakeIO(dir);
    expect(await runCli(["graph", "list"], list.io)).toBe(0);
    expect(list.io.stdout.text).toMatch(/^r1 {2}✓ completed/);
  });

  it("parks a node that may have had effects, shows how to recover it, and never picks for the user", async () => {
    const dir = await project();
    // Node a returns an oversized result after its side effect: it becomes uncertain (invalid-output).
    const path = await module(
      dir,
      chain(`a: async () => "x".repeat(300000), b: async (c) => c.predecessors.a`),
    );
    const run = fakeIO(dir);
    expect(await runCli(["graph", "run", path, "--run-id", "r1", "--no-color"], run.io)).toBe(3);
    expect(run.io.stdout.text).toMatch(/\? needs recovery/);
    expect(run.io.stdout.text).toMatch(
      /1 node needs manual recovery\. umio never retries these automatically\./,
    );
    expect(run.io.stdout.text).toMatch(/--retry[\s\S]*--complete '<json>'[\s\S]*--fail/);

    const list = fakeIO(dir);
    await runCli(["graph", "list", "--needs-recovery", "--json"], list.io);
    expect(JSON.parse(list.io.stdout.text)).toEqual([
      expect.objectContaining({
        runId: "r1",
        needsRecovery: ["a"],
        nodes: expect.arrayContaining([
          expect.objectContaining({
            nodeId: "a",
            idempotencyKey: "r1:a",
            uncertainReason: "invalid-output",
          }),
        ]),
      }),
    ]);

    const ref = JSON.stringify({
      $artifact: { uri: "file:///tmp/a", sha256: "ab".repeat(32), bytes: 300002 },
    });
    const recover = fakeIO(dir);
    expect(await runCli(["graph", "recover", path, "r1", "a", "--complete", ref], recover.io)).toBe(
      0,
    );
    expect(recover.io.stdout.text).toMatch(
      /Recorded complete for a\.[\s\S]*Continue with: umio graph resume/,
    );

    const resume = fakeIO(dir);
    expect(await runCli(["graph", "resume", path, "r1", "--json"], resume.io)).toBe(0);
    const result = JSON.parse(resume.io.stdout.text);
    expect(result.status).toBe("completed");
    expect(result.results).toEqual([
      { nodeId: "b", text: expect.stringContaining("file:///tmp/a") },
    ]);
  });

  it("rejects invalid recovery JSON with a quoting hint", async () => {
    const dir = await project();
    const path = await module(dir, chain(`a: async () => 1, b: async () => 2`));
    const { io } = fakeIO(dir);
    expect(await runCli(["graph", "recover", path, "r1", "a", "--complete", "{oops"], io)).toBe(1);
    expect(io.stderr.text).toMatch(/not valid JSON\.\nhint: Quote it for the shell/);
  });

  it("first Ctrl+C cancels the run explicitly; a second exits without finalizing, leaving it inspectable", async () => {
    const dir = await project();
    // b ignores its abort signal, so the cancel waits for the grace period.
    const path = await module(dir, chain(`a: async () => 1, b: () => new Promise(() => {})`));
    const { io, signal, exits } = fakeIO(dir);
    const running = runCli(["graph", "run", path, "--run-id", "r1", "--no-color"], io);
    await new Promise((resolve) => setTimeout(resolve, 200));
    signal("SIGINT");
    expect(io.stderr.text).toMatch(
      /Cancelling the run \(running nodes get a grace period\)… Press Ctrl\+C again to exit without waiting\./,
    );
    signal("SIGINT");
    expect(exits).toEqual([130]);
    expect(io.stderr.text).toMatch(
      /Exited without finalizing run r1\. Inspect it with `umio graph status r1`/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50)); // the cancel request is recorded asynchronously

    // The store says what happened: still running, cancel requested.
    const status = fakeIO(dir);
    await runCli(["graph", "status", "r1", "--json"], status.io);
    expect(JSON.parse(status.io.stdout.text)).toMatchObject({
      status: "running",
      owner: expect.stringMatching(/cancel requested/),
      nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "b", status: "running" })]),
    });
    // (In a real process, exit() ends here; this test lets the grace period finish the cancel.)
    expect(await running).toBe(130);
  }, 20_000);

  it("explains a module that does not export a definition", async () => {
    const dir = await project();
    const path = await module(dir, "export default 42;");
    const { io } = fakeIO(dir);
    expect(await runCli(["graph", "run", path], io)).toBe(1);
    expect(io.stderr.text).toMatch(
      /does not export a workflow definition\.\nhint: Use `export default \{ graph, handlers, predicates \}`/,
    );
  });

  const release = `
    export default {
      graph: {
        id: "release", version: "1", entry: ["plan"],
        nodes: [
          { id: "plan", handler: "plan" },
          { id: "approve", approval: { title: "Deploy to production?", description: "Runs the migration." } },
          { id: "deploy", handler: "deploy" },
        ],
        edges: [{ from: "plan", to: "approve" }, { from: "approve", to: "deploy" }],
      },
      handlers: {
        plan: async () => ({ steps: ["migrate", "restart"] }),
        deploy: async (c) => ({ text: "deployed after " + c.predecessors.approve.decidedBy }),
      },
      predicates: {},
    };`;

  /** run → paused (4) → approvals → approve → a conflicting reject loses → resume → completed. */
  async function approvalFlow(dir: string, extra: string[], deps = {}) {
    const path = await module(dir, release);
    const cli = async (args: string[]) => {
      const { io } = fakeIO(dir);
      const code = await runCli([...args, ...extra, "--no-color"], io, deps);
      return { code, out: io.stdout.text, err: io.stderr.text };
    };
    const run = await cli(["graph", "run", path, "--run-id", "r1"]);
    expect(run.code).toBe(4);
    expect(run.err).toMatch(/‖ approve waiting for approval/);
    expect(run.out).toMatch(/r1 · release@1 · ‖ paused \(waiting for approval\)/);
    expect(run.out).toMatch(/approve +‖ waiting for approval/);
    expect(run.out).toMatch(/umio graph approve r1 approve \[--comment "…"\]/);
    expect(run.out).toMatch(/continue with: umio graph resume .*wf\.mjs r1/);

    const approvals = await cli(["graph", "approvals"]);
    expect(approvals.code).toBe(0);
    expect(approvals.out).toMatch(
      /r1 · release · approve · Deploy to production\?\n {2}Runs the migration\./,
    );
    expect(approvals.out).toMatch(/plan:\n {4}\{\n {4} {2}"steps": \[/);
    const json = await cli(["graph", "approvals", "r1", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject([
      { runId: "r1", nodeId: "approve", context: { plan: { steps: ["migrate", "restart"] } } },
    ]);

    const approve = await cli([
      "graph",
      "approve",
      "r1",
      "approve",
      "--by",
      "ana",
      "--comment",
      "ok",
    ]);
    expect(approve.code).toBe(0);
    expect(approve.out).toMatch(
      /Approval recorded for run r1, approve — not yet applied\.\n {2}The run is paused\. Continue it with/,
    );
    const reject = await cli(["graph", "reject", "r1", "approve", "--by", "bo"]);
    expect(reject.code).toBe(1);
    expect(reject.out).toMatch(/Already decided: approve was approved by ana/);
    const status = await cli(["graph", "status", "r1", "--json"]);
    expect(JSON.parse(status.out)).toMatchObject({
      status: "paused",
      owner: expect.stringMatching(/^paused — waiting for 1 approval/),
      approvals: [{ nodeId: "approve", decision: { approved: true, decidedBy: "ana" } }],
    });

    const resume = await cli(["graph", "resume", path, "r1"]);
    expect(resume.code).toBe(0);
    expect(resume.out).toMatch(/✓ completed[\s\S]*deploy:\ndeployed after ana/);
    const again = await cli(["graph", "approve", "r1", "approve"]);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/Nothing to decide: run r1 is already completed\./);
    const missing = await cli(["graph", "approve", "nope", "x"]);
    expect(missing.out).toMatch(/No run "nope"/);
  }

  it("pauses at an approval, lists it with context, records one decision, and resumes", async () => {
    await approvalFlow(await project(), []);
  });

  it(
    "does the same on PostgreSQL (--store postgres://…), after `graph migrate`",
    async () => {
      const dir = await project();
      const db = await pglite();
      const loadPg = async (): Promise<PgModule> => ({
        Pool: class {
          query = db.query;
          async end() {}
        },
      });
      try {
        const store = ["--store", "postgres://umio:secret@db.example:5432/umio"];
        const before = fakeIO(dir);
        expect(await runCli(["graph", "list", ...store], before.io, { loadPg })).toBe(1);
        expect(before.io.stderr.text).toMatch(/tables do not exist[\s\S]*umio graph migrate/);
        const migrate = fakeIO(dir);
        expect(await runCli(["graph", "migrate", ...store], migrate.io, { loadPg })).toBe(0);
        expect(migrate.io.stdout.text).toMatch(
          /Checkpoint tables are ready in postgres postgres:\/\/umio:\*\*\*@db\.example:5432\/umio/,
        );
        await approvalFlow(dir, store, { loadPg });
      } finally {
        await db.close();
      }
    },
    PGLITE_TIMEOUT_MS,
  );

  it("runs a bounded loop and reports its iterations; body nodes are not results", async () => {
    const dir = await project();
    const path = await module(
      dir,
      `export default {
        graph: {
          id: "loop", version: "1", entry: ["refine"],
          nodes: [{ id: "refine", loop: {
            body: { entry: ["draft"], nodes: [{ id: "draft", handler: "draft" }], edges: [] },
            until: "good", maxIterations: 5 } }],
          edges: [],
        },
        handlers: { draft: async (c) => ({ score: c.loop.iteration }) },
        predicates: { good: (out) => out.draft.score >= 2 },
      };`,
    );
    const { io } = fakeIO(dir);
    expect(await runCli(["graph", "run", path, "--run-id", "l1", "--no-color"], io)).toBe(0);
    expect(io.stderr.text).toMatch(/↻ refine iteration 1[\s\S]*↻ refine iteration 2/);
    expect(io.stdout.text).toMatch(/refine +✓ completed · 2 iterations/);
    expect(io.stdout.text).toMatch(/refine#2\/draft +✓ completed · attempt 1/);
    expect(io.stdout.text).toMatch(/\nrefine:\n\{\n {2}"iterations": 2,/);
    expect(io.stdout.text).not.toMatch(/\nrefine#1\/draft:\n/);
    const status = fakeIO(dir);
    await runCli(["graph", "status", "l1", "--json"], status.io);
    expect(JSON.parse(status.io.stdout.text).nodes[0]).toMatchObject({
      nodeId: "refine",
      iteration: 2,
      loopDecisions: [false, true],
    });
  });

  it("migrate needs nothing for the file store", async () => {
    const dir = await project();
    const { io } = fakeIO(dir);
    expect(await runCli(["graph", "migrate"], io)).toBe(0);
    expect(io.stdout.text).toMatch(/The file store needs no setup/);
  });

  it(
    "never prints PostgreSQL passwords (fix 2026-09-27 #2), yet connects with the original string",
    async () => {
      const secret = "REVIEW_FAKE_SECRET";
      const dir = await project(
        baseConfig({
          graph: { checkpoint: { type: "postgres", connectionString: "${DATABASE_URL}" } },
        }),
      );
      const env = {
        DATABASE_URL: `postgres://review:${secret}@localhost/review?password=${secret}`,
      };
      const connected: string[] = [];
      const db = await pglite();
      const loadPg = async (): Promise<PgModule> => ({
        Pool: class {
          constructor(options: { connectionString: string }) {
            connected.push(options.connectionString);
          }
          query = db.query;
          async end() {}
        },
      });
      try {
        const outputs: string[] = [];
        for (const args of [
          ["config", "--json"],
          ["config"],
          ["graph", "migrate"],
          ["graph", "migrate", "--json"],
          ["graph", "list"],
          ["graph", "approvals"],
          ["graph", "status", "missing"],
          ["graph", "list", "--store", `postgres://review@localhost/review?Password=${secret}`],
        ]) {
          const { io } = fakeIO(dir, { env });
          await runCli([...args, "--no-color"], io, { loadPg });
          outputs.push(io.stdout.text + io.stderr.text);
        }
        for (const output of outputs) expect(output).not.toContain(secret);
        expect(JSON.parse(outputs[0] as string).config.graph.checkpoint.connectionString).toBe(
          "postgres://review:***@localhost/review?password=***",
        );
        expect(outputs[1]).toMatch(/runs: postgres postgres:\/\/review:\*\*\*@localhost\/review/);
        expect(outputs[2]).toMatch(
          /Checkpoint tables are ready in postgres postgres:\/\/review:\*\*\*@/,
        );
        // The driver still received the real credentials.
        expect(connected).toContain(env.DATABASE_URL);
        expect(connected).toContain(`postgres://review@localhost/review?Password=${secret}`);
      } finally {
        await db.close();
      }
    },
    PGLITE_TIMEOUT_MS,
  );

  it("keeps masking provider keys and other secret-named values", async () => {
    const dir = await project(
      baseConfig({
        providers: {
          ollama: { type: "ollama", baseURL: "http://127.0.0.1:9/v1" },
          anthropic: { type: "anthropic", apiKey: "sk-literal-secret" },
          proxy: { type: "openai-compatible", baseURL: "https://u:proxy-secret@proxy.example/v1" },
        },
      }),
    );
    for (const args of [["config", "--json"], ["config"]]) {
      const { io } = fakeIO(dir);
      await runCli([...args, "--no-color"], io);
      expect(io.stdout.text).not.toMatch(/sk-literal-secret|proxy-secret/);
    }
  });

  it(
    "lists old approvals and recovery runs behind 1 000 newer runs on PostgreSQL (fix 2026-09-27 #3)",
    async () => {
      const dir = await project();
      const db = await pglite();
      const loadPg = async (): Promise<PgModule> => ({
        Pool: class {
          query = db.query;
          async end() {}
        },
      });
      const store = ["--store", "postgres://umio@localhost/umio"];
      const cli = async (args: string[]) => {
        const { io } = fakeIO(dir);
        const code = await runCli([...args, ...store, "--no-color"], io, { loadPg });
        return { code, out: io.stdout.text };
      };
      try {
        expect((await cli(["graph", "migrate"])).code).toBe(0);
        const base = {
          schemaVersion: 2,
          workflowId: "wf",
          definitionVersion: "1",
          definitionHash: "h",
          input: null,
          edges: {},
          revision: 0,
          createdAt: 1,
        };
        const gate = (runId: string) => ({
          gate: {
            nodeId: "gate",
            status: "waiting",
            attempt: 0,
            approval: {
              requestId: `q-${runId}`,
              requestedAt: 1,
              title: "Go?",
              context: [],
              onReject: "fail",
            },
          },
        });
        const insert = (record: Record<string, unknown>) =>
          db.query(
            `INSERT INTO umio_runs (run_id, instance, record, schema_version, workflow_id, status, revision,
                                  created_at, updated_at)
           VALUES ($1, 'i', $2::json, 2, 'wf', $3, 0, 1, $4)`,
            [record.runId, JSON.stringify(record), record.status, record.updatedAt],
          );
        await insert({
          ...base,
          runId: "old-paused",
          status: "paused",
          updatedAt: 2,
          nodes: gate("old-paused"),
        });
        await insert({
          ...base,
          runId: "old-running",
          status: "running",
          updatedAt: 3,
          nodes: gate("old-running"),
        });
        await insert({
          ...base,
          runId: "old-recovery",
          status: "needs-recovery",
          updatedAt: 4,
          nodes: {
            ...gate("old-recovery"),
            work: {
              nodeId: "work",
              status: "uncertain",
              attempt: 1,
              uncertainReason: "process-lost",
            },
          },
        });
        await db.query(
          `INSERT INTO umio_runs (run_id, instance, record, schema_version, workflow_id, status, revision,
                                created_at, updated_at)
         SELECT 'done-' || i, 'i', json_build_object('schemaVersion', 1, 'runId', 'done-' || i,
                  'workflowId', 'wf', 'definitionVersion', '1', 'definitionHash', 'h',
                  'status', 'completed', 'input', null, 'nodes', '{}'::json, 'edges', '{}'::json,
                  'revision', 0, 'createdAt', 0, 'updatedAt', 1000 + i),
                1, 'wf', 'completed', 0, 0, 1000 + i
         FROM generate_series(1, 1000) AS i`,
        );

        const approvals = await cli(["graph", "approvals", "--json"]);
        expect(approvals.code).toBe(0);
        expect(JSON.parse(approvals.out).map((item: { runId: string }) => item.runId)).toEqual([
          "old-recovery",
          "old-running",
          "old-paused",
        ]);
        const recovery = await cli(["graph", "list", "--needs-recovery", "--json"]);
        expect(JSON.parse(recovery.out).map((item: { runId: string }) => item.runId)).toEqual([
          "old-recovery",
        ]);
        const all = await cli(["graph", "list", "--json"]);
        expect(JSON.parse(all.out)).toHaveLength(1_003);
        const direct = await cli(["graph", "approvals", "old-paused", "--json"]);
        expect(JSON.parse(direct.out)).toMatchObject([{ runId: "old-paused", nodeId: "gate" }]);
      } finally {
        await db.close();
      }
    },
    PGLITE_TIMEOUT_MS,
  );

  it("filters the file store the same way", async () => {
    const dir = await project();
    const path = await module(dir, release);
    await runCli(["graph", "run", path, "--run-id", "p1"], fakeIO(dir).io);
    await runCli(["graph", "run", path, "--run-id", "p2"], fakeIO(dir).io);
    await runCli(["graph", "cancel", "p2"], fakeIO(dir).io);
    const approvals = fakeIO(dir);
    await runCli(["graph", "approvals", "--json"], approvals.io);
    expect(
      JSON.parse(approvals.io.stdout.text).map((item: { runId: string }) => item.runId),
    ).toEqual(["p1"]);
    const recovery = fakeIO(dir);
    await runCli(["graph", "list", "--needs-recovery", "--json"], recovery.io);
    expect(JSON.parse(recovery.io.stdout.text)).toEqual([]);
  });
});

describe("skills", () => {
  async function skillProject(skills: object = {}) {
    const dir = await project(
      baseConfig({
        skills: { roots: ["skills"], include: ["code-review", "test-design"], ...skills },
      }),
    );
    const put = async (path: string, content: string) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    };
    await put(
      "skills/code-review/SKILL.md",
      "---\nname: code-review\ndescription: Review changes for missing tests.\n---\n\nREVIEW-BODY\n",
    );
    await put("skills/code-review/references/checklist.md", "CHECKLIST");
    await put(
      "skills/test-design/SKILL.md",
      "---\nname: test-design\ndescription: Design tests.\n---\n\nTEST-BODY\n",
    );
    await put(
      "skills/secret-ops/SKILL.md",
      "---\nname: secret-ops\ndescription: Not permitted.\n---\n\nSECRET-BODY\n",
    );
    return dir;
  }
  const systemOf = (request: GenerateRequest | undefined) =>
    typeof request?.system === "string"
      ? request.system
      : (request?.system ?? []).map((part) => part.text).join("\n");

  it("lists permitted skills with activation, and shows one; unpermitted skills stay hidden", async () => {
    const dir = await skillProject({ activate: ["code-review"] });
    const list = fakeIO(dir);
    expect(await runCli(["skills", "--no-color"], list.io)).toBe(0);
    expect(list.io.stdout.text).toMatch(/Skills · model selection off · 2 permitted of 3 found/);
    expect(list.io.stdout.text).toMatch(
      /code-review {2}active {2}Review changes for missing tests\. sha256:[0-9a-f]{12}/,
    );
    expect(list.io.stdout.text).toMatch(/test-design {10}Design tests\./);
    expect(list.io.stdout.text).not.toMatch(/secret-ops/);
    const json = fakeIO(dir);
    await runCli(["skills", "list", "--json"], json.io);
    expect(JSON.parse(json.io.stdout.text)).toMatchObject({
      configured: true,
      include: ["code-review", "test-design"],
      activate: ["code-review"],
      skills: [
        { name: "code-review", active: true, digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { name: "test-design", active: false },
      ],
      diagnostics: [],
    });
    const show = fakeIO(dir);
    expect(await runCli(["skills", "show", "code-review", "--no-color"], show.io)).toBe(0);
    expect(show.io.stdout.text).toMatch(
      /^code-review sha256:[0-9a-f]{64}\nReview changes for missing tests\.\n\nREVIEW-BODY\n$/,
    );
    const hidden = fakeIO(dir);
    expect(await runCli(["skills", "show", "secret-ops"], hidden.io)).toBe(1);
    expect(hidden.io.stderr.text).toMatch(/not permitted by skills\.include/);
    expect(hidden.io.stdout.text).not.toMatch(/SECRET-BODY/);
  });

  it("reports invalid packages and missing permitted skills with exit 1; no section is not an error", async () => {
    const dir = await skillProject({ include: ["code-review", "absent"] });
    await writeFile(join(dir, "skills/test-design/SKILL.md"), "no frontmatter");
    const { io } = fakeIO(dir);
    expect(await runCli(["skills", "--no-color"], io)).toBe(1);
    expect(io.stdout.text).toMatch(/absent +not found in skills/);
    expect(io.stdout.text).toMatch(/✗ .*test-design\/SKILL\.md: must start with YAML frontmatter/);
    const plain = fakeIO(await project());
    expect(await runCli(["skills"], plain.io)).toBe(0);
    expect(plain.io.stdout.text).toMatch(/No skills configured\./);
  });

  it("ask applies the configured activation; --skill replaces it; --no-skills removes skills", async () => {
    const dir = await skillProject({ activate: ["code-review"] });
    const run = async (args: string[]) => {
      const { model, requests } = scripted([reply("ok")]);
      const { io } = fakeIO(dir);
      const code = await runCli(["ask", ...args, "hi"], io, { createModel: () => model });
      return { code, request: requests[0], io };
    };
    const configured = await run([]);
    expect(configured.code).toBe(0);
    expect(systemOf(configured.request)).toMatch(/REVIEW-BODY/);
    expect(configured.request?.tools?.map((tool) => tool.name)).toContain("skills_read");
    const replaced = await run(["--skill", "test-design"]);
    expect(systemOf(replaced.request)).toMatch(/TEST-BODY/);
    expect(systemOf(replaced.request)).not.toMatch(/REVIEW-BODY/);
    const both = await run(["--skill", "test-design", "--skill", "code-review"]);
    expect(systemOf(both.request)).toMatch(/REVIEW-BODY[\s\S]*TEST-BODY/);
    const off = await run(["--no-skills"]);
    expect(systemOf(off.request)).not.toMatch(/Skills|BODY/);
    expect(off.request?.tools?.map((tool) => tool.name)).not.toContain("skills_read");
  });

  it("a flag never expands include, and --skill with --no-skills is a usage error", async () => {
    const dir = await skillProject();
    const outside = fakeIO(dir);
    expect(await runCli(["ask", "--skill", "secret-ops", "hi"], outside.io)).toBe(2);
    expect(outside.io.stderr.text).toMatch(
      /--skill secret-ops: not permitted by skills\.include in the config\.\nhint: Permitted: code-review, test-design\./,
    );
    const both = fakeIO(dir);
    expect(await runCli(["ask", "--skill", "code-review", "--no-skills", "hi"], both.io)).toBe(2);
    expect(both.io.stderr.text).toMatch(/Use either --skill or --no-skills, not both\./);
    const unconfigured = fakeIO(await project());
    expect(await runCli(["ask", "--skill", "code-review", "hi"], unconfigured.io)).toBe(2);
    expect(unconfigured.io.stderr.text).toMatch(/--skill needs a skills section/);
  });

  it("with model selection, the model loads and reads a skill without a confirmation (read-only tools)", async () => {
    const dir = await skillProject({ allowModelSelection: true });
    const { model, requests } = scripted([
      reply("", [
        { type: "tool-call", id: "l", name: "skills_load", input: { name: "code-review" } },
      ]),
      reply("", [
        {
          type: "tool-call",
          id: "r",
          name: "skills_read",
          input: { name: "code-review", path: "references/checklist.md" },
        },
      ]),
      reply("Reviewed."),
    ]);
    const { io } = fakeIO(dir);
    // Not interactive and no --yes: tools that may change things would be declined.
    expect(await runCli(["ask", "--no-color", "review"], io, { createModel: () => model })).toBe(0);
    expect(io.stdout.text).toBe("Reviewed.\n");
    expect(io.stderr.text).toMatch(/✓ skills_load[\s\S]*✓ skills_read/);
    expect(systemOf(requests[0])).toMatch(/- code-review: Review changes for missing tests\./);
    expect(systemOf(requests[0])).not.toMatch(/REVIEW-BODY|secret-ops/);
    const last = JSON.stringify(requests[2]?.messages);
    expect(last).toMatch(/REVIEW-BODY/);
    expect(last).toMatch(/CHECKLIST/);
  });
});
