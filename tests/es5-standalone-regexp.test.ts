// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4233) The ES5 RegExp cluster in `--target standalone`.
 *
 * Four independent root causes, one describe-block each:
 *
 *  1. `env::RegExp_exec` leaked out of the any-receiver extern-class dispatch,
 *     so the whole §22.2.6.2 reflective battery failed to INSTANTIATE.
 *  2. `re.exec()` / `re.test()` (zero args) were compile-time refusals instead
 *     of `ToString(undefined)` === `"undefined"`.
 *  3. `RegExp(R)` without `new` cloned instead of returning `R` (§22.2.4.1 s1).
 *  4. an `undefined` pattern/flags operand went through ToString instead of
 *     §22.2.3.1 steps 5/7 ("let P/F be the empty String").
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as a standalone (host-free) module exporting `f`, assert no
 * host imports leaked, instantiate, and return `f()`.
 *
 * Compiled as JS (`allowJs`) because the reflective idioms these tests pin —
 * `o.exec = RegExp.prototype.exec`, `re.indicator = 1` — have no TypeScript
 * spelling on the lib's `Object`/`RegExp` interfaces.
 */
async function runStandalone(body: string): Promise<unknown> {
  const result = await compile(`export function f() {\n${body}\n}`, {
    allowJs: true,
    fileName: "es5-standalone-regexp.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { f: () => unknown }).f();
}

describe("#4233 — ES5 RegExp semantics in --target standalone", () => {
  describe("transferred exec/test brand check (§22.2.6.2 step 1)", () => {
    // Before #4233 these bound `env::RegExp_exec` — `runStandalone`'s
    // empty-imports assertion is itself the regression guard.
    for (const member of ["exec", "test"]) {
      it(`${member} on a plain-object receiver throws a catchable TypeError`, async () => {
        const src = `var o = new Object(); o.${member} = RegExp.prototype.${member};
          try { o.${member}("message to investigate"); } catch (e) { return e instanceof TypeError ? 1 : 2; }
          return 0;`;
        expect(await runStandalone(src)).toBe(1);
      });

      it(`${member} on a Boolean-wrapper receiver throws a catchable TypeError`, async () => {
        const src = `var o = new Boolean(false); o.${member} = RegExp.prototype.${member};
          try { o.${member}("message to investigate"); } catch (e) { return e instanceof TypeError ? 1 : 2; }
          return 0;`;
        expect(await runStandalone(src)).toBe(1);
      });
    }

    it("a genuine RegExp receiver still runs the match", async () => {
      expect(await runStandalone(`return /b/.test("abc") ? 1 : 0;`)).toBe(1);
      expect(await runStandalone(`return /b/.exec("abc")[0] === "b" ? 1 : 0;`)).toBe(1);
    });
  });

  describe('zero-argument exec/test — ToString(undefined) is "undefined"', () => {
    it('exec() matches against the string "undefined" (15.10.6.2_A1_T16)', async () => {
      expect(await runStandalone(`return /undefined/.exec()[0] === "undefined" ? 1 : 0;`)).toBe(1);
    });

    it("exec() on a capturing pattern returns the whole subject (15.10.6.2_A12)", async () => {
      const src = `var m = new RegExp("(.|\\r|\\n)*", "").exec()[0];
        return m === "undefined" ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it('test() matches against the string "undefined" (15.10.6.3_A1_T16)', async () => {
      expect(await runStandalone(`return /undefined/.test() ? 1 : 0;`)).toBe(1);
      expect(await runStandalone(`return /^zzz$/.test() ? 1 : 0;`)).toBe(0);
    });
  });

  describe("RegExp(R) identity vs new RegExp(R) clone (§22.2.4.1 step 1)", () => {
    it("RegExp(R) returns R itself, so later own properties are visible", async () => {
      const src = `var re = /x/i; var inst = RegExp(re); re.indicator = 1;
        return (inst === re ? 1 : 0) + (inst.indicator === 1 ? 2 : 0);`;
      expect(await runStandalone(src)).toBe(3);
    });

    it("an explicitly-undefined flags operand keeps the identity", async () => {
      for (const flags of ["undefined", "void 0"]) {
        const src = `var re = /x/i; var inst = RegExp(re, ${flags}); re.indicator = 1;
          return inst.indicator === 1 ? 1 : 0;`;
        expect(await runStandalone(src), flags).toBe(1);
      }
    });

    it("a hoisted, never-assigned var also counts as undefined flags", async () => {
      // 15.10.3.1_A1_T3 — `staticConstStringValue` folds this to `undefined`,
      // which is neither the `undefined` identifier nor a `null` (dynamic) fold.
      const src = `var re = new RegExp(); var x; var inst = RegExp(re, x); re.indicator = 1;
        return inst.indicator === 1 ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("flags that are undefined only at RUNTIME keep the identity", async () => {
      // 15.10.3.1_A1_T2 — the operand is an IIFE, unresolvable statically.
      const src = `var re = new RegExp(); var inst = RegExp(re, (function(){})()); re.indicator = 1;
        return inst.indicator === 1 ? 1 : 0;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("new RegExp(R) still CLONES — identity must not leak into the ctor", async () => {
      const src = `var re = /x/i; var copy = new RegExp(re); re.indicator = 1;
        return (copy === re ? 1 : 0) + (copy.indicator === undefined ? 2 : 0)
             + (copy.source === "x" ? 4 : 0) + (copy.ignoreCase ? 8 : 0);`;
      expect(await runStandalone(src)).toBe(14);
    });

    it("explicit flags still override, they never take the identity arm", async () => {
      const src = `var re = /x/i; var out = RegExp(re, "g");
        return (out === re ? 1 : 0) + (out.global ? 2 : 0) + (out.source === "x" ? 4 : 0)
             + (out.ignoreCase ? 8 : 0);`;
      expect(await runStandalone(src)).toBe(6);
    });

    // (#4233 follow-up) §22.2.3.1 step 4.b guards the identity arm with TWO
    // preconditions the static RegExp *type* does not establish:
    // `IsRegExp(pattern)` (which reads `pattern[Symbol.match]` and uses
    // ToBoolean of it when present) and `SameValue(newTarget, pattern
    // .constructor)`. Folding on the type alone returned `R` where the spec
    // constructs a new object — this is the exact shape of
    // `built-ins/RegExp/call_with_regexp_match_falsy.js`, which the first cut
    // of the fold flipped pass→fail on the standalone lane.
    it("a falsy Symbol.match makes IsRegExp false — RegExp(R) must build a NEW object", async () => {
      const src = `var re = /(?:)/; re[Symbol.match] = false; var out = RegExp(re);
        return out === re ? 0 : 1;`;
      expect(await runStandalone(src)).toBe(1);
    });

    // (A `.constructor` override — step 4.b.iii's other precondition — takes the
    // same code path but cannot be pinned through `runStandalone`: writing
    // `re.constructor` needs `env::Object_set_constructor`, and this suite's
    // empty-imports assertion is itself a #4233 regression guard.)

    it("the brand guard also covers the RUNTIME-undefined flags arm", async () => {
      // Same §22.2.3.1 branch, reached through the two-arm runtime merge
      // (`(function(){})()` is undefined only at runtime), which had its own
      // identity spelling.
      const src = `var re = /(?:)/; re[Symbol.match] = false;
        var out = RegExp(re, (function(){})());
        return out === re ? 0 : 1;`;
      expect(await runStandalone(src)).toBe(1);
    });

    it("runtime-known flags recompile R's ORIGINAL SOURCE, not ToString(R)", async () => {
      // §22.2.3.1 step 6. ToString(R) would be "/x/i", an invalid pattern.
      const src = `var re = /x/i; var fl = "g"; var out = new RegExp(re, fl);
        return (out.global ? 1 : 0) + (out.ignoreCase ? 2 : 0) + (out.source === "x" ? 4 : 0);`;
      expect(await runStandalone(src)).toBe(5);
    });
  });

  describe("undefined pattern/flags are the empty string (§22.2.3.1 steps 5/7)", () => {
    it("absent object properties give /(?:)/ with no flags (15.10.4.1_A4_T3)", async () => {
      const src = `var re = new RegExp({}.p, {}.q);
        return (re.multiline === false ? 1 : 0) + (re.global === false ? 2 : 0)
             + (re.ignoreCase === false ? 4 : 0) + (re.source === "(?:)" ? 8 : 0);`;
      expect(await runStandalone(src)).toBe(15);
    });

    it('a void-returning IIFE as flags is not the string "undefined" (15.10.4.1_A4_T5)', async () => {
      const src = `var re = new RegExp("", (function(){})());
        return (re.multiline === false ? 1 : 0) + (re.global === false ? 2 : 0)
             + (re.ignoreCase === false ? 4 : 0);`;
      expect(await runStandalone(src)).toBe(7);
    });

    it("a RegExp pattern with runtime-undefined flags inherits its own flags (15.10.4.1_A1_T5)", async () => {
      const src = `var p = RegExp("1?", "mig"); var re = new RegExp(p, (function(){})());
        return (re.source === p.source ? 1 : 0) + (re.multiline === p.multiline ? 2 : 0)
             + (re.global === p.global ? 4 : 0) + (re.ignoreCase === p.ignoreCase ? 8 : 0);`;
      expect(await runStandalone(src)).toBe(15);
    });
  });

  it("leaves the JS-host (gc) lane compiling the same sources", async () => {
    const result = await compile(
      `export function f() {\nvar re = /x/i; var inst = RegExp(re); return /undefined/.test() ? 1 : 0;\n}`,
      { allowJs: true, fileName: "es5-regexp-gc.js", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
