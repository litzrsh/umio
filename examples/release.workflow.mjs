// Approval and a bounded loop, for the umio CLI:
//   umio graph run examples/release.workflow.mjs --input "Add rate limiting to the upload API." --run-id rel-1
//   umio graph approvals rel-1                       # what is being asked, with the draft
//   umio graph reject rel-1 'plan#1/review' --comment "Cover the admin endpoints too."
//   umio graph resume examples/release.workflow.mjs rel-1   # drafts again, asks again
//   umio graph approve rel-1 'plan#2/review'
//   umio graph resume examples/release.workflow.mjs rel-1   # announces the approved plan
// With the file store this runs on one machine; with a PostgreSQL store
// (see examples/umio.postgres.config.json) anyone sharing the database can
// approve while the run is paused, from any machine.
import { Agent, agentNode } from "umio";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Inside a loop, predecessors are keyed by iteration ID ("plan#2/draft"): look one up by body ID. */
const from = (context, bodyId) =>
  Object.entries(context.predecessors).find(([key]) => key.endsWith(`/${bodyId}`))?.[1];

/** @param {{ llm: import("umio").ModelClient }} context */
export default ({ llm }) => {
  const planner = new Agent({
    name: "Planner",
    role: "Writes short implementation plans.",
    instructions:
      "Answer with at most 5 numbered steps. If the task mentions reviewer feedback, address it.",
  });
  const announcer = new Agent({
    name: "Announcer",
    role: "Writes a two-sentence announcement of an approved plan.",
  });
  const draft = agentNode(planner, {
    llm,
    adr: false,
    stream: true,
    // Each iteration sees the reviewer's comment on the previous draft.
    task: (context) => {
      const previous = context.loop?.previous?.result;
      const feedback = previous?.comment
        ? `\n\nReviewer feedback on the last draft: ${previous.comment}`
        : "";
      return `Plan this change: ${context.input}${feedback}`;
    },
  });

  return {
    graph: {
      id: "release",
      version: "1",
      entry: ["plan"],
      nodes: [
        {
          id: "plan",
          // Draft, then ask a person; repeat until approved, at most 3 times.
          loop: {
            body: {
              entry: ["draft"],
              nodes: [
                { id: "draft", handler: "draft", timeoutMs: SIX_HOURS },
                // The iteration's output: the draft with the decision on it.
                { id: "result", handler: "result" },
                {
                  id: "review",
                  approval: {
                    title: "Approve this plan?",
                    description: "Reject with a comment to get a revised draft.",
                    onReject: "continue",
                  },
                },
              ],
              edges: [
                { from: "draft", to: "review" },
                { from: "draft", to: "result" },
                // onReject "continue" needs a condition on each outgoing edge; this one always holds.
                { from: "review", to: "result", when: "decided" },
              ],
            },
            until: "approved",
            maxIterations: 3,
          },
        },
        { id: "announce", handler: "announce", timeoutMs: SIX_HOURS },
      ],
      edges: [{ from: "plan", to: "announce" }],
    },
    handlers: {
      draft,
      result: async (context) => {
        const review = from(context, "review");
        return {
          plan: from(context, "draft")?.text ?? "",
          approved: review?.approved === true,
          ...(review?.comment && { comment: review.comment }),
        };
      },
      announce: agentNode(announcer, {
        llm,
        adr: false,
        stream: true,
        task: (context) =>
          `Announce this approved plan:\n${context.predecessors.plan?.outputs?.result?.plan}`,
      }),
    },
    predicates: {
      decided: () => true,
      approved: (output) => output.result?.approved === true,
    },
  };
};
