// Acorn standalone compile probe (#1712 / #2847).
//
// Kept in a child process because compiling the 230 KB parser graph needs a
// substantially larger heap than Vitest's normal worker. The source is the
// same committed, integrity-checked acorn@8.16.0 tarball used by the host
// differential corpus.

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { derivationFlagEnabled } from "../../src/derivation-flags.ts";
import { compile } from "../../src/index.ts";
import { setupAcorn } from "./setup-acorn.mjs";

function describeDiagnostic(diagnostic) {
  if (diagnostic == null) return String(diagnostic);
  if (typeof diagnostic === "string") return diagnostic;
  const message = diagnostic.messageText ?? diagnostic.message ?? diagnostic;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

export async function compileStandaloneAcorn() {
  const { entryModulePath, version } = setupAcorn();
  const packageSource = readFileSync(entryModulePath, "utf-8");

  // Keep the public `parse(nativeString, options) -> AST` export untouched and
  // add a no-argument in-module canary. A JS host cannot manufacture the
  // parser's private native-string carrier directly, so this wrapper executes
  // the package without adding a host marshalling bridge.
  const source = `${packageSource}
export function __acorn_runtime_canary() {
  const ast = parse("1 + 2", { ecmaVersion: 2025, sourceType: "script" });
  const statement = ast.body[0];
  const expression = statement.expression;
  return ast.type === "Program" &&
    ast.body.length === 1 &&
    statement.type === "ExpressionStatement" &&
    expression.type === "BinaryExpression" &&
    expression.operator === "+" &&
    expression.left.value === 1 &&
    expression.right.value === 2 ? 2 : -1;
}
export function __acorn_parse_expression_at_canary() {
  const expression = parseExpressionAt("xx 1 + 2 yy", 3, {
    ecmaVersion: 2025,
    sourceType: "script"
  });
  return expression.type === "BinaryExpression" &&
    expression.operator === "+" &&
    expression.start === 3 &&
    expression.end === 8 &&
    expression.left.value === 1 &&
    expression.right.value === 2 ? 3 : -1;
}
export function __acorn_tokenizer_canary() {
  const stream = tokenizer("42", { ecmaVersion: 2025, sourceType: "script" });
  const token = stream.getToken();
  const eof = stream.getToken();
  return token.type.label === "num" &&
    token.value === 42 &&
    token.start === 0 &&
    token.end === 2 &&
    eof.type.label === "eof" ? 4 : -1;
}
export function __acorn_function_body_canary() {
  const ast = parse("function f(a,b) { return a + b; }", {
    ecmaVersion: 2025,
    sourceType: "script"
  });
  const declaration = ast.body[0];
  const returnStatement = declaration.body.body[0];
  const expression = returnStatement.argument;
  return ast.type === "Program" &&
    ast.body.length === 1 &&
    declaration.type === "FunctionDeclaration" &&
    declaration.id.name === "f" &&
    declaration.params.length === 2 &&
    declaration.params[0].name === "a" &&
    declaration.params[1].name === "b" &&
    returnStatement.type === "ReturnStatement" &&
    expression.type === "BinaryExpression" &&
    expression.operator === "+" &&
    expression.left.name === "a" &&
    expression.right.name === "b" ? 5 : -1;
}
`;

  const started = performance.now();
  const result = await compile(source, {
    fileName: "acorn.mjs",
    // (#743) `.d.ts` entrypoint seeding measurement lane: when the flag is on,
    // hand the compiler the SHIPPED declaration file (`dist/acorn.d.mts`, a
    // byte-for-byte copy of `dist/acorn.d.ts`) so exported entrypoints
    // (`parse(input: string, options: Options)`, …) seed their implicit-`any`
    // params from it. The entry here is in-memory (`fileName: "acorn.mjs"` is
    // virtual), so on-disk sibling discovery cannot fire — the explicit option
    // is the honest equivalent. Flag off: option absent, byte-identical
    // compile.
    //
    // (#743 defaults flip, 2026-08-08) The flag is now ON when UNSET, so this
    // condition uses the family's token rule rather than `=== "1"`. Getting
    // that wrong would make the harness's default lane compile with seeding
    // enabled but no declarations supplied — i.e. silently measure the flag-off
    // artifact while reporting it as the shipped default.
    ...(derivationFlagEnabled(process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS)
      ? { entryDeclarations: readFileSync(entryModulePath.replace(/\.mjs$/, ".d.mts"), "utf-8") }
      : {}),
    skipSemanticDiagnostics: true,
    target: "standalone",
    // (#3673 round 30) Dogfood the SHIPPED configuration: the CLI defaults to
    // `-O3` (cli.ts "Builds opt in by default at -O3"), so an unoptimized
    // artifact here measured something nobody ships. Binaryen is worth a
    // measured 7.1% on this artifact post-#3683-S3 (it was ~0% pre-S2 — the
    // monomorphic direct calls are what give it something to inline), and it
    // also shrinks the binary ~30%. `optimizeBinaryAsync` validates its own
    // output and falls back to the raw binary with a warning, so this can
    // only change performance, never correctness.
    optimize: 3,
  });
  const compileMs = Math.round(performance.now() - started);
  const errors = (result.errors ?? []).map(describeDiagnostic);

  if (!result.binary?.length) {
    return {
      acornVersion: version,
      success: false,
      compileMs,
      binaryBytes: 0,
      errors,
      runtimeCanary: null,
      parseExpressionAtCanary: null,
      tokenizerCanary: null,
      functionBodyCanary: null,
      functionBodyCanaryError: null,
      functionImports: [],
      exports: [],
    };
  }

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module);
  let runtimeCanary = null;
  let parseExpressionAtCanary = null;
  let tokenizerCanary = null;
  let functionBodyCanary = null;
  let functionBodyCanaryError = null;
  if (result.success && imports.length === 0) {
    const { exports } = await WebAssembly.instantiate(module, {});
    runtimeCanary = exports.__acorn_runtime_canary();
    parseExpressionAtCanary = exports.__acorn_parse_expression_at_canary();
    tokenizerCanary = exports.__acorn_tokenizer_canary();
    try {
      functionBodyCanary = exports.__acorn_function_body_canary();
    } catch (error) {
      functionBodyCanaryError = error?.stack ?? error?.message ?? String(error);
    }
  }

  return {
    acornVersion: version,
    success: result.success,
    compileMs,
    binaryBytes: result.binary.length,
    errors,
    runtimeCanary,
    parseExpressionAtCanary,
    tokenizerCanary,
    functionBodyCanary,
    functionBodyCanaryError,
    functionImports: imports
      .filter((entry) => entry.kind === "function")
      .map((entry) => `${entry.module}::${entry.name}`),
    exports: WebAssembly.Module.exports(module)
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name),
  };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  compileStandaloneAcorn()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify(
          {
            success: false,
            errors: [error?.stack ?? error?.message ?? String(error)],
            functionImports: [],
            exports: [],
          },
          null,
          2,
        )}\n`,
      );
    });
}
