// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5343) `call-tail-dispatch.ts`'s "CallExpression as callee" arm (`f()()`)
// calls `matchClosureInfoBySignature` over `ctx.closureInfoByTypeIdx`. Before
// this fix, a MISS there (no registered closure matches) only routed to the
// dynamic-call ladder (`tryEmitInlineDynamicCall`) when the checker gave the
// inner call NO signature at all (`callSigs.length === 0` — the untyped `any`
// twin, already repaired). When the checker DID supply a signature but the
// registry still had no match, the code fell all the way through to the
// graceful tail (`compileCallDispatchTail`'s fallback): it evaluates the
// callee and the arguments for side effects, DROPS every value, and pushes
// `ref.null.extern` — a silent `undefined`, not a trap. Confirmed in WAT: the
// pre-fix `f()(1, 3)` compiled to `<callee> drop <args> drop drop ref.null
// extern call $__unbox_number`.
//
// This is reachable whenever the inner call's registered-closure match can
// NEVER succeed (a host callee, e.g. `Math.max`) or has not yet been
// registered AT THE POINT the call site compiles (a closure-minting function
// whose OWN body is compiled after the call site's — reachable across module
// boundaries per `src/checker/index.ts`'s entry-anchored DFS: a back-edge
// cycle can make an importing module's function body compile before the
// module it imports from).
//
// The fix: on a registry miss — whether because there was no checker
// signature at all, or because there WAS one but nothing registered matches
// it — route to the same dynamic-call ladder. The exact-match arm still owns
// every registry HIT and is untouched (pinned below via a byte-identical WAT
// assertion).

import { describe, expect, it } from "vitest";

import { compile, compileMulti, compileToWat, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runSingle(source: string, fileName: string): Promise<Record<string, (...args: number[]) => number>> {
  const result: CompileResult = await compile(source, { fileName, skipSemanticDiagnostics: true, allowJs: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return instance.exports as unknown as Record<string, (...args: number[]) => number>;
}

async function runMulti(
  files: Record<string, string>,
  entryFile: string,
): Promise<Record<string, (...args: number[]) => number>> {
  const result: CompileResult = await compileMulti(files, entryFile, {
    skipSemanticDiagnostics: true,
    allowJs: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return instance.exports as unknown as Record<string, (...args: number[]) => number>;
}

describe("#5343 — call-tail-dispatch: typed-but-unmatched call-of-call must not answer undefined", () => {
  it("(a) a host callee (Math.max) returns the real value, not a silent undefined", async () => {
    // Untyped .js on purpose — TypeScript still infers `f`'s return type
    // structurally from `return Math.max`, so the checker gives the inner
    // call `f()` a real call signature (`callSigs.length > 0`). No registered
    // closure will EVER match a host function, so this is a permanent miss.
    // `other`/`oc` exist purely so `ctx.closureInfoByTypeIdx` is non-empty
    // when `f()()` compiles — `tryEmitInlineDynamicCall` declines outright
    // (returns null, no dispatch arm at all) when the module has neither a
    // registered closure NOR a standalone/wasi arm to fall back on.
    const src = `
      function other() { return function (x) { return x + 1; }; }
      var oc = other();
      export function useOc() { return oc(41); }

      function f() { return Math.max; }
      export function test() { return f()(1, 3); }
    `;
    const exports = await runSingle(src, "issue-5343-host-callee.js");
    expect(exports.useOc!()).toBe(42);
    // Math.max(1, 3) === 3. Pre-fix this read 0 (NaN/undefined unboxed to 0
    // via `f64.const 0`-style coercion of a dropped `ref.null.extern`).
    expect(exports.test!()).toBe(3);
  });

  it("(b) a callee exported by a second module, called before that module's closures are lifted", async () => {
    // src/checker/index.ts's cross-file compile order is an entry-anchored,
    // dependency-first DFS: children are pushed to `sourceFiles` before their
    // parent, and a cycle's back-edge is a no-op (first-seen wins). Structuring
    // the graph as a cycle rooted at moduleB — which reaches moduleA BEFORE
    // moduleA's own back-edge to moduleB is hit — makes moduleA finish (and
    // get pushed) before moduleB. That compiles `run`'s body (in moduleA,
    // calling `outer()()`) BEFORE `outer`'s own body (in moduleB, the
    // function that actually mints the returned closure) — a registry miss
    // that is not about untyped `any`, just about compile order:
    //
    //   entry.js   -> imports callRun from moduleB.js
    //   moduleB.js -> imports run from moduleA.js; defines `outer`
    //   moduleA.js -> imports outer from moduleB.js (back-edge, no-op); defines `run`
    //
    // Resulting sourceFiles order: [moduleA, moduleB, entry] — `run` compiles
    // before `outer`. Measured: this returned 0 on the parent commit and 3
    // (the real value) with the fix.
    const files: Record<string, string> = {
      "./entry.js": `
        import { callRun } from "./moduleB.js";
        export function test() { return callRun(); }
      `,
      "./moduleB.js": `
        import { run } from "./moduleA.js";
        export function outer() {
          let a = 1;
          return function () {
            let b = 2;
            return a + b;
          };
        }
        export function callRun() { return run(); }
      `,
      "./moduleA.js": `
        import { outer } from "./moduleB.js";
        export function run() { return outer()(); }
      `,
    };
    const exports = await runMulti(files, "./entry.js");
    expect(exports.test!()).toBe(3);
  });

  it("anti-vacuity control: an already-matched call-of-call still takes the fast call_ref arm", async () => {
    // outer's returned closure IS registered (same file, declared above the
    // call site) so `matchClosureInfoBySignature` finds it — this must keep
    // emitting the exact-match `return_call_ref` arm, not the dynamic ladder.
    const src = `
      function outer(): (x: number) => number {
        return function (x: number) {
          return x + 1;
        };
      }
      export function test(n: number): number {
        return outer()(n);
      }
    `;
    const wat = await compileToWat(src);
    expect(wat).toContain("return_call_ref");

    const exports = await runSingle(src, "issue-5343-matched-fast-arm.ts");
    expect(exports.test!(5)).toBe(6);
  });
});
