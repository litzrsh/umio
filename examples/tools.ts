// Usage: cp umio.config.example.json umio.config.json
//        npx tsx examples/tools.ts [model-alias]
import { z } from "zod";
import { LLM, runToolLoop, tool } from "../src/index.js";

const getWeather = tool({
  name: "get_weather",
  description: "Returns the current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City name, e.g. Seoul"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  annotations: { readOnly: true },
  execute: async ({ city, unit }) => {
    const celsius = 10 + (city.length % 15); // stand-in for a real weather API
    return { city, temperature: unit === "celsius" ? celsius : celsius * 1.8 + 32, unit };
  },
});

const llm = await LLM.fromFile(process.env.UMIO_CONFIG);
const alias = process.argv[2];

const result = await runToolLoop(llm, {
  ...(alias && { model: alias }),
  messages: [{ role: "user", content: "Is it warmer in Seoul or in Busan right now?" }],
  tools: [getWeather],
  stream: true,
  onEvent: (event) => {
    if (event.type === "text-delta") process.stdout.write(event.text);
    if (event.type === "tool-result") {
      const { call, result } = event.execution;
      console.error(`\n[tool] ${call.name}(${JSON.stringify(call.input)}) -> ${result.content}`);
    }
  },
});

console.error(
  `\n[${result.result.model}] steps=${result.steps.length} stop=${result.stopReason} in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
);
