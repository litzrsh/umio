/**
 * `SKILL.md` parsing: YAML frontmatter (`name`, `description`, nothing else)
 * followed by a nonempty Markdown body. Pure: bytes in, fields or problems out.
 */
import { isAlias, parseDocument, visit } from "yaml";

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1_024;
const FIELDS = new Set(["name", "description"]);

export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export type ParseResult =
  | { readonly ok: true; readonly skill: ParsedSkill }
  | { readonly ok: false; readonly problems: readonly { field?: string; message: string }[] };

/** Decodes strict UTF-8 text; undefined for invalid UTF-8 or NUL bytes (treated as binary). */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function isSkillName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_NAME_LENGTH && SKILL_NAME.test(name);
}

export function parseSkillDocument(bytes: Uint8Array): ParseResult {
  const text = decodeText(bytes);
  if (text === undefined) {
    return { ok: false, problems: [{ message: "is not UTF-8 text" }] };
  }
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return {
      ok: false,
      problems: [{ message: "must start with YAML frontmatter between --- lines" }],
    };
  }
  const problems: { field?: string; message: string }[] = [];
  const document = parseDocument(match[1] ?? "", {
    uniqueKeys: true,
    schema: "core",
    customTags: [],
    strict: true,
    prettyErrors: false,
  });
  for (const issue of [...document.errors, ...document.warnings]) {
    problems.push({ message: `invalid frontmatter: ${issue.message.split("\n")[0]}` });
  }
  let aliases = false;
  visit(document, {
    Node(_, node) {
      if (isAlias(node) || ("anchor" in node && node.anchor)) aliases = true;
    },
  });
  if (aliases)
    problems.push({ message: "invalid frontmatter: anchors and aliases are not allowed" });
  if (problems.length > 0) return { ok: false, problems };

  const data = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, problems: [{ message: "frontmatter must be a mapping" }] };
  }
  const fields = data as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!FIELDS.has(key)) problems.push({ field: key, message: "is not a supported field" });
  }
  const { name, description } = fields;
  if (!isSkillName(name)) {
    problems.push({
      field: "name",
      message: `is required: lowercase letters and digits in hyphen-separated words, at most ${MAX_NAME_LENGTH} characters`,
    });
  }
  if (typeof description !== "string" || !description.trim()) {
    problems.push({ field: "description", message: "is required and must be a nonempty string" });
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push({
      field: "description",
      message: `is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}`,
    });
  }
  const body = text.slice(match[0].length).trim();
  if (!body) problems.push({ message: "has no instructions after the frontmatter" });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    skill: { name: name as string, description: (description as string).trim(), body },
  };
}
