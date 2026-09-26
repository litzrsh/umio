# Graph Workflow: Modification Plan

- Status: Revised draft (revision 4). All decisions are settled (§13); ready for approval.
- Design: [`docs/design/umio-graph-workflow-design.md`](../design/umio-graph-workflow-design.md)
- Code baseline: commit `a216ef9` (initial commit)
- Scope: How to implement the design in this repository: contracts, defaults, files, work order, tests, documentation. No code is written until this plan is approved.
- Target environment: local LLMs on a modest PC, where a single LLM or Agent operation may legitimately run for **two to three hours**. Slow inference must never be mistaken for a crashed executor.

### Progress

| Phase | Status |
|---|---|
| P0: Characterization tests | Done (`669c0b4`); `test/workflow-compat.test.ts` |
| P-T: Provider and transport time limits, `maxConcurrentRequests` | Done; `test/local-providers.test.ts` (classification, defaults, a real HTTP server for header timeouts, retries and aborts, and the limiter). Verified live against local Ollama. |
| P1: Types, validation, identity, planning, adapter | Done; `src/graph/` (types, errors, runtime, identity, validate, plan, executor), `src/agents/adr-context.ts`, `Workflow.run()` on the executor. Tests in `test/graph.test.ts`; the P0 suite passes unchanged. Verified live with `examples/workflow.ts` on local Ollama. The executor stays internal until P3/P4; conditional edges and `join: "any"` validate but are rejected at run time until P2. |
| P2: DAG execution | Done; predicates (evaluated once), transitive skips, `join: "all"`/`"any"` with a fixed `selectedPredecessor`, the concurrency limit with D14 precedence (config `graph.maxConcurrency` / `maxOutputBytes`, `WorkflowExecutor.fromConfig`), output checks (`output-not-json`, `output-too-large`), `ArtifactRef` helpers and `agentNode`. On node failure, siblings are aborted and recorded `cancelled` (the grace period and abandonment come in P5). `WorkflowExecutor` is now exported. Tests in `test/graph-dag.test.ts`, mutation-checked. Verified live with `examples/graph.ts` on local Ollama (the conditional branch was skipped). |
| P3: Checkpoint store, fenced CAS, owner timers | Done; `CheckpointStore`, `MemoryCheckpointStore`, the contract suite (`test/checkpoint-contract.ts`, run by `test/checkpoint-memory.test.ts`), fenced W0–W5 writes, lease renewal and cancel polling on their own timers, lease-loss and conflict shutdown, and `test/support/fake-clock.ts`. The executor's `store` defaults to a per-executor memory store, so the legacy adapter needs no change. Cancel detection ends the run `cancelled` (no grace or abandonment yet; P5). Renewal errors are tolerated until the lease has expired by the owner's clock. Tests in `test/graph-checkpoint.test.ts` (including 900 renewals over a simulated 2.5 h silent call), mutation-checked. Verified live with `examples/graph.ts` on local Ollama. |
| P4: Resume, uncertainty, explicit recovery, file store | Done; `resume()` (§5 steps 1–7), W6 (`recoverOrphans`), W7 on the resume and `recoverNode` paths (`finalizeCancel`), W8 (`applyRecovery`) and `recoverNode()`, `recovery: "retry"` within the budget, identity checks, and an experimental `FileCheckpointStore` (in-process mutex, fsync + rename, PID guard) passing the contract suite. A resumed run with a failed node finishes `failed` without new starts. Deviations: `LeaseUnavailableError` carries `leaseTtlMs` rather than `expiresAt`, because `acquireLease` does not report the holder's expiry; invalid recovery actions reject with a new `RecoveryNotApplicableError`, and the file guard with `CheckpointStoreLockedError`. Tests in `test/graph-resume.test.ts` (crash simulations after W1, after a side effect, after W2, after W3) and `test/checkpoint-file.test.ts`, mutation-checked. Verified live on local Ollama: a SIGKILLed process, `LeaseUnavailableError` before expiry, then `needs-recovery`, `recoverNode` retry and a completed resume, with the finished node not re-run. |
| P5: Timeouts, retry, cancellation, observer | Done; node and inactivity timeouts on per-attempt timers, `retry.ts` (full jitter; retryable = `GraphNodeError.retryable`, `LLMError.retryable`, `timeout`), W3 retries with a checkpointed `retryAt` that the scheduler waits for (also after `resume()`), the D10 flow (`cancel()` with every `CancelAck` outcome, `GraphRunOptions.signal`, a control-record read before every attempt start, `cancelGraceMs`, abandonment to `uncertain` for timeout, cancel and failure, W5′ `needs-recovery`), the D6 observer queue with drain after the terminal write and lease release, the D12 configuration checks, and the provider-timeout warning from `fromConfig` and `agentNode`. Deviations: `onNodeEvent` is replaced by `GraphRunOptions.observer` (`node-event`); a result arriving after its timeout fired is discarded as a `timeout` failure; `cancel()` on a run this executor drives returns `requested` (the run then ends through the normal flow); the warning compares against the executor's node timeout in `fromConfig` and the 3 h default in `agentNode`, and is a Node process warning (`UMIO_PROVIDER_TIMEOUT_BELOW_NODE_TIMEOUT`, once per message). Tests in `test/graph-retry.test.ts`, `test/graph-timeouts.test.ts`, `test/graph-cancel.test.ts`, `test/graph-observer.test.ts` and `test/graph-long-run.test.ts` (the §10 simulations 1–6), mutation-checked (25 mutations). Also fixed in both provider adapters: the SDKs end a stream quietly when its signal aborts, which turned a cancelled streaming agent node into an empty `completed` result; `stream()` now throws the abort error. Verified live on local Ollama: a streaming node cancelled through a second executor's `cancel()` ends `cancelled`, a 15 s node timeout fails the node with `timeout`, and `examples/graph.ts` completes with the observer. |
| Review fixes (after P5) | Done. (1) A cancel request arriving while W1 is written (local `cancel()`, run signal, or control record) is rechecked after W1 and before the handler starts; the handler never runs and W4 records the node `cancelled` (attempt counted), then W5 `cancelled`. (2) An output that fails `checkOutput` (`output-too-large`, `output-not-json`) is W2′: the node becomes `uncertain` with `uncertainReason: "invalid-output"` and the check error, never retried automatically, and the run parks (W5′) so `recoverNode()` can `complete` it with an `ArtifactRef` (the recovery clears the error), `retry` it or `fail` it. This changes the P2 acceptance "oversized or non-JSON output → non-retryable failure" to "→ non-retryable, recoverable"; the sequential `Workflow` still throws the check's message. (3) README: the node timeout covers an agent node's whole run; per-node `timeoutMs` or `null` for multi-turn agents. (4) `recoverNode()` releases its lease in `finally` on every path (release errors swallowed as elsewhere). Regression tests in `test/graph-cancel.test.ts` (W1 held open by the store), `test/graph-resume.test.ts` and `test/agents.test.ts`, each shown to fail without its fix. |

### Changes in revision 4

- **Local provider defaults are adopted** (formerly open item 1): a 3 h 5 min request timeout, no SDK retries, and `fetch` transport timeouts aligned with the request timeout. They apply only to providers classified as local, a new rule that keeps hosted `openai-compatible` gateways on the cloud defaults (D15).
- **`maxConcurrentRequests` is added:** a per-provider FIFO request limit inside `LLM`, defaulting to 1 for local providers and unlimited otherwise (D15). This resolves F11.
- **`.gitignore` no longer ignores `docs/`** (F9 resolved). The design, this plan and `docs/adr` can be versioned.

### Changes in revision 3

- **Crash recovery:** an interrupted node becomes `uncertain`. A new run status, `needs-recovery`, parks the run until an explicit `recoverNode()`. Automatic retry happens only when a node opts in with `recovery: "retry"` (D13).
- **Time limits:**
  - A layered model with separate semantics (D12). Node timeout 3 h by default. Lease: 30 s TTL, renewed every 10 s on its own timer. Cancellation polled every 2 s.
  - Provider and transport timeouts must not undercut the node timeout. New finding F10: an SDK timeout triggers a retry, and Node's `fetch` has its own idle timeouts.
