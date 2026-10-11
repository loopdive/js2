/**
 * #6651 slice W2b — §10.1.14 GetPrototypeFromConstructor step 4 in
 * `--target standalone`: when `Get(NewTarget, "prototype")` is not an Object,
 * the instance gets the intrinsic default (`%Object.prototype%` for every
 * ordinary-function route), not `null` and not the target's own prototype.
 *
 * Before W2b each case below answered `null` (or the target's prototype, for
 * the Proxy forward), and `new D()` on a `var D = f.bind()` binding evaluated
 * to null. The returned-object case is a control: it passes on base and must
 * keep passing (a constructor's own result is never re-prototyped). Host-free;
 * each check sets one bit, so a failure names its check.
 * The realm global is built the way the test262 runtime prelude builds it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(src: string): Promise<{ value: unknown; imports: unknown[] }> {
  const r = (await compile(src, {
    fileName: "t.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { value: (instance.exports as { test: () => unknown }).test(), imports: r.imports ?? [] };
}

const REALM = `function mkRealm() { return { global: { Function: globalThis.Function, Object: globalThis.Object } }; }
var other = mkRealm().global;`;

describe("#6651 W2b · GetPrototypeFromConstructor falls back to %Object.prototype% (standalone)", () => {
  it("Reflect.construct over an ordinary function, a bound function, a trapless Proxy", async () => {
    const src = `export function test() {
  var r = 0;
  var C = function () {};
  C.prototype = null;
  if (Object.getPrototypeOf(Reflect.construct(function () {}, [], C)) === Object.prototype) r += 1;
  var D = function () {}.bind();
  var d = Reflect.construct(D, [], C);
  if (d !== null && Object.getPrototypeOf(d) === Object.prototype) r += 2;
  if (new D() !== null) r += 4;
  var P = new Proxy(function () {}, {});
  if (Object.getPrototypeOf(Reflect.construct(P, [], C)) === Object.prototype) r += 8;
  return r;
}`;
    const { value, imports } = await run(src);
    expect(value).toBe(15);
    expect(imports).toEqual([]);
  });

  it("Reflect.construct over a class (base and derived from a function)", async () => {
    const src = `export function test() {
  var r = 0;
  var C = function () {};
  C.prototype = null;
  class B extends function () {} {
    constructor() { super(); }
  }
  if (Object.getPrototypeOf(new B()) === B.prototype) r += 1;
  if (Object.getPrototypeOf(Reflect.construct(B, [], C)) === Object.prototype) r += 2;
  class E {}
  if (Object.getPrototypeOf(Reflect.construct(E, [], C)) === Object.prototype) r += 4;
  return r;
}`;
    expect((await run(src)).value).toBe(7);
  });

  it("a constructor's own returned object keeps its prototype", async () => {
    const src = `export function test() {
  var C = function () {};
  C.prototype = null;
  var proto = { k: 1 };
  var own = Object.create(proto);
  var R = function () { return own; };
  var got = Reflect.construct(R, [], C);
  return (got === own ? 1 : 0) + (Object.getPrototypeOf(got) === proto ? 2 : 0);
}`;
    expect((await run(src)).value).toBe(3);
  });

  it("Array.from / Array.of construct a realm %Function% product on %Object.prototype%", async () => {
    const src = `${REALM}
export function test() {
  var C = new other.Function();
  C.prototype = null;
  var r = 0;
  if (Object.getPrototypeOf(Array.from.call(C, [])) === other.Object.prototype) r += 1;
  if (Object.getPrototypeOf(Array.of.call(C, 1, 2, 3)) === other.Object.prototype) r += 2;
  return r;
}`;
    expect((await run(src)).value).toBe(3);
  });
});
