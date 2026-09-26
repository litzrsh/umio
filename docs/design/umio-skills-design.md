# Umio Skills Design Proposal

- Status: Phases 1–3 implemented, plus the manifest API of phase 4 (`skillManifest`, `SkillCatalog.verify`); automatic verification on graph retry/resume is not implemented. Implementation record: [`docs/works/2026-09-27-010113-skills-feature.md`](../works/2026-09-27-010113-skills-feature.md).
- Baseline: Existing `Agent`, `Toolset`, tool loop, sequential `Workflow`, and graph `agentNode` APIs.
- Goal: Add reusable, file-based agent instructions and supporting resources without coupling skills to a model provider or replacing the execution engine.

## 1. Scope and principles

A skill is a named package containing a `SKILL.md` instruction document and optional references, scripts, and assets. Applying a skill gives an agent task-specific guidance. It does not create another agent, execute a workflow, or grant permissions.

The first release supports local skill directories, explicit selection, bounded resource reads, and library integration. Later releases add model-driven selection, configuration, and CLI support. Remote installation, marketplaces, dependency resolution, executable plugins, and automatic script execution are outside this proposal.

This document defines an Umio format and behavior. It does not claim compatibility with every external `SKILL.md` convention. Compatibility with a specific ecosystem requires separate format fixtures and validation.

Core principles:

1. Preserve existing behavior when skills are absent.
2. Keep discovery and file I/O outside the synchronous `Agent` constructor.
3. Separate available skills, selected skills, and authorized tools.
4. Load only the instructions and resources needed for the current execution.
5. Keep skill selection and content identity observable and reproducible.

## 2. Existing integration points

| Existing code | Reuse in the proposed design |
| --- | --- |
| `src/agents/agent.ts`: `AgentConfig.instructions` | Standing agent instructions remain independent of skills. |
| `src/agents/agent.ts`: `AgentRunOptions.context` | Supply explicitly selected skill bodies as system-prompt sections. |
| `src/agents/agent.ts`: `AgentRunOptions.extraTools` | Add bounded skill-reading tools for one invocation. |
| `src/agents/adr-context.ts` | Follow the existing pattern of resolving external context and associated tools. |
| `src/agents/workflow.ts` and `src/graph/agent-node.ts` | Compose skill context with ADR context at agent invocation boundaries. |
| `src/cli/chat.ts`: `runChatTurn` | Pass prepared skill context and tools through the existing approval and event path. |
| `src/config/schema.ts`: `UmioConfigSchema` | Add an optional validated configuration section. Unknown keys are currently rejected. |

`Agent.run()` currently combines the agent's tools with `extraTools` and builds its system prompt from `context`, role, and instructions. It does not discover skills. The first phase therefore needs an adapter layer, not a new tool-loop protocol.

## 3. Package format and discovery

```text
skills/
  code-review/
    SKILL.md
    references/checklist.md
    scripts/check.sh
    assets/report-template.md
```

Example `SKILL.md`:

```markdown
---
name: code-review
description: Review code changes for correctness and missing regression tests.
---

Inspect the changed behavior and its callers before proposing a fix.
Read references/checklist.md when checking test coverage.
Report findings with file locations and a concrete failure scenario.
```

Use YAML frontmatter with required `name` and `description`, followed by a nonempty Markdown body. Names must match `[a-z0-9]+(?:-[a-z0-9]+)*` and be at most 64 characters. Limit descriptions to 1,024 characters. Use a maintained YAML parser with custom tags disabled; reject duplicate keys and unsupported frontmatter fields in the initial format.

Each configured root contains immediate child directories with a `SKILL.md`; discovery does not recursively scan arbitrary repositories. The frontmatter name must match the directory name. Sort roots and entries deterministically and reject duplicate names across roots rather than silently overriding a package.

Only explicitly supplied roots are scanned. Do not implicitly load home-directory skills or search ancestor directories. Relative configuration paths resolve against `configDir`; programmatic callers provide an explicit base directory.

Discovery parses bounded `SKILL.md` files to validate metadata but exposes only summaries to the model. References, scripts, and assets remain unread until requested. Invalid packages produce diagnostics identifying the file and field. Preparing an execution fails if its configured catalog is invalid.

## 4. Proposed library contracts

These are proposed public contracts; names may change during implementation.

```ts
interface SkillSummary {
  name: string;
  description: string;
  digest: string; // SHA-256 of the original SKILL.md bytes
}

interface LoadedSkill extends SkillSummary {
  body: string; // Markdown without frontmatter
}

interface SkillLimits {
  maxCatalogEntries: number; // default: 100
  maxDocumentBytes: number; // default: 64 KiB
  maxResourceBytes: number; // default: 128 KiB
  maxContextBytes: number; // default: 256 KiB per preparation
  maxReadBytes: number; // default: 1 MiB per invocation
}

interface SkillSelection {
  include: readonly string[]; // allowed catalog subset
  activate?: readonly string[]; // eagerly load these bodies
  allowModelSelection?: boolean; // default: false
}

interface SkillUsage {
  name: string;
  documentDigest: string;
  resources: readonly { path: string; digest: string }[];
}

interface PreparedSkills {
  context: string[];
  tools: Tool[];
  usage(): readonly SkillUsage[];
}

interface SkillCatalog {
  list(): readonly SkillSummary[];
  load(name: string, signal?: AbortSignal): Promise<LoadedSkill>;
  prepare(
    selection: SkillSelection,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedSkills>;
}
```

