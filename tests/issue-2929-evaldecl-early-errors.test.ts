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

  it("Annex B.3.5 catch parameter: try{}catch(e){ eval('var e;') } at global is fine", async () => {
    // CatchClause bindings are NOT in `ctx.globalLexicalBindings` (only
    // top-level let/const/class are), so the guard correctly stays silent.
    await runScript(`try { throw 1; } catch (e) { eval('var e;'); }
`);
  });

  it("a function-scope caller has its own varEnv: let x; function h(){ eval('var x;') } is fine", async () => {
    await runScript(`let x;
function h() { eval('var x;'); return 1; }
if (h() !== 1) throw new Error('h() misbehaved');
`);
  });

  it("an unrelated eval var name does not collide", async () => {
    await runScript(`let x;
eval('var y;');
`);
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
