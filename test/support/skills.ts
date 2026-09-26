/** Temporary skill trees and a scripted model for the skills suites. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelClient,
  StreamEvent,
  ToolCallPart,
} from "../../src/index.js";

const dirs: string[] = [];

export async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umio-skills-"));
  dirs.push(dir);
  return dir;
}

export async function cleanup(): Promise<void> {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

export function skillDocument(name: string, body: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} guidance for tests.\n${extra}---\n\n${body}\n`;
}

/** Writes files relative to `root`: path → content. */
export async function writeTree(root: string, files: Record<string, string | Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

export function text(value: string): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text: value }] },
    text: value,
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "fake",
    raw: null,
  };
}

export function calls(...toolCalls: ToolCallPart[]): GenerateResult {
  return {
    message: { role: "assistant", content: toolCalls },
    text: "",
    toolCalls,
    finishReason: "tool-calls",
    rawFinishReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "fake",
    raw: null,
  };
}

export const call = (id: string, name: string, input: unknown): ToolCallPart => ({
  type: "tool-call",
  id,
  name,
  input,
});

/** Returns the scripted results in order and records each request. */
export function scripted(...results: GenerateResult[]) {
  const requests: GenerateRequest[] = [];
  const next = (request: GenerateRequest) => {
    requests.push(structuredClone({ ...request, signal: undefined }));
    const result = results.shift();
    if (!result) throw new Error("script exhausted");
    return result;
  };
  const model: ModelClient = {
    generate: async (request) => next(request),
    async *stream(request): AsyncGenerator<StreamEvent> {
      const result = next(request);
      if (result.text) yield { type: "text-delta", text: result.text };
      yield { type: "finish", result };
    },
  };
  return { model, requests };
}

/** The system prompt as one string. */
export function systemText(request: GenerateRequest | undefined): string {
  const system = request?.system;
  if (!system) return "";
  return typeof system === "string" ? system : system.map((part) => part.text).join("\n---\n");
}

/** Tool results in the last request, by call ID. */
export function toolResults(
  request: GenerateRequest | undefined,
): Record<string, { content: string; isError?: boolean }> {
  const results: Record<string, { content: string; isError?: boolean }> = {};
  for (const message of request?.messages ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      results[part.toolCallId] = { content: part.content, ...(part.isError && { isError: true }) };
    }
  }
  return results;
}