- **Concurrency:** limits are configurable through the JSON config. 1 is recommended for local setups; the general default remains 4 (D14).
- **Stores and artifacts:** no reference database adapter ships initially; the `CheckpointStore` interface and a shared contract suite do (D2). `ArtifactRef` has required fields and ownership rules, but there is no built-in artifact store (D4).
- **Observer drain:** it runs after the terminal write, so it can never change a run's status (D6).
- **Tests:** new simulated multi-hour tests using the injected clock (§10).

## 1. Where the design meets the current code

Findings from reading the code at `a216ef9`. F10 and F11 are new in this revision.

| # | Design assumption | Current code | Consequence for the plan |
|---|---|---|---|
| F1 | Node outputs and checkpoints are JSON only | `WorkflowResult.steps[].result` is a full `AgentResult` (messages, provider `raw` responses, `providerData`). `WorkflowResult.state` is a live `KVStore`. | The legacy adapter persists only `{ text, usage }` per node. It keeps full results in process memory, and the legacy `Workflow` stays non-resumable. |
| F2 | Handlers receive `input` and `predecessors` | `StepContext` = `{ input, previous, outputs, state }`, where `state` is a `KVStore`. | The adapter's handlers capture the `KVStore`, `outputs` and step input functions in closures. `NodeContext` stays free of process objects (D7). |
| F3 | Failures are retried per policy | `Workflow.run()` has no retries and rejects with the original error instance. | Adapter nodes use `maxAttempts: 1`. The adapter re-throws the captured original error. |
| F4 | Events flow through `RunObserver` | `WorkflowEvent`s are awaited in order, and an exception from `onEvent` rejects `run()`. | The adapter bypasses `RunObserver` and calls `onEvent` directly (D6). |
| F5 | Cancellation via `AbortSignal` | `WorkflowOptions.signal` goes only to agents. A step starting after an abort still emits `step-start`, then fails. | The adapter passes `signal` to agents only, never to the executor. |
| F6 | ADR propagation continues in handlers | ADR resolution lives in `Workflow.adrOptions()`, and ADR tools are created per step. | Moved to a shared helper used by the adapter and `agentNode()`. |
| F7 | `CheckpointStore` differs from `KVStore` | `KVStore` has no revisions or leases. Node has no built-in advisory file lock. | A new interface with fenced CAS. The file store is experimental and single-process (D2). |
| F8 | Names like `RunOptions`, `RuntimeEvent`, `NodeEvent` | Flat exports from `src/index.ts`. `NodeEvent` is undefined in the design. | Renamed to `GraphRunOptions` and `GraphRunEvent`; `NodeEvent` defined (§3). |
| F9 | `docs/` is project documentation | An earlier working-tree `.gitignore` ignored `docs/`. That rule has been removed. | Resolved: the design, this plan and `docs/adr` are versionable. |
| F10 | Slow requests are bounded only by the node timeout | Several shorter limits can end a long local call first:<br>• **SDK `timeout`:** defaults to 10 minutes and runs until response headers arrive (verified in the installed `openai` SDK: `fetchWithTimeout` clears it in `finally`).<br>• **Retries:** a timeout is **retried** (`maxRetries` defaults to 2), repeating the whole inference.<br>• **Non-streaming `generate()` (OpenAI adapter):** a local server sends headers only once generation finishes, so the whole run must fit inside the SDK timeout.<br>• **Node's `fetch` (undici 7.29):** has its own header and body idle timeouts. The documented default is 300 s each; this is to be confirmed by test (P-T).<br>• **Cancellation:** `ProviderConfig.timeoutMs` / `maxRetries` exist but default to the SDK values. The adapters already pass `request.signal`, so aborting a node aborts its HTTP request. | Phase P-T aligns provider and transport limits with the node timeout for providers classified as local (D12, D15). Streaming is recommended for long local calls. |
| F11 | Node concurrency bounds model load | Inside one node, `executeToolCalls` runs a turn's tool calls concurrently (`Promise.all`). With `agent.asTool()`, one node can therefore issue several model calls at once. | `maxConcurrency: 1` does not by itself serialize LLM requests. Resolved by the per-provider `maxConcurrentRequests` (D15). |

## 2. Decisions

### D1: Public API

- The public names are `WorkflowGraph`, `WorkflowDefinition`, `WorkflowRun`, `NodeContext`, `NodeHandler`, `EdgePredicate`, `CheckpointStore`, `RunObserver`, `GraphRunOptions`, `GraphRunEvent`, `ArtifactRef` and `RecoveryAction`.
- **`WorkflowExecutor` is a concrete class.** `CheckpointStore` is the interface for alternative storage.
- The existing `Workflow`, `WorkflowOptions`, `WorkflowResult`, `WorkflowEvent`, `StepContext` and `StepOptions` are unchanged.

### D2: Checkpoint stores and fencing

- **Every run-record write is a fenced CAS.** It carries the writer's lease `{ ownerId, token }`, and the store accepts it only if all hold, checked atomically with the write:
  1. The token is the latest issued for the run.
  2. The lease is unexpired by the store's clock.
  3. The revision matches.
