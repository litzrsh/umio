// Writes schema/umio.config.schema.json from the Zod config schema, for editor
// autocomplete and validation of umio.config.json files.
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { UmioConfigSchema } from "../src/config/schema.js";

const schema = z.toJSONSchema(UmioConfigSchema, { io: "input", unrepresentable: "any" });
const out = new URL("../schema/umio.config.schema.json", import.meta.url);

await mkdir(new URL(".", out), { recursive: true });
await writeFile(out, `${JSON.stringify({ title: "umio config", ...schema }, null, 2)}\n`);
console.log(`Wrote ${out.pathname}`);