Add `loadSkillCatalog({ roots, baseDir, limits, signal })` to create a catalog asynchronously. Keep canonical filesystem paths private to its implementation. Unknown names and activation outside `include` fail before the model runs. Empty `include` enables nothing; it never means all skills. Deduplicate names and render selected bodies in name order.

Initial usage requires no new `Agent` fields:

```ts
const catalog = await loadSkillCatalog({
  roots: ["./skills"],
  baseDir: process.cwd(),
});
const prepared = await catalog.prepare({
  include: ["code-review"],
  activate: ["code-review"],
});

const result = await reviewer.run(task, {
  llm,
  context: [...sharedContext, ...prepared.context],
  extraTools: [...existingExtraTools, ...prepared.tools],
  hooks,
  signal,
});
```

Create a fresh preparation for each agent invocation. Immutable catalog metadata may be shared; read budgets, activation records, and resource usage must not leak between concurrent agents.

## 5. Selection and prompt composition

Support two paths:

- **Explicit activation:** Load `activate` bodies before the first model request. This is the initial release and the preferred path for predictable workflows.
- **Model selection:** Present summaries for `include` and offer `skills_load`. The model chooses whether a skill is relevant and reads its body through a normal tool result. This adds a tool round trip and is not guaranteed to select the ideal skill.

When model selection is disabled, unactivated entries are not advertised. Explicitly activated bodies are wrapped with the skill name, digest, and relative-resource instructions. Preserve the current system layout: caller context and ADRs, skill sections, then the agent's role and standing instructions. State that skill guidance must respect application constraints and tool permissions; prompt ordering alone is not enforcement.

`skills_load({ name })` only accepts names from the allowed subset. Its result identifies the document and contains its body. Do not mutate the running system prompt or toolset in response to this call. The existing tool-result message carries the new instructions to the next model step.

`skills_read({ name, path })` reads a UTF-8 text resource from an activated skill. Loading a body activates it for the invocation; resources requested before activation return a recoverable tool error. In a parallel batch, dependent reads may need to be retried after `skills_load` completes. Reserve both tool names and reject collisions before execution.

Do not silently truncate instructions or resources. Reject reads or preparations exceeding limits with actionable errors. Byte budgets bound I/O and prompt growth but are not exact model-token budgets. Repeated reads count toward the invocation budget, with accounting reserved before asynchronous reads to prevent parallel oversubscription.

## 6. Resources, scripts, and authority

Resource paths resolve against the owning skill directory, never the process working directory. Reject absolute paths, traversal outside the root, symlink entries, nonregular files, and binary resources. Validate path components and the opened file, and read at most the allowed bytes plus one to detect oversized inputs.

Treat skill roots as application-controlled, stable directories during execution. Path checks are not an operating-system sandbox against a hostile process concurrently modifying the filesystem; stronger isolation belongs to the deployment environment.

Scripts are resources, not automatic entry points. A skill may describe how to invoke a script, but execution requires an independently supplied command tool and its existing allowlist and approval policy. Skill frontmatter cannot create tools, change tool annotations, bypass hooks, expand file roots, or mark an operation as approved.

Mark the skill-reading tools as read-only and keep them inside normal tool hooks. Application code determines which skill roots may be exposed. An existing general-purpose file tool remains subject to its own scope; skill selection does not narrow or expand that separate tool's access.

## 7. Configuration and CLI integration

Proposed optional configuration:

```json
{
  "skills": {
    "roots": ["./skills"],
    "include": ["code-review", "test-design"],
    "activate": ["code-review"],
    "allowModelSelection": false
  }
}
```

This is a fragment of `umio.config.json`, not a complete configuration. Require explicit `include` whenever `skills` is present; allow an empty list. Expose optional positive integer limits using the defaults above. Regenerate `schema/umio.config.schema.json` after adding the Zod schema.

Keep catalog loading in application adapters rather than the `LLM` constructor. Generic `ModelClient` implementations must work without Umio configuration or filesystem access.

Proposed CLI behavior:

- `umio skills list`: validate configured roots and display permitted skill summaries.
- `umio skills show <name>`: display a permitted skill's instructions and digest.
- `umio ask --skill code-review "Review these changes"`: explicitly activate a permitted skill; repeat the flag for multiple skills.
- `--no-skills`: disable skill context and reading tools for that invocation.

