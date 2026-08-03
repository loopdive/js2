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

import { readFileSync } from "node:fs";

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
  const assertHarnessSource = readFileSync(new URL("../../test262/harness/assert.js", import.meta.url), "utf8");
  const staHarnessSource = readFileSync(new URL("../../test262/harness/sta.js", import.meta.url), "utf8");
  const user = await compile(
    `
      ${assertHarnessSource}
      ${staHarnessSource}

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
        try {
          eval(dynamic("var x = 1; x"));
          return x === 40 ? 0 : 3;
        } catch (error) {
          return error && error.name === "SyntaxError" ? 1 : 2;
        }
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

      export function linkedDirectMappedArgumentsDelete(): number {
        function acornMappedDelete(a: number): number {
          return eval(
            dynamic("delete arguments[0]; a = 2; typeof arguments[0] === 'undefined' ? a : -1")
          ) as number;
        }
        return acornMappedDelete(1);
      }

      export function linkedDirectMappedDeletePersistsToAot(): number {
        function acornMappedDeletePersists(a: number): number {
          eval(dynamic("delete arguments[0]"));
          a = 6;
          return typeof arguments[0] === "undefined" ? a : -1;
        }
        return acornMappedDeletePersists(1);
      }

      export function linkedDirectMappedArgumentsDefine(): number {
        function acornMappedDefine(a: number): number {
          eval(dynamic("Object.defineProperty(arguments, '0', { value: 4, writable: false })"));
          a = 5;
          return (arguments[0] as number) * 10 + a;
        }
        return acornMappedDefine(1);
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

      export function linkedDirectLowerLexicalCollision(): number {
        try {
          { let x = 1; { eval(dynamic("var x;")); } }
          return 0;
        } catch (error) {
          return error && error.name === "SyntaxError" ? 1 : 2;
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

      export function linkedLiteralBlockFunctionLowerLexicalCancellation(): number {
        let f: any = 3;
        eval("{ function f() { return 2; } }");
        return typeof f === "number" ? f : -1;
      }

      export function linkedDirectBlockFunctionSkippedInit(): number {
        const result: any = eval(dynamic("if (false) { function f() {} } f"));
        return result === undefined ? 1 : 2;
      }

      export function linkedDirectSloppyIfFunction(): number {
        return eval(
          dynamic("if (true) function directIfFn() { return 5; } directIfFn()")
        ) as number;
      }

      export function linkedIndirectSloppyIfFunction(): number {
        return (0, eval)(
          dynamic("if (true) function indirectIfFn() { return 6; } indirectIfFn()")
        ) as number;
      }

      export function linkedDirectSwitchFlow(): number {
        return eval(
          dynamic("var result = 0; switch (2) { case 1: result = 1; break; case 2: result = 2; case 3: result = result + 3; break; default: result = 9; } result")
        ) as number;
      }

      export function linkedDirectSwitchAnnexB(): number {
        return eval(
          dynamic("switch (1) { case 1: function switchFn() { return 6; } } switchFn()")
        ) as number;
      }

      export function linkedDirectSwitchFunctionCompletion(): number {
        const fn: any = eval(
          dynamic("switch (1) { case 1: function completedSwitchFn() { return 8; } }")
        );
        return fn() as number;
      }

      export function linkedDirectSwitchSkippedAnnexB(): number {
        const result: any = eval(
          dynamic("switch (0) { case 1: function skippedSwitchFn() {} } typeof skippedSwitchFn")
        );
        return result === "undefined" ? 1 : 2;
      }

      export function linkedDirectSwitchLexical(): number {
        return eval(
          dynamic("var result = 0; switch (1) { case 1: let local = 7; result = local; break; } typeof local === 'undefined' ? result : -1")
        ) as number;
      }

      export function linkedDirectSwitchFunctionInitialization(): number {
        return eval(
          dynamic("var result = 0; switch (1) { case typeof f === 'function' ? 1 : 0: result = f(); break; default: function f() { return 4; } } typeof f === 'undefined' ? result : -1")
        ) as number;
      }

      var aotSwitchInit: any = 0;

      export function linkedDirectSwitchExistingVarInside(): number {
        return eval(
          dynamic("var f = 123; var same = aotAssert.sameValue(f, 123); switch (1) { case 1: function f() {} } same")
        ) as number;
      }

      export function linkedDirectRealHarnessSwitchExistingVar(): number {
        return eval(
          dynamic("var f = 123; assert.sameValue(f, 123); switch (1) { case 1: function f() {} } 1")
        ) as number;
      }

      export function linkedDirectSwitchExistingVarWriteback(): number {
        eval(dynamic("var f = 123; aotSwitchInit = f; switch (1) { case 1: function f() {} }"));
        return (aotAssert as any).sameValue(aotSwitchInit, 123) as number;
      }

      var aotSwitchFunction: any;
      var aotSwitchInitialBinding: any;
      var aotSwitchCurrentBinding: any;

      export function linkedDirectSwitchBlockBindingIdentity(): number {
        eval(
          dynamic("switch (1) { case 1: function f() { aotSwitchInitialBinding = f; f = 123; aotSwitchCurrentBinding = f; return 'decl'; } } aotSwitchFunction = f")
        );
        const callableBefore: any = typeof aotSwitchFunction === "function";
        const first: any = aotSwitchFunction();
        const initial: any = aotSwitchInitialBinding;
        return (first === "decl" ? 1 : 0) +
          (typeof initial === "function" ? 2 : 0) +
          (aotSwitchCurrentBinding === 123 ? 4 : 0) +
          (initial() === "decl" ? 8 : 0) +
          (aotSwitchFunction() === "decl" ? 16 : 0) +
          (callableBefore ? 32 : 0) +
          (initial === aotSwitchFunction ? 64 : 0);
      }

      export function linkedDirectForInOfLexical(): number {
        return eval(
          dynamic("var total = 0; for (let value of [1, 2, 3]) { if (value === 2) continue; total = total + value; } var keys = ''; for (let key in { a: 1, b: 2 }) { keys = keys + key; } for (let f of [0]) { switch (1) { case 1: function f() {} } } (total === 4 ? 1 : 0) + (keys === 'ab' ? 2 : 0) + (typeof value === 'undefined' ? 4 : 0) + (typeof key === 'undefined' ? 8 : 0) + (typeof f === 'undefined' ? 16 : 0)")
        ) as number;
      }

      export function linkedDirectForOfClosure(): number {
        return eval(
          dynamic("var closures = []; for (let value of [1, 2]) { closures[closures.length] = function () { return value; }; } closures[0]() * 10 + closures[1]()")
        ) as number;
      }

      export function linkedDirectForInKeys(): number {
        return eval(
          dynamic("var count = 0; var score = 0; for (let key in { a: 1, b: 2 }) { count = count + 1; if (typeof key === 'string') score = score + 1; if (key === 'a') score = score + 10; if (key === 'b') score = score + 20; } count * 100 + score")
        ) as number;
      }

      export function linkedDirectStringAdd(): number {
        return eval(
          dynamic("var score = 'a' + 'b' === 'ab' ? 1 : 0; var literal = 'ab'; if (literal === 'ab') score = score + 2; var text = ''; text = text + 'a'; if (text === 'a') score = score + 4; text = text + 'b'; if (text === 'ab') score = score + 8; if (typeof text === 'string') score = score + 16; if (text === 'aa') score = score + 32; if (text === 'a') score = score + 64; if (text === 'b') score = score + 128; if (text.length === 2) score = score + 256; if (text.length === 1) score = score + 512; score")
        ) as number;
      }

      export function linkedDirectReferenceErrorValue(): number {
        const expected: any = ReferenceError;
        const actual: any = eval(dynamic("ReferenceError"));
        return actual === expected ? 1 : 2;
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

      var aotSeededValue = 40;

      function aotSeededHelper(value: number): number {
        return value + 2;
      }

      var aotLiveValue = 40;

      function aotReadLiveValue(): number {
        return aotLiveValue;
      }

      function aotWriteLiveValue(value: number): number {
        aotLiveValue = value;
        return aotLiveValue;
      }

      function aotReplaceable(): number {
        return 1;
      }

      var aotVarCallable: any;
      var evalAliasGlobal = "global";

      function aotAssert(value: any): void {
        if (!value) throw new Error("assertion failed");
      }

      (aotAssert as any).throws = function (expected: any, callback: any): number {
        if (typeof callback !== "function") return 4;
        try {
          callback();
        } catch (error) {
          return error && error.constructor === expected ? 1 : 2;
        }
        return 3;
      };

      aotAssert._isSameValue = function (actual: any, expected: any): boolean {
        return actual === expected;
      };

      aotAssert.sameValue = function (actual: any, expected: any, message: any): number {
        try {
          return aotAssert._isSameValue(actual, expected) ? 1 : 2;
        } catch (error) {
          return 3;
        }
      };

      export function linkedAotCall(): number {
        const assigned: any = (globalThis.aotAdd = aotAdd);
        if (assigned !== aotAdd) return -1;
        return (0, eval)(dynamic("aotAdd(2, 3)")) as number;
      }

      export function linkedIndirectAotGlobalSeed(): number {
        return (0, eval)(dynamic("aotSeededHelper(aotSeededValue)")) as number;
      }

      export function linkedFunctionAotGlobalSeed(): number {
        const fn: any = new Function(
          dynamic("return aotSeededHelper(aotSeededValue)")
        );
        return fn() as number;
      }

      export function linkedIndirectAotGlobalWriteback(): number {
        aotLiveValue = 40;
        (0, eval)(dynamic("aotLiveValue = 41"));
        return aotLiveValue + 1;
      }

      export function linkedFunctionAotLiveRead(): number {
        aotLiveValue = 40;
        const fn: any = new Function(dynamic("return aotLiveValue"));
        aotLiveValue = 42;
        return fn() as number;
      }

      export function linkedFunctionAotWriteback(): number {
        aotLiveValue = 40;
        const fn: any = new Function(dynamic("aotLiveValue = 43"));
        fn();
        return aotLiveValue;
      }

      export function linkedEvalCallsAotWithFreshGlobal(): number {
        aotLiveValue = 40;
        return (0, eval)(dynamic("aotLiveValue = 44; aotReadLiveValue()")) as number;
      }

      export function linkedEvalAotCallbackWriteback(): number {
        aotLiveValue = 40;
        const result: any = (0, eval)(dynamic("aotWriteLiveValue(45)"));
        return (result as number) * 100 + aotLiveValue;
      }

      export function linkedDirectAotHarnessLookup(): number {
        return eval(
          dynamic("typeof aotAssert === 'function' && typeof aotAssert.throws === 'function' && typeof aotAssert.sameValue === 'function' ? 1 : 2")
        ) as number;
      }

      export function linkedDirectAotAssertThrows(): number {
        return eval(
          dynamic("aotAssert.throws(ReferenceError, function () { missingEvalBinding; })")
        ) as number;
      }

      export function linkedDirectAotAssertSameValue(): number {
        return eval(dynamic("aotAssert.sameValue(typeof missingEvalBinding, 'undefined')")) as number;
      }

      export function linkedIndirectFunctionBindingWriteback(): number {
        const before = aotReplaceable();
        (0, eval)(dynamic("aotReplaceable = function () { return 7; }"));
        return before * 10 + (aotReplaceable() as number);
      }

      export function linkedAotFunctionBindingUpdateVisibleToEval(): number {
        aotReplaceable = function (): number { return 8; };
        return (0, eval)(dynamic("aotReplaceable()")) as number;
      }

      export function linkedIndirectVarCallableWriteback(): number {
        (0, eval)(dynamic("aotVarCallable = function () { return 7; }"));
        return (typeof aotVarCallable === "function" ? 10 : 0) +
          (aotVarCallable() as number);
      }

      export function linkedIndirectCreatedGlobalNumber(): number {
        (0, eval)(dynamic("var evalCreatedNumber = 41"));
        return evalCreatedNumber + 1;
      }

      export function linkedIndirectIifeVarIsolation(): number {
        let inside = -1;
        (function (): void {
          var evalIifeBinding = 0;
          (0, eval)(dynamic("var evalIifeBinding = 1"));
          inside = evalIifeBinding;
        })();
        return inside * 10 + evalIifeBinding;
      }

      export function linkedIndirectTypedEvalAlias(): number {
        const alias = eval;
        const evalAliasGlobal = "local";
        const result = alias(dynamic("'global' === evalAliasGlobal"));
        return (result === true ? 1 : 0) +
          (result ? 2 : 0) +
          (typeof result === "boolean" ? 4 : 0);
      }

    `,
    {
      fileName: "runtime-eval-acorn-user.ts",
      inferModuleStrictArguments: false,
      skipSemanticDiagnostics: true,
      target: "standalone",
      deferTopLevelInit: true,
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
            __runtime_apply_interpreted: instance.exports.__runtime_apply_interpreted,
            __runtime_new_function: instance.exports.__runtime_new_function,
            __runtime_indirect_eval: instance.exports.__runtime_indirect_eval,
            __runtime_direct_eval: instance.exports.__runtime_direct_eval,
          },
        });
        userInstance.exports.__module_init();
        const canaries = [
          ["function", instance.exports.__runtime_function_canary],
          ["linkedFunction", userInstance.exports.linkedFunction],
          ["linkedFunctionImmediate", userInstance.exports.linkedFunctionImmediate],
          ["linkedFunctionCall", userInstance.exports.linkedFunctionCall],
          ["linkedSloppyThis", userInstance.exports.linkedSloppyThis],
          ["linkedStrictThis", userInstance.exports.linkedStrictThis],
          ["eval", instance.exports.__runtime_eval_canary],
          ["directEval", instance.exports.__runtime_direct_eval_canary],
          ["applyInterpreted", instance.exports.__runtime_apply_interpreted_canary],
          ["positiveCorpus", instance.exports.__runtime_positive_corpus_canary],
          ["linkedEval", userInstance.exports.linkedEval],
          ["linkedDirectEval", userInstance.exports.linkedDirectEval],
          ["linkedDirectSloppyVarMutation", userInstance.exports.linkedDirectSloppyVarMutation],
          ["linkedDirectVarPersistence", userInstance.exports.linkedDirectVarPersistence],
          ["linkedNestedDirectVarPersistence", userInstance.exports.linkedNestedDirectVarPersistence],
          ["linkedDirectMappedParameterAssignment", userInstance.exports.linkedDirectMappedParameterAssignment],
          ["linkedDirectMappedArgumentsAssignment", userInstance.exports.linkedDirectMappedArgumentsAssignment],
          ["linkedDirectMappedArgumentsDelete", userInstance.exports.linkedDirectMappedArgumentsDelete],
          ["linkedDirectMappedDeletePersistsToAot", userInstance.exports.linkedDirectMappedDeletePersistsToAot],
          ["linkedDirectMappedArgumentsDefine", userInstance.exports.linkedDirectMappedArgumentsDefine],
          ["linkedDirectDefaultParameter", userInstance.exports.linkedDirectDefaultParameter],
          ["linkedDirectParameterWriteBeforeEval", userInstance.exports.linkedDirectParameterWriteBeforeEval],
          ["linkedDirectStrictSourceVarIsolation", userInstance.exports.linkedDirectStrictSourceVarIsolation],
          ["linkedDirectStrictCallerVarIsolation", userInstance.exports.linkedDirectStrictCallerVarIsolation],
          ["linkedDirectLexicalIsolation", userInstance.exports.linkedDirectLexicalIsolation],
          ["linkedDirectLexicalTdz", userInstance.exports.linkedDirectLexicalTdz],
          ["linkedDirectLowerLexicalCollision", userInstance.exports.linkedDirectLowerLexicalCollision],
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
          [
            "linkedLiteralBlockFunctionLowerLexicalCancellation",
            userInstance.exports.linkedLiteralBlockFunctionLowerLexicalCancellation,
          ],
          ["linkedDirectBlockFunctionSkippedInit", userInstance.exports.linkedDirectBlockFunctionSkippedInit],
          ["linkedDirectSloppyIfFunction", userInstance.exports.linkedDirectSloppyIfFunction],
          ["linkedIndirectSloppyIfFunction", userInstance.exports.linkedIndirectSloppyIfFunction],
          ["linkedDirectSwitchFlow", userInstance.exports.linkedDirectSwitchFlow],
          ["linkedDirectSwitchAnnexB", userInstance.exports.linkedDirectSwitchAnnexB],
          ["linkedDirectSwitchFunctionCompletion", userInstance.exports.linkedDirectSwitchFunctionCompletion],
          ["linkedDirectSwitchSkippedAnnexB", userInstance.exports.linkedDirectSwitchSkippedAnnexB],
          ["linkedDirectSwitchLexical", userInstance.exports.linkedDirectSwitchLexical],
          ["linkedDirectSwitchFunctionInitialization", userInstance.exports.linkedDirectSwitchFunctionInitialization],
          ["linkedDirectSwitchExistingVarInside", userInstance.exports.linkedDirectSwitchExistingVarInside],
          ["linkedDirectRealHarnessSwitchExistingVar", userInstance.exports.linkedDirectRealHarnessSwitchExistingVar],
          ["linkedDirectSwitchExistingVarWriteback", userInstance.exports.linkedDirectSwitchExistingVarWriteback],
          ["linkedDirectSwitchBlockBindingIdentity", userInstance.exports.linkedDirectSwitchBlockBindingIdentity],
          ["linkedDirectForInOfLexical", userInstance.exports.linkedDirectForInOfLexical],
          ["linkedDirectForOfClosure", userInstance.exports.linkedDirectForOfClosure],
          ["linkedDirectForInKeys", userInstance.exports.linkedDirectForInKeys],
          ["linkedDirectStringAdd", userInstance.exports.linkedDirectStringAdd],
          ["linkedDirectReferenceErrorValue", userInstance.exports.linkedDirectReferenceErrorValue],
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
          ["linkedIndirectAotGlobalSeed", userInstance.exports.linkedIndirectAotGlobalSeed],
          ["linkedFunctionAotGlobalSeed", userInstance.exports.linkedFunctionAotGlobalSeed],
          ["linkedIndirectAotGlobalWriteback", userInstance.exports.linkedIndirectAotGlobalWriteback],
          ["linkedFunctionAotLiveRead", userInstance.exports.linkedFunctionAotLiveRead],
          ["linkedFunctionAotWriteback", userInstance.exports.linkedFunctionAotWriteback],
          ["linkedEvalCallsAotWithFreshGlobal", userInstance.exports.linkedEvalCallsAotWithFreshGlobal],
          ["linkedEvalAotCallbackWriteback", userInstance.exports.linkedEvalAotCallbackWriteback],
          ["linkedDirectAotHarnessLookup", userInstance.exports.linkedDirectAotHarnessLookup],
          ["linkedDirectAotAssertThrows", userInstance.exports.linkedDirectAotAssertThrows],
          ["linkedDirectAotAssertSameValue", userInstance.exports.linkedDirectAotAssertSameValue],
          ["linkedIndirectFunctionBindingWriteback", userInstance.exports.linkedIndirectFunctionBindingWriteback],
          [
            "linkedAotFunctionBindingUpdateVisibleToEval",
            userInstance.exports.linkedAotFunctionBindingUpdateVisibleToEval,
          ],
          ["linkedIndirectVarCallableWriteback", userInstance.exports.linkedIndirectVarCallableWriteback],
          ["linkedIndirectCreatedGlobalNumber", userInstance.exports.linkedIndirectCreatedGlobalNumber],
          ["linkedIndirectIifeVarIsolation", userInstance.exports.linkedIndirectIifeVarIsolation],
          ["linkedIndirectTypedEvalAlias", userInstance.exports.linkedIndirectTypedEvalAlias],
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
