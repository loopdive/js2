// Diagnostic only: retain located repairs, compile errors, and exact source IDs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(process.argv[2]);
const { compile } = await import(pathToFileURL(resolve(root, "src/index.ts")).href);
const { getFixupEvents } = await import(pathToFileURL(resolve(root, "src/codegen/stack-balance.ts")).href);
for (const file of ["website/playground/examples/benchmarks.ts", "website/playground/examples/benchmarks/helpers.ts"]) {
  const fileName = resolve(root, file);
  const source = readFileSync(fileName, "utf8");
  const result = await compile(source, { fileName });
  console.log(
    JSON.stringify({
      root,
      file,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      success: result.success,
      errors: result.errors,
      events: getFixupEvents(),
    }),
  );
}
