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

      export function linkedDirectEval(): number {
        let x = 40;
        const result: any = eval(dynamic("x = x + 2; x"));
        return (result as number) + x;
      }

      export function linkedDirectSloppyVarMutation(): number {
        let x = 40;
        const result: any = eval(dynamic("var x = 1; x"));
        return (result as number) + x;
      }

      export function linkedDirectVarPersistence(): number {
        eval(dynamic("var x = 1; x"));
        return eval(dynamic("x = x + 1; x")) as number;
      }

      export function linkedNestedDirectVarPersistence(): number {
        let x = 40;
        function acornVarEval(first: string, second: string): any {
          eval(first);
          return eval(second);
        }
        const result: any = acornVarEval(
          dynamic("var x = 1; x"),
          dynamic("x = x + 1; x")
        );
        return (result as number) * 100 + x;
      }

      export function linkedDirectMappedParameterAssignment(): number {
        function acornMappedParameter(a: number): number {
          eval(dynamic("a = 2"));
          return a * 100 + (arguments[0] as number);
        }
        return acornMappedParameter(1);
      }

      export function linkedDirectMappedArgumentsAssignment(): number {
        function acornMappedArguments(a: number): number {
          eval(dynamic("arguments[0] = 3"));
          return a * 100 + (arguments[0] as number);
        }
        return acornMappedArguments(1);
      }

      export function linkedDirectDefaultParameter(): number {
        function acornDefaultParameter(a: number = 5): number {
          return eval(dynamic("a")) as number;
        }
        return acornDefaultParameter();
      }

      export function linkedDirectParameterWriteBeforeEval(): number {
        function acornParameterWrite(a: number): number {
          a = 6;
          return eval(dynamic("a")) as number;
        }
        return acornParameterWrite(1);
      }

      export function linkedDirectStrictSourceVarIsolation(): number {
        let x = 40;
        const result: any = eval(dynamic("'use strict'; var x = 1; x"));
        return (result as number) + x;
      }

      export function linkedDirectStrictCallerVarIsolation(): number {
        "use strict";
        let x = 40;
        const result: any = eval(dynamic("var x = 1; x"));
        return (result as number) + x;
      }

      export function linkedDirectLexicalIsolation(): number {
        let x = 40;
        const result: any = eval(dynamic("let x = 1; x"));
        return (result as number) + x;
      }

      export function linkedDirectLexicalTdz(): number {
        try {
          eval(dynamic("x; let x = 1"));
          return 0;
        } catch (error) {
          return error && error.name === "ReferenceError" ? 1 : 2;
        }
      }

      export function linkedDirectNestedLexicalShadow(): number {
        return eval(dynamic("let y = 1; { let y = 2; y; } y")) as number;
      }

      export function linkedDirectBlockClosureCapture(): number {
        return eval(
          dynamic("var f; { let y = 3; f = function () { return y; }; } f()")
        ) as number;
      }

      export function linkedDirectNestedLexicalTdz(): number {
        try {
          eval(dynamic("{ x; let x = 1; }"));
          return 0;
        } catch (error) {
          return error && error.name === "ReferenceError" ? 1 : 2;
        }
      }

      export function linkedDirectBlockBreakCleanup(): number {
        return eval(
          dynamic("var r = 0; while (true) { let y = 1; r = y; break; } typeof y === 'undefined' ? r : -1")
        ) as number;
      }

      export function linkedDirectBlockCatchCleanup(): number {
        return eval(
          dynamic("var r = 0; try { { let y = 1; throw 7; } } catch (error) { r = error; } typeof y === 'undefined' ? r : -1")
        ) as number;
      }

      export function linkedDirectStrictBlockFunctionLifetime(): number {
        const result: any = eval(
          dynamic("'use strict'; { function f() { return 1; } f(); } typeof f")
        );
        return result === "undefined" ? 1 : 2;
      }

      export function linkedDirectSloppyBlockFunction(): number {
        return eval(dynamic("{ function f() { return 2; } } f()")) as number;
      }

      export function linkedDirectSloppyBlockFunctionPersistence(): number {
        eval(dynamic("{ function f() { return 4; } } 0"));
        return eval(dynamic("f()")) as number;
      }

      export function linkedDirectBlockFunctionLexicalConflict(): number {
        return eval(dynamic("let f = 3; { function f() { return 2; } } f")) as number;
      }

      export function linkedDirectBlockFunctionOuterLexicalConflict(): number {
        return eval(dynamic("{ let f = 3; { function f() { return 2; } } f; }")) as number;
      }

      export function linkedDirectBlockFunctionSkippedInit(): number {
        const result: any = eval(dynamic("if (false) { function f() {} } f"));
        return result === undefined ? 1 : 2;
      }

      export function linkedDirectClassBasic(): number {
        return eval(
          dynamic("class C { constructor(x) { this.x = x; } value() { return this.x; } static two() { return 2; } } var c = new C(5); c.value() + C.two()")
        ) as number;
      }

      export function linkedDirectClassInstanceMethod(): number {
        return eval(dynamic("class C { value() { return 4; } } new C().value()")) as number;
      }

      export function linkedDirectClassConstructorField(): number {
        return eval(dynamic("class C { constructor(x) { this.x = x; } } new C(5).x")) as number;
      }

      export function linkedDirectClassBlockLifetime(): number {
        const result: any = eval(
          dynamic("{ class C { static value() { return 3; } } C.value(); } typeof C")
        );
        return result === "undefined" ? 1 : 2;
      }

      export function linkedDirectClassCallGuard(): number {
        return eval(
          dynamic("class C {} try { C(); } catch (error) { error.name === 'TypeError' ? 1 : 2 }")
        ) as number;
      }

      export function linkedDirectClassExpression(): number {
        return eval(
          dynamic("var C = class Named { value() { return 4; } }; new C().value()")
        ) as number;
      }

      export function linkedDirectStrictEarlyError(): number {
        "use strict";
        try {
          eval(dynamic("var arguments = 1"));
          return 0;
        } catch (error) {
          return error && error.name === "SyntaxError" ? 1 : 2;
        }
      }

      export function linkedIndirectStrictVarIsolation(): number {
        globalThis.evalStrictX = 40;
        const result: any = (0, eval)(dynamic("'use strict'; var evalStrictX = 1; evalStrictX"));
        return (result as number) + globalThis.evalStrictX;
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
      inferModuleStrictArguments: false,
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
            __runtime_direct_eval: instance.exports.__runtime_direct_eval,
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
          ["directEval", instance.exports.__runtime_direct_eval_canary],
          ["positiveCorpus", instance.exports.__runtime_positive_corpus_canary],
          ["linkedEval", userInstance.exports.linkedEval],
          ["linkedDirectEval", userInstance.exports.linkedDirectEval],
          ["linkedDirectSloppyVarMutation", userInstance.exports.linkedDirectSloppyVarMutation],
          ["linkedDirectVarPersistence", userInstance.exports.linkedDirectVarPersistence],
          ["linkedNestedDirectVarPersistence", userInstance.exports.linkedNestedDirectVarPersistence],
          ["linkedDirectMappedParameterAssignment", userInstance.exports.linkedDirectMappedParameterAssignment],
          ["linkedDirectMappedArgumentsAssignment", userInstance.exports.linkedDirectMappedArgumentsAssignment],
          ["linkedDirectDefaultParameter", userInstance.exports.linkedDirectDefaultParameter],
          ["linkedDirectParameterWriteBeforeEval", userInstance.exports.linkedDirectParameterWriteBeforeEval],
          ["linkedDirectStrictSourceVarIsolation", userInstance.exports.linkedDirectStrictSourceVarIsolation],
          ["linkedDirectStrictCallerVarIsolation", userInstance.exports.linkedDirectStrictCallerVarIsolation],
          ["linkedDirectLexicalIsolation", userInstance.exports.linkedDirectLexicalIsolation],
          ["linkedDirectLexicalTdz", userInstance.exports.linkedDirectLexicalTdz],
          ["linkedDirectNestedLexicalShadow", userInstance.exports.linkedDirectNestedLexicalShadow],
          ["linkedDirectBlockClosureCapture", userInstance.exports.linkedDirectBlockClosureCapture],
          ["linkedDirectNestedLexicalTdz", userInstance.exports.linkedDirectNestedLexicalTdz],
          ["linkedDirectBlockBreakCleanup", userInstance.exports.linkedDirectBlockBreakCleanup],
          ["linkedDirectBlockCatchCleanup", userInstance.exports.linkedDirectBlockCatchCleanup],
          ["linkedDirectStrictBlockFunctionLifetime", userInstance.exports.linkedDirectStrictBlockFunctionLifetime],
          ["linkedDirectSloppyBlockFunction", userInstance.exports.linkedDirectSloppyBlockFunction],
          [
            "linkedDirectSloppyBlockFunctionPersistence",
            userInstance.exports.linkedDirectSloppyBlockFunctionPersistence,
          ],
          ["linkedDirectBlockFunctionLexicalConflict", userInstance.exports.linkedDirectBlockFunctionLexicalConflict],
          [
            "linkedDirectBlockFunctionOuterLexicalConflict",
            userInstance.exports.linkedDirectBlockFunctionOuterLexicalConflict,
          ],
          ["linkedDirectBlockFunctionSkippedInit", userInstance.exports.linkedDirectBlockFunctionSkippedInit],
          ["linkedDirectClassBasic", userInstance.exports.linkedDirectClassBasic],
          ["linkedDirectClassInstanceMethod", userInstance.exports.linkedDirectClassInstanceMethod],
          ["linkedDirectClassConstructorField", userInstance.exports.linkedDirectClassConstructorField],
          ["linkedDirectClassBlockLifetime", userInstance.exports.linkedDirectClassBlockLifetime],
          ["linkedDirectClassCallGuard", userInstance.exports.linkedDirectClassCallGuard],
          ["linkedDirectClassExpression", userInstance.exports.linkedDirectClassExpression],
          ["linkedDirectStrictEarlyError", userInstance.exports.linkedDirectStrictEarlyError],
          ["linkedIndirectStrictVarIsolation", userInstance.exports.linkedIndirectStrictVarIsolation],
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
