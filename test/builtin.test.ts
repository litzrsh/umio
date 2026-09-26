import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertReadOnly,
  ConfigError,
  commandTool,
  createToolsets,
  defaultToolRegistry,
  evaluate,
  executeToolCall,
  fileTools,
  htmlToText,
  isInternalAddress,
  shellTools,
  sqlTools,
  type Tool,
  Toolset,
  utilityTools,
  webTools,
} from "../src/index.js";

function runner(tools: Tool[] | Toolset) {
  const set = tools instanceof Toolset ? tools : new Toolset(tools);
  return async (name: string, input: unknown) =>
    (await executeToolCall({ type: "tool-call", id: "c", name, input }, set, { messages: [] }))
      .result;
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "umio-files-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/app.ts"), "const a = 1;\nconst b = 2;\nexport { a, b };\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "node_modules/pkg/index.js"), "const a = 1;\n");
  return root;
}

describe("fileTools", () => {
  it("reads numbered line ranges, lists and searches", async () => {
    const root = await project();
    const call = runner(fileTools({ root }));

    expect((await call("read_file", { path: "src/app.ts", offset: 2, limit: 1 })).content).toBe(
      "2\tconst b = 2;",
    );
    expect((await call("list_directory", { recursive: true })).content).toBe(
      "node_modules/\nsrc/\nsrc/app.ts",
    );
    expect((await call("search_files", { pattern: "const a" })).content).toBe(
      "src/app.ts:1: const a = 1;",
    );
  });

  it("refuses paths outside the root, via .. or symlinks, and denied names", async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), "umio-outside-"));
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(outside, join(root, "link"));
    const call = runner(fileTools({ root }));

    for (const path of ["../x", "/etc/passwd", "link/secret.txt", ".env", "src/../.env"]) {
      const result = await call("read_file", { path });
      expect(result.isError, path).toBe(true);
    }
    expect((await call("write_file", { path: "link/new.txt", content: "x" })).isError).toBe(true);
  });

  it("edits only unique exact matches and writes new files", async () => {
    const root = await project();
    const call = runner(fileTools({ root }));

    expect(
      (await call("edit_file", { path: "src/app.ts", oldText: "const", newText: "let" })).content,
    ).toMatch(/matches 2 times/);
    await call("edit_file", {
      path: "src/app.ts",
      oldText: "const b = 2;",
      newText: "const b = 3;",
    });
    expect(await readFile(join(root, "src/app.ts"), "utf8")).toContain("const b = 3;");

    await call("write_file", { path: "docs/new.md", content: "# New" });
    expect(await readFile(join(root, "docs/new.md"), "utf8")).toBe("# New");
  });

  it("omits write tools when read-only", async () => {
    const names = new Toolset(fileTools({ root: ".", readOnly: true })).names;
    expect(names).toEqual(["read_file", "list_directory", "search_files"]);
  });
});

describe("webTools", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/page" });
        res.end();
      } else if (req.url === "/binary") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end("x");
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<html><head><title>t</title><script>evil()</script></head><body><h1>Hello &amp; welcome</h1><p>See <a href="/docs">docs</a></p></body></html>',
        );
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("blocks internal addresses by default", async () => {
    const call = runner(webTools());
    const result = await call("fetch_url", { url: `${base}/page` });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/internal address/);
  });

  it("fetches, follows redirects and converts HTML when private networks are allowed", async () => {
    const call = runner(webTools({ allowPrivateNetwork: true }));
    const result = await call("fetch_url", { url: `${base}/redirect` });
    expect(result.content).toBe(
      `URL: ${base}/page\nStatus: 200\n\nHello & welcome\nSee docs (/docs)`,
    );
    expect((await call("fetch_url", { url: `${base}/binary` })).content).toMatch(
      /Unsupported content type/,
    );
  });

  it("enforces allowed domains and schemes", async () => {
    const call = runner(webTools({ allowedDomains: ["example.com"] }));
    expect((await call("fetch_url", { url: "https://evil.test/" })).content).toMatch(
      /not in the allowed domains/,
    );
    expect((await call("fetch_url", { url: "file:///etc/passwd" })).isError).toBe(true);
  });

  it("classifies internal addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ]) {
      expect(isInternalAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1"]) {
      expect(isInternalAddress(address), address).toBe(false);
    }
  });

  it("strips scripts and decodes entities", () => {
    expect(
      htmlToText("<style>x{}</style><p>a&lt;b&#33;</p><ul><li>one</li><li>two</li></ul>"),
    ).toBe("a<b!\n- one\n- two");
  });
});

