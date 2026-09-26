# Changelog

All notable changes to `@litzrsh/umio` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0.0, minor versions may
contain breaking changes.

## Unreleased

## 0.1.0

First public release.

- **Models:**
  - one `LLM` API over Anthropic, OpenAI, OpenAI-compatible servers and Ollama, with streaming;
  - JSON configuration with `${VAR}` references;
  - defaults for local providers (multi-hour timeouts, no retries, one request at a time).
- **Tools:** Zod-defined tools, the tool loop, hooks, toolsets, and built-in tools for files, the web, commands, SQL and utilities.
- **Caching and middleware:** provider prompt caching, a response cache, a middleware pipeline (including a prompt translator), and per-model harnesses.
- **Agents:** agents, sequential workflows, delegation, and Architecture Decision Records.
- **Graph workflows:** checkpointed runs with retries, timeouts, cancellation, crash recovery, approvals, bounded loops, and memory, file and PostgreSQL checkpoint stores.
- **Skills:** file-based instruction packages with explicit or model-selected activation.
- **CLI:** the `umio` command for chat, one-shot prompts, `doctor`, skills, and graph workflow operations.
