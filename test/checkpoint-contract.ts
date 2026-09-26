/**
 * The shared `CheckpointStore` contract (plan D2). Every store, including
 * third-party adapters, must pass it:
 *
 *   checkpointStoreContract("MyStore", (now) => new MyStore({ now }));
 *
 * `now` is the store's clock; the suite moves it to expire leases.
 */
import { describe, expect, it } from "vitest";
import {
  CheckpointConflictError,
  CheckpointSchemaError,
  type CheckpointStore,
  RunNotFoundError,
  type WorkflowRun,
} from "../src/index.js";

export function checkpointStoreContract(
  name: string,
  createStore: (now: () => number) => CheckpointStore | Promise<CheckpointStore>,
): void {
  describe(`CheckpointStore contract: ${name}`, () => {
    const TTL = 30_000;

    const setup = async () => {
      const clock = { time: 1_000 };
      const store = await createStore(() => clock.time);
      return { store, clock };
    };

    const record = (runId = "run-1", revision = 0): WorkflowRun => ({
      schemaVersion: 1,
      runId,
      workflowId: "wf",
      definitionVersion: "1",
      definitionHash: "hash",
      status: "running",
      input: { task: "x" },
      nodes: { a: { nodeId: "a", status: "pending", attempt: 0 } },
      edges: {},
      revision,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const revised = (run: WorkflowRun, changes: Partial<WorkflowRun> = {}): WorkflowRun => ({
      ...run,
      ...changes,
      revision: run.revision + 1,
    });

    describe("create and load", () => {
      it("stores the record and issues the first lease", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        expect(lease).toMatchObject({ runId: "run-1", ownerId: "owner-a", expiresAt: 1_000 + TTL });
        expect(lease.token).toBeGreaterThan(0);
        await expect(store.load("run-1")).resolves.toEqual(record());
      });

      it("rejects an existing run ID without touching it", async () => {
        const { store } = await setup();
        await store.create(record(), "owner-a", TTL);
        await expect(
          store.create({ ...record(), input: "other" }, "owner-b", TTL),
        ).rejects.toBeInstanceOf(CheckpointConflictError);
        await expect(store.load("run-1")).resolves.toEqual(record());
      });

      it("rejects an unknown schema version", async () => {
        const { store } = await setup();
        const bad = { ...record(), schemaVersion: 2 } as unknown as WorkflowRun;
        await expect(store.create(bad, "owner-a", TTL)).rejects.toBeInstanceOf(
          CheckpointSchemaError,
        );
      });

      it("returns undefined for a missing run", async () => {
        const { store } = await setup();
        await expect(store.load("missing")).resolves.toBeUndefined();
      });

      it("copies records in and out", async () => {
        const { store } = await setup();
        const run = record();
        await store.create(run, "owner-a", TTL);
        (run.nodes as Record<string, unknown>).a = "mutated";
        const loaded = await store.load("run-1");
        (loaded?.nodes as Record<string, unknown>).a = "mutated";
        await expect(store.load("run-1")).resolves.toEqual(record());
      });
    });

    describe("compareAndSwap", () => {
      it("writes with the current lease and expected revision", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        const next = revised(record(), { status: "completed" });
        await expect(store.compareAndSwap(next, 0, lease)).resolves.toBe("ok");
        await expect(store.load("run-1")).resolves.toEqual(next);
      });

      it("reports a revision conflict and keeps the stored record", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        const first = revised(record());
        await store.compareAndSwap(first, 0, lease);
        await expect(store.compareAndSwap(revised(record()), 0, lease)).resolves.toBe(
          "revision-conflict",
        );
        await expect(store.load("run-1")).resolves.toEqual(first);
      });

      it("fences off an expired lease even without a takeover", async () => {
        const { store, clock } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        clock.time += TTL;
        await expect(store.compareAndSwap(revised(record()), 0, lease)).resolves.toBe("lease-lost");
        await expect(store.load("run-1")).resolves.toEqual(record());
      });

      it("fences off a superseded token", async () => {
        const { store, clock } = await setup();
        const old = await store.create(record(), "owner-a", TTL);
        clock.time += TTL;
        const current = await store.acquireLease("run-1", "owner-b", TTL);
        expect(current).toBeDefined();
        await expect(store.compareAndSwap(revised(record()), 0, old)).resolves.toBe("lease-lost");
        // Even if the old owner re-reads the revision, its token is stale.
        await expect(store.compareAndSwap(revised(record()), 0, { ...old })).resolves.toBe(
          "lease-lost",
        );
        if (current) {
          await expect(store.compareAndSwap(revised(record()), 0, current)).resolves.toBe("ok");
        }
      });

      it("fences off a released lease and a forged owner", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        await expect(
          store.compareAndSwap(revised(record()), 0, { ...lease, ownerId: "owner-b" }),
        ).resolves.toBe("lease-lost");
        await store.releaseLease(lease);
        await expect(store.compareAndSwap(revised(record()), 0, lease)).resolves.toBe("lease-lost");
      });

      it("checks the lease before the revision", async () => {
        const { store, clock } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        clock.time += TTL;
        await expect(store.compareAndSwap(revised(record()), 5, lease)).resolves.toBe("lease-lost");
      });

      it("rejects a missing run", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        await expect(
          store.compareAndSwap(revised(record("other")), 0, { ...lease, runId: "other" }),
        ).rejects.toBeInstanceOf(RunNotFoundError);
      });

      it("rejects an unknown schema version", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        const bad = { ...revised(record()), schemaVersion: 2 } as unknown as WorkflowRun;
        await expect(store.compareAndSwap(bad, 0, lease)).rejects.toBeInstanceOf(
          CheckpointSchemaError,
        );
      });
    });

    describe("leases", () => {
      it("refuses acquisition while a lease is held, by anyone", async () => {
        const { store, clock } = await setup();
        await store.create(record(), "owner-a", TTL);
        await expect(store.acquireLease("run-1", "owner-b", TTL)).resolves.toBeUndefined();
        await expect(store.acquireLease("run-1", "owner-a", TTL)).resolves.toBeUndefined();
        clock.time += TTL - 1;
        await expect(store.acquireLease("run-1", "owner-b", TTL)).resolves.toBeUndefined();
      });

      it("issues a strictly higher token on every takeover", async () => {
        const { store, clock } = await setup();
        let lease = await store.create(record(), "owner-0", TTL);
        const tokens = [lease.token];
        for (let owner = 1; owner <= 3; owner++) {
          clock.time += TTL; // expiry
          const next = await store.acquireLease("run-1", `owner-${owner}`, TTL);
          expect(next).toMatchObject({ ownerId: `owner-${owner}`, expiresAt: clock.time + TTL });
          if (!next) throw new Error("not acquired");
          lease = next;
          tokens.push(lease.token);
        }
        await store.releaseLease(lease); // release
        const afterRelease = await store.acquireLease("run-1", "owner-4", TTL);
        tokens.push(afterRelease?.token ?? Number.NaN);
        for (let i = 1; i < tokens.length; i++) {
          expect(tokens[i]).toBeGreaterThan(tokens[i - 1] as number);
        }
      });

      it("renews a current lease with the same token", async () => {
        const { store, clock } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        clock.time += TTL - 1;
        const renewed = await store.renewLease(lease, TTL);
        expect(renewed).toEqual({ ...lease, expiresAt: clock.time + TTL });
        clock.time += TTL - 1;
        await expect(store.acquireLease("run-1", "owner-b", TTL)).resolves.toBeUndefined();
        if (renewed) {
          await expect(store.compareAndSwap(revised(record()), 0, renewed)).resolves.toBe("ok");
        }
      });

      it("does not renew an expired, superseded or released lease", async () => {
        const { store, clock } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        clock.time += TTL;
        await expect(store.renewLease(lease, TTL)).resolves.toBeUndefined();
        const next = await store.acquireLease("run-1", "owner-b", TTL);
        await expect(store.renewLease(lease, TTL)).resolves.toBeUndefined();
        if (!next) throw new Error("not acquired");
        await store.releaseLease(next);
        await expect(store.renewLease(next, TTL)).resolves.toBeUndefined();
      });

      it("ignores the release of a stale lease", async () => {
        const { store, clock } = await setup();
        const old = await store.create(record(), "owner-a", TTL);
        clock.time += TTL;
        const current = await store.acquireLease("run-1", "owner-b", TTL);
        await store.releaseLease(old);
        await expect(store.acquireLease("run-1", "owner-c", TTL)).resolves.toBeUndefined();
        if (current) {
          await expect(store.compareAndSwap(revised(record()), 0, current)).resolves.toBe("ok");
        }
      });

      it("rejects acquisition for a missing run", async () => {
        const { store } = await setup();
        await expect(store.acquireLease("missing", "owner-a", TTL)).rejects.toBeInstanceOf(
          RunNotFoundError,
        );
      });
    });

    describe("cancel requests", () => {
      it("records a request without a lease, independent of lease state", async () => {
        const { store, clock } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        await expect(store.isCancelRequested("run-1")).resolves.toBe(false);
        await store.requestCancel("run-1");
        await store.requestCancel("run-1"); // idempotent
        await expect(store.isCancelRequested("run-1")).resolves.toBe(true);
        // The record and lease are untouched.
        await expect(store.load("run-1")).resolves.toEqual(record());
        await expect(store.compareAndSwap(revised(record()), 0, lease)).resolves.toBe("ok");
        clock.time += TTL;
        await store.acquireLease("run-1", "owner-b", TTL);
        await expect(store.isCancelRequested("run-1")).resolves.toBe(true);
      });

      it("rejects a request for a missing run", async () => {
        const { store } = await setup();
        await expect(store.requestCancel("missing")).rejects.toBeInstanceOf(RunNotFoundError);
        await expect(store.isCancelRequested("missing")).resolves.toBe(false);
      });
    });

    describe("delete", () => {
      it("removes the record, its lease state and its control record", async () => {
        const { store } = await setup();
        const lease = await store.create(record(), "owner-a", TTL);
        await store.requestCancel("run-1");
        await store.delete("run-1");
        await expect(store.load("run-1")).resolves.toBeUndefined();
        await expect(store.isCancelRequested("run-1")).resolves.toBe(false);
        await expect(store.renewLease(lease, TTL)).resolves.toBeUndefined();
        await store.delete("run-1"); // idempotent
        await store.create(record(), "owner-b", TTL);
        // The old owner's lease does not carry over to the new run.
        await expect(store.compareAndSwap(revised(record()), 0, lease)).resolves.toBe("lease-lost");
      });
    });
  });
}
