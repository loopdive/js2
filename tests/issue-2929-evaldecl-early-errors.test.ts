// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2929 — EvalDeclarationInstantiation early errors on the AOT constant-splice
// path (buckets A + B of the 2026-08-08 implementation plan).
//
// Both populations use LITERAL eval sources, so they never reach the runtime
// interpreter: `tryStaticEvalInline` splices the foreign AST into the caller
// and returns before provider routing. The interpreter side was already correct
// for both rules; the splice was missing exactly two caller-dependent
// behaviours.
//
//   A. §19.2.1.3 step 5.a — when eval's VariableEnvironment IS the
//      GlobalEnvironmentRecord, a sloppy VarDeclaredName colliding with a
//      Script lexical declaration must throw a runtime SyntaxError. The splice
//      never consulted `ctx.globalLexicalBindings`, so it evaluated silently.
//      (test262 `{direct,indirect}/var-env-global-lex-non-strict.js`)
//
//   B. §19.2.1 PerformEval steps 17-20 — the eval Script's LexicalEnvironment
//      is a FRESH record discarded on exit. `compileInlinedEvalStatements`
//      registered the body's top-level `let`/`const`/class into the caller's
//      live `fctx.localMap` and never removed them, so the binding leaked and a
//      later caller read resolved instead of producing an unresolved reference.
//      (test262 `{direct,indirect}/lex-env-{distinct,no-init}-{let,const}.js`)
//
// A compile-time fold must never erase a required early error. The guard
// EMIT-THROWS (rather than bailing to the provider) because the error is
// statically certain — the Script's lexical name set is a compile-time
// constant — which also covers host/GC mode, where no provider exists.
//
// The negative canaries below are the regression pins named in §7 of the plan:
// the guard must NOT fire for strict eval, Annex B block functions,
// function-scope callers, or unrelated names.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile a sloppy SCRIPT-goal standalone module, mirroring the test262
 * runner's options (`inferModuleStrictArguments: false`, `deferTopLevelInit`).
 * The source self-checks and throws on mismatch, exactly like a test262 file,
 * so "module init completed without throwing" IS the assertion.
 */
