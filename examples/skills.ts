// Usage: npx tsx examples/skills.ts [model-alias] ["change description"]
//        (uses ./umio.config.json, or UMIO_CONFIG=<path>)
//
// Skills from examples/skills, applied two ways:
// 1. Explicit activation: code-review's instructions go into the system prompt.
// 2. Model selection: the model sees summaries of the permitted skills and may
//    load one with skills_load (and read its files with skills_read).
import { Agent, LLM, loadSkillCatalog, withSkills } from "../src/index.js";

const llm = await LLM.fromFile(process.env.UMIO_CONFIG);
const model = process.argv[2];
const change =
  process.argv[3] ??
  "In the retry helper, `attempt` now starts at 0 instead of 1, and the delay is `base * 2 ** attempt`. No tests changed.";

const catalog = await loadSkillCatalog({
  roots: ["skills"],
  baseDir: new URL(".", import.meta.url).pathname,
});
if (catalog.diagnostics.length > 0) {
  for (const item of catalog.diagnostics) console.error(`${item.path}: ${item.message}`);
  process.exit(1);
}
console.error(
  `Skills: ${catalog
    .list()
    .map((skill) => skill.name)
    .join(", ")}`,
);

const agent = new Agent({
  name: "Assistant",
  role: "Helps with software changes.",
  instructions: "Be brief.",
  ...(model && { model }),
});
const onEvent = (event: { type: string }) => console.error(`[skill] ${JSON.stringify(event)}`);

console.error("\n=== 1. Explicit activation (code-review) ===");
{
  const { options, prepared } = await withSkills(
    agent,
    { llm },
    { catalog, selection: { include: ["code-review"], activate: ["code-review"] }, onEvent },
  );
  const result = await agent.run(`Review this change:\n${change}`, options);
  console.log(result.text);
  console.error(`used: ${JSON.stringify(prepared?.usage())}`);
}

console.error("\n=== 2. Model selection (code-review or commit-message) ===");
{
  const { options, prepared } = await withSkills(
    agent,
    { llm },
    {
      catalog,
      selection: { include: ["code-review", "commit-message"], allowModelSelection: true },
      onEvent,
    },
  );
  const result = await agent.run(`Write a commit message for this change:\n${change}`, options);
  console.log(result.text);
  console.error(`used: ${JSON.stringify(prepared?.usage())}`);
}
