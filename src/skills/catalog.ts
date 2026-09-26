/**
 * Discovery and loading of local skill packages. Only the given roots are
 * scanned, one level deep: each immediate child directory with a `SKILL.md`
 * is a skill. Canonical paths stay private to the catalog.
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SkillChangedError, SkillError, SkillSelectionError } from "./errors.js";
import { readBounded, resolveResource, sha256 } from "./files.js";
import { decodeText, parseSkillDocument } from "./parse.js";
import { prepareSkills } from "./prepare.js";
import {
  DEFAULT_SKILL_LIMITS,
  type LoadedSkill,
  type PreparedSkills,
  type PrepareOptions,
  type SkillCatalog,
  type SkillDiagnostic,
  type SkillLimits,
  type SkillManifest,
  type SkillSelection,
  type SkillSummary,
  type SkillUsage,
} from "./types.js";

export interface LoadSkillCatalogOptions {
  /** Directories whose immediate children are skills. Relative roots resolve against `baseDir`. */
  readonly roots: readonly string[];
  /** Base for relative roots, e.g. the config file's directory. Required: never the process's implicit cwd. */
  readonly baseDir: string;
  readonly limits?: Partial<SkillLimits>;
  readonly signal?: AbortSignal;
}

interface Entry {
  readonly summary: SkillSummary;
  /** Canonical skill directory. */
  readonly dir: string;
  readonly document: string;
}

/** What a catalog hands to preparations; not part of the public API. */
export interface CatalogAccess {
  readonly limits: SkillLimits;
  has(name: string): boolean;
  names(): readonly string[];
  summary(name: string): SkillSummary | undefined;
  dir(name: string): string;
  /**
   * The document, checked against the catalog digest: the parsed skill and
   * the full text, both from the exact bytes read. `reserve(size)` runs
   * synchronously once the file size is known, before its content is read,
   * and may throw to refuse.
   */
  read(
    name: string,
    signal?: AbortSignal,
    reserve?: (size: number) => void,
  ): Promise<{ skill: LoadedSkill; bytes: number; text: string }>;
  /** Whether `file` is the skill's `SKILL.md` (the same file, whatever its spelling). */
  isDocument(name: string, file: string): Promise<boolean>;
}

/**
 * Scans the roots and validates every `SKILL.md`. Problems do not reject:
 * they are collected in `catalog.diagnostics` (file, field, message), invalid
 * packages are left out of `list()`, and `prepare()` refuses to run until the
 * catalog is valid. Rejects only for invalid options, cancellation or
 * unexpected I/O errors.
 */
export async function loadSkillCatalog(options: LoadSkillCatalogOptions): Promise<SkillCatalog> {
  const limits = checkLimits({ ...DEFAULT_SKILL_LIMITS, ...definedOnly(options.limits ?? {}) });
  if (typeof options.baseDir !== "string" || !options.baseDir) {
    throw new SkillError("loadSkillCatalog needs a baseDir for relative roots.");
  }
  const roots = [...new Set(options.roots.map((root) => resolve(options.baseDir, root)))].sort();
  const diagnostics: SkillDiagnostic[] = [];
  const entries = new Map<string, Entry>();
  const firstSeen = new Map<string, string>();

  for (const root of roots) {
    options.signal?.throwIfAborted();
    let rootDir: string;
    try {
      const info = await stat(root);
      if (!info.isDirectory()) {
        diagnostics.push({ path: root, message: "skill root is not a directory" });
        continue;
      }
      rootDir = await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      diagnostics.push({ path: root, message: "skill root does not exist" });
      continue;
    }
    const children = (await readdir(rootDir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const child of children) {
      options.signal?.throwIfAborted();
      const dir = join(rootDir, child.name);
      if (child.isSymbolicLink()) {
        const target = await stat(dir).catch(() => undefined);
        if (target?.isDirectory()) {
          diagnostics.push({
            path: dir,
            message: "symbolic links to skill directories are not followed",
          });
        }
        continue;
      }
      if (!child.isDirectory()) continue;
      const document = join(dir, "SKILL.md");
      const info = await lstat(document).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) continue; // not a skill
      if (info.isSymbolicLink() || !info.isFile()) {
        diagnostics.push({
          path: document,
          message: "SKILL.md must be a regular file, not a link",
        });
        continue;
      }
      const read = await readBounded(document, limits.maxDocumentBytes, {
        ...(options.signal && { signal: options.signal }),
      });
      if (!read.ok) {
        diagnostics.push({
          path: document,
          message:
            read.reason === "too-large"
              ? `is ${read.size} bytes; the limit is ${limits.maxDocumentBytes} (maxDocumentBytes)`
              : "SKILL.md must be a regular file",
        });
        continue;
      }
      const parsed = parseSkillDocument(read.bytes);
      if (!parsed.ok) {
        for (const problem of parsed.problems) {
          diagnostics.push({
            path: document,
            ...(problem.field && { field: problem.field }),
            message: problem.message,
          });
        }
        continue;
      }
      const { name, description } = parsed.skill;
      if (name !== child.name) {
        diagnostics.push({
          path: document,
          field: "name",
          message: `"${name}" must match its directory name "${child.name}"`,
        });
        continue;
      }
      const previous = firstSeen.get(name);
      if (previous) {
        diagnostics.push({
          path: document,
          field: "name",
          message: `duplicate skill "${name}" (also in ${previous}); names must be unique across roots`,
        });
        entries.delete(name);
        continue;
      }
      firstSeen.set(name, document);
      entries.set(name, {
        summary: Object.freeze({ name, description, digest: sha256(read.bytes) }),
        dir,
        document,
      });
    }
  }
  if (firstSeen.size > limits.maxCatalogEntries) {
    diagnostics.push({
      path: roots.join(", "),
      message: `${firstSeen.size} skills found; the limit is ${limits.maxCatalogEntries} (maxCatalogEntries)`,
    });
  }
  return new LocalSkillCatalog(
    new Map([...entries].sort(([a], [b]) => (a < b ? -1 : 1))),
    Object.freeze(diagnostics.map((item) => Object.freeze(item))),
    Object.freeze(limits),
  );
}

