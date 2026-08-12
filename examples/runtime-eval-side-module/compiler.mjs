// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Replaceable compiler capability for the #3630 proof of concept.
 *
 * Today this calls the full js2wasm compiler in the host process. A future
 * self-hosted Acorn + dynamic-IR compiler can replace this provider without
 * changing the broker's WebAssembly-facing import ABI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSourceSync } from "../../src/compiler.js";
import { EVAL_EXPORT_NAME } from "./broker.mjs";

export function compileEvalExpression(source) {
  if (typeof source !== "string") throw new TypeError("eval source must be a string");

  const wrappedSource = `export function ${EVAL_EXPORT_NAME}(): number { return (${source}); }`;
  const result = compileSourceSync(wrappedSource, {
    fileName: "runtime-eval-side-module.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });

  if (!result.success) {
    const diagnostics = result.errors
      .filter((error) => error.severity === "error")
      .map((error) => error.message)
      .join("; ");
    throw new SyntaxError(diagnostics || "runtime eval compilation failed");
  }

  const module = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(
      `runtime eval side module must be standalone; found imports: ${imports
        .map(({ module: namespace, name }) => `${namespace}::${name}`)
        .join(", ")}`,
    );
  }
  if (!WebAssembly.Module.exports(module).some(({ name }) => name === EVAL_EXPORT_NAME)) {
    throw new Error(`runtime eval side module does not export ${EVAL_EXPORT_NAME}`);
  }
  return result.binary;
}

// Native-host CLI: source arrives on stdin and Wasm is written to a named file.
// Keeping binary output off stdout makes compiler diagnostics unambiguous.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("usage: compiler.mjs <output.wasm>");
  const source = readFileSync(0, "utf8");
  writeFileSync(resolve(outputPath), compileEvalExpression(source));
}