async function runScript(src: string): Promise<void> {
  const r = await compile(src, {
    allowJs: true,
    fileName: "issue-2929.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const init = (instance.exports as { __module_init?: () => void }).__module_init;
  expect(init, "standalone script must export __module_init").toBeTypeOf("function");
  init!();
}

/**
 * True when the eval call site bailed to the runtime-eval provider instead of
 * being compiled away. Used for shapes that MUST stay on the dynamic tier — if
 * the new guard wrongly fired, the call would have been folded to a static
 * throw and the provider import would be absent.
 */
async function bailsToProvider(src: string): Promise<boolean> {
  const r = await compile(src, {
    allowJs: true,
    fileName: "issue-2929.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  return Buffer.from(r.binary).includes("js2wasm:runtime-eval");
}

describe("#2929 bucket A — global-lexical collision guard", () => {
  it("direct eval at global scope: let x; eval('var x;') throws SyntaxError", async () => {
    await runScript(`let x;
var caught = null;
try { eval('var x;'); } catch (e) { caught = e; }
if (caught === null) throw new Error('expected a SyntaxError, nothing thrown');
if (caught.constructor !== SyntaxError) throw new Error('wrong constructor');
`);
  });

  it("indirect eval: let x; (0,eval)('var x;') throws SyntaxError", async () => {
    await runScript(`let x;
var caught = null;
try { (0,eval)('var x;'); } catch (e) { caught = e; }
if (caught === null) throw new Error('expected a SyntaxError, nothing thrown');
if (caught.constructor !== SyntaxError) throw new Error('wrong constructor');
`);
  });

  it("a top-level function declaration in the eval body is a VarDeclaredName too", async () => {
    await runScript(`let fx;
var caught = null;
try { eval('function fx(){}'); } catch (e) { caught = e; }
if (caught === null) throw new Error('expected a SyntaxError, nothing thrown');
if (caught.constructor !== SyntaxError) throw new Error('wrong constructor');
`);
  });

  it("a global BLOCK at the call site does not suppress the guard (varEnv is still global)", async () => {
    // Blocks/switch/catch change the LexicalEnvironment, never the
    // VariableEnvironment — this is why the predicate is the `__module_init`
    // fctx identity, not `directEvalRunsAtScriptGlobal`.
    await runScript(`let bx;
var caught = null;
try { { eval('var bx;'); } } catch (e) { caught = e; }
if (caught === null) throw new Error('expected a SyntaxError, nothing thrown');
if (caught.constructor !== SyntaxError) throw new Error('wrong constructor');
`);
  });

  // ── negative pins (§7 "false-positive SyntaxError is the top regression risk")

  it("Annex B.3.3 cancels, never throws: let x; eval('{ function x(){} }') is fine", async () => {
    await runScript(`let x;
eval('{ function x(){} }');
`);
  });

  it("Annex B.3.5 catch parameter: try{}catch(e){ eval('var e;') } at global routes, never static-throws", async () => {
    // CatchClause bindings are NOT in `ctx.globalLexicalBindings` (only
    // top-level let/const/class are), so the bucket-A guard correctly stays
    // silent. Since the C+D slice this global-varEnv var declaration is owned
    // by the provider (which B.3.5-exempts the catch binding in
    // `validateNonStrictEvalVarNames`), so the assertion is that it ROUTES —
    // the one thing that must never happen is folding to a static throw.
    expect(await bailsToProvider(`try { throw 1; } catch (e) { eval('var e;'); }\n`)).toBe(true);
  });

  it("a function-scope caller has its own varEnv: let x; function h(){ eval('var x;') } is fine", async () => {
    await runScript(`let x;
function h() { eval('var x;'); return 1; }
if (h() !== 1) throw new Error('h() misbehaved');
`);
  });

  it("an unrelated eval var name does not collide (routes, no static throw)", async () => {
    // `y` misses `globalLexicalBindings`, so the bucket-A guard stays silent
    // and the C+D slice hands the global-varEnv declaration to the provider.
    expect(await bailsToProvider(`let x;\neval('var y;');\n`)).toBe(true);
  });

  it("strict eval gets a private varEnv — it must not fold to a static throw", async () => {
    expect(await bailsToProvider(`let x;\neval('"use strict"; var x;');\n`)).toBe(true);
  });

  it("indirect eval in a function must not see caller lexicals — it must not fold to a static throw", async () => {
    expect(await bailsToProvider(`function g() { let w; (0,eval)('var w;'); return 1; }\ng();\n`)).toBe(true);
  });

  it("a dynamic source stays on the provider tier (the interpreter owns that check)", async () => {
    expect(await bailsToProvider(`let x;\nvar s = 'var x;';\neval(s);\n`)).toBe(true);
  });
});

describe("#2929 bucket B — scoped lexical isolation for the splice", () => {
  it("eval('let a = 1; a') evaluates to 1 but leaves no caller binding", async () => {
    await runScript(`var r = eval('let a = 1; a');
if (r !== 1) throw new Error('eval result was ' + r);
if (typeof a !== 'undefined') throw new Error('binding leaked: typeof a === ' + typeof a);
`);
  });

  it("a same-named caller binding is shadowed by the eval, then restored", async () => {
    await runScript(`let o = 23;
eval('let o;');
if (o !== 23) throw new Error('caller binding clobbered: o === ' + o);
`);
  });

  it("a bare read of an eval-declared let is an unresolved reference afterwards", async () => {
    await runScript(`eval('let q = 3;');
var caught = null;
try { q; } catch (e) { caught = e; }
if (caught === null) throw new Error('expected a ReferenceError, nothing thrown');
`);
  });

  it("const isolates the same way as let", async () => {
    await runScript(`eval('const c = 7;');
if (typeof c !== 'undefined') throw new Error('const leaked: typeof c === ' + typeof c);
`);
  });

  it("isolation also holds inside a function body", async () => {
    await runScript(`function f() { eval('let z = 5;'); return typeof z; }
var t = f();
if (t !== 'undefined') throw new Error('leaked into function scope: ' + t);
`);
  });

  it("indirect eval isolates its lexicals too", async () => {
    await runScript(`(0,eval)('let ind = 9;');
if (typeof ind !== 'undefined') throw new Error('indirect let leaked: typeof ind === ' + typeof ind);
`);
  });

  it("eval-created sloppy VARS at global routes to the provider (#1102 AC2 moved, not dropped)", async () => {
    // Bucket B deliberately left sloppy vars alone, so the splice kept them as
    // caller locals. The C+D slice moves the GLOBAL-varEnv case to the
    // provider, where the var becomes an own property of the realm global —
    // the actual spec behaviour. Persistence is still verified end-to-end, by
    // `tests/issue-2929-cd-global-materialization.test.ts` and by test262
    // `language/eval-code/{direct,indirect}/var-env-var-init-global-*`.
    // The #1102 AC2 TS-module lane is untouched: it is strict, so `evalIsStrict`
    // excludes it from the new bail.
    expect(await bailsToProvider(`eval('var kept = 11;');\n`)).toBe(true);
  });
});

describe("#2929 bucket B — the discarded slot must be invisible to LATER closures", () => {
  /**
   * The #1177 block-scope-shadow rescue in `closures/arrow-phases.ts` falls back
   * to scanning `fctx.locals` BY NAME when `localMap` misses. Dropping the name
   * mapping alone therefore did NOT close the leak: a lifted thunk created after
   * the eval resurrected the eval's orphaned slot and read it happily. Only the
   * IIFE shape (compiled in the caller's own context) threw. This is the exact
   * shape test262's `assert.throws(ReferenceError, function(){ x; })` uses.
   */
  async function outcomeOf(src: string): Promise<number> {
    const r = await compile(src, {
      allowJs: false,
      fileName: "issue-2929.ts",
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const THREW = 2;

  it("a thunk PASSED TO A HELPER throws on the eval-declared name (assert.throws shape)", async () => {
    expect(
      await outcomeOf(`var outcome = 0;
function thr(f) { try { f(); outcome = 1; } catch (e) { outcome = 2; } }
eval('let q2 = 3;');
thr(function () { q2; });
export function test(): number { return outcome; }
`),
    ).toBe(THREW);
  });

  it("a thunk stored in a var then called throws too", async () => {
    expect(
      await outcomeOf(`var outcome = 0;
eval('let q3 = 3;');
var f = function () { q3; };
try { f(); outcome = 1; } catch (e) { outcome = 2; }
export function test(): number { return outcome; }
`),
    ).toBe(THREW);
  });

  it("a closure created INSIDE the eval body is provider-owned since the C+D slice", async () => {
    // Originally a SPLICE canary: the bucket-B slot rename only re-labels the
    // slot, so a closure built inside the eval body keeps reading its lexical.
    //
    // That shape is no longer spliced. The only inline-supported way to build a
    // closure in a foreign eval body is a FunctionDeclaration (function
    // *expressions* have never been inline-supported), and a top-level
    // FunctionDeclaration is a VarDeclaredName — routed by the C+D slice at
    // global scope (slice 1) and in function callers (slice 2) alike. So assert
    // the routing; the splice-path slot rename stays pinned by the two sibling
    // thunk canaries above, which still fold.
    expect(
      await bailsToProvider(`var outcome = 0;
eval('let cv = 7; function g() { return cv; }');
outcome = (g() === 7) ? 2 : 1;
`),
    ).toBe(true);
  });

  it("a same-named CALLER binding stays capturable by a later closure", async () => {
    expect(
      await outcomeOf(`var outcome = 0;
function call(f) { return f(); }
let keep = 23;
eval('let keep;');
outcome = (call(function () { return keep; }) === 23) ? 2 : 1;
export function test(): number { return outcome; }
`),
    ).toBe(THREW);
  });
});

describe("#2929 — TDZ typeof inside an eval body routes to the provider", () => {
  // `typeof-delete.ts` resolves the operand via `checker.getSymbolAtLocation`;
  // a FOREIGN eval identifier has no symbol, so it takes the
  // genuinely-unresolvable arm and folds to "undefined", erasing the required
  // ReferenceError. The splice cannot express it, so it must not fold it away.
  async function bails(src: string): Promise<boolean> {
    const r = await compile(src, {
      allowJs: true,
      fileName: "issue-2929.js",
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      target: "standalone",
      deferTopLevelInit: true,
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    return Buffer.from(r.binary).includes("js2wasm:runtime-eval");
  }

  it("eval('typeof x; let x;') bails to the provider", async () => {
    expect(await bails(`eval('typeof x; let x;');\n`)).toBe(true);
  });

  it("eval('typeof x; const x = 1;') bails to the provider", async () => {
    expect(await bails(`eval('typeof x; const x = 1;');\n`)).toBe(true);
  });

  it("a nested-block TDZ typeof bails too", async () => {
    expect(await bails(`eval('{ typeof y; let y; }');\n`)).toBe(true);
  });

  it("typeof AFTER the declaration still folds (no needless bail)", async () => {
    expect(await bails(`eval('let z = 1; typeof z;');\n`)).toBe(false);
  });

  it("typeof of an unrelated name still folds", async () => {
    expect(await bails(`eval('typeof nope; let w = 1;');\n`)).toBe(false);
  });
});

describe("#2929 — pre-existing collision paths stay green", () => {
  it("lower-lexical collision in a function caller still throws SyntaxError", async () => {
    await runScript(`function f() { let y; return eval('var y;'); }
var caught = null;
try { f(); } catch (e) { caught = e; }
if (caught === null) throw new Error('expected a SyntaxError, nothing thrown');
if (caught.constructor !== SyntaxError) throw new Error('wrong constructor');
`);
  });
});
