import { defineConfig } from "tsup";

// tsup's declaration build injects `baseUrl`, which TypeScript 6 deprecates.
// TypeScript 7 (native) has no JS API, so tsup cannot generate declarations with it.
const dtsOptions = { compilerOptions: { ignoreDeprecations: "6.0" } };

export default defineConfig([
  {
    // ESM: the library and the `umio` CLI share chunks, so a workflow module
    // that imports "@litzrsh/umio" gets the same classes as the CLI running it.
    entry: { index: "src/index.ts", cli: "src/cli/main.ts" },
    format: ["esm"],
    splitting: true,
    dts: { entry: "src/index.ts", ...dtsOptions },
    sourcemap: true,
    target: "node20",
    // Optional peer dependency, loaded only for a PostgreSQL store.
    external: ["pg"],
  },
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: { entry: "src/index.ts", ...dtsOptions },
    sourcemap: true,
    target: "node20",
    external: ["pg"],
  },
]);
