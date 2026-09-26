/**
 * Skill contracts (docs/design/umio-skills-design.md). A skill is a local
 * directory with a `SKILL.md` (YAML frontmatter with `name` and
 * `description`, then Markdown instructions) and optional text resources.
 * Applying a skill gives an agent guidance; it never grants tools or permissions.
 */
import type { Tool } from "../tools/tool.js";

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  /** SHA-256 (hex) of the original `SKILL.md` bytes. */
  readonly digest: string;
}

export interface LoadedSkill extends SkillSummary {
  /** The Markdown instructions, without the frontmatter. */
  readonly body: string;
}

/**
 * Byte limits (UTF-8 bytes; not model tokens). Each says what it bounds:
 * filesystem reads of one file, system-prompt text, or text returned by tools.
 */
export interface SkillLimits {
  /** Skills in one catalog. Default 100. */
  readonly maxCatalogEntries: number;
  /** Filesystem: one `SKILL.md` is never read beyond this. Default 64 KiB. */
  readonly maxDocumentBytes: number;
  /** Filesystem: one resource file is never read beyond this. Default 128 KiB. */
  readonly maxResourceBytes: number;
  /** System prompt: the text one preparation adds. Default 256 KiB. */
  readonly maxContextBytes: number;
  /**
   * Tool output: the complete responses of `skills_load` and `skills_read` in
   * one invocation, generated wrapper text and repeats included; a response
   * that does not fit is refused, never truncated. Before reading a file, a
   * call reserves the least it could return (for `skills_read`, the file's
   * size, which is what it returns; for `skills_load`, its wrapper text), so
   * a call that cannot fit is refused after a size check, without reading
   * content. After reading, the reservation is settled to the exact response
   * size atomically (concurrent calls never oversubscribe), and a failed call
   * releases it. How much a call may read from disk is bounded by the per-file
   * limits above, not by this budget. Default 1 MiB.
   */
  readonly maxReadBytes: number;
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = Object.freeze({
  maxCatalogEntries: 100,
  maxDocumentBytes: 64 * 1024,
  maxResourceBytes: 128 * 1024,
  maxContextBytes: 256 * 1024,
  maxReadBytes: 1024 * 1024,
});

/** Which skills one invocation may use. */
export interface SkillSelection {
  /** The permitted subset of the catalog. Empty permits nothing; it never means "all". */
  readonly include: readonly string[];
  /** Skills whose instructions are put in the system prompt before the first model call. */
  readonly activate?: readonly string[];
  /**
   * Also list the other permitted skills and offer `skills_load`, so the model
   * can load one it finds relevant. Default false.
   */
  readonly allowModelSelection?: boolean;
}

/** What one invocation used: documents and the resources actually read, with their digests. */
export interface SkillUsage {
  readonly name: string;
  readonly documentDigest: string;
  readonly resources: readonly { readonly path: string; readonly digest: string }[];
}

/** Reported to `SkillBinding.onEvent` / `prepare({ onEvent })`. Never contains document bodies. */
export type SkillEvent =
  | {
      readonly type: "skills-prepared";
      readonly include: readonly string[];
      readonly activated: readonly { readonly name: string; readonly digest: string }[];
      readonly modelSelection: boolean;
      readonly contextBytes: number;
    }
  | {
      readonly type: "skill-loaded";
      readonly name: string;
      readonly digest?: string;
      readonly bytes?: number;
      readonly outcome: "ok" | "error";
      readonly error?: string;
    }
  | {
      readonly type: "skill-resource-read";
      readonly name: string;
      readonly path: string;
      readonly digest?: string;
      readonly bytes?: number;
      readonly outcome: "ok" | "error";
      readonly error?: string;
    };

/** Skill context and tools for exactly one agent invocation. */
export interface PreparedSkills {
  /** System-prompt sections to append to the caller's context (after ADRs). */
  readonly context: string[];
  /** `skills_read`, and `skills_load` with model selection; empty when nothing is active or loadable. */
  readonly tools: Tool[];
  /** An immutable snapshot of what was used so far. */
  usage(): readonly SkillUsage[];
}

export interface PrepareOptions {
  readonly signal?: AbortSignal;
  /** Diagnostics; a callback that throws never changes the invocation. */
  readonly onEvent?: (event: SkillEvent) => void;
}

export interface SkillDiagnostic {
  /** The file or directory concerned. */
  readonly path: string;
  /** The frontmatter field concerned, if any. */
  readonly field?: string;
  readonly message: string;
}

export interface SkillCatalog {
  /** Valid skills, by name. */
  list(): readonly SkillSummary[];
  /** Problems found while loading; `prepare()` refuses to run while there are any. */
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly limits: SkillLimits;
  /** Reads a skill's instructions; rejects if `SKILL.md` changed since the catalog was loaded. */
  load(name: string, signal?: AbortSignal): Promise<LoadedSkill>;
  /** Context and tools for one invocation. Create a fresh preparation per agent run. */
  prepare(selection: SkillSelection, options?: PrepareOptions): Promise<PreparedSkills>;
  /** Rejects with `SkillChangedError` unless every document and resource in the manifest is unchanged. */
  verify(manifest: SkillManifest, signal?: AbortSignal): Promise<void>;
}

/** A JSON record of the skill content an invocation used, e.g. to keep with a node's output. */
export interface SkillManifest {
  readonly version: 1;
  readonly skills: readonly SkillUsage[];
}
