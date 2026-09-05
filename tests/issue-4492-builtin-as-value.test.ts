// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4492) A BUILTIN PROTOTYPE OBJECT in a `[[Prototype]]` position, under
 * `--target standalone`.
 *
 * `$Object.$proto` is `(mut (ref null $Object))`, so `__object_create`'s
 * `ref.test` misses a `$NativeProto` (`Function.prototype`, `Array.prototype`,
 * …) and stores **null** — the same shape #4637 fixed for a CALLABLE in that
 * position, with the same fix: canonicalize to an `$Object` proto-VIEW at the
 * choke point and map back on the way out (`proto-function-value.ts`). The view
 * for a builtin brand is its proto-index COMPANION, which is already the brand's
 * own-member table.
 *
 * Every test here EXECUTES the operation it guards (an identity assertion alone
 * would sit one property read away from the defect), and every positive pin was
 * verified to FAIL with `src/codegen/proto-function-value.ts` and
 * `src/codegen/object-proto-tostring.ts` reverted to the branch base.
 *
 * Output is read back host-free through the module's own `__stdout_prepare` /
 * `__stdout_char` exports (#3469), the channel the test262 runner uses — a
 * standalone module cannot hand a string to the host any other way.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `body` as a standalone module and return the lines it printed.
 * `LOG(s)` is `console.log`; a module-level throw is reported as a
 * `THREW:` line so a pin can assert on a refusal without the host needing to
 * decode a Wasm-GC payload.
 */
async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4492-builtin-as-value.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
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

describe("#4492 a builtin prototype in [[Prototype]] position (standalone)", () => {
  it("Object.create(Function.prototype) inherits call/apply/bind and keeps the identity", async () => {
    // RED on base: every `typeof` is "undefined" and the identity is false.
    const lines = await runLines(`
      var o = Object.create(Function.prototype);
      LOG("call=" + (typeof o.call));
      LOG("apply=" + (typeof o.apply));
      LOG("bind=" + (typeof o.bind));
      LOG("id=" + (Object.getPrototypeOf(o) === Function.prototype));
    `);
    expect(lines).toEqual(["call=function", "apply=function", "bind=function", "id=true"]);
  });

  it("Object.create(Array.prototype) inherits a real Array method", async () => {
    // RED on base: "undefined" / false.
    const lines = await runLines(`
      var o = Object.create(Array.prototype);
      LOG("slice=" + (typeof o.slice));
      LOG("id=" + (Object.getPrototypeOf(o) === Array.prototype));
    `);
    expect(lines).toEqual(["slice=function", "id=true"]);
  });

  it("new F() with F.prototype = Function.prototype — the test262 S15.3.4.4_A1_T2 shape", async () => {
    // The row this exists for. `obj.call()` must throw a TypeError because
    // `obj` has no [[Call]]; the reflective `Function.prototype.call` closure's
    // refusal body IS a catchable TypeError, which is what the test asserts.
    const lines = await runLines(`
      function FACTORY() {}
      FACTORY.prototype = Function.prototype;
      var obj = new FACTORY();
      LOG("call=" + (typeof obj.call));
      LOG("in=" + ("call" in obj));
      LOG("id=" + (Object.getPrototypeOf(obj) === Function.prototype));
      var verdict = "no-throw";
      try {
        obj.call();
      } catch (e) {
        verdict = e instanceof TypeError ? "TypeError" : "other";
      }
      LOG("invoke=" + verdict);
    `);
    expect(lines).toEqual(["call=function", "in=true", "id=true", "invoke=TypeError"]);
  });

  it("pins test262 S15.3.4.3_A1_T1: Function() prototype inherits apply", async () => {
    // Keep the upstream row's source shape: the prototype is the RESULT of a
    // zero-argument Function() call, not the named Function.prototype value.
    const lines = await runLines(`
      var proto = Function();
      function FACTORY() {}
      FACTORY.prototype = proto;
      var obj = new FACTORY;
      LOG("type=" + (typeof obj.apply));
      var verdict = "no-throw";
      try {
        obj.apply();
        verdict = "no-throw";
      } catch (e) {
        verdict = e instanceof TypeError ? "TypeError" : "other";
      }
      LOG("invoke=" + verdict);
    `);
    expect(lines).toEqual(["type=function", "invoke=TypeError"]);
  });

  it("pins test262 S15.3.4.4_A1_T1: Function() prototype inherits call", async () => {
    // This is the sibling upstream row, kept separate so either exact failure
    // remains diagnosable if apply and call ever diverge again.
    const lines = await runLines(`
      var proto = Function();
      function FACTORY() {}
      FACTORY.prototype = proto;
      var obj = new FACTORY;
      LOG("type=" + (typeof obj.call));
      var verdict = "no-throw";
      try {
        obj.call();
        verdict = "no-throw";
      } catch (e) {
        verdict = e instanceof TypeError ? "TypeError" : "other";
      }
      LOG("invoke=" + verdict);
    `);
    expect(lines).toEqual(["type=function", "invoke=TypeError"]);
  });

  it("a COMPUTED key reaches the same members (the runtime walk, not a fold)", async () => {
    // Written as a loop-carried key so no compile-time fold can bypass the
    // dynamic read this pin exists to exercise.
    const lines = await runLines(`
      var keys = ["call", "apply", "bind"];
      var o = Object.create(Function.prototype);
      var out = "";
      for (var i = 0; i < keys.length; i++) {
        out = out + (typeof o[keys[i]]) + ";";
      }
      LOG(out);
    `);
    expect(lines).toEqual(["function;function;function;"]);
  });

  it("a CALLABLE prototype now reaches %Function.prototype% (the hop #4637 left open)", async () => {
    // `var arm = Function.prototype` is what arms `protoMemberDirty`, and the
    // proto-index store is what supplies the companion. Without it the whole
    // mechanism is byte-inert — that is the measured residual for the
    // `S15.3.4.4_A1_T1` spelling, recorded in the issue file.
    // RED on base: "call=undefined" (the link to G was already true).
    const lines = await runLines(`
      var arm = Function.prototype;
      function G() {}
      function H() {}
      H.prototype = G;
      var h = new H();
      LOG("id=" + (Object.getPrototypeOf(h) === G));
      LOG("call=" + (typeof h.call));
    `);
    expect(lines).toEqual(["id=true", "call=function"]);
  });

  it("the reflective Object.prototype.toString accepts a $NativeProto receiver", async () => {
    // RED on base: the third line is a refusal
    // ("Object.prototype.toString is not yet implemented in --target standalone").
    // The stored-slot spelling is what defeats the #2501 compile-time fold.
    const lines = await runLines(`
      var np = Object.prototype;
      np.getClass = Object.prototype.toString;
      var arr = [1, 2];
      arr.getClass = Object.prototype.toString;
      var o = {};
      o.getClass = Object.prototype.toString;
      LOG("arr=" + arr.getClass());
      LOG("obj=" + o.getClass());
      LOG("np=" + np.getClass());
    `);
    expect(lines).toEqual(["arr=[object Array]", "obj=[object Object]", "np=[object Object]"]);
  });

  it("Object.prototype.toString is callable but not constructable", async () => {
    const lines = await runLines(`
      LOG("call=" + Object.prototype.toString());
      var verdict = "no-throw";
      try {
        new Object.prototype.toString();
      } catch (e) {
        verdict = e instanceof TypeError ? "TypeError" : "other";
      }
      LOG("construct=" + verdict);
    `);
    expect(lines).toEqual(["call=[object Object]", "construct=TypeError"]);
  });

  // ── GUARDS: shapes that must NOT move. These pass on both arms by design. ──

  it("GUARD an ordinary object prototype still links, and Object.create(null) still has none", async () => {
    const lines = await runLines(`
      var p = { hi: 1 };
      var q = Object.create(p);
      LOG("id=" + (Object.getPrototypeOf(q) === p));
      LOG("hi=" + q.hi);
      var n = Object.create(null);
      LOG("null=" + (Object.getPrototypeOf(n) === null));
    `);
    expect(lines).toEqual(["id=true", "hi=1", "null=true"]);
  });

  it("GUARD the companion's members are NON-enumerable — no key leak", async () => {
    // The view is a real `$Object` in the chain, so if its entries were
    // enumerable every `for-in` over such an object would grow ~4-36 keys. They
    // are installed with `PROTO_METHOD_DEFINE_FLAGS` (enumerable false); this
    // executes the enumeration rather than asserting the flag.
    const lines = await runLines(`
      var o = Object.create(Function.prototype);
      o.own = 1;
      var seen = "";
      for (var k in o) { seen = seen + k + ","; }
      LOG("forin=" + seen);
      LOG("keys=" + Object.keys(o).length);
      LOG("hasOwn=" + o.hasOwnProperty("call"));
    `);
    expect(lines).toEqual(["forin=own,", "keys=1", "hasOwn=false"]);
  });

  it("GUARD a CLASS prototype is not mapped to a builtin brand companion", async () => {
    // `$NativeProto.$isClass` guards the arm out: `__protoidx_brand_off` answers
    // its `Object` DEFAULT for a user-class tag, so mapping one would publish
    // %Object.prototype%'s companion as the class's prototype. Both lines are
    // the BASE answers — this pin fails if the guard is ever dropped.
    const lines = await runLines(`
      class A { m() { return 7; } }
      var o = Object.create(A.prototype);
      LOG("m=" + (typeof o.m));
      LOG("mval=" + o.m.call(o));
    `);
    expect(lines).toEqual(["m=function", "mval=7"]);
  });

  it("GUARD an ordinary null prototype does not inherit Function.prototype methods", async () => {
    const lines = await runLines(`
      function FACTORY() {}
      FACTORY.prototype = Object.create(null);
      var obj = new FACTORY;
      LOG("apply=" + (typeof obj.apply));
      LOG("call=" + (typeof obj.call));
    `);
    expect(lines).toEqual(["apply=undefined", "call=undefined"]);
  });

  // ── RESIDUALS: measured, still failing, root recorded in the issue file. ──

  it.fails("RESIDUAL a function-valued prototype with no builtin brand remains unsupported", async () => {
    // This is deliberately distinct from the exact Function() rows above:
    // assigning an arbitrary user function as a prototype still has no
    // Function.prototype companion link in the generic callable path.
    const lines = await runLines(`
      function G() {}
      function H() {}
      H.prototype = G;
      var h = new H();
      LOG("call=" + (typeof h.call));
    `);
    expect(lines).toEqual(["call=function"]);
  });

  it("a runtime delete removes Object.prototype.toString from the direct call path", async () => {
    // The second half of `built-ins/Object/prototype/S15.2.4_A1_T2`. The
    // source-level delete must be observed by the syntactic call just as it is
    // by hasOwnProperty and the dynamic property read.
    const lines = await runLines(`
      LOG("before=" + Object.prototype.toString());
      delete Object.prototype.toString;
      LOG("hasOwn=" + Object.prototype.hasOwnProperty("toString"));
      var verdict = "no-throw";
      try {
        Object.prototype.toString();
      } catch (e) {
        verdict = e instanceof TypeError ? "TypeError" : "other";
      }
      LOG("after=" + verdict);
    `);
    expect(lines).toEqual(["before=[object Object]", "hasOwn=false", "after=TypeError"]);
  });

  it("RESIDUAL Array.prototype.concat has no reflective body", async () => {
    // `built-ins/Array/prototype/concat/S15.4.4.4_A2_T{1,2}`. Unrelated to the
    // prototype link: `emitArrayProtoMemberBody` has a native core for `slice`
    // and the HOF family only, so every other member degrades to a catchable
    // TypeError when reached as a VALUE.
    const lines = await runLines(`
      var x = {};
      x.concat = Array.prototype.concat;
      var arr = x.concat();
      LOG("len=" + arr.length);
      LOG("zero=" + (arr[0] === x));
    `);
    expect(lines).toEqual(["len=1", "zero=true"]);
  });

  it("RESIDUAL `new <Builtin>.prototype.constructor` is classified non-constructable", async () => {
    // `built-ins/{Object,String}/prototype/constructor/S15.*_A1_T2`. The
    // `isNewOnNonConstructablePrototype` / `classifyNonConstructableValue`
    // predicates read every `X.prototype.<name>` as a prototype METHOD;
    // `constructor` is the intrinsic constructor. Excluding the name alone is
    // NOT the fix — measured in the issue file, it turns the loud refusal into a
    // WRONG answer for String.
    const lines = await runLines(`
      var c = String.prototype.constructor;
      var s = new c("choosing one");
      LOG("eq=" + (s == "choosing one"));
    `);
    expect(lines).toEqual(["eq=true"]);
  });
});
