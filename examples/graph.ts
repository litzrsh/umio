// Usage: npx tsx examples/graph.ts [model-alias] "request"
// A diamond review: research → (design ‖ security) → merge. The security branch
// runs only when research flags risk. Concurrency comes from the config's
// `graph.maxConcurrency` (1 recommended for a single local model).
import { Agent, agentNode, LLM, type WorkflowDefinition, WorkflowExecutor } from "../src/index.js";

const llm = await LLM.fromFile(process.env.UMIO_CONFIG);
const model = process.argv[2];
const request =
  process.argv[3] ??
  "Review this plan: store user-uploaded files on the web server's local disk and serve them directly.";

const agent = (name: string, role: string) =>
  new Agent({
    name,
    role,
    instructions: "Answer in at most 5 bullet points.",
    ...(model && { model }),
  });

const definition: WorkflowDefinition = {
  graph: {
    id: "architecture-review",
    version: "1",
    entry: ["research"],
    nodes: [
      { id: "research", handler: "research" },
      { id: "design", handler: "design" },
      { id: "security", handler: "security" },
      { id: "merge", handler: "merge" },
    ],
    edges: [
      { from: "research", to: "design" },
      { from: "research", to: "security", when: "flagsRisk" },
      { from: "design", to: "merge" },
      { from: "security", to: "merge" },
    ],
  },
  handlers: {
    research: agentNode(
      agent(
        "Researcher",
        "Summarizes the request and its main concerns. End with a line 'RISK: yes' or 'RISK: no' for security risk.",
      ),
      { llm, adr: false },
    ),
    design: agentNode(agent("Designer", "Proposes a better design."), { llm, adr: false }),
    security: agentNode(agent("SecurityReviewer", "Lists concrete security problems."), {
      llm,
      adr: false,
    }),
    merge: agentNode(agent("Editor", "Merges the reviews into one recommendation."), {
      llm,
      adr: false,
    }),
  },
  predicates: {
    flagsRisk: (output) => /RISK:\s*yes/i.test((output as { text: string }).text),
  },
};

const executor = WorkflowExecutor.fromConfig(llm.config, {
  onNodeEvent: (nodeId, _attempt, event) => {
    if (event.type === "agent-event" && event.event.type === "step-finish") {
      console.error(`[${nodeId}] model call finished`);
    }
  },
});
const run = await executor.run(definition, request);

for (const [id, node] of Object.entries(run.nodes)) {
  console.error(
    `- ${id}: ${node.status}${node.selectedPredecessor ? ` (from ${node.selectedPredecessor})` : ""}`,
  );
}
console.log(
  `\n${(run.nodes.merge?.output as { text?: string } | undefined)?.text ?? run.error?.message}`,
);
