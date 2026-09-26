// Usage: cp umio.config.example.json umio.config.json   (set "adr": { "path": "docs/adr" })
//        npx tsx examples/workflow.ts [model-alias] "task"
import { Agent, LLM, Workflow } from "../src/index.js";

const llm = await LLM.fromFile(process.env.UMIO_CONFIG);
const model = process.argv[2];
const task =
  process.argv[3] ??
  "Design the storage layer for a small note-taking service: where notes live and how they are backed up.";

const architect = new Agent({
  name: "Architect",
  role: "Designs systems. Checks the project's ADRs first and follows them; proposes a new ADR for each significant decision you make.",
  instructions: "Answer with a short design (at most 8 bullet points).",
  ...(model && { model }),
});
const reviewer = new Agent({
  name: "Reviewer",
  role: "Reviews designs for conflicts with the project's accepted ADRs and for risks.",
  instructions: "List concrete problems, or say the design is consistent. At most 5 bullet points.",
  ...(model && { model }),
});

const run = await new Workflow({
  llm,
  onEvent: (event) => {
    if (event.type === "step-start") console.error(`\n=== ${event.step} ===`);
    if (event.type === "adr-proposed") {
      console.error(
        `[adr] proposed ADR-${event.adr.number}: ${event.adr.title} (${event.adr.file})`,
      );
    }
    if (event.type === "agent-event" && event.event.type === "tool-result") {
      console.error(`[tool] ${event.event.execution.call.name}`);
    }
    if (event.type === "step-finish") console.log(event.result.text);
  },
})
  .step(architect)
  .step(reviewer, {
    input: ({ input, outputs }) => `Task: ${input}\n\nProposed design:\n${outputs.Architect}`,
  })
  .run(task);

console.error(
  `\n[workflow] steps=${run.steps.length} proposed ADRs=${run.proposedAdrs.length} in=${run.usage.inputTokens} out=${run.usage.outputTokens}`,
);
