// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4231) Runtime scope-resolution defects in the `with` statement lowering,
 * `--target standalone`.
 *
 * Everything here is compiled in the SCRIPT goal — no `export`, `deferTopLevelInit`,
 * then `__module_init()` is called explicitly. That shape is load-bearing, not
 * incidental: `tests/test262-runner.ts` compiles these files the same way, and
 * script-goal top-level `this` IS the global object. Probing the same source as a
 * MODULE (adding an `export`) makes top-level `this` `undefined` by spec and
 * produces a failure that looks exactly like a global-binding defect but is only
 * a measurement artefact — that artefact is what kept #4206's handoff pointing at
 * an already-fixed blocker.
 *
 * Each case asserts inside the script and throws on mismatch, so "the module
 * initialised without throwing" IS the assertion.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` in the script goal, assert host-free, run `__module_init`. */
async function runScript(body: string): Promise<void> {
  const src = `function CHK(c, m) { if (!c) { throw new Error("assertion failed: " + m); } }\n${body}\n`;
  const result = await compile(src, {
    allowJs: true,
    fileName: "es5-standalone-with.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init: () => void }).__module_init();
}

/**
 * The `with` target shape the whole `S12.10_A1.*` battery uses: an object with a
 * METHOD member (which disqualifies the Tier-1 closed-literal proof) so the
 * statement takes the Tier-2 dynamic path.
 */
const TIER2_OBJ = `var myObj = { p1: 'a', p3: 'c', value: 'myObj_value', valueOf: function(){ return 'obj_valueOf'; } };`;

describe("#4231 — with statement, standalone runtime scope resolution", () => {
  describe("RC-F: the Tier-2 fallback write must not shadow a global-object property", () => {
    it("a bare read after the with still sees the global-object property", async () => {
      // RED on base: reads `null`. The HasBinding-MISS arm of the with-scoped
      // write to `p1` is compiled even though it is never TAKEN (myObj owns p1),
      // and it used to `allocLocal` a local named `p1` — which registers the name
      // in `localMap` and captures every LATER bare read in the function.
      await runScript(`
        this.p1 = 1;
        this.p3 = 3;
        ${TIER2_OBJ}
        var del;
        with (myObj) { p1 = 'x1'; del = delete p3; }
        CHK(p1 === 1, "outer p1 = " + p1);
      `);
    });

    it("the with-scoped write still lands on the object", async () => {
      await runScript(`
        this.p1 = 1;
        ${TIER2_OBJ}
        with (myObj) { p1 = 'x1'; delete p3; }
        CHK(myObj.p1 === 'x1', "myObj.p1 = " + myObj.p1);
      `);
    });

    it("`this.p1` and a bare `p1` read the same storage after the with", async () => {
      await runScript(`
        this.p1 = 1;
        ${TIER2_OBJ}
        with (myObj) { p1 = 'x1'; delete p3; }
        CHK(this.p1 === p1, "this.p1 = " + this.p1 + " vs p1 = " + p1);
      `);
    });

    it("a name the with-object does NOT own still cascades to the global object", async () => {
      await runScript(`
        this.q1 = 1;
        ${TIER2_OBJ}
        with (myObj) { q1 = 'x1'; delete p3; }
        CHK(q1 === 'x1', "q1 = " + q1);
        CHK(myObj.q1 === undefined, "myObj.q1 = " + myObj.q1);
      `);
    });
  });

  describe("RC-A: a `var` inside a with body does not shadow the object", () => {
    it("`var value = v` writes the OBJECT when the target owns `value`", async () => {
      // §14.11.2 puts the object environment record in FRONT of the scope chain;
      // §10.2.11 hoists the `var` to the function environment. So the declaration's
      // initializer is an ordinary assignment that the object wins.
      await runScript(`
        var o = { value: 'mv' };
        with (o) { var value = 'v'; }
        CHK(o.value === 'v', "o.value = " + o.value);
      `);
    });

    it("a bare read of a var-declared name inside the body sees the object", async () => {
      await runScript(`
        var o = { value: 'mv' };
        var s = 'z';
        with (o) { var value; s = value; }
        CHK(s === 'mv', "s = " + s);
      `);
    });

    it("write-then-read of a var-declared name inside the body round-trips the object", async () => {
      await runScript(`
        var o = { value: 'mv' };
        var s = 'z';
        with (o) { var value = 'v'; s = value; }
        CHK(s === 'v', "s = " + s);
        CHK(o.value === 'v', "o.value = " + o.value);
      `);
    });

    it("a `var` whose name the object does NOT own still binds the local", async () => {
      await runScript(`
        var o = { p1: 'a' };
        with (o) { var p4 = 'x4'; }
        CHK(p4 === 'x4', "p4 = " + p4);
        CHK(o.p4 === undefined, "o.p4 = " + o.p4);
      `);
    });

    it("a LEXICAL declaration still shadows the object", async () => {
      await runScript(`
        var o = { value: 'mv' };
        var s = 'z';
        with (o) { let value = 'v'; s = value; }
        CHK(s === 'v', "s = " + s);
        CHK(o.value === 'mv', "o.value = " + o.value);
      `);
    });
  });

  describe("RC-B: `delete name` through a with yields a boolean", () => {
    it("the result is `true`, not `1`", async () => {
      await runScript(`
        ${TIER2_OBJ}
        var del;
        with (myObj) { del = delete p3; }
        CHK(del === true, "del = " + del);
      `);
    });

    it("typeof the result is 'boolean'", async () => {
      await runScript(`
        ${TIER2_OBJ}
        var del;
        with (myObj) { del = delete p3; }
        CHK(typeof del === 'boolean', "typeof del = " + typeof del);
      `);
    });

    it("the property is actually removed", async () => {
      await runScript(`
        ${TIER2_OBJ}
        with (myObj) { delete p3; }
        CHK(myObj.p3 === undefined, "myObj.p3 = " + myObj.p3);
      `);
    });
  });

  describe("RC-C: §14.11.7 ToObject on a nullish target throws TypeError", () => {
    it("`with (null)` throws TypeError", async () => {
      // RED on base: a literal `null` lowers to a genuine `ref.null.extern`,
      // which is NOT the host `undefined`/`null` sentinel the guard tested, so
      // the body ran instead of throwing.
      await runScript(`
        var caught = 0;
        try { with (null) { var x = 2; } } catch (e) { caught = (e instanceof TypeError) ? 1 : 2; }
        CHK(caught === 1, "caught = " + caught);
      `);
    });

    it("`with (undefined)` throws TypeError", async () => {
      await runScript(`
        var caught = 0;
        try { with (undefined) { var x = 2; } } catch (e) { caught = (e instanceof TypeError) ? 1 : 2; }
        CHK(caught === 1, "caught = " + caught);
      `);
    });
  });

  describe("RC-D: typeof through a with binding", () => {
    it("a string-valued binding reports 'string'", async () => {
      await runScript(`
        var o = { s: 'a' };
        var t = 0;
        with (o) { t = (typeof s === 'string') ? 1 : 0; }
        CHK(t === 1, "typeof was not string");
      `);
    });

    it("a number-valued binding still reports 'number'", async () => {
      await runScript(`
        var o = { n: 1 };
        var t = 0;
        with (o) { t = (typeof n === 'number') ? 1 : 0; }
        CHK(t === 1, "typeof was not number");
      `);
    });

    it("a boolean-valued binding still reports 'boolean'", async () => {
      await runScript(`
        var o = { b: true };
        var t = 0;
        with (o) { t = (typeof b === 'boolean') ? 1 : 0; }
        CHK(t === 1, "typeof was not boolean");
      `);
    });
  });

  describe("unchanged behaviour these fixes must not disturb", () => {
    it("the with-object shadows an outer binding of the same name", async () => {
      await runScript(`
        var p1 = 1;
        var o = { p1: 'a' };
        var s = 'z';
        with (o) { s = p1; }
        CHK(s === 'a', "s = " + s);
        CHK(p1 === 1, "p1 = " + p1);
      `);
    });

    it("a name absent from the object falls through to the outer binding", async () => {
      await runScript(`
        var p9 = 9;
        var o = { p1: 'a' };
        var s = 0;
        with (o) { s = p9; }
        CHK(s === 9, "s = " + s);
      `);
    });

    it("nested with resolves innermost-first, then outward", async () => {
      await runScript(`
        var o1 = { a: 1, b: 3 };
        var o2 = { a: 2 };
        var x = 0; var y = 0;
        with (o1) { with (o2) { x = a; y = b; } }
        CHK(x === 2, "x = " + x);
        CHK(y === 3, "y = " + y);
      `);
    });

    it("an undeclared assignment inside a with creates a global, not an object property", async () => {
      await runScript(`
        var o = { p1: 'a' };
        with (o) { p5 = 'x5'; }
        CHK(p5 === 'x5', "p5 = " + p5);
        CHK(o.p5 === undefined, "o.p5 = " + o.p5);
      `);
    });

    it("`this.p = v` inside a with targets the global object, not the with-object", async () => {
      await runScript(`
        this.p2 = 2;
        var o = { p2: 'b' };
        with (o) { this.p2 = 'x2'; }
        CHK(p2 === 'x2', "p2 = " + p2);
        CHK(o.p2 === 'b', "o.p2 = " + o.p2);
      `);
    });

    it("a compound assignment and an increment both round-trip the object", async () => {
      await runScript(`
        var o = { n: 1, m: 1 };
        with (o) { n += 2; m++; }
        CHK(o.n === 3, "o.n = " + o.n);
        CHK(o.m === 2, "o.m = " + o.m);
      `);
    });

    it("a throw out of a with body restores the scope chain", async () => {
      await runScript(`
        var p1 = 1;
        var o = { p1: 'a' };
        var r = 0;
        try { with (o) { throw 7; } } catch (e) { r = p1; }
        CHK(r === 1, "r = " + r);
      `);
    });
  });
});
