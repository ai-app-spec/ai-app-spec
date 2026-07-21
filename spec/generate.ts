import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import {
  appManifestStructuralSchema,
  jsonSchemaId,
} from "./v0.1/app.ts";

const outputPath = fileURLToPath(
  new URL("./v0.1/app.schema.json", import.meta.url),
);

function generateJsonSchema(): string {
  const generatedSchema = z.toJSONSchema(appManifestStructuralSchema, {
    target: "draft-2020-12",
  });

  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: jsonSchemaId,
      ...generatedSchema,
    },
    null,
    2,
  )}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";

  if (args.length > 0 && !check) {
    console.error("Usage: bun run generate [--check]");
    process.exitCode = 2;
    return;
  }

  const generated = generateJsonSchema();

  if (check) {
    const existing = await readFile(outputPath, "utf8").catch(() => undefined);
    if (existing !== generated) {
      console.error(
        "Generated JSON Schema is stale. Run `bun run generate` from spec/.",
      );
      process.exitCode = 1;
    }
    return;
  }

  await writeFile(outputPath, generated);
  console.log(`Generated ${outputPath}`);
}

await main();
