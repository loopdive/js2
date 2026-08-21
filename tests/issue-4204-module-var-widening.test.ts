// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4204 — a PRIMITIVE-initialized module `var` reassigned to another JS type.
 *
 * `moduleGlobalWasmType` pinned the slot from the initializer, so `var x = 2`
 * became `(global $__mod_x (mut f64))` and a later `x = {}` / `x = this`
 * squeezed a reference through it and read back `NaN` — silently.
 *
 * ## Shape of this file (deliberate)
 *
 * Every LEVER case below is RED on `origin/main@d9feaef47c` (verified by A/B,
 * not by reasoning); the PRECONDITION cases are green on BOTH arms and exist so
 * a green run cannot be a run that never reached the substrate. That pairing is
 * the defence against the vacuous fixture described in
 * `.claude/memory/reference_standalone_eval_instrument_reports_unmeasured_failures.md`
 * — and the risk is live here, because a probe comparing two things that both
 * collapse to `NaN` passes without asserting anything.
 *
 * The bodies are compiled with `allowJs` as SCRIPTS (`inferModuleStrictArguments:
 * false`), matching how the test262 runner compiles the §10.4.3 files this fixes.
 * A stray top-level `export` would make TypeScript call the source a module and
 * change what `this` means — the exact way #4202's probe went vacuous.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile as a host-free script and run `__module_init`. The body signals
 * failure by THROWING, so a completed init is the pass; that keeps the verdict
 * out of a return value whose own representation is under test.
 */
async function runScript(body: string): Promise<void> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports, `standalone leaked host imports: ${JSON.stringify(result.imports)}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
}

/** The declared Wasm type of `$__mod_<name>`, read out of the emitted WAT. */
async function moduleGlobalType(body: string, name: string): Promise<string> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
    deferTopLevelInit: true,
    emitWat: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const line = (result.wat ?? "").split("\n").find((l) => l.includes(`(global $__mod_${name} `));
  expect(line, `no $__mod_${name} global in:\n${result.wat?.slice(0, 4000)}`).toBeDefined();
  // The type is the balanced `(mut …)` group; a plain regex stops at the first
  // `)` and mangles `(mut (ref null 6))` — and, worse, silently mangles the
  // scalar cases too, so it fails a correct compiler.
  const start = line!.indexOf("(mut ");
  expect(start, `no (mut …) in: ${line}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < line!.length; i++) {
    if (line![i] === "(") depth++;
    else if (line![i] === ")" && --depth === 0) return line!.slice(start + "(mut ".length, i).trim();
  }
  throw new Error(`unbalanced (mut …) in: ${line}`);
}

