// Usage: cp umio.config.example.json umio.config.json
//        npx tsx examples/chat.ts [model-alias] "prompt"
import { LLM } from "../src/index.js";

const [alias, prompt = "In one sentence, what is an AI agent?"] =
  process.argv.length > 3 ? process.argv.slice(2) : [undefined, process.argv[2]];

const llm = await LLM.fromFile(process.env.UMIO_CONFIG);
const result = await llm.generate({
  ...(alias && { model: alias }),
  messages: [{ role: "user", content: prompt ?? "" }],
});

console.log(result.text);
console.error(
  `\n[${result.model}] finish=${result.finishReason} in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
);
