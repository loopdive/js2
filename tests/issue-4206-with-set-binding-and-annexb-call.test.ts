// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4206 slices 3 and 4 — two places where a STATIC type stood in for a value
 * the spec makes dynamic.
 *
 * Both were verified RED on this branch's merge base.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile host-free as a SCRIPT and run `__module_init`; failure is a throw. */
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

/**
 * §9.1.1.2.5 SetMutableBinding on an Object Environment Record is an ordinary
 * `Set(bindingObject, N, V, S)` — the value is arbitrary. The closed-fields
 * projection pins each field's carrier from the literal's initializer, so
 * `with (b) { p1 = "x1" }` against `var b = { p1: true }` coerced the string
 * into the boolean field and read back `false`.
 */
describe("#4206 — a bare-identifier write inside a `with` body needs the open-object carrier", () => {
  describe("PRECONDITION (green on BOTH arms)", () => {
    it("a `with` body that only READS keeps working", async () => {
      await runScript(`
        var b = { p1: true, q: "s" };
        var read;
        with (b) { read = q; }
        if (read !== "s") throw new Error("read: " + String(read));
      `);
    });

    it("a same-typed write is unaffected", async () => {
      await runScript(`
        var b = { p1: "a" };
        with (b) { p1 = "z"; }
        if (b.p1 !== "z") throw new Error("same-typed write: " + String(b.p1));
      `);
    });
  });

  describe("LEVER (RED before this change)", () => {
    it("a string into a boolean-carrier field survives", async () => {
      await runScript(`
        var b = { p1: true };
        with (b) { p1 = "x1"; }
        if (b.p1 !== "x1") throw new Error('expected "x1", got ' + String(b.p1));
      `);
    });

    it("a string into a numeric-carrier field survives", async () => {
      await runScript(`
        var b = { p1: 1 };
        with (b) { p1 = "x1"; }
        if (b.p1 !== "x1") throw new Error('expected "x1", got ' + String(b.p1));
      `);
    });

    it("a `var x = v` declaration inside the body is a SetMutableBinding too", async () => {
      // §13.3.2.4: the `var` hoists to the enclosing function/script scope, so
      // the initializer is an ordinary assignment to the resolved reference —
      // which the Object Environment Record intercepts. This is `12.10-0-8`.
      await runScript(`
        var o = { foo: 42 };
        with (o) { var foo = "set in with"; }
        if (o.foo !== "set in with") throw new Error("o.foo: " + String(o.foo));
      `);
    });

    it("a `let` inside the body is NOT — it binds in the block", async () => {
      await runScript(`
        var o = { foo: 42 };
        with (o) { let foo = "block local"; }
        if (o.foo !== 42) throw new Error("o.foo must be untouched: " + String(o.foo));
      `);
    });

    it("the INNER target of a nested `with` is planned too", async () => {
      // The inner target sits inside the outer `with` body, where the checker
      // gives it no symbol at all — see `targetIsThisBinding` for the bounded
      // name fallback that makes it visible. This is `S12.10_A3.6_T{1,2}`.
      await runScript(`
        var a = { p1: "a" };
        var b = { p1: true };
        with (a) {
          with (b) { p1 = "x1"; }
        }
        if (b.p1 !== "x1") throw new Error('inner: expected "x1", got ' + String(b.p1));
        if (a.p1 !== "a") throw new Error('outer must not change: ' + String(a.p1));
      `);
    });
  });
});

/**
 * Annex B B.3.3.2.c makes a module-scope block-nested `function f` a LIVE
 * binding: a call must invoke whatever declaration most recently evaluated.
 * TypeScript has no notion of that, so a later `var f = 123` anywhere in the
 * script is the only thing it types the name from — and the #4221
 * non-callable-callee guard read that `number` fact and baked an unconditional
 * TypeError into a call the spec says must succeed.
 */
describe("#4206 — an Annex B block-function binding is not a provably non-callable callee", () => {
  describe("PRECONDITION (green on BOTH arms)", () => {
    it("the same script without the later `var f` already worked", async () => {
      await runScript(`
        { function f() { return "function declaration"; } }
        if (f() !== "function declaration") throw new Error("call: " + String(f()));
      `);
    });

    it("a genuinely non-callable callee still throws TypeError (#4221 kept)", async () => {
      let threw = "";
      try {
        await runScript(`var n = 123; n();`);
      } catch (e) {
        threw = String(e);
      }
      expect(threw, "calling a plain number must still throw").not.toBe("");
    });
  });

  describe("LEVER (RED before this change)", () => {
    it("calls the block function even though a later `var f = 123` types the name", async () => {
      // No `typeof f` probe first: a leading `typeof` read is GREEN on base
      // (measured), so including it would make this case vacuous.
      await runScript(`
        { function f() { return "function declaration"; } }
        var r = f();
        if (r !== "function declaration") throw new Error("call: " + String(r));
        var f = 123;
      `);
    });

    it("the same through a `switch` case (B.3.3.2 covers every block form)", async () => {
      await runScript(`
        switch (1) {
          case 1:
            function f() { return "function declaration"; }
        }
        var r = f();
        if (r !== "function declaration") throw new Error("call: " + String(r));
        var f = 123;
      `);
    });
  });
});
