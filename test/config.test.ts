import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  interpolateEnv,
  loadConfig,
  parseConfig,
  resolveProviderConfig,
} from "../src/index.js";

const baseConfig = {
  defaultModel: "local",
  providers: {
    anthropic: { type: "anthropic", apiKey: "${ANTHROPIC_API_KEY}" },
    ollama: { type: "ollama" },
  },
  models: {
    smart: { provider: "anthropic", model: "claude-opus-5" },
    local: { provider: "ollama", model: "llama3.2" },
  },
};

describe("interpolateEnv", () => {
  it("replaces references in nested strings", () => {
    expect(interpolateEnv({ a: ["x-${FOO}-y"], b: 1 }, { FOO: "bar" })).toEqual({
      a: ["x-bar-y"],
      b: 1,
    });
  });

  it("uses the fallback when the variable is unset or empty", () => {
    expect(interpolateEnv("${NOPE:-http://localhost}", {})).toBe("http://localhost");
    expect(interpolateEnv("${EMPTY:-d}", { EMPTY: "" })).toBe("d");
  });

  it("names the path of a missing variable", () => {
    expect(() => interpolateEnv({ p: { key: "${MISSING}" } }, {})).toThrow(/MISSING.*p\.key/);
  });
});

describe("parseConfig", () => {
  it("accepts a valid config and leaves provider references unresolved", () => {
    const config = parseConfig(baseConfig, {});
    expect(config.defaultModel).toBe("local");
    expect(config.providers.anthropic).toEqual({
      type: "anthropic",
      apiKey: "${ANTHROPIC_API_KEY}",
    });
  });

  it("rejects models that point at unknown providers", () => {
    const raw = {
      ...baseConfig,
      models: { local: { provider: "nope", model: "x" } },
    };
    expect(() => parseConfig(raw, {})).toThrow(/models\.local\.provider: Unknown provider "nope"/);
  });

  it("rejects an unknown default model", () => {
    expect(() => parseConfig({ ...baseConfig, defaultModel: "gone" }, {})).toThrow(/defaultModel/);
  });

  it("rejects misspelled keys", () => {
    const raw = {
      ...baseConfig,
      providers: { ...baseConfig.providers, ollama: { type: "ollama", baseUrl: "x" } },
    };
    expect(() => parseConfig(raw, {})).toThrow(ConfigError);
  });

  it("requires baseURL for openai-compatible providers", () => {
    const raw = {
      ...baseConfig,
      providers: { ...baseConfig.providers, ollama: { type: "openai-compatible" } },
    };
    expect(() => parseConfig(raw, {})).toThrow(/providers\.ollama\.baseURL/);
  });
});

describe("resolveProviderConfig", () => {
  it("resolves env references for one provider", () => {
    const config = parseConfig(baseConfig, {});
    const anthropic = config.providers.anthropic;
    if (!anthropic) throw new Error("fixture");
    expect(resolveProviderConfig("anthropic", anthropic, { ANTHROPIC_API_KEY: "sk-test" })).toEqual(
      { type: "anthropic", apiKey: "sk-test" },
    );
    expect(() => resolveProviderConfig("anthropic", anthropic, {})).toThrow(
      /ANTHROPIC_API_KEY.*providers\.anthropic\.apiKey/,
    );
  });
});

describe("loadConfig", () => {
  it("reads and validates a JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "umio-"));
    const file = join(dir, "umio.config.json");
    await writeFile(file, JSON.stringify(baseConfig));
    await expect(loadConfig(file, {})).resolves.toMatchObject({ defaultModel: "local" });
  });

  it("reports invalid JSON and missing files as ConfigError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "umio-"));
    const file = join(dir, "broken.json");
    await writeFile(file, "{ nope");
    await expect(loadConfig(file, {})).rejects.toThrow(/not valid JSON/);
    await expect(loadConfig(join(dir, "missing.json"), {})).rejects.toBeInstanceOf(ConfigError);
  });

  it("resolves a relative file cache path against the config file's directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "umio-"));
    const file = join(dir, "umio.config.json");
    await writeFile(
      file,
      JSON.stringify({ ...baseConfig, responseCache: { store: "file", path: ".umio/cache" } }),
    );
    const config = await loadConfig(file, {});
    expect(config.responseCache).toEqual({ store: "file", path: join(dir, ".umio/cache") });
  });

  it("accepts the example config shipped in the repo", async () => {
    await expect(loadConfig("umio.config.example.json", {})).resolves.toBeDefined();
  });
});
