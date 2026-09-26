// Writes schema/umio.config.schema.json from the Zod config schema, for editor
// autocomplete and validation of umio.config.json files.
// With --check, writes nothing and exits 1 if the file is out of date (CI, releases).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { UmioConfigSchema } from "../src/config/schema.js";

const schema = z.toJSONSchema(UmioConfigSchema, { io: "input", unrepresentable: "any" });
const out = new URL("../schema/umio.config.schema.json", import.meta.url);
const text = `${JSON.stringify({ title: "umio config", ...schema }, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(out, "utf8").catch(() => "");
  if (current !== text) {
    console.error(`${out.pathname} is out of date; run npm run schema and commit it.`);
    process.exit(1);
  }
  console.log(`${out.pathname} is up to date.`);
} else {
  await mkdir(new URL(".", out), { recursive: true });
  await writeFile(out, text);
  console.log(`Wrote ${out.pathname}`);
}