An explicit `--skill` list replaces configured activation but cannot expand `include`. Combining `--skill` and `--no-skills` is a usage error. Existing `--tools` selection continues to control ordinary tools independently.

For interactive chat, freeze the catalog for the session and re-prepare configured activation each turn. Skill bodies loaded through tools remain in conversation history under existing session rules. Do not assume past tool results grant activation in a new invocation: resource reads require current activation. If future history compaction removes skill content, reload it before relying on it.

## 8. Workflow integration and reproducibility

Add optional runtime skill bindings to `WorkflowOptions` and `AgentNodeOptions` after the standalone adapter is stable. Each binding contains a catalog and selection. Sequential workflows may supply a default binding with a per-step replacement; `false` disables it. Graph node bindings are explicit per node. Do not implicitly union selections, because that can expose more skills than the caller intended.

Prepare skills at the agent invocation boundary and append their context and tools to ADR context and tools. Preserve hooks, cancellation, state, streaming, and existing event forwarding. Delegated agents receive their own bindings; parent skills are not inherited automatically.

The first release does not add skill state to graph checkpoints. Applications using durable runs must pin immutable skill packages and change `definitionVersion` whenever those packages change. Until automatic validation exists, document this as an application responsibility, not an enforced resume guarantee.

A later durable integration should persist a JSON manifest containing selected document digests and the paths and digests of resources actually read. It must verify content before retry or resume and fail on mismatches instead of silently accepting changed guidance. A `SKILL.md` digest alone cannot identify referenced resources. Catalog objects, tools, and filesystem handles remain runtime objects and must never enter checkpoints.

Record preparation and reads through an optional skill-specific callback and `usage()`. Include names, digests, relative paths, byte counts, and outcomes; omit document bodies from telemetry by default. Normal reading tools already produce tool-loop events. Graph adapters may translate skill callbacks into node events without making the graph executor depend on skills. Diagnostic callback failures must not change execution outcomes.

## 9. Errors and cancellation

Use errors derived from `UmioError` for invalid catalogs, missing skills, changed documents, and preparation limits. Translate configuration failures into existing CLI diagnostics. Errors during `skills_load` or `skills_read` become ordinary error tool results so the model can correct a name or path.

Honor the invocation's `AbortSignal` during preparation and resource access. Reject changed `SKILL.md` content relative to the catalog digest; refresh only by explicitly loading a new catalog. On the first resource read, record its digest; subsequent reads in that invocation must match. Do not cache failed or cancelled loads. Return immutable usage snapshots so callers cannot change internal records.

## 10. Implementation plan

| Phase | Deliverables | Completion criteria |
| --- | --- | --- |
| 1. Local explicit skills | `src/skills/{types,parse,catalog,prepare,index}.ts`, bounded reads, `skills_read`, public exports | An existing agent applies selected instructions and reads a reference without changing provider adapters or the tool loop. |
| 2. Model selection | `skills_load`, summary rendering, activation bookkeeping and diagnostics | Only permitted skills can be loaded; parallel reads and budgets behave deterministically. |
| 3. Application integration | Agent context adapter, workflow/node bindings, config schema, CLI commands and flags | CLI, sequential workflows, and graph nodes compose skills with existing tools and ADRs. |
| 4. Durable content identity | Versioned JSON manifest and retry/resume checks | Changed documents or previously used resources block resumption with a useful diagnostic. |

Keep parsing, filesystem loading, prompt rendering, and tool construction separate. Add examples demonstrating explicit use and model selection, and document configuration in `README.md`. No changes to provider SDK adapters are expected.

## 11. Validation strategy

Use Vitest and temporary directories; no live model or network is required.

- Parser and catalog tests: malformed YAML, duplicate keys and names, invalid names, empty bodies, stable ordering, unknown fields, and size limits.
- Resource tests: relative paths, traversal, symlinks, binary files, changed content, cumulative limits, parallel reads, and cancellation.
- Agent tests: system sections, coexistence with standing instructions and ADR context, duplicate tool names, missing skills, and unchanged requests when disabled.
- Selection tests: summaries without eager body injection, explicit activation, model loading, rejected unauthorized names, and resources requiring activation.
- Integration tests: mocked multi-step model calls, preserved approval hooks, per-agent isolation, delegated agents, sequential workflows, graph nodes, and chat continuation.
- CLI/config tests: path resolution, invalid selections, flag precedence, JSON output, and no permission expansion from document content.
- Durable-phase tests: manifest serialization, restart against identical content, changed resource rejection, and no runtime objects in checkpoints.

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` for implementation changes. Run `npm run schema` when configuration changes and verify the generated schema. Refresh the Graft graph after substantial code changes.

## 12. Deferred decisions

Evaluate external format compatibility, optional metadata fields, remote package acquisition, and automatic relevance ranking after the local API has usage evidence. Binary asset delivery requires a separate provider-neutral representation. A dedicated script runner needs its own process, permission, timeout, and output-limit design; it should not be hidden inside skill activation.
