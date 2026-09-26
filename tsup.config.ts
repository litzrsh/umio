import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // tsup's declaration build injects `baseUrl`, which TypeScript 6 deprecates.
  // TypeScript 7 (native) has no JS API, so tsup cannot generate declarations with it.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  target: "node20",
});
