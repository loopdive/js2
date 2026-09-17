// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6493) A builtin prototype method read as a VALUE and then CALLED, under
 * `--target standalone`.
 *
 * `src/codegen/builtin-value-read.ts`'s last arm, and `makeGlue`'s
 * `emitProtoMemberBodyRefusal`, degrade an unwired first-class builtin method to
 * a catchable `TypeError: <key> is not yet implemented in --target standalone`.
 * That refusal is a SAFETY NET and stays; what this file pins is that
 * `Function.prototype.call`, `Function.prototype.apply` and the
 * `Object.prototype.toString` [[ErrorData]] receiver no longer reach it.
 *
 * Four of the seven `it`s were verified RED on the branch base — the three
 * `Function.prototype.<m>` ones with `… is not yet implemented in --target
 * standalone`, and the `Object.prototype.toString` one on its `err` line. The
 * other three are GUARDS, green on base too: they assert that the properties
 * this change could plausibly have broken (the catchable-TypeError refusal, the
 * `.length`/`.name` metadata, and the still-unwired generic arm) did not move.
 *
 * Output is read back host-free through the module's own `__stdout_prepare` /
 * `__stdout_char` exports (#3469), the channel the test262 runner uses — a
 * standalone module cannot hand a string to the host any other way. Every probe
 * value is untyped, exactly as a plain-JavaScript test262 program writes it:
 * the whole defect class lives on the dynamic path, and a statically-typed
 * probe takes a different lowering and hides it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as a standalone module and return the lines it printed.
 * `LOG(s)` is `console.log`.
 */
async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6493-first-class-builtin-method-values.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // A leaked host import would make every assertion below meaningless.
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

describe("#6493 first-class builtin method values (standalone)", () => {
  it("Function.prototype.call invoked through a value forwards receiver and arguments", async () => {
    // RED on base: every line is
    // "Function.prototype.call is not yet implemented in --target standalone".
    // The two invocations are deliberately DIFFERENT arities on DIFFERENT
    // receivers: one shared closure body serves every call site, so a body that
    // failed to re-initialise its argument locals would answer the first call
    // correctly and the second from stale state.
    const lines = await runLines(`
      var c = Function.prototype.call;
      function f(a, b) { return this.tag + "/" + a + "/" + b; }
      function g() { return "g:" + this.tag; }
      try { LOG("two=" + c.call(f, { tag: "T" }, 1, 2)); } catch (e) { LOG("two!" + e.message); }
      try { LOG("zero=" + c.call(g, { tag: "U" })); } catch (e) { LOG("zero!" + e.message); }
      try { LOG("again=" + c.call(f, { tag: "V" }, 8, 9)); } catch (e) { LOG("again!" + e.message); }
    `);
    expect(lines).toEqual(["two=T/1/2", "zero=g:U", "again=V/8/9"]);
  });

  it("Function.prototype.call.bind(fn) — the propertyHelper uncurry shape, on a USER function", async () => {
    // RED on base. The narrow AST recogniser in object-builtin-effects.ts only
    // folds `Function.prototype.call.bind(<Builtin>.prototype.<m>)` for five
    // whitelisted methods; a user-function target had no first-class value.
    const lines = await runLines(`
      var f = function (a) { return "f(" + this.tag + "," + a + ")"; };
      var b = Function.prototype.call.bind(f);
      try { LOG("b=" + b({ tag: "T" }, 9)); } catch (e) { LOG("b!" + e.message); }
      try { LOG("b2=" + b({ tag: "U" }, 8)); } catch (e) { LOG("b2!" + e.message); }
    `);
    expect(lines).toEqual(["b=f(T,9)", "b2=f(U,8)"]);
  });

  it("Function.prototype.apply invoked through a value spreads the array-like", async () => {
    // RED on base: the refusal. `apply(thisArg)` with NO argArray is §20.2.3.1
    // step 2 (call with an empty list), not a TypeError.
    const lines = await runLines(`
      var ap = Function.prototype.apply;
      function f(a, b) { return this.tag + "/" + a + "/" + b; }
      function g() { return "g:" + this.tag; }
      try { LOG("two=" + ap.call(f, { tag: "T" }, [1, 2])); } catch (e) { LOG("two!" + e.message); }
      try { LOG("none=" + ap.call(g, { tag: "U" })); } catch (e) { LOG("none!" + e.message); }
      try { LOG("nullish=" + ap.call(g, { tag: "W" }, null)); } catch (e) { LOG("nullish!" + e.message); }
    `);
    expect(lines).toEqual(["two=T/1/2", "none=g:U", "nullish=g:W"]);
  });

  it("a non-callable receiver is a catchable TypeError, never a trap", async () => {
    // §20.2.3.1/.3 step 1. GREEN on base as well — there the refusal itself was
    // a TypeError — so this is a guard, not a proof: it is the arm that must not
    // become a wrong ANSWER now that a body exists, because `__apply_closure`
    // alone returns `undefined` for a non-callable rather than throwing.
    // The last line is test262's S15.3.4.4_A* shape — an object that INHERITS
    // `call` from Function.prototype but has no [[Call]] of its own.
    const lines = await runLines(`
      var c = Function.prototype.call;
      var ap = Function.prototype.apply;
      var verdict = "no-throw";
      try { c.call({}); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("call=" + verdict);
      verdict = "no-throw";
      try { ap.call({}, {}, []); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("apply=" + verdict);
      function FACTORY() {}
      FACTORY.prototype = Function.prototype;
      var obj = new FACTORY();
      verdict = "no-throw";
      try { obj.call(); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("inherited=" + verdict);
    `);
    expect(lines).toEqual(["call=TypeError", "apply=TypeError", "inherited=TypeError"]);
  });

  it("§20.2.3 arity and name metadata on the reflective values", async () => {
    // `call.length` is 1, `apply.length` is 2 (§20.2.3.1/.3); both `name`s are
    // the bare member. Several target rows read exactly this metadata through
    // `verifyProperty`, i.e. at RUNTIME off the value object.
    //
    // KNOWN RESIDUAL, pinned on the last two lines so the day it is fixed this
    // expectation fails loudly instead of rotting: `.length` read through a
    // VARIABLE folds from the lib.d.ts signature
    // (`function-expected-argument-count.ts`), where `apply(thisArg, argArray?)`
    // stops at the optional parameter and answers 1. That fold is a separate
    // mechanism from the value object's own metadata and is out of #6493's scope.
    const lines = await runLines(`
      LOG("call.len=" + Function.prototype.call.length);
      LOG("apply.len=" + Function.prototype.apply.length);
      LOG("call.name=" + Function.prototype.call.name);
      LOG("apply.name=" + Function.prototype.apply.name);
      var d = Object.getOwnPropertyDescriptor(Function.prototype, "apply");
      LOG("gopd.len=" + d.value.length);
      var a = Function.prototype.apply;
      LOG("residual.var-apply.len=" + a.length);
    `);
    expect(lines).toEqual([
      "call.len=1",
      "apply.len=2",
      "call.name=call",
      "apply.name=apply",
      "gopd.len=2",
      "residual.var-apply.len=1",
    ]);
  });

  it("Object.prototype.toString through a value answers for null, undefined and an Error", async () => {
    // The null/undefined receivers are §20.1.3.6 steps 1-2 — they answer rather
    // than throwing, and already did before this change; they are here because
    // the spec's acceptance names them and because a regression in the
    // classifier's PROLOGUE would silently move them into the refusal.
    //
    // RED on base: the `err` line only ("Object.prototype.toString is not yet
    // implemented in --target standalone"). The standalone Error carrier is a
    // nominal `$Error_struct`, so it matched no classifier arm; §20.1.3.6
    // step 8 gives it `[object Error]`.
    const lines = await runLines(`
      var t = Object.prototype.toString;
      function tag(label, v) {
        try { LOG(label + "=" + t.call(v)); } catch (e) { LOG(label + "!" + e.message); }
      }
      tag("undef", undefined);
      tag("null", null);
      tag("err", new Error("x"));
      tag("obj", {});
      tag("arr", [1, 2]);
      tag("err2", new TypeError("y"));
    `);
    expect(lines).toEqual([
      "undef=[object Undefined]",
      "null=[object Null]",
      "err=[object Error]",
      "obj=[object Object]",
      "arr=[object Array]",
      "err2=[object Error]",
    ]);
  });

  it("the generic refusal is still there for a builtin method with no body", async () => {
    // The safety net this issue must NOT widen away: an unwired first-class
    // builtin method value stays a CATCHABLE TypeError rather than a trap or a
    // wrong answer. `WeakRef.prototype.deref` is one such member today.
    const lines = await runLines(`
      var d = WeakRef.prototype.deref;
      var verdict = "no-throw";
      try { d.call({}); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("refusal=" + verdict);
    `);
    expect(lines).toEqual(["refusal=TypeError"]);
  });
});
