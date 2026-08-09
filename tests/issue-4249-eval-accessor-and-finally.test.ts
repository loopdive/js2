// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4249) Two independent wave-4 root causes, one describe-block each:
 *
 *  1. An eval-spliced object-literal ACCESSOR reached the TS checker on a
 *     never-bound node and threw `Cannot read properties of undefined
 *     (reading 'declarations'|'escapedName')` — an *internal error* that failed
 *     the whole compile (7 compile_errors in `language/expressions/object`).
 *  2. `catch { break; } finally { continue; }` inlined its finally clone one
 *     label too shallow, so the `continue` branched to the enclosing TRY and
 *     control fell out of the loop body's tail
 *     (`language/statements/try/S12.14_A9..A12_T4` CHECK#2).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `src` as a module and run its exported `probe()`. */
async function runModule(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const result = await compile(src, {
    allowJs: true,
    fileName: "issue-4249.js",
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  if (target === "standalone") {
    expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { probe: () => unknown }).probe();
}

/**
 * Compile only. The regression this pins is an *internal* error — a compiler
 * crash on a never-bound node — so the load-bearing assertion is the crash
 * signature, not `success`: a deliberate, named refusal is a different and
 * acceptable outcome. `expectSuccess` is therefore opt-out, and exactly one
 * case opts out (see the shorthand-method note below).
 */
async function compileOnly(src: string, target: "standalone" | "gc", expectSuccess = true): Promise<void> {
  const result = await compile(src, {
    allowJs: true,
    fileName: "issue-4249.js",
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  const messages = result.errors.map((e) => e.message).join("\n");
  expect(messages).not.toMatch(/Internal error compiling expression/);
  expect(messages).not.toMatch(/Cannot read properties of undefined/);
  if (expectSuccess) expect(result.success, messages).toBe(true);
}

describe("#4249 — eval-spliced object-literal accessors do not crash codegen", () => {
  // The exact shapes from language/expressions/object/11.1.5_*: the eval body
  // is parsed by a bare `ts.createSourceFile`, so its nodes carry no symbol.
  const shapes: Record<string, string> = {
    getter: `var o; eval("o = {get foo(){return 1;}};");`,
    setter: `var o; eval("o = {set foo(arg){return 1;}};");`,
    "getter + setter pair": `var s1 = "g", s2 = "s";
      var o; eval("o = {get foo(){ return s1;}, set foo(arg){ return s2 = arg; }};");`,
    "data prop then getter, same name": `eval("({foo : 1, get foo(){}});");`,
    "shorthand method": `var o; eval("o = {foo: 1, bar(){ return 2; }};");`,
  };

  // PRE-EXISTING and out of scope: an eval-spliced SHORTHAND METHOD on the gc
  // lane fails with `Missing __make_getter_callback import` — a host-bridge gap
  // in `emitObjectLiteralMethodFn`, present before #4249 and unrelated to the
  // unbound-node crash. It is listed here so the case still guards the crash
  // signature (the point of this block) without pinning the unrelated failure.
  const gcRefusesCompile = new Set(["shorthand method"]);

  for (const [name, body] of Object.entries(shapes)) {
    for (const target of ["standalone", "gc"] as const) {
      it(`${name} compiles without an internal error (${target})`, async () => {
        await compileOnly(
          `export function probe() {\n${body}\nreturn 1;\n}`,
          target,
          !(target === "gc" && gcRefusesCompile.has(name)),
        );
      });
    }
  }

  it("a NORMAL (bound) object-literal accessor still lowers and runs", async () => {
    // The unbound branch must not swallow the ordinary path: a real accessor
    // keeps its checker-derived signature.
    const src = `var o = { get foo() { return 7; }, set foo(v) { this.seen = v; } };
      export function probe() { o.foo = 3; return o.foo; }`;
    expect(await runModule(src, "standalone")).toBe(7);
  });
});

describe("#4249 — a finally's abrupt completion overrides one pending in catch", () => {
  // §14.15.3: if the finally block yields an abrupt completion, it REPLACES the
  // completion the try/catch produced. Module scope is load-bearing — inside a
  // function these take the IR path, which was already correct.
  const loops: Record<string, string> = {
    while: `while (n < 5) { n += 1; BODY n += 100; }`,
    for: `for (var i = 0; i < 5; i++) { n += 1; BODY n += 100; }`,
    "do-while": `do { n += 1; BODY n += 100; } while (n < 5);`,
  };
  const CATCH_BREAK_FINALLY_CONTINUE = `try { throw "x"; } catch (e) { break; } finally { continue; }`;

  for (const [kind, shape] of Object.entries(loops)) {
    it(`catch{break} + finally{continue} keeps looping (${kind}, module scope)`, async () => {
      const src = `var n = 0;\n${shape.replace("BODY", CATCH_BREAK_FINALLY_CONTINUE)}
        export function probe() { return n; }`;
      // The loop must run to its own exit condition (n === 5); the pre-#4249
      // lowering fell through to the `n += 100` tail on the first iteration.
      expect(await runModule(src, "standalone")).toBe(5);
    });

    it(`catch{break} + finally{continue} keeps looping (${kind}, function scope)`, async () => {
      const src = `export function probe() { var n = 0;\n${shape.replace(
        "BODY",
        CATCH_BREAK_FINALLY_CONTINUE,
      )}\n return n; }`;
      expect(await runModule(src, "standalone")).toBe(5);
    });
  }

  it("try{break} + finally{continue} keeps looping (the CHECK#1 shape)", async () => {
    const src = `var n = 0;
      while (n < 5) { n += 1; try { break; } catch (e) {} finally { continue; } n += 100; }
      export function probe() { return n; }`;
    expect(await runModule(src, "standalone")).toBe(5);
  });

  it("catch{break} with a NON-abrupt finally still breaks", async () => {
    // The delta correction must not turn every catch-break into a continue.
    const src = `var n = 0;
      while (n < 5) { n += 1; try { throw "x"; } catch (e) { break; } finally { n += 10; } n += 100; }
      export function probe() { return n; }`;
    expect(await runModule(src, "standalone")).toBe(11);
  });

  it("catch{continue} with a finally{break} takes the finally's break", async () => {
    const src = `var n = 0;
      while (n < 5) { n += 1; try { throw "x"; } catch (e) { continue; } finally { break; } n += 100; }
      export function probe() { return n; }`;
    expect(await runModule(src, "standalone")).toBe(1);
  });

  it("the full S12.14_A10_T4 CHECK#2 shape reaches its loop exit", async () => {
    const src = `var c2 = 0, fin2 = 0;
      while (c2 < 2) {
        try { throw "ex1"; }
        catch (er1) { c2 += 1; break; }
        finally { fin2 = 1; continue; }
        c2 += 2; fin2 = -1;
      }
      export function probe() { return c2 * 10 + fin2; }`;
    expect(await runModule(src, "standalone")).toBe(21);
  });

  it("a labeled break out of an outer loop still targets the outer label", async () => {
    // Guards the bumpOuterBranchDepths interaction: the finally's own labeled
    // break must keep pointing at `outer`, not slide onto the inner loop.
    const src = `var n = 0;
      outer: for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) { n += 1; try { throw "x"; } catch (e) { break; } finally { break outer; } }
        n += 100;
      }
      export function probe() { return n; }`;
    expect(await runModule(src, "standalone")).toBe(1);
  });
});