class LocalSkillCatalog implements SkillCatalog {
  private readonly access: CatalogAccess;

  constructor(
    private readonly entries: ReadonlyMap<string, Entry>,
    readonly diagnostics: readonly SkillDiagnostic[],
    readonly limits: SkillLimits,
  ) {
    const require = (name: string): Entry => {
      const entry = this.entries.get(name);
      if (!entry) throw new SkillSelectionError(`Unknown skill "${name}".${this.available()}`);
      return entry;
    };
    this.access = {
      limits,
      has: (name) => this.entries.has(name),
      names: () => [...this.entries.keys()],
      summary: (name) => this.entries.get(name)?.summary,
      dir: (name) => require(name).dir,
      read: async (name, signal, reserve) => {
        const entry = require(name);
        const read = await readBounded(entry.document, limits.maxDocumentBytes, {
          ...(signal && { signal }),
          ...(reserve && { reserve }),
        });
        if (!read.ok || sha256(read.bytes) !== entry.summary.digest) {
          throw new SkillChangedError(
            `Skill "${name}" changed since the catalog was loaded (${entry.document}); load the catalog again to use the new version.`,
          );
        }
        const parsed = parseSkillDocument(read.bytes);
        const text = decodeText(read.bytes);
        if (!parsed.ok || text === undefined) {
          throw new SkillChangedError(`Skill "${name}" is no longer valid.`);
        }
        return {
          skill: Object.freeze({ ...entry.summary, body: parsed.skill.body }),
          bytes: read.bytes.length,
          text,
        };
      },
      isDocument: async (name, file) => {
        const entry = require(name);
        const [a, b] = await Promise.all([stat(file), stat(entry.document)]).catch(() => []);
        return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
      },
    };
  }

  list(): readonly SkillSummary[] {
    return [...this.entries.values()].map((entry) => entry.summary);
  }

  async load(name: string, signal?: AbortSignal): Promise<LoadedSkill> {
    return (await this.access.read(name, signal)).skill;
  }

  prepare(selection: SkillSelection, options: PrepareOptions = {}): Promise<PreparedSkills> {
    return prepareSkills(this.access, this.diagnostics, selection, options);
  }

  async verify(manifest: SkillManifest, signal?: AbortSignal): Promise<void> {
    if (manifest?.version !== 1 || !Array.isArray(manifest.skills)) {
      throw new SkillError("Unsupported skill manifest (expected version 1).");
    }
    const problems: string[] = [];
    for (const used of manifest.skills) {
      signal?.throwIfAborted();
      const entry = this.entries.get(used.name);
      if (!entry) {
        problems.push(`skill "${used.name}" is no longer in the catalog`);
        continue;
      }
      try {
        await this.access.read(used.name, signal);
      } catch (error) {
        if (!(error instanceof SkillChangedError)) throw error;
        problems.push(`skill "${used.name}": SKILL.md changed on disk`);
        continue;
      }
      if (entry.summary.digest !== used.documentDigest) {
        problems.push(`skill "${used.name}": SKILL.md differs from the recorded version`);
      }
      for (const resource of used.resources) {
        let digest: string | undefined;
        try {
          const { file } = await resolveResource(entry.dir, resource.path);
          const read = await readBounded(file, this.limits.maxResourceBytes, {
            ...(signal && { signal }),
          });
          if (read.ok) digest = sha256(read.bytes);
        } catch (error) {
          if (!(error instanceof SkillError)) throw error;
        }
        if (digest !== resource.digest) {
          problems.push(
            `skill "${used.name}": ${resource.path} ${digest === undefined ? "is missing or unreadable" : "changed"}`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new SkillChangedError(
        `Skill content differs from what the run used:\n${problems.map((item) => `  - ${item}`).join("\n")}\nRestore those files, or start a new run.`,
      );
    }
  }

  private available(): string {
    const names = [...this.entries.keys()];
    return names.length ? ` Available: ${names.join(", ")}.` : " The catalog has no skills.";
  }
}

function checkLimits(limits: SkillLimits): SkillLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new SkillError(`Skill limit ${key} must be a positive integer, got ${value}.`);
    }
  }
  return limits;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

/** A JSON manifest of what an invocation used, for keeping beside results or checkpoints. */
export function skillManifest(usage: readonly SkillUsage[]): SkillManifest {
  return {
    version: 1,
    skills: usage.map((item) => ({
      name: item.name,
      documentDigest: item.documentDigest,
      resources: item.resources.map((resource) => ({
        path: resource.path,
        digest: resource.digest,
      })),
    })),
  };
}