describe("shell and command tools", () => {
  it("runs allowlisted programs without a shell", async () => {
    const call = runner(shellTools({ allow: ["node"] }));
    const result = await call("run_command", {
      command: "node",
      args: ["-e", "console.log(process.argv[1])", "a; rm -rf / | $(x)"],
    });
    expect(result.content).toBe("Exit code: 0\n\nstdout:\na; rm -rf / | $(x)");

    const denied = await call("run_command", { command: "rm", args: ["-rf", "/"] });
    expect(denied).toMatchObject({ isError: true, content: expect.stringMatching(/not allowed/) });
  });

  it("reports exit codes, stderr and timeouts", async () => {
    const call = runner(shellTools({ allow: ["node"], timeoutMs: 300 }));
    expect(
      (
        await call("run_command", {
          command: "node",
          args: ["-e", "console.error('bad'); process.exit(3)"],
        })
      ).content,
    ).toBe("Exit code: 3\n\nstderr:\nbad");
    expect(
      (await call("run_command", { command: "node", args: ["-e", "setTimeout(() => {}, 5000)"] }))
        .content,
    ).toBe("Timed out.");
  });

  it("requires a non-empty allowlist", () => {
    expect(() => shellTools({ allow: [] })).toThrow(/allow/);
  });

  it("commandTool fixes the program and builds arguments from input", async () => {
    const echo = commandTool({
      name: "echo_upper",
      description: "",
      command: "node",
      parameters: z.object({ text: z.string() }),
      args: ({ text }) => ["-e", "console.log(process.argv[1].toUpperCase())", text],
    });
    expect((await runner([echo])("echo_upper", { text: "hi" })).content).toBe(
      "Exit code: 0\n\nstdout:\nHI",
    );
  });
});

describe("sqlTools", () => {
  it("runs read queries through the given driver and caps rows", async () => {
    const seen: unknown[] = [];
    const call = runner(
      sqlTools({
        dialect: "PostgreSQL",
        maxRows: 2,
        execute: async (sql, params) => {
          seen.push([sql, params]);
          return [{ id: 1n }, { id: 2 }, { id: 3 }];
        },
        describe: async () => "users(id int)",
      }),
    );

    const result = await call("sql_query", {
      sql: "SELECT id FROM users WHERE id > $1",
      params: [0],
    });
    expect(result.content).toBe(
      '3 row(s)\n[\n {\n  "id": "1"\n },\n {\n  "id": 2\n }\n]\n[1 more rows not shown; add LIMIT or filters]',
    );
    expect(seen).toEqual([["SELECT id FROM users WHERE id > $1", [0]]]);
    expect((await call("describe_schema", {})).content).toBe("users(id int)");
    expect((await call("sql_query", { sql: "DELETE FROM users" })).isError).toBe(true);
  });

  it("guards read-only mode", () => {
    for (const ok of [
      "SELECT 1",
      "  with x as (select 1) select * from x;",
      "SELECT 'drop table x' -- update",
      "EXPLAIN SELECT 1",
    ]) {
      expect(() => assertReadOnly(ok), ok).not.toThrow();
    }
    for (const bad of [
      "DROP TABLE x",
      "SELECT 1; DROP TABLE x",
      "WITH d AS (DELETE FROM x RETURNING *) SELECT * FROM d",
      "update x set a=1",
    ]) {
      expect(() => assertReadOnly(bad), bad).toThrow();
    }
  });
});

describe("utilityTools", () => {
  it("evaluates arithmetic safely", async () => {
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("max(1, 2 + 3) * (4 - 1) / 3")).toBe(5);
    expect(() => evaluate("process.exit()")).toThrow();
    expect(() => evaluate("1/0")).toThrow(/finite/);
    const call = runner(utilityTools());
    expect((await call("calculate", { expression: "sqrt(2)^2" })).content).toMatch(/^2(\.0+\d*)?$/);
    expect((await call("current_time", { timeZone: "Asia/Seoul" })).content).toMatch(/ISO \(UTC\)/);
    expect((await call("current_time", { timeZone: "Mars/Base" })).isError).toBe(true);
  });
});

describe("ToolRegistry and config toolsets", () => {
  it("creates named toolsets from config, resolving paths against the config directory", async () => {
    const root = await project();
    const toolsets = createToolsets({
      configDir: root,
      tools: {
        code: { use: "files", root: "src", readOnly: true },
        misc: { use: "utilities" },
        cli: { use: "shell", allow: ["node"] },
      },
    });
    expect(toolsets.code?.names).toEqual(["read_file", "list_directory", "search_files"]);
    expect(
      (await runner(toolsets.code as Toolset)("read_file", { path: "app.ts", limit: 1 })).content,
    ).toBe("1\tconst a = 1;");
    expect(
      (
        await runner(toolsets.cli as Toolset)("run_command", {
          command: "node",
          args: ["-e", "console.log(process.cwd())"],
        })
      ).content,
    ).toContain(root);
  });

  it("reports unknown groups and invalid options with the toolset name", () => {
    expect(() => createToolsets({ tools: { x: { use: "nope" } } })).toThrow(
      /tools\.x: Unknown tool group "nope"/,
    );
    expect(() => createToolsets({ tools: { x: { use: "shell", allow: [] } } })).toThrow(
      ConfigError,
    );
    expect(() => createToolsets({ tools: { x: { use: "files", root: ".", typo: 1 } } })).toThrow(
      /typo/,
    );
  });

  it("accepts custom groups", () => {
    const registry = defaultToolRegistry().register({
      name: "clock",
      description: "",
      options: z.object({}),
      create: () => utilityTools().slice(0, 1),
    });
    expect(createToolsets({ tools: { t: { use: "clock" } } }, registry).t?.names).toEqual([
      "current_time",
    ]);
    expect(registry.list().map((g) => g.name)).toEqual([
      "files",
      "web",
      "shell",
      "utilities",
      "clock",
    ]);
  });
});
