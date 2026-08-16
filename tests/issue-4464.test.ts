// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4464) `language/statements/function` — the three families this issue
// actually closed, plus `it.fails` pins on the two it deliberately did not.
//
// Scoped sweep of the whole directory, standalone, run on this branch's base
// (`origin/main`) and on this branch, both by the same driver
// (`runTest262File(..., "standalone")` over all 256 `.js` files):
//
//   | state       | pass | fail | compile_error |
//   | ----------- | ---- | ---- | ------------- |
//   | origin/main | 194  | 60   | 2             |
//   | this branch | 209  | 45   | 2             |
//
// +15 flips, zero regressions. The per-probe numbers quoted in each block
// below come from the same A/B (base captured by reverting exactly the files
// this change-set touches to their `origin/main` contents).
//
// Every block pins a NEGATIVE control next to its positive one, because each
// family's failure mode is over-application, not under-application:
//
//   - F1 turns a property READ into an unconditional throw, so a false
//     positive poisons a sloppy function that must answer `undefined`;
//   - F2 makes `new <FunctionExpression>` return the body's `return` operand,
//     so a mis-classified primitive would leak out in place of the receiver;
//   - the dead-binding elision change KEEPS statements it used to delete, so
//     the control is that an error-free dead binding is still elided.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function compileStandalone(source: string) {
  return await compile(source, {
    allowJs: true,
    fileName: "issue-4464.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
}

/** Compile `body` as `test()` and run it with NO imports — a host-free module. */
async function runHostFree(body: string): Promise<number> {
  const result = await compileStandalone(`export function test(): number { ${body} }`);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * Same, but with the runtime-eval provider attached when the module asks for
 * it — the seam every test262 standalone lane goes through. `Function(<body>)`
 * imports `js2wasm:runtime-eval.__runtime_new_function`, so the F1 family
 * cannot be exercised host-free.
 */
async function runLinked(body: string): Promise<number> {
  const result = await compileStandalone(`export function test(): number { ${body} }`);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(result.binary, {}, { target: "standalone", providerLabel: "#4464" });
  return (instance.exports as { test(): number }).test();
}

/** 1 when reading `<expr>` threw a TypeError, 2 for another throw, 0 for no throw. */
const readThrows = (expr: string) =>
  `try { var t = ${expr}; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }`;

/**
 * CI's changed-root lane runs under `JS2WASM_EVAL_ENGINE=interpreter` with the
 * REFUSAL provider, where minting a function from a STRICT body string throws
 * at the provider (a raw WebAssembly.Exception escaping the module) before any
 * poison read can run — same tier seam as tests/issue-4442.test.ts. Under that
 * tier these pins assert the observable that survives: the mint REACHES the
 * provider and its refusal escapes. (The sloppy-body negative controls fold
 * AOT and never call the provider, which is why they stay tier-independent.)
 */
const REFUSAL_TIER = process.env.JS2WASM_EVAL_ENGINE === "interpreter";
async function expectRefusalEscape(p: Promise<number>): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  expect(threw, "refusal-tier mint should throw out of the module").toBe(true);
}

describe("#4464 F1 — `caller`/`arguments` poison on a `Function(…)`-minted strict function", () => {
  // `sourceFunctionForValue` can only see functions with a source declaration.
  // A `Function("'use strict';")` product has none — its body is a runtime
  // string — so the §13.2 poison lowering declined and the read answered
  // `undefined`. Measured on base: every assertion below returned 0.
  // Flipped: `13.2-{5,6,9,10,13,14,17,18}-s.js` (8 files).
  it("throws TypeError reading `.caller`", async () => {
    const run = runLinked(`var foo = new Function("'use strict';"); ${readThrows("(foo as any).caller")}`);
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });

  it("throws TypeError reading `.arguments`", async () => {
    const run = runLinked(`var foo = new Function("'use strict';"); ${readThrows("(foo as any).arguments")}`);
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });

  it("throws TypeError ASSIGNING `.caller` — the same [[ThrowTypeError]] accessor", async () => {
    const run = runLinked(
      `var foo = new Function("'use strict';");
       try { (foo as any).caller = 1; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }`,
    );
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });

  it("treats the call form `Function(…)` exactly like `new Function(…)`", async () => {
    const run = runLinked(`var foo = Function("'use strict';"); ${readThrows("(foo as any).arguments")}`);
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });

  it("sees a prologue behind leading comments", async () => {
    const run = runLinked(`var foo = new Function("/*c*/ 'use strict';"); ${readThrows("(foo as any).caller")}`);
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });

  // NEGATIVE CONTROLS. Both returned "no throw" on base too — that is the
  // point: they must not have moved. A poison arm that fires on these would
  // have flipped the 8 files above while breaking every sloppy `.caller` read.
  it("does NOT poison a SLOPPY `Function(…)` product", async () => {
    expect(
      await runLinked(`var bar = new Function(""); try { var t = (bar as any).caller; return 1; } catch { return 0; }`),
    ).toBe(1);
  });

  it("does NOT treat a directive AFTER another statement as a prologue (§14.1.1)", async () => {
    // `var x=1; 'use strict';` leaves the function SLOPPY: the Directive
    // Prologue is only the LEADING run of string-literal statements.
    expect(
      await runLinked(
        `var bar = new Function("var x=1; 'use strict';"); try { var t = (bar as any).caller; return 1; } catch { return 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#4464 F2 — `new <FunctionExpression>` performs a real [[Construct]]", () => {
  // Base pushed a literal `ref.null.extern` for the whole construction ("we
  // don't construct actual objects"), so the FIRST property read on the result
  // trapped. Every case below threw a WebAssembly.Exception or a null-deref on
  // base. Flipped: `S13.2.2_A16_T1/T2/T3`.
  it("yields the receiver the body wrote to, not null", async () => {
    expect(await runHostFree(`var o: any = new function(){ (this as any).prop = 5; }; return o.prop;`)).toBe(5);
  });

  it("returns the body's OBJECT when it returns one (§10.2.1.3 step 13)", async () => {
    expect(
      await runHostFree(`var o: any = new function(){ (this as any).prop = 5; return { prop: 9 }; }; return o.prop;`),
    ).toBe(9);
  });

  // The step-13 discard arm, one case per Type(V) the runtime probe must
  // classify as NOT-an-Object. `null` is the one that needs its own test:
  // `__typeof_object(null)` answers 1 by design (JS `typeof null === "object"`),
  // so a probe that folded null into the typeof check would return `null` from
  // `new` — the exact defect the step exists to prevent.
  it("DISCARDS a returned primitive and yields the receiver", async () => {
    expect(
      await runHostFree(`var o: any = new function(){ (this as any).prop = 5; return "x"; }; return o.prop;`),
    ).toBe(5);
  });

  it("DISCARDS a returned `null` and yields the receiver", async () => {
    expect(
      await runHostFree(`var o: any = new function(){ (this as any).prop = 5; return null; }; return o.prop;`),
    ).toBe(5);
  });

  it("evaluates a surplus argument and drops it instead of shifting the call", async () => {
    // Base: `RuntimeError: illegal cast` — the extra operand was consumed by
    // the call, so every declared parameter read the argument to its right.
    expect(
      await runHostFree(`var o: any = new (function(a){ (this as any).prop = a; } as any)(4, 9); return o.prop;`),
    ).toBe(4);
  });
});

describe("#4464 F2b — the fnctor DECLARATION path's arity and reachability", () => {
  // `S13.2.2_A6_T2`. Base did not merely answer wrongly here — it emitted a
  // module that FAILED VALIDATION (`local.set[0] expected type externref,
  // found f64.const`), because the surplus argument was pushed and consumed.
  it("passes a surplus `new F(a, b)` argument to nothing and keeps the declared one", async () => {
    expect(
      await runHostFree(
        `function __func(arg){ (this as any).foo = arg; return true; (this as any).bar = 42; }
         var o: any = new (__func as any)(1, 2); return o.foo;`,
      ),
    ).toBe(1);
  });

  it("derives NO field from a `this.x = …` that sits after an unconditional `return`", async () => {
    expect(
      await runHostFree(
        `function __func(arg){ (this as any).foo = arg; return true; (this as any).bar = 42; }
         var o: any = new (__func as any)(1, 2); return o.bar === undefined ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("still derives a field from a `this.x = …` after a return nested in an `if`", async () => {
    // The reachability cut is per-statement-list and only for a terminator at
    // THAT level — a conditional return leaves the list's tail reachable.
    expect(
      await runHostFree(
        `function __func(a){ if (a === 0) { return true; } (this as any).bar = 7; }
         var o: any = new (__func as any)(1); return o.bar;`,
      ),
    ).toBe(7);
  });
});

describe("#4464 — dead-binding elision no longer deletes early errors with the binding", () => {
  // The elision pre-pass runs BEFORE the program is parsed for diagnostics, so
  // blanking an unreferenced `var f = <initializer>` deleted the initializer's
  // early errors too. Base COMPILED THIS CLEAN. Flipped: `13.1-4gs.js`,
  // `13.1-8gs.js`, `enable-strict-via-outer-script.js`.
  it("reports a duplicate parameter name inside an unreferenced strict function", async () => {
    const result = await compileStandalone(`"use strict";\nvar f = function (param, param) { };\n`);
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toMatch(/[Dd]uplicate parameter/);
  });

  // NEGATIVE CONTROL: the guard must key on the ERROR, not on "has an
  // initializer" — the same shape without the strict-mode context is legal and
  // must still compile.
  it("still accepts the same dead binding when the file is SLOPPY", async () => {
    const result = await compileStandalone(`var f = function (param, param) { };\n`);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  });
});

describe("#4464 residuals — measured, NOT fixed here", () => {
  // F3 is FIXED, by #4480 S1 — flipped from `it.fails` to `it` there rather
  // than deleted, so this file keeps recording which successor closed it.
  // #4480 gives every ordinary function a stable lazily-minted `.prototype`
  // `$Object` in a per-fnctor global, with the §13.2 step 10 `constructor`
  // back-ref installed at the single mint point. Measured by #4480's own run
  // of `language/statements/function/S13.2*`: `S13.2_A1_T1`, `S13.2_A1_T2` and
  // `S13.2_A4_T1` flipped fail → pass, zero regressions in that family.
  //
  // Still residual, and now owned by #4480's Residuals section rather than by
  // this file: `S13.2.2_A1_T1/T2` (`__PROTO.isPrototypeOf(new F())`), which
  // needs a FUNCTION-valued prototype the `(ref null $Object)` `$proto` field
  // cannot hold; and `S13.2_A4_T2` (the `var F = function(){}` back-ref).
  it("F3 — a function owns a `.prototype` object (fixed by #4480 S1)", async () => {
    expect(await runHostFree(`function F(){}; return (F as any).prototype === undefined ? 0 : 1;`)).toBe(1);
  });

  // F2 residual. The fn-EXPRESSION construction above yields an externref
  // object, so its `return <object>` can override the receiver. The fn
  // DECLARATION path yields a NOMINAL STRUCT whose property reads are typed
  // from the checker's instance type, so handing back an arbitrary object
  // would have to re-type every read at the `new` site — the same #3976
  // conversion. Base trapped here (`dereferencing a null pointer`); it now
  // answers the receiver, which is a wrong-answer instead of a crash.
  // Residual files: S13.2.2_A7_T1, S13.2.2_A8_T1/T2, S13.2.2_A15_T1..T4.
  it.fails("F2 — a DECLARATION fnctor returning an object still yields the receiver", async () => {
    expect(
      await runHostFree(
        `function __F(a){ (this as any).first = a; var o: any = { second: 2 }; return o; }
         var x: any = new (__F as any)(1); return x.first === undefined ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // F1 residual, and a DELIBERATE decline rather than a bug: strictness of a
  // `Function(<computed>)` body is not decidable at compile time, and an
  // unknown strictness must answer `undefined` rather than throw. A spec
  // engine throws here.
  it.fails("F1 — a COMPUTED `Function(body)` argument declines the poison arm", async () => {
    expect(
      await runLinked(`var s = "'use strict';"; var foo = new Function(s); ${readThrows("(foo as any).caller")}`),
    ).toBe(1);
  });
});