- Every acquisition issues a higher token, and an expired lease is lost even without a takeover. An owner whose lease expired therefore cannot write after another owner takes over, nor before.
- **Shipped:**
  - the `CheckpointStore` interface;
  - `MemoryCheckpointStore` (reference implementation; atomic by JavaScript's run-to-completion);
  - `FileCheckpointStore`, **experimental and single-process only** (fenced CAS through an in-process mutex, restart durability through atomic temp + rename, and a best-effort PID directory guard that is not a correctness mechanism);
  - a **shared contract test suite** that any store must pass.
- **Not shipped:** a reference database adapter. One may be added later, once its CAS, lease ownership and fencing behavior pass the contract suite under real concurrency. Adapter authors get the semantics in §3 and the suite in `test/`.

### D3: Run statuses

`RunStatus` = `running`, `needs-recovery`, `completed`, `failed`, `cancelled`.

- `paused` and `pending` are omitted because no operation produces them.
- `needs-recovery` is included because crash recovery produces it (D13).
- Adding statuses later requires a `schemaVersion` bump. `RunStatus` is documented as extensible.

### D4: Output persistence and artifacts

- **Limit:** `maxOutputBytes` is configurable per executor and per node, with a default of **256 KiB** measured as the UTF-8 length of canonical JSON. Handlers read it as `context.limits.maxOutputBytes`. Records carry `schemaVersion: 1`, and unknown versions fail with `CheckpointSchemaError`.
- **Oversized or non-JSON output** fails the node as **non-retryable** (`output-too-large`, `output-not-json`) before the success write. The failure record stores only the code and a truncated message. The handler is not re-invoked automatically, but any side effect it performed already happened; the error says so and names the idempotency key. Handlers with side effects should check the limit, or produce an `ArtifactRef`, **before** performing the effect.
- **`ArtifactRef` (type only; no built-in store):**

  ```ts
  interface ArtifactRef {
    readonly $artifact: {
      readonly uri: string;        // required; a location the application can resolve (file://, s3://, kv:<key>, …)
      readonly sha256: string;     // required; hex digest of the stored bytes
      readonly bytes: number;      // required; size of the stored bytes
      readonly mediaType?: string; // e.g. "text/markdown", "application/json"
    };
  }
  ```

  - **Creating a reference:** the handler writes the artifact with a storage client it captured (D7), under a key derived from `idempotencyKey`, e.g. `<prefix>/<runId>/<nodeId>`. A repeated attempt then overwrites rather than duplicates. The handler returns the ref as (part of) its output.
  - **Resolving a reference:** a downstream handler finds the ref in `predecessors`, reads it with its own captured client, and verifies `sha256` and `bytes`. umio never dereferences, fetches or validates the target. It provides `isArtifactRef()` and `collectArtifactRefs(run)`, which lists the refs in a run's outputs.
  - **Retention and deletion belong to the application.** `CheckpointStore.delete(runId)` does not delete artifacts. Artifacts must not be deleted while their run is non-terminal: `running` or `needs-recovery` runs may still need them. After a terminal status, the application removes them under its own retention policy, typically with `collectArtifactRefs`.
- **Redaction** is a separate concern and out of scope.

### D5: Definition identity

- Runs persist `workflowId`, `definitionVersion` and `definitionHash`.
- The hash is the SHA-256 of the canonical JSON (`stableStringify`) of the graph structure plus the sorted handler and predicate keys.
- `resume()` and `recoverNode()` reject a mismatch in any of the three with `DefinitionMismatchError`.
- Documented limitation: handler code changes behind unchanged keys are not detected, so version bumps are still required.

### D6: Observers and shutdown order

- Observer failures never change a run's outcome or status, and observers never delay scheduling or node execution. There is no `"fail"` mode.
- Events are delivered in order through a per-run queue that the scheduler does not wait on. Errors go to `onObserverError` if given, otherwise they are dropped.
- **Shutdown order:**
  1. terminal write (W5/W7), or the parking write (W6);
  2. stop the timers and release the lease;
  3. drain the observer queue for at most `observerDrainTimeoutMs` (default **5 s**);
  4. resolve.

  Because the status is already persisted before the drain starts, **a drain timeout can never turn a completed run into `failed`**. Events still undelivered are dropped, and the run's status is unaffected. Guaranteed delivery is reserved for a future transactional outbox.
- The legacy adapter keeps today's awaited `onEvent`, including its errors rejecting `run()`.

### D7: Process-bound dependencies

- `NodeContext` carries per-attempt data only.
- Handlers capture their dependencies when the definition is built. `agentNode(agent, { llm, state?, adr? })` captures its agent and model client, and the legacy adapter captures its `KVStore`.
- **Rebound on `resume()` / `recoverNode()`** (nothing process-bound is persisted):
  - through the `WorkflowDefinition`: handlers, predicates and everything they capture (`ModelClient`/`LLM`, Agents, tools, `KVStore`, ADR stores, artifact clients);
  - through the executor constructor: the store and `RuntimeDependencies`;
  - through `GraphRunOptions`: the observer, `signal` and `maxConcurrency`.
- A captured `MemoryKVStore` is empty after a restart. Resumable graphs that share state need a durable `KVStore`.

### D8: Node input and joins

- `input` is the original run input.
- `predecessors` holds completed, active predecessor outputs, with keys in node-ID order.
- **`join: "all"`** waits for all active incoming edges and is skipped if none are active.
- **`join: "any"`** runs on the first active predecessor to complete. That choice is persisted as `selectedPredecessor` in the same write as that predecessor's success. It fixes `predecessors` for every attempt and across resumes; later completions never alter the input or re-trigger the node.

### D9: Terminal statuses

- `completed`, `failed` and `cancelled` are terminal. `resume()` and `recoverNode()` reject them with `RunNotResumableError`.
- Attempt budgets are never reset implicitly. `retryFailedRun()` is deferred to P6.

### D10: Cancellation

- **`cancel(runId)` acknowledges a request.** It returns a `CancelAck` with outcome `cancelled` (termination confirmed by this call), `requested` (durably recorded; a live owner will act on it), `already-terminal` or `not-found`.
- **Cancel requests live in a control record** separate from the run record: `requestCancel`, no lease needed, and the revision is untouched. They never conflict with the owner's fenced writes.
- **`cancel()` steps:**
  1. Load the run.
  2. Return `not-found` or `already-terminal` if applicable.
  3. Call `requestCancel`.
  4. If this executor owns the run, abort its internal controller.
  5. Otherwise, try to acquire the lease. If it is free (the owner is dead or absent), reload and finalize with W7, then return `cancelled`. If it is held, return `requested`.
- **How an active owner notices requests.** These checks are independent of lease renewal:
  - a **cancel-poll timer** calls `isCancelRequested` every `cancelPollIntervalMs` (default **2 s**) for as long as the owner holds the lease, including during multi-hour LLM calls and retry waits;
  - the control record is also read before every attempt start.

  On detection, the owner stops scheduling, aborts its internal signal (which ends retry sleeps immediately), and aborts every running attempt's `context.signal`.
- **Cooperative handlers**, e.g. `agentNode`, whose abort signal reaches the SDK request and closes the HTTP connection, finish as `cancelled`. Local servers typically stop generating when the client disconnects; this is verified per server in P-T, not promised.
- **A handler that ignores cancellation** gets `cancelGraceMs` (default **10 s**). After that, its attempt is **abandoned**:
  1. The node is marked `uncertain` (D13), because umio does not know what it did.
  2. The run is finalized `cancelled` (W5), the lease is released, and `run()` resolves.
  3. The abandoned promise keeps running in the background of this process until it settles or the process exits. Its eventual result is discarded, and it may still cause side effects.

  umio cannot forcibly stop JavaScript code. Handlers doing long work must honor `context.signal`.
- **No latency promise.** A live owner detects a request in about `cancelPollIntervalMs`, but how fast work stops depends on the handler. For a dead owner, finalization happens when a later `cancel()` or `resume()` acquires the lease after expiry. Cancellation latency is not derived from the lease renewal interval.
- `GraphRunOptions.signal` aborting counts as a local cancel request.

### D11: Runtime dependencies

`WorkflowExecutor`'s constructor takes an optional `dependencies?: Partial<RuntimeDependencies>`: `now()`, `sleep(ms, signal)`, `random()`, `newId()` and `setTimer(ms, callback) → cancel`.

- These drive node timeouts, lease renewal, cancel polling, retry backoff and grace periods, and `MemoryCheckpointStore` accepts the same `now()`.
- The type is internal (`src/graph/runtime.ts`, not re-exported). The defaults are the real implementations.
- Nothing time-related appears in `GraphRunOptions`.

### D12: Time limits (layered, separate semantics)

| Layer | What it limits | Default | On expiry |
|---|---|---|---|
| **Node timeout** (`NodeSpec.timeoutMs`, executor `nodeTimeoutMs`) | Wall-clock time of one attempt, measured by the executor's clock | **3 h** (10 800 000 ms) for every graph node unless overridden; `null` disables it. The legacy adapter disables it. | Aborts `context.signal` → the attempt fails with `timeout` if it stops within `cancelGraceMs`, otherwise it is abandoned → `uncertain` (D13). Retried only per `RetryPolicy` (default `maxAttempts: 1`). |
| **Provider request timeout** (`ProviderConfig.timeoutMs`) | One HTTP request, from send to response headers (SDK semantics, F10). It starts when the request is **sent**, so time spent waiting in the `maxConcurrentRequests` queue does not count (D15). | Local providers (D15): **3 h 5 min**, just above the node timeout. Other providers: SDK default. | The SDK throws, and **retries if `maxRetries` > 0**. Local providers therefore default to `maxRetries: 0`. |
| **Transport idle timeouts** (undici `headersTimeout` / `bodyTimeout`) | Time to headers, and time between body chunks, inside Node's `fetch` | Local providers: set to the provider request timeout through an undici `Agent` passed as `fetchOptions.dispatcher`. Other providers: unchanged. | Connection error. With `maxRetries: 0`, it is not retried. |
| **Request queue wait** (`maxConcurrentRequests`, D15) | Time a model call waits for a free provider slot | No limit on the wait; it ends when the call's signal aborts | Not an expiry. The wait counts toward the **node** timeout (wall clock), but not toward provider or transport timeouts. |
| **Inactivity timeout** (`NodeSpec.inactivityTimeoutMs`) | Time between observable progress events of an attempt (stream deltas, tool results, `emit`) | **Disabled.** It must stay disabled or generous for local models, because prompt prefill on a modest PC can produce no output for a long time. | Treated like a node timeout. |
| **Tool-loop limits** (`maxSteps`, `maxToolOutputChars`) | Number of model calls, and tool result size | Unchanged; these are counts, not time | End the loop (`max-steps`) or condense output. Never time-based. |
| **Built-in tool timeouts** (web 15 s, shell 60 s) | One tool call | Unchanged | That tool call fails. They never apply to the LLM request. |
| **Lease** (`leaseTtlMs`, `leaseRenewIntervalMs`) | Proof that the owning process is alive | TTL **30 s**, renewed every **10 s** | Lease lost (§5). **Not a limit on node duration.** |
| **Cancel poll** (`cancelPollIntervalMs`) | How often an owner reads cancel requests | **2 s** | Not an expiry. |

**Consistency rules:**

- **The node timeout governs total LLM time.** Provider and transport limits for local providers are set **above** it. They then act only as a backstop and never end a valid long request early. The node timeout itself aborts the request through the signal the adapters already pass.
- **The lease timer is independent of the LLM call.** It runs on `setTimer` whether or not the model has produced any output, so a 3-hour prefill with no tokens does not expire the lease. The only ways to lose the lease are a dead process, or a JavaScript event loop blocked for more than about 20 s (two missed renewals). LLM inference runs in the model server's process, not umio's, so it does not block the event loop. The documentation warns against CPU-bound work inside handlers.
- **Streaming is recommended** for long local calls (`agentNode(…, { stream: true })`, `Agent.run` `stream`). It keeps bytes flowing and enables progress events, but correctness does not depend on it.
- **Configuration validation** at executor construction:
  - `leaseRenewIntervalMs < leaseTtlMs / 2`;
  - `cancelPollIntervalMs < leaseTtlMs`;
  - `cancelGraceMs < leaseTtlMs`, so grace waits never outlive the lease.

  A local provider whose effective request timeout is below the node timeout produces a documented warning, emitted when the executor or `agentNode` is created with an `LLM` whose config it can read.
- **Queue waits count toward the node timeout.** With `maxConcurrentRequests: 1`, a node whose model call waits behind another node's 2-hour call has less of its own 3-hour budget left. `graph.maxConcurrency: 1` (D14) avoids this for graph nodes. Remaining contention comes from parallel calls within one node, and it is documented.

### D13: Uncertain outcomes and explicit recovery

- **A node is `uncertain` whenever an attempt started (W1) but umio cannot know whether it finished or what it did.** This happens when:
  - the owning process died while the node was `running` (found by the next lease holder);
  - an attempt was abandoned after a timeout grace period;
  - an attempt was abandoned during cancellation or run failure.
- **No automatic retry by default.**
  - On `resume()`, orphaned `running` nodes become `uncertain` (W6).
  - Once the run has any `uncertain` node and no attempt is running, the executor starts no new attempts. It writes `needs-recovery`, releases the lease, and `run()`/`resume()` resolve with that status.
- **Opt-in automatic recovery:** `NodeSpec.recovery: "retry"`. It is valid only for handlers that use `context.idempotencyKey` so a repeated attempt is safe; umio documents this but cannot verify it. For such nodes, an interrupted or abandoned attempt becomes `pending` + `retryAt` if attempts remain, and `uncertain` otherwise.
- **Explicit recovery:** `recoverNode(definition, runId, nodeId, action)`. It requires a `needs-recovery` run, an `uncertain` node, matching definition identity, and the lease. Actions:
  - `{ type: "retry" }`: a new attempt with the same `idempotencyKey`. It is allowed even if the attempt budget is exhausted, because it is an explicit operator decision, and it is recorded in `NodeRun.recoveries`.
  - `{ type: "complete", output }`: the operator asserts that the effect happened. The output is validated (JSON and size limit), predicates are evaluated, and the result is written like W2.
  - `{ type: "fail", message? }`: the node becomes `failed`, and the run becomes `failed` (terminal).

  When no `uncertain` node remains, the run returns to `running` in the same write (W8). The caller then calls `resume()` to continue. Recovery and continuation are deliberately separate steps.
- `cancel()` on a `needs-recovery` run is allowed. The run becomes `cancelled`, and uncertain nodes stay `uncertain` in the terminal record, so the record stays accurate.
- **No exactly-once claims anywhere.**

### D14: Concurrency configuration

- **Precedence:** `GraphRunOptions.maxConcurrency` > the executor constructor option > the config file's `graph.maxConcurrency` > the built-in default **4**.
- New optional config section, validated by the config schema:

  ```json
  "graph": {
    "maxConcurrency": 1,
    "nodeTimeoutMs": 10800000,
    "maxOutputBytes": 262144,
    "leaseTtlMs": 30000,
    "leaseRenewIntervalMs": 10000,
    "cancelPollIntervalMs": 2000,
    "cancelGraceMs": 10000,
    "observerDrainTimeoutMs": 5000
  }
  ```

  `WorkflowExecutor.fromConfig(config, { store })` applies it, so a local project's `umio.config.json` sets `maxConcurrency: 1` and nothing overrides it silently. The general default of 4 applies only when no layer sets a value.
- **Documentation recommends `maxConcurrency: 1` for resource-constrained local setups**, and warns that node concurrency does not serialize model calls made within a node (F11).

### D15: Local providers and request concurrency

- **"Local" is decided per provider, not per type.** New optional `ProviderConfig.local?: boolean`; an explicit value always wins. When it is omitted:
  - `ollama` is local;
  - `openai-compatible` is local when its resolved `baseURL` host is `localhost`, a `*.localhost` name, or a loopback, private or link-local IP literal (reusing `isInternalAddress` from `src/builtin/web.ts`, with no DNS lookup), and not local otherwise;
  - `openai` and `anthropic` are never local by default.

  Hosted gateways configured as `openai-compatible` (OpenRouter, Groq, …) therefore keep the SDK defaults, including retries on 429 and 5xx.
- **Local provider defaults** apply only where the config does not set the value:
  - `timeoutMs`: 11 100 000 (3 h 5 min);
  - `maxRetries`: 0;
  - `transport.headersTimeoutMs` / `bodyTimeoutMs`: equal to the effective `timeoutMs`;
  - `maxConcurrentRequests`: 1.

  These are new defaults for existing users of local providers, including the legacy `Workflow` and plain `LLM.generate`. The change is documented as a behavior change.
- **`ProviderConfig.maxConcurrentRequests?: number`.** It caps in-flight model requests per provider entry, per `LLM` instance.
  - Default: **1** for local providers, unlimited otherwise.
  - Waiting calls are served in FIFO order.
  - It is enforced at the provider-call layer (`LLM.callProvider` / `streamProvider`), inside middleware and the response cache. So:
    - response-cache hits never take a slot;
    - calls made through middleware's `context.generate` (e.g. the prompt translator) share the limit, since they reach the same server;
    - the limit covers `generate()`, `stream()`, tool loops, parallel tool calls, `agent.asTool()` delegation and graph nodes alike.
  - **A streaming call holds its slot until the stream finishes, fails or is abandoned by the consumer** (the generator's `return` releases it).
  - **Aborts:** a call whose `signal` aborts while waiting leaves the queue without sending anything, and rejects with the same abort error the adapter would produce. A call that aborts while in flight releases its slot when the adapter settles.
  - **Scope, documented:** the limit is per `LLM` instance and per process. Several `LLM` instances or processes pointed at the same server do not share it. The server's own queue (e.g. Ollama's `OLLAMA_NUM_PARALLEL`) still applies behind it.
  - **Why client-side:** a request waiting in umio's queue has not been sent, so its provider and transport timeouts have not started. A request waiting in the server's queue would be consuming them.

## 3. Contracts

These refine the design's §3 and supersede it where they differ.

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type NodeId = string;
type RunStatus = "running" | "needs-recovery" | "completed" | "failed" | "cancelled";
type NodeStatus = "pending" | "running" | "completed" | "skipped" | "failed" | "cancelled" | "uncertain";
// "ready" is derived by the scheduler, never persisted.

interface WorkflowGraph {
  readonly id: string; readonly version: string;
  readonly nodes: readonly NodeSpec[]; readonly edges: readonly EdgeSpec[]; readonly entry: readonly NodeId[];
}
interface NodeSpec {
  readonly id: NodeId;
  readonly handler: string;
  readonly retry?: RetryPolicy;                // default { maxAttempts: 1 }
  readonly timeoutMs?: number | null;          // default: executor nodeTimeoutMs (3 h); null = none
  readonly inactivityTimeoutMs?: number;       // default: disabled
  readonly join?: "all" | "any";               // default "all"
  readonly maxOutputBytes?: number;            // default: executor maxOutputBytes (256 KiB)
  readonly recovery?: "manual" | "retry";      // default "manual" (D13)
}
interface EdgeSpec { readonly from: NodeId; readonly to: NodeId; readonly when?: string }
interface RetryPolicy {
  readonly maxAttempts: number; readonly initialDelayMs: number;
  readonly maxDelayMs?: number; readonly multiplier?: number;   // full jitter
}

interface NodeContext {
  readonly runId: string;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly input: JsonValue;
  readonly predecessors: Readonly<Record<NodeId, JsonValue>>;
  readonly signal: AbortSignal;            // aborted on cancel, timeout, run failure or lease loss
  readonly deadline?: number;              // from timeoutMs
  readonly idempotencyKey: string;         // `${runId}:${nodeId}`, identical across attempts and recoveries
  readonly limits: { readonly maxOutputBytes: number };
  emit(event: NodeEvent): void;            // enqueued; never throws or blocks; counts as progress
}
type NodeHandler = (context: NodeContext) => Promise<JsonValue>;
type EdgePredicate = (output: JsonValue, runInput: JsonValue) => boolean;

interface WorkflowDefinition {
  readonly graph: WorkflowGraph;
  readonly handlers: Readonly<Record<string, NodeHandler>>;
  readonly predicates: Readonly<Record<string, EdgePredicate>>;
}
type NodeEvent =
  | { type: "agent-event"; agent: string; event: ToolLoopEvent }
  | { type: "adr-proposed"; agent: string; adr: Adr }
  | { type: "custom"; name: string; data?: JsonValue };

interface NodeRun {
  readonly nodeId: NodeId;
  readonly status: NodeStatus;
  readonly attempt: number;                    // attempts started, including recovery retries
  readonly retryAt?: number;
  readonly selectedPredecessor?: NodeId;
  readonly output?: JsonValue;
  readonly error?: { code: string; message: string; retryable: boolean };
  readonly uncertainReason?: "process-lost" | "abandoned-timeout" | "abandoned-cancel" | "abandoned-failure";
  readonly recoveries?: readonly { action: "retry" | "complete" | "fail"; at: number }[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
}
interface WorkflowRun {
  readonly schemaVersion: 1;
  readonly runId: string; readonly workflowId: string;
  readonly definitionVersion: string; readonly definitionHash: string;
  readonly status: RunStatus;
  readonly input: JsonValue;
  readonly nodes: Readonly<Record<NodeId, NodeRun>>;
  readonly edges: Readonly<Record<string, boolean>>;
  readonly revision: number;
  readonly error?: { code: string; message: string; nodeId?: NodeId };
  readonly createdAt: number; readonly updatedAt: number;
}

interface Lease { readonly runId: string; readonly ownerId: string; readonly token: number; readonly expiresAt: number }
type CasResult = "ok" | "revision-conflict" | "lease-lost";
interface CheckpointStore {
  create(run: WorkflowRun, ownerId: string, ttlMs: number): Promise<Lease>;   // rejects an existing runId
  load(runId: string): Promise<WorkflowRun | undefined>;
  compareAndSwap(run: WorkflowRun, expectedRevision: number, lease: Lease): Promise<CasResult>;
  acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<Lease | undefined>;  // higher token
  renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined>;       // same token; unexpired only
  releaseLease(lease: Lease): Promise<void>;
  requestCancel(runId: string): Promise<void>;                               // control record
  isCancelRequested(runId: string): Promise<boolean>;
  delete(runId: string): Promise<void>;                                      // never touches artifacts
}

type RecoveryAction =
  | { type: "retry" }
  | { type: "complete"; output: JsonValue }
  | { type: "fail"; message?: string };

class WorkflowExecutor {
  constructor(options: WorkflowExecutorOptions, dependencies?: Partial<RuntimeDependencies>);
  static fromConfig(config: UmioConfig, options: WorkflowExecutorOptions): WorkflowExecutor;  // D14
  run(definition: WorkflowDefinition, input: JsonValue, options?: GraphRunOptions): Promise<WorkflowRun>;
  resume(definition: WorkflowDefinition, runId: string, options?: GraphRunOptions): Promise<WorkflowRun>;
  recoverNode(definition: WorkflowDefinition, runId: string, nodeId: NodeId, action: RecoveryAction): Promise<WorkflowRun>;
  cancel(runId: string): Promise<CancelAck>;
}
interface WorkflowExecutorOptions {
  store: CheckpointStore;
  maxConcurrency?: number;            // default 4 (D14)
  nodeTimeoutMs?: number | null;      // default 10 800 000
  maxOutputBytes?: number;            // default 262 144
  leaseTtlMs?: number;                // default 30 000
  leaseRenewIntervalMs?: number;      // default 10 000
  cancelPollIntervalMs?: number;      // default 2 000
  cancelGraceMs?: number;             // default 10 000
  observerDrainTimeoutMs?: number;    // default 5 000
}
interface GraphRunOptions {
  readonly runId?: string; readonly signal?: AbortSignal; readonly maxConcurrency?: number;
  readonly observer?: RunObserver;
  readonly onObserverError?: (error: unknown, event: GraphRunEvent) => void;
}
interface CancelAck {
  readonly runId: string;
  readonly outcome: "cancelled" | "requested" | "already-terminal" | "not-found";
  readonly status?: RunStatus;
}
type GraphRunEvent =
  | { type: "run-start" | "run-resume"; runId: string; at: number }
  | { type: "run-finish"; runId: string; status: "completed" | "failed" | "cancelled"; at: number }
  | { type: "run-needs-recovery"; runId: string; nodes: NodeId[]; at: number }
  | { type: "run-cancel-requested"; runId: string; at: number }
  | { type: "node-start"; runId: string; nodeId: NodeId; attempt: number; at: number }
  | { type: "node-event"; runId: string; nodeId: NodeId; attempt: number; event: NodeEvent; at: number }
  | { type: "node-retry"; runId: string; nodeId: NodeId; attempt: number; retryAt: number; at: number }
  | { type: "node-finish"; runId: string; nodeId: NodeId; attempt: number;
      status: "completed" | "failed" | "skipped" | "cancelled" | "uncertain"; at: number };
interface RunObserver { emit(event: GraphRunEvent): void | Promise<void> }
```

**Provider configuration additions (P-T, D15)**, valid on every provider type:

```ts
interface ProviderConfigAdditions {
  local?: boolean;                 // default inferred (D15)
  maxConcurrentRequests?: number;  // default 1 if local, else unlimited
  transport?: { headersTimeoutMs?: number; bodyTimeoutMs?: number };  // default = timeoutMs if local
}
// Local defaults when unset: timeoutMs 11 100 000, maxRetries 0.
```

**Outcomes of `run()` / `resume()` / `recoverNode()`.** They **resolve** with the persisted `WorkflowRun` when the run is terminal (`completed`, `failed`, `cancelled`) or parked (`needs-recovery`). They **reject** only when the executor cannot continue safely:

- `GraphValidationError`, `DefinitionMismatchError`
- `RunNotFoundError`, `RunNotResumableError`
- `LeaseUnavailableError` (with `expiresAt`), `LeaseLostError`
- `CheckpointConflictError`, `CheckpointSchemaError`
- store I/O errors

After a rejection, the stored run is whatever was last written, and recovery belongs to the next lease holder.

## 4. State machine and writes

| Entity | From | To | Trigger (write) |
|---|---|---|---|
| Run | none | `running` | `run()` (W0) |
| Run | `running` | `completed` / `failed` / `cancelled` | terminal decision after running attempts settle or are abandoned (W5) |
| Run | `running` | `needs-recovery` | an `uncertain` node exists and no attempt is running (W6 or W5′) |
| Run | `needs-recovery` | `running` | the last `uncertain` node is resolved by `recoverNode` (W8) |
| Run | `needs-recovery` | `failed` | `recoverNode` `fail` (W8) |
| Run | `running` / `needs-recovery` | `cancelled` | cancel observed by the owner (W5), or finalized on an orphan (W7) |
| Node | `pending` | `running` | attempt start (W1); ready and `retryAt` ≤ now |
| Node | `running` | `completed` | valid output (W2) |
| Node | `running` | `pending` + `retryAt` | retryable failure (including `timeout`) with attempts remaining (W3) |
| Node | `running` | `failed` | non-retryable or exhausted (W3) |
| Node | `running` | `cancelled` | the attempt stopped within grace during cancel or run failure (W4) |
| Node | `running` | `uncertain` | abandoned after grace (W4), or orphaned at recovery (W6/W7) |
| Node | `running` | `pending` + `retryAt` | abandoned or orphaned, `recovery: "retry"`, attempts remain (W4/W6) |
| Node | `pending` | `skipped` | all incoming edges inactive (inside W2/W3/W6/W8) |
| Node | `uncertain` | `running` / `completed` / `failed` | `recoverNode` `retry` (then W1 after `resume`) / `complete` / `fail` (W8) |

- **W0 create:** status `running`, schema, identity. Returns the first lease.
- **W1 attempt start:** `attempt + 1`, `startedAt`. **The handler is invoked only after W1 succeeds.**
- **W2 success:** output, `completed`, edge decisions (predicates evaluated once), `selectedPredecessor` for `join: "any"` successors, and transitive skips, all in one write. **Successors become ready only after W2.**
- **W3 failure:** a retry is scheduled, or the node fails.
- **W4 attempt stopped or abandoned** during timeout, cancel or failure handling.
- **W5 run terminal** (W5′: parked as `needs-recovery`): written once no attempt is running. Abandoned attempts do not count as running.
- **W6 recovery on resume:** orphaned `running` nodes → `uncertain` (or `pending` for `recovery: "retry"`). If any node is `uncertain`, the run → `needs-recovery` in the same write. This is the first write under the new lease.
- **W7 orphan finalization on cancel:** orphaned `running` → `uncertain`, and the run → `cancelled`, in one write.
- **W8 recovery action:** `retry` makes the node `pending` with `retryAt = now`, eligible regardless of the budget, and records the recovery. `complete` is like W2. `fail` marks the node `failed` and the run `failed`. If no `uncertain` node remains and the run is not failed, the run → `running`.

**Serialization and stale results.** All writes of a run go through one per-run queue, each as a fenced CAS. A handler's result is applied only while its node is `running` with the same `attempt` in the owner's in-memory copy. Abandoned, timed-out, cancelled and lease-lost attempts are therefore discarded.

## 5. Resume, recovery and leases

**`resume(definition, runId)`:**

1. Load the run. If missing, `RunNotFoundError`; if terminal, `RunNotResumableError`.
2. Check the schema and definition identity.
3. Acquire the lease (`LeaseUnavailableError` if it is held).
4. Reload under the lease.
5. If a cancel request exists, W7, release the lease and resolve `cancelled`.
6. If there are orphaned `running` nodes, W6. If the run is (or becomes) `needs-recovery`, release the lease and resolve with it; no new attempts start.
7. Otherwise, schedule, honoring the persisted `retryAt`.

**`recoverNode()`** performs steps 1–5 of `resume()` (and additionally requires `needs-recovery` and an `uncertain` node), then W8, then releases the lease. It never starts attempts; the caller then calls `resume()`.

**Owner timers.** All three run on `RuntimeDependencies.setTimer`, independently of handler activity:
- lease renewal every `leaseRenewIntervalMs`;
- cancel poll every `cancelPollIntervalMs`;
- a per-attempt node timeout.

**Losing the lease.** A failed renewal, or any CAS returning `lease-lost`, means the lease is lost. The owner then:
1. stops scheduling;
2. aborts all attempt signals;
3. **writes nothing more**;
4. stops its timers;
5. rejects with `LeaseLostError`.

A `revision-conflict` under a valid lease breaks I1: it raises `CheckpointConflictError` with the same shutdown. The lease is released after W5, W5′, W7 or W8.

**After a crash**, the dead owner's lease stays valid until it expires (at most 30 s after its last renewal). Until then, `resume()` returns `LeaseUnavailableError` with `expiresAt`. No forced takeover is offered.

## 6. Legacy `Workflow` adapter

- `Workflow.run()` compiles its steps into a chain and runs it on a private `WorkflowExecutor` with:
  - a fresh `MemoryCheckpointStore`;
  - `maxConcurrency: 1`, `maxAttempts: 1`, **`nodeTimeoutMs: null`** (the legacy API has no node timeout);
  - no observer and no executor signal.
- **Each handler:** computes the step input from captured state (an input function that throws fails before `step-start`), awaits `step-start`, then runs the agent with the captured `llm`, ADR context and tools, `state`, `hooks`, `stream` and the original `signal`, forwarding events through the awaited `onEvent`. It then stores the full `AgentResult` process-side, awaits `step-finish`, and returns `{ text, usage }`.
- **Errors:** the first error is captured and re-thrown by the handler. When the executor resolves `failed`, `Workflow.run()` throws that same instance.
- **Unchanged:**
  - event order, awaited callbacks, and `onEvent` errors rejecting `run()`;
  - error identity;
  - abort behavior (the signal reaches agents only);
  - the `WorkflowResult` shape;
  - non-resumability.
- **Uncertain nodes cannot arise** here: the adapter never resumes, and the memory store dies with the process.
- **P-T changes provider defaults for local providers** (D15): longer timeouts, no retries, and one request at a time. That applies to every caller of `LLM`, the legacy `Workflow` included. It is a provider behavior change, not an adapter change, and is documented as such. Legacy workflows already run steps sequentially; the only visible effect is that parallel tool calls within a step no longer send concurrent requests to a local server.

## 7. Target layout

| File | Contents |
|---|---|
| `src/graph/types.ts` | §3 public types |
| `src/graph/runtime.ts` | `RuntimeDependencies` and real defaults (internal) |
| `src/graph/errors.ts` | Graph error classes (all extend `UmioError`); `GraphNodeError` (`code`, `retryable`) |
| `src/graph/validate.ts` | Definition validation (duplicate IDs, missing handlers or predicates, unknown endpoints, cycles, unreachable nodes, entry nodes with incoming edges, `join` with fewer than 2 incoming edges, non-JSON values, `recovery`/`timeoutMs` value checks) |
| `src/graph/identity.ts` | `definitionHash()` |
| `src/graph/plan.ts` | Pure scheduling over a `WorkflowRun`: ready set, edges, skips, joins, W2/W6/W8 contents |
| `src/graph/output.ts` | Output validation, `ArtifactRef`, `isArtifactRef()`, `collectArtifactRefs()` |
| `src/graph/retry.ts` | Backoff with full jitter; retryability (`GraphNodeError.retryable`, `LLMError.retryable`, `timeout`) |
| `src/graph/executor.ts` | `WorkflowExecutor`: write queue, the three owner timers, scheduling, cancellation, recovery, observer queue |
| `src/graph/checkpoint/memory.ts` | `MemoryCheckpointStore` |
| `src/graph/checkpoint/file.ts` | `FileCheckpointStore` (experimental, single-process) |
| `src/graph/agent-node.ts` | `agentNode(agent, { llm, state?, adr?, stream? })` |
| `src/agents/adr-context.ts` | ADR option resolution (taken out of `Workflow`) |
| `src/agents/workflow.ts` | `run()` rewritten per §6 |
| `src/config/schema.ts` | Optional `graph` section (D14); provider `local`, `maxConcurrentRequests`, `transport` (D12, D15) |
| `src/llm/providers/openai.ts` | Local defaults and the undici dispatcher (P-T) |
| `src/llm/local.ts` | Local classification (D15) and effective local defaults |
| `src/llm/limiter.ts` | FIFO request limiter with abort-aware waiting (D15) |
| `src/llm/client.ts` | Acquire a limiter slot in `callProvider` / `streamProvider` (after the cache check) |
| `test/checkpoint-contract.ts` | The shared store contract suite (D2) |
| `test/support/fake-clock.ts` | A fake `RuntimeDependencies` with `advance(ms)` that runs due timers in order |

## 8. Invariants and consistency check

- **I1: Single writer.** Only the current, unexpired lease holder writes the run record, enforced by fenced CAS. Cancel requests go to the control record.
- **I2: Durable before visible.** Handlers run only after W1, and successors only after W2.
- **I3: Decisions happen once.** Predicates and `selectedPredecessor` are fixed in W2 (or in W8 `complete`) and never re-evaluated.
- **I4: Bounded automatic attempts.** Attempts are counted durably in W1. Automatic retries respect the budget. Only an explicit `recoverNode` `retry` may exceed it, and it is recorded.
- **I5: Terminal is final.** Nothing leaves `completed`, `failed` or `cancelled`. `needs-recovery` is not terminal; it leaves only through W8, W7 or W5 (cancel).
- **I6: A lost lease means silence.** After a lease loss or a conflict, the owner makes no writes. The next holder sees the last written state, and orphaned `running` nodes become `uncertain` (W6/W7).
- **I7: Stale results are ignored.** A result is applied only while its attempt is current (§4).
- **I8: Cancel meets crash.** A pending cancel request is honored by the next lease holder, whether through `cancel()` or `resume()`. `resume()` never starts attempts while a request exists.
- **I9: One terminal write.** The per-run queue serializes failure, cancellation and completion. The first processed decision wins, and none overwrites a terminal status.
- **I10: Uncertainty is explicit.** Every started attempt whose outcome umio cannot know becomes `uncertain`, never silently `failed` or `completed`. Automatic recovery happens only with `recovery: "retry"`.
- **I11: No exactly-once.** Effects may be applied without a completed node, or repeated by an explicit or opted-in retry. `idempotencyKey` is stable across attempts and recoveries.
- **I12: Time layers do not interfere.**
  - The node timeout is the only wall-clock limit on an attempt. Provider and transport limits for local providers are above it; queue waits count only toward the node timeout.
  - The lease depends on process liveness, not model progress.
  - The cancel poll is its own timer.
  - Tool-loop limits count steps, not time.

- **I13: The request limit never leaks slots.** A slot is released exactly once whenever a provider call settles: success, error, abort, or a consumer abandoning a stream. A call aborted while queued never takes a slot. Cache hits never take one.

**Checked combinations:**

| Scenario | Outcome |
|---|---|
| A 2.5 h local call with no output for 2 h | The lease renews every 10 s (I12). No timeout fires before 3 h. Provider limits are 3 h 5 min. The cancel poll runs every 2 s throughout. |
| A crash at 2 h into a call | Renewals stop, and the lease expires ≤ 30 s later. `resume()` → W6 → `uncertain` (`process-lost`) → `needs-recovery`, with no automatic retry (D13). |
| A cancel at 1 h into a call | Detected within about 2 s by the poll. The signal aborts the SDK request. A cooperative handler → `cancelled`; otherwise → `uncertain` after 10 s, and the run is `cancelled` either way. |
| The node timeout at 3 h | The signal aborts. If the attempt stops within grace → `failed`/`timeout` (retry per policy); otherwise → `uncertain`, then `needs-recovery` unless `recovery: "retry"`. |
| The provider timeout is misconfigured below the node timeout | A warning at setup (D12). Without it, the SDK error surfaces as a normal attempt failure, not retried for local providers (`maxRetries: 0`). |
| A lease is lost during cancellation | I6. The next holder sees the request (I8) and finalizes with W7. |
| A cancel during `needs-recovery` | W5/W7 → `cancelled`, with uncertain nodes kept (D13). |
| An observer drain timeout after `completed` | The status was persisted before the drain (D6), so it stays `completed`. |
| A version bump between crash and `recoverNode` | Rejected (D5). |
| An abandoned handler finishes later | Its result is discarded (I7). Its side effects may have happened (I11). |
| An abandoned handler still holds a request slot | The slot stays taken until its provider call settles (I13). Adapters pass the attempt's aborted signal to the SDK, so a cooperative model call settles promptly. A handler that ignores its signal but calls the model keeps the slot until that call ends, and this is documented. |
| A cancel while a call is queued | The signal aborts, the call leaves the queue unsent (I13), and the attempt ends `cancelled`. |
| A crash while calls are queued | Queued calls were never sent, so there is no server-side effect. Running attempts become `uncertain` on resume (D13). |
| A hosted `openai-compatible` gateway | Classified as not local, so it keeps its retries and unlimited concurrency (D15). |

## 9. Work breakdown

Each phase ends with `typecheck`, `lint` and `test` green, and is committed separately.

### P0: Characterization tests

Pin the current `Workflow` behavior in `test/workflow-compat.test.ts`:

- The exact event order (including `adr-proposed` and the `agent-event` wrapping).
- Awaited `onEvent`, and `onEvent` errors rejecting `run()`.
- Original error identity; no later steps after a failure.
- Abort during a step, and between steps: `step-start` is still emitted, then the run rejects.
- A throwing input function rejects before `step-start`.
- The `WorkflowResult` shape.

Acceptance: all pass against the unchanged code.

### P-T: Provider and transport time limits (can land before or in parallel with P1)

- **Config:** `ProviderConfig.local`, `maxConcurrentRequests` and `transport`; local classification (`src/llm/local.ts`); local defaults (`timeoutMs` 3 h 5 min, `maxRetries` 0, transport timeouts equal to `timeoutMs`, `maxConcurrentRequests` 1), with an undici `Agent` passed through `fetchOptions.dispatcher`. Adds an `undici` dependency pinned to the major bundled with the supported Node versions.
- **Limiter:** the FIFO limiter (`src/llm/limiter.ts`), wired into `LLM.callProvider` / `streamProvider` after the cache check.
- **Verification before building:** confirm the `fetchOptions` name in both installed SDKs (present in `openai` and `@anthropic-ai/sdk` as `MergedRequestInit`), and undici's actual defaults.
- **Documentation:** a "local long-running inference" configuration section (streaming, `maxConcurrency: 1`, timeouts).

Acceptance:
- Unit tests show local providers get the aligned options, and other providers are unchanged.
- An integration test against a local HTTP server that withholds headers shows the configured `headersTimeoutMs` (set to 1 s in the test) governs, instead of the undici default. A real 5-minute wait is not needed.
- A test shows that no retry happens after a timeout for local providers.
- **Classification:** `ollama` → local; `openai-compatible` at `http://localhost:1234/v1` or `http://192.168.1.5:8000/v1` → local; at `https://openrouter.ai/api/v1` → not local (retries and concurrency unchanged); explicit `local` wins either way.
- **Limiter:**
  - With `maxConcurrentRequests: 1`, parallel tool calls and `asTool` delegation inside one agent never have more than one provider call in flight (gated stub provider).
  - Waiting calls run in FIFO order.
  - A queued call aborted by its signal never reaches the provider and rejects with the abort error.
  - A stream holds its slot until it completes, and releases it when the consumer stops early.
  - Response-cache hits bypass the limiter.
  - Translator calls through `context.generate` share the limit.
  - After errors, aborts and early stream exits, the in-flight count returns to 0.
- An abort through `request.signal` closes the connection (the server observes the client disconnect).

### P1: Types, validation, identity, pure planning, adapter

`types.ts`, `errors.ts`, `validate.ts`, `identity.ts`, `plan.ts` (sequential subset), `adr-context.ts`, a minimal in-memory executor path, and the legacy adapter (§6).

Acceptance: P0 passes unchanged; the validator rejects every listed case; the hash is stable under key order and sensitive to structure.

### P2: DAG execution

Complete `plan.ts` (branches, joins with `selectedPredecessor`, transitive skips), the concurrency limit and D14 precedence (including the config `graph` section and `fromConfig`), `output.ts`, and `agentNode()`.

Acceptance: a diamond runs each node once; inactive branches are skipped; `join: "any"` is fixed and runs once; predicates are evaluated once; concurrency never exceeds the limit; `maxConcurrency: 1` from the config is not overridden by the default of 4; oversized or non-JSON output → non-retryable failure.

### P3: Checkpoint store, fenced CAS, owner timers

The `CheckpointStore` interface, `MemoryCheckpointStore`, the contract suite, the write queue, W0–W5, lease acquisition, renewal on its own timer, the cancel-poll timer (detection only; the full cancel flow is P5), lease-loss shutdown, and `test/support/fake-clock.ts`.

Acceptance: fencing (superseded token and expired-without-takeover are both `lease-lost`); every takeover increases the token; a failed W2 starts no successors; a conflict under a valid lease → `CheckpointConflictError`; a lease loss → no writes and `LeaseLostError`; the renewal count matches `elapsed / 10 s` under the fake clock.

### P4: Resume, uncertainty, explicit recovery, file store

`resume()` per §5, W6, W7 on the resume path, W8 and `recoverNode()`, `recovery: "retry"`, identity checks, and `FileCheckpointStore` (experimental) passing the contract suite.

Acceptance:
- **Crash simulations:** after W1, before the handler; after a side effect, before W2; after W2, before successors. Completed nodes are never re-run. Orphans → `uncertain`, then `needs-recovery`, with no attempt started.
- Each `recoverNode` action behaves per D13. `retry` reuses the `idempotencyKey`. `recovery: "retry"` retries automatically only within the budget.
- Terminal runs are rejected, and so are identity mismatches.
- The file store survives a restart simulation, and its guard rejects a second instance.

### P5: Timeouts, retry, cancellation, observer

Node timeout and inactivity timeout, `retry.ts`, the full D10 flow (`cancel()`, grace, abandonment → `uncertain`, W7 via `cancel()`), `GraphRunOptions.signal`, the D6 observer queue and shutdown order, and the D12 configuration validation and warnings.

Acceptance: the **multi-hour simulations in §10**; exact retry delays under the fake clock and random source; each `CancelAck` outcome; the cancel-versus-failure race → one terminal write; an observer that throws or hangs changes neither status nor scheduling; a drain timeout after `completed` leaves `completed`; pinned event order.

### P6: Deferred

Pause and approval, loops, `retryFailedRun()`, the transactional outbox, a reference database adapter (after contract verification), cross-version migration, the output redaction hook, and a built-in artifact store.

## 10. Test plan

| Layer | Approach |
|---|---|
| Pure (`validate`, `identity`, `plan`, `output`, `retry`) | Table-driven; no timers |
| Stores | The shared contract suite (`test/checkpoint-contract.ts`) run against `MemoryCheckpointStore` and `FileCheckpointStore`: create conflicts, CAS, fencing, acquire/renew/release/expiry, control record, schema errors, `delete` |
| Executor | Fake handlers and `test/support/fake-clock.ts`; gated promises for concurrency and races; no provider SDKs |
| Crash and recovery | Store wrappers and handlers that throw at named points; a new executor instance per simulated process |
| Compatibility | The P0 suite, unchanged through all phases |
| Provider limits | P-T unit and local-HTTP-server tests with short configured timeouts; local classification table |
| Request limiter | Stub providers with gated promises: in-flight maximum, FIFO order, aborts while queued, streams, slot release on every exit path, cache bypass |
| Agent wiring | `agentNode` with the scripted `ModelClient` from `test/agents.test.ts` |
| Manual live check | `examples/graph.ts` on the local Ollama setup: a diamond review with `maxConcurrency: 1` and streaming, with interrupt, `needs-recovery`, `recoverNode` and `resume` using `FileCheckpointStore` |

**Simulated multi-hour LLM operation (P5, fake clock; no real waiting).** A fake long-running handler (and an `agentNode` over a scripted `ModelClient` whose response resolves only when the fake clock reaches a target time) runs under an executor with default limits:

1. **The timeout does not fire early:** the target is 2 h 30 min, the clock advances in 1-minute steps, and the node completes with no timeout, abort or `node-retry`.
2. **The timeout fires at the limit:** with the target beyond 3 h, the signal aborts at exactly 3 h. A cooperative handler → `failed`/`timeout`. A non-cooperative one → `uncertain` (`abandoned-timeout`) after 10 s, then the run → `needs-recovery`.
3. **Leases keep renewing:** across 2 h 30 min, the store sees about 900 renewals (one per 10 s), the lease never expires, and the handler produces no output for the first 2 h (the prefill case).
4. **Cancellation is detected:** a `requestCancel` from a second executor at 1 h is detected within 2 s of fake time. The handler's signal aborts, the run → `cancelled`, and the second executor's `cancel()` returned `requested`. A second node's model call queued behind the long call (limit 1) leaves the queue unsent on cancel.
5. **A crash leaves the node uncertain:** at 2 h the owner is killed (its timers stop and no writes follow), and the clock advances 31 s. A new executor's `resume()` acquires the lease with a higher token; the node → `uncertain` (`process-lost`) and the run → `needs-recovery`, with no attempt started. Any write attempted by the old owner is rejected as `lease-lost`.
6. **Opt-in automatic recovery:** the same crash with `recovery: "retry"` and attempts remaining → `pending`, and the next attempt receives the same `idempotencyKey`.

## 11. Documentation

- **README "Graph workflows" section:**
  - definitions, joins, predicates;
  - checkpoints and `resume`;
  - uncertain nodes and `recoverNode`;
  - idempotency and the no-exactly-once caveat;
  - cancellation semantics and non-cooperative handlers;
  - observers and the drain;
  - `ArtifactRef` creation, resolution and ownership;
  - the experimental file store and the contract suite for adapter authors.
- **README "Local long-running inference" section:**
  - the time-limit layers table (D12);
  - local classification and its override;
  - the local defaults and why `maxRetries: 0`;
  - `maxConcurrentRequests`: its scope (per `LLM` instance and process), queue waits counting toward node timeouts, and the server-side queue;
  - recommended config: streaming and `graph.maxConcurrency: 1`;
  - the event-loop warning.
- **CLAUDE.md:** the `src/graph/` architecture and invariants I1–I12.
- **ADRs in `docs/adr`** (now versionable) recording D1–D15 once the plan is approved, at minimum for:
  - fencing and store scope (D2);
  - uncertain outcomes and explicit recovery (D13);
  - the time-limit layers (D12);
  - local providers and request concurrency (D15).
- **Roadmap:** state-graph workflows with the phase checklist.

## 12. Risks

| Risk | Mitigation |
|---|---|
| The adapter changes legacy behavior | P0 first; the adapter bypasses observers and the executor signal, and disables node timeouts (§6) |
| The new local defaults change behavior for existing local-provider users (no retries, longer timeouts, one request at a time) | Applied only to providers classified as local; explicit config always wins; documented as a behavior change |
| Local classification is wrong (e.g. a remote Ollama host, or a gateway reached through a private IP) | Explicit `local` overrides; classification uses only the configured host, with no DNS lookup; documented |
| A long call holds the only slot, so other model calls wait for hours | Intended serialization for modest hardware; queue waits count toward node timeouts (D12); `graph.maxConcurrency: 1` avoids cross-node waits; raise `maxConcurrentRequests` for stronger machines |
| undici options or SDK `fetchOptions` differ from what is assumed | Verified before building (P-T); integration test with a local server |
| The event loop is blocked by in-process CPU work, so the lease expires during a valid long run | LLM work is out of process; the documentation warns; a lease loss yields a safe `uncertain` state, never corruption |
| Local servers keep generating after a client disconnect | Verified per server in P-T; documented; the node still ends (`cancelled` or `uncertain`) |
| Uncooperative handlers keep running after cancel or timeout | Grace, then abandonment to `uncertain`; results discarded; documented |
| Too many runs park in `needs-recovery` and need operator work | Deliberate safety default; `recovery: "retry"` for idempotent nodes; the `run-needs-recovery` event for alerting |
| The file store is used across processes | Experimental, single-process label; best-effort guard; contract suite for real adapters |
| Artifacts are orphaned or deleted too early | Ownership rules (D4); `collectArtifactRefs`; no deletion before a terminal status |
| Several `LLM` instances or processes overload one local server | The limit is per instance and documented; the server's own queue still applies |
| Adding statuses later breaks exhaustive `switch`es | `RunStatus` documented as extensible; `schemaVersion` bump |

## 13. Open decisions

None. D1–D15 are settled. Formerly open:
- local provider defaults: adopted, with local classification (D15);
- `maxConcurrentRequests`: added (D15);
- `.gitignore`: `docs/` is no longer ignored (F9).
