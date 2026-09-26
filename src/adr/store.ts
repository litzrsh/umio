import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UmioError } from "../errors.js";

export interface Adr {
  number: number;
  title: string;
  /** Free text, e.g. "Accepted", "Proposed", "Superseded by ADR-0012". */
  status: string;
  date?: string;
  file: string;
  /** The full Markdown document. */
  content: string;
}

export interface AdrProposal {
  title: string;
  /** The forces at play: why a decision is needed. */
  context: string;
  /** The decision, in active voice ("We will ..."). */
  decision: string;
  /** What becomes easier or harder as a result. */
  consequences: string;
  /** Number of an ADR this one would replace. */
  supersedes?: number;
}

const FILE_PATTERN = /^(\d{4})-[^/]*\.md$/;
export const DEFAULT_ADR_STATUSES = ["Accepted"];

/**
 * Architecture Decision Records stored as Markdown files named NNNN-title.md
 * (Michael Nygard's format: title, date, Status, Context, Decision,
 * Consequences). Reads tolerate common variants: a "## Status" section or a
 * "Status: ..." line, and titles like "# 3. Title" or "# ADR-0003: Title".
 */
export class AdrStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** All records, sorted by number. A missing directory means no records. */
  async list(): Promise<Adr[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      files.filter((file) => FILE_PATTERN.test(file)).map((file) => this.read(file)),
    );
    return records.sort((a, b) => a.number - b.number);
  }

  async get(number: number): Promise<Adr | undefined> {
    return (await this.list()).find((adr) => adr.number === number);
  }

  /** Records whose status starts with one of `statuses` (case-insensitive). */
  async withStatus(statuses: readonly string[] = DEFAULT_ADR_STATUSES): Promise<Adr[]> {
    const wanted = statuses.map((status) => status.toLowerCase());
    return (await this.list()).filter((adr) =>
      wanted.some((status) => adr.status.toLowerCase().startsWith(status)),
    );
  }

  /**
   * The records as a system-prompt section agents must follow, or undefined
   * when there are none. Ordered by number, so the text is stable across calls
   * and cacheable by the provider.
   */
  async context(statuses: readonly string[] = DEFAULT_ADR_STATUSES): Promise<string | undefined> {
    const records = await this.withStatus(statuses);
    if (records.length === 0) return undefined;
    return [
      "# Architecture Decision Records",
      "",
      "These decisions are binding for this project. Follow them. If your work requires departing from one, say so explicitly and propose a new ADR that supersedes it instead of silently deviating.",
      "",
      ...records.map(
        (adr) =>
          `<adr number="${adr.number}" status="${adr.status}">\n${adr.content.trim()}\n</adr>`,
      ),
    ].join("\n");
  }

  /** Writes a new record with status "Proposed" and the next free number. */
  async propose(proposal: AdrProposal, date: Date = new Date()): Promise<Adr> {
    await mkdir(this.dir, { recursive: true });
    const status = proposal.supersedes
      ? `Proposed (supersedes ADR-${pad(proposal.supersedes)})`
      : "Proposed";
    // Retry on a number taken concurrently: `wx` refuses to overwrite.
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = ((await this.list()).at(-1)?.number ?? 0) + 1;
      const file = `${pad(number)}-${slug(proposal.title)}.md`;
      const content = render(number, proposal, status, isoDate(date));
      try {
        await writeFile(join(this.dir, file), content, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      return { number, title: proposal.title, status, date: isoDate(date), file, content };
    }
    throw new UmioError(`Could not allocate an ADR number in ${this.dir}.`);
  }

  private async read(file: string): Promise<Adr> {
    const content = await readFile(join(this.dir, file), "utf8");
    const number = Number(FILE_PATTERN.exec(file)?.[1]);
    const date = /^Date:\s*(.+)$/im.exec(content)?.[1]?.trim();
    return {
      number,
      title: parseTitle(content) ?? file,
      status: parseStatus(content) ?? "Unknown",
      ...(date && { date }),
      file,
      content,
    };
  }
}

function parseTitle(content: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return heading?.replace(/^(ADR[-\s]?)?\d+[.:]?\s*/i, "").trim() || heading;
}

function parseStatus(content: string): string | undefined {
  const section = /^##\s+Status\s*\n+([^\n#][^\n]*)/im.exec(content)?.[1];
  const line = /^Status:\s*(.+)$/im.exec(content)?.[1];
  return (section ?? line)?.trim();
}

function render(number: number, proposal: AdrProposal, status: string, date: string): string {
  return `# ${number}. ${proposal.title}

Date: ${date}

## Status

${status}

## Context

${proposal.context.trim()}

## Decision

${proposal.decision.trim()}

## Consequences

${proposal.consequences.trim()}
`;
}

function pad(number: number): string {
  return String(number).padStart(4, "0");
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "decision"
  );
}
