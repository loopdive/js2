// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V10a — a PRIMITIVE base reads through its wrapper prototype on
// the standalone lane (§6.2.4.8 GetValue step 5.a, §7.3.2 GetV ToObject).
//
// Two defects, two owners:
//
//  - `Symbol.prototype.x = v; Symbol().x` read `undefined`. The #5269 B-d arm
//    folded every non-own symbol read to `undefined` even when the module
//    wrote `Symbol.prototype`, and `__protoidx_brand_off` classified a bare
//    `$Symbol` carrier as Object, so the Symbol companion was never consulted
//    (test262 `language/types/reference/get-value-prop-base-primitive.js`).
//  - `Promise.prototype.catch.call(true)` threw "is not a function". Its
//    IsCallable guard reused the RESOLVE-path thenable predicate, which answers
//    0 for every primitive by design (§27.2.1.3.2 step 8 — a primitive is never
//    a thenable). Invoke(true, "then") must ToObject instead
//    (`built-ins/Promise/prototype/catch/this-value-obj-coercible.js`).
//
// The first describe fails on the base tree; the controls pass on both.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function evalStandalone(body: string): Promise<string> {
  const source = `let __s = "";
export function prepare() {
  try { __s = "" + ((() => { ${body} })()); } catch (e) { __s = "!" + (e instanceof TypeError ? "TypeError" : e && e.message ? e.message : e); }
  return __s.length;
}
export function at(i) { return __s.charCodeAt(i); }`;
  const result = (await compile(source, {
    target: "standalone",
    hostBridge: "off",
    fileName: "/p.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never)) as unknown as { success: boolean; errors?: { message: string }[]; binary?: Uint8Array };
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary as Uint8Array), {});
  const exports = instance.exports as unknown as { prepare(): number; at(i: number): number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < Math.min(length, 400); index++) out += String.fromCharCode(exports.at(index));
  return out;
}

describe("#6651 V10a primitive base reads through its wrapper prototype", () => {
  it("answers as JS does on the standalone lane", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      symbolProtoData: await evalStandalone(
        `Symbol.prototype.t = "sp"; var s = Symbol(); return String(Symbol().t) + "|" + String(s.t);`,
      ),
      catchInvokesWrapperThen: await evalStandalone(`var n = 0;
        Boolean.prototype.then = function () { n += 1; };
        Number.prototype.then = function () { n += 10; };
        String.prototype.then = function () { n += 100; };
        Symbol.prototype.then = function () { n += 1000; };
        Promise.prototype.catch.call(true); Promise.prototype.catch.call(34);
        Promise.prototype.catch.call(""); Promise.prototype.catch.call(Symbol());
        return n;`),
      catchPassesArgs: await evalStandalone(`var seen = "";
        String.prototype.then = function (a, b) { seen = typeof a + ":" + typeof b; };
        Promise.prototype.catch.call("x", function () {}); return seen;`),
    };
    expect(observed).toEqual({
      symbolProtoData: "sp|sp",
      catchInvokesWrapperThen: "1111",
      catchPassesArgs: "undefined:function",
    });
  });
});

describe("#6651 V10a controls — unchanged on both trees", () => {
  it("keeps absent reads undefined and non-callable `then` a TypeError", { timeout: 600_000 }, async () => {
    const observed: Record<string, string> = {
      symbolAbsentNoWrite: await evalStandalone(`var s = Symbol(); return String(s.t);`),
      symbolOwnMember: await evalStandalone(`Symbol.prototype.t = 1; return Symbol("d").description;`),
      numberProtoData: await evalStandalone(`Number.prototype.t = "np"; return (1).t;`),
      catchNoThen: await evalStandalone(`Promise.prototype.catch.call(1); return "no-throw";`),
      catchNonCallableThen: await evalStandalone(
        `Number.prototype.then = 5; Promise.prototype.catch.call(1); return "no-throw";`,
      ),
      catchObjectThenable: await evalStandalone(
        `var seen = ""; var o = { then: function (a, b) { seen = "obj:" + typeof b; } }; Promise.prototype.catch.call(o, function () {}); return seen;`,
      ),
    };
    expect(observed).toEqual({
      symbolAbsentNoWrite: "undefined",
      symbolOwnMember: "d",
      numberProtoData: "np",
      catchNoThen: "!TypeError",
      catchNonCallableThen: "!TypeError",
      catchObjectThenable: "obj:function",
    });
  });
});