describe("#4204 — module `var` widens when provably assigned another JS type", () => {
  describe("PRECONDITION (green on BOTH arms — proves the probe reaches the substrate)", () => {
    it("a bare `var` already uses the dynamic slot and round-trips a number", async () => {
      expect(await moduleGlobalType("var a; a = 2; var u = a;", "a")).toBe("externref");
      await runScript(`
        var a; a = 2;
        if (a !== 2) throw new Error("bare var lost the number: " + String(a));
        if (a + 1 !== 3) throw new Error("bare var arithmetic: " + String(a + 1));
        if (typeof a !== "number") throw new Error("bare var typeof: " + typeof a);
      `);
    });

    it("a homogeneously-assigned number `var` keeps its f64 slot", async () => {
      expect(await moduleGlobalType("var a = 2; a = 3; var u = a;", "a")).toBe("f64");
      await runScript(`var a = 2; a = 3; if (a !== 3) throw new Error("num->num: " + String(a));`);
    });

    it("an object-initialized `var` is unaffected", async () => {
      await runScript(`var o = {}; var p = o; if (p !== o) throw new Error("obj identity");`);
    });
  });

  describe("LEVER (RED on origin/main@d9feaef47c)", () => {
    it("widens the slot itself, not just the observed value", async () => {
      // The representation IS the fix; asserting only behaviour would let a
      // future const-fold satisfy the test without moving the slot.
      expect(await moduleGlobalType("var a = 2; var o = {}; a = o;", "a")).toBe("externref");
    });

    it("number -> object preserves identity instead of collapsing to NaN", async () => {
      await runScript(`
        var a = 2;
        var o = {};
        a = o;
        if (a !== o) throw new Error("identity lost: " + String(a));
        if (String(a) === "NaN") throw new Error("collapsed to NaN");
      `);
    });

    it("number -> object literal, assigned directly", async () => {
      await runScript(`
        var a = 2;
        a = { k: 7 };
        if (typeof a !== "object") throw new Error("typeof: " + typeof a);
        if (a.k !== 7) throw new Error("property lost: " + String(a.k));
      `);
    });

    it("number -> string / null / array / function", async () => {
      await runScript(`var a = 2; a = "x"; if (a !== "x") throw new Error("string: " + String(a));`);
      await runScript(`var b = 2; b = null; if (b !== null) throw new Error("null: " + String(b));`);
      await runScript(`
        var c = 2;
        var arr = [1, 2];
        c = arr;
        if (c !== arr) throw new Error("array: " + String(c));
      `);
      await runScript(`
        var d = 2;
        function g() {}
        d = g;
        if (d !== g) throw new Error("function: " + String(d));
      `);
    });

    it("boolean -> object (the non-number primitive arm)", async () => {
      await runScript(`
        var a = true;
        var o = {};
        a = o;
        if (a !== o) throw new Error("bool->obj: " + String(a));
      `);
    });

    it("`typeof` reports the CURRENT value, not the initializer's type", async () => {
      // Second seam: a widened binding keeps its `number` checker type, so both
      // the general typeof path and the `typeof x === "…"` comparison fast path
      // const-folded to "number" and never read the value.
      await runScript(`
        var a = 2;
        var o = {};
        if (typeof a !== "number") throw new Error("before: " + typeof a);
        a = o;
        if (typeof a !== "object") throw new Error("after: " + typeof a);
      `);
    });

    it("§10.4.3 literal setter — `x = this` where x is a top-level `var x = 2`", async () => {
      // 10.4.3-1-{56,57}{-s,gs} verbatim shape.
      await runScript(`
        var x = 2;
        var o = { set foo(stuff) { x = this; } };
        o.foo = 3;
        if (x !== o) throw new Error("setter this: " + String(x));
      `);
    });

    it("§10.4.3 injected setter — the checker declines to type `this` here", async () => {
      // 10.4.3-1-{60,61}{-s,gs}. No object-literal shorthand, so there is no
      // contextual `this` type; this is the case the named `this` arm exists for.
      await runScript(`
        var o = {};
        var x = 2;
        Object.defineProperty(o, "foo", { set: function (stuff) { x = this; } });
        o.foo = 3;
        if (x !== o) throw new Error("injected setter this: " + String(x));
      `);
    });

    it("a widened binding still lowers correctly in every numeric consumer", async () => {
      // Widening changes the representation of a HOT path. These are the
      // consumers that read the binding through its (now stale) `number`
      // checker type; each was verified individually before the fix landed.
      await runScript(`
        var a = 2;
        var o = {};
        if (a + 1 !== 3) throw new Error("add");
        if (!(a < 5)) throw new Error("relational");
        if ("x" + a !== "x2") throw new Error("concat");
        if (a.toFixed(1) !== "2.0") throw new Error("toFixed");
        if (Math.max(a, 1) !== 2) throw new Error("Math.max");
        if (a !== 2) throw new Error("strict-eq");
        var hit = 0;
        switch (a) { case 2: hit = 1; break; }
        if (hit !== 1) throw new Error("switch");
        a = o;
        if (a !== o) throw new Error("post-widen identity");
      `);
    });

    it("a widened `var` still works as a for-loop counter", async () => {
      await runScript(`
        var i = 0;
        var o = {};
        var s = 0;
        for (i = 0; i < 5; i++) { s += i; }
        if (s !== 10) throw new Error("loop sum: " + String(s));
        i = o;
        if (i !== o) throw new Error("post-loop widen");
      `);
    });
  });

  describe("NEGATIVE — the predicate stays narrow", () => {
    it("(SUPERSEDED by #4206) an UNPROVABLE (mixed) RHS now DOES widen", async () => {
      // This case asserted `f64` when #4204 landed, on the grounds that widening
      // on an unknown tag would move a large fraction of the corpus onto the
      // dynamic representation for no measured benefit (5,943 syntactic
      // candidates against 55 provable ones).
      //
      // #4206 measured both halves and reversed the verdict. The refusal is a
      // LOSSY STORE, not a coverage gap: `var s = "a"; s = f(1)` coerces the
      // number into a `(ref null $AnyString)` slot, which stores **null** and
      // traps in `__str_concat` on the next concatenation — the largest single
      // failure signature in the ES5 standalone residue. And the corpus cost is
      // ~nil: over 73 compiled `language/{statements,expressions}` modules
      // exactly one changed a byte (and shrank), and a 1,200-file standalone A/B
      // produced three fail→pass, zero pass→fail, zero altered signatures.
      //
      // Kept as an explicit assertion of the NEW verdict rather than deleted, so
      // the reversal is visible to anyone re-deriving the predicate.
      expect(await moduleGlobalType("function f(x) { return x; } var a = 2; a = f(1); var u = a;", "a")).toBe(
        "externref",
      );
    });

    it("a same-named local in another function cannot widen the global", async () => {
      // Binding identity via the oracle, not the name (#3364's failure mode).
      const src = "var a = 2; function g() { var a = 1; var o = {}; a = o; return a; } g(); var u = a;";
      expect(await moduleGlobalType(src, "a")).toBe("f64");
    });
  });
});
