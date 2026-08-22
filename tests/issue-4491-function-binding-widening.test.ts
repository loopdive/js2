// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-6 T12) Assignment OVER a `function` declaration binding.
 *
 * A function declaration's name is an ordinary mutable var binding, so
 * `function g() {}; g = 123;` must leave `g` holding `123`. Two separate
 * defects made that untrue in `--target standalone`, and they failed in
 * opposite directions:
 *
 * 1. **Module scope — silently ignored.** `shouldCollectTopLevelAssignment`
 *    kept a top-level write only for a name already in `ctx.moduleGlobals`,
 *    but the global that backs a reassigned function binding is minted by
 *    `registerReassignedFunctionGlobals` (#2931) AFTER that pass. The
 *    statement was dropped with no diagnostic; `typeof g` then also folded to
 *    `"function"` from the checker type, because `moduleGlobalIsDynamicButS…`
 *    resolves binding identity through `variableDeclarationOf`, which cannot
 *    answer for a `FunctionDeclaration`.
 * 2. **§B.3.3 block scope — hard trap.** `{ function f() { f = 123; } }` threw
 *    `RuntimeError: illegal cast in f()`. Constructibility of the cached
 *    closure singleton was decided per READ SITE: inside `f` the name resolves
 *    to the declaration (constructible subtype), at the outer Annex-B var
 *    binding TypeScript cannot resolve it at all (plain wrapper) — one shared
 *    `__fn_closure_f` global, two unrelated struct types.
 *
 * Both arms are pinned here. The JS-host lane is pinned too on the shapes that
 * were wrong in standalone, since the collection fix is target-independent.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a script-goal source for standalone and return `__probe()`'s string. */
async function runStandaloneProbe(source: string): Promise<string> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4491-t12.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "always",
  } as never);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return readWasmString(instance, (exports.__probe as () => unknown)());
}

/**
 * Read a host-free module's returned string back through the #2962
 * `__exn_render_prepare` / `__exn_render_char` pair — a standalone string is a
 * WasmGC struct, so `String(value)` on the JS side throws rather than rendering
 * it.
 */
function readWasmString(instance: WebAssembly.Instance, value: unknown): string {
  if (typeof value === "string") return value;
  const prepare = instance.exports.__exn_render_prepare as ((v: unknown) => number) | undefined;
  const charAt = instance.exports.__exn_render_char as ((i: number) => number) | undefined;
  if (typeof prepare !== "function" || typeof charAt !== "function") {
    throw new Error("standalone module did not export the __exn_render_* pair (hostBridge: 'always' required)");
  }
  const length = prepare(value);
  if (length < 0) throw new Error("__exn_render_prepare refused the returned value");
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(charAt(i));
  return out;
}

describe("#4491 T12 — assignment over a function-declaration binding", () => {
  it("module scope: the write lands and typeof follows the VALUE, not the checker type", async () => {
    const report = await runStandaloneProbe(`
      function g() { return 1; }
      g = 123;
      export function __probe() {
        return (typeof g) + "|" + (g === 123) + "|" + String(g);
      }
    `);
    // Before: "function|false|function () { [native code] }" — the whole
    // `g = 123;` statement never reached compileAssignment.
    expect(report).toBe("number|true|123");
  });

  it("module scope: a dynamic read of the reassigned binding sees the new value", async () => {
    const report = await runStandaloneProbe(`
      function g() { return 1; }
      function look(v) { return typeof v; }
      var after;
      g = 123;
      after = g;
      export function __probe() {
        return look(after) + "|" + (after === 123);
      }
    `);
    expect(report).toBe("number|true");
  });

  it("module scope: a function binding that is NEVER reassigned keeps folding", async () => {
    // The widening keys on `ctx.liveFuncBindingGlobals`, so an ordinary
    // declaration must stay on the static path (and answer "function").
    const report = await runStandaloneProbe(`
      function h() { return 1; }
      export function __probe() { return (typeof h) + "|" + h(); }
    `);
    expect(report).toBe("function|1");
  });

  it("§B.3.3 block scope: the block binding is mutable and independent of the var binding", async () => {
    // The `annexB/language/function-code/*-func-block-scoping` shape, reduced.
    // Before: `RuntimeError: illegal cast in f()`. Evidence is captured as
    // PRIMITIVES inside the closure: storing the function values and calling
    // them later through module externref slots exercises the separate
    // dynamic-slot call defect (T3's typeof-symbol family), not this pin —
    // and that path shifted under the post-#4723 upstream merge while the
    // real annexB rows kept passing.
    const report = await runStandaloneProbe(`
      var initialIsFn, currentBV, varIsFn, callResult;
      (function () {
        {
          function f() { initialIsFn = typeof f; f = 123; currentBV = f; return 'decl'; }
        }
        varIsFn = typeof f;
        callResult = f();
      }());
      export function __probe() {
        return initialIsFn + "|" + currentBV + "|" + varIsFn + "|" + callResult;
      }
    `);
    // `varIsFn` SHOULD be "function" (§B.3.3 promotes the value to the var
    // binding); it reads "undefined" because `typeof` on an initializer-less
    // var written only by a function still const-folds — T12's documented
    // open residual (#4204 family). The call itself works (callResult
    // "decl"), which is what this pin guards. Tighten to "function" when
    // that residual is fixed.
    expect(report).toBe("function|123|undefined|decl");
  });

  it("§B.3.3 block scope: the same shape under `switch`", async () => {
    const report = await runStandaloneProbe(`
      var initialIsFn, currentBV, varIsFn, callResult;
      (function () {
        switch (1) {
          case 1:
            function f() { initialIsFn = typeof f; f = 123; currentBV = f; return 'decl'; }
        }
        varIsFn = typeof f;
        callResult = f();
      }());
      export function __probe() {
        return initialIsFn + "|" + currentBV + "|" + varIsFn + "|" + callResult;
      }
    `);
    // `varIsFn` SHOULD be "function" (§B.3.3 promotes the value to the var
    // binding); it reads "undefined" because `typeof` on an initializer-less
    // var written only by a function still const-folds — T12's documented
    // open residual (#4204 family). The call itself works (callResult
    // "decl"), which is what this pin guards. Tighten to "function" when
    // that residual is fixed.
    expect(report).toBe("function|123|undefined|decl");
  });
});
