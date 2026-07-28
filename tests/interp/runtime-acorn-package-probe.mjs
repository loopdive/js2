// #2928 E6 — real Acorn + interpreter provider packaging probe.
//
// Acorn and the import-clean interpreter sources are compiled as ONE source
// unit. This gives the provider exactly one ordered initializer without relying
// on compileMulti's current per-source initializer ownership (#3525), and keeps
// ESTree objects inside the provider rather than exposing them as a link ABI.
//
// The source assembly + compile options now live in
// scripts/runtime-eval-provider.mjs (the E6 distribution seam consumed by the
// Test262 runner), so the artifact this probe validates and the artifact the
// runner links are one and the same — they cannot drift.

import { compile } from "../../src/index.ts";
import {
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalProviderSource,
} from "../../scripts/runtime-eval-provider.mjs";

function describeDiagnostic(diagnostic) {
  return diagnostic?.messageText ?? diagnostic?.message ?? String(diagnostic);
}

async function main() {
  const provider = await compile(buildRuntimeEvalProviderSource(), { ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS });
  const user = await compile(
    `
      function dynamic(value: string): string {
        return value;
      }

      export function linkedFunction(): number {
        const fn: any = new Function(
          dynamic("a,b"),
          dynamic("return a + b")
        );
        return fn(1, 2) as number;
      }

      export function linkedFunctionImmediate(): number {
        return new Function(
          dynamic("a"),
          dynamic("b"),
          dynamic("return a + b")
        )(1, 2) as number;
      }

      export function linkedFunctionCall(): number {
        return Function(
          dynamic("a,b"),
          dynamic("return a + b")
        )(2, 3) as number;
      }

      export function linkedSloppyThis(): number {
        const fn: any = new Function(dynamic("return this"));
        return fn() === globalThis ? 1 : 2;
      }

      export function linkedStrictThis(): number {
        const fn: any = new Function(dynamic('"use strict"; return this'));
        return fn() === undefined ? 1 : 2;
      }

      export function linkedEval(): number {
        globalThis.answer = 40;
        return (0, eval)(dynamic("answer + 2")) as number;
      }

      export function linkedThrow(): number {
        try {
          (0, eval)(dynamic("throw 7"));
          return 0;
        } catch (error) {
          return error === 7 ? 1 : 2;
        }
      }

      export function linkedErrorThrow(): number {
        try {
          (0, eval)(dynamic("throw new Error('x')"));
          return 0;
        } catch (error) {
          return error ? 1 : 2;
        }
      }

      export function linkedNumberBuiltin(): number {
        return (0, eval)(dynamic("Number('4')")) as number;
      }

      export function linkedMathBuiltin(): number {
        return (0, eval)(dynamic("Math.max(3, 7, 2)")) as number;
      }

      function aotAdd(a: number, b: number): number {
        return a + b;
      }

      export function linkedAotCall(): number {
        const assigned: any = (globalThis.aotAdd = aotAdd);
        if (assigned !== aotAdd) return -1;
        return (0, eval)(dynamic("aotAdd(2, 3)")) as number;
      }

    `,
    {
      fileName: "runtime-eval-acorn-user.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    },
  );
  const report = {
    success: provider.success,
    errors: provider.errors.map(describeDiagnostic),
    bytes: provider.binary.length,
    imports: [],
    exports: [],
    userSuccess: user.success,
    userErrors: user.errors.map(describeDiagnostic),
    userImports: [],
    values: {},
    executionErrors: {},
  };

  if (provider.binary.length > 0 && user.binary.length > 0) {
    const module = new WebAssembly.Module(provider.binary);
    const userModule = new WebAssembly.Module(user.binary);
    report.imports = WebAssembly.Module.imports(module);
    report.exports = WebAssembly.Module.exports(module).filter((entry) => entry.name.startsWith("__runtime_"));
    report.userImports = WebAssembly.Module.imports(userModule);
    if (provider.success && user.success && report.imports.length === 0) {
      try {
        const instance = new WebAssembly.Instance(module, {});
        const userInstance = new WebAssembly.Instance(userModule, {
          "js2wasm:runtime-eval": {
            __runtime_new_function: instance.exports.__runtime_new_function,
            __runtime_indirect_eval: instance.exports.__runtime_indirect_eval,
          },
        });
        const canaries = [
          ["function", instance.exports.__runtime_function_canary],
          ["linkedFunction", userInstance.exports.linkedFunction],
          ["linkedFunctionImmediate", userInstance.exports.linkedFunctionImmediate],
          ["linkedFunctionCall", userInstance.exports.linkedFunctionCall],
          ["linkedSloppyThis", userInstance.exports.linkedSloppyThis],
          ["linkedStrictThis", userInstance.exports.linkedStrictThis],
          ["eval", instance.exports.__runtime_eval_canary],
          ["positiveCorpus", instance.exports.__runtime_positive_corpus_canary],
          ["linkedEval", userInstance.exports.linkedEval],
          ["linkedThrow", userInstance.exports.linkedThrow],
          ["linkedErrorThrow", userInstance.exports.linkedErrorThrow],
          ["linkedNumberBuiltin", userInstance.exports.linkedNumberBuiltin],
          ["linkedMathBuiltin", userInstance.exports.linkedMathBuiltin],
          ["linkedAotCall", userInstance.exports.linkedAotCall],
        ];
        for (const [name, fn] of canaries) {
          try {
            report.values[name] = fn();
          } catch (error) {
            report.executionErrors[name] = error?.stack ?? error?.message ?? String(error);
          }
        }
      } catch (error) {
        report.executionErrors.instantiate = error?.stack ?? error?.message ?? String(error);
      }
    }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      success: false,
      errors: [error?.stack ?? error?.message ?? String(error)],
      bytes: 0,
      imports: [],
      exports: [],
      userSuccess: false,
      userErrors: [],
      userImports: [],
      values: {},
      executionErrors: {},
    })}\n`,
  );
});
