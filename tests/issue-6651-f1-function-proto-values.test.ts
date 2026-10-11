// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 F1 — `%Function.prototype%` members must be readable as VALUES off a
 * function in the `standalone` target.
 *
 * Before this fix `f.apply` / `f.call` / `f.bind` / `f.toString` all evaluated
 * to `undefined` while `typeof f === "function"`. CALLING them was unaffected
 * (`f.call(x)` folds at the call site), so the gap was invisible from every
 * ordinary spelling and only surfaced where the member is handed to another
 * function as a value — which is exactly what test262's
 * `assertNativeFunction(new Proxy(<callable>, { apply() {} }).apply)` does in
 * the 10 `built-ins/Function/prototype/toString/proxy-*` rows.
 *
 * Two independent causes, both fixed:
 *
 *  1. `reserveProtoIndexStore` never reserved the companion store, because its
 *     demand gate only saw a PROTOTYPE OBJECT flowing (`var p =
 *     Function.prototype`). A bare `fn.apply` read names no prototype, so every
 *     consult site emitted its pre-existing `undefined` miss.
 *  2. Even with the store reserved, the Function brand's companion carried no
 *     members: the seeder that installs them is registered as a side effect of
 *     materializing the brand's `$NativeProto` singleton, which only a SYNTACTIC
 *     `Function.prototype` read ever did.
 *
 * The receiver-laundering cases below are the load-bearing ones: a statically
 * typed receiver can be answered by a constant fold, so a probe that never
 * launders the value through an untyped parameter reports success on a broken
 * compiler.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

/**
 * Compile+run `body` as the whole of a `standalone` module export. `code(v)`
 * maps a value to a small integer so the assertion never depends on the string
 * representation crossing the module boundary.
 */
async function run(body: string): Promise<unknown> {
  const source = `export function test(): number {
      function code(v: any): number {
        var t = typeof v;
        if (t === "undefined") return 0;
        if (t === "function") return 1;
        if (t === "object") return 2;
        return 9;
      }
      ${body}
    }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-f1.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    {
      target: "standalone",
      providerLabel: "issue-6651-f1",
    },
  );
  return (instance.exports as { test(): number }).test();
}

describe("#6651 F1 — Function.prototype members as values (standalone)", () => {
  it("reads apply/call/bind/toString off a function declaration", async () => {
    // 1 per member ⇒ 4 when all four resolve to callables. Before the fix: 0.
    expect(
      await run(`
      function f() {}
      var g: any = f;
      return code(g.apply) + code(g.call) + code(g.bind) + code(g.toString);
    `),
    ).toBe(4);
  });

  it("reads them through a computed key", async () => {
    expect(
      await run(`
      function f() {}
      var g: any = f;
      return code(g["apply"]) + code(g["call"]) + code(g["bind"]) + code(g["toString"]);
    `),
    ).toBe(4);
  });

  it("reads them off a LAUNDERED receiver (untyped parameter)", async () => {
    // The receiver's static type is erased by the `any` parameter, so no
    // constant fold can answer this — it must go through the dynamic
    // property-read path.
    expect(
      await run(`
      function f() {}
      function readApply(x: any): any { return x.apply; }
      function readToString(x: any): any { return x.toString; }
      var g: any = f;
      return code(readApply(g)) + code(readToString(g));
    `),
    ).toBe(2);
  });

  it("reads them off a function EXPRESSION and an arrow", async () => {
    expect(
      await run(`
      var fe: any = function () {};
      var ar: any = () => 1;
      return code(fe.apply) + code(fe.bind) + code(ar.call) + code(ar.toString);
    `),
    ).toBe(4);
  });

  it("reads them off a Proxy whose target is a function", async () => {
    // The test262 row shape. The `apply` trap on the handler must NOT be what
    // answers the read — this is an ordinary [[Get]] of the string key "apply".
    expect(
      await run(`
      var p: any = new Proxy(function () {}, { apply: function () {} });
      function readApply(x: any): any { return x.apply; }
      return code(p.apply) + code(p["call"]) + code(readApply(p)) + code(p.toString);
    `),
    ).toBe(4);
  });

  it("still routes the read through the Proxy's get trap", async () => {
    // The whole reason this fix goes through the dynamic path rather than a
    // static fold in property-access.ts: a `get` trap must still intercept.
    // 7 = trap saw "apply" (1) + "call" (2) + "bind" (4).
    expect(
      await run(`
      var seen = 0;
      var p: any = new Proxy(function () {}, {
        get: function (t: any, k: any) {
          if (k === "apply") seen += 1;
          if (k === "call") seen += 2;
          if (k === "bind") seen += 4;
          return t[k];
        },
      });
      var a: any = p.apply;
      var b: any = p.call;
      var c: any = p.bind;
      return seen;
    `),
    ).toBe(7);
  });

  it("keeps an own property shadowing the inherited member", async () => {
    // §10.1.8.1 — the carrier bag's own entry must still win over the new
    // Function-brand companion consult.
    expect(
      await run(`
      function f() {}
      var g: any = f;
      g.apply = 7;
      return typeof g.apply === "number" ? 1 : 0;
    `),
    ).toBe(1);
  });

  it("still answers undefined for a key %Function.prototype% does not own", async () => {
    // Selectivity guard: the new consult must resolve the four §20.2.3 members
    // and NOTHING else. `g.nope` stays `undefined` (0) while `g.apply` is a
    // callable (1) — i.e. 1, not 11.
    //
    // NOT asserted here, deliberately: `g.hasOwnProperty` (inherited from
    // %Object.prototype% one level further up the same walk) still reads
    // `undefined` in standalone. That is a SEPARATE, pre-existing gap — the
    // Object brand's companion has no registered glue either — and it is
    // unchanged by this fix, measured both before and after.
    expect(
      await run(`
      function f() {}
      var g: any = f;
      return code(g.nope) * 10 + code(g.apply);
    `),
    ).toBe(1);
  });

  it("leaves calling those members working", async () => {
    // Regression guard on the half that was never broken.
    expect(
      await run(`
      function add(this: any, a: number): number { return a + 1; }
      var g: any = add;
      var viaCall: number = g.call(null, 1);
      var viaApply: number = g.apply(null, [2]);
      return viaCall + viaApply;
    `),
    ).toBe(2 + 3);
  });
});
