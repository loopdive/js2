// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4206 — a primitive-initialized module `var` assigned an UNCONSTRAINABLE
 * (`mixed`) value.
 *
 * #4204 widened the slot only when the two JS tags were both known and
 * differed. A `mixed` right-hand side — an `any`-returning call, a property
 * read off a dynamic global, a `catch` binding — was deliberately refused.
 * That refusal is a lossy store, not a coverage gap:
 *
 * ```js
 * var result = "result";   // (mut (ref null $AnyString))
 * result = id(1);          // `id` returns `any` ⇒ mixed ⇒ slot kept narrow
 * "" + result              // traps: dereferencing a null pointer in __str_concat
 * ```
 *
 * The number never reaches the slot; a failed `string` coercion stores **null**,
 * which is a value the binding could not legitimately have received, and the
 * next concatenation dereferences it. That crash was the largest single failure
 * signature in the ES5 standalone residue.
 *
 * ## Shape of this file (deliberate)
 *
 * Mirrors `issue-4204-module-var-widening.test.ts`: PRECONDITION cases are
 * green on both arms so a green run cannot be a run that never reached the
 * substrate, and every LEVER case below was verified RED on this branch's merge
 * base before the fix (the `mixed` cases threw
 * `dereferencing a null pointer` / read back `null`).
 *
 * Compiled with `allowJs` as SCRIPTS (`inferModuleStrictArguments: false`) to
 * match how the test262 runner compiles the `language/statements/with` files
 * this converts.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile host-free and run `__module_init`; the body signals failure by throwing. */
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
  expect(line, `no $__mod_${name} global`).toBeDefined();
  const start = line!.indexOf("(mut ");
  expect(start, `no (mut …) in: ${line}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < line!.length; i++) {
    if (line![i] === "(") depth++;
    else if (line![i] === ")" && --depth === 0) return line!.slice(start + "(mut ".length, i).trim();
  }
  throw new Error(`unbalanced (mut …) in: ${line}`);
}

describe("#4206 — a `mixed` assignment widens a primitive-pinned module slot", () => {
  describe("PRECONDITION (green on BOTH arms — proves the probe reaches the substrate)", () => {
    it("a homogeneously-assigned string `var` keeps its narrow string slot", async () => {
      expect(await moduleGlobalType('var s = "a"; s = "b"; var u = s;', "s")).not.toBe("externref");
      await runScript('var s = "a"; s = "b"; if (s !== "b") throw new Error("str->str: " + String(s));');
    });

    it("a statically-known number stored into a string slot already widened (#4204)", async () => {
      expect(await moduleGlobalType('var s = "a"; s = 1;', "s")).toBe("externref");
      await runScript('var s = "a"; s = 1; if ("" + s !== "1") throw new Error("literal: " + String(s));');
    });
  });

  describe("LEVER (RED before this change)", () => {
    it("widens the slot itself, not just the observed value", async () => {
      expect(await moduleGlobalType('function id(x) { return x; } var s = "a"; s = id(1);', "s")).toBe("externref");
    });

    it("an `any`-returning call into a string slot survives concatenation", async () => {
      await runScript(`
        function id(x) { return x; }
        var result = "result";
        result = id(1);
        if (result !== 1) throw new Error("value lost: " + String(result));
        if ("" + result !== "1") throw new Error("concat: " + ("" + result));
      `);
    });

    it("the with-statement shape from S12.10_A3.1_T2 keeps the caught value", async () => {
      await runScript(`
        this.p1 = 1;
        var result = "result";
        var myObj = { p1: "a", value: "myObj_value" };
        try {
          with (myObj) {
            p1 = "x1";
            throw value;
          }
        } catch (e) {
          result = p1;
        }
        if (result !== 1) throw new Error("result === 1, actual " + String(result));
        if (myObj.p1 !== "x1") throw new Error('myObj.p1 === "x1", actual ' + String(myObj.p1));
      `);
    });

    it("a number-initialized slot also widens on a `mixed` right-hand side", async () => {
      expect(await moduleGlobalType('function id(x) { return x; } var n = 2; n = id("s");', "n")).toBe("externref");
      await runScript(`
        function id(x) { return x; }
        var n = 2;
        n = id("s");
        if (n !== "s") throw new Error("number slot lost the string: " + String(n));
      `);
    });
  });
});

/**
 * #4206 slice 2 — a `var` whose PRE-INITIALIZATION value is observed.
 *
 * §10.2.11 creates every `var` binding with `undefined` at function entry, so a
 * read placed before the declaration answers `undefined`. `hoistVarDecl` typed
 * the slot from the declaration, and a native-string `(ref null $AnyString)`
 * has no representation for `undefined` — its zero-init reads back as `null`.
 *
 * Verified RED on this branch's merge base: every LEVER case below answered
 * `null` (or, for the numeric slot, `0`).
 */
describe("#4206 — a read before the declaration observes `undefined`, not `null`", () => {
  describe("PRECONDITION (green on BOTH arms)", () => {
    it("the ordinary declaration order is unaffected", async () => {
      await runScript(`
        var f = function () { var value = "value"; return value; };
        var r = f();
        if (r !== "value") throw new Error("normal order: " + String(r));
      `);
    });

    it("a bare `var` (no initializer) already read as undefined", async () => {
      await runScript(`
        var f = function () { var value; return value; };
        var r = f();
        if (r !== undefined) throw new Error("bare var: " + String(r));
      `);
    });
  });

  describe("LEVER (RED before this change)", () => {
    it("a string-initialized local reads `undefined` before its declaration", async () => {
      await runScript(`
        var f = function () {
          return value;
          var value = "value";
        };
        var r;
        r = f();
        if (r !== undefined) throw new Error("expected undefined, got " + String(r));
        if (r === null) throw new Error("read back null");
      `);
    });

    it("the same shape inside a `with` body, where the checker resolves nothing", async () => {
      // Binding identity here comes from the file-header's bounded name-keyed
      // fallback: inside a `with` body `variableDeclarationOf` cannot answer.
      await runScript(`
        var myObj = { value: "myObj_value" };
        var r;
        with (myObj) {
          var f = function () {
            return value;
            var value = "value";
          };
          r = f();
        }
        if (r !== undefined) throw new Error("expected undefined, got " + String(r));
      `);
    });

    it("a with-body closure called AFTER the with also returns undefined", async () => {
      await runScript(`
        var myObj = { zz: 1 };
        var r;
        with (myObj) {
          var f = function () {
            return value;
            var value = "value";
          };
        }
        r = f();
        if (r !== undefined) throw new Error("expected undefined, got " + String(r));
      `);
    });
  });
});
