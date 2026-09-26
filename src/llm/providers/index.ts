import type { ProviderConfig } from "../../config/schema.js";
import type { LLMProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

export const createProvider: ProviderFactory = (config) => {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
    case "openai-compatible":
    case "ollama":
      return new OpenAIProvider(config);
  }
};

export { AnthropicProvider } from "./anthropic.js";
export { OLLAMA_DEFAULT_BASE_URL, OpenAIProvider } from "./openai.js";
