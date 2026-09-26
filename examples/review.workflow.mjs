// A workflow module for the umio CLI:
//   umio graph run examples/review.workflow.mjs --input "Store uploads on the web server's disk."
// The default export receives the CLI's model client and config, so agent
// nodes share its request limits. Import "umio" as a package (not from source)
// so the module and the CLI use the same library instance.
import { Agent, agentNode } from "umio";

/** @param {{ llm: import("umio").ModelClient, config: import("umio").UmioConfig }} context */
export default ({ llm }) => {
  const agent = (name, role) =>
    new Agent({ name, role, instructions: "Answer in at most 3 short bullet points." });
  const node = (name, role) => agentNode(agent(name, role), { llm, adr: false, stream: true });

  return {
    graph: {
      id: "review",
      version: "1",
      entry: ["research"],
      nodes: [
        // Agent nodes make several model calls: give them a node timeout that
        // covers the whole agent run, not just one request (null = none).
        { id: "research", handler: "research", timeoutMs: 6 * 60 * 60 * 1000 },
        { id: "design", handler: "design", timeoutMs: 6 * 60 * 60 * 1000 },
        { id: "merge", handler: "merge", timeoutMs: 6 * 60 * 60 * 1000 },
      ],
      edges: [
        { from: "research", to: "design" },
        { from: "design", to: "merge" },
      ],
    },
    handlers: {
      research: node("Researcher", "Summarizes the request and its main risks."),
      design: node("Designer", "Proposes a better design."),
      merge: node("Editor", "Merges the notes into one recommendation."),
    },
    predicates: {},
  };
};
