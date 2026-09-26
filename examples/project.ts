// Usage: npx tsx examples/project.ts [model-alias] "question about this repository"
// Uses the config's "tools" section, e.g.
//   "tools": { "repo": { "use": "files", "root": ".", "readOnly": true }, "misc": { "use": "utilities" } }
import { z } from "zod";
import { Agent, commandTool, createToolsets, LLM } from "../src/index.js";

const llm = await LLM.fromFile(process.env.UMIO_CONFIG);
const toolsets = createToolsets(llm.config);
const model = process.argv[2];
const question =
  process.argv[3] ?? "What does runToolLoop default maxSteps to, and where is that defined?";

// Wrapping an external CLI: the model picks the query, never the program.
const codeSearch = commandTool({
  name: "code_search",
  description: "Semantic code search over this repository (graft). Returns ranked code locations.",
  command: "graft",
  parameters: z.object({ query: z.string().describe("What you are looking for.") }),
  args: ({ query }) => ["ask", query],
  cwd: llm.config.configDir ?? ".",
  annotations: { readOnly: true },
});

const agent = new Agent({
  name: "CodeGuide",
  role: "Answers questions about this codebase by reading it. Cite file paths.",
  instructions: "Answer in at most 5 sentences.",
  ...(model && { model }),
  tools: [...Object.values(toolsets).flatMap((set) => [...set]), codeSearch],
});

const result = await agent.run(question, {
  llm,
  onEvent: (event) => {
    if (event.type === "tool-result") {
      console.error(
        `[tool] ${event.execution.call.name} ${JSON.stringify(event.execution.call.input)}`,
      );
    }
  },
});
console.log(result.text);
console.error(
  `\n[${result.steps.length} steps, in=${result.usage.inputTokens} out=${result.usage.outputTokens}]`,
);
