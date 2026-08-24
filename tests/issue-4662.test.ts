// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4662) `++` / `--` on a name bound in a FUNCTION variable environment threw
// `ReferenceError: <name> is not defined` inside eval'd / `Function`-minted code.
//
// ROOT CAUSE — `tryEmitUnresolvableUpdateThrow` (src/codegen/update-unresolvable-ref.ts)
// gates the §13.4.4 static throw on `ctx.oracle.isUnresolvableIdentifier`, which is
// `checker.getSymbolAtLocation(id) === undefined`. An eval'd / minted body is parsed
// into a FOREIGN `ts.SourceFile` (`<eval>.ts`) that is never added to the program, so
// the checker answers `undefined` for EVERY identifier in it — the body's own
// parameters and locals included. "The checker has no opinion" was being read as "the
// reference is unresolvable". Instrumented on campaign HEAD 74389b417, all six
// throwing cells below reached that site with `fctx.localMap.has(name) === true`: the
// binding was live in the very FunctionContext being compiled.
//
// WHY ONLY UPDATE EXPRESSIONS — that helper is called from `compilePrefixUpdate` /
// `compilePostfixUnary` and from nowhere else. A plain read and a compound assignment
// (`x = x + 1`) never consult the checker for resolvability, which is why `p` read
// fine and `p = p + 1` wrote fine while `p++` threw. The axis is WHERE THE NAME IS
// BOUND, not the operator's spelling and not the nesting depth: a top-level
// `new Function("p","p++; return p;")` throws with no enclosing function anywhere.
//
// FIX — decline when codegen already holds a binding for the name (`fctx.localMap`,
// a boxed cell, a module global, a captured global, a boxed captured global — the
// very arms the caller takes next). Absent-not-wrong: where codegen knows the
// binding the static diagnostic is provably false; where it does not, nothing
// changes and a genuinely undeclared name still gets the §13.4.4 throw.
//
// TIERS — every shape pinned below is compiled by the STATIC SPLICE, so it never
// crosses the runtime-eval provider seam and its answer cannot depend on which
// provider is installed. That is not an assumption here: `import manifest` at the
// bottom asserts it from the emitted binary (spliced shapes import nothing; a
// splice-DECLINING mint imports `js2wasm:runtime-eval.*`). The suite therefore runs
// identically under the default lane and under `JS2WASM_EVAL_ENGINE=interpreter`
// with the REFUSAL provider, and was executed under both.
//
// CONTROLS — this file must claim "`++` on a function-environment binding", not
// "eval scope is broken". So each positive pin sits next to (a) a control showing the
// binding already EXISTED on base (a plain read and a compound assignment on the same
// parameter both answered correctly before the fix), (b) an axis control showing the
// module-environment `++` was never broken, and (c) negative controls showing the
// §13.4.4 throw this module exists for still fires. A fix that widened the decline
// too far would break the negatives; a fix that "repaired eval scope" wholesale would
// not be distinguishable from one that did nothing without (a).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `<prelude> export function test(): number { <body> }` for standalone. */
async function compileStandalone(body: string, prelude = "") {
  const result = await compile(`${prelude}\nexport function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4662.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  } as never);
  expect(
    result.success,
    result.errors.map((error: { line: number; message: string }) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  return result;
}

/** Run host-free — NO imports at all, so no provider can influence the answer. */
async function run(body: string, prelude = ""): Promise<number> {
  const result = await compileStandalone(body, prelude);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** 1 when `body` threw a ReferenceError, 2 for any other throw, 0 for no throw. */
const refErr = (stmt: string) =>
  `try { ${stmt} return 0; } catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }`;

describe("#4662 — `++`/`--` on a FUNCTION-environment binding in eval'd / minted code", () => {
  // Every pin EXECUTES the update expression and reads the updated binding back;
  // asserting the shape compiles would not test what broke.
  it("`Function` mint's own PARAMETER — postfix `++`", async () => {
    expect(await run(`return new Function("p", "p++; return p;")(1);`)).toBe(2);
  });

  it("`Function` mint's own PARAMETER — prefix `++`", async () => {
    expect(await run(`return new Function("p", "return ++p;")(1);`)).toBe(2);
  });

  it("`Function` mint's own PARAMETER — postfix `--` (the operator is not the axis)", async () => {
    expect(await run(`return new Function("p", "p--; return p;")(1);`)).toBe(0);
  });

  it("`Function` mint's own PARAMETER — prefix `--`", async () => {
    expect(await run(`return new Function("p", "return --p;")(1);`)).toBe(0);
  });

  it("`Function` mint's own local `var`", async () => {
    expect(await run(`return new Function("var q = 5; q++; return q;")();`)).toBe(6);
  });

  it("direct eval inside a function — the ENCLOSING function's local", async () => {
    expect(await run(`var d = 3; eval("d++;"); return d;`)).toBe(4);
  });

  it("direct eval inside a function — the ENCLOSING function's PARAMETER", async () => {
    expect(await run(`return (function (a) { eval("a++;"); return a; })(3);`)).toBe(4);
  });

  it("direct eval inside a function — the eval's OWN `var`", async () => {
    expect(await run(`return eval("var z = 1; z++; z");`)).toBe(2);
  });

  // RULE REFINEMENT (measured here, contradicting the issue's v3 wording).
  // v3 said the defect spares "names bound in the module/global environment".
  // That held for its probes because they were SCRIPTS: a script-level `var`
  // becomes a realm-global property, which the #4640 D3 sloppy-implicit-global
  // decline catches BEFORE the unresolvable check. A `var` at the top of a
  // MODULE becomes a `ctx.moduleGlobals` entry, is not an implicit global, and
  // threw on base exactly like a function-environment binding. The axis is
  // therefore "which decline catches the name first", and "module/global is
  // safe" was an artifact of the probe harness, not a property of the compiler.
  it("module-scope `var` updated from inside a direct eval (broken on base too)", async () => {
    expect(await run(`eval("g4662++;"); return g4662;`, `var g4662 = 10;`)).toBe(11);
  });

  // UNFOLDABLE: the operand is loop-carried, so no constant fold can answer these
  // without actually running the update through the minted / eval'd binding.
  it("mint parameter updated across a loop-carried value (unfoldable)", async () => {
    expect(
      await run(`var mint: any = new Function("p", "p++; return p;");
                 var s = 0;
                 for (var i = 0; i < 3; i = i + 1) { s = mint(s); }
                 return s;`),
    ).toBe(3);
  });

  it("enclosing-function local updated by a direct eval inside a loop (unfoldable)", async () => {
    expect(
      await run(`var c = 0; var i = 0;
                 while (i < 4) { eval("c++;"); i = i + 1; }
                 return c;`),
    ).toBe(4);
  });

  // RESIDUAL, out of scope for #4662 and NOT caused by it. Swapping the `while`
  // above for a `for (var i = 0; …)` head makes the MODULE fail Wasm validation:
  //   local.tee[0] expected type (ref null 117), found local.get of type i32
  // Measured on BOTH arms (campaign HEAD 74389b417 and this branch), and — the
  // discriminator — the same shape with COMPOUND assignment in place of the
  // update expression (`eval("c = c + 1;")`) fails identically on both arms.
  // Compound assignment never touches `tryEmitUnresolvableUpdateThrow`, so the
  // root is the `for (var …)` head's interaction with direct-eval binding
  // reification (the loop counter's cell promotion), not the update operator.
  // Left `it.fails` with that root named so a fix there surfaces here instead of
  // being masked; see `## Residuals` in the issue file.
  it.fails("RESIDUAL: `for (var i = …)` + direct eval mis-types the reified cell local", async () => {
    expect(
      await run(`var c = 0;
                 for (var i = 0; i < 4; i = i + 1) { eval("c++;"); }
                 return c;`),
    ).toBe(4);
  });

  // ── POSITIVE CONTROLS ────────────────────────────────────────────────────────
  // These answered correctly on BASE too. That is the point: they establish that
  // the binding EXISTED all along, so the pins above are about the update
  // expression's own reference resolution and not about eval scope in general.
  it("CONTROL: the mint's parameter IS bound — a plain read answers it (green on base)", async () => {
    expect(await run(`return new Function("p", "return p;")(7);`)).toBe(7);
  });

  it("CONTROL: compound assignment WRITES that same parameter (green on base)", async () => {
    expect(await run(`return new Function("p", "p = p + 1; return p;")(1);`)).toBe(2);
  });

  it("CONTROL: `++` on an ordinary function local, no eval anywhere (green on base)", async () => {
    expect(await run(`var k = 1; k++; return k;`)).toBe(2);
  });

  it("CONTROL: `++` on a MODULE-scope `var`, no eval anywhere (green on base)", async () => {
    expect(await run(`g4662ctl++; return g4662ctl;`, `var g4662ctl = 10;`)).toBe(11);
  });

  // ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
  // §13.4.4 GetValue on an UNRESOLVABLE reference must still throw. All five were
  // already correct on base and must not move: they are what a too-wide decline
  // would break.
  it("NEGATIVE: `++` on a genuinely undeclared name inside a MINT still throws ReferenceError", async () => {
    expect(await run(refErr(`return new Function("return und4662a++;")();`))).toBe(1);
  });

  it("NEGATIVE: `++` on a genuinely undeclared name inside a direct EVAL still throws", async () => {
    expect(await run(refErr(`eval("und4662b++;");`))).toBe(1);
  });

  it("NEGATIVE: `++` on a genuinely undeclared name in ORDINARY source still throws", async () => {
    expect(await run(refErr(`return und4662c++;`))).toBe(1);
  });

  it("NEGATIVE: prefix `--` on a genuinely undeclared name still throws", async () => {
    expect(await run(refErr(`return --und4662d;`))).toBe(1);
  });

  it("NEGATIVE: a `with`-supplied name is still resolved at run time, not statically thrown", async () => {
    expect(await run(`var o: any = { w: 1 }; with (o) { w++; } return o.w;`)).toBe(2);
  });

  // The #4640 D3 sloppy-implicit-global decline sits ABOVE this change in the
  // same function and is untouched by it, so there is no pin for it here: a
  // host-free module has no realm global object, and even the plain READ
  // (`x = 5; return x;`) throws under this file's harness on BOTH arms — a
  // harness limit, not a behavioural one. It is covered where it can be measured
  // honestly: `language/statements/for/S12.6.3_A10_T1` and `A10.1_T1` (the two
  // rows #4640 D3 cites) were run through the full test262 harness on both arms
  // and did not move — see `## Test Results` in the issue file.

  // ── TIER CLAIM, verified structurally ────────────────────────────────────────
  // The pins above are provider-INDEPENDENT because the static splice compiles
  // those bodies into the module: their import manifest is EMPTY, so there is no
  // runtime-eval seam for a quickjs / refusal provider to answer differently. The
  // splice-declining mint is the contrast case and DOES import the seam — without
  // it, "the manifest is empty" would be a claim about compiling nothing.
  const importsOf = async (body: string): Promise<string[]> => {
    const result = await compileStandalone(body);
    const mod = await WebAssembly.compile(result.binary);
    return WebAssembly.Module.imports(mod).map((entry) => `${entry.module}.${entry.name}`);
  };

  it("TIER: the pinned mint shape crosses NO runtime-eval seam (import manifest empty)", async () => {
    expect(await importsOf(`return new Function("p", "p++; return p;")(1);`)).toEqual([]);
  });

  it("TIER: the pinned direct-eval shape crosses NO runtime-eval seam", async () => {
    expect(await importsOf(`var d = 3; eval("d++;"); return d;`)).toEqual([]);
  });

  it("TIER: a splice-DECLINING mint DOES import the provider seam (contrast case)", async () => {
    const names = await importsOf(`return new Function("var f = function () { return 9; }; return f();")();`);
    expect(names.some((n) => n.startsWith("js2wasm:runtime-eval."))).toBe(true);
  });
});
