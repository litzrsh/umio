/**
 * The CLI end to end through `runCli` with fake streams, a scripted model and
 * real temp directories (config, workflow modules, checkpoint store).
 */
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIO, runCli } from "../src/cli/app.js";
import type {
  GenerateRequest,
  GenerateResult,
  ModelClient,
  StreamEvent,
  ToolCallPart,
} from "../src/index.js";

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
});
