// #2928 E6 — real Acorn + interpreter provider packaging probe.
//
// Acorn and the import-clean interpreter sources are compiled as ONE source
// unit. This gives the provider exactly one ordered initializer without relying
// on compileMulti's current per-source initializer ownership (#3525), and keeps
// ESTree objects inside the provider rather than exposing them as a link ABI.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compile } from "../../src/index.ts";
import { setupAcorn } from "../dogfood/setup-acorn.mjs";

const INTERP_FILES = [
  "types.ts",
  "opcodes.ts",
  "encoder.ts",
  "runtime-ops.ts",
  "emitter.ts",
  "loop.ts",
  "dynamic-function.ts",
];

function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export \{[^;]+;\n/gm, "")
    .replace(/\bexport (?=(?:type|interface|class|const|function)\b)/g, "");
}

function providerSource() {
  const { entryModulePath } = setupAcorn();
  const acorn = stripModuleSyntax(readFileSync(entryModulePath, "utf8"));
  const interpreter = INTERP_FILES.map((name) => stripModuleSyntax(readFileSync(resolve("src/interp", name), "utf8")));

  return [
    acorn,
    ...interpreter,
    `
      function runtimeEvalResult(ok: boolean, value: any): any {
        const result: any[] = [ok, value];
        return result;
      }

      export function __runtime_new_function(
        paramString: any,
        bodyString: any,
        globalObject: any
      ): any {
        try {
          return runtimeEvalResult(
            true,
            createDynamicFunction(
              parse,
              String(paramString),
              String(bodyString),
              globalObject
            )
          );
        } catch (error) {
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_indirect_eval(
        source: any,
        globalObject: any
      ): any {
        try {
          return runtimeEvalResult(
            true,
            executeIndirectEval(parse, source, globalObject)
          );
        } catch (error) {
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_eval_canary(): number {
        return executeIndirectEval(parse, "1 + 2", {}) as number;
      }

      export function __runtime_function_canary(): number {
        const fn = createDynamicFunction(
          parse,
          "a,b",
          "return a + b",
          {}
        );
        return fn(1, 2) as number;
      }

      export function __runtime_positive_corpus_canary(): number {
        // Thirty Phase-1-positive bodies drawn from the Test262-shaped corpus
        // in differential.test.ts. Every case parses through the real Acorn
        // artifact and executes in the self-compiled interpreter.
        const sources: string[] = [
          "1 + 2",
          "1 + 2 * 3 - 4 / 2",
          "17 % 5",
          "-3 + 4",
          "var r = 0; if (5 > 3) r = 1; r",
          "var r = 0; if (3 >= 3) r = 1; r",
          "var r = 0; if (1 != 2) r = 1; r",
          "var r = 0; if (1 !== '1') r = 1; r",
          "12",
          "var x = 1; x = x + 41; x",
          "let a = 1, b = 2; a + b",
          "var x = 5; x * 2",
          "var x = 7; x -= 2; x",
          "var x = 2; x *= 3; x",
          "8 / 2",
          "9 % 4",
          "var o = { a: 1, b: 2 }; o.a + o.b",
          "var o = {}; var k = 'z'; o[k] = 9; o[k]",
          "var o = { a: 10, b: 30 }; o.a + o.b",
          "function add(a, b) { return a + b; } add(4, 5)",
          "function twice(n) { return n * 2; } twice(4)",
          "function square(x) { return x * x; } square(6)",
          "function multiply(a, b) { return a * b; } multiply(6, 7)",
          "var g = 0; function inc() { g = g + 1; return g; } inc(); inc(); inc()",
          "var r = 0; try { throw 42; } catch (e) { r = e + 1; } r",
          "var r = 0; try { throw 10; } catch (e) { r = e + 1; } r",
          "function boom() { throw 7; } var r = 0; try { boom(); } catch (e) { r = e; } r",
          "var r = 0; try { throw new Error('x'); } catch (e) { r = 1; } r",
          "Number('4') + Number()",
          "Math.max(3, 7, 2) + Math.min(3, 7, 2) + Math.abs(-5) + Math.floor(2.9) + Math.ceil(2.1)",
        ];
        const expected: number[] = [
          3, 5, 2, 1, 1, 1, 1, 1, 12, 42,
          3, 10, 5, 6, 4, 1, 3, 9, 40, 9,
          8, 36, 42, 3, 43, 11, 7, 1, 4, 19,
        ];
        for (let i = 0; i < sources.length; i += 1) {
          try {
            const actual = executeIndirectEval(parse, sources[i], {});
            if (actual !== expected[i]) return -(i + 1);
          } catch (error) {
            return -(1001 + i);
          }
        }
        return sources.length;
      }
    `,
  ].join("\n");
}

function describeDiagnostic(diagnostic) {
  return diagnostic?.messageText ?? diagnostic?.message ?? String(diagnostic);
}

async function main() {
  const provider = await compile(providerSource(), {
    experimentalIR: false,
    fileName: "runtime-eval-acorn-provider.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
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
