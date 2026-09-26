/**
 * Cross-process cancellation with real processes: one `umio graph run` owns
 * the file store and drives a silent, long-running node; `umio graph cancel`
 * runs in a second process. The CLI runs from source through tsx.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileCheckpointStore } from "../src/index.js";

const MAIN = resolve(__dirname, "../src/cli/main.ts");
// Absolute, because the processes run in a temp directory without node_modules.
const TSX = pathToFileURL(resolve(__dirname, "../node_modules/tsx/dist/loader.mjs")).href;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Running {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exit: Promise<number>;
}

function umio(cwd: string, args: string[]): Running {
  const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args, "--no-color"], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    err += chunk;
  });
  const exit = new Promise<number>((done) =>
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1))),
  );
  return { child, stdout: () => out, stderr: () => err, exit };
}

async function until(
  check: () => boolean,
  what: string,
  timeoutMs = 20_000,
  context?: Running,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}${context ? `\n${context.stderr()}` : ""}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** A project whose workflow has one node that stays silent until aborted (a long local call). */
async function project(graph: object = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umio-xproc-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "umio.config.json"),
    JSON.stringify({
      defaultModel: "local",
      providers: { ollama: { type: "ollama" } },
      models: { local: { provider: "ollama", model: "tiny" } },
      graph,
    }),
  );
  await writeFile(
    join(dir, "wf.mjs"),
    `export default {
      graph: { id: "wf", version: "1", entry: ["slow"], nodes: [{ id: "slow", handler: "slow" }], edges: [] },
      handlers: {
        slow: (context) => new Promise((_, reject) =>
          context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      },
      predicates: {},
    };`,
  );
  return dir;
}

describe("umio graph cancel from another process", () => {
  it("records the request, the owner stops through its executor, and the run is persisted cancelled", async () => {
    const dir = await project();
    const owner = umio(dir, ["graph", "run", "wf.mjs", "--run-id", "r1"]);
    await until(() => owner.stderr().includes("slow started"), "the node to start", 20_000, owner);

    // A plain cancel returns once the request is recorded, and says it is not yet confirmed.
    const cancel = umio(dir, ["graph", "cancel", "r1"]);
    expect(await cancel.exit).toBe(0);
    expect(cancel.stdout()).toMatch(/Cancel request recorded for run r1 — not yet confirmed\./);
    expect(cancel.stdout()).toMatch(/The umio process driving it checks every ~2 s/);

    // A second request is idempotent (or finds the run already finished).
    const again = umio(dir, ["graph", "cancel", "r1", "--json"]);
    expect(await again.exit).toBe(0);
    expect(JSON.parse(again.stdout()).outcome).toMatch(/^(already-requested|already-terminal)$/);

    expect(await owner.exit).toBe(130);
    expect(owner.stderr()).toMatch(/cancel requested — stopping running nodes/);
    // The status symbol depends on the terminal ("–", or "-" with TERM=dumb), so it is not asserted.
    const summary = owner
      .stdout()
      .split("\n")
      .find((line) => line.startsWith("r1 "));
    expect(summary).toContain("wf@1");
    expect(summary).toMatch(/\bcancelled$/);

    const persisted = await FileCheckpointStore.snapshot(join(dir, ".umio", "runs"), "r1");
    expect(persisted?.record.status).toBe("cancelled");
    expect(persisted?.record.nodes.slow?.status).toBe("cancelled");
    expect(persisted?.lease).toBeUndefined();
    expect(await readdir(join(dir, ".umio", "runs", "control"))).toEqual([]);

    const status = umio(dir, ["graph", "status", "r1", "--json"]);
    await status.exit;
    expect(JSON.parse(status.stdout())).toMatchObject({
      status: "cancelled",
      cancelRequest: "none",
    });
  }, 60_000);

  it("--wait confirms the cancel, and status shows the request while it is pending", async () => {
    // A slow poll keeps the request pending long enough to observe it.
    const dir = await project({ cancelPollIntervalMs: 4_000 });
    const owner = umio(dir, ["graph", "run", "wf.mjs", "--run-id", "r2"]);
    await until(() => owner.stderr().includes("slow started"), "the node to start", 20_000, owner);

    const waiting = umio(dir, ["graph", "cancel", "r2", "--wait", "--json"]);
    const store = join(dir, ".umio", "runs");
    let pending: Awaited<ReturnType<typeof FileCheckpointStore.snapshot>>;
    for (;;) {
      pending = await FileCheckpointStore.snapshot(store, "r2");
      if (pending?.pendingCancelRequest || pending?.cancelRequested) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    // With a 4 s poll, the owner has usually not picked it up yet.
    if (pending?.pendingCancelRequest) {
      const status = umio(dir, ["graph", "status", "r2"]);
      await status.exit;
      expect(status.stdout()).toMatch(
        /cancel requested \d+s ago by pid \d+, not yet picked up by the owner|cancel requested \(recorded in the run/,
      );
    }

    expect(await waiting.exit).toBe(0);
    expect(JSON.parse(waiting.stdout())).toMatchObject({
      runId: "r2",
      outcome: "recorded",
      via: "control-file",
      ownerActive: true,
      waited: "ended",
      confirmed: "cancelled",
    });
    expect(await owner.exit).toBe(130);
  }, 60_000);

  it("finishes the cancel itself when the owner crashes before applying the request", async () => {
    // Short lease so the dead owner's lease expires quickly; slow poll so it never picks the request up.
    const dir = await project({
      leaseTtlMs: 3_000,
      leaseRenewIntervalMs: 1_000,
      cancelPollIntervalMs: 2_500,
      cancelGraceMs: 1_000,
    });
    const owner = umio(dir, ["graph", "run", "wf.mjs", "--run-id", "r3"]);
    await until(() => owner.stderr().includes("slow started"), "the node to start", 20_000, owner);

    const store = join(dir, ".umio", "runs");
    // Deterministic: the request is written by the library call a CLI would make…
    await expect(FileCheckpointStore.submitCancelRequest(store, "r3")).resolves.toMatchObject({
      outcome: "recorded",
    });
    owner.child.kill("SIGKILL"); // …and the owner dies before its next poll.
    await owner.exit;

    const cancel = umio(dir, ["graph", "cancel", "r3", "--wait", "--timeout", "20s"]);
    expect(await cancel.exit).toBe(0);
    expect(cancel.stdout()).toMatch(/Confirmed: run r3 is cancelled\./);
    const persisted = await FileCheckpointStore.snapshot(store, "r3");
    expect(persisted?.record.status).toBe("cancelled");
    // Its attempt was running when the owner died: its effects are unknown.
    expect(persisted?.record.nodes.slow).toMatchObject({
      status: "uncertain",
      uncertainReason: "process-lost",
    });
  }, 60_000);

  it("resume and recover report the lock instead of waiting", async () => {
    const dir = await project();
    const owner = umio(dir, ["graph", "run", "wf.mjs", "--run-id", "r4"]);
    await until(() => owner.stderr().includes("slow started"), "the node to start", 20_000, owner);
    const resume = umio(dir, ["graph", "resume", "wf.mjs", "r4"]);
    expect(await resume.exit).toBe(1);
    expect(resume.stderr()).toMatch(/is in use by process \d+|locked|held by/i);
    expect(resume.stderr()).toMatch(
      /hint: The file checkpoint store has one writer at a time[\s\S]*umio graph cancel <run-id>/,
    );
    owner.child.kill("SIGINT"); // the owner's own Ctrl+C still cancels
    expect(await owner.exit).toBe(130);
  }, 60_000);
});
